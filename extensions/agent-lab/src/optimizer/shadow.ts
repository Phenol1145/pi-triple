/**
 * Shadow evaluation engine for optimizer proposals.
 *
 * Evaluates a candidate parameter change under a fixed catalog snapshot by
 * scoring against both the current and proposed weight sets, then comparing
 * top-1/top-N rankings and computing expected completion/cost deltas from
 * windowed projector aggregates.
 *
 * ## Locked decisions (Phase 5b adversarial review)
 *
 * - **I1**: Aggregate-level top-1/top-N comparison (not per-run re-ranking).
 * - **I2**: Cost delta sourced from projector `avgCost`, NOT scorer cost dimension.
 * - **Q2**: Shadow result persisted to `proposal.evaluation.shadow` + event emitted.
 *
 * ## Fail-open
 *
 * Shadow errors are caught, annotated in the result, persisted, and an
 * `optimizer.shadow.completed` event is emitted — they are **never** thrown
 * back into the proposal path.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CoreRepository } from "../core/storage/repository.ts";
import type { EventLog } from "../core/events/event-log.ts";
import type { ModelInfo, Aggregate, LabConfig, ScoredModel } from "../types.ts";
import { scoreCandidates } from "../scorer/scorer.ts";
import { getProjector } from "./registry.ts";
import type { ModelAggregate } from "../optimizers/ws-projector.ts";
import { buildLabConfigFromParams, type WeightedScorerParameters } from "../schedulers/weighted-scorer.ts";

// ── Public types ────────────────────────────────────────────────────────────

export interface ShadowDeps {
  repository: CoreRepository;
  events: EventLog;
  db: DatabaseSync;
  /** Called once — the returned snapshot is pinned for both score calls. */
  getCatalogSnapshot: () => ModelInfo[];
  optimizerInstanceId: string;
  schedulerInstanceId: string;
  /** Minimum total runs before shadow can produce an "ok" result (default 20). */
  minSamples?: number;
}

export interface ShadowResult {
  selectionChanged: boolean;
  currentTop: ScoredModel[];
  candidateTop: ScoredModel[];
  expectedCompletionDelta: number;
  expectedCostDelta: number;
  samples: number;
  status: "ok" | "insufficient-data" | "failed";
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_MIN_SAMPLES = 20;

/**
 * Convert windowed projector aggregates to the `Map<string, Aggregate>` shape
 * expected by `scoreCandidates`.
 */
function aggregatesToMap(
  aggs: ModelAggregate[],
  role = "",
): Map<string, Aggregate> {
  const map = new Map<string, Aggregate>();
  for (const a of aggs) {
    map.set(a.model, {
      model: a.model,
      role,
      runs: a.runs,
      avgCompletion: a.avgCompletion,
      avgCost: a.avgCost,
      successRate: a.successRate,
    });
  }
  return map;
}

type EvalData = {
  dataWindow?: { since: number; until: number };
  summary?: string;
  metrics?: Record<string, number>;
};

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * Evaluate a proposal through the shadow engine.
 *
 * 1. Load proposal + candidate round params + current (base) round params.
 * 2. Run windowed projector aggregates (window from `proposal.evaluation.dataWindow`).
 * 3. Fetch catalog snapshot **once** (pinned for both score calls).
 * 4. Score candidates under both the current and candidate weight sets.
 * 5. Compare top-1 ranking → `selectionChanged`.
 * 6. Compute `expectedCompletionDelta` and `expectedCostDelta` from projector `avgCost`.
 * 7. Persist `proposal.evaluation.shadow` + emit `optimizer.shadow.completed`.
 *
 * **Never throws** — errors are caught, annotated in the result, and persisted
 * with status `"failed"`.
 */
export async function evaluateShadow(
  deps: ShadowDeps,
  proposalId: string,
): Promise<ShadowResult> {
  const minSamples = deps.minSamples ?? DEFAULT_MIN_SAMPLES;
  const now = Date.now();

  let result: ShadowResult;
  let candidateRoundId: string | undefined;
  let currentTopModelId: string | null = null;
  let candidateTopModelId: string | null = null;
  let evalData: EvalData | undefined;

  try {
    // ── 1. Load proposal ────────────────────────────────────────────────
    const proposal = deps.repository.getProposal(proposalId);
    if (!proposal) {
      result = failResult(`proposal not found: ${proposalId}`, "failed");
    } else {
      candidateRoundId = proposal.candidateRoundId;
      evalData = proposal.evaluation as EvalData | undefined;

      if (!candidateRoundId) {
        result = failResult(`proposal ${proposalId} has no candidateRoundId`, "failed");
      } else if (!evalData?.dataWindow) {
        result = failResult(
          `proposal ${proposalId} has no evaluation.dataWindow`,
          "failed",
        );
      } else {
        // ── 2. Load rounds ──────────────────────────────────────────────
        const candidateRound = deps.repository.getRound(candidateRoundId);
        const baseRound = deps.repository.getRound(proposal.baseRoundId);

        if (!candidateRound) {
          result = failResult(`candidate round not found: ${candidateRoundId}`, "failed");
        } else if (!baseRound) {
          result = failResult(`base round not found: ${proposal.baseRoundId}`, "failed");
        } else {
          const candidateParams = candidateRound.parameters as WeightedScorerParameters;
          const currentParams = baseRound.parameters as WeightedScorerParameters;

          if (!candidateParams?.weights || !currentParams?.weights) {
            result = failResult(
              "round parameters missing weights (not WeightedScorerParameters)",
              "failed",
            );
          } else {
            // ── 3. Projector aggregates ─────────────────────────────────
            const instance = deps.repository.getInstance(deps.schedulerInstanceId);
            if (!instance) {
              result = failResult(
                `scheduler instance not found: ${deps.schedulerInstanceId}`,
                "failed",
              );
            } else {
              const projector = getProjector(instance.definition.id);
              if (!projector) {
                result = failResult(
                  `no projector registered for "${instance.definition.id}"`,
                  "failed",
                );
              } else {
                const rawAggs = projector(deps.db, evalData.dataWindow, {
                  schedulerInstanceId: deps.schedulerInstanceId,
                });

                if (!Array.isArray(rawAggs)) {
                  result = failResult("projector returned non-array result", "failed");
                } else {
                  const aggregates = rawAggs as ModelAggregate[];
                  const totalRuns = aggregates.reduce((sum, a) => sum + a.runs, 0);
                  const aggsByModel = aggregatesToMap(aggregates);

                  // ── 4. Catalog snapshot (pinned once) — fail-open ────
                  let catalogSnapshot: ModelInfo[];
                  try {
                    catalogSnapshot = deps.getCatalogSnapshot();
                  } catch (err) {
                    result = failResult(`catalog snapshot failed: ${fmtErr(err)}`, "failed");
                    finishAndPersist();
                    return result;
                  }

                  if (!Array.isArray(catalogSnapshot) || catalogSnapshot.length === 0) {
                    result = failResult("catalog snapshot is empty", "failed");
                    finishAndPersist();
                    return result;
                  }

                  // ── 5. Score under both weight sets ──────────────────
                  let scoredCurrent: ScoredModel[];
                  let scoredCandidate: ScoredModel[];
                  try {
                    const currentCfg = buildLabConfigFromParams(currentParams);
                    const candidateCfg = buildLabConfigFromParams(candidateParams);

                    scoredCurrent = scoreCandidates(catalogSnapshot, aggsByModel, currentCfg)
                      .sort((a, b) => b.score - a.score);
                    scoredCandidate = scoreCandidates(catalogSnapshot, aggsByModel, candidateCfg)
                      .sort((a, b) => b.score - a.score);
                  } catch (err) {
                    result = failResult(`scoring failed: ${fmtErr(err)}`, "failed");
                    finishAndPersist();
                    return result;
                  }

                  // ── 6. Compare top-1 ─────────────────────────────────
                  const currentTop = scoredCurrent.slice(0, currentParams.topN);
                  const candidateTop = scoredCandidate.slice(0, candidateParams.topN);

                  const curTop = currentTop[0];
                  const candTop = candidateTop[0];

                  const selectionChanged =
                    curTop?.model.id !== candTop?.model.id;

                  currentTopModelId = curTop?.model.id ?? null;
                  candidateTopModelId = candTop?.model.id ?? null;

                  // ── 7. Compute deltas from projector aggregates (I2) ─
                  const curAgg = curTop
                    ? aggregates.find((a) => a.model === curTop.model.id)
                    : undefined;
                  const candAgg = candTop
                    ? aggregates.find((a) => a.model === candTop.model.id)
                    : undefined;

                  const expectedCompletionDelta =
                    (candAgg?.avgCompletion ?? 0) - (curAgg?.avgCompletion ?? 0);
                  const expectedCostDelta =
                    (candAgg?.avgCost ?? 0) - (curAgg?.avgCost ?? 0);

                  // ── 8. Determine status ──────────────────────────────
                  const status: ShadowResult["status"] =
                    totalRuns < minSamples ? "insufficient-data" : "ok";

                  result = {
                    selectionChanged,
                    currentTop,
                    candidateTop,
                    expectedCompletionDelta,
                    expectedCostDelta,
                    samples: totalRuns,
                    status,
                  };
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    // Top-level safety net: any unexpected error
    result = failResult(`unexpected error: ${fmtErr(err)}`, "failed");
  }

  // ── Persist + emit (always, for all paths) ────────────────────────────
  finishAndPersist();

  return result;

  // ── Local helper: persist shadow + emit event ──────────────────────────
  function finishAndPersist(): void {
    const shadowSegment = {
      status: result!.status,
      selectionChanged: result!.selectionChanged,
      currentTop: result!.currentTop.map((s) => s.model.id),
      candidateTop: result!.candidateTop.map((s) => s.model.id),
      expectedCompletionDelta: result!.expectedCompletionDelta,
      expectedCostDelta: result!.expectedCostDelta,
      samples: result!.samples,
      evaluatedAt: now,
      ...(result!.error ? { error: result!.error } : {}),
    };

    // Persist
    try {
      const updatedEval = {
        ...(evalData ?? {}),
        shadow: shadowSegment,
      };
      deps.repository.updateProposalEvaluation(proposalId, updatedEval);
    } catch (err) {
      if (result!.status !== "failed") {
        result!.status = "failed";
        result!.error = `persist failed: ${fmtErr(err)}`;
      }
    }

    // Emit event
    try {
      deps.events.append({
        eventId: `optimizer.shadow.completed:${proposalId}:${now}`,
        eventType: "optimizer.shadow.completed",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `optimizer:${deps.optimizerInstanceId}`,
          optimizerInstanceId: deps.optimizerInstanceId,
          schedulerInstanceId: deps.schedulerInstanceId,
        },
        payload: {
          proposalId,
          candidateRoundId: candidateRoundId ?? null,
          status: result!.status,
          selectionChanged: result!.selectionChanged,
          currentTopModel: currentTopModelId,
          candidateTopModel: candidateTopModelId,
          expectedCompletionDelta: result!.expectedCompletionDelta,
          expectedCostDelta: result!.expectedCostDelta,
          samples: result!.samples,
          minSamples,
        },
      });
    } catch {
      // best-effort event emission
    }
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function failResult(
  error: string,
  status: ShadowResult["status"],
): ShadowResult {
  return {
    selectionChanged: false,
    currentTop: [],
    candidateTop: [],
    expectedCompletionDelta: 0,
    expectedCostDelta: 0,
    samples: 0,
    status,
    error,
  };
}

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
