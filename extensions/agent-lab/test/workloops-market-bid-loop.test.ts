import { test } from "node:test";
import assert from "node:assert/strict";
import { marketBidLoop } from "../src/workloops/market-bid-loop.ts";
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
    checkpoint: { async save(context, state, label) { const id = `ckpt-${checkpoints.length}`; checkpoints.push({ id, context, state, label }); return { checkpointId: id }; } },
    telemetry: { emit() {} },
    control: { signal: new AbortController().signal, throwIfCancelled() {} },
  } as unknown as WorkLoopSDK;
}

function input(task: string, config: Record<string, unknown> = {}): WorkLoopInput {
  return {
    traceId: "t", executionId: "e", agentInstanceId: "agent-1", optimizationRoundId: "r",
    task, config, state: {},
    context: { messages: [], metadata: { contextId: "c0", sourceRefs: [], artifactRefs: [] } },
  } as WorkLoopInput;
}

test("market-bid-loop: parses stake from model reply", async () => {
  const sdk = fakeSdk("我出 42 credits");
  const result = await marketBidLoop.run(input("任务X，余额 100，赔率 3.0", { model: "openai/gpt-4" }), sdk);
  assert.equal(result.status, "completed");
  assert.equal((result.output?.custom as { stake: number }).stake, 42);
});

test("market-bid-loop: stake clamped to available balance", async () => {
  const sdk = fakeSdk("999");
  const result = await marketBidLoop.run(input("余额 50", { model: "m", balance: 50 }), sdk);
  assert.equal((result.output?.custom as { stake: number }).stake, 50);
});

test("market-bid-loop: checkpoints the bid result (persistence)", async () => {
  const checkpoints: unknown[] = [];
  const sdk = fakeSdk("30", { checkpoints });
  await marketBidLoop.run(input("余额 100", { model: "m" }), sdk);
  assert.equal(checkpoints.length, 1);
  assert.match(String((checkpoints[0] as { label?: string }).label ?? ""), /bid/);
});

test("market-bid-loop: model failure → failed status (fail-open upstream)", async () => {
  const sdk = fakeSdk("", { failModel: true });
  const result = await marketBidLoop.run(input("余额 100", { model: "m" }), sdk);
  assert.equal(result.status, "failed");
});

test("market-bid-loop: definition shape", () => {
  assert.equal(marketBidLoop.id, "market-bid-loop");
  assert.equal(marketBidLoop.version, "1.0.0");
  assert.deepEqual(marketBidLoop.cloneModes, ["fresh"]);
});