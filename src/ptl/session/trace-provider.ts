import type { DatabaseSync } from "node:sqlite";
import type { TraceProvider, TraceRecord } from "./session-provider.js";
import { sharedDbPath, openReadOnlyOrNull } from "../lab-data/open-db.js";
import { registerTraceProvider } from "./session-store.js";

export function createBiddingTraceProvider(dbOverride?: DatabaseSync): TraceProvider {
  const openDb = (): DatabaseSync | null => dbOverride ?? openReadOnlyOrNull(sharedDbPath());

  function creditTxRecords(db: DatabaseSync): TraceRecord[] {
    try {
      const rows = db.prepare(`SELECT id, ts, agent, delta, reason, task_id FROM credit_tx ORDER BY ts DESC LIMIT 200`).all() as any[];
      return rows.map((r) => ({
        id: String(r.id),
        kind: "trace" as const,
        workloop: "bidding",
        templateId: "",
        timestamp: new Date(r.ts).toISOString(),
        summary: `credit ${r.delta > 0 ? "+" : ""}${r.delta} · ${r.agent} · ${r.reason ?? "tx"}${r.task_id ? ` · ${r.task_id}` : ""}`,
        detail: { "agent": r.agent, "delta": String(r.delta), "reason": r.reason ?? "", "task": r.task_id ?? "" },
      }));
    } catch { return []; }
  }

  function taskRecords(db: DatabaseSync): TraceRecord[] {
    try {
      const rows = db.prepare(`SELECT task_id, role, winner, stake, status, created_ts, template_id FROM market_tasks ORDER BY created_ts DESC LIMIT 100`).all() as any[];
      return rows.map((r) => ({
        id: r.task_id,
        kind: "trace" as const,
        workloop: "bidding",
        templateId: r.template_id ?? "",
        timestamp: new Date(r.created_ts).toISOString(),
        summary: `task ${r.status} · role=${r.role} · winner=${r.winner ?? "-"} · stake=${r.stake ?? "-"}`,
        detail: { "role": r.role, "winner": r.winner ?? "-", "stake": String(r.stake ?? "-"), "status": r.status },
      }));
    } catch { return []; }
  }

  function runRecords(db: DatabaseSync): TraceRecord[] {
    try {
      const rows = db.prepare(`SELECT id, ts, role, model, completion, trace_id, template_id FROM runs WHERE source = 'bidding' ORDER BY ts DESC LIMIT 100`).all() as any[];
      return rows.map((r) => ({
        id: `run-${r.id}`,
        kind: "trace" as const,
        workloop: "bidding",
        templateId: r.template_id ?? "",
        timestamp: new Date(r.ts).toISOString(),
        summary: `run role=${r.role} · ${r.model} · completion=${r.completion}`,
        detail: { "role": r.role, "model": r.model, "completion": String(r.completion), "trace_id": r.trace_id ?? "" },
      }));
    } catch { return []; }
  }

  return {
    workloop: "bidding",
    list(): TraceRecord[] {
      const db = openDb();
      if (!db) return [];
      try {
        return [...creditTxRecords(db), ...taskRecords(db), ...runRecords(db)].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      } finally {
        if (!dbOverride) db.close();
      }
    },
    show(r: TraceRecord): string {
      return [`Trace ${r.id}`, `WorkLoop: ${r.workloop}`, `时间: ${r.timestamp}`, ...Object.entries(r.detail).map(([k, v]) => `${k}: ${v}`)].join("\n");
    },
    timeline(agentId: string): TraceRecord[] {
      const db = openDb();
      if (!db) return [];
      try {
        const txRows = db.prepare(`SELECT id, ts, agent, delta, reason, task_id FROM credit_tx WHERE agent = ? ORDER BY ts DESC LIMIT 200`).all(agentId) as any[];
        const tx = txRows.map((r) => ({
          id: r.id, kind: "trace" as const, workloop: "bidding", templateId: "",
          timestamp: new Date(r.ts).toISOString(),
          summary: `credit ${r.delta > 0 ? "+" : ""}${r.delta} · ${r.reason ?? "tx"}`,
          detail: { agent: agentId, delta: String(r.delta), reason: r.reason ?? "" },
        }));
        const taskRows = db.prepare(`SELECT task_id, role, winner, stake, status, created_ts, template_id FROM market_tasks WHERE winner = ? ORDER BY created_ts DESC LIMIT 100`).all(agentId) as any[];
        const tasks = taskRows.map((r) => ({
          id: r.task_id, kind: "trace" as const, workloop: "bidding", templateId: r.template_id ?? "",
          timestamp: new Date(r.created_ts).toISOString(),
          summary: `task ${r.status} · role=${r.role} · stake=${r.stake ?? "-"}`,
          detail: { role: r.role, status: r.status, stake: String(r.stake ?? "-") },
        }));
        return [...tx, ...tasks].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      } finally {
        if (!dbOverride) db.close();
      }
    },
  };
}

export function registerBiddingTraceProvider(): void {
  registerTraceProvider(createBiddingTraceProvider());
}
