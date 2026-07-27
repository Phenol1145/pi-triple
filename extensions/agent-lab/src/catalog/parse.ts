import type { ModelInfo } from "../types.ts";

export interface ORModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}
export interface ORModelsJson { data: ORModelEntry[]; }

export function providerPrefix(id: string): string {
  const idx = id.indexOf("/");
  return idx >= 0 ? id.slice(0, idx) : id;
}

export function toPerMillion(usdPerToken: string | undefined): number {
  const n = Number(usdPerToken);
  if (!Number.isFinite(n)) return 0;
  return n * 1_000_000;
}

export function isFreeModel(e: ORModelEntry): boolean {
  const p = e.pricing;
  if (!p) return false;
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

export function blendedPrice(m: ModelInfo): number {
  if (!m.pricing) return 0;
  return (m.pricing.in + m.pricing.out) / 2;
}

export function parseORModels(json: ORModelsJson, directPrefixes: string[]): ModelInfo[] {
  const direct = new Set(directPrefixes);
  const out: ModelInfo[] = [];
  for (const e of json.data) {
    const free = isFreeModel(e);
    const isDirect = direct.has(providerPrefix(e.id));
    if (!free && !isDirect) continue;
    const accessRoute = free && isDirect ? "both" : free ? "free" : "direct";
    const modalities = [
      ...(e.architecture?.input_modalities ?? []),
      ...(e.architecture?.output_modalities ?? []),
    ];
    out.push({
      id: e.id,
      provider: providerPrefix(e.id),
      name: e.name ?? e.id,
      contextWindow: e.context_length,
      pricing: { in: toPerMillion(e.pricing?.prompt), out: toPerMillion(e.pricing?.completion) },
      modalities: modalities.length ? modalities : undefined,
      accessRoute,
    });
  }
  return out;
}
