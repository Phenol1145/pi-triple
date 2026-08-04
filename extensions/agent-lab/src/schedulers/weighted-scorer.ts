import type {
  SchedulerDefinition,
  ValidationResult,
} from "../core/contracts.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulingResult,
  SchedulerSDK,
} from "../scheduler/contracts.ts";
import type { ModelInfo, Aggregate } from "../types.ts";
import { scoreCandidates } from "../scorer/scorer.ts";
import { WEIGHTED_SCORER_DEFINITION_ID } from "./names.ts";

// ── Parameter model ────────────────────────────────────────────────

export interface WeightedScorerWeights {
  completion: number;
  costEffectiveness: number;
  performance: number;
  benchmark: number;
}

export interface WeightedScorerParameters {
  weights: WeightedScorerWeights;
  topN: number;
  pinBehavior: "respect" | "ignore";
  syncOnDispatch: boolean;
}

const WEIGHT_KEYS = [
  "completion",
  "costEffectiveness",
  "performance",
  "benchmark",
] as const;

const VALID_PARAMETER_KEYS = new Set([
  "weights",
  "topN",
  "pinBehavior",
  "syncOnDispatch",
]);

export const DEFAULT_WEIGHTED_SCORER_PARAMETERS: WeightedScorerParameters = {
  weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
  topN: 3,
  pinBehavior: "respect",
  syncOnDispatch: false,
};

const TUNABLE_PATHS: string[] = [
  "weights.completion",
  "weights.costEffectiveness",
  "weights.performance",
  "weights.benchmark",
  "topN",
  "pinBehavior",
  "syncOnDispatch",
];

// ── Validators ─────────────────────────────────────────────────────

export function validateParameters(value: unknown): ValidationResult<WeightedScorerParameters> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [{ path: "", code: "INVALID_TYPE", message: "parameters must be an object" }],
    };
  }

  const obj = value as Record<string, unknown>;
  const issues: Array<{ path: string; code: string; message: string }> = [];

  // Reject unknown keys
  for (const key of Object.keys(obj)) {
    if (!VALID_PARAMETER_KEYS.has(key)) {
      issues.push({ path: key, code: "UNKNOWN_KEY", message: `unknown parameter key: ${key}` });
    }
  }

  // Validate weights
  if (typeof obj.weights !== "object" || obj.weights === null) {
    issues.push({ path: "weights", code: "INVALID_TYPE", message: "weights must be an object" });
  } else {
    const w = obj.weights as Record<string, unknown>;
    let allZero = true;
    for (const k of WEIGHT_KEYS) {
      const v = w[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        issues.push({ path: `weights.${k}`, code: "INVALID_TYPE", message: `weights.${k} must be a number` });
      } else if (v < 0) {
        issues.push({ path: `weights.${k}`, code: "NEGATIVE_WEIGHT", message: `weights.${k} must be >= 0` });
      } else if (v > 0) {
        allZero = false;
      }
    }
    if (!issues.some((i) => i.path.startsWith("weights.")) && allZero) {
      issues.push({ path: "weights", code: "ALL_ZERO", message: "at least one weight must be > 0" });
    }
  }

  // Validate topN
  if (typeof obj.topN !== "number" || !Number.isFinite(obj.topN) || !Number.isInteger(obj.topN)) {
    issues.push({ path: "topN", code: "INVALID_TYPE", message: "topN must be an integer" });
  } else if (obj.topN < 1) {
    issues.push({ path: "topN", code: "TOO_SMALL", message: "topN must be >= 1" });
  }

  // Validate pinBehavior
  if (obj.pinBehavior !== "respect" && obj.pinBehavior !== "ignore") {
    issues.push({
      path: "pinBehavior",
      code: "INVALID_VALUE",
      message: `pinBehavior must be "respect" or "ignore"`,
    });
  }

  // Validate syncOnDispatch
  if (typeof obj.syncOnDispatch !== "boolean") {
    issues.push({ path: "syncOnDispatch", code: "INVALID_TYPE", message: "syncOnDispatch must be a boolean" });
  }

  if (issues.length > 0) return { ok: false, issues };

  const weights = obj.weights as WeightedScorerWeights;
  return {
    ok: true,
    value: {
      weights: { ...weights },
      topN: obj.topN as number,
      pinBehavior: obj.pinBehavior as "respect" | "ignore",
      syncOnDispatch: obj.syncOnDispatch as boolean,
    },
  };
}

export function validateAgentDefinition(value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [{ path: "", code: "INVALID_TYPE", message: "agent definition must be an object" }],
    };
  }

  const obj = value as Record<string, unknown>;
  const issues: Array<{ path: string; code: string; message: string }> = [];

  if (typeof obj.standard !== "object" || obj.standard === null) {
    issues.push({ path: "standard", code: "MISSING", message: "standard is required" });
  }
  if (typeof obj.workLoop !== "object" || obj.workLoop === null) {
    issues.push({ path: "workLoop", code: "MISSING", message: "workLoop is required" });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: undefined };
}

export function validateTransition(
  current: unknown,
  proposed: unknown,
): ValidationResult {
  // First validate the proposed parameters structurally
  const proposedResult = validateParameters(proposed);
  if (!proposedResult.ok) return proposedResult;

  // Non-trivial rule: cannot transition to all-zero weights
  const p = proposedResult.value;
  const w = p.weights;
  const allZero =
    w.completion === 0 &&
    w.costEffectiveness === 0 &&
    w.performance === 0 &&
    w.benchmark === 0;

  if (allZero) {
    return {
      ok: false,
      issues: [{ path: "weights", code: "ALL_ZERO", message: "transition to all-zero weights is not allowed" }],
    };
  }

  return { ok: true, value: p };
}

// ── Definition ─────────────────────────────────────────────────────

export const weightedScorerDefinition: SchedulerDefinition = {
  kind: "scheduler",
  id: WEIGHTED_SCORER_DEFINITION_ID,
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  parameterModelVersion: "1.0.0",
  agentDefinitionSchemaVersion: "1.0.0",
  parameterSchema: {
    type: "object",
    properties: {
      weights: {
        type: "object",
        properties: {
          completion: { type: "number", minimum: 0 },
          costEffectiveness: { type: "number", minimum: 0 },
          performance: { type: "number", minimum: 0 },
          benchmark: { type: "number", minimum: 0 },
        },
        required: ["completion", "costEffectiveness", "performance", "benchmark"],
      },
      topN: { type: "integer", minimum: 1 },
      pinBehavior: { type: "string", enum: ["respect", "ignore"] },
      syncOnDispatch: { type: "boolean" },
    },
    required: ["weights", "topN", "pinBehavior", "syncOnDispatch"],
  },
  agentDefinitionSchema: {
    type: "object",
    properties: {
      standard: {
        type: "object",
        properties: {
          name: { type: "string" },
          capabilities: { type: "array" },
          executionKind: { type: "string" },
          labels: { type: "object" },
        },
      },
      workLoop: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "string" },
          config: { type: "object" },
        },
      },
      custom: {},
    },
  },
  defaultParameters: structuredClone(DEFAULT_WEIGHTED_SCORER_PARAMETERS),
  tunablePaths: [...TUNABLE_PATHS],
  validateParameters: validateParameters as (value: unknown) => ValidationResult,
  validateAgentDefinition,
  validateTransition: validateTransition as (
    current: unknown,
    proposed: unknown,
  ) => ValidationResult,
};

// ── Ports ──────────────────────────────────────────────────────────

export interface WeightedScorerPorts {
  candidates(): ModelInfo[];
  aggregates(role: string): Map<string, Aggregate>;
  pinLookup(role: string): string | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────

import { modelToAgentCreateSpec, modelToAgentDefinition } from "../core/agent-spec.ts";
export { modelToAgentCreateSpec, modelToAgentDefinition };

/**
 * Build a minimal `LabConfig` from a `WeightedScorerParameters` object.
 *
 * Only `weights` and `topN` are extracted; remaining fields use safe defaults
 * that do not materially affect `scoreCandidates` for comparison purposes.
 * This is the **single shared helper** used by both the scheduler implementation
 * and the shadow evaluation engine.
 */
export function buildLabConfigFromParams(
  params: WeightedScorerParameters,
): import("../types.ts").LabConfig {
  return {
    weights: { ...params.weights },
    autoApply: true,
    acceptanceScoreMap: {},
    interruptedPenalty: 0,
    toolFailPenalty: 0,
    topN: params.topN,
    catalogTtlMs: 0,
    mode: "classic",
    arena: {
      endowment: { K: 0, floor: 0 },
      odds: { easy: 0, medium: 0, hard: 0 },
      settlement: { tax: 0, errorMode: "stakeOnly" },
      cost: { tokenMult: 0, toolMult: 0, latencyMult: 0, resourceFactor: 0, toolWeights: {} },
      bidding: { timeoutMs: 0, promptTemplate: "", maxCallsPerDispatch: 0 },
      market: { staleTaskTimeoutMs: 0, eligibility: "all", maxBidders: 0, bidderSelector: "top-balance" },
      risk: { maxStakeRatio: 0 },
    },
  };
}

// ── Implementation ─────────────────────────────────────────────────

export function createWeightedScorer(ports: WeightedScorerPorts): {
  definition: SchedulerDefinition;
  implementation: SchedulerImplementation;
} {
  const impl: SchedulerImplementation = {
    id: WEIGHTED_SCORER_DEFINITION_ID,
    version: "1.0.0",

    async schedule(
      input: SchedulingInput,
      parameters: Readonly<unknown>,
      sdk: SchedulerSDK,
    ): Promise<SchedulingResult> {
      const params = parameters as WeightedScorerParameters;

      // 1. Get candidates
      const candidates = ports.candidates();

      // 2. Empty candidates → abstain (not failed)
      if (candidates.length === 0) {
        sdk.telemetry.emit("scheduler.weighted_scorer.abstained", {
          role: input.role,
          reason: "no candidates available",
        });
        return { status: "abstained", reason: "no candidates available" };
      }

      // 3. Get aggregates
      const aggsByModel = ports.aggregates(input.role);

      // 4. Handle pin
      const pin = ports.pinLookup(input.role);
      const pinBehavior = params.pinBehavior ?? "respect";

      if (pin && pinBehavior === "respect") {
        const pinnedModel = candidates.find((m) => m.id === pin);
        if (pinnedModel) {
          // Pin hit: model present in candidates
          sdk.telemetry.emit("scheduler.weighted_scorer.score", {
            role: input.role,
            candidateCount: candidates.length,
            pinHit: true,
          }, {
            "scheduler.weighted_scorer.pin_hit": 1,
            "scheduler.weighted_scorer.candidate_count": candidates.length,
          });

          // 按 model 匹配已有 agent（agent id 是随机 UUID，不能按 id 匹配）
          const existing = await sdk.agents.list();
          const findByModel = () => existing.find((a) => a.definition?.standard?.name === pinnedModel.id);

          // syncOnDispatch：按 model 判重，缺则创建
          if (params.syncOnDispatch) {
            if (!findByModel()) {
              const spec = modelToAgentCreateSpec(pinnedModel);
              const created = await sdk.agents.create(spec);
              existing.push({ id: created.id, definition: spec.definition, status: "ready" });
            }
          }

          // In select mode, check if agent exists
          if (input.mode === "select") {
            const existingAgent = findByModel();
            return {
              status: "completed",
              selectedAgentId: existingAgent ? existingAgent.id : undefined,
              model: pin,
              reason: `pinned model: ${pin}`,
            };
          }

          // Execute mode
          if (input.mode === "execute") {
            const existingAgent = findByModel();
            const runAgentId = existingAgent?.id ?? modelToAgentCreateSpec(pinnedModel).id;

            try {
              const result = await sdk.agents.run(runAgentId, {
                task: input.task,
                configOverrides: { agent: input.role },
              });
              return {
                status: "completed",
                selectedAgentId: runAgentId,
                model: pin,
                output: result.output,
                reason: `pinned model: ${pin}`,
              };
            } catch (err: unknown) {
              const e = err as { code?: string; message?: string };
              return {
                status: "failed",
                error: {
                  code: e.code ?? "EXECUTION_ERROR",
                  message: e.message ?? String(err),
                  retryable: true,
                },
              };
            }
          }
        } else {
          // Pin to model absent from population (select mode)
          sdk.telemetry.emit("scheduler.weighted_scorer.score", {
            role: input.role,
            candidateCount: candidates.length,
            pinHit: false,
          }, {
            "scheduler.weighted_scorer.pin_absent": 1,
            "scheduler.weighted_scorer.candidate_count": candidates.length,
          });

          return {
            status: "completed",
            selectedAgentId: undefined,
            model: pin,
            reason: `pinned model absent from candidates: ${pin}`,
          };
        }
      }

      // 5. Score candidates
      const cfg = buildLabConfigFromParams(params);
      const scored = scoreCandidates(candidates, aggsByModel, cfg);

      // Sort by score descending (stable)
      scored.sort((a, b) => b.score - a.score);

      // Pick top candidate
      const top = scored[0];

      if (!top) {
        // Shouldn't happen since we checked candidates.length > 0
        return { status: "abstained", reason: "no scored candidates" };
      }

      const agentSpec = modelToAgentCreateSpec(top.model);

      // Emit telemetry
      sdk.telemetry.emit("scheduler.weighted_scorer.score", {
        role: input.role,
        candidateCount: candidates.length,
        topScore: top.score,
        pinHit: false,
      }, {
        "scheduler.weighted_scorer.top_score": top.score,
        "scheduler.weighted_scorer.candidate_count": candidates.length,
      });

      // 按 model 匹配已有 agent（agent id 是随机 UUID，不能按 id 匹配）
      const existing = await sdk.agents.list();
      const findByModel = () => existing.find((a) => a.definition?.standard?.name === top.model.id);

      // 6. syncOnDispatch：按 model 判重，缺则创建
      if (params.syncOnDispatch) {
        if (!findByModel()) {
          const created = await sdk.agents.create(agentSpec);
          existing.push({ id: created.id, definition: agentSpec.definition, status: "ready" });
        }
      }

      // 7. Select mode: never call agents.run
      if (input.mode === "select") {
        const existingAgent = findByModel();
        return {
          status: "completed",
          selectedAgentId: existingAgent ? existingAgent.id : undefined,
          model: top.model.id,
          reason: top.reason,
        };
      }

      // 8. Execute mode: merge config and run
      if (input.mode === "execute") {
        const existingAgent = findByModel();
        const runAgentId = existingAgent?.id ?? agentSpec.id;

        try {
          const result = await sdk.agents.run(runAgentId, {
            task: input.task,
            configOverrides: { agent: input.role },
          });
          return {
            status: "completed",
            selectedAgentId: runAgentId,
            model: top.model.id,
            output: result.output,
            reason: top.reason,
          };
        } catch (err: unknown) {
          const e = err as { code?: string; message?: string };
          return {
            status: "failed",
            error: {
              code: e.code ?? "EXECUTION_ERROR",
              message: e.message ?? String(err),
              retryable: true,
            },
          };
        }
      }

      // Should never reach here
      return { status: "abstained", reason: "unknown mode" };
    },
  };

  return { definition: weightedScorerDefinition, implementation: impl };
}
