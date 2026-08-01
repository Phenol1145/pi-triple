import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarketBidLoop } from "../src/workloops/market-bid-loop.ts";
import type { ArenaBidLoopConfig } from "../src/workloops/market-bid-loop.ts";
import { MachineRuntime } from "../src/workloop/machine-runtime.ts";
import type { WorkLoopSDK, WorkLoopInput } from "../src/workloop/contracts.ts";

function fakeSdk(modelReply: string, opts?: { failModel?: boolean; checkpoints?: unknown[] }): WorkLoopSDK {
  const checkpoints = opts?.checkpoints ?? [];
  return {
    context: {
      append: (ctx, msgs, id) => ({ ...ctx, messages: [...ctx.messages, ...msgs], metadata: { ...ctx.metadata, contextId: id } }),
      filterMessages: (ctx) => ctx, merge: (b) => b, truncateMessages: (ctx) => ctx,
    },
    model: {
      async complete(_ctx, options) {
        if (opts?.failModel) throw new Error("model boom");
        return { message: { role: "assistant", content: modelReply }, usage: undefined };
      },
    },
    tools: { async execute() { return undefined; } },
    storage: { get: () => undefined, put: (_k, v) => ({ value: v, version: 1 }) },
    artifacts: { async put() { return "ref"; }, async get() { return undefined; } },
    checkpoint: { async save(context, state, opts) { const id = `ckpt-${checkpoints.length}`; checkpoints.push({ id, context, state, label: opts?.label }); return { checkpointId: id }; } },
    telemetry: { emit() {} },
    control: { signal: new AbortController().signal, throwIfCancelled() {} },
  } as unknown as WorkLoopSDK;
}

function input(task: string): WorkLoopInput {
  return {
    traceId: "t", executionId: "e", agentInstanceId: "agent-1", optimizationRoundId: "r",
    task, config: {}, state: {},
    context: { messages: [], metadata: { contextId: "c0", sourceRefs: [], artifactRefs: [] } },
  } as WorkLoopInput;
}

/** Machine 驱动 market-bid（Task 4 迁移：marketBidLoop 常量 → createMarketBidLoop 工厂）。 */
async function runBid(task: string, config: ArenaBidLoopConfig, sdk: WorkLoopSDK) {
  const impl = createMarketBidLoop(config);
  const runtime = new MachineRuntime({
    machine: impl.machine,
    input: input(task),
    sdk,
  });
  const { result } = await runtime.run();
  return result;
}

test("market-bid-loop: parses stake from model reply", async () => {
  const sdk = fakeSdk("我出 42 credits");
  const result = await runBid("任务X，余额 100，赔率 3.0", { model: "openai/gpt-4" }, sdk);
  assert.equal(result.status, "completed");
  assert.equal((result.output?.custom as { stake: number }).stake, 42);
});

test("market-bid-loop: stake clamped to available balance", async () => {
  const sdk = fakeSdk("999");
  const result = await runBid("余额 50", { model: "m", balance: 50 }, sdk);
  assert.equal((result.output?.custom as { stake: number }).stake, 50);
});

test("market-bid-loop: runtime auto-checkpoints the bid result (persistence)", async () => {
  const checkpoints: unknown[] = [];
  const sdk = fakeSdk("30", { checkpoints });
  await runBid("余额 100", { model: "m" }, sdk);
  // 手动 checkpoint 已移除（Task 4）——MachineRuntime 每次转移后自动 checkpoint
  assert.equal(checkpoints.length, 1);
  assert.equal((checkpoints[0] as { label?: string }).label, "done#1");
  // Task 7（ADR-0001 恢复）：出价结果写入记忆/数据域 → checkpoint state 含 stake+reasoning
  assert.deepStrictEqual(
    (checkpoints[0] as { state?: unknown }).state,
    { stake: 30, reasoning: "30" },
  );
});

test("market-bid-loop: model failure → failed status (fail-open upstream)", async () => {
  const sdk = fakeSdk("", { failModel: true });
  const result = await runBid("余额 100", { model: "m" }, sdk);
  assert.equal(result.status, "failed");
});

test("market-bid-loop: definition shape", () => {
  const impl = createMarketBidLoop({});
  assert.equal(impl.id, "market-bid-loop");
  assert.equal(impl.version, "1.0.0");
  assert.deepEqual(impl.cloneModes, ["fresh"]);
  assert.equal(impl.executorKind, "local-model");
  assert.deepEqual(impl.machine.states.map((s) => s.id), ["idle", "done"]);
  assert.equal(impl.machine.initial, "idle");
  assert.equal(impl.run, undefined, "新实现不提供 run");
});
