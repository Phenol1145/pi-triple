// 共享事务协调器（D2 Task 4 协调者裁决）。
//
// 背景：SqliteLedger 与 SqliteVoucher 各自方法内部带 BEGIN IMMEDIATE（独立事务）。
// 市场结算 effect（apply_settlement）要求"整体单事务原子"——需要嵌套复用：
// 外层事务包裹，内部方法复用同一事务，否则嵌套 BEGIN 抛
// "cannot start a transaction within a transaction"。
//
// 方案：以 DatabaseSync 实例为键的 WeakMap 事务状态。ledger/voucher 共享同一 db
// 时，外层 withSharedTransaction(db, fn) 开启，内层（buy/burn/freeze 等）检测到
// 已在事务中则直接执行（复用），不重复 BEGIN。
import type { DatabaseSync } from "node:sqlite";

const inTx = new WeakMap<DatabaseSync, boolean>();

export function isInSharedTransaction(db: DatabaseSync): boolean {
  return inTx.get(db) ?? false;
}

/**
 * 复用版事务包装：db 已在事务中则直接执行（嵌套复用）；否则 BEGIN/COMMIT/ROLLBACK。
 * 供市场结算 effect 的整体原子性使用（D2 Task 4 协调者裁决）。
 */
export function withSharedTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (inTx.get(db)) {
    return fn();
  }
  inTx.set(db, true);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    inTx.set(db, false);
  }
}
