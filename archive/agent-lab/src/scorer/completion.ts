export function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export function acceptanceBase(level: string | undefined, map: Record<string, number>): number {
  if (level && level in map) return map[level];
  return map.auto ?? 0.4;
}

export interface CompletionInput {
  acceptance?: string;
  interrupted?: number;
  toolSuccess?: number;
  manualRating?: number;
  map: Record<string, number>;
  interruptedPenalty: number;
  toolFailPenalty: number;
}

export function deriveCompletion(i: CompletionInput): number {
  if (i.manualRating != null && !Number.isNaN(i.manualRating)) return clamp01(i.manualRating);
  const base = acceptanceBase(i.acceptance, i.map);
  const interruptPen = i.interrupted ? i.interruptedPenalty : 0;
  const tsr = clamp01(i.toolSuccess ?? 1);
  const failPen = (1 - tsr) * i.toolFailPenalty;
  return clamp01(base - interruptPen - failPen);
}
