/**
 * Context token estimation helpers.
 *
 * ## Heuristic limitations
 *
 * We do **not** have a tokenizer. All estimates use `ceil(chars / 4)` which is a
 * rough heuristic originally popularised for English text.  It does not account
 * for:
 *
 * - Non-English / CJK characters (which may be >1 token each in subword tokenizers).
 * - Special tokens (BOS, EOS, separator tokens) injected by the model provider.
 * - Tool-call / function-call schema definitions injected by the provider.
 * - Image or other multi-modal parts (not estimated).
 *
 * Every value is tagged `source: "estimated"` when emitted in telemetry so that
 * downstream consumers can distinguish heuristic estimates from real,
 * provider-reported token counts.
 *
 * @module context-metrics
 */

import type { WorkContext } from "../workloop/contracts.ts";

/**
 * Heuristic token estimate for arbitrary content.
 *
 * - strings: `ceil(chars / 4)`
 * - other scalar: JSON-stringified then `ceil(chars / 4)`
 * - structured (object / array): JSON-stringified then `ceil(chars / 4)`
 * - undefined / null / empty string: 0
 * - serialisation failures (e.g. cyclic objects): falls back to 0
 *
 * @returns non-negative integer estimate, always >= 0.
 */
export function estimateTokens(content: unknown): number {
  if (content === undefined || content === null) return 0;

  if (typeof content === "string") {
    return content.length === 0 ? 0 : Math.ceil(content.length / 4);
  }

  try {
    const serialised = JSON.stringify(content);
    if (serialised === undefined) return 0;
    return serialised.length === 0 ? 0 : Math.ceil(serialised.length / 4);
  } catch {
    // Cyclic objects or other serialisation failures.
    return 0;
  }
}

/**
 * Estimate the total token count for a work-loop context.
 *
 * Includes:
 * - `systemPrompt` (if set)
 * - every `messages[].content` (recursively via `estimateTokens`)
 *
 * Does **not** include `tools` definitions — those are injected by the provider
 * and are not measurable from `WorkContext` alone.
 *
 * @returns non-negative integer estimate.
 */
export function contextTokenTotal(context: WorkContext): number {
  let total = 0;

  if (context.systemPrompt) {
    total += estimateTokens(context.systemPrompt);
  }

  for (const msg of context.messages) {
    total += estimateTokens(msg.content);
  }

  return total;
}
