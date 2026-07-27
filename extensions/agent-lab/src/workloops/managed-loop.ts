/**
 * Managed loop skeleton — shared iteration core for managed work-loop
 * implementations (budgeted-history, selective-summary, etc.).
 *
 * ## Design
 *
 * Managed loops differ from general-purpose WorkLoopImplementations: they
 * have no tool access (v1), run a simple model-complete → append loop, and
 * delegate context-size management to a pluggable strategy hook.
 *
 * Every context mutation goes through `sdk.context` ops so the contextId
 * lineage is traceable (M7).  Hard caps (maxModelCalls, tokenCeiling) are
 * enforced by the loop itself — not the strategy.
 *
 * ## Usage aggregation
 *
 * Usage is aggregated across all model calls.  When any call's usage carries
 * `_source: "derived"` the aggregate output tags `_source: "mixed"` so
 * downstream consumers know the numbers are not purely observed.
 *
 * @module managed-loop
 */

import { contextTokenTotal } from "./context-metrics.ts";
import type {
  WorkLoopSDK,
  WorkLoopInput,
  WorkLoopResult,
  WorkContext,
  StandardAgentOutput,
} from "../workloop/contracts.ts";

// ── Config ──────────────────────────────────────────────────────────

export interface ManagedLoopConfig {
  /** Model id to pass through to sdk.model.complete options. */
  model: string;
  /** Optional system prompt seeded into initialContext. */
  systemPrompt?: string;
  /** Maximum model calls before forced termination (default 8). */
  maxModelCalls?: number;
  /** Hard ceiling on context token count — if exceeded AND strategy
   *  cannot reduce, the loop terminates. */
  tokenCeiling?: number;
}

// ── Strategy hook ───────────────────────────────────────────────────

/**
 * A pluggable context-management strategy.
 *
 * Called by the managed loop before each model call when the current
 * context exceeds the strategy's own budget threshold (or tokenCeiling
 * as fallback).  The strategy may transform (truncate, summarise,
 * select) the context and must report whether a transform occurred.
 *
 * If the strategy returns `{ transformed: false }` AND the context still
 * exceeds `tokenCeiling` (the hard guard), the loop terminates.
 */
export interface StrategyHook {
  /**
   * Optional: the token threshold at which the managed loop should
   * invoke this strategy.  When not provided the loop falls back to
   * the configured `tokenCeiling` so existing strategies that never
   * declared `budgetThreshold` still work.
   */
  budgetThreshold?: (config: Record<string, unknown>) => number;

  transform(
    context: WorkContext,
    config: Record<string, unknown>,
    sdk: WorkLoopSDK,
  ): Promise<{ context: WorkContext; transformed: boolean; summaryCalls?: number }>;
}

// ── Loop runner ─────────────────────────────────────────────────────

/**
 * Run a managed loop with the given strategy.
 *
 * The loop iterates:
 * 1. Check cancellation (sdk.control.throwIfCancelled).
 * 2. If context tokens exceed the strategy's budgetThreshold (falling back
 *    to tokenCeiling) → invoke strategy.transform.  If the strategy cannot
 *    reduce AND context still exceeds tokenCeiling (hard guard), terminate.
 * 3. Call sdk.model.complete.
 * 4. Append the assistant message via sdk.context.append (M7 lineage).
 * 5. Stop when model signals completion (no tool-use in response) or
 *    when maxModelCalls is reached.
 *
 * Returns a WorkLoopResult with aggregated usage and the final context.
 */
export async function runManagedLoop(
  input: WorkLoopInput,
  sdk: WorkLoopSDK,
  strategyHook: StrategyHook,
): Promise<WorkLoopResult> {
  const config = input.config as Record<string, unknown>;
  const maxModelCalls = (config.maxModelCalls as number | undefined) ?? 8;
  const tokenCeiling = (config.tokenCeiling as number | undefined) ?? 32000;

  let context = input.context;
  let calls = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let hasDerived = false;
  let totalToolCalls = 0;
  const startedAt = Date.now();

  while (calls < maxModelCalls) {
    // ── Cancellation ──────────────────────────────────────────
    sdk.control.throwIfCancelled();

    // ── Strategy guard ────────────────────────────────────────
    // Invoke the strategy when context exceeds its declared
    // budgetThreshold; when no threshold is declared fall back to
    // tokenCeiling (the hard guard).
    const strategyThreshold = strategyHook.budgetThreshold
      ? strategyHook.budgetThreshold(config)
      : tokenCeiling;

    const currentTokens = contextTokenTotal(context);
    if (currentTokens > strategyThreshold) {
      const strategyResult = await strategyHook.transform(context, config, sdk);
      context = strategyResult.context;

      // P6b: summary calls made by the strategy count toward maxModelCalls
      // so that a misbehaving summary model cannot cause unbounded spend.
      if (strategyResult.summaryCalls) {
        calls += strategyResult.summaryCalls;
      }
      // If summary calls exhausted the budget, stop before the main model call.
      if (calls >= maxModelCalls) {
        break;
      }

      if (!strategyResult.transformed) {
        // Strategy could not reduce — check hard ceiling
        if (contextTokenTotal(context) > tokenCeiling) {
          // Over hard ceiling and cannot reduce — terminate
          break;
        }
        // Under hard ceiling — continue despite no transform
      }
    }

    // ── Model call ────────────────────────────────────────────
    const result = await sdk.model.complete(context, { strategyId: config.strategyId });

    // ── Append assistant message with lineage ─────────────────
    const newContextId = `ctx-${crypto.randomUUID()}`;
    context = sdk.context.append(context, [result.message], newContextId);

    calls++;

    // ── Aggregate usage ───────────────────────────────────────
    if (result.usage) {
      totalInput += result.usage.input;
      totalOutput += result.usage.output;
      totalCacheRead += result.usage.cacheRead ?? 0;
      totalCacheWrite += result.usage.cacheWrite ?? 0;
      totalCost += result.usage.cost;
      totalToolCalls += result.usage.toolCalls;

      const usageAny = result.usage as Record<string, unknown>;
      if (usageAny._source === "derived") {
        hasDerived = true;
      }
    }

    // ── Stop condition ────────────────────────────────────────
    // In v1 without tools the model always produces a terminal
    // response on the first call.  When tools are added in a later
    // version, the loop would check for tool-use requests here.
    // For now we stop after every model call — the loop structure
    // is ready for multi-turn when needed.
    break;
  }

  // ── Build aggregate usage ───────────────────────────────────
  const usage: StandardAgentOutput["usage"] = {
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheWrite: totalCacheWrite,
    cost: totalCost,
    turns: calls,
    toolCalls: totalToolCalls,
    durationMs: Date.now() - startedAt,
  };

  // Tag mixed-source when any call was derived
  if (hasDerived) {
    (usage as Record<string, unknown>)._source = "mixed";
  }

  // ── Determine status ────────────────────────────────────────
  // v1: single-turn, status is always "completed"
  const status: WorkLoopResult["status"] = "completed";

  // Preserve the standard output text from the last assistant message
  let lastText: string | undefined;
  if (context.messages.length > 0) {
    const lastMsg = context.messages[context.messages.length - 1];
    if (lastMsg && typeof lastMsg.content === "string") {
      lastText = lastMsg.content;
    }
  }

  return {
    status,
    output: {
      standard: {
        text: lastText,
        usage,
      },
    },
    context,
    state: input.state,
  };
}
