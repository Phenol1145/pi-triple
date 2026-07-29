import type { LabConfig } from "../types.ts";

// ── Runtime contract (matches SchedulerRunner.dispatch from Task 2) ──

export interface SchedulerRuntimeLike {
  dispatch(request: {
    traceId: string;
    dispatchId?: string;
    schedulerInstanceId?: string;
    role: string;
    task: string;
    taskCategory?: string;
    labels?: Record<string, string>;
    caller?: string;
    mode: "select" | "execute";
    signal?: AbortSignal;
    settlementRef?: string;
  }): Promise<DispatchResult>;
  settle?(taskRef: string, outcome: unknown): Promise<boolean>;
}

export type DispatchResult =
  | {
      status: "completed";
      schedulerInstanceId: string;
      roundId: string;
      selectedAgentId?: string;
      model?: string;
      output?: unknown;
      reason?: string;
      settlementRef?: string;
      attempts: unknown[];
    }
  | {
      status: "abstained";
      schedulerInstanceId: string;
      roundId: string;
      reason: string;
      attempts: unknown[];
    }
  | {
      status: "fallback";
      target: { type: string; id?: string; errorCode?: string };
      attempts: unknown[];
    }
  | {
      status: "failed";
      error: { code: string; message: string; retryable?: boolean };
      attempts: unknown[];
    };

// ── Bridge types ────────────────────────────────────────────────────

export interface SchedulerBridgeDeps {
  /** Lazy singleton getter; undefined when the runtime couldn't be constructed. */
  runtime(): SchedulerRuntimeLike | undefined;
  /** Check if a model is in the allowed scope. */
  modelAllowed(model: string): boolean;
}

export type SchedulerBridgeDecision =
  | { action: "apply"; model: string; source: "scheduler"; agentInstanceId?: string }
  | { action: "skip"; reason: string };

// ── toolCallId → agentInstanceId 映射（interceptor 存，telemetry 读，同进程共享）─────
const dispatchAgentMap = new Map<string, string>();
export function recordDispatchAgent(toolCallId: string, agentInstanceId: string): void {
  dispatchAgentMap.set(toolCallId, agentInstanceId);
}
/** 读后删（一次性关联） */
export function takeDispatchAgent(toolCallId: string): string | undefined {
  const v = dispatchAgentMap.get(toolCallId);
  if (v !== undefined) dispatchAgentMap.delete(toolCallId);
  return v;
}

// ── Pure decision logic ─────────────────────────────────────────────

export async function decideSchedulerSelection(
  input: {
    role: string;
    task: string;
    toolCallId?: string;
    cfg: LabConfig;
  },
  deps: SchedulerBridgeDeps,
): Promise<SchedulerBridgeDecision> {
  const sched = input.cfg.scheduler;
  if (!sched?.enabled) {
    return { action: "skip", reason: "scheduler disabled" };
  }

  let runtime: SchedulerRuntimeLike | undefined;
  try {
    runtime = deps.runtime();
  } catch (err) {
    // fail-open: runtime construction error
    return { action: "skip", reason: `runtime error: ${(err as Error)?.message ?? String(err)}` };
  }

  if (!runtime) {
    return { action: "skip", reason: "runtime unavailable" };
  }

  const traceId = input.toolCallId ?? `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let result: DispatchResult;
  try {
    result = await runtime.dispatch({
      traceId,
      schedulerInstanceId: sched.instanceId,
      role: input.role,
      task: input.task,
      mode: "select",
      ...(input.toolCallId ? { settlementRef: input.toolCallId } : {}),
    });
  } catch (err) {
    // fail-open: dispatch error
    return { action: "skip", reason: `dispatch error: ${(err as Error)?.message ?? String(err)}` };
  }

  if (result.status !== "completed") {
    if (result.status === "abstained") {
      return { action: "skip", reason: `scheduler abstained: ${result.reason}` };
    }
    if (result.status === "fallback" && result.target.type === "original-request") {
      return { action: "skip", reason: "scheduler fell back to original request" };
    }
    return { action: "skip", reason: "scheduler failed" };
  }

  const model = result.model;
  if (!model) {
    return { action: "skip", reason: "scheduler completed without model" };
  }

  if (!deps.modelAllowed(model)) {
    return { action: "skip", reason: `model not allowed: ${model}` };
  }

  return { action: "apply", model, source: "scheduler", agentInstanceId: result.selectedAgentId };
}
