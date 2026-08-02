import type { MachineDefinition, ExecutorKind, Executor } from "./machine.ts";
import type { MemorySdkPort, CommsSdkPort } from "../memory/sdk.ts";

export interface WorkMessage { role: string; content: unknown; [key: string]: unknown }
export interface WorkTool { name: string; [key: string]: unknown }

export interface WorkContext {
  systemPrompt?: string;
  messages: WorkMessage[];
  tools?: WorkTool[];
  metadata: {
    contextId: string;
    parentContextId?: string;
    sourceRefs: string[];
    artifactRefs: string[];
  };
}

export type WorkLoopStatus = "completed" | "failed" | "cancelled" | "paused";

export interface StandardAgentOutput {
  text?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
    toolCalls: number;
    durationMs: number;
  };
}

export interface StandardAgentError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WorkLoopInput<TConfig = unknown, TState = unknown> {
  traceId: string;
  executionId: string;
  agentInstanceId: string;
  optimizationRoundId: string;
  task: string;
  context: WorkContext;
  config: Readonly<TConfig>;
  state: TState;
}

export interface WorkLoopResult<TOutput = unknown, TError = unknown, TTrace = unknown, TState = unknown> {
  status: WorkLoopStatus;
  output?: { standard: StandardAgentOutput; custom?: TOutput };
  error?: { standard: StandardAgentError; custom?: TError };
  trace?: { custom?: TTrace };
  context: WorkContext;
  state: TState;
}

export interface ModelPort {
  complete(context: WorkContext, options?: Record<string, unknown>): Promise<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }>;
}

export interface ToolPort {
  execute(name: string, args: unknown): Promise<unknown>;
}

export interface ArtifactPort {
  put(value: unknown, mediaType: string): Promise<string>;
  get(ref: string): Promise<unknown>;
}

export interface WorkLoopTelemetry {
  emit(
    eventType: string,
    payload: unknown,
    metrics?: Record<string, string | number | boolean | null>,
    /** 事件身份补充字段（spec §7.2）：状态级事件以 (traceId, transitionSeq) 关联来源转移。 */
    identity?: { transitionSeq?: number; checkpointId?: string },
  ): void;
}

export interface WorkLoopControl {
  signal: AbortSignal;
  throwIfCancelled(): void;
}

export interface CheckpointPort {
  save(
    context: WorkContext,
    state: unknown,
    opts?: { label?: string; controlState?: string; seq?: number },
  ): Promise<{ checkpointId: string }>;
}

export interface AgentStoragePort {
  get<T = unknown>(key: string): { value: T; version: number } | undefined;
  put<T>(key: string, value: T, expectedVersion: number): { value: T; version: number };
}

export interface ContextOperations {
  append(context: WorkContext, messages: WorkMessage[], newContextId: string): WorkContext;
  filterMessages(context: WorkContext, predicate: (msg: WorkMessage) => boolean, newContextId: string): WorkContext;
  merge(base: WorkContext, other: WorkContext, newContextId: string): WorkContext;
  truncateMessages(context: WorkContext, limit: number, newContextId: string): WorkContext;
}

export interface WorkLoopSDK {
  context: ContextOperations;
  model: ModelPort;
  tools: ToolPort;
  storage: AgentStoragePort;
  artifacts: ArtifactPort;
  checkpoint: CheckpointPort;
  telemetry: WorkLoopTelemetry;
  control: WorkLoopControl;
  /** 记忆能力（Task 12 挂载；可选纯类型扩展，未挂载 = undefined，零行为变更）。 */
  memory?: MemorySdkPort;
  /** 通讯能力（Task 12 挂载；可选纯类型扩展，未挂载 = undefined，零行为变更）。 */
  comms?: CommsSdkPort;
}

export interface WorkLoopImplementation {
  id: string;
  version: string;
  cloneModes: string[];
  /** 执行器类别："pi-delegate"（委托式，需 executor 实例）| "local-model"（本地式，δ 直接调 sdk.model，无需 executor） */
  executorKind: ExecutorKind;
  initialContext(config: unknown): WorkContext;
  initialState(config: unknown): unknown;
  forkState?(state: unknown): unknown;
  /** 状态机定义——取代 run()（Task 4+ 新实现只提供 machine） */
  machine: MachineDefinition;
  /** 委托式执行器（工厂创建后挂载；local-model 不提供；runner 只读此字段） */
  executor?: Executor;
}
