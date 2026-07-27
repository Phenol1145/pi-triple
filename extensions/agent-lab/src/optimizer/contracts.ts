import type { LabEvent, OptimizationRoundRecord, OptimizerDefinition } from "../core/contracts.ts";

// ── Optimizer contracts ─────────────────────────────────────────────────────

/**
 * A parameter change proposed by an optimizer after evaluating runtime data.
 *
 * `parameters` carries the **full** parameter set, not a diff/patch.
 * `evaluation` is optional — set when the optimizer ran a data-driven
 * assessment (window, metrics) that motivated the proposal.
 */
export interface ParameterProposal {
  /** Round that was current when the optimizer evaluated data. */
  baseRoundId: string;
  /** Complete parameter set (not a partial patch). */
  parameters: unknown;
  /** Data-driven evaluation that motivated the proposal. */
  evaluation?: {
    summary: string;
    metrics: Record<string, number>;
    dataWindow: { since: number; until: number };
  };
  /** Arbitrary optimizer-specific metadata. */
  metadata?: Record<string, string>;
}

/**
 * Outcome of a single optimizer evaluation.
 *
 * - `proposal` — the optimizer recommends a parameter change.
 * - `skip`     — the optimizer has nothing to propose this cycle.
 */
export type OptimizeResult =
  | { kind: "proposal"; proposal: ParameterProposal }
  | { kind: "skip"; reason: string };

// ── Data API (read-only facade) ─────────────────────────────────────────────

/**
 * Read-only facade that an optimizer uses to inspect runtime data.
 *
 * Every method is **authorized per scheduler instance**: only IDs listed in
 * the optimizer instance's `targetSchedulers` are accessible.  Accessing
 * another instance throws {@link DataAccessDeniedError} and emits an
 * `optimizer.access.denied` event.
 */
export interface OptimizationDataAPI {
  /** Get the current (active) round for a scheduler instance. */
  getCurrentRound(schedulerInstanceId: string): OptimizationRoundRecord | undefined;

  /** List recent rounds for a scheduler instance (newest first). */
  listRounds(schedulerInstanceId: string, limit?: number): OptimizationRoundRecord[];

  /** Query events scoped to a scheduler instance. */
  listEvents(filter: {
    schedulerInstanceId: string;
    types?: string[];
    since?: number;
    until?: number;
    limit?: number;
  }): LabEvent[];

  /**
   * Compute per-model aggregates for a scheduler instance within a time window.
   *
   * Delegates to a registered {@link MetricsProjector} for the instance's
   * scheduler definition.  Passes through an optional `role` filter.
   *
   * @throws {@link ProjectorNotRegisteredError} if no projector is registered
   *         for the scheduler definition backing this instance.
   */
  getCandidateAggregates(
    schedulerInstanceId: string,
    window: { since: number; until: number },
    role?: string,
  ): unknown;
}

// ── Optimize context ────────────────────────────────────────────────────────

/**
 * Context passed to an optimizer's {@link OptimizerInstance.optimize} method.
 *
 * Includes a read-only data API (scoped to the instance's target schedulers),
 * a clock, and an optional abort signal for cancellation.
 */
export interface OptimizeContext {
  /** Read-only facade for querying rounds, events, and aggregates. */
  data: OptimizationDataAPI;
  /** The scheduler instance being optimized (set by the caller). */
  schedulerInstanceId: string;
  /** Monotonic clock (milliseconds since epoch). */
  now(): number;
  /** Optional abort signal for cooperative cancellation. */
  signal?: AbortSignal;
}

// ── Optimizer instance (runtime) ────────────────────────────────────────────

/**
 * A ready-to-run optimizer instance.
 *
 * Implementations are returned by optimizer factories registered via
 * {@link OptimizerRegistry.createOptimizerInstance}.
 */
export interface OptimizerInstance {
  /** The optimizer definition this instance was created from. */
  definition: OptimizerDefinition;
  /** Unique instance identifier (stable across restarts). */
  instanceId: string;
  /** Resolved configuration (validated against definition.configurationSchema). */
  config: unknown;
  /**
   * Evaluate runtime data and return a proposal or skip.
   *
   * Throwing is treated as a run failure — the caller records
   * `optimizer.run.failed` and the current round stays unchanged.
   */
  optimize(ctx: OptimizeContext): Promise<OptimizeResult>;
}

// ── Metrics projector ──────────────────────────────────────────────────────

/**
 * A projector computes per-model aggregate metrics from raw runtime data
 * within a given time window.
 *
 * Registered per scheduler definition id via {@link registerMetricsProjector}.
 */
export type MetricsProjector = (
  db: import("node:sqlite").DatabaseSync,
  window: { since: number; until: number },
  opts: { schedulerInstanceId: string; role?: string },
) => unknown;
