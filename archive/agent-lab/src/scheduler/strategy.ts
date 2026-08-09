export type SchedulingStrategy = "direct" | "weighted" | "market";

const VALID: ReadonlySet<string> = new Set(["direct", "weighted", "market"]);

export interface StrategyRequest {
  strategy?: SchedulingStrategy;
  caller?: string;
  role: string;
  labels?: Record<string, string>;
}

export interface StrategyConfig {
  defaultStrategy?: SchedulingStrategy;
  weightedRoles?: string[];
}

/** 调度策略解析：显式 > labels > caller=timed-trigger > 白名单 > 默认 */
export function resolveStrategy(req: StrategyRequest, cfg: StrategyConfig): SchedulingStrategy {
  const explicit = req.strategy;
  if (explicit !== undefined && VALID.has(explicit)) return explicit;
  const fromLabels = req.labels?.strategy as SchedulingStrategy | undefined;
  if (fromLabels !== undefined && VALID.has(fromLabels)) return fromLabels;
  if (req.caller === "timed-trigger") return "weighted";
  if (cfg.weightedRoles?.includes(req.role)) return "weighted";
  return cfg.defaultStrategy ?? "market";
}
