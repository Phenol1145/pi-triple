// 周期驱动（spec §6.3）：机械层与智能层的交接——认领 + 派发唤醒 + 失败收敛 + 回流/回收。
// 派发包装层用 withTimeout 强制超时（裁决 N4：executionTimeoutMs 默认 5min，不变量 staleMs > executionTimeoutMs）。

import { randomUUID } from "node:crypto";
import type { LabEvent } from "../core/contracts.ts";
import { withTimeout, isTimeoutFailure } from "../scheduler/with-timeout.ts";
import type { DispatchRequest, DispatchResult } from "../scheduler/runner-types.ts";
import type { SorterEngine } from "./engine.ts";

export interface SorterCycleDeps {
  engine: SorterEngine;
  dispatch: (req: DispatchRequest) => Promise<DispatchResult>;
  intervalMs: number;
  claimN?: number;
  executionTimeoutMs?: number;
  staleMs?: number;
  reflowAgeMs?: number;
  escalateAgeMs?: number;
  appendEvent?: (e: LabEvent) => "inserted" | "duplicate";
  now?: () => number;
}

export interface CycleResult { claimed: number; failed: number; reflowed: number; escalated: number; reclaimed: number }

export async function runSorterCycleOnce(deps: SorterCycleDeps, nowMs: number = Date.now()): Promise<CycleResult> {
  const now = deps.now ?? (() => nowMs);
  const claimN = deps.claimN ?? 3;
  const executionTimeoutMs = deps.executionTimeoutMs ?? 5 * 60_000;
  const staleMs = deps.staleMs ?? 10 * 60_000;
  const out: CycleResult = { claimed: 0, failed: 0, reflowed: 0, escalated: 0, reclaimed: 0 };

  // ① 各 selector agent 认领 topN
  for (const { agentId } of deps.engine.agentsWithSelector()) {
    const claimed = deps.engine.claimTopN(agentId, claimN);
    out.claimed += claimed.length;
    // ②③ 派发（direct + agentId + mode=execute + [task:id] 前缀 + withTimeout 强制超时）
    for (const t of claimed) {
      const req: DispatchRequest = {
        traceId: `sorter-cycle:${now()}:${t.id}`,
        role: "memory-maintenance",
        task: `[task:${t.id}] ${t.text}`,
        taskCategory: "pool-task",
        caller: "sorter-cycle",
        labels: { taskId: t.id },
        mode: "execute",
        strategy: "direct",
        agentId,
        executionTimeoutMs,
      };
      // 裁决 N4：派发包装层 withTimeout 强制超时（executionTimeoutMs 默认 5 分钟）
      const result = await withTimeout(deps.dispatch(req), executionTimeoutMs);
      const failed = result.status !== "completed" || isTimeoutFailure(result as never);
      if (failed) {
        deps.appendEvent?.({ eventId: randomUUID(), eventType: "task.dispatch_failed", schemaVersion: "1", timestamp: now(), identity: { traceId: req.traceId }, payload: { taskId: t.id, agentId, status: result.status } });
        deps.engine.autoReject(agentId, t.id, "dispatch-failed"); // 裁决 I2：进排除名单
        out.failed++;
      }
      // 裁决 B1（claims_count≥3 阈值升级）：派发已返回（非在途）后判定——claimed 源态经 store.escalate（Task 3 已支持）
      const after = deps.engine.getTask(t.id);
      if (after && after.status === "claimed" && after.claimsCount >= 3) {
        deps.appendEvent?.({ eventId: randomUUID(), eventType: "task.claims_exceeded", schemaVersion: "1", timestamp: now(), identity: { traceId: req.traceId }, payload: { taskId: t.id, agentId, claimsCount: after.claimsCount } });
        deps.engine.escalate(t.id, "claims-exceeded");
        out.escalated++;
      }
    }
  }

  // ④ 回流轮（双触发）⑤ stale 回收
  const rf = deps.engine.reflowRound(now(), { reflowAgeMs: deps.reflowAgeMs, escalateAgeMs: deps.escalateAgeMs });
  out.reflowed = rf.reflowed;
  // 修复轮 1：out.escalated += rf.escalated——循环内 claims≥3 阈值升级已 out.escalated++，
  // 此处若用赋值会把它清掉（即使 rf.escalated===0）；reflowed/reclaimed 无循环内增量源，保持赋值。
  out.escalated += rf.escalated;
  out.reclaimed = deps.engine.reclaimStale(staleMs, now());
  return out;
}

export function startSorterCycle(deps: SorterCycleDeps): { stop(): void } {
  const timer = setInterval(() => {
    runSorterCycleOnce(deps).catch(() => { /* 单轮失败静默：下轮幂等 */ });
  }, deps.intervalMs);
  timer.unref();
  return { stop() { clearInterval(timer); } };
}
