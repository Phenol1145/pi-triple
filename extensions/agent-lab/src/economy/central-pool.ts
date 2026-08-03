// 中央池（spec §2 / plan Task 3）——RESERVED_IDS 黑名单 + 池专用内部资金路径。
//
// 接线约定（T2 裁决，本任务接线处明示）：所有函数要求 ledger 为**共享同一 DatabaseSync 的
// SqliteLedger 实例**（与注入 SqliteVoucher 的 ledger 一致——直读 credits 表耦合，见
// voucher-port.ts 文档注释）。绝不经过 LedgerPort 适配层：
//   - ensureCentralPool 绕过 LedgerPort.open（open 拒绝 RESERVED_IDS）——走 SqliteLedger 底层 ensureRow
//   - poolDebit 绕过 debit 夹紧（SqliteLedger.debit 把 actual 夹到 [0, balance]）——仅系统内部
//     （endowment 出池 / 校准 escrow）可用，不进 LedgerPort 公开接口（I-R5-1 裁决）
//
// 实现要点：借 SqliteLedger.credit（`balance = balance + amt`，无夹紧）实现建行与负余额——
//   - ensureCentralPool = credit(id, 0)：credit 内部先 ensureRow 建行（balance=0），重复调用幂等
//     （已存在 → 仅记 0-delta 审计事务，余额不变）
//   - poolDebit = credit(id, -amount)：负额直接减，允许赤字（观测可见，spec §2）
//   - poolCredit = credit(id, +amount)
import type { SqliteLedger } from "../arena/ledger.ts";

/** RESERVED_IDS 黑名单：阻止外部装配/开户/竞价（spec §2 / I-R5-2）。 */
export const RESERVED_IDS: ReadonlySet<string> = new Set(["central-pool", "calibration-executor"]);
export const CENTRAL_POOL_ID = "central-pool";

/**
 * 启动初始化：池账户建行（balance=0），幂等（重复调用余额不变）。
 * 绕过 LedgerPort.open（其拒绝 RESERVED_IDS）——经 SqliteLedger.credit(0) 触发底层 ensureRow。
 */
export function ensureCentralPool(ledger: SqliteLedger): void {
  ledger.credit(CENTRAL_POOL_ID, 0, "ensure-central-pool");
}

/**
 * 池专用借记：允许负余额（绕过 debit 夹紧）——仅系统内部（endowment 出池 / 校准 escrow）。
 * 借 credit(负额)：SqliteLedger.credit 无夹紧（`balance = balance + amt`），负额直接减。
 */
export function poolDebit(ledger: SqliteLedger, amount: number, reason: string): void {
  if (!(amount >= 0)) {
    throw new Error(`poolDebit: amount must be >= 0 (got ${amount})`);
  }
  ledger.credit(CENTRAL_POOL_ID, -amount, reason);
}

/** 池专用贷记（税 + 凭证销售收入入池）。 */
export function poolCredit(ledger: SqliteLedger, amount: number, reason: string): void {
  if (!(amount >= 0)) {
    throw new Error(`poolCredit: amount must be >= 0 (got ${amount})`);
  }
  ledger.credit(CENTRAL_POOL_ID, amount, reason);
}
