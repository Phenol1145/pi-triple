/**
 * Experiment integration test — end-to-end wiring with FAKE ModelPort.
 *
 * Covers T6 of `docs/plans/2026-07-27-agent-lab-phase-6a-experiment-runtime.md`:
 *
 * (a) context.transformed / model.requested / model.completed event chain
 *     in EventLog
 * (b) identity carries schedulerInstanceId / workLoopId / agentInstanceId
 * (c) DataAPIImpl.listEvents can SEE the events (I1 closed loop)
 * (d) usage aggregated in result.output.standard
 * (e) checkpoint parentCheckpointId lineage across two runs
 * (f) experiment agent storage/checkpoint namespaces don't collide with
 *     a same-model ws-style agent id (M7 isolation)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import { DataAPIImpl } from "../src/optimizer/data-api.ts";
import {
  createExperimentRuntime,
  registerWorkLoopDefinition,
  BUDGETED_HISTORY_DEFINITION,
} from "../src/runtime/create-experiment-runtime.ts";
import { budgetedHistory } from "../src/workloops/budgeted-history.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import type {
  ModelPort,
  ToolPort,
  ArtifactPort,
  WorkContext,
  WorkMessage,
  StandardAgentOutput,
  LabEvent,
  SchedulerDefinition,
  SchedulerInstanceDraftSpec,
} from "../src/core/contracts.ts";

// ── Fake ModelPort ──────────────────────────────────────────────────

/**
 * Controllable fake ModelPort that records calls and returns
 * pre-configured responses.  No real API calls.
 */
class FakeModelPort implements ModelPort {
  callLog: Array<{ context: WorkContext; options?: Record<string, unknown> }> = [];
  private responses: Array<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }>;
  private idx = 0;

  constructor(responses: Array<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }>) {
    this.responses = responses;
  }

  async complete(
    context: WorkContext,
    options?: Record<string, unknown>,
  ): Promise<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }> {
    this.callLog.push({ context, options });
    const r = this.responses[this.idx] ?? this.responses[this.responses.length - 1];
    if (!r) throw new Error("no fake response configured");
    this.idx++;
    return { ...r, message: { ...r.message }, usage: r.usage ? { ...r.usage } : undefined };
  }
}

// ── Fake ToolPort / ArtifactPort ─────────────────────────────────────

function fakeTools(): ToolPort {
  return { execute: async () => { throw new Error("no tools in managed loop"); } };
}

function fakeArtifacts(): ArtifactPort {
  const store = new Map<string, unknown>();
  return {
    put: async (v: unknown) => {
      const ref = `art-${crypto.randomUUID()}`;
      store.set(ref, v);
      return ref;
    },
    get: async (ref: string) => store.get(ref),
  };
}

// ── Scheduler definition helper ─────────────────────────────────────

function testSchedulerDef(): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "context-experiment",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: {},
    tunablePaths: [],
    validateParameters: () => ({ ok: true as const, value: {} }),
    validateAgentDefinition: () => ({ ok: true as const, value: {} }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<WorkLoopRunRequest> = {}): WorkLoopRunRequest {
  return {
    traceId: "trace-int-1",
    executionId: "exec-int-1",
    agentInstanceId: "agent-test-model-budgeted",
    optimizationRoundId: "round-int-1",
    workLoopId: "budgeted-history",
    workLoopVersion: "1.0.0",
    config: { model: "test-model", budgetTokens: 8192 },
    task: "integration test task",
    schedulerInstanceId: "si-experiment-1",
    dispatchId: "dispatch-abc",
    ...overrides,
  };
}

/**
 * Create a fully wired experiment runtime + scheduler instance + agent
 * using `createExperimentRuntime` with fake ports.
 */
function setupExperimentRuntime(opts?: {
  modelResponses?: Array<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }>;
}) {
  const db = new DatabaseSync(":memory:");
  const fakeModel = new FakeModelPort(
    opts?.modelResponses ?? [
      {
        message: { role: "assistant", content: "Hello from fake model!" },
        usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0004, turns: 1, toolCalls: 0, durationMs: 0 },
      },
    ],
  );

  const rt = createExperimentRuntime(db, {
    model: fakeModel,
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  // Register budgeted-history definition + implementation
  registerWorkLoopDefinition(rt.core, BUDGETED_HISTORY_DEFINITION);
  rt.workloopRegistry.register(budgetedHistory);

  // Register scheduler definition
  rt.core.definitions.register(testSchedulerDef());

  // Create scheduler instance + agent via control plane
  const controlPlane = new ControlPlane(rt.core.definitions, rt.core.repository, rt.core.events);
  const draftSpec: SchedulerInstanceDraftSpec = {
    id: "si-experiment-1",
    schedulerDefinition: { kind: "scheduler", id: "context-experiment", version: "1.0.0" },
    agents: [
      {
        id: "agent-test-model-budgeted",
        definition: {
          standard: { name: "test-lab-agent", capabilities: [], executionKind: "execute", labels: {} },
          workLoop: { id: "budgeted-history", version: "1.0.0", config: { model: "test-model" } },
          custom: {},
        },
      },
    ],
    fallbackChain: [],
    routingBindings: [],
  };
  controlPlane.createDraft(draftSpec);
  const activation = controlPlane.activateDraft(draftSpec.id);
  assert.ok(activation.schedulerInstanceId, "activation should return schedulerInstanceId");
  assert.ok(activation.roundId, "activation should return roundId");

  // Initialize agent runtime snapshot for the budgeted-history agent
  const ctx: WorkContext = budgetedHistory.initialContext({ model: "test-model" });
  const state = budgetedHistory.initialState({ model: "test-model" });
  rt.stateStore.initialize("agent-test-model-budgeted", ctx, state);

  // DataAPI authorized for this scheduler instance
  const dataApi = new DataAPIImpl(
    db,
    rt.core.repository,
    rt.core.events,
    ["si-experiment-1"],
    "opt-int-1",
  );

  return { rt, db, fakeModel, controlPlane, dataApi };
}

// ── Test (a): Event chain ───────────────────────────────────────────

test("(a) event chain: context.transformed / model.requested / model.completed in EventLog", async () => {
  const { rt, fakeModel } = setupExperimentRuntime();

  // Pre-seed an over-budget initial context so the budgeted-history
  // strategy fires and emits context.transformed.
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < 700; i++) {
    messages.push({ role: "user", content: `msg ${i} `.repeat(10) });
  }
  const largeContext: WorkContext = {
    systemPrompt: "you are helpful",
    messages,
    metadata: { contextId: "ctx-large", sourceRefs: [], artifactRefs: [] },
  };

  // Override the agent's runtime snapshot with the large context
  // so the strategy fires on the next run.
  rt.stateStore.commit("agent-test-model-budgeted", largeContext, {}, 1);

  const result = await rt.workloopRunner.run(makeRequest());
  assert.equal(result.status, "completed");

  // Query events by schedulerInstanceId
  const events = rt.core.events.query({ schedulerInstanceId: "si-experiment-1" });
  // Sort by sequence number embedded in eventId
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });

  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("agent.started"), `missing agent.started in ${types}`);
  assert.ok(types.includes("workloop.started"), `missing workloop.started in ${types}`);
  // context.transformed must be present — the large context exceeds budgetTokens
  assert.ok(types.includes("context.transformed"), `missing context.transformed in ${types}`);
  // model.requested and model.completed should be present (emitted by instrumented port via sdk.telemetry)
  assert.ok(types.includes("model.requested"), `missing model.requested in ${types}`);
  assert.ok(types.includes("model.completed"), `missing model.completed in ${types}`);
  assert.ok(types.includes("workloop.completed"), `missing workloop.completed in ${types}`);
  assert.ok(types.includes("agent.completed"), `missing agent.completed in ${types}`);

  // Verify event ordering: context.transformed before model.requested
  const xformIdx = types.indexOf("context.transformed");
  const reqIdx = types.indexOf("model.requested");
  const compIdx = types.indexOf("model.completed");
  assert.ok(xformIdx < reqIdx, "context.transformed should precede model.requested");
  assert.ok(reqIdx < compIdx, "model.requested should precede model.completed");

  // Verify the transform event metrics are sane
  const xformEvent = events.find((e) => e.eventType === "context.transformed");
  assert.ok(xformEvent, "context.transformed event must exist");
  const payload = xformEvent!.payload as Record<string, unknown>;
  assert.equal(payload.strategyId, "budgeted-history");
  assert.equal(payload.kind, "truncate");
  assert.ok(xformEvent!.metrics !== undefined, "metrics must be present");
  assert.ok((xformEvent!.metrics!.beforeTokens as number) > (xformEvent!.metrics!.afterTokens as number),
    "beforeTokens should exceed afterTokens after truncation");
  assert.ok((xformEvent!.metrics!.droppedSegments as number) > 0,
    "should have dropped some segments");
});

// ── Test (b): Identity ──────────────────────────────────────────────

test("(b) identity: events carry schedulerInstanceId / workLoopId / agentInstanceId", async () => {
  const { rt } = setupExperimentRuntime();

  await rt.workloopRunner.run(makeRequest());

  const events = rt.core.events.query({ schedulerInstanceId: "si-experiment-1" });
  // Filter to only events emitted by the workloop run (skip control-plane events)
  const runEvents = events.filter((e) =>
    e.eventType !== "instance.activated",
  );
  assert.ok(runEvents.length >= 4, `expected at least 4 run events, got ${runEvents.length}`);

  for (const event of runEvents) {
    assert.equal(event.identity.schedulerInstanceId, "si-experiment-1");
    assert.equal(event.identity.dispatchId, "dispatch-abc");
    assert.equal(event.identity.agentInstanceId, "agent-test-model-budgeted");
    assert.equal(event.identity.workLoopId, "budgeted-history");
    assert.equal(event.identity.workLoopVersion, "1.0.0");
  }
});

// ── Test (c): DataAPIImpl.listEvents closed loop (I1) ──────────────

test("(c) DataAPIImpl.listEvents can see experiment events (I1 closed loop)", async () => {
  const { rt, dataApi } = setupExperimentRuntime();

  await rt.workloopRunner.run(makeRequest());

  const apiEvents = dataApi.listEvents({
    schedulerInstanceId: "si-experiment-1",
    types: ["model.requested", "model.completed"],
  });

  assert.ok(apiEvents.length >= 2, `expected at least 2 model events from DataAPI, got ${apiEvents.length}`);
  const types = apiEvents.map((e) => e.eventType);
  assert.ok(types.includes("model.requested"));
  assert.ok(types.includes("model.completed"));

  // Verify identity is intact through DataAPI
  for (const evt of apiEvents) {
    assert.equal(evt.identity.schedulerInstanceId, "si-experiment-1");
    assert.equal(evt.identity.agentInstanceId, "agent-test-model-budgeted");
  }
});

// ── Test (d): Usage aggregation ─────────────────────────────────────

test("(d) usage: aggregated in result.output.standard", async () => {
  const { rt } = setupExperimentRuntime({
    modelResponses: [
      {
        message: { role: "assistant", content: "response" },
        usage: { input: 60, output: 25, cacheRead: 0, cacheWrite: 0, cost: 0.0005, turns: 1, toolCalls: 0, durationMs: 0 },
      },
    ],
  });

  const result = await rt.workloopRunner.run(makeRequest());

  assert.ok(result.output?.standard?.usage, "usage should be present");
  const usage = result.output.standard.usage!;
  assert.ok(usage.input > 0, "input tokens should be > 0");
  assert.ok(usage.output > 0, "output tokens should be > 0");
  assert.ok(usage.cost >= 0);
  assert.equal(usage.turns, 1);
  assert.equal(usage.toolCalls, 0);
  assert.ok(usage.durationMs >= 0);
});

// ── Test (e): Checkpoint lineage ────────────────────────────────────

test("(e) checkpoint parentCheckpointId lineage across saved checkpoints", async () => {
  const { rt } = setupExperimentRuntime({
    modelResponses: [
      { message: { role: "assistant", content: "run-1" }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 0 } },
      { message: { role: "assistant", content: "run-2" }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 0 } },
    ],
  });

  const agentId = "agent-test-model-budgeted";

  // Run 1 — the workloop completes, snapshot is committed
  const r1 = await rt.workloopRunner.run(makeRequest({ executionId: "exec-run-1" }));
  assert.equal(r1.status, "completed");

  // Run 2 — another successful run
  const r2 = await rt.workloopRunner.run(makeRequest({ executionId: "exec-run-2" }));
  assert.equal(r2.status, "completed");

  // Both runs succeeded — verify snapshot was updated
  const snap = rt.stateStore.get(agentId);
  assert.ok(snap, "snapshot should exist after two runs");
  assert.equal(snap!.version, 3, "version should be 3 after init + 2 commits"); // init=1, run1→2, run2→3

  // ── Real checkpoint lineage test ─────────────────────────────
  // Save two checkpoints through the CheckpointStore directly on a FRESH
  // agent namespace（run 1/2 的 MachineRuntime 自动 checkpoint 已占用
  // budgeted-history agent 的 latest 指针——用独立 agent 隔离 lineage 断言）。
  // The second one automatically gets parentCheckpointId from the first.
  const lineageAgentId = "agent-lineage-only";
  const snapCtx = snap!.value.context;
  const snapState = snap!.value.state;

  rt.checkpointStore.save(lineageAgentId, {
    checkpointId: "ck-parent",
    agentInstanceId: lineageAgentId,
    executionId: "exec-run-1",
    workLoopId: "budgeted-history",
    workLoopVersion: "1.0.0",
    optimizationRoundId: "round-int-1",
    label: "first checkpoint",
    context: snapCtx,
    state: snapState,
    createdAt: Date.now(),
  });

  rt.checkpointStore.save(lineageAgentId, {
    checkpointId: "ck-child",
    agentInstanceId: lineageAgentId,
    executionId: "exec-run-2",
    workLoopId: "budgeted-history",
    workLoopVersion: "1.0.0",
    optimizationRoundId: "round-int-1",
    label: "second checkpoint",
    context: snapCtx,
    state: snapState,
    createdAt: Date.now(),
  });

  // Retrieve and verify lineage
  const parent = rt.checkpointStore.get(lineageAgentId, "ck-parent");
  const child = rt.checkpointStore.get(lineageAgentId, "ck-child");
  assert.equal(parent.label, "first checkpoint");
  assert.equal(parent.parentCheckpointId, undefined,
    "first checkpoint should have no parent (or explicitly set)");

  assert.equal(child.checkpointId, "ck-child");
  assert.equal(child.label, "second checkpoint");
  assert.equal(child.parentCheckpointId, "ck-parent",
    "second checkpoint should link to first via parentCheckpointId");

  // Verify that saving does NOT mutate the caller's record (hygiene)
  const callerRecord = {
    checkpointId: "ck-caller",
    agentInstanceId: lineageAgentId,
    executionId: "exec-run-3",
    workLoopId: "budgeted-history",
    workLoopVersion: "1.0.0",
    optimizationRoundId: "round-int-1",
    label: "caller record",
    context: snapCtx,
    state: snapState,
    createdAt: Date.now(),
  };
  const parentCheckpointIdBefore = callerRecord.parentCheckpointId;
  rt.checkpointStore.save(lineageAgentId, callerRecord);
  assert.equal(callerRecord.parentCheckpointId, parentCheckpointIdBefore,
    "caller record should not be mutated by save");
});

// ── Test (f): M7 isolation ──────────────────────────────────────────

test("(f) M7 isolation: experiment agent storage/checkpoint namespaces don't collide", async () => {
  const { rt } = setupExperimentRuntime({
    modelResponses: [
      { message: { role: "assistant", content: "experiment" }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 0 } },
      { message: { role: "assistant", content: "ws-style" }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 0 } },
    ],
  });

  // Create a ws-style agent with the SAME model name but different id
  const wsAgentId = "agent-test-model-weighted";
  const wsCtx: WorkContext = {
    systemPrompt: "ws-style system prompt",
    messages: [],
    metadata: { contextId: "ctx-ws-init", sourceRefs: [], artifactRefs: [] },
  };
  rt.stateStore.initialize(wsAgentId, wsCtx, { wsMode: true });

  // Register a different workloop for the ws agent
  // We need to register another definition + impl, and initialize state
  rt.core.definitions.register({
    kind: "workloop",
    id: "ws-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
  });
  rt.workloopRegistry.register({
    id: "ws-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: () => wsCtx,
    initialState: () => ({ wsMode: true }),
    machine: {
      states: [{ id: "idle" }, { id: "done", terminal: true }],
      initial: "idle",
      transitions: (s, e) => (s === "idle" && e.type === "start" ? "done" : undefined),
      step: async () => ({
        context: {
          systemPrompt: "ws-done",
          messages: [{ role: "assistant", content: "ws-style" }],
          metadata: { contextId: "ctx-ws-done", sourceRefs: [], artifactRefs: [] },
        },
        state: { wsMode: true, done: true },
        terminal: {
          status: "completed",
          context: {
            systemPrompt: "ws-done",
            messages: [{ role: "assistant", content: "ws-style" }],
            metadata: { contextId: "ctx-ws-done", sourceRefs: [], artifactRefs: [] },
          },
          state: { wsMode: true, done: true },
        },
      }),
    },
  });

  // Run both agents
  const expResult = await rt.workloopRunner.run(makeRequest({
    executionId: "exec-exp",
    agentInstanceId: "agent-test-model-budgeted",
    workLoopId: "budgeted-history",
  }));
  assert.equal(expResult.status, "completed");

  const wsResult = await rt.workloopRunner.run({
    traceId: "trace-ws",
    executionId: "exec-ws",
    agentInstanceId: wsAgentId,
    optimizationRoundId: "round-ws",
    workLoopId: "ws-loop",
    workLoopVersion: "1.0.0",
    config: {},
    task: "ws task",
    schedulerInstanceId: "si-ws",
  });
  assert.equal(wsResult.status, "completed");

  // Verify both agents have independent snapshots
  const expSnap = rt.stateStore.get("agent-test-model-budgeted");
  const wsSnap = rt.stateStore.get(wsAgentId);
  assert.ok(expSnap, "experiment agent snapshot should exist");
  assert.ok(wsSnap, "ws-style agent snapshot should exist");
  assert.notEqual(expSnap!.version, undefined);
  assert.notEqual(wsSnap!.version, undefined);

  // Contexts are independent
  assert.notEqual(
    expSnap!.value.context.metadata.contextId,
    wsSnap!.value.context.metadata.contextId,
    "experiment and ws contexts should be independent",
  );

  // Checkpoints: verify separate namespace by saving to each
  rt.checkpointStore.save("agent-test-model-budgeted", {
    checkpointId: "ck-exp-1",
    agentInstanceId: "agent-test-model-budgeted",
    executionId: "exec-exp",
    workLoopId: "budgeted-history",
    workLoopVersion: "1.0.0",
    optimizationRoundId: "round-int-1",
    label: "exp-checkpoint",
    context: expSnap!.value.context,
    state: expSnap!.value.state,
    createdAt: Date.now(),
  });

  rt.checkpointStore.save(wsAgentId, {
    checkpointId: "ck-ws-1",
    agentInstanceId: wsAgentId,
    executionId: "exec-ws",
    workLoopId: "ws-loop",
    workLoopVersion: "1.0.0",
    optimizationRoundId: "round-ws",
    label: "ws-checkpoint",
    context: wsSnap!.value.context,
    state: wsSnap!.value.state,
    createdAt: Date.now(),
  });

  const expCk = rt.checkpointStore.get("agent-test-model-budgeted", "ck-exp-1");
  const wsCk = rt.checkpointStore.get(wsAgentId, "ck-ws-1");
  assert.equal(expCk.label, "exp-checkpoint");
  assert.equal(wsCk.label, "ws-checkpoint");

  // Cross-read should fail
  assert.throws(
    () => rt.checkpointStore.get("agent-test-model-budgeted", "ck-ws-1"),
    /checkpoint not found/,
  );
  assert.throws(
    () => rt.checkpointStore.get(wsAgentId, "ck-exp-1"),
    /checkpoint not found/,
  );
});
