/**
 * Canary attribution evaluation + auto-rollback policy.
 *
 * ## Attribution
 *
 * 1. Find the canary round + its `createdAt` (activation time).
 * 2. SELECT runs WHERE `ts >= activation` AND `trace_id IS NOT NULL`.
 * 3. For each run's `trace_id`, query EventLog → extract
 *    `identity.optimizationRoundId` from matching events.
 * 4. Bucket each run:
 *    - **canary**   → `roundId === canaryRoundId`
 *    - **control**  → `roundId === currentRoundId` (active non-canary)
 *    - **other**    → everything else
 * 5. Runs with NULL `trace_id` are excluded from attribution but counted
 *    as `excludedNullTrace`.
 *
 * ## Auto-rollback policy (locked I5)
 *
 * Pure decision function `decideCanaryAction`:
 *   hold     — not enough samples OR degradation ≤ ε (with absolute floor)
 *   rollback — canaryAgg.runs ≥ minSamples AND
 *              (completion degradation > ε_completion, floored at max(ε, 0.02)
 *               OR cost degradation > ε_cost, floored at max(ε, 0.02))
 *
 * ## Locked decisions
 *
 * - **L4**: `runs.trace_id → EventLog.query(traceId) → identity.optimizationRoundId`
 * - **L6**: Auto-rollback = clearCanary + candidate round → rolled-back,
 *           NOT rollbackRound; new ControlPlane method abortCanary.
 * - **L7**: supersede discipline (linked pending proposal → superseded + event).
 * - **I5**: minSamples + ε with absolute floor.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CoreRepository } from "../core/storage/repository.ts";
import type { EventLog } from "../core/events/event-log.ts";
import type { OptimizerConfig } from "../types.ts";

// ── Public types ────────────────────────────────────────────────────────────

export interface CanaryBucket {
  runs: number;
  avgCompletion: number;
  avgCost: number;
  successRate: number;
}

export interface CanaryEvalResult {
  canary: CanaryBucket;
  control: CanaryBucket;
  other: CanaryBucket;
  /** Number of runs in the window that had NULL trace_id and were excluded. */
  excludedNullTrace: number;
  canaryRoundId: string;
  controlRoundId: string;
}

export type CanaryAction = "hold" | "rollback";

export interface CanaryEvalDeps {
  repository: CoreRepository;
  events: EventLog;
  db: DatabaseSync;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_EPSILON = 0.02;
const DEFAULT_MIN_SAMPLES = 30;

// ── Attribution ─────────────────────────────────────────────────────────────

/**
 * Evaluate canary attribution for a scheduler instance.
 *
 * Reads instance → canaryRoundId + canary activation time (canary round
 * createdAt) → SQL over runs WHERE ts >= activation AND trace_id IS NOT
 * NULL → join via EventLog.query({traceId}) → bucket each run by
 * identity.optimizationRoundId.
 *
 * Returns per-bucket aggregates plus excluded-null-trace count.
 */
export function evaluateCanary(
  deps: CanaryEvalDeps,
  schedulerInstanceId: string,
): CanaryEvalResult {
  // ── 1. Read instance + canary round ────────────────────────────────
  const instance = deps.repository.getInstance(schedulerInstanceId);
  if (!instance) {
    throw new Error(`scheduler instance not found: ${schedulerInstanceId}`);
  }

  const canaryRoundId = instance.canaryRoundId;
  if (!canaryRoundId) {
    throw new Error(`no canary round set on instance: ${schedulerInstanceId}`);
  }

  const canaryRound = deps.repository.getRound(canaryRoundId);
  if (!canaryRound) {
    throw new Error(`canary round not found: ${canaryRoundId}`);
  }

  const controlRoundId = instance.currentRoundId;
  const controlRound = deps.repository.getRound(controlRoundId);
  if (!controlRound) {
    throw new Error(`control (current) round not found: ${controlRoundId}`);
  }

  const activationTs = canaryRound.createdAt;
  const now = Date.now();

  // ── 2. Query runs in window ────────────────────────────────────────
  const runRows = deps.db.prepare(
    `SELECT trace_id, completion, cost, tool_success
     FROM runs
     WHERE ts >= ? AND ts < ?
       AND trace_id IS NOT NULL`,
  ).all(activationTs, now) as Array<{
    trace_id: string;
    completion: number;
    cost: number | null;
    tool_success: number | null;
  }>;

  // ── 3. Count NULL-trace runs (excluded) ────────────────────────────
  const nullTraceRow = deps.db.prepare(
    `SELECT COUNT(*) as cnt
     FROM runs
     WHERE ts >= ? AND ts < ?
       AND trace_id IS NULL`,
  ).get(activationTs, now) as { cnt: number } | undefined;
  const excludedNullTrace = nullTraceRow?.cnt ?? 0;

  // ── 4. Bucket runs by optimizationRoundId ─────────────────────────
  const canaryValues: Array<{ completion: number; cost: number; success: number }> = [];
  const controlValues: Array<{ completion: number; cost: number; success: number }> = [];
  const otherValues: Array<{ completion: number; cost: number; success: number }> = [];

  for (const run of runRows) {
    const events = deps.events.query({ traceId: run.trace_id, limit: 1 });
    const roundId = events[0]?.identity?.optimizationRoundId ?? undefined;

    const comp = run.completion;
    const cost = run.cost ?? 0;
    const success = run.tool_success ?? 1.0;

    if (roundId === canaryRoundId) {
      canaryValues.push({ completion: comp, cost, success });
    } else if (roundId === controlRoundId) {
      controlValues.push({ completion: comp, cost, success });
    } else {
      otherValues.push({ completion: comp, cost, success });
    }
  }

  // ── 5. Compute aggregates ──────────────────────────────────────────
  const toBucket = (vals: typeof canaryValues): CanaryBucket => {
    const runs = vals.length;
    if (runs === 0) {
      return { runs: 0, avgCompletion: 0, avgCost: 0, successRate: 0 };
    }
    const sumCompletion = vals.reduce((s, v) => s + v.completion, 0);
    const sumCost = vals.reduce((s, v) => s + v.cost, 0);
    const sumSuccess = vals.reduce((s, v) => s + v.success, 0);
    return {
      runs,
      avgCompletion: sumCompletion / runs,
      avgCost: sumCost / runs,
      successRate: sumSuccess / runs,
    };
  };

  return {
    canary: toBucket(canaryValues),
    control: toBucket(controlValues),
    other: toBucket(otherValues),
    excludedNullTrace,
    canaryRoundId,
    controlRoundId,
  };
}

// ── Decision ────────────────────────────────────────────────────────────────

/**
 * Pure decision function for canary auto-rollback.
 *
 * Returns `"rollback"` when ALL of:
 *   - `config.enabled` is true
 *   - canaryAgg.runs >= minSamples
 *   - completion degradation > ε (floored) OR cost degradation > ε (floored)
 *
 * Otherwise returns `"hold"`.
 *
 * Degradation is computed as:
 *   - completion degradation = control.avgCompletion - canary.avgCompletion
 *     (positive = canary is worse)
 *   - cost degradation = canary.avgCost - control.avgCost
 *     (positive = canary is more expensive)
 *
 * Each ε is floored at `max(ε, 0.02)` per locked I5.
 */
export function decideCanaryAction(
  autoRollback: OptimizerConfig["autoRollback"],
  canaryAgg: CanaryBucket,
  controlAgg: CanaryBucket,
): CanaryAction {
  if (!autoRollback?.enabled) return "hold";

  const minSamples = autoRollback.minSamples ?? DEFAULT_MIN_SAMPLES;
  const epsCompletion = Math.max(
    autoRollback.epsilonCompletion ?? DEFAULT_EPSILON,
    DEFAULT_EPSILON,
  );
  const epsCost = Math.max(
    autoRollback.epsilonCost ?? DEFAULT_EPSILON,
    DEFAULT_EPSILON,
  );

  if (canaryAgg.runs < minSamples) return "hold";

  const completionDegradation =
    controlAgg.avgCompletion - canaryAgg.avgCompletion;
  const costDegradation = canaryAgg.avgCost - controlAgg.avgCost;

  if (completionDegradation > epsCompletion) return "rollback";
  if (costDegradation > epsCost) return "rollback";

  return "hold";
}
