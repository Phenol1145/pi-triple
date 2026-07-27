import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CORE_SCHEMA);
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

    return "inserted";
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
