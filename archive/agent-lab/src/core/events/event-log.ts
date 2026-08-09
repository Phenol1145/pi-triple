import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { CORE_SCHEMA } from "../storage/schema.ts";
import type { LabEvent } from "../contracts.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function contentHash(event: LabEvent): string {
  const obj = canonical(event as unknown as Record<string, unknown>);
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

export class EventLog {
  private readonly db: DatabaseSync;
  private readonly appendHooks: Array<(event: LabEvent) => void> = [];
  private notifying = false;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CORE_SCHEMA);
  }

  /**
   * append 旁路通知（F/WP5 §6.2——订阅派发器接线点）。
   * 不改变 append-only 语义：hook 仅在新事件插入成功后同步触发；
   * hook 抛错仅记日志+审计（评审 I4），不阻断 append 主路径。
   * 返回注销函数。
   */
  onAppended(hook: (event: LabEvent) => void): () => void {
    this.appendHooks.push(hook);
    return () => {
      const i = this.appendHooks.indexOf(hook);
      if (i >= 0) this.appendHooks.splice(i, 1);
    };
  }

  append(event: LabEvent): "inserted" | "duplicate" {
    const hash = contentHash(event);

    const existing = this.db.prepare(
      "SELECT content_hash FROM lab_events WHERE event_id = ?",
    ).get(event.eventId) as { content_hash: string } | undefined;

    if (existing) {
      if (existing.content_hash !== hash) {
        throw new Error(`event id conflict: ${event.eventId}`);
      }
      return "duplicate";
    }

    this.db.prepare(
      `INSERT INTO lab_events
       (event_id, event_type, schema_version, ts, sequence,
        trace_id, identity_json, payload_json, metrics_json, artifact_refs_json, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      event.eventType,
      event.schemaVersion,
      event.timestamp,
      event.sequence ?? null,
      event.identity.traceId,
      JSON.stringify(event.identity),
      JSON.stringify(event.payload),
      JSON.stringify(event.metrics ?? null),
      JSON.stringify(event.artifactRefs ?? null),
      hash,
    );

    this.notifyAppended(event);

    return "inserted";
  }

  private notifyAppended(event: LabEvent): void {
    if (this.notifying) return; // 审计事件不再递归通知
    this.notifying = true;
    try {
      for (const hook of [...this.appendHooks]) {
        try {
          hook(event);
        } catch (err) {
          // 评审 I4: hook 异常仅记日志+审计，不阻断 append 主路径
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `event-log: subscription notify hook failed (event=${event.eventId}): ${message}`,
          );
          try {
            this.append({
              eventId: `subscription.notify.failed:${event.eventId}:${randomUUID().slice(0, 8)}`,
              eventType: "subscription.notify.failed",
              schemaVersion: "1",
              timestamp: Date.now(),
              identity: { traceId: event.identity.traceId },
              payload: { eventId: event.eventId, error: message },
            });
          } catch {
            // 审计失败也忽略——主路径不变量优先
          }
        }
      }
    } finally {
      this.notifying = false;
    }
  }

  get(eventId: string): LabEvent | undefined {
    const row = this.db.prepare(
      `SELECT event_id, event_type, schema_version, ts, sequence,
              trace_id, identity_json, payload_json, metrics_json, artifact_refs_json
       FROM lab_events WHERE event_id = ?`,
    ).get(eventId) as {
      event_id: string;
      event_type: string;
      schema_version: string;
      ts: number;
      sequence: number | null;
      trace_id: string;
      identity_json: string;
      payload_json: string;
      metrics_json: string;
      artifact_refs_json: string;
    } | undefined;

    if (!row) return undefined;

    return {
      eventId: row.event_id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      timestamp: row.ts,
      sequence: row.sequence ?? undefined,
      identity: JSON.parse(row.identity_json) as LabEvent["identity"],
      payload: JSON.parse(row.payload_json) as unknown,
      metrics: JSON.parse(row.metrics_json) as LabEvent["metrics"] ?? undefined,
      artifactRefs: JSON.parse(row.artifact_refs_json) as string[] ?? undefined,
    };
  }

  query(filter: {
    traceId?: string;
    tenantId?: string;
    eventType?: string;
    schedulerInstanceId?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): LabEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 10000);

    const conditions: string[] = [];
    const params: string[] = [];

    if (filter.traceId) {
      conditions.push("trace_id = ?");
      params.push(filter.traceId);
    }
    if (filter.tenantId) {
      // 评审 WP5-R2 I-1：跨租户事件隔离——按 identity_json 的 tenantId 过滤
      conditions.push("json_extract(identity_json, '$.tenantId') = ?");
      params.push(filter.tenantId);
    }
    if (filter.eventType) {
      conditions.push("event_type = ?");
      params.push(filter.eventType);
    }
    if (filter.schedulerInstanceId) {
      conditions.push("json_extract(identity_json, '$.schedulerInstanceId') = ?");
      params.push(filter.schedulerInstanceId);
    }
    if (filter.since != null) {
      conditions.push("ts >= ?");
      params.push(String(filter.since));
    }
    if (filter.until != null) {
      conditions.push("ts < ?");
      params.push(String(filter.until));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT event_id FROM lab_events ${where}
                 ORDER BY ts ASC, event_id ASC
                 LIMIT ?`;
    params.push(String(limit));

    const rows = this.db.prepare(sql).all(...params) as Array<{
      event_id: string;
    }>;

    return rows
      .map((r) => this.get(r.event_id))
      .filter((e): e is LabEvent => e !== undefined);
  }
}
