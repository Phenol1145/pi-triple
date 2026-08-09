/**
 * OptimizerFacade — production wiring for the /lab optimizer command family.
 *
 * Extracted from index.ts for testability.  The facade uses lazy-resolved
 * core & registry handles so it can be created before bootstrap completes.
 */

import type { DatabaseSync } from "node:sqlite";
import type { LabCore } from "../core/create-core.ts";
import type { OptimizerRegistry } from "./registry.ts";
import type { OptimizerFacade } from "../commands/register.ts";
import type { OptimizeResult } from "./contracts.ts";
import type { ModelInfo, OptimizerConfig } from "../types.ts";
import { DataAPIImpl } from "./data-api.ts";
import { createWeightedTunerInstance } from "../optimizers/weighted-tuner.ts";
import { diffLeafPaths } from "../core/parameter-diff.ts";
import { evaluateShadow } from "./shadow.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function pathMatchesTunable(path: string, tunablePaths: string[]): boolean {
  const segs = path.split(".");
  return tunablePaths.some((tp) => {
    const tSegs = tp.split(".");
    if (segs.length !== tSegs.length) return false;
    for (let i = 0; i < segs.length; i++) {
      if (tSegs[i] !== "*" && tSegs[i] !== segs[i]) return false;
    }
    return true;
  });
}

// ── Deps ─────────────────────────────────────────────────────────────────

export interface OptimizerFacadeDeps {
  /** Lazy resolver — returns undefined until bootstrap completes. */
  getCore(): LabCore | undefined;
  /** Lazy resolver — returns undefined until bootstrap completes. */
  getRegistry(): OptimizerRegistry | undefined;
  /** Raw SQLite handle for the legacy runs table (projector queries). */
  getDb(): DatabaseSync;
  /** Lazy resolver for catalog snapshot (needed by shadow engine). */
  getCatalog?: () => ModelInfo[];
  /** Optimizer config (for auto-status). */
  getOptimizerConfig?: () => OptimizerConfig | undefined;
  /** Auto-trigger status (for auto-status throttle display). */
  getAutoTriggerStatus?: () => { runsSinceLast: number; lastFiredAt: number | null; fires: number } | undefined;
  /** Called after a successful optimizer run produces a proposal (for auto-flow tick). */
  onRunTick?: (schedulerInstanceId: string) => void;
}

// ── Builder ──────────────────────────────────────────────────────────────

export function buildOptimizerFacade(deps: OptimizerFacadeDeps): OptimizerFacade {
  const { getCore, getRegistry, getDb } = deps;

  return {
    list() {
      const registry = getRegistry();
      if (!registry) return [];
      return registry.listInstances().map((r) => ({
        instanceId: r.id,
        definitionId: r.definitionId,
        definitionVersion: r.definitionVersion,
        status: r.status,
        targetSchedulers: r.targetSchedulers,
      }));
    },

    async run(instanceId: string) {
      const core = getCore();
      const registry = getRegistry();
      if (!core || !registry) {
        return { kind: "fail" as const, error: "optimizer unavailable (bootstrap pending)" };
      }

      const now = Date.now();
      const triggeredId = `optimizer.run.triggered:${instanceId}:${now}`;

      // Emit triggered event (best-effort)
      try {
        core.events.append({
          eventId: triggeredId,
          eventType: "optimizer.run.triggered",
          schemaVersion: "1",
          timestamp: now,
          identity: { traceId: `optimizer:${instanceId}`, optimizerInstanceId: instanceId },
          payload: { instanceId },
        });
      } catch { /* best-effort event */ }

      const rec = registry.getInstance(instanceId);
      if (!rec) {
        return { kind: "fail" as const, eventId: triggeredId, error: `optimizer instance not found: ${instanceId}` };
      }

      // Resolve definition + factory
      const def = core.definitions.require({
        kind: "optimizer",
        id: rec.definitionId,
        version: rec.definitionVersion,
      }) as import("../core/contracts.ts").OptimizerDefinition;

      const optimizable = createWeightedTunerInstance(def, rec.id, rec.config);

      for (const sid of rec.targetSchedulers) {
        try {
          const dataApi = new DataAPIImpl(getDb(), core.repository, core.events, [sid], instanceId);
          const ctx = {
            data: dataApi,
            schedulerInstanceId: sid,
            now: () => Date.now(),
          };

          let result: OptimizeResult;
          try {
            result = await optimizable.optimize(ctx);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            try {
              core.events.append({
                eventId: `optimizer.run.failed:${instanceId}:${sid}:${now}`,
                eventType: "optimizer.run.failed",
                schemaVersion: "1",
                timestamp: now,
                identity: {
                  traceId: `optimizer:${instanceId}`,
                  optimizerInstanceId: instanceId,
                  schedulerInstanceId: sid,
                },
                payload: { instanceId, error: msg },
              });
            } catch { /* best-effort */ }
            return { kind: "fail" as const, eventId: triggeredId, error: msg };
          }

          if (result.kind === "skip") {
            try {
              core.events.append({
                eventId: `optimizer.run.skipped:${instanceId}:${sid}:${now}`,
                eventType: "optimizer.run.skipped",
                schemaVersion: "1",
                timestamp: now,
                identity: {
                  traceId: `optimizer:${instanceId}`,
                  optimizerInstanceId: instanceId,
                  schedulerInstanceId: sid,
                },
                payload: { instanceId, reason: result.reason },
              });
            } catch { /* best-effort */ }
            return { kind: "skip" as const, eventId: triggeredId, reason: result.reason };
          }

          // proposal
          const { proposalId } = core.controlPlane.submitProposal(instanceId, sid, {
            baseRoundId: result.proposal.baseRoundId,
            parameters: result.proposal.parameters,
            evaluation: result.proposal.evaluation,
          });

          return {
            kind: "proposal" as const,
            eventId: triggeredId,
            proposalId,
            evaluation: result.proposal.evaluation,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            core.events.append({
              eventId: `optimizer.run.failed:${instanceId}:${sid}:${now}`,
              eventType: "optimizer.run.failed",
              schemaVersion: "1",
              timestamp: now,
              identity: {
                traceId: `optimizer:${instanceId}`,
                optimizerInstanceId: instanceId,
                schedulerInstanceId: sid,
              },
              payload: { instanceId, error: msg },
            });
          } catch { /* best-effort */ }
          return { kind: "fail" as const, eventId: triggeredId, error: msg };
        } finally {
          // Fire-and-forget auto-flow tick after EVERY optimizer run completion
          // (proposal / skip / fail alike). Fail-open per L7/I7.
          try { deps.onRunTick?.(sid); } catch { /* swallow */ }
        }
      }

      return { kind: "fail" as const, eventId: triggeredId, error: "no target schedulers processed" };
    },

    proposals(schedulerInstanceId?: string) {
      const core = getCore();
      if (!core) return [];
      return core.repository.listProposals(schedulerInstanceId).map((p) => ({
        proposalId: p.id,
        optimizerInstanceId: p.optimizerInstanceId,
        schedulerInstanceId: p.schedulerInstanceId,
        status: p.status,
        evaluation: p.evaluation as { summary: string } | undefined,
        candidateRoundId: p.candidateRoundId,
        createdAt: p.createdAt,
      }));
    },

    diff(proposalId: string) {
      const core = getCore();
      if (!core) return { baseRoundId: "", changedPaths: [] };

      const proposal = core.repository.getProposal(proposalId);
      if (!proposal) return { baseRoundId: proposalId, changedPaths: [] };

      const baseRound = core.repository.getRound(proposal.baseRoundId);
      const candidateRound = proposal.candidateRoundId
        ? core.repository.getRound(proposal.candidateRoundId)
        : undefined;

      if (!baseRound || !candidateRound) {
        return {
          baseRoundId: proposal.baseRoundId,
          candidateRoundId: proposal.candidateRoundId,
          changedPaths: [],
        };
      }

      const paths = diffLeafPaths(baseRound.parameters, candidateRound.parameters);

      // Get tunable paths from the scheduler definition
      let tunablePaths: string[] = [];
      try {
        const instance = core.repository.getInstance(proposal.schedulerInstanceId);
        if (instance) {
          const schedDef = core.definitions.require(instance.definition);
          if (schedDef && "tunablePaths" in schedDef) {
            tunablePaths = (schedDef as { tunablePaths?: string[] }).tunablePaths ?? [];
          }
        }
      } catch { /* best-effort */ }

      return {
        baseRoundId: proposal.baseRoundId,
        candidateRoundId: proposal.candidateRoundId,
        changedPaths: paths.map((p) => ({
          path: p,
          tunable: tunablePaths.length > 0 ? pathMatchesTunable(p, tunablePaths) : true,
        })),
      };
    },

    promote(roundId: string) {
      const core = getCore();
      if (!core) throw new Error("optimizer unavailable (bootstrap pending)");

      // Capture previousRoundId BEFORE promoteRound (mirrors rollback ordering)
      const round = core.repository.getRound(roundId);
      const instance = round
        ? core.repository.getInstance(round.schedulerInstanceId)
        : undefined;
      const previousRoundId = instance?.currentRoundId ?? "";

      const { newRoundId } = core.controlPlane.promoteRound(roundId);
      return { newRoundId, previousRoundId };
    },

    rollback(schedulerInstanceId: string, targetRoundId: string) {
      const core = getCore();
      if (!core) throw new Error("optimizer unavailable (bootstrap pending)");
      const instance = core.repository.getInstance(schedulerInstanceId);
      const prevRoundId = instance?.currentRoundId ?? "";
      const { newRoundId } = core.controlPlane.rollbackRound(schedulerInstanceId, targetRoundId);
      return { newRoundId, previousRoundId: prevRoundId };
    },

    async validate(proposalId: string) {
      const core = getCore();
      if (!core) throw new Error("optimizer unavailable (bootstrap pending)");

      const catalogSnapshot = deps.getCatalog?.();
      if (!catalogSnapshot) throw new Error("catalog unavailable (bootstrap pending)");

      const proposal = core.repository.getProposal(proposalId);
      if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
      if (!proposal.candidateRoundId) throw new Error(`proposal has no candidate round: ${proposalId}`);

      const shadowResult = await evaluateShadow({
        repository: core.repository,
        events: core.events,
        db: getDb(),
        getCatalogSnapshot: () => catalogSnapshot,
        optimizerInstanceId: proposal.optimizerInstanceId,
        schedulerInstanceId: proposal.schedulerInstanceId,
      }, proposalId);

      return {
        status: shadowResult.status,
        selectionChanged: shadowResult.selectionChanged,
        currentTop: shadowResult.currentTop.map((s) => s.model.id),
        candidateTop: shadowResult.candidateTop.map((s) => s.model.id),
        expectedCompletionDelta: shadowResult.expectedCompletionDelta,
        expectedCostDelta: shadowResult.expectedCostDelta,
        samples: shadowResult.samples,
        ...(shadowResult.error ? { error: shadowResult.error } : {}),
      };
    },

    canaryStart(roundId: string, percent?: number) {
      const core = getCore();
      if (!core) throw new Error("optimizer unavailable (bootstrap pending)");

      const cfg = deps.getOptimizerConfig?.();
      const effectivePercent = percent ?? cfg?.canaryPercent ?? 20;
      if (effectivePercent <= 0 || effectivePercent > 100) {
        return { ok: false, reason: `invalid percent: ${effectivePercent}` };
      }

      const round = core.repository.getRound(roundId);
      if (!round) return { ok: false, reason: `round not found: ${roundId}` };
      if (round.status !== "validated" && round.status !== "proposed") {
        return { ok: false, reason: `round must be validated or proposed, got ${round.status}` };
      }

      core.repository.setCanaryRound(round.schedulerInstanceId, roundId, effectivePercent);

      // Transition round status to canary (coherence: downstream gates check status)
      core.repository.updateRoundStatus(roundId, "canary");

      // Emit canary-started event (mirrors auto-flow shape, actor=manual)
      try {
        core.events.append({
          eventId: `optimizer.canary-started:${round.schedulerInstanceId}:${Date.now()}`,
          eventType: "optimizer.canary-started",
          schemaVersion: "1",
          timestamp: Date.now(),
          identity: {
            traceId: `optimizer:manual-canary`,
            schedulerInstanceId: round.schedulerInstanceId,
            optimizationRoundId: roundId,
          },
          payload: {
            roundId,
            canaryPercent: effectivePercent,
            actor: "manual",
          },
        });
      } catch {
        // best-effort event emission
      }

      return { ok: true, schedulerInstanceId: round.schedulerInstanceId };
    },

    canaryStop(schedulerInstanceId: string) {
      const core = getCore();
      if (!core) throw new Error("optimizer unavailable (bootstrap pending)");

      const instance = core.repository.getInstance(schedulerInstanceId);
      if (!instance) return { ok: false, reason: `instance not found: ${schedulerInstanceId}` };
      if (!instance.canaryRoundId) return { ok: false, reason: "no active canary on this instance" };

      core.controlPlane.abortCanary(schedulerInstanceId, {
        reason: "manual canary stop via /lab optimizer canary stop",
        actor: "manual",
      });
      return { ok: true };
    },

    canaryStatus() {
      const core = getCore();
      if (!core) throw new Error("optimizer unavailable (bootstrap pending)");

      // Find the first (only) instance with an active canary
      const instances = core.repository.listInstances();
      for (const inst of instances) {
        if (inst.canaryRoundId) {
          return {
            hasCanary: true,
            canaryRoundId: inst.canaryRoundId,
            canaryPercent: inst.canaryPercent,
            schedulerInstanceId: inst.id,
          };
        }
      }
      return { hasCanary: false };
    },

    autoStatus() {
      const cfg = deps.getOptimizerConfig?.();
      const triggerStatus = deps.getAutoTriggerStatus?.();
      return {
        config: (cfg ?? {}) as Record<string, unknown>,
        triggerStatus: triggerStatus ?? undefined,
      };
    },
  };
}
