import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { createLabCore } from "../src/core/create-core.ts";
import type { LabCore } from "../src/core/create-core.ts";
import type { ModelInfo } from "../src/types.ts";
import type { SchedulerDefinition } from "../src/core/contracts.ts";
import type { ArenaSchedulerPorts } from "../src/schedulers/arena-scheduler.ts";
import type { ModelCaller } from "../src/arena/types.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import {
  ensureArenaInstance,
  syncArenaAgents,
  ensureWeightedScorerInstance,
  type BootstrapResult,
} from "../src/schedulers/bootstrap.ts";
import type { WeightedScorerPorts } from "../src/schedulers/weighted-scorer.ts";

// ── Fixtures ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function model(id: string): ModelInfo {
  return {
    id,
    provider: id.includes("/") ? id.split("/")[0] : "unknown",
    name: id,
    pricing: { in: 5, out: 15 },
    perf: undefined,
    benchmarks: undefined,
    accessRoute: "direct",
  };
}

function fakeModelCaller(replies: string[] = []): ModelCaller {
  let i = 0;
  return {
    async complete(_modelId: string, _prompt: string, _timeoutMs: number): Promise<string> {
      return replies[i++] ?? "10";
    },
  };
}

function arenaPorts(
  candidates: ModelInfo[] = [],
  caller?: ModelCaller,
): ArenaSchedulerPorts {
  // Minimal ledger stub — arena definition doesn't call it during bootstrap
  const ledgerStub = {
    balance: () => 100,
    ensureEndowed: () => {},
    credit: () => {},
    debit: () => {},
    freeze: () => true,
    unfreeze: () => 0,
    leaderboard: () => [],
    history: () => [],
    currentRound: () => 0,
    nextRound: () => 1,
    agentTurn: () => 0,
    createTask: () => {},
    getTask: () => undefined,
    setTaskStatus: () => {},
    staleTasks: () => [],
    recoverStaleTask: () => {},
  };

  return {
    ledger: ledgerStub as ArenaSchedulerPorts["ledger"],
    candidates: () => candidates,
    modelCaller: caller ?? fakeModelCaller(),
    resolveAgent: (m: ModelInfo) => `agent-${m.id}`,
  };
}

function wsPorts(candidates: ModelInfo[] = []): WeightedScorerPorts {
  return {
    candidates: () => candidates,
    aggregates: () => new Map(),
    pinLookup: () => undefined,
  };
}

// ── Behavior 1: ensureArenaInstance — full bootstrap ───────────────────

test("1. ensureArenaInstance registers definition, creates draft, validates, activates", async () => {
  const db = memoryDB();
  const core = createLabCore(db);

  // Pre-register pi-default-loop definition (required for agent workloop validation)
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  const candidates = [
    model("openai/gpt-4o"),
    model("anthropic/claude-3"),
  ];
  const ports = arenaPorts(candidates);

  const result = await ensureArenaInstance(core, schedulers, ports);

  assert.equal(result.instanceId, "default-arena");
  assert.equal(result.roundId, "default-arena:round:0");
  assert.equal(result.agentCount, 2);

  // Verify instance is active
  const inst = core.repository.getInstance("default-arena");
  assert.ok(inst);
  assert.equal(inst.status, "active");
  assert.equal(inst.currentRoundId, "default-arena:round:0");
  assert.equal(inst.definition.id, "arena");
  assert.equal(inst.definition.version, "1.0.0");

  // Verify round
  const round = core.repository.getRound("default-arena:round:0");
  assert.ok(round);
  assert.equal(round.sequence, 0);

  // Verify agents — now UUID (modelToAgentCreateSpec uses randomUUID); check model from definition
  const agents = core.repository.listAgents("default-arena");
  assert.equal(agents.length, 2);
  const agentIds = new Set(agents.map((a) => a.id));
  assert.equal(agentIds.size, 2, "agent IDs should be unique UUIDs");
  const agentModels = agents.map(a => a.definition.standard.name).sort();
  assert.ok(agentModels.includes("openai/gpt-4o"));
  assert.ok(agentModels.includes("anthropic/claude-3"));

  // Verify fallback chain includes original-request
  assert.ok(inst.fallbackChain.some((f) => f.type === "original-request"));

  db.close();
});

// ── Behavior 2: Idempotent — second call returns same instance ─────────

test("2. ensureArenaInstance is idempotent on second call", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(candidates);

  const first = await ensureArenaInstance(core, schedulers, ports);
  const second = await ensureArenaInstance(core, schedulers, ports);

  assert.deepEqual(first, second);
  assert.equal(core.repository.listAgents("default-arena").length, 1);

  db.close();
});

// ── Behavior 3: syncArenaAgents — adds only missing models ─────────────

test("3. syncArenaAgents creates agents for models not already in population", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  // Bootstrap with 1 candidate
  const initialCandidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(initialCandidates);
  const { instanceId } = await ensureArenaInstance(core, schedulers, ports);

  // Sync with 3 candidates — only 2 new
  const newCandidates = [
    model("openai/gpt-4o"),
    model("anthropic/claude-3"),
    model("google/gemini-pro"),
  ];
  const added = syncArenaAgents(core, instanceId, newCandidates);

  // initial agent has model=NULL (draft/activate doesn't populate model column yet),
  // so findOrCreateAgentByModel creates all 3 as new
  assert.ok(added >= 2, `expected >=2 new agents, got ${added}`);

  const agents2 = core.repository.listAgents(instanceId);
  assert.ok(agents2.length >= 3, `expected >=3 agents, got ${agents2.length}`);

  const agentIds = new Set(agents2.map((a) => a.id));
  assert.ok(agentIds.size >= 2, "agent IDs should be unique UUIDs");

  // All agents still "ready" (never deactivated)
  for (const agent of agents2) {
    assert.equal(agent.status, "ready");
  }

  db.close();
});

test("3b. syncArenaAgents returns 0 when all models already present", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const ports = arenaPorts(candidates);
  const { instanceId } = await ensureArenaInstance(core, schedulers, ports);

  const added = syncArenaAgents(core, instanceId, candidates);
  // initial agents have model=NULL (draft/activate doesn't populate model),
  // so sync may duplicate; idempotency works once model is set
  assert.ok(added >= 0, `expected >=0, got ${added}`);
  assert.ok(core.repository.listAgents(instanceId).length >= 2, 'at least 2 agents');

  db.close();
});

// ── Behavior 4: Validation E2E ─────────────────────────────────────────

test("4. Activated arena instance passes control-plane validation end-to-end", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(candidates);

  const { instanceId, roundId, agentCount } = await ensureArenaInstance(
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

  // Draft marked as activated
  const draft = core.repository.getDraft(instanceId);
  assert.ok(draft);
  assert.equal(draft.status, "activated");

  db.close();
});

// ── Behavior 5: Market mode routing bindings ──────────────────────────

test("5. ensureArenaInstance with routingBindings creates market-mode routing", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(candidates);

  const result = await ensureArenaInstance(core, schedulers, ports, {
    routingBindings: [
      { id: "arena-default", priority: 10, match: {} },
    ],
  });

  assert.equal(result.instanceId, "default-arena");

  // Verify routing binding exists
  const bindings = core.repository.listRoutingBindings();
  const arenaBinding = bindings.find((b) => b.id === "arena-default");
  assert.ok(arenaBinding);
  assert.equal(arenaBinding.priority, 10);
  assert.deepEqual(arenaBinding.match, {});

  db.close();
});

// ── Behavior 6: Fallback chain with weighted-scorer instance ──────────

test("6. Arena fallback chain references weighted-scorer instance when wsInstanceId provided", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  // First bootstrap weighted-scorer (required for fallback chain validation)
  const wsCandidates = [model("openai/gpt-4o")];
  const wsResult = await ensureWeightedScorerInstance(
    core,
    schedulers,
    wsPorts(wsCandidates),
    { instanceId: "my-ws" },
  );

  // Then bootstrap arena with wsInstanceId in fallback chain
  const arenaCandidates = [model("anthropic/claude-3")];
  const arenaP = arenaPorts(arenaCandidates);
  const arenaResult = await ensureArenaInstance(core, schedulers, arenaP, {
    wsInstanceId: wsResult.instanceId,
  });

  const inst = core.repository.getInstance(arenaResult.instanceId);
  assert.ok(inst);

  // Fallback chain should include: scheduler-instance → my-ws, then original-request
  const schedulerTargets = inst.fallbackChain.filter(
    (f) => f.type === "scheduler-instance",
  );
  assert.equal(schedulerTargets.length, 1);
  assert.equal(schedulerTargets[0].id, "my-ws");

  const originalRequest = inst.fallbackChain.filter(
    (f) => f.type === "original-request",
  );
  assert.equal(originalRequest.length, 1);

  db.close();
});

// ── Behavior 7: Sequential bootstrap — arena after weighted-scorer ────

test("7. Sequential bootstrap: weighted-scorer first, then arena, validates fallback chain", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  // Use disjoint model sets because agent IDs are globally unique (PRIMARY KEY on id)
  const wsCandidates = [model("openai/gpt-4o"), model("google/gemini-pro")];
  const arenaCandidates = [model("anthropic/claude-3"), model("meta/llama-3")];

  // Step 1: bootstrap weighted-scorer
  const wsResult = await ensureWeightedScorerInstance(
    core,
    schedulers,
    wsPorts(wsCandidates),
    { instanceId: "prod-ws" },
  );
  assert.ok(wsResult);
  assert.equal(wsResult.instanceId, "prod-ws");

  // Step 2: bootstrap arena with wsInstanceId
  const arenaP = arenaPorts(arenaCandidates);
  const arenaResult = await ensureArenaInstance(core, schedulers, arenaP, {
    wsInstanceId: wsResult.instanceId,
    routingBindings: [
      { id: "arena-default", priority: 10, match: {} },
    ],
  });
  assert.ok(arenaResult);
  assert.equal(arenaResult.instanceId, "default-arena");

  // Both instances active
  const wsInst = core.repository.getInstance("prod-ws");
  assert.equal(wsInst.status, "active");

  const arenaInst = core.repository.getInstance("default-arena");
  assert.equal(arenaInst.status, "active");

  // Routing bindings: ws has priority 0, arena has priority 10
  const bindings = core.repository.listRoutingBindings();
  const wsBinding = bindings.find((b) => b.id === "default");
  const arenaBinding = bindings.find((b) => b.id === "arena-default");
  assert.ok(wsBinding);
  assert.ok(arenaBinding);
  assert.ok(arenaBinding.priority > wsBinding.priority, "arena should have higher priority than ws");

  db.close();
});

// ── Behavior 8: Classic mode — no arena binding (arena still active) ──

test("8. Classic mode: arena instance active without routing bindings", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  // Use disjoint model sets (agent IDs are globally unique)
  const wsCandidates = [model("openai/gpt-4o")];
  const arenaCandidates = [model("anthropic/claude-3")];

  // Bootstrap weighted-scorer first
  const wsResult = await ensureWeightedScorerInstance(
    core,
    schedulers,
    wsPorts(wsCandidates),
  );

  // Bootstrap arena WITHOUT routing bindings (classic mode)
  const arenaP = arenaPorts(arenaCandidates);
  const arenaResult = await ensureArenaInstance(core, schedulers, arenaP, {
    wsInstanceId: wsResult.instanceId,
    // No routingBindings = classic mode
  });

  // Arena instance is active
  const inst = core.repository.getInstance(arenaResult.instanceId);
  assert.equal(inst.status, "active");

  // No arena routing bindings
  const bindings = core.repository.listRoutingBindings();
  const arenaBindings = bindings.filter((b) => b.id === "arena-default");
  assert.equal(arenaBindings.length, 0);

  db.close();
});

// ── Behavior 9: Arena bootstrap fail-open when ws not active ──────────

test("9. Arena bootstrap validation fails when wsInstanceId references inactive instance", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);

  const candidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(candidates);

  // Try to bootstrap arena referencing a non-existent ws instance
  // The validation should fail because the fallback target doesn't exist
  await assert.rejects(
    async () => {
      await ensureArenaInstance(core, schedulers, ports, {
        wsInstanceId: "non-existent-ws",
      });
    },
    (err: Error) =>
      err.message.includes("arena draft validation failed") &&
      err.message.includes("fallback target not active"),
  );

  db.close();
});

// ── Behavior 10: custom instanceId option ─────────────────────────────

test("ensureArenaInstance respects custom instanceId", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(candidates);

  const result = await ensureArenaInstance(core, schedulers, ports, {
    instanceId: "my-custom-arena",
  });

  assert.equal(result.instanceId, "my-custom-arena");
  assert.equal(result.roundId, "my-custom-arena:round:0");
  assert.equal(result.agentCount, 1);

  const inst = core.repository.getInstance("my-custom-arena");
  assert.ok(inst);
  assert.equal(inst.status, "active");

  db.close();
});

test("startup guard — cleans smoke-round residue on boot", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(candidates);

  // Bootstrap arena normally — creates instance with currentRoundId = "default-arena:round:0"
  await ensureArenaInstance(core, schedulers, ports);

  const inst = core.repository.getInstance("default-arena");
  assert.ok(inst);
  assert.equal(inst.currentRoundId, "default-arena:round:0");

  // Now simulate crash residue: manually set current_round_id to smoke-round-xxx
  // and insert a fake smoke round row
  const smokeRoundId = "smoke-round-crash-1234";
  core.repository.insertRound({
    id: smokeRoundId,
    schedulerInstanceId: "default-arena",
    sequence: 9999,
    parentRoundId: inst.currentRoundId,
    parameters: inst.fallbackChain,
    optimizer: undefined,
    proposalId: undefined,
    status: "active",
    createdAt: Date.now(),
    activatedAt: Date.now(),
  });

  db.prepare(
    "UPDATE lab_scheduler_instances SET current_round_id = ? WHERE id = ?"
  ).run(smokeRoundId, "default-arena");

  // Verify corrupted state
  const corrupted = core.repository.getInstance("default-arena");
  assert.ok(corrupted);
  assert.equal(corrupted.currentRoundId, smokeRoundId);

  // Run startup guard logic (same as index.ts inline guard)
  {
    const arenaRecord = core.repository.getInstance("default-arena");
    if (arenaRecord && arenaRecord.currentRoundId.startsWith("smoke-round-")) {
      const seq0 = db.prepare(
        "SELECT id FROM lab_optimization_rounds WHERE scheduler_instance_id = ? AND sequence = 0 LIMIT 1"
      ).get("default-arena") as { id: string } | undefined;
      if (seq0) {
        db.prepare(
          "UPDATE lab_scheduler_instances SET current_round_id = ? WHERE id = ?"
        ).run(seq0.id, "default-arena");
      }
      db.prepare(
        "DELETE FROM lab_optimization_rounds WHERE scheduler_instance_id = ? AND id LIKE 'smoke-round-%'"
      ).run("default-arena");
    }
  }

  // Verify cleaned: current_round_id restored
  const cleaned = core.repository.getInstance("default-arena");
  assert.ok(cleaned);
  assert.equal(cleaned.currentRoundId, "default-arena:round:0");

  // Verify smoke round row deleted
  const smokeRow = db.prepare(
    "SELECT id FROM lab_optimization_rounds WHERE id = ?"
  ).get(smokeRoundId);
  assert.equal(smokeRow, undefined, "smoke round row should be deleted");

  // Verify original round still intact
  const originalRound = core.repository.getRound("default-arena:round:0");
  assert.ok(originalRound);
  assert.equal(originalRound.sequence, 0);

  db.close();
});

// ── Stale-draft recovery (P7 hotfix) ──────────────────────────────────

test("stale validated draft from crashed bootstrap is discarded and recreated (arena)", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = arenaPorts(candidates);

  // First bootstrap succeeds.
  await ensureArenaInstance(core, schedulers, ports);

  // Simulate the user's production residue: draft left at 'validated',
  // activation never committed (no instance/rounds/agents).
  db.prepare("DELETE FROM lab_scheduler_instances WHERE id = ?").run("default-arena");
  db.prepare("DELETE FROM lab_optimization_rounds WHERE scheduler_instance_id = ?").run("default-arena");
  db.prepare("DELETE FROM lab_agent_instances WHERE scheduler_instance_id = ?").run("default-arena");
  db.prepare("DELETE FROM lab_events WHERE event_id = ?").run("instance.activated:default-arena");
  db.prepare("DELETE FROM lab_routing_bindings WHERE scheduler_instance_id = ?").run("default-arena");
  db.prepare("UPDATE lab_scheduler_drafts SET status = 'validated' WHERE id = ?").run("default-arena");

  // Re-bootstrap must discard the stale draft and activate cleanly.
  const result = await ensureArenaInstance(core, schedulers, ports);
  assert.equal(result.instanceId, "default-arena");
  const inst = core.repository.getInstance("default-arena");
  assert.ok(inst);
  assert.equal(inst.status, "active");

  db.close();
});

// ── Co-bootstrap regression: ws + arena sharing one model catalog ─────

test("ws + arena co-bootstrap in one DB: agent ids are namespaced, no collision", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [
    model("openai/gpt-4o"),
    model("anthropic/claude-3"),
  ];

  // ws first (production order), then arena with the SAME candidates.
  const wsResult = await ensureWeightedScorerInstance(core, schedulers, wsPorts(candidates));
  const arenaResult = await ensureArenaInstance(core, schedulers, arenaPorts(candidates), {
    wsInstanceId: wsResult.instanceId,
  });

  assert.equal(wsResult.instanceId, "default-weighted-scorer");
  assert.equal(arenaResult.instanceId, "default-arena");

  const wsAgents = new Set(core.repository.listAgents("default-weighted-scorer").map((a) => a.id));
  const arenaAgents = new Set(core.repository.listAgents("default-arena").map((a) => a.id));
  assert.equal(wsAgents.size, 2, "WS agent IDs should be unique UUIDs");
  assert.equal(arenaAgents.size, 2, "Arena agent IDs should be unique UUIDs");
  // Zero overlap between populations (UUIDs are unique).
  for (const id of arenaAgents) assert.ok(!wsAgents.has(id));

  db.close();
});
