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
    let event: MachineEvent = {
      type: "start",
      payload: {
        task: this.input.task,
        // 初始事件 payload 携带 agentInstanceId（Task 6）：δ 侧 telemetry 可
        // 补充 agent 字段（arena_bid.model_completed/failed 下游兼容）。
        agentInstanceId: this.input.agentInstanceId,
      },
    };
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
      const fromState = transitions.at(-1)?.toState ?? controlState;
      const stepResult = await this.machine.step(ctx, memory, event, dspSdk);
      ctx = stepResult.context;
      memory = stepResult.state;
      controlState = next;

      // ── 投影（DSP 变化记录） ──
      const dsp = derive();
      const record: MachineTransitionRecord = {
        seq, fromState, eventType: event.type, toState: next, dspChanged: dsp || undefined,
      };

      // ── 自动 checkpoint ──
      // 写入 controlState/seq（Task 6）：resume 时经 resumeStateOf 重建控制状态与序号。
      let checkpointId: string | undefined;
      if (seq % this.checkpointEvery === 0) {
        const cp = await this.sdk.checkpoint.save(ctx, memory, {
          label: `${next}#${seq}`,
          controlState: next,
          seq,
        });
        checkpointId = cp.checkpointId;
      }
      record.checkpointId = checkpointId;

      // ── 转移级 Trace ──
      // identity 补充 transitionSeq/checkpointId（spec §7.2）：状态级事件按
      // (traceId, transitionSeq) 关联来源转移，identity 可直接索引。
      this.sdk.telemetry.emit(
        "machine.transition",
        record,
        { seq },
        { transitionSeq: seq, checkpointId: record.checkpointId },
      );
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
