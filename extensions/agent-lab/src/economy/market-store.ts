// 市场任务持久化（plan Task 2 / spec §5.1）。
// 复用 D1 market_tasks 表并扩展本任务所需字段：publisher_id、reviewer_count、
// stake_r、odds_r、voucher_allowance、ground_truth、is_calibration。
// market_bids 表记录每任务各竞标者的 stake（供 select 节点消费）。
import type { DatabaseSync } from "node:sqlite";

export interface MarketTask {
  taskId: string;
  typeId: string;
  publisherId: string;
  maxStake: number;
  odds: number;
  reviewerCount: number;
  stakeR: number;
  oddsR: number;
  voucherAllowance: number;
  brief: string;
  status: "open" | "awarded" | "executing" | "reviewing" | "settled" | "failed";
  winnerId?: string;
  winnerStake?: number;
  createdAt: number;
  settledAt?: number;
  groundTruth?: string;
  isCalibration?: boolean;
}

const MARKET_TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS market_tasks (
  task_id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  max_stake REAL NOT NULL,
  odds REAL NOT NULL,
  reviewer_count INTEGER NOT NULL,
  stake_r REAL NOT NULL,
  odds_r REAL NOT NULL,
  voucher_allowance REAL NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  winner_id TEXT,
  winner_stake REAL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  ground_truth TEXT,
  is_calibration INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS market_bids (
  task_id TEXT NOT NULL,
  bidder_id TEXT NOT NULL,
  stake REAL NOT NULL,
  PRIMARY KEY (task_id, bidder_id)
);
`;

export class MarketStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(MARKET_TASKS_SCHEMA);
  }

  /**
   * 插入市场任务；同 taskId 已存在 → 跳过并返回 false。
   * 注：brief 接口签名写 void，但注释要求返回 false；这里按注释实现 boolean
   * 返回值，便于调用方感知幂等跳过。
   */
  createTask(t: MarketTask): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO market_tasks
       (task_id, type_id, publisher_id, max_stake, odds, reviewer_count, stake_r, odds_r,
        voucher_allowance, brief, status, winner_id, winner_stake, created_at, settled_at,
        ground_truth, is_calibration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      t.taskId,
      t.typeId,
      t.publisherId,
      t.maxStake,
      t.odds,
      t.reviewerCount,
      t.stakeR,
      t.oddsR,
      t.voucherAllowance,
      t.brief,
      t.status,
      t.winnerId ?? null,
      t.winnerStake ?? null,
      t.createdAt,
      t.settledAt ?? null,
      t.groundTruth ?? null,
      t.isCalibration ? 1 : 0
    );
    return (result.changes ?? 0) > 0;
  }

  updateTask(taskId: string, patch: Partial<MarketTask>): void {
    const sets: string[] = [];
    const values: Array<string | number | null | undefined> = [];

    if (patch.typeId !== undefined) { sets.push("type_id = ?"); values.push(patch.typeId); }
    if (patch.publisherId !== undefined) { sets.push("publisher_id = ?"); values.push(patch.publisherId); }
    if (patch.maxStake !== undefined) { sets.push("max_stake = ?"); values.push(patch.maxStake); }
    if (patch.odds !== undefined) { sets.push("odds = ?"); values.push(patch.odds); }
    if (patch.reviewerCount !== undefined) { sets.push("reviewer_count = ?"); values.push(patch.reviewerCount); }
    if (patch.stakeR !== undefined) { sets.push("stake_r = ?"); values.push(patch.stakeR); }
    if (patch.oddsR !== undefined) { sets.push("odds_r = ?"); values.push(patch.oddsR); }
    if (patch.voucherAllowance !== undefined) { sets.push("voucher_allowance = ?"); values.push(patch.voucherAllowance); }
    if (patch.brief !== undefined) { sets.push("brief = ?"); values.push(patch.brief); }
    if (patch.status !== undefined) { sets.push("status = ?"); values.push(patch.status); }
    if (patch.winnerId !== undefined) { sets.push("winner_id = ?"); values.push(patch.winnerId); }
    if (patch.winnerStake !== undefined) { sets.push("winner_stake = ?"); values.push(patch.winnerStake); }
    if (patch.settledAt !== undefined) { sets.push("settled_at = ?"); values.push(patch.settledAt); }
    if (patch.groundTruth !== undefined) { sets.push("ground_truth = ?"); values.push(patch.groundTruth); }
    if (patch.isCalibration !== undefined) { sets.push("is_calibration = ?"); values.push(patch.isCalibration ? 1 : 0); }

    if (sets.length === 0) return;
    values.push(taskId);
    this.db.prepare(`UPDATE market_tasks SET ${sets.join(", ")} WHERE task_id = ?`).run(...values);
  }

  getTask(taskId: string): MarketTask | undefined {
    const row = this.db.prepare(
      `SELECT task_id, type_id, publisher_id, max_stake, odds, reviewer_count, stake_r, odds_r,
              voucher_allowance, brief, status, winner_id, winner_stake, created_at, settled_at,
              ground_truth, is_calibration
       FROM market_tasks WHERE task_id = ?`
    ).get(taskId) as {
      task_id: string;
      type_id: string;
      publisher_id: string;
      max_stake: number;
      odds: number;
      reviewer_count: number;
      stake_r: number;
      odds_r: number;
      voucher_allowance: number;
      brief: string;
      status: string;
      winner_id: string | null;
      winner_stake: number | null;
      created_at: number;
      settled_at: number | null;
      ground_truth: string | null;
      is_calibration: number;
    } | undefined;

    if (!row) return undefined;

    return {
      taskId: row.task_id,
      typeId: row.type_id,
      publisherId: row.publisher_id,
      maxStake: row.max_stake,
      odds: row.odds,
      reviewerCount: row.reviewer_count,
      stakeR: row.stake_r,
      oddsR: row.odds_r,
      voucherAllowance: row.voucher_allowance,
      brief: row.brief,
      status: row.status as MarketTask["status"],
      ...(row.winner_id !== null ? { winnerId: row.winner_id } : {}),
      ...(row.winner_stake !== null ? { winnerStake: row.winner_stake } : {}),
      createdAt: row.created_at,
      ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
      ...(row.ground_truth !== null ? { groundTruth: row.ground_truth } : {}),
      isCalibration: row.is_calibration === 1,
    };
  }

  recordBid(taskId: string, bidderId: string, stake: number): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO market_bids (task_id, bidder_id, stake) VALUES (?, ?, ?)`
    ).run(taskId, bidderId, stake);
  }

  getBids(taskId: string): Array<{ bidderId: string; stake: number }> {
    const rows = this.db.prepare(
      `SELECT bidder_id, stake FROM market_bids WHERE task_id = ? ORDER BY stake DESC, bidder_id ASC`
    ).all(taskId) as Array<{ bidder_id: string; stake: number }>;
    return rows.map((r) => ({ bidderId: r.bidder_id, stake: r.stake }));
  }
}
