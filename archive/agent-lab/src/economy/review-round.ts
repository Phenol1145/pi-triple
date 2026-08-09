// 多评评审轮编排（plan Task 5 / spec §7a.1/2/8）。
// 评审者互斥选择 + 流标阶梯 + 少数评审者保护（review_refund effect）。
import type { MarketStore, MarketTask } from "./market-store.ts";
import type { Ledger } from "../arena/types.ts";

/** 组织成员接口（Task 6 前 = 空实现接口，测试用内存假实现）。 */
export interface OrgMembership {
  membersOf(orgId: string): string[];
  orgOf(agentId: string): string | undefined;
  addMember(orgId: string, agentId: string): void;
  removeMember(orgId: string, agentId: string): void;
}

/** 评审轮依赖。 */
export interface ReviewRoundDeps {
  store: MarketStore;
  ledger: Ledger;
  orgMembers: OrgMembership; // Task 6 前空实现
  reviewerCount: number; // N = 5
  minReviewers: number; // N_min = 3
  /** 评审 elo 查询（agentId → {eloGlobal, eloByDomain}），同 Task 2 agentLookup 模式。 */
  eloLookup: (agentId: string) => { eloGlobal?: number; eloByDomain?: Record<string, number> } | undefined;
}

/** 评审输入。 */
export interface ReviewInput {
  reviewerId: string;
  score: number;
}

/** 评审轮结果（供 flow 图节点消费）。 */
export interface ReviewRoundResult {
  activated: ReviewInput[]; // 实际收到 r_i 的评审
  shortfall: boolean; // activated.length < N_min
  refundedReviewers: string[]; // 流标时已接单少数评审者（stake_r 退还 + 凭证成本补偿 capped voucherAllowance）
}

/**
 * 评审者选择（spec §7a.1/2）：
 * 1. 互斥过滤：排除执行者本人 + 同组织成员（orgMembers.membersOf(orgOf(executor))）
 * 2. 评审 elo 降序取前 N（纯 elo 序——stake_r 常数不参与选择）
 *    elo 查询：Task 2 的 MarketFnsDeps.agentLookup 模式（agentId → {eloGlobal, eloByDomain}）
 *    使用 deps.eloLookup 获取域 elo（优先）或全局 elo 回退。
 */
export function selectReviewers(
  deps: ReviewRoundDeps,
  task: MarketTask,
  executorId: string,
  pool: string[]
): string[] {
  const { orgMembers, reviewerCount, eloLookup } = deps;

  // 1) 互斥集合：执行者 + 同组织成员
  const excluded = new Set<string>();
  excluded.add(executorId);
  const executorOrg = orgMembers.orgOf(executorId);
  if (executorOrg) {
    for (const m of orgMembers.membersOf(executorOrg)) {
      excluded.add(m);
    }
  }

  // 2) 过滤候选池
  const filtered = pool.filter((id) => !excluded.has(id));

  // 3) 按评审 elo 降序排序（域 elo 优先，回退全局 elo）
  const typeId = task.typeId;
  const scored = filtered.map((id) => {
    const elo = eloLookup(id);
    const domainElo = elo?.eloByDomain?.[typeId] ?? elo?.eloGlobal ?? 1500;
    return { id, elo: domainElo };
  });
  scored.sort((a, b) => b.elo - a.elo || a.id.localeCompare(b.id));

  // 4) 取前 N
  return scored.slice(0, reviewerCount).map((s) => s.id);
}

/**
 * 评审轮编排主逻辑（供 market.review_shortlist code fn 调用）。
 * 流程：
 * 1. selectReviewers → 获得候选评审者列表
 * 2. 冻结评审者 bid（stake_r × (O_r - 1)）——对称托管
 * 3. 等待评审输入（外部 fanout 节点处理，本函数仅返回选中的评审者）
 * 4. 流标判定由 review_refund effect 处理
 *
 * 注：本函数为纯 code fn，只负责选择与冻结；评审执行与流标在 effect 层。
 */
export interface ReviewShortlistArgs {
  taskId: string;
  executorId: string;
  pool: string[];
  stakeR: number;
  oddsR: number;
}

export function reviewShortlist(
  deps: ReviewRoundDeps,
  task: MarketTask,
  args: ReviewShortlistArgs
): { reviewers: string[] } {
  const selected = selectReviewers(deps, task, args.executorId, args.pool);

  // 冻结评审者 bid（stake_r × (O_r - 1)）
  // 使用 ledger.freeze 直接冻结；余额不足者会被排除（freeze 返回 false）
  const frozenReviewers: string[] = [];
  for (const reviewerId of selected) {
    const amount = args.stakeR * (args.oddsR - 1);
    const ok = deps.ledger.freeze(reviewerId, amount, args.taskId);
    if (ok) {
      frozenReviewers.push(reviewerId);
    }
    // 余额不足者静默跳过（不入选实际激活列表）
  }

  return { reviewers: frozenReviewers };
}