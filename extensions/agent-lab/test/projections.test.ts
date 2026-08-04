// D2 Task 8：观测投影（spec §8——只读报表）。纯函数消费事件流，不触碰 ledger/voucher。
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectEconomy, type EconomyReport } from "../src/economy/projections.ts";
import type { EconomyEvent } from "../src/economy/economy-events.ts";

// ── helpers ──
function ev(partial: Omit<EconomyEvent, "ts"> & { ts?: number }, ts: number): EconomyEvent {
  return { ...partial, ts };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// ── Test 1: 投影重建一致性（发行量=Σmint−Σburn；池余额=入池−出池）──
test("投影重建一致性：报表字段与账本实际状态一致（发行量/池余额/存量/速率/流速）", () => {
  const events: EconomyEvent[] = [
    ev({ kind: "currency.mint", data: { agentId: "a1", amount: 100 } }, 1000),
    ev({ kind: "currency.mint", data: { agentId: "a2", amount: 100 } }, 2000),
    ev({ kind: "currency.buy_voucher", data: { agentId: "a1", kind: "llm", units: 10, cost: 100 } }, 3000),
    ev({ kind: "currency.burn", data: { agentId: "a1", kind: "llm", units: 3, creditCost: 30 } }, 4000),
    ev({ kind: "currency.tax", data: { taskId: "t1", amount: 5, payer: "pub" } }, 5000),
    ev({ kind: "economy.settle", data: { taskId: "t1", role: "reviewer", agentId: "r1", settle: -2, to: "central-pool" } }, 6000),
    ev({ kind: "currency.transfer", data: { taskId: "t1", from: "a1", to: "a2", amount: 30 } }, 7000),
  ];

  const r = projectEconomy(events);
  // 发行量/燃烧（credit 价值）：minted=Σmint；burned=ΣcreditCost
  assert.equal(r.minted, 200);
  assert.equal(r.burned, 30);
  assert.equal(r.minted - r.burned, 170, "货币供给 = Σmint − Σburn");
  // 池余额 = −Σmint + Σtax + ΣbuyCost + settle入池
  assert.equal(r.poolBalance, -200 + 100 + 5 + 2);
  // 凭证存量/对账
  assert.deepEqual(r.voucherStock, { llm: 7, time: 0, compute: 0 });
  // 全窗口（无 windowMs）：span = maxTs−minTs = 6000
  assert.equal(r.creditVelocity, 30 / 6000);
  assert.deepEqual(r.burnRate, { llm: 3 / 6000, time: 0, compute: 0 });

  // windowMs 窗口：仅影响流速/燃烧速率（[maxTs−windowMs, maxTs]）
  const rw = projectEconomy(events, 3000);
  assert.equal(rw.creditVelocity, 30 / 3000);
  assert.deepEqual(rw.burnRate, { llm: 3 / 3000, time: 0, compute: 0 });
  assert.equal(rw.minted, 200, "累计字段不受窗口影响");
  assert.equal(rw.poolBalance, -93, "累计字段不受窗口影响");
});

// ── Test 2: 双层对账（物理量 ↔ credit 价值——价格信号=比率）──
test("双层对账：buy/burn 事件 → 物理量与 credit 价值对账（价格信号=两者比率）", () => {
  const events: EconomyEvent[] = [
    ev({ kind: "currency.buy_voucher", data: { agentId: "a1", kind: "llm", units: 300, cost: 3000 } }, 1000),   // 10 credit/unit
    ev({ kind: "currency.burn", data: { agentId: "a1", kind: "llm", units: 100, creditCost: 1000 } }, 2000),
    ev({ kind: "currency.buy_voucher", data: { agentId: "a2", kind: "time", units: 2, cost: 10 } }, 3000),      // 5 credit/unit
    ev({ kind: "currency.burn", data: { agentId: "a2", kind: "time", units: 1, creditCost: 5 } }, 4000),
  ];

  const r = projectEconomy(events);
  assert.deepEqual(r.voucherStock, { llm: 200, time: 1, compute: 0 });
  assert.deepEqual(r.physicalCreditReconciliation, [
    { kind: "llm", physicalUnits: 200, creditValue: 2000 },
    { kind: "time", physicalUnits: 1, creditValue: 5 },
    { kind: "compute", physicalUnits: 0, creditValue: 0 },
  ]);
  // 价格信号 = creditValue/physicalUnits = 原购买汇率（10 / 5）
  const llm = r.physicalCreditReconciliation[0]!;
  const time = r.physicalCreditReconciliation[1]!;
  assert.equal(llm.creditValue / llm.physicalUnits, 10);
  assert.equal(time.creditValue / time.physicalUnits, 5);
});

// ── Test 3: elo 分布分桶（[100,500),[500,1000),… 步长 400；重建 = 1500 + Σdelta）──
test("elo 分布分桶：[100+400k, 100+400(k+1)) 计数", () => {
  const events: EconomyEvent[] = [
    ev({ kind: "economy.elo_update", data: { agentId: "a1", deltaGlobal: 200 } }, 1000),   // 1700
    ev({ kind: "economy.elo_update", data: { agentId: "a2", deltaGlobal: 300 } }, 1001),   // 1500+300
    ev({ kind: "economy.elo_update", data: { agentId: "a2", deltaGlobal: 100 } }, 1002),   // 1900（多次更新累加）
    ev({ kind: "economy.elo_update", data: { agentId: "a3", deltaGlobal: -300 } }, 1003),  // 1200
    ev({ kind: "economy.elo_update", data: { agentId: "a4", deltaGlobal: 100 } }, 1004),   // 1600
    ev({ kind: "economy.elo_update", data: { agentId: "a5", deltaGlobal: 0 } }, 1005),     // 1500
    ev({ kind: "economy.elo_update", data: { agentId: "a6", deltaGlobal: 1000 } }, 1006),  // 2500
  ];

  const r = projectEconomy(events);
  // 分桶：起点 100、步长 400 → [100,500),[500,900),[900,1300),[1300,1700),[1700,2100),…
  assert.deepEqual(r.eloDistribution.buckets, [
    { range: "[900,1300)", count: 1 },
    { range: "[1300,1700)", count: 2 },
    { range: "[1700,2100)", count: 2 },
    { range: "[2500,2900)", count: 1 },
  ]);
});

// ── Test 4: 评审准确性（review_consensus → avgAccuracy per reviewer）──
test("评审准确性：review_consensus 事件 → avgAccuracy = mean(1−|r_i−R|) per reviewer", () => {
  const events: EconomyEvent[] = [
    // R 显式给出
    ev({
      kind: "economy.review_consensus",
      data: { taskId: "t1", R: 0.7, reviews: [{ reviewerId: "r1", score: 0.7 }, { reviewerId: "r2", score: 0.9 }, { reviewerId: "r3", score: 0.5 }] },
    }, 1000),
    // R 缺失 → 回退中位数（median(0.5,0.8,0.7)=0.7——奇数评审数，口径明确）
    ev({
      kind: "economy.review_consensus",
      data: { taskId: "t2", reviews: [{ reviewerId: "r1", score: 0.5 }, { reviewerId: "r2", score: 0.8 }, { reviewerId: "r3", score: 0.7 }] },
    }, 2000),
  ];

  const r = projectEconomy(events);
  // r1: (1−|0.7−0.7| + 1−|0.5−0.7|)/2 = (1.0+0.8)/2 = 0.9；r2: (0.8+0.9)/2 = 0.85；r3: (0.8+1.0)/2 = 0.9
  assert.deepEqual(r.reviewerAccuracy, [
    { reviewerId: "r1", avgAccuracy: 0.9, n: 2 },
    { reviewerId: "r3", avgAccuracy: 0.9, n: 2 },
    { reviewerId: "r2", avgAccuracy: 0.85, n: 2 },
  ]);
});

// ── Test 5: 校准偏差榜（isCalibration 事件 → 评审者 ground truth 偏差排序）──
test("校准偏差榜：isCalibration 事件 → bias = r_i − groundTruth，按 |bias| 降序", () => {
  const events: EconomyEvent[] = [
    ev({
      kind: "economy.review_consensus",
      isCalibration: true,
      data: { taskId: "c1", groundTruthScore: 0.9, reviews: [{ reviewerId: "r1", score: 1.0 }, { reviewerId: "r2", score: 0.6 }, { reviewerId: "r3", score: 0.9 }] },
    }, 1000),
    ev({
      kind: "economy.review_consensus",
      isCalibration: true,
      data: { taskId: "c2", groundTruthScore: 0.5, reviews: [{ reviewerId: "r1", score: 0.3 }, { reviewerId: "r2", score: 0.8 }] },
    }, 2000),
    // 非校准事件不得污染偏差榜
    ev({
      kind: "economy.review_consensus",
      data: { taskId: "t1", R: 0.5, reviews: [{ reviewerId: "r1", score: 0.2 }] },
    }, 3000),
  ];

  const r = projectEconomy(events);
  // r1: (0.1 + (−0.2))/2 = −0.05；r2: (−0.3+0.3)/2 = 0；r3: 0
  assert.deepEqual(r.calibrationBias, [
    { reviewerId: "r1", bias: -0.05 },
    { reviewerId: "r2", bias: 0 },
    { reviewerId: "r3", bias: 0 },
  ]);
});

// ── Test 6: 只读性（纯函数——不触碰 ledger/voucher，不修改输入）──
test("只读性：投影为纯函数——冻结输入可安全重放，两次投影结果一致", () => {
  const events = deepFreeze([
    ev({ kind: "currency.mint", data: { agentId: "a1", amount: 100 } }, 1000),
    ev({ kind: "currency.buy_voucher", data: { agentId: "a1", kind: "llm", units: 10, cost: 100 } }, 2000),
    ev({ kind: "currency.burn", data: { agentId: "a1", kind: "llm", units: 3, creditCost: 30 } }, 3000),
    ev({ kind: "economy.escrow_freeze", data: { taskId: "t1", publisherId: "pub", amount: 96 } }, 4000),
    ev({ kind: "currency.transfer", data: { taskId: "t1", from: "a1", to: "a2", amount: 30 } }, 5000),
    ev({ kind: "economy.review_consensus", data: { taskId: "t1", R: 0.7, reviews: [{ reviewerId: "r1", score: 0.7 }] } }, 6000),
  ] as EconomyEvent[]);

  const before = JSON.stringify(events);
  const r1: EconomyReport = projectEconomy(events);
  const r2: EconomyReport = projectEconomy(events);
  assert.deepEqual(r1, r2, "同输入两次投影结果一致（纯函数）");
  assert.equal(JSON.stringify(events), before, "输入事件数组未被修改");
  assert.equal(r1.minted, 100);
  assert.equal(r1.voucherStock.llm, 7);
  assert.equal(r1.reviewerAccuracy[0]!.avgAccuracy, 1);
});
