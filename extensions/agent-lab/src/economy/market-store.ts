// 市场任务持久化（plan Task 2 / spec §5.1）。
// 协调者裁决（fix round 2）：不与 D1 arena ledger.ts 的既有 market_tasks 表复用——
// arena 遗留表（round/role/prompt/winner_model 列）与本任务 schema 冲突，
// 新表改名 economy_tasks / economy_bids 做干净命名空间隔离。
// economy_bids 表记录每任务各竞标者的 stake（供 select 节点消费）。
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

const ECONOMY_TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS economy_tasks (
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

CREATE TABLE IF NOT EXISTS economy_bids (
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
    this.db.exec(ECONOMY_TASKS_SCHEMA);
  }

  /**
   * 插入市场任务；同 taskId 已存在 → 跳过并返回 false。
   * 注：brief 接口签名写 void，但注释要求返回 false；这里按注释实现 boolean
   * 返回值，便于调用方感知幂等跳过。
   */
  createTask(t: MarketTask): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO economy_tasks
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

  /**
   * 更新市场任务；返回是否真实发生变更。
   * fix round 2：idempotent——任务不存在或 patch 各字段与现值完全相同 → 返回 false。
   * （SQLite 的 changes 对“赋值同值”也计 1，因此需先比对现值再决定是否 UPDATE。）
   */
  updateTask(taskId: string, patch: Partial<MarketTask>): boolean {
    const current = this.getTask(taskId);
    if (!current) return false;

    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const push = (col: string, value: string | number | null | undefined, prev: unknown) => {
      if (value === undefined) return;
      if (value === prev) return;
      sets.push(`${col} = ?`);
      values.push(value);
    };

    push("type_id", patch.typeId, current.typeId);
    push("publisher_id", patch.publisherId, current.publisherId);
    push("max_stake", patch.maxStake, current.maxStake);
    push("odds", patch.odds, current.odds);
    push("reviewer_count", patch.reviewerCount, current.reviewerCount);
    push("stake_r", patch.stakeR, current.stakeR);
    push("odds_r", patch.oddsR, current.oddsR);
    push("voucher_allowance", patch.voucherAllowance, current.voucherAllowance);
    push("brief", patch.brief, current.brief);
    push("status", patch.status, current.status);
    push("winner_id", patch.winnerId, current.winnerId);
    push("winner_stake", patch.winnerStake, current.winnerStake);
    push("settled_at", patch.settledAt, current.settledAt);
    push("ground_truth", patch.groundTruth, current.groundTruth);
    push("is_calibration", patch.isCalibration === undefined ? undefined : patch.isCalibration ? 1 : 0, current.isCalibration ? 1 : 0);

    if (sets.length === 0) return false;
    values.push(taskId);
    const result = this.db.prepare(`UPDATE economy_tasks SET ${sets.join(", ")} WHERE task_id = ?`).run(...values);
    return (result.changes ?? 0) > 0;
  }

  getTask(taskId: string): MarketTask | undefined {
    const row = this.db.prepare(
      `SELECT task_id, type_id, publisher_id, max_stake, odds, reviewer_count, stake_r, odds_r,
              voucher_allowance, brief, status, winner_id, winner_stake, created_at, settled_at,
              ground_truth, is_calibration
       FROM economy_tasks WHERE task_id = ?`
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

  /**
   * 记录竞标。fix round 2：幂等——同 (task_id, bidder_id) 重复竞标返回 false。
   * 语义调整：由 INSERT OR REPLACE（upsert 覆盖 stake）改为 INSERT OR IGNORE（重复拒收），
   * 与 createTask 的幂等语义一致（PK 冲突即“已存在”）。
   */
  recordBid(taskId: string, bidderId: string, stake: number): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO economy_bids (task_id, bidder_id, stake) VALUES (?, ?, ?)`
    ).run(taskId, bidderId, stake);
    return (result.changes ?? 0) > 0;
  }

  getBids(taskId: string): Array<{ bidderId: string; stake: number }> {
    const rows = this.db.prepare(
      `SELECT bidder_id, stake FROM economy_bids WHERE task_id = ? ORDER BY stake DESC, bidder_id ASC`
    ).all(taskId) as Array<{ bidder_id: string; stake: number }>;
    return rows.map((r) => ({ bidderId: r.bidder_id, stake: r.stake }));
  }
}
