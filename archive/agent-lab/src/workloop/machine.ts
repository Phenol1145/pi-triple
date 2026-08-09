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
