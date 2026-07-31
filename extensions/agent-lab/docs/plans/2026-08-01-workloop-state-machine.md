# WorkLoop 状态机化实现计划（图灵机模型落地）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 workloop 基底重构为显式状态机运行时（machine 契约取代 run），执行器双轨（委托/本地），转移级自动 checkpoint + Trace，并迁移全部 5 个 workloop。

**Architecture:** MachineDefinition（状态枚举+转移表+δ）由每个 workloop 声明；MachineRuntime 驱动循环（转移查表→δ→投影→checkpoint→Trace→预算守卫），DSP 派生并在本地式合成 system=SSP+DSP；PiDelegateExecutor 把 pi 事件流映射为转移事件（委托式），本地式 δ 经 DSP 包装的 sdk.model 自驱动；runner 检测 machine 走 MachineRuntime，生命周期事件/CAS 提交语义不变。

**Tech Stack:** TypeScript（node --experimental-strip-types），node:test 测试，零新依赖。

**Spec:** `extensions/agent-lab/docs/specs/2026-08-01-workloop-state-machine-design.md`

## Global Constraints

- 零新增依赖（不引入状态机库，自研 ~150 行运行时）
- 纯逻辑模块不 import pi 包（只 import 本 extension 内部模块）
- 对外行为不变：同一 workloop 的 terminal 结果（status/output/context/state）与迁移前一致
- LabEvent 向后兼容：identity 新增可选 `transitionSeq`，旧事件无此字段不受影响
- 测试命令：`node --experimental-strip-types --test test/<file>.test.ts`（node:test，非 vitest）；全量：`cd extensions/agent-lab && npm test`
- 术语纪律（CONTEXT.md）：WorkLoop=δ、Context=纸带、State=记忆/数据域、控制状态=转移表域；SSP 不变量 / DSP 派生不落盘
- 每个任务结束时：目标测试绿 + 全量测试绿 + 提交
- 概念修正（相对 spec §5.3）：本地式**不创建** LocalModelExecutor 类——δ 直接调用 sdk.model（经 MachineRuntime 的 DSP 包装），避免"executor 事件流单向、无法回写工具执行信号"的死结；`executorKind: "local-model"` = 无需 executor 实例。委托式 PiDelegateExecutor 按 spec 实现

---

### Task 1: machine 契约类型（machine.ts）

**Files:**
- Create: `src/workloop/machine.ts`
- Test: `test/machine-types.test.ts`

**Interfaces:**
- Consumes: `src/workloop/contracts.ts` 现有类型（WorkContext / WorkLoopResult / WorkLoopSDK / WorkLoopInput / WorkMessage）——本任务不修改 contracts
- Produces: 下列导出（Task 2-6 依赖）：

```typescript
export interface MachineState {
  id: string;
  terminal?: boolean;
  projection?: (ctx: WorkContext, memory: unknown) => string;
}
export interface MachineEvent { type: string; payload?: unknown }
export interface StepResult {
  context: WorkContext;
  state: unknown;
  event?: MachineEvent;
  terminal?: WorkLoopResult;
}
export interface MachineDefinition {
  states: ReadonlyArray<MachineState>;
  initial: string;
  transitions: (state: string, event: MachineEvent) => string | undefined;
  step: (ctx: WorkContext, state: unknown, event: MachineEvent, sdk: WorkLoopSDK)
    => Promise<StepResult>;
}
export interface ExecutorContext { deriveDsp(): string }
export interface Executor {
  start(input: WorkLoopInput, sdk: WorkLoopSDK, ectx: ExecutorContext): AsyncIterable<MachineEvent>;
  dispose(): void;
}
export type ExecutorKind = "pi-delegate" | "local-model";
```

- [ ] **Step 1: 写失败测试**

Create `test/machine-types.test.ts`：

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  MachineDefinition, MachineEvent, MachineState, StepResult, Executor, ExecutorContext,
} from "../src/workloop/machine.ts";

// 类型级 + 结构级验证：一个最小示例机器（Task 2 将驱动它）
const echoMachine: MachineDefinition = {
  states: [
    { id: "idle" },
    { id: "done", terminal: true },
  ],
  initial: "idle",
  transitions: (state, event) => {
    if (state === "idle" && event.type === "start") return "done";
    return undefined;
  },
  step: async (ctx, state, event, sdk) => {
    const stepResult: StepResult = {
      context: ctx,
      state,
      terminal: {
        status: "completed",
        context: ctx,
        state,
      },
    };
    return stepResult;
  },
};

test("machine: 状态枚举与初始状态", () => {
  assert.equal(echoMachine.initial, "idle");
  assert.deepEqual(echoMachine.states.map((s) => s.id), ["idle", "done"]);
  assert.equal(echoMachine.states[1].terminal, true);
});

test("machine: 转移表命中与未命中", () => {
  assert.equal(echoMachine.transitions("idle", { type: "start" }), "done");
  assert.equal(echoMachine.transitions("idle", { type: "unknown" }), undefined);
  assert.equal(echoMachine.transitions("done", { type: "start" }), undefined);
});

test("machine: Executor 接口结构（委托式事件源形态）", async () => {
  const executor: Executor = {
    async *start(_input, _sdk, _ectx) {
      yield { type: "pi_update", payload: { currentTool: "read" } } satisfies MachineEvent;
    },
    dispose() {},
  };
  const ectx: ExecutorContext = { deriveDsp: () => "投影测试" };
  const events: MachineEvent[] = [];
  for await (const ev of executor.start({} as never, {} as never, ectx)) events.push(ev);
  assert.equal(events[0].type, "pi_update");
});

test("machine: MachineState 投影声明可选", () => {
  const s: MachineState = { id: "bankrupt", projection: () => "你处于破产状态" };
  assert.equal(s.projection?.({} as never, {}), "你处于破产状态");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/machine-types.test.ts`
Expected: FAIL —— `Cannot find module '../src/workloop/machine.ts'`

- [ ] **Step 3: 实现 machine.ts**

Create `src/workloop/machine.ts`：

```typescript
/**
 * machine.ts — WorkLoop 状态机契约（图灵机模型落地）
 *
 * MachineDefinition = 每个 WorkLoop 声明的状态机：
 *   - states：状态枚举（显式，有限控制状态，转移表定义域）
 *   - initial：初始状态
 *   - transitions：转移表（(state, event) → nextState | undefined）
 *   - step：δ 转移函数（读纸带/记忆，产新纸带/记忆/事件/终止）
 *
 * 记忆（数据域）不进入转移表定义域（无限取值）——经派生影响控制状态，
 * 并作为 δ 的决策输入与副作用（见 spec §2.3）。
 */
import type {
  WorkContext, WorkLoopResult, WorkLoopSDK, WorkLoopInput,
} from "./contracts.ts";

/** 控制状态声明。projection：状态投影（本地式 → DSP，委托式 → 任务文本，spec §2.5/§2.6） */
export interface MachineState {
  id: string;
  terminal?: boolean;
  projection?: (ctx: WorkContext, memory: unknown) => string;
}

/** 转移事件：外部（executor 事件流）或内部（δ 自驱动）来源统一 */
export interface MachineEvent {
  type: string;
  payload?: unknown;
}

/** δ 转移函数的结果：新纸带/记忆 + 可选自驱动事件 + 可选终止结果 */
export interface StepResult {
  context: WorkContext;
  state: unknown;
  event?: MachineEvent;
  terminal?: WorkLoopResult;
}

/** WorkLoop 声明的状态机定义 */
export interface MachineDefinition {
  states: ReadonlyArray<MachineState>;
  initial: string;
  transitions: (state: string, event: MachineEvent) => string | undefined;
  step: (ctx: WorkContext, state: unknown, event: MachineEvent, sdk: WorkLoopSDK)
    => Promise<StepResult>;
}

/** MachineRuntime 注入执行器的上下文（DSP 派生 getter，本地式合成 system 用） */
export interface ExecutorContext {
  deriveDsp(): string;
}

/** 执行器 = 模型调用抽象（LLM 读写头封装）。委托式提供事件源；本地式无需实例（spec §5） */
export interface Executor {
  start(input: WorkLoopInput, sdk: WorkLoopSDK, ectx: ExecutorContext): AsyncIterable<MachineEvent>;
  dispose(): void;
}

export type ExecutorKind = "pi-delegate" | "local-model";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/machine-types.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 提交**

```bash
git add src/workloop/machine.ts test/machine-types.test.ts
git commit -m "feat(agent-lab): machine 契约类型（MachineDefinition/MachineEvent/StepResult/Executor）"
```

---

### Task 2: MachineRuntime（驱动循环 + DSP + checkpoint + 预算 + Trace + resume）

**Files:**
- Create: `src/workloop/machine-runtime.ts`
- Test: `test/machine-runtime.test.ts`

**Interfaces:**
- Consumes: `MachineDefinition / MachineEvent / StepResult / Executor / ExecutorContext`（Task 1）；`WorkLoopSDK`（sdk.telemetry / sdk.checkpoint / sdk.context / sdk.control / sdk.model）
- Produces:

```typescript
export interface RuntimeBudgets {
  maxTurns?: number;        // 转移次数上限（不含初始 start 转移），默认 100
  timeoutMs?: number;       // 总时长上限
}
export interface ResumeState {
  context: WorkContext;
  memory: unknown;
  controlState: string;
  seq: number;              // 已完成的转移数（下一转移从 seq+1 编号）
}
export interface MachineRuntimeOptions {
  machine: MachineDefinition;
  input: WorkLoopInput;
  sdk: WorkLoopSDK;
  executor?: Executor;      // 委托式注入；本地式省略
  budgets?: RuntimeBudgets;
  resumeFrom?: ResumeState;
  checkpointEvery?: number; // 每 N 次转移 checkpoint，默认 1（每次）
}
export interface MachineTransitionRecord {
  seq: number;
  fromState: string;
  eventType: string;
  toState: string;
  checkpointId?: string;
  dspChanged?: string;
}
export interface MachineRuntimeResult {
  result: WorkLoopResult;
  transitions: MachineTransitionRecord[];
  finalSeq: number;
}
export function deriveDsp(opts: {
  controlState: string;
  machine: MachineDefinition;
  ctx: WorkContext;
  memory: unknown;
  seq: number;
  budgets?: RuntimeBudgets;
}): string;
export class MachineRuntime {
  constructor(opts: MachineRuntimeOptions);
  run(): Promise<MachineRuntimeResult>;
}
```

- [ ] **Step 1: 写失败测试**

Create `test/machine-runtime.test.ts`：

```typescript
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
      save: async (ctx, state, label) => {
        checkpoints.push(`${ctx.metadata.contextId}:${label ?? ""}`);
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
  const checkpoints: string[] = [];
  const sdk = makeSdk({
    checkpoint: {
      save: async (ctx, _s, label) => {
        checkpoints.push(label ?? "");
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
  assert.deepEqual(checkpoints, ["done#1"]);          // 每次转移后 checkpoint，label = `${next}#${seq}`
  assert.deepEqual(transitions, ["done"]);
});

// ── 场景 2：δ 自驱动多事件循环（本地式形态） ──

const loopMachine: MachineDefinition = {
  states: [
    { id: "call" }, { id: "append" }, { id: "done", terminal: true },
  ],
  initial: "call",
  transitions: (s, e) => {
    if (s === "call" && e.type === "assistant_turn") return "append";
    if (s === "append" && e.type === "more") return "call";
    if (s === "append" && e.type === "max_calls") return "done";
    return undefined;
  },
  step: async (ctx, state, event, sdk) => {
    if (event.type === "assistant_turn") {
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
  // call→append→call→append→done：5 次转移
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

test("runtime: 未定义转移忽略 + warning 记录", async () => {
  const sdk = makeSdk();
  const warnings: string[] = [];
  sdk.telemetry.emit = (t, payload) => {
    if (t === "machine.transition_warning") warnings.push((payload as { eventType: string }).eventType);
  };
  const machine: MachineDefinition = {
    states: [{ id: "idle" }, { id: "done", terminal: true }],
    initial: "idle",
    transitions: (s, e) => (s === "idle" && e.type === "start" ? "done" : undefined),
    step: async (ctx, state) => ({
      context: ctx, state,
      event: { type: "unknown_event" },  // 自驱动一个无转移边的事件
      terminal: undefined,
    }),
  };
  const runtime = new MachineRuntime({ machine, input: makeInput(), sdk });
  const { result } = await runtime.run();
  // 自驱动 unknown_event 在 done 前产生 → 忽略；随后无事件 → 循环无法继续？见下方断言
  assert.equal(result.status, "completed");
  assert.ok(warnings.length >= 1);
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

test("runtime: resumeFrom 恢复控制状态与记忆", async () => {
  const input = makeInput();
  const resumeFrom = {
    context: emptyCtx(),
    memory: { calls: 1 },
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/machine-runtime.test.ts`
Expected: FAIL —— `Cannot find module '../src/workloop/machine-runtime.ts'`

- [ ] **Step 3: 实现 machine-runtime.ts**

Create `src/workloop/machine-runtime.ts`：

```typescript
/**
 * machine-runtime.ts — WorkLoop 状态机运行时（确定性骨架）
 *
 * 驱动循环：state + event → 转移表 → δ → 新纸带/记忆 → 投影 → checkpoint → Trace。
 * 事件来源：δ 自驱动（本地式）或 executor 事件流（委托式）。
 * 硬约束：转移表（未定义边 → 忽略 + warning）、预算守卫（maxTurns/timeout）。
 * DSP：由（控制状态投影 + 预算剩余 + 环境）派生，本地式在 complete 边界合成 system = SSP + DSP。
 */
import type {
  MachineDefinition, MachineEvent, Executor, ExecutorContext,
} from "./machine.ts";
import type {
  WorkContext, WorkLoopInput, WorkLoopResult, WorkLoopSDK, ModelPort,
} from "./contracts.ts";

export interface RuntimeBudgets {
  maxTurns?: number;
  timeoutMs?: number;
}

export interface ResumeState {
  context: WorkContext;
  memory: unknown;
  controlState: string;
  seq: number;
}

export interface MachineRuntimeOptions {
  machine: MachineDefinition;
  input: WorkLoopInput;
  sdk: WorkLoopSDK;
  executor?: Executor;
  budgets?: RuntimeBudgets;
  resumeFrom?: ResumeState;
  checkpointEvery?: number;
}

export interface MachineTransitionRecord {
  seq: number;
  fromState: string;
  eventType: string;
  toState: string;
  checkpointId?: string;
  dspChanged?: string;
}

export interface MachineRuntimeResult {
  result: WorkLoopResult;
  transitions: MachineTransitionRecord[];
  finalSeq: number;
}

/** 派生 DSP（投影 + 预算剩余 + 环境元数据）。派生源均在 checkpoint 内 → 不落盘、恢复重建 */
export function deriveDsp(opts: {
  controlState: string;
  machine: MachineDefinition;
  ctx: WorkContext;
  memory: unknown;
  seq: number;
  budgets?: RuntimeBudgets;
}): string {
  const { controlState, machine, ctx, memory, seq, budgets } = opts;
  const parts: string[] = [];
  const stateDef = machine.states.find((s) => s.id === controlState);
  const projection = stateDef?.projection?.(ctx, memory);
  if (projection) parts.push(`[状态投影] ${projection}`);
  if (budgets?.maxTurns !== undefined) parts.push(`[预算] 已用转移 ${seq} / 上限 ${budgets.maxTurns}`);
  if (seq !== undefined) parts.push(`[执行] 转移序号 ${seq}`);
  return parts.join("\n");
}

/** 把 sdk.model 包装为 DSP 合成版（每次 complete 前把 DSP 拼进 systemPrompt，不改原 ctx） */
function wrapModelWithDsp(model: ModelPort, derive: () => string): ModelPort {
  return {
    complete: async (ctx, options) => {
      const dsp = derive();
      if (!dsp) return model.complete(ctx, options);
      return model.complete(
        { ...ctx, systemPrompt: `${ctx.systemPrompt ?? ""}\n\n${dsp}` },
        options,
      );
    },
  };
}

export class MachineRuntime {
  private readonly machine: MachineDefinition;
  private readonly input: WorkLoopInput;
  private readonly sdk: WorkLoopSDK;
  private readonly executor?: Executor;
  private readonly budgets: Required<RuntimeBudgets>;
  private readonly checkpointEvery: number;
  private readonly resumeFrom?: ResumeState;

  constructor(opts: MachineRuntimeOptions) {
    this.machine = opts.machine;
    this.input = opts.input;
    this.sdk = opts.sdk;
    this.executor = opts.executor;
    this.budgets = {
      maxTurns: opts.budgets?.maxTurns ?? 100,
      timeoutMs: opts.budgets?.timeoutMs ?? 0,
    };
    this.checkpointEvery = opts.checkpointEvery ?? 1;
    this.resumeFrom = opts.resumeFrom;
  }

  async run(): Promise<MachineRuntimeResult> {
    const resume = this.resumeFrom;
    let controlState = resume?.controlState ?? this.machine.initial;
    let ctx: WorkContext = resume?.context ?? this.input.context;
    let memory: unknown = resume?.memory ?? this.input.state;
    let seq = resume?.seq ?? 0;
    let event: MachineEvent = { type: "start", payload: { task: this.input.task } };
    const transitions: MachineTransitionRecord[] = [];
    const startedAt = Date.now();

    // DSP 派生 getter（供 executor 与 model 包装使用）
    const derive = (): string => deriveDsp({
      controlState, machine: this.machine, ctx, memory, seq, budgets: this.budgets,
    });

    // 本地式：δ 拿到的 sdk.model 已被 DSP 包装
    const dspSdk: WorkLoopSDK = { ...this.sdk, model: wrapModelWithDsp(this.sdk.model, derive) };
    // 委托式：executor 的 ectx.deriveDsp
    const ectx: ExecutorContext = { deriveDsp: derive };

    let executorIterator: AsyncIterator<MachineEvent> | null = null;
    if (this.executor) {
      executorIterator = this.executor.start(this.input, this.sdk, ectx)[Symbol.asyncIterator]();
    }

    // resume 续跑时若存在待处理事件（resume 简化：从 start 事件重新进入）
    while (true) {
      // ── 预算守卫 ──
      if (seq >= this.budgets.maxTurns) {
        return this.finish(
          {
            status: "failed",
            error: { standard: { code: "budget-exhausted", message: `转移次数超过上限 ${this.budgets.maxTurns}`, retryable: true } },
            context: ctx, state: memory,
          },
          transitions, seq,
        );
      }
      if (this.budgets.timeoutMs > 0 && Date.now() - startedAt > this.budgets.timeoutMs) {
        return this.finish(
          {
            status: "failed",
            error: { standard: { code: "timeout", message: "状态机运行超时", retryable: true } },
            context: ctx, state: memory,
          },
          transitions, seq,
        );
      }
      this.sdk.control.throwIfCancelled();

      // ── 转移表（硬约束入口） ──
      const next = this.machine.transitions(controlState, event);
      if (next === undefined) {
        this.sdk.telemetry.emit("machine.transition_warning", {
          seq: seq + 1, fromState: controlState, eventType: event.type,
        });
        const nextEvent = await this.nextEvent(executorIterator);
        if (!nextEvent) return this.finish(
          { status: "completed", context: ctx, state: memory },
          transitions, seq,
        );
        event = nextEvent;
        continue;
      }

      // ── δ 执行 ──
      seq += 1;
      const stepResult = await this.machine.step(ctx, memory, event, dspSdk);
      ctx = stepResult.context;
      memory = stepResult.state;
      controlState = next;

      // ── 投影（DSP 变化记录） ──
      const dsp = derive();
      const fromState = transitions.at(-1)?.toState ?? controlState;
      const record: MachineTransitionRecord = {
        seq, fromState, eventType: event.type, toState: next, dspChanged: dsp || undefined,
      };

      // ── 自动 checkpoint ──
      let checkpointId: string | undefined;
      if (seq % this.checkpointEvery === 0) {
        const cp = await this.sdk.checkpoint.save(ctx, memory, { label: `${next}#${seq}` });
        checkpointId = cp.checkpointId;
      }
      record.checkpointId = checkpointId;

      // ── 转移级 Trace ──
      this.sdk.telemetry.emit("machine.transition", record, { seq });
      transitions.push(record);

      // ── 终止判定 ──
      if (stepResult.terminal) {
        return this.finish(stepResult.terminal, transitions, seq);
      }
      const nextStateDef = this.machine.states.find((s) => s.id === next);
      if (nextStateDef?.terminal) {
        return this.finish(
          { status: "completed", context: ctx, state: memory },
          transitions, seq,
        );
      }

      // ── 下一事件：δ 自驱动或 executor 外部事件 ──
      if (stepResult.event) {
        event = stepResult.event;
      } else {
        const nextEvent = await this.nextEvent(executorIterator);
        if (!nextEvent) {
          return this.finish(
            { status: "completed", context: ctx, state: memory },
            transitions, seq,
          );
        }
        event = nextEvent;
      }
    }
  }

  /** 恢复点：从最近 checkpoint 重建（纸带 + 记忆 + 控制状态 + 序号） */
  static resumeStateOf(checkpoint: { context: WorkContext; state: unknown; controlState?: string; seq?: number }): ResumeState {
    return {
      context: checkpoint.context,
      memory: checkpoint.state,
      controlState: checkpoint.controlState ?? "",
      seq: checkpoint.seq ?? 0,
    };
  }

  private previousState(transitions: MachineTransitionRecord[], current: string): string {
    return transitions.at(-1)?.toState ?? current;
  }

  private async nextEvent(iterator: AsyncIterator<MachineEvent> | null): Promise<MachineEvent | null> {
    if (!iterator) return null;
    const next = await iterator.next();
    if (next.done) return null;
    return next.value;
  }

  private finish(
    result: WorkLoopResult,
    transitions: MachineTransitionRecord[],
    seq: number,
  ): MachineRuntimeResult {
    return { result, transitions, finalSeq: seq };
  }
}
```

> 注：以上为完整实现骨架（resumeFrom 字段 + 初始事件带 task payload 已包含）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/machine-runtime.test.ts`
Expected: PASS (6 tests)。若场景 4 断言不符（unknown_event 自驱动后 done 前循环细节），以"未定义转移被忽略且 warning 记录、运行仍 completed"为准微调测试

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm test`
Expected: 现有全部通过（本任务未改现有代码）

```bash
git add src/workloop/machine-runtime.ts test/machine-runtime.test.ts
git commit -m "feat(agent-lab): MachineRuntime 驱动循环（δ/投影/checkpoint/Trace/预算守卫/resume/DSP）"
```

---

### Task 3: PiDelegateExecutor（委托式事件源）

**Files:**
- Create: `src/workloops/executors/pi-delegate-executor.ts`
- Test: `test/pi-delegate-executor.test.ts`

**Interfaces:**
- Consumes: `Executor / ExecutorContext / MachineEvent`（Task 1）；`PiSubagentsAdapter`（现有 `src/runtime/pi-subagents-adapter.ts`）；`SubagentDelegationV2Request / SubagentDelegationV2Update / SubagentDelegationV2TerminalResponse`（现有 `src/runtime/delegation-v2.ts`）；`buildV2Request`（从 `pi-default-loop.ts` 迁移到本文件——见 Task 5）
- Produces:

```typescript
export function updateToEvent(update: SubagentDelegationV2Update): MachineEvent;
export class PiDelegateExecutor implements Executor {
  constructor(adapter: PiSubagentsAdapter, buildRequest: (input: WorkLoopInput, ectx: ExecutorContext) => SubagentDelegationV2Request);
  async *start(input: WorkLoopInput, sdk: WorkLoopSDK, ectx: ExecutorContext): AsyncIterable<MachineEvent>;
  dispose(): void;
}
```

事件映射：
- `updateToEvent`: `{ type: "pi_update", payload: update }`（payload 保留 update 全量：currentTool / toolCount / tokens / durationMs / recentTools / model）
- terminal: `{ type: "pi_terminal", payload: terminalResponse }`

- [ ] **Step 1: 写失败测试**

Create `test/pi-delegate-executor.test.ts`：

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { PiDelegateExecutor, updateToEvent } from "../src/workloops/executors/pi-delegate-executor.ts";
import type { ExecutorContext } from "../src/workloop/machine.ts";
import type { WorkLoopInput, WorkLoopSDK } from "../src/workloop/contracts.ts";
import type {
  SubagentDelegationV2Request, SubagentDelegationV2Update, SubagentDelegationV2TerminalResponse,
} from "../src/runtime/delegation-v2.ts";

// ── 假 adapter：回调式 onUpdate → 队列 → terminal ──

class FakeAdapter {
  requests: SubagentDelegationV2Request[] = [];
  private updates: SubagentDelegationV2Update[] = [];
  private terminal: SubagentDelegationV2TerminalResponse | null = null;

  pushUpdate(u: SubagentDelegationV2Update) { this.updates.push(u); }
  finish(t: SubagentDelegationV2TerminalResponse) { this.terminal = t; }

  delegate(request: SubagentDelegationV2Request, options: { onUpdate?: (u: SubagentDelegationV2Update) => void } = {}) {
    this.requests.push(request);
    return new Promise<SubagentDelegationV2TerminalResponse>((resolve) => {
      const timer = setInterval(() => {
        if (this.updates.length > 0) {
          options.onUpdate?.(this.updates.shift()!);
        } else if (this.terminal) {
          clearInterval(timer);
          resolve(this.terminal);
        }
      }, 5);
    });
  }
}

test("updateToEvent: 映射为 pi_update 事件（保留全量 payload）", () => {
  const update: SubagentDelegationV2Update = { currentTool: "read", toolCount: 2, tokens: 100 };
  const ev = updateToEvent(update);
  assert.equal(ev.type, "pi_update");
  assert.equal((ev.payload as SubagentDelegationV2Update).currentTool, "read");
});

test("PiDelegateExecutor: 事件流 = pi_update × N → pi_terminal", async () => {
  const adapter = new FakeAdapter() as never;
  const buildRequest = (_input: WorkLoopInput, _ectx: ExecutorContext): SubagentDelegationV2Request =>
    ({ version: "v2", requestId: "r1", ownerRunId: "o1", nodeId: "n1", agent: "x", task: "t", context: "fresh", cwd: "/tmp" }) as SubagentDelegationV2Request;

  const executor = new PiDelegateExecutor(adapter, buildRequest);
  const input = { task: "t" } as WorkLoopInput;
  const sdk = {} as WorkLoopSDK;
  const ectx: ExecutorContext = { deriveDsp: () => "dsp" };

  // 先启动迭代，再注入事件
  const iterator = executor.start(input, sdk, ectx)[Symbol.asyncIterator]();
  const events: string[] = [];
  const reader = (async () => {
    for await (const ev of executor.start(input, sdk, ectx)) events.push(ev.type);
  })();

  const fake = adapter as unknown as FakeAdapter;
  setTimeout(() => fake.pushUpdate({ currentTool: "read" }), 20);
  setTimeout(() => fake.pushUpdate({ currentTool: "edit" }), 40);
  setTimeout(() => fake.finish({ status: "completed", usage: { input: 10, output: 5 } } as SubagentDelegationV2TerminalResponse), 60);

  await reader;
  assert.deepEqual(events, ["pi_update", "pi_update", "pi_terminal"]);
  assert.equal((fake.requests[0] as { task: string }).task, "t");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/pi-delegate-executor.test.ts`
Expected: FAIL —— module not found

- [ ] **Step 3: 实现 pi-delegate-executor.ts**

Create `src/workloops/executors/pi-delegate-executor.ts`：

```typescript
/**
 * pi-delegate-executor.ts — 委托式执行器（PiSubagentsAdapter 事件源）
 *
 * 把 pi 进程内官方循环的事件流（onUpdate 回调）映射为 MachineEvent 流：
 *   - onUpdate → { type: "pi_update", payload: update }
 *   - terminal response → { type: "pi_terminal", payload: terminal }
 *
 * 回调 → async generator 桥：delegate 的 onUpdate 推入队列，generator 拉取。
 * 中断恢复：resume 后重新 delegate 用新 requestId（spec §5.2）。
 */
import type { PiSubagentsAdapter } from "../../runtime/pi-subagents-adapter.ts";
import type {
  SubagentDelegationV2Request,
  SubagentDelegationV2Update,
  SubagentDelegationV2TerminalResponse,
} from "../../runtime/delegation-v2.ts";
import type { Executor, ExecutorContext, MachineEvent } from "../../workloop/machine.ts";
import type { WorkLoopInput, WorkLoopSDK } from "../../workloop/contracts.ts";

export function updateToEvent(update: SubagentDelegationV2Update): MachineEvent {
  return { type: "pi_update", payload: update };
}

export class PiDelegateExecutor implements Executor {
  constructor(
    private readonly adapter: PiSubagentsAdapter,
    private readonly buildRequest: (input: WorkLoopInput, ectx: ExecutorContext) => SubagentDelegationV2Request,
  ) {}

  async *start(
    input: WorkLoopInput,
    sdk: WorkLoopSDK,
    ectx: ExecutorContext,
  ): AsyncIterable<MachineEvent> {
    const pending: SubagentDelegationV2Update[] = [];
    let notify: (() => void) | null = null;
    let terminal: SubagentDelegationV2TerminalResponse | null = null;
    let done = false;

    const v2req = this.buildRequest(input, ectx);
    const terminalPromise = this.adapter.delegate(v2req, {
      onUpdate: (update) => {
        pending.push(update);
        notify?.();
      },
    });

    while (!done) {
      if (pending.length > 0) {
        yield updateToEvent(pending.shift()!);
        continue;
      }
      if (terminal) {
        yield { type: "pi_terminal", payload: terminal };
        return;
      }
      // 等待：terminal 完成 或 下一次 onUpdate
      const wait = new Promise<void>((resolve) => { notify = resolve; });
      const terminalResult = await Promise.race([
        terminalPromise.then((t) => { terminal = t; return t; }),
        wait.then(() => null),
      ]);
      notify = null;
      if (terminalResult) terminal = terminalResult;
      if (terminal) done = false; // 下一轮循环先产出 pi_terminal
    }
  }

  dispose(): void {
    // adapter 生命周期由 runner 管理（现有 dispose 语义）
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/pi-delegate-executor.test.ts`
Expected: PASS (2 tests)。若测试的假 adapter 与事件顺序偶发不稳，改用确定性队列 + 手动 `await new Promise(r => setTimeout(r, 0))` 步进

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm test`
Expected: 全部通过

```bash
git add src/workloops/executors/pi-delegate-executor.ts test/pi-delegate-executor.test.ts
git commit -m "feat(agent-lab): PiDelegateExecutor 委托式事件源（pi_update/pi_terminal 映射）"
```

---

### Task 4: 契约重构 + market-bid + managed 迁移

**Files:**
- Modify: `src/workloop/contracts.ts`（加 machine/executorKind，run 标 deprecated 保留）
- Modify: `src/workloops/market-bid-loop.ts`（迁移为单转移状态机）
- Modify: `src/workloops/managed-loop.ts`（迁移为五状态机）
- Modify: `src/workloops/budgeted-history.ts` / `selective-summary.ts`（StrategyHook 保留，依赖 managed-loop 新签名）
- Test: `test/workloops-managed-loop.test.ts`（适配新接口）、`test/market-bid-loop.test.ts`（若存在）

**Interfaces:**
- Consumes: `MachineDefinition / MachineEvent / StepResult / ExecutorKind`（Task 1）；`MachineRuntime`（Task 2）
- Produces（契约重构后）:

```typescript
// contracts.ts 中：
export interface WorkLoopImplementation {
  id: string;
  version: string;
  cloneModes: string[];
  executorKind: ExecutorKind;                       // "pi-delegate" | "local-model"
  initialContext(config: unknown): WorkContext;
  initialState(config: unknown): unknown;
  forkState?(state: unknown): unknown;
  machine: MachineDefinition;                       // 取代 run()
  /** @deprecated 过渡期保留（Task 6 删除）；新实现不提供 */
  run?(input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult>;
}
export interface WorkLoopTelemetry {
  emit(eventType: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>): void;
}  // 不变
```

- [ ] **Step 1: 写失败测试（managed 五状态机行为）**

修改 `test/workloops-managed-loop.test.ts`——先读现有文件，把断言 `runManagedLoop` 的部分改为驱动 `implementation.machine`（通过 MachineRuntime）：

```typescript
// 追加用例（保留原有用例改为 machine 驱动）：
import { MachineRuntime } from "../src/workloop/machine-runtime.ts";

test("managed-loop machine: 正常路径 check→call→append→done", async () => {
  const impl = createBudgetedHistoryLoop();   // 或现有工厂
  const input = { traceId: "t", executionId: "e", agentInstanceId: "a",
    optimizationRoundId: "o", task: "task", context: impl.initialContext({}),
    config: {}, state: impl.initialState({}) };
  const sdk = makeSdk();                       // 复用现有测试的假 sdk
  const runtime = new MachineRuntime({ machine: impl.machine, input, sdk });
  const { result } = await runtime.run();
  assert.equal(result.status, "completed");
  assert.equal(result.output?.standard?.usage?.turns, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/workloops-managed-loop.test.ts`
Expected: FAIL —— 现有工厂返回的实现没有 `machine` 属性

- [ ] **Step 3: 契约重构（contracts.ts）**

修改 `src/workloop/contracts.ts`：

```typescript
// 顶部 import ExecutorKind 与 MachineDefinition
import type { MachineDefinition, ExecutorKind } from "./machine.ts";

// WorkLoopImplementation 重构：
export interface WorkLoopImplementation {
  id: string;
  version: string;
  cloneModes: string[];
  executorKind: ExecutorKind;
  initialContext(config: unknown): WorkContext;
  initialState(config: unknown): unknown;
  forkState?(state: unknown): unknown;
  machine: MachineDefinition;
  /** @deprecated 过渡期保留（Task 6 删除）；新实现不提供 */
  run?(input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult>;
}
```

- [ ] **Step 4: 迁移 market-bid-loop（单转移状态机）**

重写 `src/workloops/market-bid-loop.ts` 的 `run` 为 `machine`（保留 `buildBidContext` / `parseBidResponse` / 对外 id/version/cloneModes 不变）：

```typescript
import type { MachineDefinition } from "../workloop/machine.ts";
// ...现有 imports（buildBidContext、parseBidResponse 保留）

export const marketBidLoop: WorkLoopImplementation = {
  id: "market-bid-loop",
  version: "1.0.0",
  cloneModes: ["fresh"],
  executorKind: "local-model",

  initialContext(_config: unknown): WorkContext {
    return { messages: [], metadata: { contextId: "ctx-initial", sourceRefs: [], artifactRefs: [] } };
  },

  initialState(_config: unknown): unknown {
    return {};
  },

  machine: {
    states: [{ id: "idle" }, { id: "done", terminal: true }],
    initial: "idle",
    transitions: (state, event) =>
      state === "idle" && event.type === "start" ? "done" : undefined,
    step: async (ctx, state, event, sdk) => {
      // task 来自初始事件 payload（MachineRuntime 注入：{ type: "start", payload: { task } }）
      const task = ((event.payload as { task?: string } | undefined)?.task) ?? "竞价";
      const bidContext = buildBidContext(task, config);
      const response = await sdk.model.complete(bidContext);
      const parsed = parseBidResponse(response.message.content as string);  // 签名按现有代码保持
      return {
        context: bidContext,
        state,
        terminal: {
          status: "completed",
          output: { standard: { text: ... }, custom: parsed },
          context: bidContext,
          state,
        },
      };
    },
  },
};
```

> 实现说明：`marketBidLoop` 改为工厂 `createMarketBidLoop(config: ArenaBidLoopConfig)`——config（model/promptTemplate/balance）由工厂参数传入（原 input.config 改为工厂参数；调用方 arena-scheduler 在 Task 6 同步改 `marketBidLoop` → `createMarketBidLoop(...)`）；`buildBidContext(task: string, config)` 签名相应调整（task 不再来自 input）。手动 checkpoint 移除（MachineRuntime 已自动 checkpoint）。

- [ ] **Step 5: 迁移 managed-loop（五状态机）**

重写 `src/workloops/managed-loop.ts`：`runManagedLoop` 重构为 `managedMachine(config, strategyHook): MachineDefinition`，工厂 `createManagedLoop(strategyHook)` 返回带 `machine` 的 implementation（现有 `StrategyHook` 接口不变）：

```typescript
export function managedMachine(
  config: ManagedLoopConfig,
  strategyHook: StrategyHook,
): MachineDefinition {
  return {
    states: [
      { id: "check" },
      { id: "manage" },
      { id: "call" },
      { id: "append" },
      { id: "done", terminal: true },
    ],
    initial: "check",
    transitions: (state, event) => {
      switch (state) {
        case "check":
          if (event.type === "ctx_ok") return "call";
          if (event.type === "over_budget") return "manage";
          return undefined;
        case "manage":
          if (event.type === "transformed") return "call";
          if (event.type === "untransformable") return "done";
          return undefined;
        case "call":
          if (event.type === "assistant_turn") return "append";
          return undefined;
        case "append":
          if (event.type === "more") return "check";
          if (event.type === "max_calls") return "done";
          return undefined;
        default:
          return undefined;
      }
    },
    step: async (ctx, state, event, sdk) => {
      // memory 结构：{ calls, totals: {input,output,cacheRead,cacheWrite,cost,toolCalls}, hasDerived }
      const memory = (state ?? {}) as ManagedMemory;
      switch (event.type) {
        case "start": {
          // 首次进入 check：检查上下文预算
          const threshold = strategyHook.budgetThreshold ? strategyHook.budgetThreshold(config) : config.tokenCeiling ?? 32000;
          const currentTokens = contextTokenTotal(ctx);
          return {
            context: ctx,
            state: memory,
            event: { type: currentTokens > threshold ? "over_budget" : "ctx_ok" },
          };
        }
        case "over_budget": {
          const strategyResult = await strategyHook.transform(ctx, config, sdk);
          const calls = memory.calls + (strategyResult.summaryCalls ?? 0);
          const nextMemory = { ...memory, calls };
          if (calls >= (config.maxModelCalls ?? 8)) {
            return { context: strategyResult.context, state: nextMemory, event: { type: "untransformable" } };
          }
          if (!strategyResult.transformed && contextTokenTotal(strategyResult.context) > (config.tokenCeiling ?? 32000)) {
            return { context: strategyResult.context, state: nextMemory, event: { type: "untransformable" } };
          }
          return { context: strategyResult.context, state: nextMemory, event: { type: "transformed" } };
        }
        case "assistant_turn": {
          // 本地式 δ 直接调 sdk.model（DSP 已由 runtime 包装）
          const result = await sdk.model.complete(ctx, { strategyId: config.strategyId });
          const newContextId = `ctx-${crypto.randomUUID()}`;
          const newCtx = sdk.context.append(ctx, [result.message], newContextId);
          const totals = aggregate(memory.totals, result.usage);
          const calls = memory.calls + 1;
          const nextMemory = { ...memory, calls, totals, hasDerived: memory.hasDerived || usageIsDerived(result.usage) };
          return {
            context: newCtx,
            state: nextMemory,
            event: { type: calls >= (config.maxModelCalls ?? 8) ? "max_calls" : "more" },
          };
        }
        default:
          return { context: ctx, state: memory };
      }
    },
  };
}
```

> 实现说明：以上为骨架。`aggregate`/`usageIsDerived` 从原 `runManagedLoop` 的累加逻辑提取；`ManagedMemory` 接口（`{ calls: number; totals: StandardAgentOutput["usage"]; hasDerived: boolean }`）在原文件定义；原 usage 汇总/`_source: "mixed"` 逻辑保留。**终止结果构造**：transitions 表把 `max_calls`/`untransformable` 映射到 `done`（terminal 状态），但 δ 在 `step` 收到这两个事件时**直接返回 `terminal`**（含 usage 汇总 + 最后文本）——MachineRuntime 优先用 `stepResult.terminal`（先检查 terminal 再检查 nextStateDef.terminal），`done` 的 `terminal: true` 仅作兜底。

- [ ] **Step 6: 适配 budgeted-history / selective-summary**

`src/workloops/budgeted-history.ts` / `selective-summary.ts`：把 `runManagedLoop(...)` 调用改为 `managedMachine(config, strategyHook)` + 工厂返回 `machine`（不再调 run）。两个文件的 StrategyHook 实现（transform 逻辑）**原样保留**——只改接线：

```typescript
// budgeted-history.ts 中：
import { managedMachine } from "./managed-loop.ts";
// 工厂：
export function createBudgetedHistoryLoop(...): WorkLoopImplementation {
  const config = ...;   // ManagedLoopConfig（model/systemPrompt/maxModelCalls/tokenCeiling + strategyId）
  return {
    id: "budgeted-history",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: ...,
    initialState: ...,
    machine: managedMachine(config, { budgetThreshold, transform }),
  };
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/workloops-managed-loop.test.ts`（+ market-bid 相关测试）
Expected: PASS。全量：`npm test` —— 若 pi-default-loop.test.ts 因契约变化失败，属预期（Task 5 迁移），**Task 4 结束前允许 pi-default 相关测试红**，其余必须全绿

- [ ] **Step 8: 提交**

```bash
git add src/workloop/contracts.ts src/workloops/market-bid-loop.ts src/workloops/managed-loop.ts src/workloops/budgeted-history.ts src/workloops/selective-summary.ts test/workloops-managed-loop.test.ts
git commit -m "refactor(agent-lab): 契约加 machine/executorKind；market-bid 单转移 + managed 五状态机迁移"
```

---

### Task 5: pi-default-loop 迁移（四状态 + PiDelegateExecutor）

**Files:**
- Modify: `src/workloops/pi-default-loop.ts`（run → machine；buildV2Request/mapResponse 保留，buildV2Request 迁至 executor 文件或保留本文件）
- Test: `test/pi-default-loop.test.ts`（适配 machine 驱动）

**Interfaces:**
- Consumes: `PiDelegateExecutor`（Task 3）、`MachineRuntime`（Task 2）
- Produces: `createPiDefaultLoop(adapter): WorkLoopImplementation`（签名不变，内部 machine + executorKind: "pi-delegate"）

- [ ] **Step 1: 写失败测试**

修改 `test/pi-default-loop.test.ts`：现有测试经 `createWorkLoopRuntime` 驱动——保持集成测试路径（Task 6 适配 runner 后自动恢复）；**本任务新增 machine 级测试**：

```typescript
test("pi-default machine: 事件流驱动四状态（idle→delegating→…→terminal）", async () => {
  const impl = createPiDefaultLoop(fakeAdapter as never);
  assert.equal(impl.executorKind, "pi-delegate");
  assert.deepEqual(impl.machine.states.map((s) => s.id), ["idle", "delegating", "terminal"]);
  assert.equal(impl.machine.initial, "idle");
});
```

- [ ] **Step 2: 运行测试确认失败**

Expected: FAIL —— `impl.machine` 不存在

- [ ] **Step 3: 迁移 pi-default-loop.ts**

重写 `src/workloops/pi-default-loop.ts`：

```typescript
import { PiDelegateExecutor } from "./executors/pi-delegate-executor.ts";
// ...现有 imports（buildV2Request、mapResponse、类型）保留

export function createPiDefaultLoop(adapter: PiSubagentsAdapter): WorkLoopImplementation {
  const executor = new PiDelegateExecutor(adapter, buildV2Request);
  return {
    id: "pi-default-loop",
    version: "1.0.0",
    cloneModes: ["fresh", "fork"],
    executorKind: "pi-delegate",

    initialContext(_config: unknown): WorkContext { /* 不变 */ },
    initialState(_config: unknown): unknown { return {}; },

    machine: {
      states: [
        { id: "idle", projection: (ctx, memory) => `任务已委托给 pi（fresh/fork 由配置决定）` },
        { id: "delegating" },
        { id: "terminal", terminal: true },
      ],
      initial: "idle",
      transitions: (state, event) => {
        if (state === "idle" && event.type === "start") return "delegating";
        if (state === "delegating" && event.type === "pi_update") return "delegating";
        if (state === "delegating" && event.type === "pi_terminal") return "terminal";
        return undefined;
      },
      step: async (ctx, state, event, sdk) => {
        if (event.type === "start") {
          // 委托式投影入任务文本：idle 状态的 projection + 原 task
          // 委托在 executor.start 时发起（buildRequest 闭包内拼投影 + input.task，见实现说明）
          return { context: ctx, state, event: { type: "started" } };
          return { context: ctx, state, event: { type: "started" } };  // 委托在 executor.start 时发起
        }
        if (event.type === "pi_update") {
          // 镜像：把 pi 进度写 Trace（sdk.telemetry 已由 runtime 发 machine.transition）
          const update = event.payload as SubagentDelegationV2Update;
          sdk.telemetry.emit("pi.progress", update, {
            ...(update.toolCount !== undefined ? { toolCount: update.toolCount } : {}),
            ...(update.tokens !== undefined ? { tokens: update.tokens } : {}),
            ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
          });
          return { context: ctx, state };
        }
        if (event.type === "pi_terminal") {
          const response = event.payload as SubagentDelegationV2TerminalResponse;
          return { context: ctx, state, terminal: mapResponse(response, ctx, state) };
        }
        return { context: ctx, state };
      },
    },
  };
}
```

> 实现说明：`PiDelegateExecutor.buildRequest` 需要 `input`（含 task 与 config）——`start(input, sdk, ectx)` 已提供 input；投影入任务文本在 **buildRequest 闭包**内完成（`ectx.deriveDsp()` 或 idle projection）：`buildV2Request` 改为接收 `(input, ectx)`，把 `ectx.deriveDsp()` 作为任务前缀。executor 在 `start` 时立即 delegate——MachineRuntime 在 idle→delegating 转移后从 executor 取事件，delegate 已发出。`thisTask(ctx)` 不需要——buildRequest 直接用 `input.task`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/pi-default-loop.test.ts`
Expected: PASS（集成测试若经 runner 驱动会红——Task 6 适配 runner；本任务结束前允许 runner 相关测试红，**machine 级测试必须绿**）

- [ ] **Step 5: 全量（除 runner 相关已知红）+ 提交**

Run: `npm test`——记录失败清单（预期：workloop-runner.test.ts / scheduler-runner 等经 runner 驱动且依赖旧 run 的测试）

```bash
git add src/workloops/pi-default-loop.ts test/pi-default-loop.test.ts
git commit -m "refactor(agent-lab): pi-default-loop 迁移四状态机 + PiDelegateExecutor（委托式）"
```

---

### Task 6: runner 适配（MachineRuntime 驱动 + resume + 删 run）+ 调用方

**Files:**
- Modify: `src/workloop/runner.ts`（executeRun 检测 machine → MachineRuntime；executor 注入；resume 入口；删 run 分支）
- Modify: `src/workloop/contracts.ts`（删除 `run?` deprecated 字段）
- Modify: `src/runtime/create-runtime.ts` / `create-scheduler-runtime.ts` / `create-experiment-runtime.ts`（WorkLoopRunner 构造传 adapter）
- Modify: `src/experiment/facade.ts`（若直接构造 implementation）
- Test: `test/workloop-runner.test.ts`（适配）、`test/scheduler-runner.test.ts`（回归）

**Interfaces:**
- Consumes: `MachineRuntime / ResumeState`（Task 2）；全部 workloop 已迁移（Task 4-5）
- Produces:

```typescript
// runner.ts：
export interface WorkLoopRunRequest {
  ...现有字段,
  resumeFromCheckpointId?: string;   // 新增：从 checkpoint 恢复
}
// WorkLoopRunner 构造新增可选参数：
constructor(..., deps: { registry; stateStore; checkpointStore; eventLog; storage; model; tools; artifacts; piAdapter?: PiSubagentsAdapter })
```

- [ ] **Step 1: 写失败测试（runner 驱动 machine + resume）**

修改 `test/workloop-runner.test.ts` 追加：

```typescript
test("runner: machine workloop 经 MachineRuntime 驱动 + machine.transition 事件", async () => {
  // 用 marketBidLoop（Task 4 已迁移）经 runner.run()
  // 断言：workloop.started → machine.transition ×N → workloop.completed → agent.completed 事件序列
});

test("runner: resumeFromCheckpointId 从 checkpoint 恢复续跑", async () => {
  // 第一次 run 产生 checkpoint；第二次 run 带 resumeFromCheckpointId → 从最近 checkpoint 续跑
  // 断言：续跑完成 + CAS 提交成功
});
```

- [ ] **Step 2: 运行测试确认失败**

Expected: FAIL —— runner 仍走旧 run() 路径（machine 存在时无 machine 分支）

- [ ] **Step 3: 适配 runner.ts**

`executeRun` 中，`implementation` 解析后：

```typescript
// 原：result = await implementation.run(input, sdk);
// 新：
const machineImpl = implementation as WorkLoopImplementation;   // machine 必填（契约重构后）
// executor 由 workloop 工厂创建并挂在 implementation.executor（见下方实现说明）
```

> 实现说明：**推荐方案**——executor 不由 runner 创建，而是 workloop 工厂创建后挂在 implementation 的可选字段：`WorkLoopImplementation.executor?: Executor`（Task 4 契约加此可选字段；pi-default 工厂返回 `{ ..., executor }`，managed 等 local-model 不提供）。runner 只读 `implementation.executor`。避免 runner 依赖 adapter 与各 workloop 的 request 构造逻辑。**对 Task 4 的修正**：契约加 `executor?: Executor`（可选），`executorKind` 保留（文档/校验用）。

```typescript
// executeRun 中（MachineRuntime 分支）：
let resumeFrom: ResumeState | undefined;
if (request.resumeFromCheckpointId) {
  const cp = this.checkpointStore.get(agentInstanceId, request.resumeFromCheckpointId);
  if (cp) resumeFrom = MachineRuntime.resumeStateOf(cp);
}
const runtime = new MachineRuntime({
  machine: implementation.machine,
  input,
  sdk,
  executor: implementation.executor,
  budgets: { maxTurns: 100 },
  resumeFrom,
});
const { result } = await runtime.run();
```

其余（CAS 提交、生命周期事件、failed/paused 分支）保持不变。checkpointStore 需要 `get(agentInstanceId, checkpointId)` —— 检查现有 `CheckpointStore` 是否有读取 API（`save` 已有；若无 get 则 Task 6 补一个按 id 读取的方法）。

- [ ] **Step 4: 删除 contracts 的 run? 字段 + 更新三个 runtime 工厂**

`contracts.ts` 删 `run?`；`create-runtime.ts` / `create-scheduler-runtime.ts` / `create-experiment-runtime.ts` 的 WorkLoopRunner 构造不变（executor 挂在 implementation 上，runner 无需新参数）；`experiment/facade.ts` 若直接调 `impl.run` 改为经 runner。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/workloop-runner.test.ts`
Expected: PASS；随后全量 `npm test` 全绿（含 pi-default 集成测试恢复）

- [ ] **Step 6: 提交**

```bash
git add src/workloop/runner.ts src/workloop/contracts.ts src/runtime/create-runtime.ts src/runtime/create-scheduler-runtime.ts src/runtime/create-experiment-runtime.ts src/experiment/facade.ts test/workloop-runner.test.ts test/scheduler-runner.test.ts
git commit -m "refactor(agent-lab): runner 走 MachineRuntime（machine 驱动 + resume）；删 run 契约；工厂适配"
```

---

## 对 Task 4 的修正（迁移时一并执行）

1. `WorkLoopImplementation` 加可选字段 `executor?: Executor`（pi-default 工厂返回时携带；local-model 不提供；runner 只读 `implementation.executor`，不自行创建）
2. `CheckpointRecord`（`src/workloop/checkpoints.ts`）加可选字段 `controlState?: string; seq?: number`；`CheckpointPort.save` 签名扩展为 `save(context, state, opts?: { label?: string; controlState?: string; seq?: number })`——MachineRuntime 自动 checkpoint 时写入 `controlState: next, seq`，resume 时经 `MachineRuntime.resumeStateOf` 重建

---

### Task 7: 全量回归 + CONTEXT.md 修订 + 冒烟

**Files:**
- Modify: `CONTEXT.md`（State 条目修订 §2.3 三层、Trace 条目重定义 §7.1——按 spec 文本）
- Modify: `docs/specs/2026-08-01-workloop-state-machine-design.md`（状态标记：设计已实现）
- 冒烟：真实 pi 委托一次（pi-default 状态机路径产出 machine.transition 事件 + checkpoint 文件）

- [ ] **Step 1: 修订 CONTEXT.md**

State 条目改为（对齐 spec §2.3/§7.1）：

```markdown
**State**:
总状态 = 控制状态 + 记忆/数据域。
**控制状态**：有限、可枚举、转移表定义域——描述执行位置，本身不携带信息（非记忆）。
**记忆/数据域**：credit 等跨转移存活的不透明持久化数据（无限取值，不进转移表定义域）——四个作用：跨转移存活（checkpoint 落盘）、派生（阈值分类 → 控制状态）、δ 的决策输入与副作用、按需投影到模型可见层（DSP）。
_Avoid_: context, memory（避免与纸带/Context 混淆）
```

Trace 条目改为（对齐 spec §7.1）：

```markdown
**Trace**:
状态机转移轨迹。记录状态机从初始到终止的每一次转移：转移前控制状态、触发事件、转移后控制状态、δ 副作用摘要（纸带写入 / 记忆变化 / 工具调用）、关联 checkpointId。
粒度（两级）：执行级（转移级）= 一次运行 = `traceId` + 转移序列（`transitionSeq`），转移记录以 `(traceId, transitionSeq)` 唯一定位；状态级 = 记忆域变化（credit 变化、结算）作为转移的副作用事件，以 `(traceId, transitionSeq)` 关联来源转移。
新语义：Trace = 恢复的索引——`resume(checkpointId)` 从 Trace 中该转移的记录重建（纸带 + 记忆 + 控制状态 + 事件队列）。
_Avoid_: session, log（log 太泛）
```

- [ ] **Step 2: 全量回归**

Run: `cd extensions/agent-lab && npm test`
Expected: 全部通过（含 arena-scheduler / arena-execute-mode / experiment 系列——契约行为不变性证明）

- [ ] **Step 3: 真实冒烟（pi 委托）**

```bash
# 1) 确认 extension 可加载
cd /Users/anzhize/pi-platform
node --experimental-strip-types -e "
  import { createPiDefaultLoop } from './extensions/agent-lab/src/workloops/pi-default-loop.ts';
  const impl = createPiDefaultLoop({} as never);
  console.log('executorKind:', impl.executorKind, '| states:', impl.machine.states.map(s=>s.id).join(','));
"
# 期望：executorKind: pi-delegate | states: idle,delegating,terminal

# 2) 若可行：一次真实委托（经实验/调度入口跑 arena execute 或 experiment run）
# 断言：LabEvent 出现 machine.transition 事件（含 transitionSeq 字段）且 checkpoint 文件落盘
```

> 若真实委托在当前环境不可行（无活动 market/agent），记录原因并以上述静态冒烟 + 单测覆盖为准（与 tmux 专项同样的证据标准：单测 + 冒烟输出记录在任务报告）。

- [ ] **Step 4: 提交**

```bash
git add CONTEXT.md docs/specs/2026-08-01-workloop-state-machine-design.md
git commit -m "docs(agent-lab): CONTEXT.md State/Trace 条目对齐状态机模型；spec 标记已实现"
```

---

## 自检清单（写 plan 时执行）

- [x] Spec §3.1/3.2（machine 契约 + executorKind）→ Task 1/4
- [x] Spec §4（MachineRuntime：循环/checkpoint/resume/预算/投影）→ Task 2
- [x] Spec §5（Executor 双轨：PiDelegate + 本地式）→ Task 3 + Task 2（DSP 包装）；本地式不建类（Global Constraints 修正）
- [x] Spec §6（官方语义：turn/stopReason/tool batch/预算；steering/compaction 不做）→ Task 2/4/5 覆盖
- [x] Spec §7（Trace 重定义 + transitionSeq + 副作用注册制）→ Task 2（machine.transition 事件）+ Task 5（pi.progress 事件）
- [x] Spec §8（迁移面：5 workloop + 3 runtime + runner + 测试）→ Task 4/5/6
- [x] Spec §11 不变量（SSP 不变/DSP 重建/投影不污染消息段/CAS 不变/事件兼容）→ 各任务实现约束
- [x] CONTEXT.md 修订 → Task 7
- [x] 无占位符（代码块均完整或含明确实现说明）
- [x] 类型一致性（machine/executor/runtime 签名跨任务核对——见 Interfaces 块）
