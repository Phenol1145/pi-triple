// D2 Task 4：市场 effect fns（persist_task / adjust_escrow / apply_settlement）——原子层 + 事件流。
// 数值钉死：maxStake=20 O=3 N=5 stakeR=10 O_r=2 voucherAllowance=6 → escrowMax=96；stake=15 → actual=86。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteVoucher } from "../src/economy/voucher-port.ts";
import { MarketStore } from "../src/economy/market-store.ts";
import { EconomyEventBus } from "../src/economy/economy-events.ts";
import { registerMarketEffectFns } from "../src/economy/market-effects.ts";
import { ensureCentralPool, CENTRAL_POOL_ID } from "../src/economy/central-pool.ts";
import { planSettlement, type ReviewInput } from "../src/economy/settlement.ts";
import { EloFormulaRegistry, taskRatingFromOdds, simpleElo } from "../src/economy/elo.ts";
import type { ModelInfo } from "../src/types.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";

// ── helpers ──
const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
const RATES = { llm: 10, time: 5, compute: 2 };
function frozenOf(ledger: SqliteLedger, agent: string): number {
  const row = (ledger as unknown as { db: { prepare: (sql: string) => { get: (...a: string[]) => { frozen: number } | undefined } } }).db
    .prepare(`SELECT frozen FROM credits WHERE agent = ?`).get(agent);
  return row?.frozen ?? 0;
}
function model(id: string): ModelInfo { return { id, provider: id.split("/")[0], name: id, accessRoute: "free" }; }
function mk() {
  const store = new SqliteStore(":memory:");
  const db = store.raw;
  const ledger = new SqliteLedger(db, fixedEndow);
  ensureCentralPool(ledger);
  const mstore = new MarketStore(db);
  const events = new EconomyEventBus();
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: RATES }, poolId: CENTRAL_POOL_ID });
  return { store, db, ledger, mstore, events, voucher };
}

const TASK_ARGS = {
  taskSpec: {
    typeId: "code", publisherId: "pub1", maxStake: 20, odds: 3, reviewerCount: 5,
    stakeR: 10, oddsR: 2, voucherAllowance: 6, brief: "write tests",
  },
};

function pub1Endow(ledger: SqliteLedger): void {
  ledger.ensureEndowed("pub1", model("pub1")); // 1000
}

// 注册（真实小 registry——捕获 fn）
function makeRegistry() {
  const fns = new Map<string, (args: Record<string, unknown>) => unknown>();
  const registry = {
    register(name: string, fn: (args: Record<string, unknown>) => unknown) { fns.set(name, fn); },
    call(name: string, args: Record<string, unknown>) { return fns.get(name)!({ ...args }); },
  };
  return registry;
}

// 标准任务（已 persist）
function setupTask(m: ReturnType<typeof mk>) {
  pub1Endow(m.ledger);
  const reg = makeRegistry();
  registerMarketEffectFns(reg, {
    store: m.mstore, ledger: m.ledger, voucher: m.voucher, events: m.events, taxRate: 0.05,
  });
  const r = reg.call("market.persist_task", { ...TASK_ARGS, taskId: "t1" }) as { ok: boolean; skipped: boolean };
  assert.equal(r.skipped, false);
  return { reg, taskId: "t1" };
}

// ── 1. persist_task 正常 + 幂等 ──
test("persist_task：任务落库 + escrow_max 冻结（96）+ 事件", () => {
  const m = mk();
  pub1Endow(m.ledger);
  const reg = makeRegistry();
  registerMarketEffectFns(reg, { store: m.mstore, ledger: m.ledger, voucher: m.voucher, events: m.events, taxRate: 0.05 });
  const r = reg.call("market.persist_task", { ...TASK_ARGS, taskId: "t1" }) as { ok: boolean; skipped: boolean };
  assert.equal(r.skipped, false);
  const task = m.mstore.getTask("t1");
  assert.ok(task);
  assert.equal(task.status, "open");
  // escrowMax = 20×2 + 5×10×1 + 6 = 96
  assert.equal(m.ledger.balance("pub1"), 1000 - 96);
  assert.equal(frozenOf(m.ledger, "pub1"), 96);
  const kinds = m.events.drain().map((e) => e.kind);
  assert.ok(kinds.includes("economy.escrow_freeze"));

  // 幂等重试：skip（不重复冻结）
  const r2 = reg.call("market.persist_task", { ...TASK_ARGS, taskId: "t1" }) as { ok: boolean; skipped: boolean };
  assert.equal(r2.skipped, true);
  assert.equal(m.ledger.balance("pub1"), 1000 - 96);
  assert.equal(frozenOf(m.ledger, "pub1"), 96);
});

test("persist_task：余额不足抛错（发布拒绝）", () => {
  const m = mk();
  m.ledger.ensureEndowed("pub1", model("pub1"));
  m.ledger.debit("pub1", 950, "spent"); // balance 50 < 96 → 拒绝
  const reg = makeRegistry();
  registerMarketEffectFns(reg, { store: m.mstore, ledger: m.ledger, voucher: m.voucher, events: m.events, taxRate: 0.05 });
  assert.throws(() => reg.call("market.persist_task", { ...TASK_ARGS, taskId: "t1" }), /freezeEscrowMax rejected/);
  assert.equal(m.mstore.getTask("t1"), undefined); // 任务不落库
  assert.equal(m.ledger.balance("pub1"), 50);
});

// ── 2. adjust_escrow：96→86 + 未中标解冻 + 事件 ──
test("adjust_escrow：调减解冻 10 + 2 未中标 bid 解冻 + 3 事件；幂等", () => {
  const m = mk();
  const { reg, taskId } = setupTask(m);
  // 三个 bidder 冻结（中标 a1 stake=15；a2/a3 未中标）
  m.ledger.ensureEndowed("a1", model("a1")); m.ledger.ensureEndowed("a2", model("a2")); m.ledger.ensureEndowed("a3", model("a3"));
  m.ledger.freeze("a1", 15 * 2, taskId);
  m.ledger.freeze("a2", 12 * 2, taskId);
  m.ledger.freeze("a3", 8 * 2, taskId);
  assert.equal(m.ledger.balance("a2"), 1000 - 24);

  const r = reg.call("market.adjust_escrow", { taskId, winnerId: "a1", winnerStake: 15, bids: [
    { bidderId: "a1", stake: 15 }, { bidderId: "a2", stake: 12 }, { bidderId: "a3", stake: 8 },
  ] }) as { ok: boolean };
  assert.equal(r.ok, true);
  // escrow 96→86：解冻 10
  assert.equal(m.ledger.balance("pub1"), 1000 - 86);
  assert.equal(frozenOf(m.ledger, "pub1"), 86);
  // 未中标解冻：a2/a3 全额回；a1 保留冻结
  assert.equal(m.ledger.balance("a2"), 1000);
  assert.equal(m.ledger.balance("a3"), 1000);
  assert.equal(frozenOf(m.ledger, "a1"), 30);
  // 事件
  const kinds = m.events.drain().map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "economy.escrow_adjust").length, 1);
  assert.equal(kinds.filter((k) => k === "economy.bid_release").length, 2);
  // 状态
  const task = m.mstore.getTask(taskId);
  assert.equal(task!.status, "awarded");
  assert.equal(task!.winnerId, "a1");

  // 幂等：再次调用 skip（status 非 open）
  const r2 = reg.call("market.adjust_escrow", { taskId, winnerId: "a1", winnerStake: 15, bids: [] }) as { ok: boolean };
  assert.equal(r2.ok, true);
  assert.equal(frozenOf(m.ledger, "pub1"), 86);
});

// ── 3. apply_settlement 正常路径：winner 得净额 / publisher 减 / 税入池 / elo 事件 ──
test("apply_settlement：正 settle → winner 净额 + 税入池 + 事件", () => {
  const m = mk();
  const { reg, taskId } = setupTask(m);
  // 中标 + 冻结
  m.ledger.ensureEndowed("a1", model("a1")); m.ledger.ensureEndowed("r1", model("r1")); m.ledger.ensureEndowed("r2", model("r2"));
  m.ledger.freeze("a1", 30, taskId);
  m.ledger.freeze("r1", 10, taskId);
  m.ledger.freeze("r2", 10, taskId);
  m.mstore.updateTask(taskId, { status: "awarded", winnerId: "a1", winnerStake: 15 });
  // 调减 escrow 到 86（模拟 adjust 后）
  m.ledger.adjustFreeze("pub1", taskId, 86);

  // 结算 plan（reviews=[0.9,0.5] → R=上中位数 0.9 → c=0.9 → 15×2×0.8=24；
  // r1 a=1.0→10；r2 a=1−0.4=0.6→2；tax=(24+10+2)×0.05=1.8）
  const reviews: ReviewInput[] = [
    { reviewerId: "r1", score: 0.9 }, { reviewerId: "r2", score: 0.5 },
  ];
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const plan = planSettlement({
    task: m.mstore.getTask(taskId)!,
    winnerId: "a1", winnerStake: 15, reviews,
    eloFn: elo.get("simple-elo"), taxRate: 0.05,
    executorElo: { global: 1500, byDomain: {} },
    reviewerElos: new Map([
      ["r1", { global: 1500, byDomain: {} }],
      ["r2", { global: 1500, byDomain: {} }],
    ]),
    taskRating: taskRatingFromOdds(3),
  });

  const r = reg.call("market.apply_settlement", { taskId, plan, winnerId: "a1" }) as { ok: boolean };
  assert.equal(r.ok, true);

  // winner 净额 = 24 − 1.2 = 22.8（税 5%：24×0.05）
  const winnerNet = 24 - 24 * 0.05;
  // publisher：1000 −96(persist) +10(adjust) +86(escrow 解冻) −24(executor gross) −10(r1) −2(r2) = 964
  assert.equal(m.ledger.balance("pub1"), 1000 - 96 + 10 + 86 - 24 - 10 - 2);
  assert.equal(frozenOf(m.ledger, "pub1"), 0);
  assert.equal(m.ledger.balance("a1"), 1000 + winnerNet); // 冻结 30 已返 + 净额
  // 评审者：r1 冻结 10 返 + 净 9.5；r2 冻结 10 返 + 净 1.9
  assert.equal(m.ledger.balance("r1"), 1000 - 10 + 10 + 9.5);
  assert.equal(m.ledger.balance("r2"), 1000 - 10 + 10 + 1.9);
  // 税：1.2 + 0.5 + 0.1 = 1.8 入池
  assert.ok(Math.abs(m.ledger.balance(CENTRAL_POOL_ID) - 1.8) < 1e-9);
  // 事件
  const kinds = m.events.drain().map((e) => e.kind);
  assert.ok(kinds.includes("economy.settle"));
  assert.ok(kinds.includes("currency.tax"));
  // 状态
  const task = m.mstore.getTask(taskId);
  assert.equal(task!.status, "settled");

  // 幂等：再次调用 skip
  const r2 = reg.call("market.apply_settlement", { taskId, plan, winnerId: "a1" }) as { ok: boolean };
  assert.equal(r2.ok, true);
  assert.equal(m.ledger.balance("a1"), 1000 + winnerNet);
});

// ── 4. 负 settle：执行者冻结直付 publisher ──
test("apply_settlement：majorError → −stake 执行者冻结直付 publisher", () => {
  const m = mk();
  const { reg, taskId } = setupTask(m);
  m.ledger.ensureEndowed("a1", model("a1"));
  m.ledger.freeze("a1", 30, taskId);
  m.mstore.updateTask(taskId, { status: "awarded", winnerId: "a1", winnerStake: 15 });
  m.ledger.adjustFreeze("pub1", taskId, 86);

  // majorError plan：settle = −15（需 ≥1 评审输入——R 计算仍执行）
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const plan = planSettlement({
    task: m.mstore.getTask(taskId)!,
    winnerId: "a1", winnerStake: 15, reviews: [{ reviewerId: "r1", score: 0.5 }],
    majorError: true,
    eloFn: elo.get("simple-elo"), taxRate: 0.05,
    executorElo: { global: 1500, byDomain: {} },
    reviewerElos: new Map([["r1", { global: 1500, byDomain: {} }]]),
    taskRating: taskRatingFromOdds(3),
  });
  assert.equal(plan.executorSettle, -15);

  const r = reg.call("market.apply_settlement", { taskId, plan, winnerId: "a1" }) as { ok: boolean };
  assert.equal(r.ok, true);
  // 执行者冻结返还 30 + 直付 15 给 publisher → a1 = 1000 − 30 + 30 − 15 = 985
  assert.equal(m.ledger.balance("a1"), 1000 - 15);
  // publisher：escrow 86 解冻回 + 收到 15 直付 = 1000 − 96 + 86 + 15
  assert.equal(m.ledger.balance("pub1"), 1000 - 96 + 86 + 15);
  assert.equal(frozenOf(m.ledger, "pub1"), 0);
  const evt = m.events.drain().find((e) => e.kind === "economy.settle");
  assert.equal((evt!.data as { to: string }).to, "pub1");
});

// ── 5. 评审者负 settle → 入池 ──
test("apply_settlement：评审者负 settle → 入中央池", () => {
  const m = mk();
  const { reg, taskId } = setupTask(m);
  m.ledger.ensureEndowed("a1", model("a1")); m.ledger.ensureEndowed("r1", model("r1"));
  m.ledger.freeze("a1", 30, taskId);
  m.ledger.freeze("r1", 10, taskId);
  m.mstore.updateTask(taskId, { status: "awarded", winnerId: "a1", winnerStake: 15 });
  m.ledger.adjustFreeze("pub1", taskId, 86);

  // reviews=[0, 0.9] → R=上中位数 0.9；r1 score=0 → a=1−0.9=0.1 → settle_i=10×1×(0.2−1)=−8；
  // executor c=0.9 → 15×2×0.8=24
  const reviews: ReviewInput[] = [{ reviewerId: "r1", score: 0 }, { reviewerId: "r2", score: 0.9 }];
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const plan = planSettlement({
    task: m.mstore.getTask(taskId)!,
    winnerId: "a1", winnerStake: 15, reviews,
    eloFn: elo.get("simple-elo"), taxRate: 0.05,
    executorElo: { global: 1500, byDomain: {} },
    reviewerElos: new Map([
      ["r1", { global: 1500, byDomain: {} }],
      ["r2", { global: 1500, byDomain: {} }],
    ]),
    taskRating: taskRatingFromOdds(3),
  });
  assert.equal(plan.reviewerSettles.get("r1"), -8);
  assert.equal(plan.executorSettle, 24);

  const r = reg.call("market.apply_settlement", { taskId, plan, winnerId: "a1" }) as { ok: boolean };
  assert.equal(r.ok, true);
  // r1 冻结 10 全额返还 → 扣回池 8（评审者负 settle 入池——C-R4-1）
  assert.equal(m.ledger.balance("r1"), 1000 - 8);
  // 池 = 8(负 settle) + 税(24×0.05 + 10×0.05 = 1.7) = 9.7
  assert.ok(Math.abs(m.ledger.balance(CENTRAL_POOL_ID) - 9.7) < 1e-9);
  const evt = m.events.drain().find((e) => e.kind === "economy.settle" && (e.data as { role: string }).role === "reviewer");
  assert.equal((evt!.data as { to: string }).to, CENTRAL_POOL_ID);
});

// ── 6. 单事务原子：中途失败回滚 ──
test("apply_settlement：内部失败 → 单事务回滚（余额/elo/状态原样）", () => {
  const m = mk();
  const { reg, taskId } = setupTask(m);
  m.ledger.ensureEndowed("a1", model("a1")); m.ledger.ensureEndowed("r1", model("r1"));
  m.ledger.freeze("a1", 30, taskId);
  m.ledger.freeze("r1", 10, taskId);
  m.mstore.updateTask(taskId, { status: "awarded", winnerId: "a1", winnerStake: 15 });
  m.ledger.adjustFreeze("pub1", taskId, 86);
  const beforePub = m.ledger.balance("pub1");

  // 构造 plan 使执行者 gross 支付超过 publisher 解冻后余额 → debit 不抛错但夹紧……
  // 更直接：评审者负 settle 入池时池扣减路径无失败——用"评审者不存在冻结"模拟？不。
  // 改为验证：负 settle 时 releaseBid 无冻结行 → 幂等返回 0（不抛）——原子性由事务保证，
  // 这里用 mock ledger 注入失败验证 ROLLBACK。
  const failingLedger = new Proxy(m.ledger, {
    get(target, prop) {
      if (prop === "credit" && (target as unknown as Record<string, unknown>)._failNext) {
        (target as unknown as Record<string, unknown>)._failNext = false;
        throw new Error("injected failure");
      }
      const v = (target as unknown as Record<string, unknown>)[prop as string];
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as SqliteLedger;
  (failingLedger as unknown as { _failNext: boolean })._failNext = true;

  const reg2 = makeRegistry();
  registerMarketEffectFns(reg2, { store: m.mstore, ledger: failingLedger, voucher: m.voucher, events: m.events, taxRate: 0.05 });
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const reviews: ReviewInput[] = [{ reviewerId: "r1", score: 0.9 }];
  const plan = planSettlement({
    task: m.mstore.getTask(taskId)!,
    winnerId: "a1", winnerStake: 15, reviews,
    eloFn: elo.get("simple-elo"), taxRate: 0.05,
    executorElo: { global: 1500, byDomain: {} },
    reviewerElos: new Map([["r1", { global: 1500, byDomain: {} }]]),
    taskRating: taskRatingFromOdds(3),
  });

  assert.throws(() => reg2.call("market.apply_settlement", { taskId, plan, winnerId: "a1" }), /injected failure/);
  // 全部回滚：publisher 余额/冻结原样
  assert.equal(m.ledger.balance("pub1"), beforePub);
  assert.equal(frozenOf(m.ledger, "pub1"), 86);
  // a1/r1 冻结原样
  assert.equal(frozenOf(m.ledger, "a1"), 30);
  assert.equal(frozenOf(m.ledger, "r1"), 10);
  // 任务状态未 settled
  assert.equal(m.mstore.getTask(taskId)!.status, "awarded");
});

// ── 7. 校准任务 isCalibration 透传 ──
test("apply_settlement：校准任务事件带 isCalibration 标记", () => {
  const m = mk();
  const reg = makeRegistry();
  registerMarketEffectFns(reg, { store: m.mstore, ledger: m.ledger, voucher: m.voucher, events: m.events, taxRate: 0.05 });
  // 校准 persist
  m.ledger.ensureEndowed("pub1", model("pub1"));
  reg.call("market.persist_task", {
    ...TASK_ARGS, taskId: "cal1",
    isCalibration: true, groundTruth: "gt-artifact",
  });
  m.ledger.ensureEndowed("a1", model("a1")); m.ledger.ensureEndowed("r1", model("r1"));
  m.ledger.freeze("a1", 30, "cal1");
  m.ledger.freeze("r1", 10, "cal1");
  m.mstore.updateTask("cal1", { status: "awarded", winnerId: "a1", winnerStake: 15 });
  m.ledger.adjustFreeze("pub1", "cal1", 86);

  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const reviews: ReviewInput[] = [{ reviewerId: "r1", score: 0.9 }];
  const plan = planSettlement({
    task: m.mstore.getTask("cal1")!,
    winnerId: "a1", winnerStake: 15, reviews,
    groundTruthScore: 0.9,
    eloFn: elo.get("simple-elo"), taxRate: 0.05,
    executorElo: { global: 1500, byDomain: {} },
    reviewerElos: new Map([["r1", { global: 1500, byDomain: {} }]]),
    taskRating: taskRatingFromOdds(3),
  });

  const r = reg.call("market.apply_settlement", { taskId: "cal1", plan, winnerId: "a1" }) as { ok: boolean };
  assert.equal(r.ok, true);
  const events = m.events.drain();
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.isCalibration, true);
  }
});
