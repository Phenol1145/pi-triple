import type { DatabaseSync } from "node:sqlite";

export type VoucherKind = "llm" | "time" | "compute";
export type BurnCause = { traceId: string; transitionSeq: number } | { periodic: "memory-storage" };
export type BurnRecord = { kind: VoucherKind; units: number; creditCost: number; cause: BurnCause; ts: number };

export interface VoucherPort {
  buy(agentId: string, kind: VoucherKind, units: number): void;
  balance(agentId: string, kind: VoucherKind): number;
  burn(agentId: string, kind: VoucherKind, units: number, cause: BurnCause): void;
  burnHistory(agentId: string, kind: VoucherKind, filter?: { traceId?: string; sinceTs?: number }): BurnRecord[];
}

/** 文档常量（spec §1.3/Global Constraints）：llm 1 unit = 1M tokens；time 1 unit = 3600s；compute 1 unit = 1 GB·天 */
export const VOUCHER_PHYSICAL_ANCHOR = { llm: 1_000_000, time: 3600, compute: 1 } as const;

/** SqliteVoucher 消费的最小账本面：buy 走 debit（agent 付 credit）+ credit（池收 credit）。 */
export type LedgerOps = {
  debit(id: string, amt: number, reason: string): void;
  credit(id: string, amt: number, reason: string): void;
};

const VOUCHER_SCHEMA = `
CREATE TABLE IF NOT EXISTS voucher_balances (
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  units REAL NOT NULL,
  PRIMARY KEY (agent_id, kind)
);
CREATE TABLE IF NOT EXISTS voucher_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  units REAL NOT NULL,
  credit_per_unit REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS voucher_burns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  units REAL NOT NULL,
  credit_cost REAL NOT NULL,
  cause_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`;

/**
 * 与 SqliteLedger 共享同一 DatabaseSync（spec C1）。双层记账：
 * buy = 单事务（credit 预检 → debit agent → credit 池 → 余额+batch 入账）；
 * burn = 单事务（余额预检 → FIFO 批次折算历史成本 → burn 落库）。
 */
export class SqliteVoucher implements VoucherPort {
  private db: DatabaseSync;
  private ledger: LedgerOps;
  private rates: Record<VoucherKind, number>;
  private poolId: string;

  constructor(deps: { db: DatabaseSync; ledger: LedgerOps; rates: { creditPerUnit: Record<VoucherKind, number> }; poolId?: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.rates = deps.rates.creditPerUnit;
    this.poolId = deps.poolId ?? "central-pool";
    this.db.exec(VOUCHER_SCHEMA);
  }

  buy(agentId: string, kind: VoucherKind, units: number): void {
    if (units <= 0) throw new Error("units must be positive");
    const cost = units * this.rates[kind];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // credit 预检：SqliteLedger.debit 夹紧不抛错（欠额静默扣到 0），凭证层必须显式拒绝（spec C1）。
      const row = this.db.prepare(`SELECT balance FROM credits WHERE agent = ?`).get(agentId) as { balance: number } | undefined;
      const balance = row?.balance ?? 0;
      if (balance < cost) {
        throw new Error(`voucher buy: insufficient credit for ${agentId} (need ${cost}, have ${balance})`);
      }
      this.ledger.debit(agentId, cost, `voucher-buy ${kind}`);
      this.ledger.credit(this.poolId, cost, `voucher-buy ${kind}`);
      this.db.prepare(
        `INSERT INTO voucher_balances (agent_id, kind, units) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, kind) DO UPDATE SET units = units + excluded.units`,
      ).run(agentId, kind, units);
      this.db.prepare(
        `INSERT INTO voucher_batches (agent_id, kind, units, credit_per_unit, ts) VALUES (?, ?, ?, ?, ?)`,
      ).run(agentId, kind, units, this.rates[kind], Date.now());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  balance(agentId: string, kind: VoucherKind): number {
    const row = this.db.prepare(`SELECT units FROM voucher_balances WHERE agent_id = ? AND kind = ?`).get(agentId, kind) as { units: number } | undefined;
    return row?.units ?? 0;
  }

  burn(agentId: string, kind: VoucherKind, units: number, cause: BurnCause): void {
    if (units <= 0) throw new Error("units must be positive");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const balRow = this.db.prepare(`SELECT units FROM voucher_balances WHERE agent_id = ? AND kind = ?`).get(agentId, kind) as { units: number } | undefined;
      const bal = balRow?.units ?? 0;
      if (bal < units) {
        throw new Error(`voucher burn: insufficient balance for ${agentId}/${kind} (need ${units}, have ${bal})`);
      }
      // FIFO：最早批次先出（历史成本，spec §1.3）。
      const batches = this.db.prepare(
        `SELECT id, units, credit_per_unit FROM voucher_batches
         WHERE agent_id = ? AND kind = ? AND units > 0 ORDER BY ts ASC, id ASC`,
      ).all(agentId, kind) as Array<{ id: number; units: number; credit_per_unit: number }>;
      let remaining = units;
      let creditCost = 0;
      for (const b of batches) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, b.units);
        creditCost += take * b.credit_per_unit;
        this.db.prepare(`UPDATE voucher_batches SET units = units - ? WHERE id = ?`).run(take, b.id);
        remaining -= take;
      }
      if (remaining > 0) {
        throw new Error(`voucher burn: inconsistent batch state for ${agentId}/${kind}`);
      }
      this.db.prepare(`UPDATE voucher_balances SET units = units - ? WHERE agent_id = ? AND kind = ?`).run(units, agentId, kind);
      this.db.prepare(
        `INSERT INTO voucher_burns (agent_id, kind, units, credit_cost, cause_json, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(agentId, kind, units, creditCost, JSON.stringify(cause), Date.now());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  burnHistory(agentId: string, kind: VoucherKind, filter?: { traceId?: string; sinceTs?: number }): BurnRecord[] {
    let sql = `SELECT kind, units, credit_cost AS creditCost, cause_json, ts FROM voucher_burns WHERE agent_id = ? AND kind = ?`;
    const params: Array<string | number> = [agentId, kind];
    if (filter?.traceId !== undefined) {
      // traceId 精确过滤（json_extract 精确匹配，I2 垫付补偿按 traceId 取燃烧量）。
      sql += ` AND json_extract(cause_json, '$.traceId') = ?`;
      params.push(filter.traceId);
    }
    if (filter?.sinceTs !== undefined) {
      sql += ` AND ts >= ?`;
      params.push(filter.sinceTs);
    }
    sql += ` ORDER BY ts ASC, id ASC`;
    const rows = this.db.prepare(sql).all(...params) as Array<{ kind: VoucherKind; units: number; creditCost: number; cause_json: string; ts: number }>;
    return rows.map((r) => ({ kind: r.kind, units: r.units, creditCost: r.creditCost, cause: JSON.parse(r.cause_json) as BurnCause, ts: r.ts }));
  }
}
