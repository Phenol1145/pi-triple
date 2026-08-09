import { WEIGHTED_SCORER_DEFINITION_ID, WEIGHTED_TUNER_OPTIMIZER_ID } from "../schedulers/names.ts";

/**
 * Reference optimizer: weighted-tuner@1.0.0
 *
 * Adjusts `weights.completion` and `weights.costEffectiveness` of the
 * weighted-scorer scheduler based on windowed runtime data.  Never touches
 * `weights.performance` or `weights.benchmark` — those are static catalog
 * data and not derivable from runtime metrics.
 *
 * ## Algorithm (decide)
 *
 * Given per-model aggregates within a time window, the tuner identifies the
 * most-selected model (highest `runs` count) and compares its metrics to the
 * pool average:
 *
 * - **Quality rule**: if mostSelected.successRate < poolMeanSuccess × (1 − margin)
 *   → `weights.completion += step` (clamped to [0, 1])
 * - **Cost rule**: if mostSelected.avgCost > poolMeanCost × (1 + margin)
 *   → `weights.costEffectiveness += step` (clamped to [0, 1])
 *
 * Both rules can fire simultaneously.  If neither fires, the tuner skips.
 * If total runs across all models is below `minSamples`, the tuner skips
 * with reason `"insufficient-data"`.
 *
 * ## Weight bounds
 *
 * The weighted-scorer schema enforces `weights.* >= 0` with no upper bound.
 * This tuner adds a practical upper bound of **1.0** to prevent unbounded
 * drift across many optimization rounds.  The clamp range is therefore
 * `[0, 1]` for both `completion` and `costEffectiveness`.
 *
 * ## Data window (M15)
 *
 * The evaluation window is `[currentRound.createdAt, ctx.now()]` — i.e. all
 * runs recorded since the current round became active.  On the very first
 * round, `createdAt` equals the instance creation time, so the window covers
 * all runs since bootstrap.  Zero-traffic installations will permanently
 * skip with `"insufficient-data"`, which is correct conservative behavior.
 */

import type { OptimizerDefinition } from "../core/contracts.ts";
import type {
  OptimizeContext,
  OptimizeResult,
  OptimizerInstance,
} from "../optimizer/contracts.ts";
import type {
  WeightedScorerWeights,
  WeightedScorerParameters,
} from "../schedulers/weighted-scorer.ts";
import type { ModelAggregate } from "./ws-projector.ts";

// ── Config ──────────────────────────────────────────────────────────────────

export interface WeightedTunerConfig {
  /** Minimum total runs across all models before the tuner activates (default 20). */
  minSamples?: number;
  /** Adjustment step size for weight increments (default 0.05). */
  step?: number;
  /** Relative margin for rule activation (default 0.1 = 10%). */
  margin?: number;
}

const DEFAULTS: Required<WeightedTunerConfig> = {
  minSamples: 20,
  step: 0.05,
  margin: 0.1,
};

function resolveConfig(raw: unknown): Required<WeightedTunerConfig> {
  const cfg = (raw ?? {}) as WeightedTunerConfig;
  return {
    minSamples: typeof cfg.minSamples === "number" ? cfg.minSamples : DEFAULTS.minSamples,
    step: typeof cfg.step === "number" ? cfg.step : DEFAULTS.step,
    margin: typeof cfg.margin === "number" ? cfg.margin : DEFAULTS.margin,
  };
}

// ── Definition ──────────────────────────────────────────────────────────────

export const weightedTunerDefinition: OptimizerDefinition = {
  kind: "optimizer",
  id: WEIGHTED_TUNER_OPTIMIZER_ID,
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configurationSchema: {
    type: "object",
    properties: {
      minSamples: { type: "number" },
      step: { type: "number" },
      margin: { type: "number" },
    },
  },
  requiredMetrics: ["runs", "avgCompletion", "avgCost", "successRate"],
  compatibleSchedulers: [
    { id: WEIGHTED_SCORER_DEFINITION_ID, versionRange: "^1.0.0" },
  ],
  parameterModelVersionRange: "1.0.0",
};

// ── decide (pure function) ──────────────────────────────────────────────────

export interface DecideResult {
  /** New weights after applying adjustments. */
  weights: WeightedScorerWeights;
  /** Human-readable summary of what changed. */
  summary: string;
  /** Observed metrics that motivated the adjustments. */
  metrics: Record<string, number>;
}

/**
 * Evaluate per-model aggregates and return adjusted weights, or null if no
 * actionable signal was found.
 *
 * This is a pure function — it does not access the database or any external
 * state.  It can be unit-tested independently.
 *
 * @param aggregates  Per-model aggregates from the windowed SQL projector.
 * @param currentWeights  The current weights to adjust.
 * @param cfg  Resolved tuner configuration.
 * @returns Adjusted weights + evaluation metadata, or null on skip.
 */
export function decide(
  aggregates: ModelAggregate[],
  currentWeights: WeightedScorerWeights,
  cfg: Required<WeightedTunerConfig>,
): DecideResult | null {
  // ── Guard: insufficient data ──────────────────────────────────────────
  const totalRuns = aggregates.reduce((sum, a) => sum + a.runs, 0);
  if (totalRuns < cfg.minSamples) {
    return null;
  }

  // ── Identify most-selected model ──────────────────────────────────────
  if (aggregates.length === 0) {
    return null;
  }

  let mostSelected = aggregates[0];
  for (let i = 1; i < aggregates.length; i++) {
    if (aggregates[i].runs > mostSelected.runs) {
      mostSelected = aggregates[i];
    }
  }

  // ── Compute pool means (weighted by runs) ─────────────────────────────
  const poolMeanSuccess =
    aggregates.reduce((sum, a) => sum + a.successRate * a.runs, 0) / totalRuns;
  const poolMeanCost =
    aggregates.reduce((sum, a) => sum + a.avgCost * a.runs, 0) / totalRuns;

  // ── Apply rules ───────────────────────────────────────────────────────
  const newWeights = { ...currentWeights };
  const triggers: string[] = [];

  // Quality rule: mostSelected successRate significantly below pool mean
  if (mostSelected.successRate < poolMeanSuccess * (1 - cfg.margin)) {
    newWeights.completion = clamp(newWeights.completion + cfg.step, 0, 1);
    triggers.push("completion");
  }

  // Cost rule: mostSelected avgCost significantly above pool mean
  if (mostSelected.avgCost > poolMeanCost * (1 + cfg.margin)) {
    newWeights.costEffectiveness = clamp(
      newWeights.costEffectiveness + cfg.step,
      0,
      1,
    );
    triggers.push("costEffectiveness");
  }

  // ── No signal ─────────────────────────────────────────────────────────
  if (triggers.length === 0) {
    return null;
  }

  // ── Build evaluation ──────────────────────────────────────────────────
  return {
    weights: newWeights,
    summary:
      `Adjusted ${triggers.join(" + ")}: ` +
      `mostSelected=${mostSelected.model} ` +
      `(runs=${mostSelected.runs}, successRate=${mostSelected.successRate.toFixed(3)}, ` +
      `avgCost=${mostSelected.avgCost.toFixed(4)}) ` +
      `vs pool (successRate=${poolMeanSuccess.toFixed(3)}, avgCost=${poolMeanCost.toFixed(4)})`,
    metrics: {
      totalRuns,
      mostSelectedRuns: mostSelected.runs,
      mostSelectedSuccessRate: mostSelected.successRate,
      mostSelectedAvgCost: mostSelected.avgCost,
      poolMeanSuccess,
      poolMeanCost,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Instance factory ────────────────────────────────────────────────────────

/**
 * Create a ready-to-run weighted-tuner optimizer instance.
 *
 * The returned object satisfies {@link OptimizerInstance} and can be used
 * directly with the ControlPlane's submitProposal flow.
 */
export function createWeightedTunerInstance(
  definition: OptimizerDefinition,
  instanceId: string,
  config: unknown,
): OptimizerInstance {
  const resolvedCfg = resolveConfig(config);

  return {
    definition,
    instanceId,
    config: resolvedCfg,

    async optimize(ctx: OptimizeContext): Promise<OptimizeResult> {
      // ── 1. Get current round ──────────────────────────────────────────
      // The data API is scoped to the instance's targetSchedulers.
      // We use the first (and typically only) target scheduler instance.
      // In practice the ControlPlane passes the specific schedulerInstanceId
      // via the context; for the reference tuner we assume a single target.
      // We need to discover the schedulerInstanceId — the tuner is bound
      // to one or more targets at instance creation time.
      //
      // The DataAPI checkAccess already validates that the caller is
      // authorized.  For simplicity, the reference tuner operates on the
      // first target.  Multi-target instances would need a different
      // contract (P5b+).

      const sid = ctx.schedulerInstanceId;
      if (!sid) {
        throw new Error(
          "weighted-tuner: optimize() requires schedulerInstanceId in context",
        );
      }

      // ── 2. Get current round and its parameters ───────────────────────
      const currentRound = ctx.data.getCurrentRound(sid);
      if (!currentRound) {
        return {
          kind: "skip",
          reason: `no current round for scheduler instance "${sid}"`,
        };
      }

      const currentParams = currentRound.parameters as WeightedScorerParameters;
      if (
        !currentParams ||
        typeof currentParams !== "object" ||
        !currentParams.weights
      ) {
        return {
          kind: "skip",
          reason: "current round has no recognizable weighted-scorer parameters",
        };
      }

      // ── 3. Define evaluation window ───────────────────────────────────
      const now = ctx.now();
      const window = {
        since: currentRound.createdAt,
        until: now,
      };

      // ── 4. Get aggregates ─────────────────────────────────────────────
      const aggregates = (await ctx.data.getCandidateAggregates(
        sid,
        window,
      )) as ModelAggregate[];

      if (!Array.isArray(aggregates)) {
        return {
          kind: "skip",
          reason:
            "projector returned non-array aggregates (projector may not be registered)",
        };
      }

      // ── 5. Decide ─────────────────────────────────────────────────────
      const result = decide(aggregates, currentParams.weights, resolvedCfg);

      if (!result) {
        // Distinguish between insufficient-data and no-actionable-signal
        const totalRuns = aggregates.reduce((sum, a) => sum + a.runs, 0);
        const reason =
          totalRuns < resolvedCfg.minSamples
            ? "insufficient-data"
            : "no-actionable-signal";
        return { kind: "skip", reason };
      }

      // ── 6. Build full parameter set (deep copy + adjustments) ─────────
      const newParams: WeightedScorerParameters = {
        ...deepClone(currentParams),
        weights: result.weights,
      };

      // ── 7. Return proposal ────────────────────────────────────────────
      return {
        kind: "proposal",
        proposal: {
          baseRoundId: currentRound.id,
          parameters: newParams,
          evaluation: {
            summary: result.summary,
            metrics: result.metrics,
            dataWindow: { since: window.since, until: window.until },
          },
        },
      };
    },
  };
}
