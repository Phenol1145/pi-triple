/**
 * arena-bid-persistence.test.ts — 持久化行为集成测试
 *
 * 验证 WorkLoopRunner（真实）+ CheckpointStore（内存 SQLite）+ arenaBidLoop
 * 的持久化行为：
 *   1. per-candidate single-flight（同 agent 串行，checkpoint 链）
 *   2. checkpoint 持久化 bid result（state.stake 正确）
 *   3. 不同 agent 并发（per-agent 单飞）
 *
 * 使用 node:test + node:assert/strict；fake ModelPort 返回 "37"
 * → parseBidResponse 解析 stake=37。
 *
 * 内存队列限制声明：见本文档末尾注释及
 * docs/adr/0001-bidding-workloop-modelport.md 的 Persistence 章节。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import { ARENA_BID_LOOP_DEFINITION } from "../src/runtime/create-scheduler-runtime.ts";
import { arenaBidLoop } from "../src/workloops/arena-bid-loop.ts";
import type { ModelPort, WorkContext } from "../src/workloop/contracts.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

/** Fake ModelPort: always returns "37" → parseBidResponse → stake=37 */
function fakeModelPort(): ModelPort {
  return {
    async complete(_ctx: WorkContext, _opts?: Record<string, unknown>) {
      return { message: { role: "assistant", content: "37" }, usage: undefined };
    },
  };
}

function noopTools() {
  return { async execute(_name: string, _args: unknown) { throw new Error("stub"); } };
}

function noopArtifacts() {
  return {
    async put(_value: unknown, _mediaType: string) { return crypto.randomUUID(); },
    async get(_ref: string) { return undefined; },
  };
}

function emptyContext(): WorkContext {
  return {
    messages: [],
    metadata: { contextId: "ctx-empty", sourceRefs: [], artifactRefs: [] },
  };
}

/**
 * Build a full WorkLoopRunner wired to arena-bid-loop and real
 * CheckpointStore (backed by an in-memory SQLite NamespacedStore).
 */
function buildArenaRunner() {
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register(ARENA_BID_LOOP_DEFINITION);
  const registry = new WorkLoopRegistry(definitions);
  registry.register(arenaBidLoop);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    fakeModelPort(),
    noopTools(),
    noopArtifacts(),
  );

  return { runner, db, store, eventLog, stateStore, checkpointStore, definitions, registry };
}

function bidRequest(overrides: Partial<WorkLoopRunRequest> = {}): WorkLoopRunRequest {
  return {
    traceId: "trace-1",
    executionId: "exec-1",
    agentInstanceId: "agent-1",
    optimizationRoundId: "round-1",
    workLoopId: "arena-bid-loop",
    workLoopVersion: "1.0.0",
    config: { model: "test/model", balance: 100 },
    task: "bid task",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

test("0. runner auto-initializes snapshot on first run (no explicit initialize)", async () => {
  const { runner } = buildArenaRunner();
  // NOTE: no stateStore.initialize() call — the runner must auto-init
  const result = await runner.run(
    bidRequest({ agentInstanceId: "agent-autoinit", traceId: "trace-autoinit", executionId: "exec-autoinit" }),
  );
  assert.equal(result.status, "completed");
  const stake = (result.output?.custom as { stake: number } | undefined)?.stake;
  assert.equal(stake, 37);
});

test("1. per-candidate single-flight: same agent bids serialized, 2 checkpoints", async () => {
  const { runner, stateStore, eventLog, checkpointStore } = buildArenaRunner();

  // Initialize agent snapshot — required for runner to start
  stateStore.initialize("agent-1", emptyContext(), {});

  // Dispatch TWO concurrent arena-bid-loop runs for the SAME agentInstanceId
  const p1 = runner.run(bidRequest({ traceId: "trace-a", executionId: "exec-a" }));
  const p2 = runner.run(bidRequest({ traceId: "trace-b", executionId: "exec-b" }));

  const [r1, r2] = await Promise.all([p1, p2]);

  // Both complete (serialized by runner.tails)
  assert.equal(r1.status, "completed");
  assert.equal(r2.status, "completed");

  // Each run produced a checkpoint.created event
  const cpA = eventLog.query({ traceId: "trace-a", eventType: "checkpoint.created" });
  const cpB = eventLog.query({ traceId: "trace-b", eventType: "checkpoint.created" });
  assert.equal(cpA.length, 1, "run A should have 1 checkpoint event");
  assert.equal(cpB.length, 1, "run B should have 1 checkpoint event");

  const cpIdA = (cpA[0].payload as { checkpointId: string }).checkpointId;
  const cpIdB = (cpB[0].payload as { checkpointId: string }).checkpointId;

  // Both checkpoints retrievable for agent-1
  const recA = checkpointStore.get("agent-1", cpIdA);
  const recB = checkpointStore.get("agent-1", cpIdB);
  assert.ok(recA);
  assert.ok(recB);
  assert.equal(recA.label, "bid-result");
  assert.equal(recB.label, "bid-result");

  // Verify state.stake = 37 (parseBidResponse("37", 100) → 37)
  assert.equal((recA.state as { stake: number }).stake, 37);
  assert.equal((recB.state as { stake: number }).stake, 37);

  // Checkpoint chain: B's parentCheckpointId should point to A's checkpoint
  // because they're serialized and CheckpointStore.save chains via "latest" pointer
  assert.equal(
    recB.parentCheckpointId,
    cpIdA,
    "second checkpoint should chain to first via parentCheckpointId",
  );

  // First checkpoint has no parent (first in chain for this agent)
  assert.equal(recA.parentCheckpointId, undefined, "first checkpoint should have no parent");
});

test("2. checkpoint persisted with bid result (state.stake)", async () => {
  const { runner, stateStore, eventLog, checkpointStore } = buildArenaRunner();

  stateStore.initialize("agent-2", emptyContext(), {});

  // Run arena-bid-loop once for an agent
  const result = await runner.run(bidRequest({
    traceId: "trace-c",
    executionId: "exec-c",
    agentInstanceId: "agent-2",
  }));

  assert.equal(result.status, "completed");

  // Verify output.custom has the parsed stake
  const custom = result.output?.custom as { stake: number; reasoning: string } | undefined;
  assert.ok(custom, "output.custom should be present");
  assert.equal(custom!.stake, 37);
  assert.equal(custom!.reasoning, "37");

  // Verify checkpoint created with correct state
  const cpEvents = eventLog.query({ traceId: "trace-c", eventType: "checkpoint.created" });
  assert.equal(cpEvents.length, 1);
  const cpId = (cpEvents[0].payload as { checkpointId: string }).checkpointId;
  const rec = checkpointStore.get("agent-2", cpId);
  assert.ok(rec);
  assert.equal(rec.label, "bid-result");
  assert.equal((rec.state as { stake: number }).stake, 37);
  assert.equal((rec.state as { reasoning: string }).reasoning, "37");
  assert.equal(rec.workLoopId, "arena-bid-loop");
  assert.equal(rec.workLoopVersion, "1.0.0");
  assert.equal(rec.agentInstanceId, "agent-2");

  // parentCheckpointId is undefined (first checkpoint for this agent)
  assert.equal(rec.parentCheckpointId, undefined);

  // Verify checkpoint.created event has correct identity
  assert.equal(cpEvents[0].identity.agentInstanceId, "agent-2");
  assert.equal(cpEvents[0].identity.workLoopId, "arena-bid-loop");
});

test("3. different agents run concurrently (single-flight is per-agent)", async () => {
  const { runner, stateStore, eventLog } = buildArenaRunner();

  stateStore.initialize("agent-3", emptyContext(), {});
  stateStore.initialize("agent-4", emptyContext(), {});

  // Dispatch runs for TWO different agentInstanceIds concurrently
  const p3 = runner.run(bidRequest({
    traceId: "trace-d",
    executionId: "exec-d",
    agentInstanceId: "agent-3",
  }));
  const p4 = runner.run(bidRequest({
    traceId: "trace-e",
    executionId: "exec-e",
    agentInstanceId: "agent-4",
  }));

  const [r3, r4] = await Promise.all([p3, p4]);

  // Both complete — per-agent single-flight allows concurrent execution
  // across different agents
  assert.equal(r3.status, "completed");
  assert.equal(r4.status, "completed");

  // Each agent has its own checkpoint
  const cp3 = eventLog.query({ traceId: "trace-d", eventType: "checkpoint.created" });
  const cp4 = eventLog.query({ traceId: "trace-e", eventType: "checkpoint.created" });
  assert.equal(cp3.length, 1);
  assert.equal(cp4.length, 1);

  // Outputs have correct stakes
  const custom3 = r3.output?.custom as { stake: number } | undefined;
  const custom4 = r4.output?.custom as { stake: number } | undefined;
  assert.equal(custom3?.stake, 37);
  assert.equal(custom4?.stake, 37);
});

// ── 内存队列限制声明 ─────────────────────────────────────────────────
//
// WorkLoopRunner.tails 是一个进程内的 Map<string, Promise<WorkLoopResult>>，
// 不持久化。进程重启后队列丢失。竞价为快速、幂等操作（Ledger freeze 按
// task/agent 键控），中断的竞标轮次可重跑恢复。CheckpointStore（SQLite）提供
// 出价结果的持久审计链。
//
// 详见 docs/adr/0001-bidding-workloop-modelport.md §Persistence。
