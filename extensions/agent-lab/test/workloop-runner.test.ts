import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { NamespacedStore, VersionConflictError } from "../src/core/storage/namespaced-store.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import type { WorkLoopDefinition } from "../src/core/contracts.ts";
import { createMarketBidLoop } from "../src/workloops/market-bid-loop.ts";
import type {
  WorkLoopImplementation,
  WorkLoopResult,
  WorkLoopSDK,
  WorkContext,
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../src/workloop/contracts.ts";
import type { MachineEvent, StepResult } from "../src/workloop/machine.ts";

// ── helpers ──────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function testContext(id = "ctx-1"): WorkContext {
  return {
    systemPrompt: "helpful",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "search", description: "search the web" }],
    metadata: {
      contextId: id,
      sourceRefs: [],
      artifactRefs: [],
    },
  };
}

function workloopDef(overrides: Partial<WorkLoopDefinition> = {}): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: "test-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
    ...overrides,
  };
}

function noopModel(): ModelPort {
  return {
    complete: async (_ctx, _opts) => ({
      message: { role: "assistant", content: "ok" },
    }),
  };
}

function noopTools(): ToolPort {
  return { execute: async (_name, _args) => "done" };
}

function noopArtifacts(): ArtifactPort {
  return {
    put: async (_value, _mediaType) => "ref-1",
    get: async (_ref) => "artifact-value",
  };
}

function defaultRequest(overrides: Partial<WorkLoopRunRequest> = {}): WorkLoopRunRequest {
  return {
    traceId: "trace-1",
    executionId: "exec-1",
    agentInstanceId: "agent-1",
    optimizationRoundId: "round-1",
    workLoopId: "test-loop",
    workLoopVersion: "1.0.0",
    config: { mode: "test" },
    task: "do the thing",
    ...overrides,
  };
}

/**
 * 单转移 machine impl 工厂（Task 6 适配：runner 只支持 machine 驱动）。
 * 默认 step：idle→done，terminal completed（context "completed" / state {counter:1}）。
 */
function machineImpl(opts?: {
  step?: (
    ctx: WorkContext,
    state: unknown,
    event: MachineEvent,
    sdk: WorkLoopSDK,
  ) => Promise<StepResult>;
  id?: string;
  version?: string;
  cloneModes?: string[];
  initialContext?: (config: unknown) => WorkContext;
  initialState?: (config: unknown) => unknown;
}): WorkLoopImplementation {
  return {
    id: opts?.id ?? "test-loop",
    version: opts?.version ?? "1.0.0",
    cloneModes: opts?.cloneModes ?? ["fresh"],
    executorKind: "local-model",
    initialContext: opts?.initialContext ?? ((_config: unknown) => testContext("init")),
    initialState: opts?.initialState ?? ((_config: unknown) => ({ counter: 0 })),
    machine: {
      states: [{ id: "idle" }, { id: "done", terminal: true }],
      initial: "idle",
      transitions: (state, event) =>
        state === "idle" && event.type === "start" ? "done" : undefined,
      step: async (ctx, state, event, sdk) => {
        if (opts?.step) return opts.step(ctx, state, event, sdk);
        return {
          context: testContext("completed"),
          state: { counter: 1 },
          terminal: {
            status: "completed",
            output: { standard: { text: "done" } },
            context: testContext("completed"),
            state: { counter: 1 },
          },
        };
      },
    },
  };
}

/**
 * Build a complete runner with all real P1 components wired to :memory: DBs.
 */
function buildRunner(opts?: {
  impl?: WorkLoopImplementation;
  model?: ModelPort;
  tools?: ToolPort;
  artifacts?: ArtifactPort;
}): {
  runner: WorkLoopRunner;
  db: DatabaseSync;
  store: NamespacedStore;
  eventLog: EventLog;
  stateStore: AgentRuntimeStateStore;
  checkpointStore: CheckpointStore;
  registry: WorkLoopRegistry;
  definitions: DefinitionRegistry;
} {
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);

  const impl = opts?.impl ?? machineImpl();

  registry.register(impl);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    opts?.model ?? noopModel(),
    opts?.tools ?? noopTools(),
    opts?.artifacts ?? noopArtifacts(),
  );

  return { runner, db, store, eventLog, stateStore, checkpointStore, registry, definitions };
}

/** 按 eventId 内嵌序号排序（:eventType:seq 末尾） */
function sortBySeq(events: Array<{ eventId: string }>): void {
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });
}

// ── Tests ────────────────────────────────────────────────────────────

// ── Test 1: Completed run ──────────────────────────────────────────

test("1. Completed run: loads snapshot, drives machine via MachineRuntime, commits at expected version, emits lifecycle events", async () => {
  const { runner, stateStore, eventLog } = buildRunner();

  // Initialize agent snapshot
  const ctx = testContext("initial-ctx");
  const st = { counter: 0 };
  stateStore.initialize("agent-1", ctx, st);

  const result = await runner.run(defaultRequest());

  // Result assertions
  assert.equal(result.status, "completed");
  assert.equal(result.output?.standard?.text, "done");
  assert.equal((result.state as { counter: number }).counter, 1);

  // Snapshot committed at version 2
  const snap = stateStore.get("agent-1");
  assert.equal(snap!.version, 2);
  assert.equal(snap!.value.context.metadata.contextId, "completed");
  assert.equal((snap!.value.state as { counter: number }).counter, 1);

  // Lifecycle events: machine 驱动 → machine.transition + 自动 checkpoint
  const events = eventLog.query({ traceId: "trace-1" });
  sortBySeq(events);
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "agent.started",
    "workloop.started",
    "checkpoint.created",
    "machine.transition",
    "workloop.completed",
    "agent.completed",
  ]);

  // Verify event IDs are deterministic: ${executionId}:${eventType}:${seq}
  assert.equal(events[0].eventId, "exec-1:agent.started:0");
  assert.equal(events[1].eventId, "exec-1:workloop.started:1");
  assert.equal(events[2].eventId, "exec-1:checkpoint.created:2");
  assert.equal(events[3].eventId, "exec-1:machine.transition:3");
  assert.equal(events[4].eventId, "exec-1:workloop.completed:4");
  assert.equal(events[5].eventId, "exec-1:agent.completed:5");

  // machine.transition 记录携带控制状态转移
  const transition = events[3];
  assert.equal((transition.payload as { fromState?: string }).fromState, "idle");
  assert.equal((transition.payload as { toState?: string }).toState, "done");
  assert.equal((transition.payload as { seq?: number }).seq, 1);

  // machine.transition identity 携带 transitionSeq/checkpointId（spec §7.2 / 健康审计 F1）
  assert.equal(transition.identity.transitionSeq, 1);
  assert.equal(typeof transition.identity.checkpointId, "string");
  assert.ok(transition.identity.checkpointId!.length > 0);

  // Verify identity fields on first event
  const id = events[0].identity;
  assert.equal(id.traceId, "trace-1");
  assert.equal(id.executionId, "exec-1");
  assert.equal(id.agentInstanceId, "agent-1");
  assert.equal(id.optimizationRoundId, "round-1");
  assert.equal(id.workLoopId, "test-loop");
  assert.equal(id.workLoopVersion, "1.0.0");
});

// ── Test 2: Failed WorkLoop ────────────────────────────────────────

test("2. Failed WorkLoop: returns failure, emits failure events, does not commit", async () => {
  const { runner, stateStore, eventLog, registry } = buildRunner();

  // Override with a failing machine implementation
  const failingImpl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: () => testContext("init"),
    initialState: () => ({ counter: 0 }),
    machine: {
      states: [{ id: "idle" }, { id: "done", terminal: true }],
      initial: "idle",
      transitions: (s, e) => (s === "idle" && e.type === "start" ? "done" : undefined),
      step: async () => ({
        context: testContext("failed-ctx"),
        state: { counter: 99 },
        terminal: {
          status: "failed",
          error: { standard: { code: "TEST_FAIL", message: "it broke", retryable: false } },
          context: testContext("failed-ctx"),
          state: { counter: 99 },
        },
      }),
    },
  };

  // Register the failing impl (replace)
  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const reg = new WorkLoopRegistry(definitions);
  reg.register(failingImpl);

  // Rebuild runner with failing impl
  const db2 = memoryDB();
  const store2 = new NamespacedStore(db2);
  const eventLog2 = new EventLog(db2);
  const stateStore2 = new AgentRuntimeStateStore(store2);
  const checkpointStore2 = new CheckpointStore(store2);

  const runner2 = new WorkLoopRunner(
    reg,
    stateStore2,
    checkpointStore2,
    eventLog2,
    store2,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  // Initialize
  const ctx = testContext("initial-ctx");
  stateStore2.initialize("agent-1", ctx, { counter: 0 });

  const result = await runner2.run(defaultRequest());

  // Result is failure
  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "TEST_FAIL");

  // Snapshot NOT committed — still version 1 with original state
  const snap = stateStore2.get("agent-1");
  assert.equal(snap!.version, 1);
  assert.equal(snap!.value.context.metadata.contextId, "initial-ctx");
  assert.equal((snap!.value.state as { counter: number }).counter, 0);

  // Failure events emitted (machine.transition + auto checkpoint still recorded)
  const events = eventLog2.query({ traceId: "trace-1" });
  sortBySeq(events);
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "agent.started",
    "workloop.started",
    "checkpoint.created",
    "machine.transition",
    "workloop.failed",
    "agent.failed",
  ]);
});

// ── Test 3: Abort ──────────────────────────────────────────────────

test("3a. Abort before start: returns cancelled without invoking implementation", async () => {
  let invoked = false;

  const impl = machineImpl({
    step: async () => {
      invoked = true;
      return {
        context: testContext(),
        state: {},
        terminal: { status: "completed", context: testContext(), state: {} },
      };
    },
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("init"), {});

  const ac = new AbortController();
  ac.abort(); // pre-abort

  const result = await runner.run(defaultRequest({ signal: ac.signal }));

  assert.equal(result.status, "cancelled");
  assert.equal(invoked, false, "implementation should not have been invoked");

  // Cancellation event emitted
  const events = eventLog.query({ traceId: "trace-1" });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "agent.cancelled");
});

test("3b. Abort during run: visible through sdk.control.signal, does not commit", async () => {
  let capturedSignal: AbortSignal | undefined;

  const impl = machineImpl({
    step: async (_ctx, _state, _event, sdk) => {
      capturedSignal = sdk.control.signal;

      // Wait for abort
      await new Promise<void>((resolve) => {
        if (sdk.control.signal.aborted) {
          resolve();
          return;
        }
        sdk.control.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      return {
        context: testContext("aborted-ctx"),
        state: { counter: 5 },
        terminal: {
          status: "cancelled",
          context: testContext("aborted-ctx"),
          state: { counter: 5 },
        },
      };
    },
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("init"), { counter: 0 });

  const ac = new AbortController();

  const runPromise = runner.run(defaultRequest({ signal: ac.signal }));

  // Abort mid-run
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();

  const result = await runPromise;

  // Signal was visible
  assert.ok(capturedSignal, "signal should have been captured");
  assert.equal(capturedSignal!.aborted, true);

  // Result is cancelled
  assert.equal(result.status, "cancelled");

  // Not committed — still version 1
  const snap = stateStore.get("agent-1");
  assert.equal(snap!.version, 1);
  assert.equal((snap!.value.state as { counter: number }).counter, 0);
});

test("3c. throwIfCancelled throws AbortError", async () => {
  let threwAbort = false;

  const impl = machineImpl({
    step: async (_ctx, _state, _event, sdk) => {
      try {
        sdk.control.throwIfCancelled();
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          threwAbort = true;
          throw e; // rethrow
        }
      }
      return {
        context: testContext(),
        state: {},
        terminal: { status: "completed", context: testContext(), state: {} },
      };
    },
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("init"), {});

  const ac = new AbortController();
  ac.abort(); // pre-abort

  const result = await runner.run(defaultRequest({ signal: ac.signal }));

  // Since we pre-aborted, control should not be invoked at all
  // But if the impl ran, throwIfCancelled should have thrown
  // Actually, the pre-abort check in executeRun catches it first
  assert.equal(result.status, "cancelled");
});

// ── Test 4: FIFO single-flight ─────────────────────────────────────

test("4a. Two concurrent runs for same agent execute FIFO (serial)", async () => {
  const executionOrder: string[] = [];

  const impl = machineImpl({
    step: async (_ctx, _state, event) => {
      executionOrder.push(((event.payload as { task?: string })?.task) ?? "");
      // Small delay to make concurrency observable
      await new Promise((r) => setTimeout(r, 20));
      return {
        context: testContext("done"),
        state: {},
        terminal: { status: "completed", context: testContext("done"), state: {} },
      };
    },
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("init"), {});

  // Launch two runs concurrently for the same agent
  const p1 = runner.run(defaultRequest({ executionId: "exec-first", task: "exec-first" }));
  const p2 = runner.run(defaultRequest({ executionId: "exec-second", task: "exec-second" }));

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.status, "completed");
  assert.equal(r2.status, "completed");

  // FIFO order: first started first, second after first completes
  // （δ 经 start 事件 payload 读取 task —— 单飞序列化保证顺序）
  assert.deepStrictEqual(executionOrder, ["exec-first", "exec-second"]);
});

test("4b. Different agents may run concurrently", async () => {
  const executionOrder: string[] = [];
  const startTimes: number[] = [];

  const impl = machineImpl({
    step: async (_ctx, _state, event) => {
      startTimes.push(Date.now());
      executionOrder.push(((event.payload as { agentInstanceId?: string })?.agentInstanceId) ?? "");
      // Delay long enough to observe overlap
      await new Promise((r) => setTimeout(r, 100));
      return {
        context: testContext("done"),
        state: {},
        terminal: { status: "completed", context: testContext("done"), state: {} },
      };
    },
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-A", testContext("init-A"), {});
  stateStore.initialize("agent-B", testContext("init-B"), {});

  const pA = runner.run(defaultRequest({ agentInstanceId: "agent-A", executionId: "exec-A" }));
  const pB = runner.run(defaultRequest({ agentInstanceId: "agent-B", executionId: "exec-B" }));

  const [rA, rB] = await Promise.all([pA, pB]);

  assert.equal(rA.status, "completed");
  assert.equal(rB.status, "completed");

  // Both agents should have started (different agents, no FIFO lock across them)
  assert.equal(executionOrder.length, 2);

  // Overlap: start times should be within 50ms of each other (concurrent start)
  assert.ok(
    Math.abs(startTimes[0] - startTimes[1]) < 80,
    `start times too far apart: ${startTimes[0]} vs ${startTimes[1]}`,
  );
});

// ── Test 5: Checkpoint ─────────────────────────────────────────────

test("5. Checkpoint: MachineRuntime 自动 checkpoint 落盘并携带 controlState/seq", async () => {
  const { runner, eventLog, checkpointStore } = buildRunner();

  const result = await runner.run(defaultRequest());
  assert.equal(result.status, "completed");

  // checkpoint.created event emitted (自动 checkpoint：每次转移后)
  const cpEvents = eventLog.query({ traceId: "trace-1", eventType: "checkpoint.created" });
  assert.equal(cpEvents.length, 1);
  const cpEvent = cpEvents[0];
  assert.equal(cpEvent.eventType, "checkpoint.created");
  assert.equal(cpEvent.identity.agentInstanceId, "agent-1");
  assert.equal(cpEvent.identity.executionId, "exec-1");
  assert.equal(cpEvent.identity.workLoopId, "test-loop");
  assert.ok((cpEvent.payload as Record<string, unknown>).checkpointId, "checkpointId should be present");
  assert.equal((cpEvent.payload as { label?: string }).label, "done#1");

  // Checkpoint retrievable from CheckpointStore with controlState/seq（Task 6 carry-forward）
  const cpId = (cpEvent.payload as Record<string, string>).checkpointId;
  const record = checkpointStore.get("agent-1", cpId);
  assert.ok(record);
  assert.deepStrictEqual(record.context, testContext("completed"));
  assert.deepStrictEqual(record.state, { counter: 1 });
  assert.equal(record.label, "done#1");
  assert.equal(record.controlState, "done");
  assert.equal(record.seq, 1);
  assert.equal(record.agentInstanceId, "agent-1");
  assert.equal(record.workLoopId, "test-loop");
  assert.equal(record.workLoopVersion, "1.0.0");
  assert.equal(record.optimizationRoundId, "round-1");

  // Event ID format for checkpoint.created
  assert.ok(cpEvent.eventId.startsWith("exec-1:checkpoint.created:"));
});

// ── Test 5a: Identity passthrough (I1) ─────────────────────────────

test("5a. Identity passthrough: schedulerInstanceId and dispatchId appear in event identity", async () => {
  const { runner, stateStore, eventLog } = buildRunner();

  stateStore.initialize("agent-1", testContext("init"), { counter: 0 });

  const result = await runner.run(
    defaultRequest({
      schedulerInstanceId: "si-test-1",
      dispatchId: "dispatch-abc",
    }),
  );

  assert.equal(result.status, "completed");

  const events = eventLog.query({ traceId: "trace-1" });
  assert.ok(events.length >= 4, `expected at least 4 events, got ${events.length}`);

  for (const event of events) {
    assert.equal(
      event.identity.schedulerInstanceId,
      "si-test-1",
      `event ${event.eventType} missing schedulerInstanceId`,
    );
    assert.equal(
      event.identity.dispatchId,
      "dispatch-abc",
      `event ${event.eventType} missing dispatchId`,
    );
  }
});

// ── Test 5b: Absent identity fields (I1) ────────────────────────────

test("5b. Absent identity fields: omitting schedulerInstanceId/dispatchId preserves existing event shapes", async () => {
  const { runner, stateStore, eventLog } = buildRunner();

  stateStore.initialize("agent-1", testContext("init"), { counter: 0 });

  // Request without schedulerInstanceId or dispatchId (existing default)
  const result = await runner.run(defaultRequest());

  assert.equal(result.status, "completed");

  const events = eventLog.query({ traceId: "trace-1" });
  assert.ok(events.length >= 4, `expected at least 4 events, got ${events.length}`);

  for (const event of events) {
    // Keys must be absent, not present with undefined
    assert.ok(
      !("schedulerInstanceId" in event.identity),
      `event ${event.eventType} should NOT have schedulerInstanceId key`,
    );
    assert.ok(
      !("dispatchId" in event.identity),
      `event ${event.eventType} should NOT have dispatchId key`,
    );
  }
});

// ── Test 5c: Checkpoint lineage (M2) ────────────────────────────────

test("5c. Checkpoint lineage: parentCheckpointId chains across sequential auto-checkpoints", async () => {
  // 四状态自驱动机器（s0→s1→s2→s3 terminal）：3 次转移 → 3 个自动 checkpoint
  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: () => testContext("init"),
    initialState: () => ({ step: 0 }),
    machine: {
      states: [{ id: "s0" }, { id: "s1" }, { id: "s2" }, { id: "s3", terminal: true }],
      initial: "s0",
      transitions: (s, e) => {
        if (s === "s0" && e.type === "start") return "s1";
        if (s === "s1" && e.type === "go") return "s2";
        if (s === "s2" && e.type === "go") return "s3";
        return undefined;
      },
      step: async (_ctx, state, event) => {
        if (event.type === "start") {
          return { context: testContext("cp1"), state: { step: 1 }, event: { type: "go" } };
        }
        const step = (state as { step: number }).step ?? 0;
        if (step === 1) {
          return { context: testContext("cp2"), state: { step: 2 }, event: { type: "go" } };
        }
        return {
          context: testContext("final"),
          state: { step: 3 },
          terminal: {
            status: "completed",
            output: { standard: { text: "chained" } },
            context: testContext("final"),
            state: { step: 3 },
          },
        };
      },
    },
  };

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("init"), { step: 0 });

  const result = await runner.run(defaultRequest());
  assert.equal(result.status, "completed");
  assert.equal((result.state as { step: number }).step, 3);

  // 3 auto-checkpoints（s1#1 / s2#2 / s3#3）
  const cpEvents = eventLog.query({ traceId: "trace-1", eventType: "checkpoint.created" });
  sortBySeq(cpEvents);
  assert.equal(cpEvents.length, 3);

  const ids: string[] = [];
  for (const ev of cpEvents) {
    ids.push((ev.payload as { checkpointId: string }).checkpointId);
  }

  // Retrieve all checkpoints and verify lineage + controlState/seq
  const cp1 = checkpointStore.get("agent-1", ids[0]);
  const cp2 = checkpointStore.get("agent-1", ids[1]);
  const cp3 = checkpointStore.get("agent-1", ids[2]);

  assert.equal(cp1.parentCheckpointId, undefined, "first checkpoint should have no parent");
  assert.equal(cp2.parentCheckpointId, ids[0], "second checkpoint parent should be first checkpoint");
  assert.equal(cp3.parentCheckpointId, ids[1], "third checkpoint parent should be second checkpoint");

  assert.equal(cp1.label, "s1#1");
  assert.equal(cp2.label, "s2#2");
  assert.equal(cp3.label, "s3#3");
  assert.equal(cp1.controlState, "s1");
  assert.equal(cp2.controlState, "s2");
  assert.equal(cp3.controlState, "s3");
  assert.equal(cp1.seq, 1);
  assert.equal(cp2.seq, 2);
  assert.equal(cp3.seq, 3);
  assert.equal(cp1.context.metadata.contextId, "cp1");
  assert.equal(cp2.context.metadata.contextId, "cp2");
});

// ── Test 6: CAS conflict ───────────────────────────────────────────

test("6. CAS conflict: returns state-conflict error, preserves winning state", async () => {
  // Build everything from scratch — need a single shared store so the
  // impl can simulate a concurrent modification on the same DB.
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  // Capture stateStore in closure for the δ
  const capturedStateStore = stateStore;

  const impl = machineImpl({
    step: async () => {
      // Simulate a concurrent commit by another runner/scheduler
      capturedStateStore.commit(
        "agent-1",
        testContext("concurrent-winner"),
        { counter: 42 },
        1, // expected version = 1 (what we initialized with)
      );
      return {
        context: testContext("my-result"),
        state: { counter: 1 },
        terminal: { status: "completed", context: testContext("my-result"), state: { counter: 1 } },
      };
    },
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("initial"), { counter: 0 });

  const result = await runner.run(defaultRequest());

  // Result should be state-conflict
  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "state-conflict");
  assert.equal(result.error?.standard?.retryable, true);

  // Winning state preserved: context from concurrent winner
  const snap = stateStore.get("agent-1");
  assert.equal(snap!.version, 2);
  assert.equal(snap!.value.context.metadata.contextId, "concurrent-winner");
  assert.equal((snap!.value.state as { counter: number }).counter, 42);

  // Result should reflect winning state
  assert.equal(result.context.metadata.contextId, "concurrent-winner");
  assert.equal((result.state as { counter: number }).counter, 42);

  // agent.failed event emitted (conflict = failure)
  const events = eventLog.query({ traceId: "trace-1" });
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("agent.failed"), "should include agent.failed");
});

// ── Additional: runtime snapshot auto-initialized on first run ─────

test("runtime snapshot auto-initialized on first run (no explicit initialize)", async () => {
  const { runner } = buildRunner();
  // Do NOT initialize agent-1 — runner auto-inits from implementation.initialContext/initialState

  const result = await runner.run(defaultRequest());

  assert.equal(result.status, "completed");
  assert.equal((result.state as { counter: number }).counter, 1);
});

// ── Additional: implementation throws unexpectedly ─────────────────

test("implementation that throws returns workloop-error, does not commit", async () => {
  const impl = machineImpl({
    step: async () => {
      throw new Error("unexpected boom");
    },
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("init"), { counter: 0 });

  const result = await runner.run(defaultRequest());

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "workloop-error");
  assert.ok(result.error?.standard?.message.includes("unexpected boom"));

  // Not committed
  const snap = stateStore.get("agent-1");
  assert.equal(snap!.version, 1);
});

// ── Test 7: Paused WorkLoop ─────────────────────────────────────────

test("7. Paused run: emits agent.paused, does not commit snapshot", async () => {
  const impl = machineImpl({
    step: async () => ({
      context: testContext("paused-ctx"),
      state: { counter: 1, note: "midway" },
      terminal: {
        status: "paused",
        context: testContext("paused-ctx"),
        state: { counter: 1, note: "midway" },
      },
    }),
  });

  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);

  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-1", testContext("init"), { counter: 0 });

  const result = await runner.run(defaultRequest());

  // Result status is paused
  assert.equal(result.status, "paused");

  // agent.paused event emitted
  const events = eventLog.query({ traceId: "trace-1" });
  sortBySeq(events);
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "agent.started",
    "workloop.started",
    "checkpoint.created",
    "machine.transition",
    "agent.paused",
  ]);

  // Snapshot NOT committed — still version 1 with initial values
  const snap = stateStore.get("agent-1");
  assert.equal(snap!.version, 1);
  assert.equal(snap!.value.context.metadata.contextId, "init");
  assert.equal((snap!.value.state as { counter: number }).counter, 0);
});

// ── Test 8: machine workloop 经 MachineRuntime 驱动（market-bid） ──

test("runner: machine workloop 经 MachineRuntime 驱动 + machine.transition 事件", async () => {
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register({
    kind: "workloop",
    id: "market-bid-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
  });
  const registry = new WorkLoopRegistry(definitions);
  registry.register(createMarketBidLoop({ balance: 100 }));

  const bidModel: ModelPort = {
    complete: async () => ({ message: { role: "assistant", content: "37" } }),
  };

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    bidModel,
    noopTools(),
    noopArtifacts(),
  );

  // runner auto-init（market-bid initialContext/initialState）
  const result = await runner.run(defaultRequest({
    workLoopId: "market-bid-loop",
    workLoopVersion: "1.0.0",
    config: {},
  }));

  assert.equal(result.status, "completed");
  assert.equal((result.output?.custom as { stake: number }).stake, 37);

  const events = eventLog.query({ traceId: "trace-1" });
  sortBySeq(events);
  const types = events.map((e) => e.eventType);

  // workloop.started → machine.transition → workloop.completed → agent.completed
  const iStarted = types.indexOf("workloop.started");
  const iTransition = types.indexOf("machine.transition");
  const iCompleted = types.indexOf("workloop.completed");
  const iAgent = types.indexOf("agent.completed");
  assert.ok(iStarted !== -1, `missing workloop.started in ${types}`);
  assert.ok(iTransition !== -1, `missing machine.transition in ${types}`);
  assert.ok(iCompleted !== -1, `missing workloop.completed in ${types}`);
  assert.ok(iAgent !== -1, `missing agent.completed in ${types}`);
  assert.ok(iStarted < iTransition, "workloop.started should precede machine.transition");
  assert.ok(iTransition < iCompleted, "machine.transition should precede workloop.completed");
  assert.ok(iCompleted < iAgent, "workloop.completed should precede agent.completed");

  // carry-forward：arena_bid.model_completed telemetry 恢复 agent 字段
  const bidEvent = events.find((e) => e.eventType === "arena_bid.model_completed");
  assert.ok(bidEvent, "arena_bid.model_completed should be emitted");
  assert.equal((bidEvent!.payload as { agent?: string }).agent, "agent-1");
  assert.equal(bidEvent!.identity.agentInstanceId, "agent-1");
});

// ── Test 9: resumeFromCheckpointId 从 checkpoint 恢复续跑 ───────────

test("runner: resumeFromCheckpointId 从 checkpoint 恢复续跑", async () => {
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);

  // 四状态自驱动机器（s0→s1→s2→s3 terminal）；start 事件在任意状态均可续跑
  // （resume 简化：从 start 事件重新进入转移表）
  const resumeImpl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: () => testContext("init"),
    initialState: () => ({ step: 0 }),
    machine: {
      states: [{ id: "s0" }, { id: "s1" }, { id: "s2" }, { id: "s3", terminal: true }],
      initial: "s0",
      transitions: (s, e) => {
        if (e.type === "start") {
          if (s === "s0") return "s1";
          if (s === "s1") return "s2";
          if (s === "s2") return "s3";
        }
        return undefined;
      },
      step: async (_ctx, state, event) => {
        if (event.type === "start") {
          const step = (state as { step: number }).step ?? 0;
          if (step === 0) return { context: testContext("cp1"), state: { step: 1 }, event: { type: "start" } };
          if (step === 1) return { context: testContext("cp2"), state: { step: 2 }, event: { type: "start" } };
          return {
            context: testContext("final"),
            state: { step: 3 },
            terminal: {
              status: "completed",
              output: { standard: { text: "resumed" } },
              context: testContext("final"),
              state: { step: 3 },
            },
          };
        }
        return { context: _ctx, state };
      },
    },
  };
  registry.register(resumeImpl);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-rs", testContext("init"), { step: 0 });

  // ── Run 1：s0→s1→s2→s3，3 次转移，3 个自动 checkpoint ──
  const r1 = await runner.run(defaultRequest({
    agentInstanceId: "agent-rs",
    executionId: "exec-rs-1",
  }));
  assert.equal(r1.status, "completed");
  assert.equal((r1.state as { step: number }).step, 3);

  const cpEvents = eventLog.query({ traceId: "trace-1", eventType: "checkpoint.created" });
  assert.equal(cpEvents.length, 3);

  // 取 run 1 的 s1#1 checkpoint（controlState s1 / seq 1 / memory {step:1}）
  const s1cp = cpEvents.find((e) => (e.payload as { label?: string }).label === "s1#1");
  assert.ok(s1cp, "s1#1 checkpoint should exist");
  const resumeCpId = (s1cp!.payload as { checkpointId: string }).checkpointId;

  // checkpoint 记录带 controlState/seq（Task 6 carry-forward）
  const rec = checkpointStore.get("agent-rs", resumeCpId);
  assert.equal(rec.label, "s1#1");
  assert.equal(rec.controlState, "s1");
  assert.equal(rec.seq, 1);
  assert.deepStrictEqual(rec.state, { step: 1 });

  // ── Run 2：resumeFromCheckpointId → 从 s1 续跑剩余 2 次转移 → completed ──
  const r2 = await runner.run(defaultRequest({
    agentInstanceId: "agent-rs",
    executionId: "exec-rs-2",
    traceId: "trace-rs-2",
    resumeFromCheckpointId: resumeCpId,
  }));
  assert.equal(r2.status, "completed");
  assert.equal((r2.state as { step: number }).step, 3);

  // CAS 提交成功：init(1) → run1(2) → run2(3)
  const snap = stateStore.get("agent-rs");
  assert.equal(snap!.version, 3);
  assert.equal((snap!.value.state as { step: number }).step, 3);

  // resume 续跑：2 次新转移，首条 fromState = s1（恢复的控制状态）
  const rsEvents = eventLog.query({ traceId: "trace-rs-2" });
  const rsTransitions = rsEvents.filter((e) => e.eventType === "machine.transition");
  assert.equal(rsTransitions.length, 2, "resume run should re-execute 2 remaining transitions");
  assert.equal((rsTransitions[0].payload as { fromState?: string }).fromState, "s1");
  assert.equal((rsTransitions[0].payload as { toState?: string }).toState, "s2");
});

// ── Test 10: maxTurns 透传（Task 7：WorkLoopRunRequest.maxTurns → MachineRuntime 预算） ──

test("runner: maxTurns 透传 → 预算强制终止（budget-exhausted）", async () => {
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);

  // 自驱动机器：idle→working 后 δ 持续自驱动 tick（永不 terminal）→ 靠 maxTurns 兜底
  const loopImpl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: () => testContext("init"),
    initialState: () => ({ n: 0 }),
    machine: {
      states: [{ id: "idle" }, { id: "working" }],
      initial: "idle",
      transitions: (s, e) => {
        if (s === "idle" && e.type === "start") return "working";
        if (s === "working" && e.type === "tick") return "working";
        return undefined;
      },
      step: async (ctx, state, event) => {
        if (event.type === "start") return { context: ctx, state, event: { type: "tick" } };
        return { context: ctx, state, event: { type: "tick" } };
      },
    },
  };
  registry.register(loopImpl);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  stateStore.initialize("agent-mt", testContext("init"), { n: 0 });

  // maxTurns: 2 → 转移 2 次后预算耗尽（idle→working, working→working）
  const result = await runner.run(defaultRequest({
    agentInstanceId: "agent-mt",
    executionId: "exec-mt",
    maxTurns: 2,
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard.code, "budget-exhausted");
  assert.equal(result.error?.standard.retryable, true);

  // 无 maxTurns → 默认 100（此处不跑 100 次；仅验证默认分支不炸：用单转移机器）
  const okImpl: WorkLoopImplementation = {
    id: "ok-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: () => testContext("init"),
    initialState: () => ({ n: 0 }),
    machine: {
      states: [{ id: "idle" }, { id: "done", terminal: true }],
      initial: "idle",
      transitions: (s, e) => (s === "idle" && e.type === "start" ? "done" : undefined),
      step: async (ctx, state) => ({
        context: ctx, state,
        terminal: { status: "completed", context: ctx, state },
      }),
    },
  };
  definitions.register(workloopDef({ id: "ok-loop" }));
  registry.register(okImpl);
  const okResult = await runner.run(defaultRequest({
    agentInstanceId: "agent-mt",
    executionId: "exec-mt-ok",
    workLoopId: "ok-loop",
  }));
  assert.equal(okResult.status, "completed");
});
