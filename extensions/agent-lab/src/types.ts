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
  tenantId?: string;
  sessionId?: string;
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
  arena: ArenaConfig;
  scheduler?: SchedulerConfig;
  optimizer?: OptimizerConfig;
}

export interface SchedulerConfig {
  enabled?: boolean;
  instanceId?: string;
}

export type Mode = "classic" | "market";

export interface ArenaConfig {
  endowment: { K: number; floor: number };
  odds: { easy: number; medium: number; hard: number };
  settlement: { tax: number; errorMode: "stakeOnly" | "stakeTimesOdds" };
  cost: { tokenMult: number; toolMult: number; latencyMult: number; resourceFactor: number; toolWeights: Record<string, number> };
  bidding: { timeoutMs: number; promptTemplate: string; maxCallsPerDispatch: number };
  market: { staleTaskTimeoutMs: number; eligibility: string; maxBidders: number; bidderSelector: string; };
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
