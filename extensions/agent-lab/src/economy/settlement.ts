// 市场结算纯计算（plan Task 3 / spec §7/§7a）。
// 纯函数模块（无副作用）——D1 effect/code 拆分原则的 code 侧：
//   computeConsensus：多评共识中位数（§7a.3）+ 评审准确性 a_i；
//   planSettlement：执行者/评审者结算、对称课税、负流、elo 双写增量、
//     majorError 显式分支、校准 ground truth 锚定。
//
// 数值钉死（spec §7/§7a，接口字段逐字来自 plan Task 3 Interfaces 块）：
//   settle     = stake × (O−1) × (2c−1)
//   majorError → −stake（显式特殊分支——不代入公式，M-R4-1）
//   settle_i   = stake_r × (O_r−1) × (2a_i−1)   （O_r≥2 约束）
//   tax_total  = max(0, settle)×rate + Σ_i max(0, settle_i)×rate   （I-R4-1 对称课税）
//   R          = median(r_i)；a_i = 1 − |r_i − R|
//   校准任务（§7a.7）：c 与 a_i 按 ground truth 锚定（评审偏差不连坐执行者）
// 负流（C-2/C-R4-1，不对称）：执行者负 settle → 直付发布方；评审者负 settle → 入中央池。
//
// 设计裁决（实施期）：
//   - majorError 的 elo outcome=0（崩溃/交付无效——K×(0−expected) 下降）；
//   - 评审者 elo outcome=a_i（准确性是评审者的绩效信号）；
//   - elo 双写增量：global 与 byDomain[typeId] 各按当前值更新（§3.2 回退
//     byDomain[t] ?? global；plan 只产出增量，落库由 Task 4 effect 完成）；
//   - negativeFlow 单槽：执行者负 settle 优先（直付 publisher）；否则取最负评审者
//     代表（入 central-pool）；各评审者负额明细在 reviewerSettles 中，effect 侧可遍历。
import type { MarketTask } from "./market-store.ts";
import { ELO_DEFAULTS, type EloFormula } from "./elo.ts";

/** 默认税率（spec 可调参数——I-R4-1 对称课税；无既有 tax 常量故在此定义）。 */
export const DEFAULT_TAX_RATE = 0.05;

/** 评审输入（r_i ∈ [0,1]）。 */
export interface ReviewInput {
  reviewerId: string;
  score: number;
}

/** 结算计划（全部结算数值的纯计算输出——effect 侧据此划付）。 */
export interface SettlementPlan {
  R: number;
  accuracies: Map<string, number>; // 常规 a_i=1−|r_i−R|；校准按 ground truth
  executorSettle: number;
  executorEloDelta: { global: number; domain: number };
  reviewerSettles: Map<string, number>; // settle_i = stake_r×(O_r−1)×(2a_i−1)
  reviewerEloDeltas: Map<string, { global: number; domain: number }>;
  taxTotal: number; // max(0,settle)×rate + Σmax(0,settle_i)×rate
  negativeFlow: { from: string; to: "publisher" | "central-pool"; amount: number } | null;
  majorError: boolean;
}

export interface PlanSettlementArgs {
  task: MarketTask;
  winnerId: string;
  winnerStake: number;
  reviews: ReviewInput[];
  majorError?: boolean;
  groundTruthScore?: number; // 校准任务：c 与 a_i 按 ground truth
  eloFn: EloFormula;
  taxRate: number;
  executorElo: { global: number; byDomain: Record<string, number> };
  reviewerElos: Map<string, { global: number; byDomain: Record<string, number> }>;
  taskRating: number;
}

/**
 * 多评共识（§7a.3）：`R = median(r_i)`（偶数取上中位数——排序后 index n/2）；
 * `a_i = 1 − |r_i − R|`。空评审抛错（共识必须有评审输入）。
 */
export function computeConsensus(reviews: ReviewInput[]): { R: number; accuracies: Map<string, number> } {
  if (reviews.length === 0) {
    throw new Error("computeConsensus: empty reviews");
  }
  // fix round 3（H2）：r_i ∈ [0,1] 边界守卫——越界抛错（NaN 亦命中：比较全 false）。
  for (const r of reviews) {
    if (!(r.score >= 0 && r.score <= 1)) {
      throw new Error(`computeConsensus: score out of range [0,1]: ${r.score}`);
    }
  }
  const sorted = [...reviews].sort((a, b) => a.score - b.score);
  // n 奇数 → 正中位；n 偶数 → 上中位数（均等于 index floor(n/2)）
  const R = sorted[Math.floor(reviews.length / 2)].score;
  const accuracies = new Map<string, number>();
  for (const r of reviews) {
    accuracies.set(r.reviewerId, 1 - Math.abs(r.score - R));
  }
  return { R, accuracies };
}

/** 域 elo 回退（§3.2）：byDomain[typeId] ?? global。 */
function domainElo(elo: { global: number; byDomain: Record<string, number> }, typeId: string): number {
  return elo.byDomain[typeId] ?? elo.global;
}

/**
 * 结算纯计算。c = groundTruthScore（校准）?? R；评审 a_i 同步按 ground truth 或共识。
 * majorError 分支直接返回 −stake（不代入公式）。负流不对称：
 * 执行者 → publisher；评审者 → central-pool。
 */
export function planSettlement(args: PlanSettlementArgs): SettlementPlan {
  const { task, winnerId, winnerStake, reviews, eloFn, taxRate, executorElo, reviewerElos, taskRating } = args;
  const majorError = args.majorError === true;
  const isCalibration = args.groundTruthScore !== undefined;

  // fix round 3（H2）：O_r ≥ 2 守卫（spec M-R4-2 禁止退化——settle_i 公式要求）。
  if (task.oddsR < 2) {
    throw new Error(`planSettlement: oddsR must be ≥ 2 (M-R4-2), got ${task.oddsR}`);
  }

  // 共识 R 恒为评审中位数（校准任务亦保留——观测/事件使用）；准确度按锚点计算。
  const { R } = computeConsensus(reviews);
  const c = isCalibration ? args.groundTruthScore! : R;
  const anchor = isCalibration ? args.groundTruthScore! : R;
  const accuracies = new Map<string, number>();
  for (const r of reviews) {
    accuracies.set(r.reviewerId, 1 - Math.abs(r.score - anchor));
  }

  // ── 执行者结算 ──
  // majorError → −stake（显式分支，不代入公式）；否则 stake×(O−1)×(2c−1)
  // 协调者裁决：majorError → elo outcome=0（K×(0−expected) 与 −stake 一致惩罚）；
  // spec 未钉死，D2 ledger 记录。
  const outcome = majorError ? 0 : c;
  const executorSettle = majorError ? -winnerStake : winnerStake * (task.odds - 1) * (2 * c - 1);
  const domainCur = domainElo(executorElo, task.typeId);
  const executorEloDelta = {
    global: eloFn.update(executorElo.global, { taskRating, outcome }) - executorElo.global,
    domain: eloFn.update(domainCur, { taskRating, outcome }) - domainCur,
  };

  // ── 评审者结算 + 课税（I-R4-1 对称：负收益不课）──
  const reviewerSettles = new Map<string, number>();
  const reviewerEloDeltas = new Map<string, { global: number; domain: number }>();
  let taxTotal = Math.max(0, executorSettle) * taxRate;
  for (const r of reviews) {
    const a = accuracies.get(r.reviewerId)!;
    const settleI = task.stakeR * (task.oddsR - 1) * (2 * a - 1);
    reviewerSettles.set(r.reviewerId, settleI);
    taxTotal += Math.max(0, settleI) * taxRate;

    const cur = reviewerElos.get(r.reviewerId) ?? { global: ELO_DEFAULTS.INITIAL, byDomain: {} };
    const dCur = domainElo(cur, task.typeId);
    reviewerEloDeltas.set(r.reviewerId, {
      global: eloFn.update(cur.global, { taskRating, outcome: a }) - cur.global,
      domain: eloFn.update(dCur, { taskRating, outcome: a }) - dCur,
    });
  }

  // ── 负流（C-2/C-R4-1 不对称）──
  let negativeFlow: SettlementPlan["negativeFlow"] = null;
  if (executorSettle < 0) {
    // 执行者负 settle → 直付发布方（escrow 只托管发布方资金，不经手负流）
    negativeFlow = { from: winnerId, to: "publisher", amount: -executorSettle };
  } else {
    // 评审者负 settle → 入中央池；取最负者作为单槽代表（明细全量在 reviewerSettles）
    let mostNegative: { reviewerId: string; settle: number } | undefined;
    for (const [reviewerId, settleI] of reviewerSettles) {
      if (settleI < 0 && (!mostNegative || settleI < mostNegative.settle)) {
        mostNegative = { reviewerId, settle: settleI };
      }
    }
    if (mostNegative) {
      negativeFlow = { from: mostNegative.reviewerId, to: "central-pool", amount: -mostNegative.settle };
    }
  }

  return {
    R,
    accuracies,
    executorSettle,
    executorEloDelta,
    reviewerSettles,
    reviewerEloDeltas,
    taxTotal,
    negativeFlow,
    majorError,
  };
}
