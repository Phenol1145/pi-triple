import type {
  AgentCreateSpec,
  AgentDefinition,
  AgentInstanceStatus,
} from "../core/contracts.ts";
import type {
  StandardAgentError,
  StandardAgentOutput,
  WorkLoopStatus,
} from "../workloop/contracts.ts";

export type SchedulingMode = "select" | "execute";

export type { SchedulingStrategy } from "./strategy.ts";

export interface SchedulingInput {
  traceId: string;
  dispatchId: string;
  role: string;
  task: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
  mode: SchedulingMode;
  /** 本 dispatch 生效的调度策略（runner 经 resolveStrategy 解析后注入） */
  strategy?: SchedulingStrategy;
  signal?: AbortSignal;
  settlementRef?: string;
}

export interface AgentSnapshot {
  id: string;
  definition: AgentDefinition;
  status: AgentInstanceStatus;
}

export interface AgentRunRequest {
  task: string;
  configOverrides?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AgentRunResult {
  status: WorkLoopStatus;
  output?: StandardAgentOutput;
  error?: StandardAgentError;
}

export interface SchedulerSDK {
  agents: {
    list(): Promise<AgentSnapshot[]>;
    create(spec: AgentCreateSpec): Promise<{ id: string }>;
    run(agentId: string, request: AgentRunRequest): Promise<AgentRunResult>;
  };
  storage: {
    get<T = unknown>(
      key: string,
    ): { value: T; version: number } | undefined;
    put<T>(
      key: string,
      value: T,
      expectedVersion: number,
    ): { value: T; version: number };
  };
  telemetry: {
    emit(
      eventType: string,
      payload: unknown,
      metrics?: Record<string, string | number | boolean | null>,
    ): void;
  };
  control: { signal: AbortSignal };
}

export type SchedulingResult =
  | {
      status: "completed";
      selectedAgentId?: string;
      model?: string;
      output?: StandardAgentOutput;
      reason?: string;
      settlementRef?: string;
    }
  | { status: "abstained"; reason: string }
  | { status: "failed"; error: StandardAgentError };

export interface SettleOutcome {
  completion: number;
  majorError: boolean;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  toolCalls: { name: string; durationMs: number }[];
  inferenceLatencyMs: number;
}

export interface SettleContext {
  schedulerInstanceId: string;
  roundId?: string;
  traceId: string;
  /** Round parameters frozen at schedule-time. Undefined when roundId is absent or the round cannot be found. */
  parameters?: Readonly<unknown>;
  telemetry: {
    emit(
      eventType: string,
      payload: unknown,
      metrics?: Record<string, string | number | boolean | null>,
    ): void;
  };
  now: number;
}

export interface SchedulerImplementation {
  id: string;
  version: string;
  schedule(
    input: SchedulingInput,
    parameters: Readonly<unknown>,
    sdk: SchedulerSDK,
  ): Promise<SchedulingResult>;
  settle?(
    ctx: SettleContext,
    taskRef: string,
    outcome: SettleOutcome,
  ): Promise<void> | void;
}
