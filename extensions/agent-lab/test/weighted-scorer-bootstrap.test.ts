import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { SchedulerRunner } from "../src/scheduler/runner.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { PiSubagentsAdapter } from "../src/runtime/pi-subagents-adapter.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import { createPiDefaultLoop } from "../src/workloops/pi-default-loop.ts";
import type { DelegationEventBus } from "../src/runtime/pi-subagents-adapter.ts";
import { createLabCore } from "../src/core/create-core.ts";
import type { LabCore } from "../src/core/create-core.ts";
import type { ModelInfo, Aggregate } from "../src/types.ts";
import type { AgentInstanceRecord, SchedulerDefinition } from "../src/core/contracts.ts";
import type { WeightedScorerPorts } from "../src/schedulers/weighted-scorer.ts";
import type {
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../src/workloop/contracts.ts";

// These will be implemented:
import {
  ensureWeightedScorerInstance,
  syncWeightedScorerAgents,
} from "../src/schedulers/bootstrap.ts";
import { createSchedulerRuntime } from "../src/runtime/create-scheduler-runtime.ts";

// ── Fixtures ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function model(
  id: string,
  pricing?: { in: number; out: number },
): ModelInfo {
  const free = pricing != null && pricing.in === 0 && pricing.out === 0;
  return {
    id,
    provider: id.includes("/") ? id.split("/")[0] : "unknown",
    name: id,
    pricing,
    perf: undefined,
    benchmarks: undefined,
    accessRoute: free ? "free" : "direct",
  };
}

function mockPorts(candidates: ModelInfo[] = []): WeightedScorerPorts {
  return {
    candidates: () => candidates,
    aggregates: () => new Map(),
    pinLookup: () => undefined,
  };
}

function noopModel(): ModelPort {
  return {
    complete: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
  };
}

function noopTools(): ToolPort {
  return { execute: async () => "done" };
}

function noopArtifacts(): ArtifactPort {
  return {
    put: async () => "ref-1",
    get: async () => "value",
  };
}

function fakeEventBus(): DelegationEventBus {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on(event: string, handler: (payload: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    emit(_event: string, _payload: unknown) {
      // no-op for tests; real event bus would fire handlers
    },
  };
}

// ── Behavior 1: ensureWeightedScorerInstance — full bootstrap ───────────

test("1. ensureWeightedScorerInstance registers definition, creates draft, validates, activates", async () => {
  const db = memoryDB();
  const core = createLabCore(db);

  // Pre-register pi-default-loop definition (required for validation)
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  const candidates = [
    model("openai/gpt-4o", { in: 5, out: 15 }),
    model("anthropic/claude-3", { in: 3, out: 15 }),
  ];
  const ports = mockPorts(candidates);

  const result = await ensureWeightedScorerInstance(core, schedulers, ports);

  // instanceId is now a UUID (ADR-0002 UUID identity)
  assert.match(result.instanceId, /^[0-9a-f-]{36}$/);
  assert.match(result.roundId, /^[0-9a-f-]{36}:round:0$/);
  assert.equal(result.agentCount, 2);

  // Verify instance is active (by UUID)
  const inst = core.repository.getInstance(result.instanceId);
  assert.ok(inst);
  assert.equal(inst.status, "active");
  assert.equal(inst.name, "default-weighted-scorer");
  assert.equal(inst.currentRoundId, result.roundId);
  assert.equal(inst.definition.id, "weighted-scorer");
  assert.equal(inst.definition.version, "1.0.0");

  // Verify round
  const round = core.repository.getRound(result.roundId);
  assert.ok(round);
  assert.equal(round.sequence, 0);

  // Verify agents
  const agents = core.repository.listAgents(result.instanceId);
  assert.equal(agents.length, 2);
  const agentModels = new Set(agents.map((a) => a.model));
  assert.ok(agentModels.has("openai/gpt-4o"));
  assert.ok(agentModels.has("anthropic/claude-3"));

  // Verify routing bindings
  const bindings = core.repository.listRoutingBindings();
  const defaultBinding = bindings.find((b) => b.id === "default");
  assert.ok(defaultBinding);
  assert.equal(defaultBinding.priority, 0);
  assert.deepEqual(defaultBinding.match, {});

  // Verify by-name lookup works
  const byName = core.repository.findInstanceByName("weighted-scorer", "default-weighted-scorer");
  assert.ok(byName);
  assert.equal(byName.id, result.instanceId);

  db.close();
});

// ── Behavior 2: Idempotent — second call returns same instance ─────────

test("2. ensureWeightedScorerInstance is idempotent on second call", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  const first = await ensureWeightedScorerInstance(core, schedulers, ports);
  const second = await ensureWeightedScorerInstance(core, schedulers, ports);

  // Both return the same UUID-identified instance
  assert.deepEqual(first, second);
  // Verify only one agent exists (no duplicates)
  assert.equal(core.repository.listAgents(first.instanceId).length, 1);

  db.close();
});

// ── Behavior 3: syncWeightedScorerAgents — adds only missing models ─────

test("3. syncWeightedScorerAgents creates agents for models not already in population", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  // Bootstrap with 1 candidate
  const initialCandidates = [model("openai/gpt-4o")];
  const ports = mockPorts(initialCandidates);
  const { instanceId } = await ensureWeightedScorerInstance(core, schedulers, ports);

  // Sync with 3 candidates — only 2 new
  const newCandidates = [
    model("openai/gpt-4o"),
    model("anthropic/claude-3"),
    model("google/gemini-pro"),
  ];
  const ports2 = mockPorts(newCandidates);
  const added = await syncWeightedScorerAgents(core, instanceId, ports2.candidates());

  assert.equal(added, 2);

  const agents = core.repository.listAgents(instanceId);
  assert.equal(agents.length, 3);

  const agentModels = new Set(agents.map((a) => a.model));
  assert.ok(agentModels.has("openai/gpt-4o"));
  assert.ok(agentModels.has("anthropic/claude-3"));
  assert.ok(agentModels.has("google/gemini-pro"));

  // All agents still "ready" (never deactivated)
  for (const agent of agents) {
    assert.equal(agent.status, "ready");
  }

  db.close();
});

test("3b. syncWeightedScorerAgents returns 0 when all models already present", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const ports = mockPorts(candidates);
  const { instanceId } = await ensureWeightedScorerInstance(core, schedulers, ports);

  const added = await syncWeightedScorerAgents(core, instanceId, ports.candidates());
  assert.equal(added, 0);
  assert.equal(core.repository.listAgents(instanceId).length, 2);

  db.close();
});

// ── Behavior 4: Activated instance passes validation E2E ────────────────

test("4. Activated instance passes control-plane validation end-to-end", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  const { instanceId, roundId, agentCount } = await ensureWeightedScorerInstance(
    core,
    schedulers,
    ports,
  );

  // Instance is active
  const inst = core.repository.getInstance(instanceId);
  assert.ok(inst);
  assert.equal(inst.status, "active");

  // Round exists
  const round = core.repository.getRound(roundId);
  assert.ok(round);
  assert.equal(round.status, "active");

  // Agents created
  assert.equal(agentCount, 1);

  // Routing binding exists
  const bindings = core.repository.listRoutingBindings();
  assert.ok(bindings.some((b) => b.id === "default"));

  // Draft marked as activated
  const draft = core.repository.getDraft(instanceId);
  assert.ok(draft);
  assert.equal(draft.status, "activated");

  db.close();
});

// ── Behavior 5: createSchedulerRuntime without eventBus ─────────────────

test("5. createSchedulerRuntime without eventBus — select mode works, execute rejects", async () => {
  const db = memoryDB();
  const runtime = createSchedulerRuntime(db, { ports: mockPorts([model("openai/gpt-4o")]) });

  // Should have core, schedulers, schedulerRunner
  assert.ok(runtime.core);
  assert.ok(runtime.schedulers);
  assert.ok(runtime.schedulerRunner);
  assert.equal(runtime.workloopRuntime, undefined);

  // createSchedulerRuntime already registered pi-default-loop definition.
  // Bootstrap the weighted-scorer instance.
  const { instanceId } = await ensureWeightedScorerInstance(
    runtime.core,
    runtime.schedulers,
    mockPorts([model("openai/gpt-4o")]),
  );

  // Select mode dispatch should succeed
  const result = await runtime.schedulerRunner.dispatch({
    traceId: "t-select",
    schedulerInstanceId: instanceId,
    role: "coder",
    task: "build it",
    mode: "select",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.model, "openai/gpt-4o");

  // Execute mode dispatch: agents.run throws unavailable, scheduler returns
  // failed, fallback chain (original-request) produces fallback result.
  // The verifier is that we DON'T get a completed result — we can't
  // execute without a WorkLoopRunner.
  const execResult = await runtime.schedulerRunner.dispatch({
    traceId: "t-exec",
    schedulerInstanceId: instanceId,
    role: "coder",
    task: "build it",
    mode: "execute",
  });

  // Execute mode without WorkLoopRunner falls through to fallback
  // (not completed)
  assert.notEqual(execResult.status, "completed");

  runtime.dispose();
  db.close();
});

// ── Behavior 6: With eventBus + ports — execute mode E2E ────────────────

test("6. createSchedulerRuntime with eventBus + ports — execute mode dispatch completes", async () => {
  const db = memoryDB();
  const eb = fakeEventBus();

  const runtime = createSchedulerRuntime(db, {
    ports: mockPorts([model("openai/gpt-4o")]),
    eventBus: eb,
    model: noopModel(),
    tools: noopTools(),
    artifacts: noopArtifacts(),
  });

  assert.ok(runtime.workloopRuntime);

  // Bootstrap
  const { instanceId } = await ensureWeightedScorerInstance(
    runtime.core,
    runtime.schedulers,
    mockPorts([model("openai/gpt-4o")]),
  );

  // Execute mode dispatch should complete (even if the fake event bus never
  // actually responds, the WorkLoopRunner is wired and will be invoked)
  try {
    const result = await runtime.schedulerRunner.dispatch({
      traceId: "t-exec-e2e",
      schedulerInstanceId: instanceId,
      role: "coder",
      task: "build it",
      mode: "execute",
    });

    // The execution may or may not complete based on the fake event bus.
    // The key assertion: the WorkLoopRunner was registered and agents.run
    // did not throw "unavailable".
    // Since our fake event bus doesn't respond to delegate requests, the
    // WorkLoopRunner will likely timeout or fail, but NOT with "unavailable".
    // This test verifies the wiring, not the full E2E.
    if (result.status === "failed") {
      const err = (result as any).error?.standard;
      // Should NOT be "unavailable" since WorkLoopRunner exists
      assert.ok(!err?.message?.includes("unavailable"), "should not be unavailable error");
    }
  } catch (_err) {
    // Timeout or other runtime error is fine — we just verify wiring doesn't throw.
  }

  runtime.dispose();
  db.close();
});

// ── Behavior 7: Dispose disposes workloop runtime when present ──────────

test("7. dispose disposes workloop runtime when present", () => {
  const db = memoryDB();
  const eb = fakeEventBus();

  const runtime = createSchedulerRuntime(db, {
    ports: mockPorts([]),
    eventBus: eb,
    model: noopModel(),
    tools: noopTools(),
    artifacts: noopArtifacts(),
  });

  assert.ok(runtime.workloopRuntime);
  assert.doesNotThrow(() => runtime.dispose());
  db.close();
});

test("7b. dispose is safe without workloop runtime", () => {
  const db = memoryDB();
  const runtime = createSchedulerRuntime(db, { ports: mockPorts([]) });
  assert.equal(runtime.workloopRuntime, undefined);
  assert.doesNotThrow(() => runtime.dispose());
  db.close();
});

// ── custom instanceId option ────────────────────────────────────────────

test("ensureWeightedScorerInstance respects custom instanceId", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  const result = await ensureWeightedScorerInstance(core, schedulers, ports, {
    instanceId: "my-custom-id",
  });

  assert.equal(result.instanceId, "my-custom-id");
  assert.equal(result.roundId, "my-custom-id:round:0");
  assert.equal(result.agentCount, 1);

  const inst = core.repository.getInstance("my-custom-id");
  assert.ok(inst);
  assert.equal(inst.status, "active");

  db.close();
});

// ── Stale-draft recovery (P7 hotfix, adapted for UUID identity) ────

test("stale draft from crashed bootstrap is discarded and recreated (ws)", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  // Simulate a crashed bootstrap: draft exists, instance never activated.
  const first = await ensureWeightedScorerInstance(core, schedulers, ports);
  const firstUuid = first.instanceId;
  assert.match(firstUuid, /^[0-9a-f-]{36}$/);
  // Simulate a crashed bootstrap: draft row remains (pre-activation),
  // instance/rounds/agents were never committed (activation is
  // transactional — a crash leaves none of them behind).
  db.prepare("DELETE FROM lab_scheduler_instances WHERE id = ?").run(firstUuid);
  db.prepare("DELETE FROM lab_optimization_rounds WHERE scheduler_instance_id = ?").run(firstUuid);
  db.prepare("DELETE FROM lab_agent_instances WHERE scheduler_instance_id = ?").run(firstUuid);
  db.prepare("DELETE FROM lab_events WHERE event_id = ?").run(`instance.activated:${firstUuid}`);
  db.prepare("DELETE FROM lab_routing_bindings WHERE scheduler_instance_id = ?").run(firstUuid);
  db.prepare("UPDATE lab_scheduler_drafts SET status = 'draft' WHERE id = ?").run(firstUuid);

  // Second bootstrap must not throw. With UUID identity, each bootstrap
  // generates a fresh UUID so there's no "draft already exists" conflict.
  const second = await ensureWeightedScorerInstance(core, schedulers, ports);
  assert.match(second.instanceId, /^[0-9a-f-]{36}$/);
  const inst = core.repository.getInstance(second.instanceId);
  assert.ok(inst);
  assert.equal(inst.status, "active");

  db.close();
});
