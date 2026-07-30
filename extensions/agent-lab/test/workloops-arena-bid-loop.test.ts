import { test } from "node:test";
import assert from "node:assert/strict";
import { arenaBidLoop } from "../src/workloops/arena-bid-loop.ts";
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

test("arena-bid-loop: parses stake from model reply", async () => {
  const sdk = fakeSdk("我出 42 credits");
  const result = await arenaBidLoop.run(input("任务X，余额 100，赔率 3.0", { model: "openai/gpt-4" }), sdk);
  assert.equal(result.status, "completed");
  assert.equal((result.output?.custom as { stake: number }).stake, 42);
});

test("arena-bid-loop: stake clamped to available balance", async () => {
  const sdk = fakeSdk("999");
  const result = await arenaBidLoop.run(input("余额 50", { model: "m", balance: 50 }), sdk);
  assert.equal((result.output?.custom as { stake: number }).stake, 50);
});

test("arena-bid-loop: checkpoints the bid result (persistence)", async () => {
  const checkpoints: unknown[] = [];
  const sdk = fakeSdk("30", { checkpoints });
  await arenaBidLoop.run(input("余额 100", { model: "m" }), sdk);
  assert.equal(checkpoints.length, 1);
  assert.match(String((checkpoints[0] as { label?: string }).label ?? ""), /bid/);
});

test("arena-bid-loop: model failure → failed status (fail-open upstream)", async () => {
  const sdk = fakeSdk("", { failModel: true });
  const result = await arenaBidLoop.run(input("余额 100", { model: "m" }), sdk);
  assert.equal(result.status, "failed");
});

test("arena-bid-loop: definition shape", () => {
  assert.equal(arenaBidLoop.id, "arena-bid-loop");
  assert.equal(arenaBidLoop.version, "1.0.0");
  assert.deepEqual(arenaBidLoop.cloneModes, ["fresh"]);
});