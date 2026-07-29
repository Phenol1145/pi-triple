/**
 * lab-data/telemetry — 共享 DB 查询（runs 表）
 */

import type { DatabaseSync } from "node:sqlite";

export interface AggregateRow {
  role: string;
  model: string;
  runs: number;
  avgSuccess: number;
  avgLatency: number;
  totalTokensIn: number;
  totalTokensOut: number;
  avgCost: number;
  toolSuccess: number;
}

export function aggregateByRole(
  db: DatabaseSync,
  role?: string,
  templateId?: string,
  days = 7,
): AggregateRow[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let sql = `
    SELECT
      role,
      model,
      COUNT(*) as runs,
      AVG(CASE WHEN acceptance = 'accepted' THEN 1 ELSE 0 END) as avgSuccess,
      AVG(completion) as avgLatency,
      COALESCE(SUM(tokens_in), 0) as totalTokensIn,
      COALESCE(SUM(tokens_out), 0) as totalTokensOut,
      COALESCE(AVG(cost), 0) as avgCost,
      AVG(CASE WHEN tool_success IS NOT NULL THEN tool_success ELSE NULL END) as toolSuccess
    FROM runs
    WHERE ts > ?
  `;
  const params: (string | number)[] = [cutoff];

  if (role) {
    sql += ` AND role = ?`;
    params.push(role);
  }
  // NULL template_id = pre-migration legacy rows.
  //   - Template-filtered queries (templateId provided): INCLUDE legacy rows (OR template_id IS NULL)
  //     so historic data contributes to per-template stats.
  //   - Global queries (templateId undefined): all rows counted including legacy.
  if (templateId) {
    sql += ` AND (template_id = ? OR template_id IS NULL)`;
    params.push(templateId);
  }

  sql += ` GROUP BY role, model ORDER BY role, runs DESC LIMIT 1000`;

  try {
    return db.prepare(sql).all(...params) as unknown as AggregateRow[];
  } catch {
    return [];
  }
}

export function listRoles(db: DatabaseSync, templateId?: string, days = 7): string[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let sql = `SELECT DISTINCT role FROM runs WHERE ts > ?`;
  const params: (string | number)[] = [cutoff];

  if (templateId) {
    sql += ` AND (template_id = ? OR template_id IS NULL)`;
    params.push(templateId);
  }

  sql += ` ORDER BY role`;

  try {
    const rows = db.prepare(sql).all(...params) as unknown as Array<{ role: string }>;
    return rows.map((r) => r.role);
  } catch {
    return [];
  }
}

export function listModels(db: DatabaseSync): string[] {
  try {
    const rows = db.prepare(`SELECT DISTINCT model FROM runs ORDER BY model`).all() as unknown as Array<{
      model: string;
    }>;
    return rows.map((r) => r.model);
  } catch {
    return [];
  }
}

export interface ComparisonRow {
  metric: string;
  modelA: string;
  modelB: string;
}

export function modelComparison(
  db: DatabaseSync,
  modelA: string,
  modelB: string,
  templateId?: string,
  days = 7,
): ComparisonRow[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: ComparisonRow[] = [];

  const query = (model: string) => {
    let sql = `
      SELECT
        COUNT(*) as runs,
        AVG(CASE WHEN acceptance = 'accepted' THEN 1 ELSE 0 END) as success,
        AVG(completion) as latency,
        COALESCE(AVG(cost), 0) as cost,
        AVG(CASE WHEN tool_success IS NOT NULL THEN tool_success ELSE NULL END) as toolRate
      FROM runs
      WHERE model = ? AND ts > ?
    `;
    const params: (string | number)[] = [model, cutoff];
    if (templateId) {
      sql += ` AND (template_id = ? OR template_id IS NULL)`;
      params.push(templateId);
    }
    return db.prepare(sql).get(...params) as unknown as Record<string, number> | undefined;
  };

  const a = query(modelA);
  const b = query(modelB);

  const fmt = (v: number | undefined | null, suffix = "", decimals = 2) => {
    if (v === undefined || v === null) return "n/a";
    return v.toFixed(decimals) + suffix;
  };

  const fmtPct = (row: Record<string, number> | undefined, field: string) => {
    if (!row || row.runs === 0) return "n/a";
    const v = row[field];
    if (v === undefined || v === null) return "n/a";
    return (v * 100).toFixed(1) + "%";
  };

  const fmtCost = (row: Record<string, number> | undefined) => {
    if (!row || row.runs === 0 || row.cost == null) return "n/a";
    return "$" + row.cost.toFixed(4);
  };

  results.push({ metric: "Runs", modelA: fmt(a?.runs, "", 0), modelB: fmt(b?.runs, "", 0) });
  results.push({ metric: "Success %", modelA: fmtPct(a, "success"), modelB: fmtPct(b, "success") });
  results.push({ metric: "Avg Latency (ms)", modelA: !a || a.runs === 0 ? "n/a" : fmt(a.latency, "ms", 0), modelB: !b || b.runs === 0 ? "n/a" : fmt(b.latency, "ms", 0) });
  results.push({ metric: "Avg Cost/run", modelA: fmtCost(a), modelB: fmtCost(b) });
  results.push({ metric: "Tool Success %", modelA: fmtPct(a, "toolRate"), modelB: fmtPct(b, "toolRate") });

  return results;
}
