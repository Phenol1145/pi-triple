import type { SchedulingStrategy } from "./scheduler/strategy.ts";

export type AccessRoute = "free" | "direct" | "both";

export interface ModelPricing { in: number; out: number; }
export interface ModelPerf { throughputP50?: number; latencyP50?: number; uptime7d?: number; }

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  contextWindow?: number;
  pricing?: ModelPricing;
  perf?: ModelPerf;
  benchmarks?: Record<string, number>;
  modalities?: string[];
  accessRoute: AccessRoute;
}

export interface RunRecord {
  ts: number;
  role: string;
  model: string;
  taskCategory?: string;
  acceptance?: string;
  completion: number;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  toolSuccess?: number;
  turns?: number;
  interrupted?: number;
  signals?: Record<string, unknown>;
  source: "auto" | "manual";
  traceId?: string;
  templateId?: string;
  sessionId?: string;
  agentInstanceId?: string;
}

export interface Aggregate {
  model: string;
  role: string;
  runs: number;
  avgCompletion: number;
  avgCost: number;
  successRate: number;
}

export interface Weights { completion: number; costEffectiveness: number; performance: number; benchmark: number; }

export interface OptimizerConfig {
  shadow?: { enabled?: boolean };
  canaryPercent?: number;
  autoTrigger?: { enabled?: boolean; everyNRuns?: number; everyTMs?: number };
  autoPromote?: { enabled?: boolean; minSamples?: number; epsilonCompletion?: number; epsilonCost?: number };
  autoRollback?: { enabled?: boolean; minSamples?: number; epsilonCompletion?: number; epsilonCost?: number };
}

export interface LabConfig {
  weights: Weights;
  autoApply: boolean;
  acceptanceScoreMap: Record<string, number>;
  interruptedPenalty: number;
  toolFailPenalty: number;
  topN: number;
  catalogTtlMs: number;
  mode: Mode;
  market: MarketConfig;
  scheduler?: SchedulerConfig;
  optimizer?: OptimizerConfig;
}

export interface SchedulerConfig {
  enabled?: boolean;
  instanceId?: string;
  /** 默认调度策略（resolveStrategy 缺省回退值；runner 构造参数注入） */
  defaultStrategy?: SchedulingStrategy;
  /** 命中 role 即强制 weighted 策略的白名单 */
  weightedRoles?: string[];
}

export type Mode = "classic" | "market";

export interface MarketConfig {
  endowment: { K: number; floor: number };
  odds: { easy: number; medium: number; hard: number };
  settlement: { tax: number; /** @deprecated 行为恒 stakeOnly（spec §7/M-R4-3）：值被忽略，仅保留读取兼容 */ errorMode: "stakeOnly" | "stakeTimesOdds" };
  cost: { tokenMult: number; toolMult: number; latencyMult: number; resourceFactor: number; toolWeights: Record<string, number> };
  bidding: { timeoutMs: number; promptTemplate: string; maxCallsPerDispatch: number; minStake: number; engine: "model-caller" | "workloop"; maxConcurrentBids: number; bidTurnBudget: number; bidSkill: string };
  market: { staleTaskTimeoutMs: number; eligibility: string; maxBidders: number; bidderSelector: string; diversityFactor: number };
  execution: { timeoutMs: number };
  risk: { maxStakeRatio: number };
}

export interface ScoreBreakdown { completion: number; costEffectiveness: number; performance: number; benchmark: number; }

export interface ScoredModel {
  model: ModelInfo;
  score: number;
  breakdown: ScoreBreakdown;
  reason: string;
  coldStart: boolean;
}
