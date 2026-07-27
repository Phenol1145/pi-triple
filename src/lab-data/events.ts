/**
 * lab-data/events — per-tenant DB 查询（调度事件流）
 *
 * 表结构（lab_events）：
 *   event_id, event_type, schema_version, ts, sequence, trace_id,
 *   identity_json, payload_json, metrics_json, artifact_refs_json, content_hash
 */

import type { DatabaseSync } from "node:sqlite";

export interface EventRow {
  eventId: string;
  eventType: string;
  ts: number;
  traceId: string;
  identityJson: string;
  payloadJson: string;
  metricsJson: string;
}

export function getRecentEvents(db: DatabaseSync, limit = 200): EventRow[] {
  try {
    return db
      .prepare(
        `SELECT
          event_id as eventId,
          event_type as eventType,
          ts,
          trace_id as traceId,
          identity_json as identityJson,
          payload_json as payloadJson,
          metrics_json as metricsJson
        FROM lab_events
        ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as unknown as EventRow[];
  } catch {
    return [];
  }
}

export function getEventsByType(db: DatabaseSync, eventType: string, limit = 100): EventRow[] {
  try {
    return db
      .prepare(
        `SELECT
          event_id as eventId,
          event_type as eventType,
          ts,
          trace_id as traceId,
          identity_json as identityJson,
          payload_json as payloadJson,
          metrics_json as metricsJson
        FROM lab_events
        WHERE event_type = ?
        ORDER BY ts DESC LIMIT ?`,
      )
      .all(eventType, limit) as unknown as EventRow[];
  } catch {
    return [];
  }
}

export function getEventTypes(db: DatabaseSync): string[] {
  try {
    const rows = db
      .prepare(`SELECT DISTINCT event_type as eventType FROM lab_events ORDER BY eventType`)
      .all() as unknown as Array<{ eventType: string }>;
    return rows.map((r) => r.eventType);
  } catch {
    return [];
  }
}
