/**
 * budgeted-history@1.0.0 — context-management strategy that keeps the
 * system prompt and the most recent messages fitting within a configurable
 * token budget, dropping the oldest middle segment.
 *
 * ## Strategy
 *
 * 1. Compute current token count via `contextTokenTotal`.
 * 2. If under `budgetTokens` (default 8192): no transform.
 * 3. If over: walk messages from newest to oldest, accumulating token
 *    estimates, stopping when adding the next message would exceed the budget.
 * 4. Keep those most-recent messages + the original system prompt.
 * 5. Emit `context.transformed` (kind: "truncate") with before/after token
 *    counts and dropped-segment count (T2 helper).
 *
 * ## cloneModes
 *
 * Only `"fresh"` is declared — matches `BUDGETED_HISTORY_DEFINITION` in
 * `src/runtime/create-experiment-runtime.ts`.  Fork support may be added in
 * P6b.
 *
 * @module budgeted-history
 */

import { estimateTokens, contextTokenTotal } from "./context-metrics.ts";
import { emitContextTransform } from "./context-events.ts";
import { runManagedLoop } from "./managed-loop.ts";
import type { StrategyHook } from "./managed-loop.ts";
import type {
  WorkLoopImplementation,
  WorkLoopInput,
  WorkLoopResult,
  WorkLoopSDK,
  WorkContext,
} from "../workloop/contracts.ts";

// ── Strategy hook ───────────────────────────────────────────────────

/**
 * Create the budgeted-history strategy hook.
 *
 * The strategy does NOT make LLM calls itself; it purely truncates the
 * message list.  Token estimates use the `chars/4` heuristic from
 * `context-metrics.ts` and are tagged `source: "estimated"` in the
 * emitted `context.transformed` event.
 */
function createBudgetedHistoryStrategy(): StrategyHook {
  return {
    budgetThreshold(config: Record<string, unknown>): number {
      return (config.budgetTokens as number | undefined) ?? 8192;
    },

    async transform(
      context: WorkContext,
      config: Record<string, unknown>,
      sdk: WorkLoopSDK,
    ): Promise<{ context: WorkContext; transformed: boolean }> {
      const budgetTokens = (config.budgetTokens as number | undefined) ?? 8192;

      // ── Fast path: under budget ─────────────────────────────
      const beforeTokens = contextTokenTotal(context);
      if (beforeTokens <= budgetTokens) {
        return { context, transformed: false };
      }

      // ── Walk from newest to oldest ──────────────────────────
      const messages = context.messages;
      const kept: typeof messages = [];
      let keptTokens = 0;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        const msgTokens = estimateTokens(msg.content);
        if (keptTokens + msgTokens <= budgetTokens) {
          kept.unshift(msg);
          keptTokens += msgTokens;
        } else {
          // Cannot fit this message — stop walking
          break;
        }
      }

      const droppedSegments = messages.length - kept.length;

      // ── Build new context with proper lineage ───────────────
      const newContextId = `ctx-${crypto.randomUUID()}`;
      const newContext: WorkContext = {
        systemPrompt: context.systemPrompt,
        messages: kept,
        tools: context.tools,
        metadata: {
          contextId: newContextId,
          parentContextId: context.metadata.contextId,
          sourceRefs: [...context.metadata.sourceRefs],
          artifactRefs: [...context.metadata.artifactRefs],
        },
      };

      const afterTokens = contextTokenTotal(newContext);

      // ── Emit transform event ─────────────────────────────────
      emitContextTransform(sdk.telemetry, {
        strategyId: "budgeted-history",
        kind: "truncate",
        beforeTokens,
        afterTokens,
        droppedSegments,
      });

      return { context: newContext, transformed: true };
    },
  };
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * budgeted-history@1.0.0 WorkLoopImplementation.
 *
 * - initialContext: an empty context seeded with a system prompt from
 *   config if provided.
 * - initialState: empty object (stateless strategy).
 * - run: delegates to `runManagedLoop` with the budgeted-history strategy.
 * - cloneModes: `["fresh"]` — matches `BUDGETED_HISTORY_DEFINITION`.
 */
export const budgetedHistory: WorkLoopImplementation = {
  id: "budgeted-history",
  version: "1.0.0",
  cloneModes: ["fresh"],

  initialContext(config: unknown): WorkContext {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      systemPrompt: typeof cfg?.systemPrompt === "string" ? cfg.systemPrompt : undefined,
      messages: [],
      tools: undefined,
      metadata: {
        contextId: "ctx-initial",
        sourceRefs: [],
        artifactRefs: [],
      },
    };
  },

  initialState(_config: unknown): unknown {
    return {};
  },

  async run(input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult> {
    return runManagedLoop(input, sdk, createBudgetedHistoryStrategy());
  },
};
