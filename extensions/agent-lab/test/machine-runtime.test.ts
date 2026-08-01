import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MachineRuntime, deriveDsp,
} from "../src/workloop/machine-runtime.ts";
import type {
  MachineDefinition, MachineEvent,
} from "../src/workloop/machine.ts";
import type {
  WorkContext, WorkLoopInput, WorkLoopResult, WorkLoopSDK,
} from "../src/workloop/contracts.ts";

// ── 测试替身 ──

const emptyCtx = (): WorkContext => ({
  messages: [],
  metadata: { contextId: "c1", sourceRefs: [], artifactRefs: [] },
});

function makeInput(): WorkLoopInput {
  return {
    traceId: "t1", executionId: "e1", agentInstanceId: "a1",
    optimizationRoundId: "o1", task: "do it", config: {},
    context: emptyCtx(), state: {},
  };
}

function makeSdk(overrides: Partial<WorkLoopSDK> = {}): WorkLoopSDK {
  const checkpoints: string[] = [];
  return {
    context: {
      append: (ctx, msgs, newId) => ({ ...ctx, messages: [...ctx.messages, ...msgs], metadata: { ...ctx.metadata, contextId: newId } }),
      filterMessages: (ctx) => ctx,
      merge: (a) => a,
      truncateMessages: (ctx) => ctx,
    },
    model: {
      complete: async (ctx) => ({ message: { role: "assistant", content: "ok" }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1, toolCalls: 0, durationMs: 1 } }),
    },
    tools: { execute: async () => ({ content: "tool result" }) },
    storage: {
      get: () => undefined,
      put: (_k, v) => ({ value: v, version: 1 }),
    },
    artifacts: { put: async () => "ref", get: async () => undefined },
    checkpoint: {
      save: async (ctx, state, opts) => {
        checkpoints.push(`${ctx.metadata.contextId}:${opts?.label ?? ""}`);
        return { checkpointId: `cp${checkpoints.length}` };
      },
    },
    telemetry: { emit: () => {} },
    control: { signal: new AbortController().signal, throwIfCancelled() {} },
    ...overrides,
  } as WorkLoopSDK;
}

// ── 场景 1：单转移机器（δ 自驱动终止） ──

const singleMachine: MachineDefinition = {
  states: [{ id: "idle" }, { id: "done", terminal: true }],
  initial: "idle",
  transitions: (s, e) => (s === "idle" && e.type === "start" ? "done" : undefined),
  step: async (ctx, state) => ({
    context: ctx,
    state,
    terminal: { status: "completed", context: ctx, state },
  }),
};

test("runtime: 单转移完成 + 自动 checkpoint + 转移 Trace", async () => {
  const checkpoints: Array<{ label?: string; controlState?: string; seq?: number }> = [];
  const sdk = makeSdk({
    checkpoint: {
      save: async (ctx, _s, opts) => {
        checkpoints.push({ label: opts?.label, controlState: opts?.controlState, seq: opts?.seq });
        return { checkpointId: `cp${checkpoints.length}` };
      },
    },
  });
  const transitions: string[] = [];
  sdk.telemetry.emit = (t, payload) => {
    if (t === "machine.transition") transitions.push((payload as { toState: string }).toState);
  };
  const runtime = new MachineRuntime({ machine: singleMachine, input: makeInput(), sdk });
  const { result, finalSeq } = await runtime.run();
  assert.equal(result.status, "completed");
  assert.equal(finalSeq, 1);
  // 每次转移后 checkpoint，label = `${next}#${seq}`，并写入 controlState/seq（Task 6）
  assert.deepEqual(checkpoints, [{ label: "done#1", controlState: "done", seq: 1 }]);
  assert.deepEqual(transitions, ["done"]);
});

// ── 场景 2：δ 自驱动多事件循环（本地式形态） ──
// （修正：start 事件需要转移边 + δ 需处理 start，否则首次进入即被转移表拒绝——
//   spec §4.1 规定初始事件 { type: "start" } 走转移表，机器必须声明 start 边）

const loopMachine: MachineDefinition = {
  states: [
    { id: "call" }, { id: "append" }, { id: "done", terminal: true },
  ],
  initial: "call",
  transitions: (s, e) => {
    if (s === "call" && (e.type === "assistant_turn" || e.type === "start")) return "append";
    if (s === "append" && e.type === "more") return "call";
    if (s === "append" && e.type === "max_calls") return "done";
    return undefined;
  },
  step: async (ctx, state, event, sdk) => {
    if (event.type === "assistant_turn" || event.type === "start") {
      const result = await sdk.model.complete(ctx);
      const calls = (state as { calls: number }).calls + 1;
      return {
        context: ctx,
        state: { calls },
        event: { type: calls >= 2 ? "max_calls" : "more" },
      };
    }
    return { context: ctx, state, event: { type: "assistant_turn" } };
  },
};

test("runtime: δ 自驱动循环直到终止", async () => {
  const input = makeInput();
  input.state = { calls: 0 };
  const runtime = new MachineRuntime({ machine: loopMachine, input, sdk: makeSdk() });
  const { result, transitions } = await runtime.run();
  assert.equal(result.status, "completed");
  // start→append→call→append→done：4 次转移
  assert.deepEqual(transitions.map((t) => t.toState), ["append", "call", "append", "done"]);
});

// ── 场景 3：预算守卫 ──

test("runtime: maxTurns 预算强制终止", async () => {
  const input = makeInput();
  input.state = { calls: 0 };
  const runtime = new MachineRuntime({
    machine: loopMachine, input, sdk: makeSdk(),
    budgets: { maxTurns: 3 },   // 超过 3 次转移 → budget_exhausted
  });
  const { result } = await runtime.run();
  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard.code, "budget-exhausted");
  assert.equal(result.error?.standard.retryable, true);
});

// ── 场景 4：非法转移（未定义边）→ 忽略 + warning Trace，不中断 ──
// （修正：原机器 start→done 一步到位，自驱动的 unknown_event 永远到不了转移表。
//   改为 start→working（非终止），δ 自驱动无转移边的 unknown_event → 运行时忽略 + warning）

test("runtime: 未定义转移忽略 + warning 记录", async () => {
  const sdk = makeSdk();
  const warnings: string[] = [];
  sdk.telemetry.emit = (t, payload) => {
    if (t === "machine.transition_warning") warnings.push((payload as { eventType: string }).eventType);
  };
  const machine: MachineDefinition = {
    states: [{ id: "idle" }, { id: "working" }, { id: "done", terminal: true }],
    initial: "idle",
    transitions: (s, e) => {
      if (s === "idle" && e.type === "start") return "working";
      if (s === "working" && e.type === "work_done") return "done";
      return undefined;
    },
    step: async (ctx, state, event) => {
      if (event.type === "start") {
        // 自驱动一个无转移边的事件（working + unknown_event 无定义）→ 忽略 + warning
        return { context: ctx, state, event: { type: "unknown_event" } };
      }
      return { context: ctx, state, terminal: { status: "completed", context: ctx, state } };
    },
  };
  const runtime = new MachineRuntime({ machine, input: makeInput(), sdk });
  const { result } = await runtime.run();
  // working 上收到 unknown_event → 转移表未定义 → 忽略（δ 不执行、状态不变）+ warning；
  // 无 executor 提供下一事件 → 正常运行结束（completed）
  assert.equal(result.status, "completed");
  assert.ok(warnings.length >= 1);
  assert.deepEqual(warnings, ["unknown_event"]);
});

// ── 场景 5：DSP 派生（投影 + 预算 + 环境） ──

test("deriveDsp: 投影 + 预算剩余 + 序号", () => {
  const machine: MachineDefinition = {
    states: [
      { id: "bankrupt", projection: () => "你处于破产状态，只可执行任务" },
    ],
    initial: "bankrupt",
    transitions: () => undefined,
    step: async () => ({ context: emptyCtx(), state: {} }),
  };
  const dsp = deriveDsp({
    controlState: "bankrupt", machine, ctx: emptyCtx(), memory: {}, seq: 3,
    budgets: { maxTurns: 10 },
  });
  assert.ok(dsp.includes("你处于破产状态"));
  assert.ok(dsp.includes("3"));
  assert.ok(dsp.includes("10"));
});

// ── 场景 6：resume 从最近转移续跑 ──
// （修正：resume 记忆 calls 需为 0——δ 在 calls 1→2 时即发 max_calls，{calls:1} 只会产生
//   2 次转移；{calls:0} 才得到预期的 call→append→call→append→done 4 次续跑）

test("runtime: resumeFrom 恢复控制状态与记忆", async () => {
  const input = makeInput();
  const resumeFrom = {
    context: emptyCtx(),
    memory: { calls: 0 },
    controlState: "call",
    seq: 2,
  };
  const runtime = new MachineRuntime({
    machine: loopMachine, input, sdk: makeSdk(), resumeFrom,
  });
  const { result, transitions } = await runtime.run();
  assert.equal(result.status, "completed");
  // 从 call 续跑：call→append→call→append→done = 4 次新转移
  assert.equal(transitions.length, 4);
  assert.equal(transitions[0].seq, 3);   // 序号续接
});
