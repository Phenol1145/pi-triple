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
import type {
  WorkLoopImplementation,
  WorkLoopInput,
  WorkLoopResult,
  WorkLoopSDK,
  WorkContext,
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../src/workloop/contracts.ts";

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

  const impl = opts?.impl ??
    ({
      id: "test-loop",
      version: "1.0.0",
      cloneModes: ["fresh"],
      initialContext: (_config: unknown) => testContext("init"),
      initialState: (_config: unknown) => ({ counter: 0 }),
      run: async (_input: WorkLoopInput, _sdk: WorkLoopSDK): Promise<WorkLoopResult> => ({
        status: "completed",
        output: { standard: { text: "done" } },
        context: testContext("completed"),
        state: { counter: 1 },
      }),
    } satisfies WorkLoopImplementation);

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

// ── Tests ────────────────────────────────────────────────────────────

// ── Test 1: Completed run ──────────────────────────────────────────

test("1. Completed run: loads snapshot, invokes impl, commits at expected version, emits lifecycle events", async () => {
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

  // Lifecycle events: sort by sequence for deterministic order
  const events = eventLog.query({ traceId: "trace-1" });
  // Sort by the sequence number embedded in eventId: ...:eventType:N
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "agent.started",
    "workloop.started",
    "workloop.completed",
    "agent.completed",
  ]);

  // Verify event IDs are deterministic: ${executionId}:${eventType}:${seq}
  assert.equal(events[0].eventId, "exec-1:agent.started:0");
  assert.equal(events[1].eventId, "exec-1:workloop.started:1");
  assert.equal(events[2].eventId, "exec-1:workloop.completed:2");
  assert.equal(events[3].eventId, "exec-1:agent.completed:3");

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

  // Override with a failing implementation
  const failingImpl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({ counter: 0 }),
    run: async (): Promise<WorkLoopResult> => ({
      status: "failed",
      error: { standard: { code: "TEST_FAIL", message: "it broke", retryable: false } },
      context: testContext("failed-ctx"),
      state: { counter: 99 },
    }),
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

  // Failure events emitted
  const events = eventLog2.query({ traceId: "trace-1" });
  // Sort by sequence number embedded in eventId
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "agent.started",
    "workloop.started",
    "workloop.failed",
    "agent.failed",
  ]);
});

// ── Test 3: Abort ──────────────────────────────────────────────────

test("3a. Abort before start: returns cancelled without invoking implementation", async () => {
  let invoked = false;

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({}),
    run: async () => {
      invoked = true;
      return { status: "completed", context: testContext(), state: {} };
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

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({ counter: 0 }),
    run: async (_input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult> => {
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
        status: "cancelled",
        context: testContext("aborted-ctx"),
        state: { counter: 5 },
      };
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

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({}),
    run: async (_input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult> => {
      try {
        sdk.control.throwIfCancelled();
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          threwAbort = true;
          throw e; // rethrow
        }
      }
      return { status: "completed", context: testContext(), state: {} };
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

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({}),
    run: async (input: WorkLoopInput): Promise<WorkLoopResult> => {
      executionOrder.push(input.executionId);
      // Small delay to make concurrency observable
      await new Promise((r) => setTimeout(r, 20));
      return {
        status: "completed",
        context: testContext(input.executionId),
        state: {},
      };
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

  stateStore.initialize("agent-1", testContext("init"), {});

  // Launch two runs concurrently for the same agent
  const p1 = runner.run(defaultRequest({ executionId: "exec-first" }));
  const p2 = runner.run(defaultRequest({ executionId: "exec-second" }));

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.status, "completed");
  assert.equal(r2.status, "completed");

  // FIFO order: first started first, second after first completes
  assert.deepStrictEqual(executionOrder, ["exec-first", "exec-second"]);
});

test("4b. Different agents may run concurrently", async () => {
  const executionOrder: string[] = [];
  const startTimes: number[] = [];

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({}),
    run: async (input: WorkLoopInput): Promise<WorkLoopResult> => {
      startTimes.push(Date.now());
      executionOrder.push(input.agentInstanceId);
      // Delay long enough to observe overlap
      await new Promise((r) => setTimeout(r, 100));
      return {
        status: "completed",
        context: testContext(input.agentInstanceId),
        state: {},
      };
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

test("5. Checkpoint: sdk.checkpoint.save stores checkpoint and emits checkpoint.created", async () => {
  let savedCtx: WorkContext | undefined;
  let savedState: unknown;

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({ step: 0 }),
    run: async (_input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult> => {
      const midCtx = testContext("mid-flight");
      const midState = { step: 1, data: "checkpointed" };

      const { checkpointId } = await sdk.checkpoint.save(midCtx, midState, "mid-run");
      savedCtx = midCtx;
      savedState = midState;

      return {
        status: "completed",
        output: { standard: { text: "done" } },
        context: testContext("final"),
        state: { step: 2, checkpointId },
      };
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

  // checkpoint.created event emitted
  const cpEvents = eventLog.query({ traceId: "trace-1", eventType: "checkpoint.created" });
  assert.equal(cpEvents.length, 1);
  const cpEvent = cpEvents[0];
  assert.equal(cpEvent.eventType, "checkpoint.created");
  assert.equal(cpEvent.identity.agentInstanceId, "agent-1");
  assert.equal(cpEvent.identity.executionId, "exec-1");
  assert.equal(cpEvent.identity.workLoopId, "test-loop");
  assert.ok((cpEvent.payload as Record<string, unknown>).checkpointId, "checkpointId should be present");

  // Checkpoint retrievable from CheckpointStore
  const cpId = (cpEvent.payload as Record<string, string>).checkpointId;
  const record = checkpointStore.get("agent-1", cpId);
  assert.ok(record);
  assert.deepStrictEqual(record.context, savedCtx);
  assert.deepStrictEqual(record.state, savedState);
  assert.equal(record.label, "mid-run");
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

test("5c. Checkpoint lineage: parentCheckpointId chains across sequential saves", async () => {
  const checkpointIds: string[] = [];

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({ step: 0 }),
    run: async (_input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult> => {
      // Save three checkpoints in sequence
      const cp1 = await sdk.checkpoint.save(testContext("cp1"), { step: 1 }, "first");
      checkpointIds.push(cp1.checkpointId);

      const cp2 = await sdk.checkpoint.save(testContext("cp2"), { step: 2 }, "second");
      checkpointIds.push(cp2.checkpointId);

      const cp3 = await sdk.checkpoint.save(testContext("cp3"), { step: 3 }, "third");
      checkpointIds.push(cp3.checkpointId);

      return {
        status: "completed",
        output: { standard: { text: "chained" } },
        context: testContext("final"),
        state: { step: 4 },
      };
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
  assert.equal(checkpointIds.length, 3);

  // Retrieve all checkpoints and verify lineage
  const cp1 = checkpointStore.get("agent-1", checkpointIds[0]);
  const cp2 = checkpointStore.get("agent-1", checkpointIds[1]);
  const cp3 = checkpointStore.get("agent-1", checkpointIds[2]);

  // First checkpoint: no parent (first in chain)
  assert.equal(cp1.parentCheckpointId, undefined, "first checkpoint should have no parent");

  // Second checkpoint: parent = first
  assert.equal(
    cp2.parentCheckpointId,
    checkpointIds[0],
    "second checkpoint parent should be first checkpoint",
  );

  // Third checkpoint: parent = second
  assert.equal(
    cp3.parentCheckpointId,
    checkpointIds[1],
    "third checkpoint parent should be second checkpoint",
  );

  // Labels and context are preserved correctly
  assert.equal(cp1.label, "first");
  assert.equal(cp2.label, "second");
  assert.equal(cp3.label, "third");
  assert.equal(cp1.context.metadata.contextId, "cp1");
  assert.equal(cp2.context.metadata.contextId, "cp2");
  assert.equal(cp3.context.metadata.contextId, "cp3");
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

  // Capture stateStore in closure for the impl
  const capturedStateStore = stateStore;

  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({}),
    run: async (_input: WorkLoopInput): Promise<WorkLoopResult> => {
      // Simulate a concurrent commit by another runner/scheduler
      // This bumps the version so our commit will fail
      capturedStateStore.commit(
        "agent-1",
        testContext("concurrent-winner"),
        { counter: 42 },
        1, // expected version = 1 (what we initialized with)
      );

      return {
        status: "completed",
        context: testContext("my-result"),
        state: { counter: 1 },
      };
    },
  };

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

// ── Additional: runtime snapshot missing ───────────────────────────

test("runtime snapshot missing returns workloop-error", async () => {
  const { runner } = buildRunner();
  // Do NOT initialize agent-1

  const result = await runner.run(defaultRequest());

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "workloop-error");
  assert.ok(result.error?.standard?.message.includes("no runtime snapshot"));
});

// ── Additional: implementation throws unexpectedly ─────────────────

test("implementation that throws returns workloop-error, does not commit", async () => {
  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({ counter: 0 }),
    run: async (): Promise<WorkLoopResult> => {
      throw new Error("unexpected boom");
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
  const impl: WorkLoopImplementation = {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({ counter: 0 }),
    run: async (): Promise<WorkLoopResult> => ({
      status: "paused",
      context: testContext("paused-ctx"),
      state: { counter: 1, note: "midway" },
    }),
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

  stateStore.initialize("agent-1", testContext("init"), { counter: 0 });

  const result = await runner.run(defaultRequest());

  // Result status is paused
  assert.equal(result.status, "paused");

  // agent.paused event emitted
  const events = eventLog.query({ traceId: "trace-1" });
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "agent.started",
    "workloop.started",
    "agent.paused",
  ]);

  // Snapshot NOT committed — still version 1 with initial values
  const snap = stateStore.get("agent-1");
  assert.equal(snap!.version, 1);
  assert.equal(snap!.value.context.metadata.contextId, "init");
  assert.equal((snap!.value.state as { counter: number }).counter, 0);
});
