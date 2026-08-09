import type { Ledger } from "../arena/types.ts";

export function renderLeaderboard(ledger: Ledger): string {
  const lb = ledger.leaderboard();
  if (lb.length === 0) return "暂无 agent credits。";
  return "Agent credits 排行:\n" + lb.map((r, i) => `${i + 1}. ${r.agent}  ${r.balance.toFixed(2)}`).join("\n");
}

export function renderHistory(ledger: Ledger, agent?: string, limit = 20): string {
  const h = ledger.history(agent, limit);
  if (h.length === 0) return "暂无流水。";
  return h.map((tx) => `[r${tx.round ?? "-"} t${tx.agentTurn ?? "-"}] ${tx.agent} ${tx.delta >= 0 ? "+" : ""}${tx.delta.toFixed(2)} (${tx.reason ?? ""})`).join("\n");
}
