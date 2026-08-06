import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, DEFAULT_EXECUTION_TIMEOUT_MS } from "../src/scheduler/with-timeout.ts";
import { buildSchedulerSDK } from "../src/scheduler/runner-sdk.ts";
import type { AgentRunResult } from "../src/scheduler/contracts.ts";

// ── withTimeout 单测（brief Step 1）─────────────────────────────────

test("正常完成不触发超时", async () => {
  const r = await withTimeout(Promise.resolve("ok"), 1000);
  assert.equal(r, "ok");
});

test("超时返回 failed", async () => {
  const r = await withTimeout(new Promise(() => {}), 50);
  assert.equal(r.status, "failed");
  assert.equal(r.error.code, "execution-timeout");
  assert.equal(r.error.retryable, true);
});

test("默认超时常量为 5 分钟（与 DEFAULT_MARKET_CONFIG.execution.timeoutMs 对齐）", () => {
  assert.equal(DEFAULT_EXECUTION_TIMEOUT_MS, 300_000);
});

// ── runner-sdk agents.run 接入（brief Step 4）────────────────────────

test("agents.run 超时返回 failed + execution-timeout，并尽力 abort signal", async () => {
  const aborted: string[] = [];
  const fakeCore = {
    repository: {
      listAgents: () => [
        {
          id: "agent-1",
          definition: { workLoop: { id: "wl-1", version: "1.0.0", config: { model: "test" } } },
          status: "ready",
        },
      ],
      getAgent: () => ({
        id: "agent-1",
        definition: { workLoop: { id: "wl-1", version: "1.0.0", config: { model: "test" } } },
        status: "ready",
      }),
    },
    storage: {},
    events: {},
  };
  const neverRunner = { run: () => new Promise(() => {}) };

  let seq = 0;
  const sdk = buildSchedulerSDK(
    { core: fakeCore as never, wlRunner: neverRunner as never, emit: (() => {}) as never },
    "inst-1",
    "round-0",
    "trace-1",
    "disp-1",
    () => `evt-${seq++}`,
    { abort: () => aborted.push("signal") } as never,
  );

  const result = await sdk.agents.run("agent-1", { task: "do it", timeoutMs: 50 });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "execution-timeout");
  assert.equal(result.error?.retryable, true);
  assert.deepEqual(aborted, ["signal"], "超时后应尽力调用 signal.abort");
});

test("agents.run 正常完成不走超时分支（timeoutMs 透传但未触发）", async () => {
  const fakeCore = {
    repository: {
      listAgents: () => [
        {
          id: "agent-1",
          definition: { workLoop: { id: "wl-1", version: "1.0.0", config: { model: "test" } } },
          status: "ready",
        },
      ],
      getAgent: () => ({
        id: "agent-1",
        definition: { workLoop: { id: "wl-1", version: "1.0.0", config: { model: "test" } } },
        status: "ready",
      }),
    },
    storage: {},
    events: {},
  };
  const completingRunner = {
    run: async () => ({
      status: "completed",
      output: { standard: { text: "done" } },
      error: undefined,
      context: {},
      state: {},
    }),
  };

  let seq = 0;
  const sdk = buildSchedulerSDK(
    { core: fakeCore as never, wlRunner: completingRunner as never, emit: (() => {}) as never },
    "inst-1",
    "round-0",
    "trace-1",
    "disp-1",
    () => `evt-${seq++}`,
  );

  const result: AgentRunResult = await sdk.agents.run("agent-1", { task: "ok", timeoutMs: 50 });
  assert.equal(result.status, "completed");
  assert.equal(result.output?.text, "done");
});
