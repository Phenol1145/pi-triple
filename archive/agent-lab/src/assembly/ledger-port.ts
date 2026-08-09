// 装配层 LedgerPort（spec §3.3）：arena SqliteLedger 的装配侧适配。
// 语义差异（与 arena 内部 clamp 语义不同）：
//   - open: flat-K 直接开户（绕过 ensureEndowed 的模型价格计算），返回 {created}（attempt-local 回滚前提）
//   - debit: 余额不足 → 抛错（balance 预检）
//   - freeze: reason → taskId 派生键 `freeze:<agentId>:<reason>`；SqliteLedger.freeze 返回 false → 抛错
//   - unfreeze: 整笔解冻（SqliteLedger.unfreeze 按 taskId 整笔）
import { SqliteLedger } from "../arena/ledger.ts";
import { RESERVED_IDS } from "../economy/central-pool.ts";

export interface LedgerPort {
  open(agentId: string, initialK: number): { created: boolean };
  balance(agentId: string): number;
  credit(agentId: string, amount: number, reason: string): void;
  debit(agentId: string, amount: number, reason: string): void;   // 余额不足 → 抛错
  freeze(agentId: string, amount: number, reason: string): void;  // reason → taskId 派生键 `freeze:<agentId>:<reason>`；余额不足/false → 抛错
  unfreeze(agentId: string, reason: string): void;                // 整笔解冻
  /** C 接线包（plan Task 10 项 9）：删账（装配失败回滚用，attempt-local：仅删本调用创建账户）。不存在 → no-op。 */
  removeAccount(agentId: string): void;
}

export class SqliteLedgerAdapter implements LedgerPort {
  readonly impl: SqliteLedger;
  /** 冻结键 → 金额（adapter 内同 key 异 amount 检测；instance-local，见 freeze 注释） */
  private frozenAmounts = new Map<string, number>();

  constructor(impl: SqliteLedger) {
    this.impl = impl;
  }

  open(agentId: string, initialK: number): { created: boolean } {
    // RESERVED_IDS 黑名单前置拒绝（spec §2 / I-R5-2）：池/校准执行者不经外部装配路径开户
    if (RESERVED_IDS.has(agentId)) {
      throw new Error(`reserved agent id: ${agentId}`);
    }
    // 已存在（含零余额账户）→ 续跑信号，不重复入账
    const exists = this.impl.leaderboard().some((r) => r.agent === agentId);
    if (exists) return { created: false };
    // flat-K：经 public API 入账（ensureRow + credit），绕过 ensureEndowed 的模型价格计算
    this.impl.credit(agentId, initialK, "open");
    return { created: true };
  }

  balance(agentId: string): number {
    return this.impl.balance(agentId);
  }

  credit(agentId: string, amount: number, reason: string): void {
    this.impl.credit(agentId, amount, reason);
  }

  debit(agentId: string, amount: number, reason: string): void {
    // balance 预检（arena debit 本身 clamp 静默 —— Port 语义要求抛错）
    if (this.impl.balance(agentId) < amount) {
      throw new Error(`insufficient funds: ${agentId}`);
    }
    this.impl.debit(agentId, amount, reason);
  }

  freeze(agentId: string, amount: number, reason: string): void {
    const taskId = `freeze:${agentId}:${reason}`;
    // 同 key 异 amount：SqliteLedger.freeze 对已冻结 key 是 INSERT OR IGNORE 静默幂等（不改金额）——
    // adapter 用 instance-local 记账检测并抛错（brief：以可实现为准，测试覆盖主路径）
    const existing = this.frozenAmounts.get(taskId);
    if (existing !== undefined && existing !== amount) {
      throw new Error(`freeze amount mismatch for ${taskId}: already frozen ${existing}, got ${amount}`);
    }
    const ok = this.impl.freeze(agentId, amount, taskId);
    if (!ok) throw new Error(`insufficient funds: ${agentId}`);
    this.frozenAmounts.set(taskId, amount);
  }

  unfreeze(agentId: string, reason: string): void {
    const taskId = `freeze:${agentId}:${reason}`;
    this.impl.unfreeze(agentId, taskId); // 整笔解冻；无冻结行 → 幂等 no-op
    this.frozenAmounts.delete(taskId);
  }

  /** 删账（credits 行删除；不存在 → no-op——SqliteLedger.removeAccount 语义）。 */
  removeAccount(agentId: string): void {
    this.impl.removeAccount(agentId);
  }
}
