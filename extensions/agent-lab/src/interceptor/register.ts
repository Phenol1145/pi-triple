import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabConfig } from "../types.ts";
import { modelAllowed, loadModelScopeAllow } from "./model-scope.ts";
import { decideSchedulerSelection } from "./scheduler-bridge.ts";
import type { SchedulerRuntimeLike } from "./scheduler-bridge.ts";

/** Register the bridge-only interceptor.
 *
 *  - Bridge (scheduler.enabled + runtime factory) → decideSchedulerSelection →
 *    apply (rewrite input.model + setStatus) or skip/throw (return silently).
 *  - No market.allocate fallback, no classic recommend/pin/select-UI branch.
 *  - Fail-open outer try/catch: never throws into the host event loop.
 */
export function registerInterceptor(
  pi: ExtensionAPI,
  cfg: LabConfig,
  schedulerRuntimeFactory?: () => SchedulerRuntimeLike | undefined,
): void {
  const allowGlobs = loadModelScopeAllow();
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    try {
      const input = event.input as Record<string, unknown>;
      const role = typeof input.agent === "string" ? input.agent : undefined;
      if (!role) return;

      // Bridge-only path: scheduler.enabled + runtime factory
      if (!cfg.scheduler?.enabled || !schedulerRuntimeFactory) return;

      const decision = await decideSchedulerSelection(
        {
          role,
          task: typeof input.task === "string" ? input.task : "",
          toolCallId: (event as { toolCallId?: unknown }).toolCallId as string | undefined,
          cfg,
        },
        {
          runtime: schedulerRuntimeFactory,
          modelAllowed: (model: string) => modelAllowed(model, allowGlobs),
        },
      );

      if (decision.action === "apply") {
        input.model = decision.model;
        const source = decision.source === "scheduler" ? "WeightedScorer" : decision.source;
        ctx.ui.setStatus("agent-lab", `${role} → ${decision.model} (${source})`);
        return;
      }
      // skip → return silently (no rewrite)
    } catch (err) {
      console.error("[agent-lab] interceptor failed (fail-open):", err);
      // fail-open: don't rewrite model, don't throw
    }
  });
}
