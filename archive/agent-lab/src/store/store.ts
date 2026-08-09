import { DatabaseSync } from "node:sqlite";
import type { Aggregate, RunRecord } from "../types.ts";
import { SCHEMA, MIGRATIONS } from "./schema.ts";

export interface Store {
  appendRun(r: RunRecord): void;
  aggregateByRole(role: string, templateId?: string): Aggregate[];
  listRoles(templateId?: string): string[];
  getPin(role: string): string | undefined;
  setPin(role: string, model: string): void;
  clearPin(role: string): void;
  getConfig(): Record<string, string>;
  setConfig(key: string, value: string): void;
  close(): void;
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(SCHEMA);
    this._applyMigrations();
  }
  private _applyMigrations(): void {
    // Current schema version tracked via PRAGMA user_version
    const currentVersionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    const currentVersion = currentVersionRow?.user_version ?? 0;
    for (const [ver, sql] of MIGRATIONS) {
      if (ver > currentVersion) {
        // Check if column already exists before ALTER (idempotent for edge cases)
        if (sql.startsWith("ALTER TABLE")) {
          // ADD COLUMN 幂等
          const m = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
          if (m) {
            const cols = this.db.prepare(`PRAGMA table_info(${m[1]})`).all() as Array<{ name: string }>;
            if (cols.some((c) => c.name === m[2])) continue;
          }
          // RENAME COLUMN 幂等：新列已存在则跳过
          const rn = sql.match(/ALTER TABLE (\w+) RENAME COLUMN (\w+) TO (\w+)/);
          if (rn) {
            const cols = this.db.prepare(`PRAGMA table_info(${rn[1]})`).all() as Array<{ name: string }>;
            if (cols.some((c) => c.name === rn[3])) {
              this.db.exec(`PRAGMA user_version = ${ver}`);
              continue;
            }
          }
        }
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${ver}`);
      }
    }
  }
  get raw(): DatabaseSync { return this.db; }
  appendRun(r: RunRecord): void {
    this.db.prepare(
      `INSERT INTO runs (ts, role, model, task_category, acceptance, completion, tokens_in, tokens_out, cost, tool_success, turns, interrupted, signals, source, trace_id, template_id, session_id, agent_instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      r.ts, r.role, r.model, r.taskCategory ?? null, r.acceptance ?? null, r.completion,
      r.tokensIn ?? null, r.tokensOut ?? null, r.cost ?? null, r.toolSuccess ?? null,
      r.turns ?? null, r.interrupted ?? null, JSON.stringify(r.signals ?? {}), r.source,
      r.traceId ?? null, r.templateId ?? null, r.sessionId ?? null, r.agentInstanceId ?? null
    );
  }
  aggregateByRole(role: string, templateId?: string): Aggregate[] {
    let sql = `SELECT model, role, COUNT(*) AS runs, AVG(completion) AS avgCompletion,
              AVG(COALESCE(cost, 0)) AS avgCost, AVG(COALESCE(tool_success, 1)) AS successRate
       FROM runs WHERE role = ?`;
    const params: (string | number)[] = [role];
    if (templateId) {
      sql += ` AND (template_id = ? OR template_id IS NULL)`;
      params.push(templateId);
    }
    sql += ` GROUP BY model, role`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, number | string>>;
    return rows.map((row) => ({
      model: String(row.model),
      role: String(row.role),
      runs: Number(row.runs),
      avgCompletion: Number(row.avgCompletion),
      avgCost: Number(row.avgCost),
      successRate: Number(row.successRate),
    }));
  }
  listRoles(templateId?: string): string[] {
    let sql = `SELECT DISTINCT role FROM runs`;
    const params: string[] = [];
    if (templateId) {
      sql += ` WHERE template_id = ? OR template_id IS NULL`;
      params.push(templateId);
    }
    sql += ` ORDER BY role`;
    const rows = this.db.prepare(sql).all(...params) as Array<{ role: string }>;
    return rows.map((r) => r.role);
  }
  getPin(role: string): string | undefined {
    const row = this.db.prepare(`SELECT model FROM role_pin WHERE role = ?`).get(role) as { model: string } | undefined;
    return row?.model;
  }
  setPin(role: string, model: string): void {
    this.db.prepare(
      `INSERT INTO role_pin (role, model, updated_ts) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET model = excluded.model, updated_ts = excluded.updated_ts`
    ).run(role, model, Date.now());
  }
  clearPin(role: string): void {
    this.db.prepare(`DELETE FROM role_pin WHERE role = ?`).run(role);
  }
  getConfig(): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM config`).all() as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }
  setConfig(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }
  close(): void {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ok */ }
    this.db.close();
  }
}
