import type { DatabaseSync } from "node:sqlite";
import type { ModelInfo } from "../types.ts";
import type { AgentId, ArenaTask, CreditTx, EndowmentPolicy, Ledger, MarketTaskRow } from "./types.ts";
import { withSharedTransaction } from "../core/tx-utils.ts";

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
  task_id TEXT NOT NULL, agent TEXT NOT NULL, amount REAL NOT NULL, created_ts INTEGER NOT NULL,
  PRIMARY KEY (task_id, agent)
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
    this._migrateArenaFreezesCompositeKey();
  }
  /** 将旧版 arena_freezes（task_id 单列主键）迁移为 (task_id, agent) 复合主键（Task 9）。 */
  private _migrateArenaFreezesCompositeKey(): void {
    const exists = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'arena_freezes'`).get() as { name: string } | undefined;
    if (!exists) return;
    const cols = this.db.prepare(`PRAGMA table_info(arena_freezes)`).all() as Array<{ name: string; pk: number }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    if (pkCols.length === 1 && pkCols[0] === "task_id") {
      // 构造期一次性迁移——此时无活跃事务，withSharedTransaction 与裸 BEGIN 等价；
      // 统一用协调器（与 ledger.transaction 一致，消除"同文件两轨"疑惑）。
      withSharedTransaction(this.db, () => {
        this.db.exec(`ALTER TABLE arena_freezes RENAME TO arena_freezes_old`);
        this.db.exec(`CREATE TABLE arena_freezes (
          task_id TEXT NOT NULL, agent TEXT NOT NULL, amount REAL NOT NULL, created_ts INTEGER NOT NULL,
          PRIMARY KEY (task_id, agent)
        )`);
        this.db.exec(`INSERT OR IGNORE INTO arena_freezes (task_id, agent, amount, created_ts)
          SELECT task_id, agent, amount, created_ts FROM arena_freezes_old`);
        this.db.exec(`DROP TABLE arena_freezes_old`);
      });
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
          this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${pkCol} = ? AND ${col} = ?`).run(uuid, row.pk, row.agent);
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
  /**
   * 复用版事务包装：已在事务中则直接执行（嵌套复用）；否则 BEGIN/COMMIT/ROLLBACK。
   * 与 SqliteVoucher（buy/burn）共享同一 db 的事务状态——市场结算 effect 的整体原子性用。
   */
  transaction<T>(fn: () => T): T {
    return withSharedTransaction(this.db, fn);
  }
  /**
   * 借记但不夹紧到 [0, balance]：允许负余额。用于池/系统内部资金路径（central-pool 等）。
   * 单事务包裹；金额可以为任意非负数（调用方校验）。
   */
  debitUnclamped(a: AgentId, amt: number, reason: string, taskId?: string, round?: number, templateId?: string): void {
    this.transaction(() => {
      this.ensureRow(a, templateId);
      this.db.prepare(`UPDATE credits SET balance = balance - ?, updated_ts = ? WHERE agent = ?`).run(amt, this.now(), a);
      this.recordTx(a, -amt, reason, taskId, round, templateId);
    });
  }
  /**
   * 冻结指定账户的信用额以锁定任务 stake。
   * 使用 INSERT OR IGNORE 实现幂等：同 (taskId, agent) 二次调用时，即使金额不同
   * 也会静默忽略、不更新金额，并返回 true。若需变更冻结金额，必须调用 adjustFreeze。
   */
  freeze(a: AgentId, amt: number, taskId: string): boolean {
    this.ensureRow(a);
    try {
      return this.transaction(() => {
        // INSERT OR IGNORE: idempotent — if the same taskId is already frozen, skip the atomic guard.
        const ins = this.db.prepare(`INSERT OR IGNORE INTO arena_freezes (task_id, agent, amount, created_ts) VALUES (?, ?, ?, ?)`);
        const insResult = ins.run(taskId, a, amt, this.now());
        if (insResult.changes === 0) {
          return true; // already frozen, idempotent success
        }
        // Atomic guard: only deduct if balance is sufficient.
        const upd = this.db.prepare(`UPDATE credits SET balance = balance - ?, frozen = frozen + ?, updated_ts = ? WHERE agent = ? AND balance >= ?`);
        const updResult = upd.run(amt, amt, this.now(), a, amt);
        if (updResult.changes === 0) {
          // Insufficient balance — throw triggers ROLLBACK (incl. the INSERT), caught below → false.
          throw Object.assign(new Error("freeze: insufficient balance"), { insufficientBalance: true });
        }
        return true;
      });
    } catch (e) {
      if ((e as { insufficientBalance?: boolean }).insufficientBalance) {
        return false;
      }
      throw e;
    }
  }
  unfreeze(a: AgentId, taskId: string): number {
    // 单事务包裹（M-R4-3）：SELECT→UPDATE→DELETE 原子，崩溃/异常不产生部分状态。
    return this.transaction(() => {
      const freezeRow = this.db.prepare(`SELECT amount FROM arena_freezes WHERE task_id = ? AND agent = ?`).get(taskId, a) as { amount: number } | undefined;
      if (!freezeRow) {
        return 0; // idempotent: no freeze row
      }
      const amt = freezeRow.amount;
      // Unfreeze: add back to balance, subtract from frozen (clamped ≥ 0).
      this.db.prepare(`UPDATE credits SET balance = balance + ?, frozen = MAX(frozen - ?, 0), updated_ts = ? WHERE agent = ?`).run(amt, amt, this.now(), a);
      this.db.prepare(`DELETE FROM arena_freezes WHERE task_id = ? AND agent = ?`).run(taskId, a);
      return amt;
    });
  }
  /**
   * 将已有的冻结额原子调整为 newAmount（ Task 9 escrow 两阶段用）。
   * 返回实际解冻/追加的数额：正数 = 解冻返回余额；负数 = 追加冻结。
   * 不存在冻结行或余额不足以追加时抛错。
   */
  adjustFreeze(a: AgentId, taskId: string, newAmount: number): number {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT amount FROM arena_freezes WHERE task_id = ? AND agent = ?`).get(taskId, a) as { amount: number } | undefined;
      if (!row) {
        throw new Error(`adjustFreeze: no freeze row for agent=${a} task=${taskId}`);
      }
      const oldAmount = row.amount;
      if (newAmount === oldAmount) {
        return 0;
      }
      if (newAmount > oldAmount) {
        const extra = newAmount - oldAmount;
        const upd = this.db.prepare(`UPDATE credits SET balance = balance - ?, frozen = frozen + ?, updated_ts = ? WHERE agent = ? AND balance >= ?`);
        const updResult = upd.run(extra, extra, this.now(), a, extra);
        if (updResult.changes === 0) {
          throw new Error(`adjustFreeze: insufficient balance to increase freeze for agent=${a} task=${taskId}`);
        }
        this.db.prepare(`UPDATE arena_freezes SET amount = ? WHERE task_id = ? AND agent = ?`).run(newAmount, taskId, a);
        return -extra;
      }
      const delta = oldAmount - newAmount;
      this.db.prepare(`UPDATE credits SET balance = balance + ?, frozen = MAX(frozen - ?, 0), updated_ts = ? WHERE agent = ?`).run(delta, delta, this.now(), a);
      this.db.prepare(`UPDATE arena_freezes SET amount = ? WHERE task_id = ? AND agent = ?`).run(newAmount, taskId, a);
      return delta;
    });
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
