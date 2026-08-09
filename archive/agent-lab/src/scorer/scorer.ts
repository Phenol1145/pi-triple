import type { Aggregate, LabConfig, ModelInfo, ScoredModel } from "../types.ts";
import { blendedPrice } from "../catalog/parse.ts";

export function minmax(values: number[], invert = false): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => {
    const n = (v - min) / (max - min);
    return invert ? 1 - n : n;
  });
}

export function representativeBenchmark(m: ModelInfo): number {
  if (!m.benchmarks) return 0;
  const vals = Object.values(m.benchmarks).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function staticProxy(m: ModelInfo): number {
  const b = representativeBenchmark(m);
  return b > 0 ? Math.min(1, b / 100) : 0.5;
}

export function scoreCandidates(candidates: ModelInfo[], aggsByModel: Map<string, Aggregate>, cfg: LabConfig): ScoredModel[] {
  const completionRaw = candidates.map((m) => {
    const agg = aggsByModel.get(m.id);
    return agg ? agg.avgCompletion : staticProxy(m);
  });
  const costRaw = candidates.map((m) => blendedPrice(m));
  const perfRaw = candidates.map((m) => m.perf?.throughputP50 ?? 0);
  const benchRaw = candidates.map((m) => representativeBenchmark(m));

  const costNorm = minmax(costRaw, true);
  const perfNorm = minmax(perfRaw);
  const benchNorm = minmax(benchRaw);
  const w = cfg.weights;

  return candidates.map((m, i) => {
    const agg = aggsByModel.get(m.id);
    const coldStart = !agg;
    const breakdown = {
      completion: w.completion * completionRaw[i],
      costEffectiveness: w.costEffectiveness * costNorm[i],
      performance: w.performance * perfNorm[i],
      benchmark: w.benchmark * benchNorm[i],
    };
    const score = breakdown.completion + breakdown.costEffectiveness + breakdown.performance + breakdown.benchmark;
    return { model: m, score, breakdown, coldStart, reason: buildReason(m, coldStart, breakdown, costRaw[i]) };
  });
}

function buildReason(m: ModelInfo, coldStart: boolean, b: { completion: number; costEffectiveness: number; performance: number; benchmark: number }, cost: number): string {
  const parts: string[] = [];
  if (coldStart) parts.push("冷启动(静态特征)");
  if (cost === 0) parts.push("免费");
  const dominant = (Object.entries(b) as Array<[string, number]>).sort((a, c) => c[1] - a[1])[0];
  const label: Record<string, string> = { completion: "完成度高", costEffectiveness: "性价比高", performance: "性能高", benchmark: "基准高" };
  if (dominant) parts.push(label[dominant[0]] ?? dominant[0]);
  return parts.join(" · ");
}

export function recommend(candidates: ModelInfo[], aggsByModel: Map<string, Aggregate>, cfg: LabConfig, topN: number): ScoredModel[] {
  return scoreCandidates(candidates, aggsByModel, cfg).sort((a, b) => b.score - a.score).slice(0, topN);
}
