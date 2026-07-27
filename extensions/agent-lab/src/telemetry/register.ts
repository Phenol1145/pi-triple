import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import type { Outcome } from "../arena/types.ts";
import type { SchedulerRuntimeLike } from "../interceptor/scheduler-bridge.ts";
import { parseSubagentRun } from "./parse.ts";

export function registerTelemetry(
  pi: ExtensionAPI,
  store: Store,
  cfg: LabConfig,
  settleDispatch?: (taskId: string, outcome: Outcome) => void,
  onRunRecorded?: () => void,
): void {
  const startTimes = new Map<string, number>();
  pi.on("tool_execution_start", async (event) => {
    try {
      if (event.toolName !== "subagent") return;
      const id = String((event as { toolCallId?: unknown }).toolCallId ?? "");
      if (id) startTimes.set(id, Date.now());
    } catch (err) {
      console.error("[agent-lab] telemetry start failed:", err);
    }
  });
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "subagent") return;
    try {
      const taskId = String((event as { toolCallId?: unknown }).toolCallId ?? "");
      const startedAt = taskId ? startTimes.get(taskId) : undefined;
      if (taskId) startTimes.delete(taskId);
      const inferenceLatencyMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : 0;
      const raw = event.result as { details?: unknown } | undefined;
      const result = (raw?.details ?? event.result) as Record<string, unknown>;
      const rec = parseSubagentRun({ input: (event.args ?? {}) as Record<string, unknown>, result }, cfg, undefined, taskId);
      if (rec) {
        store.appendRun(rec);
        // fail-open auto-trigger hook: never throw into telemetry handler (L7/I7)
        try { onRunRecorded?.(); } catch { /* swallow */ }
      }
      if (taskId) {
        const outcome: Outcome = {
          completion: rec?.completion ?? 0,
          majorError: Boolean((event as { isError?: unknown }).isError) || rec?.acceptance === "none",
          tokensIn: rec?.tokensIn ?? 0,
          tokensOut: rec?.tokensOut ?? 0,
          cost: rec?.cost ?? 0,
          toolCalls: [],   // v1: 子 agent 内部工具对父扩展不可见（spec §11.3 限制）
          inferenceLatencyMs,
        };
        if (settleDispatch) {
          settleDispatch(taskId, outcome);
        }
      }
    } catch (err) {
      console.error("[agent-lab] telemetry failed:", err);
    }
  });
}

/** Compose a settleDispatch closure that routes through the scheduler runner.
 *
 *  Runtime-only settle.  When the runtime is unavailable or the settle call
 *  misses / errors, the outcome is silently skipped (documented).  No market
 *  fallback remains.
 *
 *  Uses the shared `getRuntime` lazy getter so the closure sees the latest
 *  SchedulerRuntimeLike reference at call time, not at creation time. */
export function createSettleDispatch(
  getRuntime: () => SchedulerRuntimeLike | undefined,
): (taskId: string, outcome: Outcome) => void {
  return (taskId: string, outcome: Outcome) => {
    const rt = getRuntime();
    if (rt?.settle) {
      void rt.settle(taskId, outcome).catch(() => { /* silent skip — documented */ });
      return;
    }
    // runtime unavailable or no settle method → silent skip (documented)
  };
}
