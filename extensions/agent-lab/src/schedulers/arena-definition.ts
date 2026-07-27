import type {
  SchedulerDefinition,
  ValidationResult,
} from "../core/contracts.ts";
import type { ArenaConfig } from "../types.ts";
import { DEFAULT_ARENA_CONFIG } from "../config.ts";
import { globMatch } from "../interceptor/model-scope.ts";

// ── Parameter model ────────────────────────────────────────────────

export interface ArenaSchedulerParameters {
  endowment: { K: number; floor: number };
  odds: { easy: number; medium: number; hard: number };
  settlement: { tax: number; errorMode: "stakeOnly" | "stakeTimesOdds" };
  cost: {
    tokenMult: number;
    toolMult: number;
    latencyMult: number;
    resourceFactor: number;
    toolWeights: Record<string, number>;
  };
  bidding: {
    timeoutMs: number;
    promptTemplate: string;
    maxCallsPerDispatch: number;
  };
  market: {
    staleTaskTimeoutMs: number;
    eligibility: string;
    maxBidders: number;
    bidderSelector: string;
  };
  risk: { maxStakeRatio: number };
}

export const ARENA_DEFAULT_PARAMETERS: ArenaSchedulerParameters = {
  endowment: { ...DEFAULT_ARENA_CONFIG.endowment },
  odds: { ...DEFAULT_ARENA_CONFIG.odds },
  settlement: { ...DEFAULT_ARENA_CONFIG.settlement },
  cost: {
    ...DEFAULT_ARENA_CONFIG.cost,
    toolWeights: { ...DEFAULT_ARENA_CONFIG.cost.toolWeights },
  },
  bidding: {
    ...DEFAULT_ARENA_CONFIG.bidding,
    maxCallsPerDispatch: DEFAULT_ARENA_CONFIG.bidding.maxCallsPerDispatch,
  },
  market: { ...DEFAULT_ARENA_CONFIG.market },
  risk: { ...DEFAULT_ARENA_CONFIG.risk },
};

const TUNABLE_PATHS: string[] = [
  "endowment.K",
  "endowment.floor",
  "odds.easy",
  "odds.medium",
  "odds.hard",
  "settlement.tax",
  "settlement.errorMode",
  "market.maxBidders",
  "market.staleTaskTimeoutMs",
  "market.eligibility",
  "bidding.timeoutMs",
  "bidding.maxCallsPerDispatch",
  "risk.maxStakeRatio",
];

// ── Eligibility ────────────────────────────────────────────────────

/**
 * Check whether a model id matches the eligibility string.
 * Eligibility is a comma-separated list of glob patterns matched case-insensitively
 * against the model id. "all" matches everything.
 */
export function matchEligibility(eligibility: string, modelId: string): boolean {
  if (eligibility === "all") return true;
  const trimmed = eligibility.trim();
  if (!trimmed) return false;
  const patterns = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return patterns.some((p) => globMatch(p, modelId));
}

// ── Parameter bridge ──────────────────────────────────────────────

/**
 * Map arena scheduler parameters to the ArenaConfig shape used by policy classes.
 * Only endowment/odds/settlement/cost are explicitly mapped (policy classes need
 * just these four sub-objects). Remaining fields fall back to defaults.
 */
export function arenaParamsToArenaConfig(params: unknown): ArenaConfig {
  const p = (params ?? {}) as Record<string, unknown>;
  const endowment = (p.endowment ?? ARENA_DEFAULT_PARAMETERS.endowment) as Record<string, number>;
  const odds = (p.odds ?? ARENA_DEFAULT_PARAMETERS.odds) as Record<string, number>;
  const settlement = (p.settlement ?? ARENA_DEFAULT_PARAMETERS.settlement) as Record<string, unknown>;
  const cost = (p.cost ?? ARENA_DEFAULT_PARAMETERS.cost) as Record<string, unknown>;

  return {
    endowment: {
      K: Number(endowment.K),
      floor: Number(endowment.floor),
    },
    odds: {
      easy: Number(odds.easy),
      medium: Number(odds.medium),
      hard: Number(odds.hard),
    },
    settlement: {
      tax: Number(settlement.tax),
      errorMode: (settlement.errorMode as "stakeOnly" | "stakeTimesOdds") ?? ARENA_DEFAULT_PARAMETERS.settlement.errorMode,
    },
    cost: {
      tokenMult: Number((cost as Record<string, number>).tokenMult ?? 1),
      toolMult: Number((cost as Record<string, number>).toolMult ?? 1),
      latencyMult: Number((cost as Record<string, number>).latencyMult ?? 1),
      resourceFactor: Number((cost as Record<string, number>).resourceFactor ?? 1),
      toolWeights: (cost.toolWeights ?? {}) as Record<string, number>,
    },
    bidding: { ...ARENA_DEFAULT_PARAMETERS.bidding },
    market: { ...ARENA_DEFAULT_PARAMETERS.market },
    risk: { ...ARENA_DEFAULT_PARAMETERS.risk },
  };
}

// ── Validators ─────────────────────────────────────────────────────

const VALID_ERROR_MODES = new Set(["stakeOnly", "stakeTimesOdds"]);

export function validateArenaParameters(value: unknown): ValidationResult<ArenaSchedulerParameters> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [{ path: "", code: "INVALID_TYPE", message: "parameters must be an object" }],
    };
  }

  const obj = value as Record<string, unknown>;
  const issues: Array<{ path: string; code: string; message: string }> = [];

  // ── risk.maxStakeRatio ──
  const risk = obj.risk as Record<string, unknown> | undefined;
  if (!risk || typeof risk.maxStakeRatio !== "number" || !Number.isFinite(risk.maxStakeRatio)) {
    issues.push({ path: "risk.maxStakeRatio", code: "INVALID_TYPE", message: "risk.maxStakeRatio must be a number" });
  } else if (risk.maxStakeRatio <= 0 || risk.maxStakeRatio > 1) {
    issues.push({
      path: "risk.maxStakeRatio",
      code: "OUT_OF_RANGE",
      message: "risk.maxStakeRatio must be in (0, 1]",
    });
  }

  // ── endowment ──
  const endowment = obj.endowment as Record<string, unknown> | undefined;
  if (!endowment) {
    issues.push({ path: "endowment", code: "MISSING", message: "endowment is required" });
  } else {
    for (const key of ["K", "floor"] as const) {
      const v = endowment[key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        issues.push({ path: `endowment.${key}`, code: "INVALID_TYPE", message: `endowment.${key} must be a number` });
      } else if (v <= 0) {
        issues.push({ path: `endowment.${key}`, code: "OUT_OF_RANGE", message: `endowment.${key} must be > 0` });
      }
    }
  }

  // ── odds ──
  const odds = obj.odds as Record<string, unknown> | undefined;
  if (!odds) {
    issues.push({ path: "odds", code: "MISSING", message: "odds is required" });
  } else {
    for (const key of ["easy", "medium", "hard"] as const) {
      const v = odds[key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        issues.push({ path: `odds.${key}`, code: "INVALID_TYPE", message: `odds.${key} must be a number` });
      } else if (v <= 0) {
        issues.push({ path: `odds.${key}`, code: "OUT_OF_RANGE", message: `odds.${key} must be > 0` });
      }
    }
  }

  // ── settlement ──
  const settlement = obj.settlement as Record<string, unknown> | undefined;
  if (!settlement) {
    issues.push({ path: "settlement", code: "MISSING", message: "settlement is required" });
  } else {
    // tax
    const tax = settlement.tax;
    if (typeof tax !== "number" || !Number.isFinite(tax)) {
      issues.push({ path: "settlement.tax", code: "INVALID_TYPE", message: "settlement.tax must be a number" });
    } else if (tax < 0) {
      issues.push({ path: "settlement.tax", code: "OUT_OF_RANGE", message: "settlement.tax must be >= 0" });
    }
    // errorMode
    const errorMode = settlement.errorMode;
    if (typeof errorMode !== "string" || !VALID_ERROR_MODES.has(errorMode)) {
      issues.push({
        path: "settlement.errorMode",
        code: "INVALID_VALUE",
        message: `settlement.errorMode must be one of: ${[...VALID_ERROR_MODES].join(", ")}`,
      });
    }
  }

  // ── market.maxBidders ──
  const market = obj.market as Record<string, unknown> | undefined;
  if (!market) {
    issues.push({ path: "market", code: "MISSING", message: "market is required" });
  } else {
    const maxBidders = market.maxBidders;
    if (typeof maxBidders !== "number" || !Number.isFinite(maxBidders) || !Number.isInteger(maxBidders)) {
      issues.push({ path: "market.maxBidders", code: "INVALID_TYPE", message: "market.maxBidders must be an integer" });
    } else if (maxBidders < 1) {
      issues.push({ path: "market.maxBidders", code: "OUT_OF_RANGE", message: "market.maxBidders must be >= 1" });
    }

    // market.staleTaskTimeoutMs
    const staleTaskTimeoutMs = market.staleTaskTimeoutMs;
    if (typeof staleTaskTimeoutMs !== "number" || !Number.isFinite(staleTaskTimeoutMs)) {
      issues.push({ path: "market.staleTaskTimeoutMs", code: "INVALID_TYPE", message: "market.staleTaskTimeoutMs must be a number" });
    } else if (staleTaskTimeoutMs <= 0) {
      issues.push({ path: "market.staleTaskTimeoutMs", code: "OUT_OF_RANGE", message: "market.staleTaskTimeoutMs must be > 0" });
    }

    // market.eligibility
    const eligibility = market.eligibility;
    if (typeof eligibility !== "string" || eligibility.trim().length === 0) {
      issues.push({
        path: "market.eligibility",
        code: "INVALID_VALUE",
        message: "market.eligibility must be a non-empty string",
      });
    }
  }

  // ── bidding.timeoutMs ──
  const bidding = obj.bidding as Record<string, unknown> | undefined;
  if (!bidding) {
    issues.push({ path: "bidding", code: "MISSING", message: "bidding is required" });
  } else {
    const timeoutMs = bidding.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      issues.push({ path: "bidding.timeoutMs", code: "INVALID_TYPE", message: "bidding.timeoutMs must be a number" });
    } else if (timeoutMs <= 0) {
      issues.push({ path: "bidding.timeoutMs", code: "OUT_OF_RANGE", message: "bidding.timeoutMs must be > 0" });
    }

    // bidding.maxCallsPerDispatch
    const maxCalls = bidding.maxCallsPerDispatch;
    if (typeof maxCalls !== "number" || !Number.isFinite(maxCalls) || !Number.isInteger(maxCalls)) {
      issues.push({ path: "bidding.maxCallsPerDispatch", code: "INVALID_TYPE", message: "bidding.maxCallsPerDispatch must be an integer" });
    } else if (maxCalls < 1) {
      issues.push({ path: "bidding.maxCallsPerDispatch", code: "OUT_OF_RANGE", message: "bidding.maxCallsPerDispatch must be >= 1" });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // Build the validated value
  return {
    ok: true,
    value: {
      endowment: {
        K: (endowment as Record<string, number>).K,
        floor: (endowment as Record<string, number>).floor,
      },
      odds: {
        easy: (odds as Record<string, number>).easy,
        medium: (odds as Record<string, number>).medium,
        hard: (odds as Record<string, number>).hard,
      },
      settlement: {
        tax: (settlement as Record<string, number>).tax,
        errorMode: (settlement as Record<string, string>).errorMode as "stakeOnly" | "stakeTimesOdds",
      },
      cost: {
        tokenMult: (obj.cost as Record<string, number>)?.tokenMult ?? 1,
        toolMult: (obj.cost as Record<string, number>)?.toolMult ?? 1,
        latencyMult: (obj.cost as Record<string, number>)?.latencyMult ?? 1,
        resourceFactor: (obj.cost as Record<string, number>)?.resourceFactor ?? 1,
        toolWeights: (obj.cost as Record<string, unknown>)?.toolWeights as Record<string, number> ?? {},
      },
      bidding: {
        timeoutMs: (bidding as Record<string, number>).timeoutMs,
        promptTemplate: (bidding as Record<string, string>).promptTemplate ?? "",
        maxCallsPerDispatch: (bidding as Record<string, number>).maxCallsPerDispatch,
      },
      market: {
        staleTaskTimeoutMs: (market as Record<string, number>).staleTaskTimeoutMs ?? 600000,
        eligibility: (market as Record<string, string>).eligibility,
        maxBidders: (market as Record<string, number>).maxBidders,
        bidderSelector: (market as Record<string, string>).bidderSelector ?? "top-balance",
      },
      risk: {
        maxStakeRatio: (risk as Record<string, number>).maxStakeRatio,
      },
    },
  };
}

// ── Agent definition validation ────────────────────────────────────

function validateAgentDefinition(value: unknown): ValidationResult {
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

// ── Transition validation ──────────────────────────────────────────

function validateTransition(
  _current: unknown,
  proposed: unknown,
): ValidationResult {
  return validateArenaParameters(proposed) as ValidationResult;
}

// ── Definition ─────────────────────────────────────────────────────

export const ARENA_DEFINITION: SchedulerDefinition = {
  kind: "scheduler",
  id: "arena",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  parameterModelVersion: "1.0.0",
  agentDefinitionSchemaVersion: "1.0.0",
  parameterSchema: {
    type: "object",
    properties: {
      endowment: {
        type: "object",
        properties: {
          K: { type: "number", minimum: 0 },
          floor: { type: "number", minimum: 0 },
        },
        required: ["K", "floor"],
      },
      odds: {
        type: "object",
        properties: {
          easy: { type: "number", minimum: 0 },
          medium: { type: "number", minimum: 0 },
          hard: { type: "number", minimum: 0 },
        },
        required: ["easy", "medium", "hard"],
      },
      settlement: {
        type: "object",
        properties: {
          tax: { type: "number", minimum: 0 },
          errorMode: { type: "string", enum: ["stakeOnly", "stakeTimesOdds"] },
        },
        required: ["tax", "errorMode"],
      },
      cost: {
        type: "object",
        properties: {
          tokenMult: { type: "number" },
          toolMult: { type: "number" },
          latencyMult: { type: "number" },
          resourceFactor: { type: "number" },
          toolWeights: { type: "object" },
        },
      },
      bidding: {
        type: "object",
        properties: {
          timeoutMs: { type: "number" },
          promptTemplate: { type: "string" },
          maxCallsPerDispatch: { type: "integer", minimum: 1 },
        },
        required: ["timeoutMs", "maxCallsPerDispatch"],
      },
      market: {
        type: "object",
        properties: {
          staleTaskTimeoutMs: { type: "number" },
          eligibility: { type: "string" },
          maxBidders: { type: "integer", minimum: 1 },
          bidderSelector: { type: "string" },
        },
        required: ["maxBidders", "eligibility"],
      },
      risk: {
        type: "object",
        properties: {
          maxStakeRatio: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["maxStakeRatio"],
      },
    },
    required: ["endowment", "odds", "settlement", "market", "risk"],
  },
  agentDefinitionSchema: {
    type: "object",
    properties: {
      standard: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
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
  defaultParameters: structuredClone(ARENA_DEFAULT_PARAMETERS),
  tunablePaths: [...TUNABLE_PATHS],
  validateParameters: validateArenaParameters as (value: unknown) => ValidationResult,
  validateAgentDefinition,
  validateTransition: validateTransition as (
    current: unknown,
    proposed: unknown,
  ) => ValidationResult,
};
