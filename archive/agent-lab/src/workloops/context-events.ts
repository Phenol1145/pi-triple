/**
 * Context transform event helpers for work-loop implementations.
 *
 * ## Schema version convention (M4)
 *
 * Events emitted by this module use `schemaVersion: "1.0"`.  This is the same
 * convention used by the runner itself (`src/workloop/runner.ts:emitEvent`).
 * When the event shape changes in a breaking way the version must be bumped.
 *
 * ## Fail-open telemetry
 *
 * Both helpers wrap `telemetry.emit()` in a try/catch so that a telemetry
 * failure (e.g. event-id collision in the event log) never escapes to crash
 * the work-loop.  Lost events are silently dropped — this is acceptable for
 * diagnostic/observability signals that must not interfere with execution.
 *
 * @module context-events
 */

import type { WorkLoopTelemetry } from "../workloop/contracts.ts";

// ── payload / metrics shapes ────────────────────────────────────────

export interface ContextTransformDetails {
  /** Identifier of the strategy that performed the transform. */
  strategyId: string;
  /** The kind of context transform performed. */
  kind: "truncate" | "summarize" | "select" | "inject";
  /** Estimated tokens before the transform. */
  beforeTokens: number;
  /** Estimated tokens after the transform. */
  afterTokens: number;
  /** Number of segments (messages, blocks, etc.) that were dropped. */
  droppedSegments: number;
  /** Optional round identifier for correlation. */
  roundId?: string;
  /** When true, this transform is a fallback after a primary strategy failed. */
  fallback?: boolean;
}

export interface ContextSummaryDetails {
  /** Identifier of the summarisation strategy. */
  strategyId: string;
  /** Number of tokens consumed by the summary LLM call (input). */
  inputTokens: number;
  /** Number of tokens produced by the summary LLM call (output). */
  outputTokens: number;
  /** Cost of the summary LLM call in the configured currency. */
  cost: number;
  /** Duration of the summary LLM call in milliseconds. */
  durationMs: number;
  /** Where the usage data came from: observed (provider-reported) or derived (estimated). */
  source: "observed" | "derived";
  /** Optional round identifier for correlation. */
  roundId?: string;
}

// ── emit helpers ────────────────────────────────────────────────────

/**
 * Emit a `context.transformed` event.
 *
 * Payload carries strategy identity and transform kind; separate metrics carry
 * the numeric estimates so that they can be queried / aggregated independently.
 * All token values are `source: "estimated"`.
 */
export function emitContextTransform(
  telemetry: WorkLoopTelemetry,
  details: ContextTransformDetails,
): void {
  const { strategyId, kind, beforeTokens, afterTokens, droppedSegments, roundId, fallback } = details;

  const payload: Record<string, unknown> = {
    strategyId,
    kind,
    source: "estimated",
  };
  if (roundId !== undefined) payload.roundId = roundId;
  if (fallback !== undefined) payload.fallback = fallback;

  const metrics: Record<string, string | number | boolean | null> = {
    beforeTokens,
    afterTokens,
    droppedSegments,
  };

  safelyEmit(telemetry, "context.transformed", payload, metrics);
}

/**
 * Emit a `context.summary.created` event (P6b forward-compatible).
 *
 * Captures the cost of a summarisation LLM call so that P6b selective-summary
 * can attribute costs per-round.
 */
export function emitSummaryCreated(
  telemetry: WorkLoopTelemetry,
  details: ContextSummaryDetails,
): void {
  const { strategyId, inputTokens, outputTokens, cost, durationMs, source, roundId } = details;

  const payload: Record<string, unknown> = {
    strategyId,
    source,
  };
  if (roundId !== undefined) payload.roundId = roundId;

  const metrics: Record<string, string | number | boolean | null> = {
    inputTokens,
    outputTokens,
    cost,
    durationMs,
  };

  safelyEmit(telemetry, "context.summary.created", payload, metrics);
}

// ── internal ────────────────────────────────────────────────────────

function safelyEmit(
  telemetry: WorkLoopTelemetry,
  eventType: string,
  payload: unknown,
  metrics?: Record<string, string | number | boolean | null>,
): void {
  try {
    telemetry.emit(eventType, payload, metrics);
  } catch {
    // Fail-open: diagnostic events must not crash the work-loop.
  }
}
