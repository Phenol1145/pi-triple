import type { DatabaseSync } from "node:sqlite";
import type { ModelInfo } from "../types.ts";
import type { AgentId, ArenaTask, CreditTx, EndowmentPolicy, Ledger, MarketTaskRow } from "./types.ts";

const ARENA_SCHEMA = `
CREATE TABLE IF NOT EXISTS credits (
  agent TEXT PRIMARY KEY, balance REAL NOT NULL, frozen REAL NOT NULL DEFAULT 0, template_id TEXT, updated_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, delta REAL NOT NULL,
  reason TEXT, task_id TEXT, round INTEGER, agent_turn INTEGER, template_id TEXT
);
CREATE TABLE IF NOT EXISTS market_tasks (
  task_id TEXT PRIMARY KEY, round INTEGER, role TEXT, prompt TEXT, difficulty TEXT,
  odds REAL, reward REAL, winner TEXT, winner_model TEXT, stake REAL, status TEXT, created_ts INTEGER, template_id TEXT
);
CREATE TABLE IF NOT EXISTS market_meta ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS arena_freezes (
  task_id TEXT PRIMARY KEY, agent TEXT NOT NULL, amount REAL NOT NULL, created_ts INTEGER NOT NULL
);
`;

export class SqliteLedger implements Ledger {
  private db: DatabaseSync;
  private endowment: EndowmentPolicy;
  constructor(db: DatabaseSync, endowment: EndowmentPolicy, resolveAgentId?: (v: string) => string | undefined) {
    this.db = db;
    this.endowment = endowment;
    this.db.exec(ARENA_SCHEMA);
    this._applyArenaMigrations();
    if (resolveAgentId) this.runMigration(resolveAgentId);
  }
  /** Add template_id columns to existing DBs (idempotent). */
  private _applyArenaMigrations(): void {
    for (const table of ["credits", "credit_tx", "market_tasks"]) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "template_id")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN template_id TEXT`);
      }
    }
  }
  private now(): number { return Date.now(); }
  /** 迁移 credits/credit_tx/market_tasks/arena_freezes 的 agent 字段从 model id → UUID（幂等） */
  private runMigration(resolveAgentId: (v: string) => string | undefined): void {
    const plans: Array<{ table: string; col: string; pkCol: string }> = [
      { table: "credits",  col: "agent",  pkCol: "agent" },
      { table: "credit_tx", col: "agent",  pkCol: "id" },
      { table: "market_tasks", col: "winner", pkCol: "task_id" },
      { table: "arena_freezes", col: "agent",  pkCol: "task_id" },
    ];
    for (const { table, col, pkCol } of plans) {
      const rows = this.db.prepare(`SELECT ${pkCol} AS pk, ${col} AS agent FROM ${table}`).all() as { pk: number | string; agent: string }[];
      for (const row of rows) {
        const uuid = resolveAgentId(row.agent);
        if (uuid !== undefined && uuid !== row.agent) {
          this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${pkCol} = ?`).run(uuid, row.pk);
        }
      }
    }
  }
  /** 迁移（公开，供启动时调用） */
  migrateAgentKeys(resolveAgentId: (v: string) => string | undefined): void {
    this.runMigration(resolveAgentId);
  }
  private ensureRow(a: AgentId, templateId?: string): void {
    if (!this.db.prepare(`SELECT agent FROM credits WHERE agent = ?`).get(a)) {
      this.db.prepare(`INSERT INTO credits (agent, balance, frozen, template_id, updated_ts) VALUES (?, 0, 0, ?, ?)`).run(a, templateId ?? null, this.now());
    }
  }
  private recordTx(a: AgentId, delta: number, reason: string, taskId?: string, round?: number, templateId?: string): void {
    this.db.prepare(`INSERT INTO credit_tx (ts, agent, delta, reason, task_id, round, agent_turn, template_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.now(), a, delta, reason, taskId ?? null, round ?? null, this.agentTurn(a), templateId ?? null);
  }
  balance(a: AgentId): number {
    const row = this.db.prepare(`SELECT balance FROM credits WHERE agent = ?`).get(a) as { balance: number } | undefined;
    return row?.balance ?? 0;
  }
  /** 删除账户（装配回滚/清理用）。不存在 → no-op。 */
  removeAccount(a: AgentId): void {
    this.db.prepare(`DELETE FROM credits WHERE agent = ?`).run(a);
  }
  ensureEndowed(a: AgentId, m: ModelInfo, templateId?: string): void {
    if (this.db.prepare(`SELECT agent FROM credits WHERE agent = ?`).get(a)) return;
    const initial = this.endowment.initialCredits(m);
    this.db.prepare(`INSERT INTO credits (agent, balance, frozen, template_id, updated_ts) VALUES (?, ?, 0, ?, ?)`).run(a, initial, templateId ?? null, this.now());
    this.recordTx(a, initial, "endowment", undefined, this.currentRound(), templateId);
  }
  credit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number, templateId?: string): void {
    this.ensureRow(a, templateId);
    this.db.prepare(`UPDATE credits SET balance = balance + ?, updated_ts = ? WHERE agent = ?`).run(amt, this.now(), a);
    this.recordTx(a, amt, reason, taskId, round, templateId);
  }
  debit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number, templateId?: string): void {
    this.ensureRow(a, templateId);
    const actual = Math.min(amt, Math.max(0, this.balance(a)));
    this.db.prepare(`UPDATE credits SET balance = balance - ?, updated_ts = ? WHERE agent = ?`).run(actual, this.now(), a);
    this.recordTx(a, -actual, reason, taskId, round, templateId);
  }
  freeze(a: AgentId, amt: number, taskId: string): boolean {
    this.ensureRow(a);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // INSERT OR IGNORE: idempotent — if the same taskId is already frozen, skip the atomic guard.
      const ins = this.db.prepare(`INSERT OR IGNORE INTO arena_freezes (task_id, agent, amount, created_ts) VALUES (?, ?, ?, ?)`);
      const insResult = ins.run(taskId, a, amt, this.now());
      if (insResult.changes === 0) {
        this.db.exec("COMMIT");
        return true; // already frozen, idempotent success
      }
      // Atomic guard: only deduct if balance is sufficient.
      const upd = this.db.prepare(`UPDATE credits SET balance = balance - ?, frozen = frozen + ?, updated_ts = ? WHERE agent = ? AND balance >= ?`);
      const updResult = upd.run(amt, amt, this.now(), a, amt);
      if (updResult.changes === 0) {
        // Insufficient balance — roll back the entire transaction (including the INSERT).
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  unfreeze(a: AgentId, taskId: string): number {
    // 单事务包裹（M-R4-3）：SELECT→UPDATE→DELETE 原子，崩溃/异常不产生部分状态。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const freezeRow = this.db.prepare(`SELECT amount FROM arena_freezes WHERE task_id = ?`).get(taskId) as { amount: number } | undefined;
      if (!freezeRow) {
        this.db.exec("COMMIT");
        return 0; // idempotent: no freeze row
      }
      const amt = freezeRow.amount;
      // Unfreeze: add back to balance, subtract from frozen (clamped ≥ 0).
      this.db.prepare(`UPDATE credits SET balance = balance + ?, frozen = MAX(frozen - ?, 0), updated_ts = ? WHERE agent = ?`).run(amt, amt, this.now(), a);
      this.db.prepare(`DELETE FROM arena_freezes WHERE task_id = ?`).run(taskId);
      this.db.exec("COMMIT");
      return amt;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  leaderboard(): { agent: AgentId; balance: number }[] {
    const rows = this.db.prepare(`SELECT agent, balance FROM credits ORDER BY balance DESC, agent ASC`).all() as { agent: string; balance: number }[];
    return rows.map((r) => ({ agent: r.agent, balance: r.balance }));
  }
  history(a?: AgentId, limit = 100): CreditTx[] {
    const rows = a
      ? this.db.prepare(`SELECT id, ts, agent, delta, reason, task_id AS taskId, round, agent_turn AS agentTurn FROM credit_tx WHERE agent = ? ORDER BY id DESC LIMIT ?`).all(a, limit)
      : this.db.prepare(`SELECT id, ts, agent, delta, reason, task_id AS taskId, round, agent_turn AS agentTurn FROM credit_tx ORDER BY id DESC LIMIT ?`).all(limit);
    return rows as CreditTx[];
  }
  currentRound(): number {
    const row = this.db.prepare(`SELECT value FROM market_meta WHERE key = 'current_round'`).get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }
  nextRound(): number {
    const next = this.currentRound() + 1;
    this.db.prepare(`INSERT INTO market_meta (key, value) VALUES ('current_round', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
    return next;
  }
  agentTurn(a: AgentId): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM market_tasks WHERE winner = ? AND status = 'settled'`).get(a) as { n: number };
    return Number(row.n);
  }
  createTask(t: ArenaTask, winner: AgentId, stake: number, round: number, modelId: string, templateId?: string): void {
    this.db.prepare(`INSERT INTO market_tasks (task_id, round, role, prompt, difficulty, odds, reward, winner, winner_model, stake, status, created_ts, template_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(t.id, round, t.role, t.prompt, String(t.difficulty), t.odds, t.reward, winner, modelId, stake, this.now(), templateId ?? null);
  }
  getTask(taskId: string): MarketTaskRow | undefined {
    const row = this.db.prepare(`SELECT task_id AS taskId, role, prompt, difficulty, odds, reward, winner, winner_model AS winnerModel, stake, status, round, template_id AS templateId FROM market_tasks WHERE task_id = ?`).get(taskId);
    return row as MarketTaskRow | undefined;
  }
  setTaskStatus(taskId: string, status: string): void {
    this.db.prepare(`UPDATE market_tasks SET status = ? WHERE task_id = ?`).run(status, taskId);
  }
  staleTasks(timeoutMs: number): MarketTaskRow[] {
    const cutoff = this.now() - timeoutMs;
    const rows = this.db.prepare(`SELECT task_id AS taskId, role, prompt, difficulty, odds, reward, winner, winner_model AS winnerModel, stake, status, round, template_id AS templateId FROM market_tasks WHERE status = 'pending' AND created_ts < ?`).all(cutoff);
    return rows as MarketTaskRow[];
  }
  recoverStaleTask(taskId: string): void {
    const row = this.getTask(taskId);
    if (!row || row.status !== "pending") return;
    this.unfreeze(row.winner, taskId);
    this.setTaskStatus(taskId, "failed");
  }
  countSettledByTemplate(templateId: string, excludeTaskId?: string): number {
    if (excludeTaskId) {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM market_tasks WHERE template_id = ? AND status = 'settled' AND task_id != ?`
      ).get(templateId, excludeTaskId) as { n: number };
      return Number(row.n);
    }
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM market_tasks WHERE template_id = ? AND status = 'settled'`
    ).get(templateId) as { n: number };
    return Number(row.n);
  }

  reconcileFrozenResidue(): { agent: string; frozenBefore: number }[] {
    const rows = this.db.prepare(
      `SELECT agent, frozen FROM credits WHERE frozen > 0 AND agent NOT IN (SELECT agent FROM arena_freezes)`,
    ).all() as { agent: string; frozen: number }[];

    const result: { agent: string; frozenBefore: number }[] = [];
    for (const row of rows) {
      const { agent, frozen: frozenBefore } = row;
      // Return frozen to balance and zero the frozen column.
      this.db.prepare(
        `UPDATE credits SET balance = balance + ?, frozen = 0, updated_ts = ? WHERE agent = ?`,
      ).run(frozenBefore, this.now(), agent);
      // Compensating credit_tx: delta=0, reason carries frozenBefore for audit.
      this.recordTx(agent, 0, `migration-reconcile frozenBefore=${frozenBefore}`);
      result.push({ agent, frozenBefore });
    }
    return result;
  }
}
