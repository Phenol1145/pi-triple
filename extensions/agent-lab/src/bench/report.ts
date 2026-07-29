import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface BenchTaskResult {
  task_id: string; model?: string; stake?: number; passed?: boolean;
  settled?: boolean; latencyMs?: number; error?: string; status?: string; detail?: string;
}
export interface ModelStat { model: string; wins: number; passes: number; passRate: number; totalStake: number; }
export interface BalanceDelta { model: string; before: number; after: number; settlement: number; tax: number; }
export interface BenchReport { runId: string; results: BenchTaskResult[]; modelStats: ModelStat[]; balanceDeltas: BalanceDelta[]; }

export function renderBenchReport(r: BenchReport): string {
  const L: string[] = [];
  L.push(`Arena Bench: ${r.runId}`);
  L.push("");
  L.push("── 逐题 ──");
  for (const t of r.results) {
    if (t.status === "routing_fallback") { L.push(`  ${t.task_id}  [routing_fallback: ${t.detail}]`); continue; }
    const mark = t.passed ? "✅ pass" : "❌ fail";
    L.push(`  ${t.task_id}  ${(t.model ?? "?").padEnd(36)}  stake=${String(t.stake ?? 0).padStart(5)}  ${mark}  (${t.latencyMs ?? 0}ms)${t.error ? "  " + t.error : ""}`);
  }
  L.push("");
  L.push("── 模型统计 ──");
  for (const m of r.modelStats) L.push(`  ${m.model.padEnd(36)}  wins=${m.wins} passes=${m.passes} passRate=${(m.passRate * 100).toFixed(0)}% totalStake=${m.totalStake}`);
  L.push("");
  L.push("── 余额变化（settlement 与 opt-out tax 分列）──");
  for (const b of r.balanceDeltas) L.push(`  ${b.model.padEnd(36)}  ${b.before} → ${b.after}  (settlement=${b.settlement >= 0 ? "+" : ""}${b.settlement}, tax=${b.tax})`);
  return L.join("\n");
}

export function writeBenchJson(dir: string, r: BenchReport): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.runId}.json`);
  writeFileSync(file, JSON.stringify(r, null, 2));
  return file;
}
