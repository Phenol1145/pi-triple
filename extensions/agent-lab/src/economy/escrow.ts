// 双向托管（spec §4.3/§4.4 / plan Task 9）——escrow 两阶段 + bid 对称冻结。
//
// 公式：
//   escrowMax  = maxStake×(O−1) + N×stakeR×(O_r−1) + voucherAllowance
//   escrowActual(stake) = stake×(O−1) + N×stakeR×(O_r−1) + voucherAllowance
//
// 接线约定（Task 1 裁决 + 本任务 ledger 修改）：依赖 SqliteLedger.freeze/unfreeze 事务安全
// 及 (agentId, taskId) 复合键；本模块函数为纯数值计算 + 对 ledger 的冻结/解冻调用。
import type { SqliteLedger } from "../arena/ledger.ts";

export type EscrowParams = {
  maxStake: number;
  odds: number;
  reviewerCount: number;
  stakeR: number;
  oddsR: number;
  voucherAllowance: number;
};

function reviewerEscrow(p: EscrowParams): number {
  return p.reviewerCount * p.stakeR * (p.oddsR - 1) + p.voucherAllowance;
}

/** 发布方按 maxStake 冻结的 escrow 上限。 */
export function escrowMax(p: EscrowParams): number {
  return p.maxStake * (p.odds - 1) + reviewerEscrow(p);
}

/** 实际 stake 对应的 escrow 数额（stake ≤ maxStake）。 */
export function escrowActual(p: EscrowParams, stake: number): number {
  return stake * (p.odds - 1) + reviewerEscrow(p);
}

/** 发布阶段：按 escrowMax 冻结发布方资金；余额不足则抛错（拒绝发布）。 */
export function freezeEscrowMax(
  ledger: SqliteLedger,
  publisherId: string,
  taskId: string,
  p: EscrowParams,
): void {
  const amount = escrowMax(p);
  const ok = ledger.freeze(publisherId, amount, taskId);
  if (!ok) {
    throw new Error(
      `freezeEscrowMax rejected: publisher=${publisherId} task=${taskId} needs ${amount}`,
    );
  }
}

/**
 * 调整阶段：将已冻结的 escrowMax 降为 escrowActual(actualStake)，
 * 解冻差额。actualStake > maxStake 时抛错（clamp 由 D2 市场层执行）。
 */
export function adjustEscrow(
  ledger: SqliteLedger,
  publisherId: string,
  taskId: string,
  p: EscrowParams,
  actualStake: number,
): void {
  if (actualStake > p.maxStake) {
    throw new Error(
      `adjustEscrow rejected: actualStake=${actualStake} exceeds maxStake=${p.maxStake}`,
    );
  }
  const target = escrowActual(p, actualStake);
  ledger.adjustFreeze(publisherId, taskId, target);
}

/** 投标阶段：bidder 冻结 stake×(O−1)；余额不足则抛错（拒绝 bid）。 */
export function freezeBid(
  ledger: SqliteLedger,
  bidderId: string,
  taskId: string,
  stake: number,
  odds: number,
): void {
  const amount = stake * (odds - 1);
  const ok = ledger.freeze(bidderId, amount, taskId);
  if (!ok) {
    throw new Error(
      `freezeBid rejected: bidder=${bidderId} task=${taskId} needs ${amount}`,
    );
  }
}

/** 未中标释放：解冻 bidder 在 task 上的冻结资金。 */
export function releaseBid(
  ledger: SqliteLedger,
  bidderId: string,
  taskId: string,
): void {
  ledger.unfreeze(bidderId, taskId);
}
