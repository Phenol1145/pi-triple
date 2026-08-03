// 市场结算纯计算测试（plan Task 3 / spec §7/§7a）。
// 覆盖：consensus 中位数（奇/偶上中位数）、执行者结算（settle 公式/majorError 显式分支/
// odds=1 退化）、评审者结算（stake_r×(O_r−1)×(2a−1) + 负 settle 入中央池）、对称课税
// （负收益不课）、校准任务（c 与 a_i 按 ground truth）、code fn 薄壳（market.consensus/market.settle）。
// 浮点断言统一走 closeTo（1−|r−R| 与 ×2−1 链在二进制下非精确值）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MarketStore, type MarketTask } from "../src/economy/market-store.ts";
import {
  computeConsensus,
  planSettlement,
  DEFAULT_TAX_RATE,
  type ReviewInput,
  type SettlementPlan,
} from "../src/economy/settlement.ts";
import {
  registerMarketCodeFns,
  type MarketFnsDeps,
  type CodeRegistry,
} from "../src/economy/market-fns.ts";
import {
  EloFormulaRegistry,
  SelectionFormulaRegistry,
  simpleElo,
  stakeEloPower,
  taskRatingFromOdds,
} from "../src/economy/elo.ts";
import { SqliteTaskTypeRegistry } from "../src/economy/task-types.ts";
import type { Ledger } from "../src/arena/types.ts";
import type { VoucherPort } from "../src/economy/voucher-port.ts";

function closeTo(actual: number, expected: number, eps = 1e-9, msg?: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg ?? "value"} expected ${actual} ≈ ${expected} (±${eps})`);
}

function mockLedger(): Ledger {
  return {
    balance: () => 0,
    ensureEndowed: () => {},
    credit: () => {},
    debit: () => {},
    debitUnclamped: () => {},
    freeze: () => true,
    adjustFreeze: () => 0,
    unfreeze: () => 0,
    leaderboard: () => [],
    history: () => [],
    currentRound: () => 0,
    nextRound: () => 1,
    agentTurn: () => 0,
    createTask: () => {},
    getTask: () => undefined,
    setTaskStatus: () => {},
    staleTasks: () => [],
    recoverStaleTask: () => {},
    countSettledByTemplate: () => 0,
    removeAccount: () => {},
  };
}

function mockVoucher(): VoucherPort {
  return {
    buy: () => {},
    balance: () => 0,
    burn: () => {},
    burnHistory: () => [],
  };
}

function makeCodeRegistry(): CodeRegistry & { resolve(name: string): ((args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) | undefined } {
  const fns = new Map<string, (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
  return {
    register(name: string, fn: (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
      if (fns.has(name)) throw new Error(`code fn already registered: ${name}`);
      fns.set(name, fn);
    },
    resolve(name: string) {
      return fns.get(name);
    },
  };
}

function makeCtx(state: Record<string, unknown>): Record<string, unknown> {
  return { state, runId: "run-1", nodeId: "node-1", log: () => {} };
}

function makeDeps(db: DatabaseSync, over: Partial<MarketFnsDeps> = {}): MarketFnsDeps {
  const taskTypes = new SqliteTaskTypeRegistry(db);
  taskTypes.register({ id: "code", description: "coding task", registeredBy: "test", createdAt: 1000 });
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const selection = new SelectionFormulaRegistry();
  selection.register(stakeEloPower);
  return {
    store: new MarketStore(db),
    ledger: mockLedger(),
    voucher: mockVoucher(),
    elo,
    selection,
    taskTypes,
    calibrationRate: 0.1,
    rng: () => 0.99,
    ...over,
  };
}

function makeTask(over: Partial<MarketTask> = {}): MarketTask {
  return {
    taskId: "t1",
    typeId: "code",
    publisherId: "pub-1",
    maxStake: 15,
    odds: 3,
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    brief: "fix the bug",
    status: "executing",
    winnerId: "exec-1",
    winnerStake: 15,
    createdAt: 1000,
    ...over,
  };
}

/** 标准 5 评审（R=0.7，a=[0.5,0.8,1.0,0.9,0.8]，settle=[0,6,10,8,6]）。 */
function standardReviews(): ReviewInput[] {
  return [
    { reviewerId: "r1", score: 0.2 },
    { reviewerId: "r2", score: 0.5 },
    { reviewerId: "r3", score: 0.7 },
    { reviewerId: "r4", score: 0.8 },
    { reviewerId: "r5", score: 0.9 },
  ];
}

function standardReviewerElos(): Map<string, { global: number; byDomain: Record<string, number> }> {
  const m = new Map<string, { global: number; byDomain: Record<string, number> }>();
  for (const id of ["r1", "r2", "r3", "r4", "r5"]) {
    m.set(id, { global: 1500, byDomain: { code: 1500 } });
  }
  return m;
}

function standardArgs(task: MarketTask = makeTask(), reviews: ReviewInput[] = standardReviews()): Parameters<typeof planSettlement>[0] {
  return {
    task,
    winnerId: task.winnerId ?? "exec-1",
    winnerStake: task.winnerStake ?? 15,
    reviews,
    eloFn: simpleElo,
    taxRate: DEFAULT_TAX_RATE,
    executorElo: { global: 1500, byDomain: { code: 1500 } },
    reviewerElos: standardReviewerElos(),
    taskRating: taskRatingFromOdds(task.odds),
  };
}

// ── 1. consensus 奇数中位数 ─────────────────────────────────────────
test("consensus：r=[0.2,0.5,0.7,0.8,0.9] → R=0.7（median）；a=[0.5,0.8,1.0,0.9,0.8]", () => {
  const { R, accuracies } = computeConsensus(standardReviews());

  assert.equal(R, 0.7);
  const expected = [0.5, 0.8, 1.0, 0.9, 0.8];
  assert.equal(accuracies.size, 5);
  Array.from(accuracies.entries()).forEach(([id, a], i) => {
    assert.equal(id, `r${i + 1}`);
    closeTo(a, expected[i]);
  });
});

// ── 2. consensus 偶数上中位数 ───────────────────────────────────────
test("consensus：偶数 → 上中位数（[0.2,0.5,0.7,0.8] → R=0.7）", () => {
  const { R } = computeConsensus([
    { reviewerId: "r1", score: 0.2 },
    { reviewerId: "r2", score: 0.5 },
    { reviewerId: "r3", score: 0.7 },
    { reviewerId: "r4", score: 0.8 },
  ]);

  // 上中位数 = 排序后中间两值中较大者（index 2）
  assert.equal(R, 0.7);
});

// ── 3. settle 正常 ──────────────────────────────────────────────────
test("settle 正常：stake=15,O=3,c=0.7 → 15×2×0.4=12；elo 增量（taskRating=1900，得分=0.7）", () => {
  const plan = planSettlement(standardArgs());

  assert.equal(plan.R, 0.7);
  assert.equal(plan.majorError, false);
  closeTo(plan.executorSettle, 12); // 15×(3−1)×(2×0.7−1) = 30×0.4

  // elo 增量 = update(current, {taskRating, outcome}) − current（双写同公式）
  const expectedGlobal = simpleElo.update(1500, { taskRating: 1900, outcome: 0.7 }) - 1500;
  closeTo(plan.executorEloDelta.global, expectedGlobal);
  closeTo(plan.executorEloDelta.domain, expectedGlobal, 1e-9, "byDomain 起点同值 → 增量相同");

  // 评审者结算：settle_i = 10×(2−1)×(2a−1) → [0,6,10,8,6]
  const expectedSettles = [0, 6, 10, 8, 6];
  Array.from(plan.reviewerSettles.entries()).forEach(([id, s], i) => {
    assert.equal(id, `r${i + 1}`);
    closeTo(s, expectedSettles[i]);
  });
  // 评审者 elo 增量 outcome=a_i
  const reviewerDelta = simpleElo.update(1500, { taskRating: 1900, outcome: 1.0 }) - 1500;
  closeTo(plan.reviewerEloDeltas.get("r3")!.global, reviewerDelta);

  // 对称课税：(12 + 0+6+10+8+6) × 0.05 = 42 × 0.05 = 2.1
  closeTo(plan.taxTotal, 2.1);
  assert.equal(plan.negativeFlow, null);
});

// ── 4. majorError 显式分支 ─────────────────────────────────────────
test("majorError → settle=−stake（−15，显式分支不代入公式）+ negativeFlow 直付 publisher", () => {
  const plan = planSettlement({ ...standardArgs(), majorError: true });

  assert.equal(plan.majorError, true);
  // 显式分支：直接 −stake，绝不代入 stake×(O−1)×(2c−1)
  closeTo(plan.executorSettle, -15);
  assert.deepEqual(plan.negativeFlow, { from: "exec-1", to: "publisher", amount: 15 });
  // 执行者 elo outcome=0（崩溃/失败——K×(0−expected) 下降）
  const crashDelta = simpleElo.update(1500, { taskRating: 1900, outcome: 0 }) - 1500;
  assert.ok(crashDelta < 0);
  closeTo(plan.executorEloDelta.global, crashDelta);
  // 税不含执行者负 settle：max(0,−15)=0，仅评审者正收益课税
  closeTo(plan.taxTotal, (0 + 6 + 10 + 8 + 6) * 0.05); // 1.5
});

// ── 5. 评审者结算 + 负 settle 入中央池 ─────────────────────────────
test("评审者结算：stake_r=10,O_r=2,a=0.8 → 10×1×0.6=6；a<0.5 → 负 settle → negativeFlow 入 central-pool", () => {
  // r1=0.1 → a=1−|0.1−0.7|=0.4 → settle=−2；r2=0.5 → a=0.8 → settle=6
  const reviews: ReviewInput[] = [
    { reviewerId: "r1", score: 0.1 },
    { reviewerId: "r2", score: 0.5 },
    { reviewerId: "r3", score: 0.7 },
    { reviewerId: "r4", score: 0.8 },
    { reviewerId: "r5", score: 0.9 },
  ];
  const plan = planSettlement(standardArgs(makeTask(), reviews));

  assert.equal(plan.R, 0.7);
  closeTo(plan.reviewerSettles.get("r1")!, -2); // 10×(2×0.4−1) = 10×(−0.2)
  closeTo(plan.reviewerSettles.get("r2")!, 6); // 10×1×0.6
  // 执行者 settle 为正时，负流取最负评审者 → 入中央池（C-R4-1 不对称）
  assert.equal(plan.negativeFlow!.from, "r1");
  assert.equal(plan.negativeFlow!.to, "central-pool");
  closeTo(plan.negativeFlow!.amount, 2);
});

// ── 6. 对称课税（负的不课）─────────────────────────────────────────
test("对称课税：settle=12 + settle_i=6,−2 → tax=(12+6)×0.05=0.9（负的不课）", () => {
  // 数值钉死场景：executor c=0.7 → 12；评审 r1 a=0.8 → 6、r2 a=0.4 → −2。
  // 该数值组合无法由同一共识（R=0.7）自然导出（见报告适配说明）——经校准路径
  // groundTruthScore=0.7 构造（评审 a_i 按 ground truth 偏差；c 独立于 R），专测税公式。
  const args = standardArgs(
    makeTask({ isCalibration: true }),
    [
      { reviewerId: "r1", score: 0.9 },
      { reviewerId: "r2", score: 0.1 },
    ]
  );
  const plan = planSettlement({ ...args, groundTruthScore: 0.7 });

  closeTo(plan.executorSettle, 12);
  closeTo(plan.reviewerSettles.get("r1")!, 6);
  closeTo(plan.reviewerSettles.get("r2")!, -2);
  closeTo(plan.taxTotal, 0.9); // (12 + 6) × 0.05，负的 −2 不课
});

// ── 7. 校准任务 ground truth 锚定 ──────────────────────────────────
test("校准任务：groundTruthScore=0.9 → c=0.9（非 R）；a_i=1−|r_i−0.9|（非共识偏差）", () => {
  const reviews: ReviewInput[] = [
    { reviewerId: "r1", score: 0.7 },
    { reviewerId: "r2", score: 0.9 },
    { reviewerId: "r3", score: 1.0 },
    { reviewerId: "r4", score: 0.8 },
    { reviewerId: "r5", score: 0.5 },
  ];
  const args = standardArgs(makeTask({ isCalibration: true, groundTruth: "gt-artifact" }), reviews);
  const plan = planSettlement({ ...args, groundTruthScore: 0.9 });

  // R 仍是评审中位数（[0.5,0.7,0.8,0.9,1.0] → 0.8）
  assert.equal(plan.R, 0.8);
  // 执行者 c 按 ground truth=0.9（非 R=0.8）→ 15×2×(2×0.9−1)=24
  closeTo(plan.executorSettle, 24);
  // a_i 按与 ground truth 的偏差：1−|r_i−0.9|
  const expectedA = [0.8, 1.0, 0.9, 0.9, 0.6];
  Array.from(plan.accuracies.entries()).forEach(([id, a], i) => {
    assert.equal(id, `r${i + 1}`);
    closeTo(a, expectedA[i]);
  });
  // 评审者结算基于 ground-truth 准确性：r1 → 10×(2×0.8−1)=6；r5 → 10×(2×0.6−1)=2
  closeTo(plan.reviewerSettles.get("r1")!, 6);
  closeTo(plan.reviewerSettles.get("r5")!, 2);
});

// ── 8. odds=1 退化 ─────────────────────────────────────────────────
test("odds=1 退化：settle=0（义务性任务）；税不含执行者项", () => {
  const plan = planSettlement(standardArgs(makeTask({ odds: 1 })));

  assert.equal(plan.executorSettle, 0); // 15×(1−1)×(2×0.7−1) = 0
  closeTo(plan.taxTotal, (0 + 6 + 10 + 8 + 6) * 0.05); // 1.5，只有评审者正收益课税
});

// ── 9. code fn 薄壳：market.consensus ──────────────────────────────
test("market.consensus：注册 + 薄壳委托 computeConsensus", () => {
  const db = new DatabaseSync(":memory:");
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, makeDeps(db));

  const fn = registry.resolve("market.consensus")!;
  const result = fn({}, makeCtx({ reviews: standardReviews() })) as { R: number; accuracies: Map<string, number> };

  assert.equal(result.R, 0.7);
  closeTo(result.accuracies.get("r3")!, 1.0);
  closeTo(result.accuracies.get("r1")!, 0.5);

  db.close();
});

// ── 10. code fn 薄壳：market.settle（默认税率/taskRating 派生）──────
test("market.settle：注册 + 薄壳委托 planSettlement（默认税 0.05，taskRating 由 odds 派生）", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);
  deps.store.createTask(makeTask());

  const fn = registry.resolve("market.settle")!;
  const result = fn(
    {},
    makeCtx({
      taskId: "t1",
      winnerId: "exec-1",
      winnerStake: 15,
      reviews: standardReviews(),
      executorElo: { global: 1500, byDomain: { code: 1500 } },
      reviewerElos: standardReviewerElos(),
    })
  ) as SettlementPlan;

  // odds=3 → taskRating=1900；c=R=0.7 → settle=12
  closeTo(result.executorSettle, 12);
  assert.equal(result.R, 0.7);
  closeTo(result.taxTotal, 2.1);
  assert.equal(result.majorError, false);
  // 未显式传 taskRating 时由 task.odds 派生 = 1500+200×(3−1) = 1900
  closeTo(result.executorEloDelta.global, simpleElo.update(1500, { taskRating: 1900, outcome: 0.7 }) - 1500);

  db.close();
});

// ── 11. code fn 薄壳：market.settle 校准路径 ───────────────────────
test("market.settle：groundTruthScore 经 state 透传 → c 按 ground truth（非 R）", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);
  deps.store.createTask(makeTask({ isCalibration: true }));

  const fn = registry.resolve("market.settle")!;
  const result = fn(
    {},
    makeCtx({
      taskId: "t1",
      winnerId: "exec-1",
      winnerStake: 15,
      reviews: [
        { reviewerId: "r1", score: 0.7 },
        { reviewerId: "r2", score: 0.9 },
      ],
      groundTruthScore: 0.9,
      executorElo: { global: 1500, byDomain: { code: 1500 } },
    })
  ) as SettlementPlan;

  // R=上中位数=0.9，但 c=groundTruthScore=0.9 → settle=15×2×0.8=24
  assert.equal(result.R, 0.9);
  closeTo(result.executorSettle, 24);
  closeTo(result.accuracies.get("r1")!, 0.8); // 1−|0.7−0.9|
  closeTo(result.accuracies.get("r2")!, 1.0); // 1−|0.9−0.9|

  db.close();
});
