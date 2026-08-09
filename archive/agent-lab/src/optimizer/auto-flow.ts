/**
 * Automatic validation → canary → promote orchestration (Phase 5b T8).
 *
 * ## Locked decisions
 *
 * - **L6**: Rejection / errors → benign events only, NO retry loop.
 * - **C1**: `promoteRound` gate already accepts `{proposed, validated, canary}`.
 * - **M4**: Single-target assumption — `tick()` operates on one scheduler
 *   instance at a time.  Multi-target orchestration is the caller's
 *   responsibility.
 * - **M6**: Event IDs use unique suffixed ids (`:instanceId:timestamp`).
 *
 * ## Default-off
 *
 * With default config (`shadow.enabled=false`, `canaryPercent=0`,
 * `autoPromote.enabled=false`, `autoRollback.enabled=false`) `tick()` is a
 * pure no-op.
 *
 * ## Concurrency safety
 *
 * `promoteRound` / `abortCanary` are synchronous self-revalidating gates.
 * A racing manual promote between evaluation and auto-promote will cause the
 * auto call to throw → caught → benign `optimizer.auto.promote-failed`
 * event.  No data corruption.
 */

import type { CoreRepository } from "../core/storage/repository.ts";
import type { EventLog } from "../core/events/event-log.ts";
import type { ControlPlane } from "../core/control-plane/service.ts";
import type { OptimizerConfig } from "../types.ts";
import type { ShadowResult } from "./shadow.ts";
import type { CanaryEvalResult, CanaryAction, CanaryBucket } from "./canary-eval.ts";

// ── Public types ────────────────────────────────────────────────────────────

export interface AutoFlowDeps {
  repository: CoreRepository;
  events: EventLog;
  controlPlane: ControlPlane;
  config: OptimizerConfig;
  /** Shadow evaluation (from shadow.ts). */
  evaluateShadow: (proposalId: string) => Promise<ShadowResult>;
  /** Canary attribution evaluation (from canary-eval.ts). */
  evaluateCanary: (schedulerInstanceId: string) => CanaryEvalResult;
  /** Pure canary-action decision function (from canary-eval.ts). */
  decideCanaryAction: (
    autoRollback: OptimizerConfig["autoRollback"],
    canaryAgg: CanaryBucket,
    controlAgg: CanaryBucket,
  ) => CanaryAction;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
}

export interface AutoFlow {
  /**
   * Run one orchestration tick for the given scheduler instance.
   *
   * Never throws — all errors are caught and emitted as
   * `optimizer.auto.failed` events.
   */
  tick(schedulerInstanceId: string): Promise<void>;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_EPSILON = 0.02;

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an auto-flow orchestrator.
 *
 * The returned `tick()` method is the single entry point.  Each tick
 * executes the full state-machine orchestration:
 *
 * ```
 * proposed → (shadow) → validated → (canary start) → canary → promote / rollback
 * ```
 *
 * Every step is guarded by config flags — with default config this is a
 * pure no-op.
 */
export function createAutoFlow(deps: AutoFlowDeps): AutoFlow {
  return {
    async tick(schedulerInstanceId: string): Promise<void> {
      try {
        await doTick(deps, schedulerInstanceId);
      } catch (err) {
        const now = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger?.warn?.(`auto-flow tick failed: ${msg}`);
        try {
          deps.events.append({
            eventId: `optimizer.auto.failed:${schedulerInstanceId}:${now}`,
            eventType: "optimizer.auto.failed",
            schemaVersion: "1",
            timestamp: now,
            identity: {
              traceId: `auto-flow:${schedulerInstanceId}`,
              schedulerInstanceId,
            },
            payload: { error: msg },
          });
        } catch {
          // best-effort event emission
        }
      }
    },
  };
}

// ── Internal orchestration ─────────────────────────────────────────────────

async function doTick(
  deps: AutoFlowDeps,
  schedulerInstanceId: string,
): Promise<void> {
  const now = Date.now();

  // ═══════════════════════════════════════════════════════════════════
  // Step 1 — Shadow evaluation
  // ═══════════════════════════════════════════════════════════════════
  if (deps.config.shadow?.enabled) {
    const proposals = deps.repository.listProposals(schedulerInstanceId);
    const pendingProposal = proposals.find(
      (p) => p.status === "pending" && p.candidateRoundId,
    );

    if (pendingProposal?.candidateRoundId) {
      const round = deps.repository.getRound(pendingProposal.candidateRoundId);
      if (round?.status === "proposed") {
        try {
          const shadowResult = await deps.evaluateShadow(pendingProposal.id);

          // If shadow says ok → markRoundValidated (benign on race)
          if (shadowResult.status === "ok") {
            try {
              deps.controlPlane.markRoundValidated(
                pendingProposal.candidateRoundId,
              );
            } catch (markErr) {
              // Racing manual promote/validate → benign, no retry
              const msg =
                markErr instanceof Error ? markErr.message : String(markErr);
              deps.logger?.warn?.(
                `auto-flow markRoundValidated failed (race): ${msg}`,
              );
              try {
                deps.events.append({
                  eventId: `optimizer.auto.mark-validated-failed:${schedulerInstanceId}:${now}`,
                  eventType: "optimizer.auto.mark-validated-failed",
                  schemaVersion: "1",
                  timestamp: now,
                  identity: {
                    traceId: `auto-flow:${schedulerInstanceId}`,
                    schedulerInstanceId,
                  },
                  payload: {
                    candidateRoundId: pendingProposal.candidateRoundId,
                    reason: msg,
                  },
                });
              } catch {
                // best-effort
              }
            }
          }
        } catch (shadowErr) {
          // evaluateShadow should never throw, but safety net
          const msg =
            shadowErr instanceof Error ? shadowErr.message : String(shadowErr);
          deps.logger?.warn?.(`auto-flow shadow eval failed: ${msg}`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Step 2 — Start canary (if auto-canary enabled)
  // ═══════════════════════════════════════════════════════════════════
  const canaryPercent = Math.max(0, Math.min(100, deps.config.canaryPercent ?? 0));
  if (canaryPercent > 0) {
    const instance = deps.repository.getInstance(schedulerInstanceId);
    if (instance && !instance.canaryRoundId) {
      // Find a validated candidate round
      const rounds = deps.repository.listRounds(schedulerInstanceId);
      const validatedRound = rounds.find(
        (r) => r.status === "validated",
      );

      if (validatedRound) {
        try {
          deps.repository.setCanaryRound(
            schedulerInstanceId,
            validatedRound.id,
            canaryPercent,
          );

          // Transition round status to canary (coherence: downstream gates check status)
          deps.repository.updateRoundStatus(validatedRound.id, "canary");

          deps.events.append({
            eventId: `optimizer.auto.canary-started:${schedulerInstanceId}:${now}`,
            eventType: "optimizer.auto.canary-started",
            schemaVersion: "1",
            timestamp: now,
            identity: {
              traceId: `auto-flow:${schedulerInstanceId}`,
              schedulerInstanceId,
              optimizationRoundId: validatedRound.id,
            },
            payload: {
              roundId: validatedRound.id,
              canaryPercent,
            },
          });

          deps.logger?.info?.(
            `auto-flow: canary started on round ${validatedRound.id} at ${canaryPercent}%`,
          );
        } catch (setErr) {
          const msg =
            setErr instanceof Error ? setErr.message : String(setErr);
          deps.logger?.warn?.(`auto-flow setCanaryRound failed: ${msg}`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Step 3 — Evaluate canary + auto-actions (promote / rollback)
  // ═══════════════════════════════════════════════════════════════════
  // Re-read instance (may have changed after step 2)
  const canaryInstance = deps.repository.getInstance(schedulerInstanceId);
  if (!canaryInstance?.canaryRoundId) {
    return; // No canary to evaluate → no-op
  }

  let evalResult: CanaryEvalResult;
  try {
    evalResult = deps.evaluateCanary(schedulerInstanceId);
  } catch (evalErr) {
    const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
    deps.logger?.warn?.(`auto-flow canary eval failed: ${msg}`);
    // Benign — no retry per L6
    return;
  }

  const action = deps.decideCanaryAction(
    deps.config.autoRollback,
    evalResult.canary,
    evalResult.control,
  );

  if (action === "rollback") {
    // ── Auto-rollback ──────────────────────────────────────────────
    if (!deps.config.autoRollback?.enabled) {
      return; // rollback suggested but not enabled
    }

    try {
      deps.controlPlane.abortCanary(schedulerInstanceId, {
        reason: "auto-rollback: canary degradation detected",
        actor: "auto",
      });

      deps.events.append({
        eventId: `optimizer.auto.rollback:${schedulerInstanceId}:${now}`,
        eventType: "optimizer.auto.rollback",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `auto-flow:${schedulerInstanceId}`,
          schedulerInstanceId,
          optimizationRoundId: canaryInstance.canaryRoundId,
        },
        payload: {
          roundId: canaryInstance.canaryRoundId,
          canaryRuns: evalResult.canary.runs,
          controlRuns: evalResult.control.runs,
          canaryAvgCompletion: evalResult.canary.avgCompletion,
          controlAvgCompletion: evalResult.control.avgCompletion,
          canaryAvgCost: evalResult.canary.avgCost,
          controlAvgCost: evalResult.control.avgCost,
        },
      });

      deps.logger?.info?.(
        `auto-flow: auto-rollback on round ${canaryInstance.canaryRoundId}`,
      );
    } catch (abortErr) {
      // Racing manual abort or promote → benign, no retry
      const msg =
        abortErr instanceof Error ? abortErr.message : String(abortErr);
      deps.logger?.warn?.(`auto-flow abortCanary failed (race): ${msg}`);
      try {
        deps.events.append({
          eventId: `optimizer.auto.rollback-failed:${schedulerInstanceId}:${now}`,
          eventType: "optimizer.auto.rollback-failed",
          schemaVersion: "1",
          timestamp: now,
          identity: {
            traceId: `auto-flow:${schedulerInstanceId}`,
            schedulerInstanceId,
          },
          payload: {
            roundId: canaryInstance.canaryRoundId,
            reason: msg,
          },
        });
      } catch {
        // best-effort
      }
    }
  } else {
    // ── Auto-promote (action = "hold") ────────────────────────────
    if (!deps.config.autoPromote?.enabled) return;

    const minSamples = deps.config.autoPromote.minSamples ?? DEFAULT_MIN_SAMPLES;
    if (evalResult.canary.runs < minSamples) return;

    // Degradation check using autoPromote epsilons (floored)
    const epsCompletion = Math.max(
      deps.config.autoPromote.epsilonCompletion ?? DEFAULT_EPSILON,
      DEFAULT_EPSILON,
    );
    const epsCost = Math.max(
      deps.config.autoPromote.epsilonCost ?? DEFAULT_EPSILON,
      DEFAULT_EPSILON,
    );

    const completionDegradation =
      evalResult.control.avgCompletion - evalResult.canary.avgCompletion;
    const costDegradation =
      evalResult.canary.avgCost - evalResult.control.avgCost;

    if (completionDegradation > epsCompletion || costDegradation > epsCost) {
      // Canary is degraded — do NOT auto-promote
      deps.logger?.info?.(
        `auto-flow: skipping auto-promote — canary degraded ` +
          `(completion Δ=${completionDegradation.toFixed(4)}, ` +
          `cost Δ=${costDegradation.toFixed(6)})`,
      );
      return;
    }

    try {
      deps.controlPlane.promoteRound(canaryInstance.canaryRoundId);

      deps.events.append({
        eventId: `optimizer.auto.promoted:${schedulerInstanceId}:${now}`,
        eventType: "optimizer.auto.promoted",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `auto-flow:${schedulerInstanceId}`,
          schedulerInstanceId,
          optimizationRoundId: canaryInstance.canaryRoundId,
        },
        payload: {
          roundId: canaryInstance.canaryRoundId,
          canaryRuns: evalResult.canary.runs,
          controlRuns: evalResult.control.runs,
          canaryAvgCompletion: evalResult.canary.avgCompletion,
          controlAvgCompletion: evalResult.control.avgCompletion,
          canaryAvgCost: evalResult.canary.avgCost,
          controlAvgCost: evalResult.control.avgCost,
        },
      });

      deps.logger?.info?.(
        `auto-flow: auto-promoted round ${canaryInstance.canaryRoundId}`,
      );
    } catch (promoteErr) {
      // Racing manual promote → benign, no retry
      const msg =
        promoteErr instanceof Error
          ? promoteErr.message
          : String(promoteErr);
      deps.logger?.warn?.(
        `auto-flow promoteRound failed (race): ${msg}`,
      );
      try {
        deps.events.append({
          eventId: `optimizer.auto.promote-failed:${schedulerInstanceId}:${now}`,
          eventType: "optimizer.auto.promote-failed",
          schemaVersion: "1",
          timestamp: now,
          identity: {
            traceId: `auto-flow:${schedulerInstanceId}`,
            schedulerInstanceId,
          },
          payload: {
            roundId: canaryInstance.canaryRoundId,
            reason: msg,
          },
        });
      } catch {
        // best-effort
      }
    }
  }
}
