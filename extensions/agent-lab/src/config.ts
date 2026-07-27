import type { ArenaConfig, LabConfig, OptimizerConfig } from "./types.ts";

export const DEFAULT_ARENA_CONFIG: ArenaConfig = {
  endowment: { K: 100, floor: 0.05 },
  odds: { easy: 1.5, medium: 3.0, hard: 5.0 },
  settlement: { tax: 5, errorMode: "stakeTimesOdds" },
  cost: { tokenMult: 1.0, toolMult: 1.0, latencyMult: 1.0, resourceFactor: 1.0, toolWeights: { bash: 1.0, edit: 0.8, write: 0.8, read: 0.2 } },
  bidding: { timeoutMs: 10000, promptTemplate: "任务：{prompt}（角色 {role}），难度 {difficulty}，赔率 {odds}。你当前 credits：{balance}。可押不超过可用余额。你押多少 credits 接此任务？只回一个数字。", maxCallsPerDispatch: 6 },
  market: { staleTaskTimeoutMs: 600000, eligibility: "all", maxBidders: 6, bidderSelector: "top-balance" },
  risk: { maxStakeRatio: 0.5 },
};

export const DEFAULT_CONFIG: LabConfig = {
  weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
  autoApply: true,
  acceptanceScoreMap: { reviewed: 1.0, verified: 0.9, checked: 0.7, attested: 0.5, auto: 0.4, none: 0.2 },
  interruptedPenalty: 0.3,
  toolFailPenalty: 0.2,
  topN: 3,
  catalogTtlMs: 21_600_000,
  mode: "classic",
  arena: mergeArena(DEFAULT_ARENA_CONFIG),
};

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  shadow: { enabled: false },
  canaryPercent: 0,
  autoTrigger: { enabled: false },
  autoPromote: { enabled: false },
  autoRollback: { enabled: false },
};

export function mergeConfig(partial: Partial<LabConfig> | undefined): LabConfig {
  if (!partial) {
    return { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights }, acceptanceScoreMap: { ...DEFAULT_CONFIG.acceptanceScoreMap }, arena: mergeArena(DEFAULT_ARENA_CONFIG) };
  }
  const scheduler = partial.scheduler ? { ...partial.scheduler } : undefined;
  const optimizer = partial.optimizer ? mergeOptimizer(DEFAULT_OPTIMIZER_CONFIG, partial.optimizer) : undefined;
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    weights: { ...DEFAULT_CONFIG.weights, ...(partial.weights ?? {}) },
    acceptanceScoreMap: { ...DEFAULT_CONFIG.acceptanceScoreMap, ...(partial.acceptanceScoreMap ?? {}) },
    arena: mergeArena(DEFAULT_ARENA_CONFIG, partial.arena),
    scheduler,
    optimizer,
  };
}

function mergeArena(base: ArenaConfig, partial?: ArenaConfig): ArenaConfig {
  return {
    endowment: { ...base.endowment, ...(partial?.endowment ?? {}) },
    odds: { ...base.odds, ...(partial?.odds ?? {}) },
    settlement: { ...base.settlement, ...(partial?.settlement ?? {}) },
    cost: { ...base.cost, ...(partial?.cost ?? {}), toolWeights: { ...base.cost.toolWeights, ...(partial?.cost?.toolWeights ?? {}) } },
    bidding: { ...base.bidding, ...(partial?.bidding ?? {}) },
    market: { ...base.market, ...(partial?.market ?? {}) },
    risk: { ...base.risk, ...(partial?.risk ?? {}) },
  };
}

function mergeOptimizer(base: OptimizerConfig, partial: Partial<OptimizerConfig>): OptimizerConfig {
  return {
    shadow: { ...base.shadow, ...(partial.shadow ?? {}) },
    canaryPercent: partial.canaryPercent ?? base.canaryPercent,
    autoTrigger: { ...base.autoTrigger, ...(partial.autoTrigger ?? {}) },
    autoPromote: { ...base.autoPromote, ...(partial.autoPromote ?? {}) },
    autoRollback: { ...base.autoRollback, ...(partial.autoRollback ?? {}) },
  };
}
