/**
 * Instrumented model port for managed work-loops.
 *
 * Wraps a `ModelPort` so that every `complete()` call emits standard
 * instrumentation events through a `WorkLoopTelemetry` channel.
 *
 * This lives in the framework layer (`workloop/`): instrumentation of the
 * model port is a framework capability, not a concrete plugin concern.
 * The plugins-side model-port module re-exports `createInstrumentedModelPort`
 * from here for backwards-compatible deep imports.
 *
 * ## Error handling
 *
 * When the inner port throws (e.g. pi-ai `complete()` returning
 * `stopReason: "error"` or a non-empty `errorMessage`), the wrapper emits
 * `model.failed` (not `model.completed`) and re-throws.
 *
 * ## Fail-open telemetry
 *
 * Telemetry calls in `createInstrumentedModelPort` are wrapped in try/catch
 * so that event-emit failures never escape to crash the enclosing work-loop.
 *
 * @module instrumented-model-port
 */

import type {
  ModelPort,
  WorkLoopTelemetry,
  WorkContext,
  WorkMessage,
  StandardAgentOutput,
} from "./contracts.ts";

// ── Instrumented model port ─────────────────────────────────────────

export interface ModelRequestedPayload {
  strategyId?: string;
}

export interface ModelCompletedMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  durationMs: number;
  /** Where the usage data came from. */
  source: "observed" | "derived";
}

export interface ModelFailedPayload {
  code: string;
  message: string;
}

/**
 * Wrap a ModelPort so that every `complete()` call emits standard
 * instrumentation events through the given telemetry channel.
 *
 * Emitted events:
 * - `model.requested` — before the inner complete() call
 * - `model.completed` — on success, with usage + timing metrics
 * - `model.failed`    — on error, with code + message
 *
 * All telemetry emissions are fail-open: a thrown emit does **not**
 * propagate to the caller.
 */
export function createInstrumentedModelPort(
  inner: ModelPort,
  telemetry: WorkLoopTelemetry,
): ModelPort {
  return {
    async complete(
      context: WorkContext,
      options?: Record<string, unknown>,
    ): Promise<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }> {
      // emit model.requested (fail-open)
      const requestedPayload: Record<string, unknown> = {};
      if (options?.strategyId) {
        requestedPayload.strategyId = options.strategyId;
      }
      safelyEmit(telemetry, "model.requested", requestedPayload);

      const startedAt = Date.now();

      try {
        const result = await inner.complete(context, options);

        const durationMs = Date.now() - startedAt;

        // assemble usage metrics from result.usage if present
        const usage = result.usage;
        const source: "observed" | "derived" =
          usage != null ? "observed" : "derived";

        const metrics: ModelCompletedMetrics = {
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0,
          cacheWrite: usage?.cacheWrite ?? 0,
          cost: usage?.cost ?? 0,
          durationMs,
          source,
        };

        // Annotate usage with source so downstream consumers (e.g.
        // managed-loop usage aggregation) can detect derived estimates
        // without peeking at telemetry metrics.
        if (result.usage) {
          (result.usage as Record<string, unknown>)._source = source;
        }

        safelyEmit(telemetry, "model.completed", {}, metrics);
        return result;
      } catch (err) {
        const code = err instanceof Error ? (err as Error & { code?: string }).code ?? "model-error" : "model-error";
        const message = err instanceof Error ? err.message : String(err);

        safelyEmit(telemetry, "model.failed", { code, message } satisfies ModelFailedPayload);
        throw err;
      }
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function safelyEmit(
  telemetry: WorkLoopTelemetry,
  eventType: string,
  payload: unknown,
  metrics?: Record<string, string | number | boolean | null>,
): void {
  try {
    telemetry.emit(eventType, payload, metrics);
  } catch {
    // Fail-open: instrumentation must not crash the work-loop.
  }
}
