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

/**
 * machine 转移序列 trace provider — 读 agent-lab lab_events 的 machine.transition 事件。
 * identity_json 含 traceId/agentInstanceId/transitionSeq/checkpointId（spec §7.2 / 健康审计 F1）；
 * payload_json 含 fromState/toState/eventType/checkpointId。
 */
export function createMachineTraceProvider(dbOverride?: DatabaseSync): TraceProvider {
  const openDb = (): DatabaseSync | null => dbOverride ?? openReadOnlyOrNull(sharedDbPath());

  function transitionRecords(db: DatabaseSync, extraWhere: string, params: any[]): TraceRecord[] {
    try {
      const rows = db.prepare(
        `SELECT event_id, ts, trace_id, identity_json, payload_json FROM lab_events
         WHERE event_type = 'machine.transition' ${extraWhere}
         ORDER BY ts DESC LIMIT 200`,
      ).all(...params) as any[];
      return rows.flatMap((r) => {
        try {
          const identity = JSON.parse(r.identity_json);
          const payload = JSON.parse(r.payload_json);
          // 容错：字段缺失（transitionSeq/fromState/toState/eventType）→ 跳过该行
          if (identity.transitionSeq == null || payload.fromState == null || payload.toState == null || payload.eventType == null) return [];
          const traceId = identity.traceId ?? r.trace_id;
          return [{
            id: `${traceId}:${identity.transitionSeq}`,
            kind: "trace" as const,
            workloop: "machine",
            templateId: "",
            timestamp: new Date(r.ts).toISOString(),
            summary: `转移 #${identity.transitionSeq}: ${payload.fromState}→${payload.toState} · ${payload.eventType}`,
            detail: {
              fromState: payload.fromState,
              toState: payload.toState,
              eventType: payload.eventType,
              checkpointId: payload.checkpointId ?? "",
              traceId,
              agent: identity.agentInstanceId ?? "",
            },
          }];
        } catch { return []; }
      });
    } catch { return []; }
  }

  return {
    workloop: "machine",
    list(): TraceRecord[] {
      const db = openDb();
      if (!db) return [];
      try {
        return transitionRecords(db, "", []);
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
        // identity_json 是 JSON 字符串，LIKE 匹配 agentInstanceId 可行（P5 量级扫描可接受）
        return transitionRecords(db, `AND identity_json LIKE ?`, [`%"agentInstanceId":"${agentId}"%`]);
      } finally {
        if (!dbOverride) db.close();
      }
    },
  };
}

export function registerMachineTraceProvider(): void {
  registerTraceProvider(createMachineTraceProvider());
}
