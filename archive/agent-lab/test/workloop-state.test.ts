import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NamespacedStore, VersionConflictError } from "../src/core/storage/namespaced-store.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore, CheckpointNotFoundError } from "../src/workloop/checkpoints.ts";
import {
  AgentCloneService,
  CloneModeNotSupportedError,
  SourceCheckpointNotFoundError,
} from "../src/workloop/checkpoints.ts";
import type { AgentRuntimeSnapshot, CheckpointRecord } from "../src/workloop/checkpoints.ts";
import type { WorkLoopImplementation, WorkContext, WorkLoopInput, WorkLoopResult, WorkLoopSDK } from "../src/workloop/contracts.ts";

// ── helpers ──────────────────────────────────────────────────────────

function memoryStore(): { db: DatabaseSync; store: NamespacedStore } {
  const db = new DatabaseSync(":memory:");
  const store = new NamespacedStore(db);
  return { db, store };
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

function testState(): unknown {
  return { counter: 0, items: ["a", "b"] };
}

function createCheckpoint(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    checkpointId: "cp-1",
    agentInstanceId: "agent-1",
    executionId: "exec-1",
    workLoopId: "wl-1",
    workLoopVersion: "1.0.0",
    optimizationRoundId: "round-1",
    context: testContext(),
    state: testState(),
    createdAt: Date.now(),
    ...overrides,
  };
}

function noopImpl(
  id = "test-loop",
  version = "1.0.0",
  cloneModes: string[] = ["fresh", "fork"],
  forkStateFn?: (state: unknown) => unknown,
): WorkLoopImplementation {
  return {
    id,
    version,
    cloneModes,
    initialContext: (config: unknown) => ({
      systemPrompt: "initial",
      messages: [{ role: "system", content: config }],
      metadata: { contextId: "ctx-init", sourceRefs: [], artifactRefs: [] },
    }),
    initialState: (config: unknown) => ({ config, initialised: true }),
    forkState: forkStateFn,
    run: async (_input: WorkLoopInput, _sdk: WorkLoopSDK): Promise<WorkLoopResult> => {
      return {
        status: "completed",
        context: {
          messages: [],
          metadata: { contextId: "ctx-1", sourceRefs: [], artifactRefs: [] },
        },
        state: {},
      };
    },
  };
}

// ── AgentRuntimeStateStore tests ─────────────────────────────────────

test("initialize(agentId, context, state) creates version 1 snapshot", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const ctx = testContext();
  const st = testState();

  const result = stateStore.initialize("agent-1", ctx, st);

  assert.equal(result.version, 1);
  assert.deepStrictEqual(result.value.context, ctx);
  assert.deepStrictEqual(result.value.state, st);
  assert.equal(result.value.lastCheckpointId, undefined);

  // Verify it's actually stored
  const retrieved = stateStore.get("agent-1");
  assert.equal(retrieved.version, 1);
  assert.deepStrictEqual(retrieved.value.context, ctx);
  assert.deepStrictEqual(retrieved.value.state, st);
});

test("initialize with same agentId twice throws VersionConflictError", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);

  stateStore.initialize("agent-1", testContext(), testState());

  assert.throws(
    () => stateStore.initialize("agent-1", testContext(), testState()),
    VersionConflictError,
  );
});

test("get returns undefined for unknown agent", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);

  assert.equal(stateStore.get("unknown-agent"), undefined);
});

test("commit succeeds with correct expectedVersion and increments version", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);

  stateStore.initialize("agent-1", testContext(), testState());

  const newCtx = testContext("ctx-2");
  const newSt = { counter: 1, items: ["c"] };

  const result = stateStore.commit("agent-1", newCtx, newSt, 1);
  assert.equal(result.version, 2);
  assert.deepStrictEqual(result.value.context, newCtx);
  assert.deepStrictEqual(result.value.state, newSt);

  const retrieved = stateStore.get("agent-1");
  assert.equal(retrieved!.version, 2);
  assert.deepStrictEqual(retrieved!.value.context, newCtx);
});

test("commit with stale expectedVersion throws VersionConflictError and preserves old snapshot", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const originalCtx = testContext("ctx-original");
  const originalSt = { counter: 5 };

  stateStore.initialize("agent-1", originalCtx, originalSt);

  // First commit succeeds
  stateStore.commit("agent-1", testContext("ctx-intermediate"), { counter: 6 }, 1);

  // Second commit with stale version (1) should fail
  assert.throws(
    () => stateStore.commit("agent-1", testContext("ctx-wrong"), { counter: 99 }, 1),
    VersionConflictError,
  );

  // Old snapshot should be preserved (version 2, the successful one)
  const retrieved = stateStore.get("agent-1");
  assert.equal(retrieved!.version, 2);
});

test("commit stores lastCheckpointId in snapshot", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);

  stateStore.initialize("agent-1", testContext(), testState());

  const result = stateStore.commit("agent-1", testContext(), testState(), 1, "cp-42");
  assert.equal(result.value.lastCheckpointId, "cp-42");

  const retrieved = stateStore.get("agent-1");
  assert.equal(retrieved!.value.lastCheckpointId, "cp-42");
});

// ── CheckpointStore tests ────────────────────────────────────────────

test("CheckpointStore.save persists an immutable snapshot", () => {
  const { store } = memoryStore();
  const checkpointStore = new CheckpointStore(store);
  const cp = createCheckpoint();

  checkpointStore.save("agent-1", cp);

  const retrieved = checkpointStore.get("agent-1", "cp-1");
  assert.equal(retrieved.checkpointId, "cp-1");
  assert.equal(retrieved.agentInstanceId, "agent-1");
  assert.deepStrictEqual(retrieved.context, cp.context);
  assert.deepStrictEqual(retrieved.state, cp.state);
  assert.equal(retrieved.workLoopId, "wl-1");
  assert.equal(retrieved.workLoopVersion, "1.0.0");
  assert.equal(retrieved.executionId, "exec-1");
  assert.equal(retrieved.optimizationRoundId, "round-1");
  assert.equal(retrieved.createdAt, cp.createdAt);
});

test("mutating caller objects after save does not alter get", () => {
  const { store } = memoryStore();
  const checkpointStore = new CheckpointStore(store);

  const ctx = testContext();
  const st = testState();
  const cp = createCheckpoint({ context: ctx, state: st });

  checkpointStore.save("agent-1", cp);

  // Mutate the original objects
  ctx.systemPrompt = "evil";
  (st as Record<string, unknown>).counter = 999;
  ctx.messages.push({ role: "attacker", content: "injected" });

  const retrieved = checkpointStore.get("agent-1", "cp-1");
  assert.equal(retrieved.context.systemPrompt, "helpful");
  assert.deepStrictEqual(retrieved.state, { counter: 0, items: ["a", "b"] });
  assert.equal(retrieved.context.messages.length, 1);
});

test("get throws CheckpointNotFoundError for missing checkpoint", () => {
  const { store } = memoryStore();
  const checkpointStore = new CheckpointStore(store);

  assert.throws(
    () => checkpointStore.get("agent-1", "missing-cp"),
    CheckpointNotFoundError,
  );
});

test("get returns defensive copy that cannot mutate stored data", () => {
  const { store } = memoryStore();
  const checkpointStore = new CheckpointStore(store);

  const cp = createCheckpoint();
  checkpointStore.save("agent-1", cp);

  const retrieved = checkpointStore.get("agent-1", "cp-1");
  // Mutate the returned objects
  (retrieved.state as Record<string, unknown>).counter = 999;
  retrieved.context.messages.push({ role: "bad", content: "mutated" });

  // Second retrieval should still have original data
  const retrieved2 = checkpointStore.get("agent-1", "cp-1");
  assert.deepStrictEqual(retrieved2.state, { counter: 0, items: ["a", "b"] });
  assert.equal(retrieved2.context.messages.length, 1);
});

test("save with parentCheckpointId and label preserves metadata", () => {
  const { store } = memoryStore();
  const checkpointStore = new CheckpointStore(store);

  const cp = createCheckpoint({
    checkpointId: "cp-2",
    parentCheckpointId: "cp-1",
    label: "pre-fork",
  });

  checkpointStore.save("agent-1", cp);

  const retrieved = checkpointStore.get("agent-1", "cp-2");
  assert.equal(retrieved.parentCheckpointId, "cp-1");
  assert.equal(retrieved.label, "pre-fork");
});

// ── AgentCloneService tests ──────────────────────────────────────────

test("fresh initializes target from implementation.initialContext/config and initialState/config", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  const impl = noopImpl();
  const config = { mode: "test" };

  cloneService.fresh("agent-new", impl, config);

  const snapshot = stateStore.get("agent-new");
  assert.ok(snapshot, "snapshot should exist");
  assert.equal(snapshot.version, 1);
  assert.deepStrictEqual(snapshot.value.state, { config, initialised: true });
  assert.equal(snapshot.value.context.systemPrompt, "initial");
});

test("fresh does not use any source state", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  // Pre-populate another agent — should not affect fresh
  stateStore.initialize("source-agent", testContext("src"), { sourceOnly: true });

  const impl = noopImpl();
  cloneService.fresh("agent-fresh", impl, { mode: "clean" });

  const snapshot = stateStore.get("agent-fresh");
  assert.deepStrictEqual(snapshot!.value.state, { config: { mode: "clean" }, initialised: true });
  // Source agent still has its own state
  const sourceSnapshot = stateStore.get("source-agent");
  assert.deepStrictEqual(sourceSnapshot!.value.state, { sourceOnly: true });
});

test("fork requires implementation clone mode fork", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  // Create a source agent with a checkpoint
  stateStore.initialize("agent-src", testContext("src-ctx"), { src: true });
  const cp = createCheckpoint({ checkpointId: "cp-1", agentInstanceId: "agent-src" });
  checkpointStore.save("agent-src", cp);

  // Implementation that does NOT support fork
  const noForkImpl = noopImpl("no-fork-loop", "1.0.0", ["fresh"]);

  assert.throws(
    () => cloneService.fork("agent-tgt", noForkImpl, "agent-src", "cp-1"),
    CloneModeNotSupportedError,
  );
});

test("fork rejects absent checkpoint with SourceCheckpointNotFoundError", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  stateStore.initialize("agent-src", testContext("src-ctx"), { src: true });

  const impl = noopImpl();

  assert.throws(
    () => cloneService.fork("agent-tgt", impl, "agent-src", "missing-cp"),
    SourceCheckpointNotFoundError,
  );
});

test("fork loads checkpoint, initializes target, preserves source/checkpoint", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  // Set up source agent with a checkpoint
  const srcCtx = testContext("src-ctx");
  srcCtx.systemPrompt = "source prompt";
  const srcState = { counter: 10, items: ["x", "y"] };
  stateStore.initialize("agent-src", srcCtx, srcState);
  const cp = createCheckpoint({
    checkpointId: "cp-src-1",
    agentInstanceId: "agent-src",
    context: srcCtx,
    state: srcState,
  });
  checkpointStore.save("agent-src", cp);

  const impl = noopImpl();
  const targetId = "agent-tgt";

  cloneService.fork(targetId, impl, "agent-src", "cp-src-1");

  // Target should exist with its own snapshot
  const targetSnap = stateStore.get(targetId);
  assert.ok(targetSnap, "target snapshot should exist");
  assert.equal(targetSnap.version, 1);
  // Target state starts from checkpoint state
  assert.deepStrictEqual(targetSnap.value.state, srcState);
  // Target context starts from checkpoint context
  assert.equal(targetSnap.value.context.systemPrompt, "source prompt");

  // Source should still be intact
  const sourceSnap = stateStore.get("agent-src");
  assert.ok(sourceSnap, "source snapshot should still exist");
  assert.equal(sourceSnap.version, 1);
  assert.deepStrictEqual(sourceSnap.value.state, srcState);
});

test("fork calls implementation.forkState when present, using its result as target state", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  const srcState = { counter: 10 };
  stateStore.initialize("agent-src", testContext("src-ctx"), srcState);
  const cp = createCheckpoint({
    checkpointId: "cp-src-2",
    agentInstanceId: "agent-src",
    state: srcState,
  });
  checkpointStore.save("agent-src", cp);

  const forkStateFn = (state: unknown) => {
    const s = state as { counter: number };
    return { counter: s.counter * 2, forked: true };
  };

  const impl = noopImpl("test-loop", "1.0.0", ["fresh", "fork"], forkStateFn);

  cloneService.fork("agent-tgt", impl, "agent-src", "cp-src-2");

  const targetSnap = stateStore.get("agent-tgt");
  assert.deepStrictEqual(targetSnap!.value.state, { counter: 20, forked: true });
});

test("fork when forkState is not provided uses checkpoint state directly", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  const srcState = { counter: 100 };
  stateStore.initialize("agent-src", testContext("src-ctx"), srcState);
  const cp = createCheckpoint({
    checkpointId: "cp-no-forkfn",
    agentInstanceId: "agent-src",
    state: srcState,
  });
  checkpointStore.save("agent-src", cp);

  // Implementation without forkState (the default noopImpl has forkState: undefined when not passed)
  const impl = noopImpl("test-loop", "1.0.0", ["fresh", "fork"]); // no forkStateFn
  cloneService.fork("agent-tgt", impl, "agent-src", "cp-no-forkfn");

  const targetSnap = stateStore.get("agent-tgt");
  assert.deepStrictEqual(targetSnap!.value.state, srcState);
});

test("fork initializes target with lastCheckpointId set", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  stateStore.initialize("agent-src", testContext("src-ctx"), {});
  const cp = createCheckpoint({ checkpointId: "cp-fork-1", agentInstanceId: "agent-src" });
  checkpointStore.save("agent-src", cp);

  const impl = noopImpl();
  cloneService.fork("agent-tgt", impl, "agent-src", "cp-fork-1");

  const targetSnap = stateStore.get("agent-tgt");
  assert.equal(targetSnap!.value.lastCheckpointId, "cp-fork-1");
});

test("fork on already-initialized target throws VersionConflictError", () => {
  const { store } = memoryStore();
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  stateStore.initialize("agent-src", testContext("src-ctx"), {});
  const cp = createCheckpoint({ checkpointId: "cp-already", agentInstanceId: "agent-src" });
  checkpointStore.save("agent-src", cp);

  const impl = noopImpl();
  cloneService.fork("agent-tgt", impl, "agent-src", "cp-already");

  // Second fork on same target should fail
  assert.throws(
    () => cloneService.fork("agent-tgt", impl, "agent-src", "cp-already"),
    VersionConflictError,
  );
});
