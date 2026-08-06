import type { StandardAgentError, StandardAgentOutput } from "../workloop/contracts.ts";
import type { FallbackTarget } from "../core/contracts.ts";
import type { SchedulingMode } from "./contracts.ts";
import type { SchedulingStrategy } from "./strategy.ts";

// ── Public types ──────────────────────────────────────────────────────

export interface DispatchAttempt {
  schedulerInstanceId: string;
  roundId?: string;
  status: "completed" | "abstained" | "failed";
  error?: StandardAgentError;
}

export type DispatchResult =
  | {
      status: "completed";
      schedulerInstanceId: string;
      /** direct 短路（strategy=direct）无优化轮次，roundId 可为空 */
      roundId?: string;
      selectedAgentId?: string;
      model?: string;
      output?: StandardAgentOutput;
      reason?: string;
      settlementRef?: string;
      attempts: DispatchAttempt[];
    }
  | {
      status: "abstained";
      schedulerInstanceId: string;
      roundId: string;
      reason: string;
      attempts: DispatchAttempt[];
    }
  | {
      status: "fallback";
      target: FallbackTarget;
      attempts: DispatchAttempt[];
    }
  | {
      status: "failed";
      error: StandardAgentError;
      attempts: DispatchAttempt[];
    };

export interface DispatchRequest {
  traceId: string;
  dispatchId?: string;
  schedulerInstanceId?: string;
  role: string;
  task: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
  mode?: SchedulingMode;
  /** 显式调度策略（缺省走 resolveStrategy 自动路由） */
  strategy?: SchedulingStrategy;
  /** direct 模式指定执行 agent（strategy==="direct" 时必填） */
  agentId?: string;
  signal?: AbortSignal;
  settlementRef?: string;
}

// ── Routing match types + resolution (extracted from SchedulerRunner) ─

export interface RoutingMatch {
  role?: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
}

export interface RoutingBinding {
  id: string;
  schedulerInstanceId: string;
  priority: number;
  match: RoutingMatch;
}

/**
 * Static routing resolution. Pure (no repository access) — bindings are
 * expected to be sorted by priority DESC, id ASC from the repository.
 * Exact role match beats catch-all.
 */
export function resolveRoute(
  bindings: RoutingBinding[],
  request: { role: string; taskCategory?: string; labels?: Record<string, string>; caller?: string },
): { binding: RoutingBinding } | undefined {
  let best: RoutingBinding | undefined;
  let bestIsExact = false;

  for (const binding of bindings) {
    const hasRole = binding.match.role !== undefined;
    const isExact = hasRole && binding.match.role === request.role;
    const isCatchAll = !hasRole;

    if (isExact) {
      if (!bestIsExact) {
        // First exact match (highest priority due to sort)
        best = binding;
        bestIsExact = true;
      }
      // Higher priority exact matches already came first, so skip lower ones
      continue;
    }

    if (isCatchAll && !bestIsExact && !best) {
      // First catch-all (highest priority)
      best = binding;
    }
  }

  return best ? { binding: best } : undefined;
}
