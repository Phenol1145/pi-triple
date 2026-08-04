// 经济事件流（spec §8 / plan Task 4）。全量货币事件的发射点。
// 事件流供投影报表（Task 8）与审计使用；本模块仅负责 emit/持久化/drain。
import type { DatabaseSync } from "node:sqlite";

/** §8 事件 kind 全量。 */
export type EconomyEventKind =
  | "currency.mint"
  | "currency.burn"
  | "currency.buy_voucher"
  | "currency.transfer"
  | "currency.tax"
  | "currency.rate_adjust"
  | "economy.org_default"
  | "economy.elo_update"
  | "economy.review_consensus"
  | "economy.escrow_freeze"
  | "economy.escrow_adjust"
  | "economy.escrow_release"
  | "economy.bid_freeze"
  | "economy.bid_release"
  | "economy.settle";

export interface EconomyEvent {
  kind: EconomyEventKind;
  ts: number;
  data: Record<string, unknown>;
  /** 校准任务事件标记（§7a.7——审计可区分）。 */
  isCalibration?: boolean;
}

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS economy_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  is_calibration INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * 内存队列 + 可选持久化（economy_events 表——投影重建基源）。
 * emit 始终进内存队列；db 提供时同步落库（单条 INSERT，不包事务——事件是追加日志）。
 */
export class EconomyEventBus {
  private queue: EconomyEvent[] = [];
  private db?: DatabaseSync;

  constructor(db?: DatabaseSync) {
    this.db = db;
    if (db) {
      db.exec(EVENTS_SCHEMA);
    }
  }

  emit(e: Omit<EconomyEvent, "ts">): void {
    const event: EconomyEvent = { ...e, ts: Date.now() };
    this.queue.push(event);
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO economy_events (kind, ts, data_json, is_calibration) VALUES (?, ?, ?, ?)`,
        )
        .run(event.kind, event.ts, JSON.stringify(event.data), event.isCalibration ? 1 : 0);
    }
  }

  /** 取走全部内存事件（测试/投影消费）。 */
  drain(): EconomyEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** 内存队列当前条数。 */
  get size(): number {
    return this.queue.length;
  }

  /** 从持久化表重放全部事件（投影重建基源——Task 8）。 */
  replayAll(): EconomyEvent[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(`SELECT kind, ts, data_json, is_calibration FROM economy_events ORDER BY id ASC`)
      .all() as Array<{ kind: EconomyEventKind; ts: number; data_json: string; is_calibration: number }>;
    return rows.map((r) => ({
      kind: r.kind,
      ts: r.ts,
      data: JSON.parse(r.data_json) as Record<string, unknown>,
      isCalibration: r.is_calibration === 1,
    }));
  }
}
