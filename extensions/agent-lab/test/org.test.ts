// 组织测试（plan Task 7 / spec §6）——org_members / 垫付制 / 违约链。
// 6 测试（plan Step 1 逐字）：垫付成功、凭证成本优先（先本后息）、垫付失败违约链、
// burnHistory traceId 精确、评审互斥对接（SqliteOrgMembership 真实过滤）、嵌套市场
// （组织对外中标 → 内部 subflow（成员候选）→ 子结算回传 + M-1 双重冻结）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteVoucher, type VoucherPort } from "../src/economy/voucher-port.ts";
import { EconomyEventBus } from "../src/economy/economy-events.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { simpleElo } from "../src/economy/elo.ts";
import {
  SqliteOrgMembership,
  planPayouts,
  executeOrgPayout,
  orgProfitAfterPayouts,
  voucherCostForTask,
  type OrgPayoutDeps,
} from "../src/economy/org.ts";
import { selectReviewers, type ReviewRoundDeps } from "../src/economy/review-round.ts";
import { MarketStore, type MarketTask } from "../src/economy/market-store.ts";
import { freezeBid, freezeEscrowMax, escrowMax, type EscrowParams } from "../src/economy/escrow.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import type { Ledger } from "../src/arena/types.ts";

function agentRecord(id: string, over: Partial<AgentInstanceRecord> = {}): AgentInstanceRecord {
  return {
    id,
    schedulerInstanceId: "si-1",
    definition: {
      standard: {
        name: "test-agent",
        capabilities: ["test"],
        executionKind: "workloop",
        labels: {},
      },
      workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
      custom: {},
    },
    createdAtRoundId: "r0",
    status: "ready",
    createdAt: 1000,
    ...over,
  };
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

function makeOrgDeps(db: DatabaseSync, ledger: SqliteLedger, over: Partial<OrgPayoutDeps> = {}): OrgPayoutDeps {
  return {
    db,
    ledger,
    events: new EconomyEventBus(),
    repository: new CoreRepository(db),
    eloFn: simpleElo,
    ...over,
  };
}

/** 建行 + 精确 credit（initialCredits=0——余额断言可精确）。 */
function endow(ledger: SqliteLedger, id: string, amount: number): void {
  ledger.ensureEndowed(id, { id, provider: "p", name: id, accessRoute: "free" });
  ledger.credit(id, amount, "endow");
}

// ============================================================================
// Test 1: 垫付成功：3 成员 settle+cost → payouts=成本+收益 → 余额扣减正确
// ============================================================================
test("垫付成功：3 成员 settle+cost → payouts=成本+收益 → 余额扣减正确（幂等 taskId）", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 0 });
  const deps = makeOrgDeps(db, ledger);
  endow(ledger, "org-1", 100);

  const memberSettles = new Map([
    ["m1", 30],
    ["m2", 20],
    ["m3", 10],
  ]);
  const voucherCosts = new Map([
    ["m1", 5],
    ["m2", 5],
    ["m3", 5],
  ]);

  const result = executeOrgPayout(deps, { taskId: "t-1", orgId: "org-1", memberSettles, voucherCosts });

  // 垫付全额：payout = 成本 + 收益
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.defaulted, false);
  assert.equal(result.plan.partial, false);
  assert.deepEqual([...result.plan.payouts.entries()], [
    ["m1", 35],
    ["m2", 25],
    ["m3", 15],
  ]);
  assert.equal(result.totalPayouts, 75);
  // 余额扣减正确（资金守恒：org 100 → 25；成员 0 → 35/25/15）
  assert.equal(result.orgBalanceAfter, 25);
  assert.equal(ledger.balance("org-1"), 25);
  assert.equal(ledger.balance("m1"), 35);
  assert.equal(ledger.balance("m2"), 25);
  assert.equal(ledger.balance("m3"), 15);

  // 幂等：同 taskId 重跑 skip，不重复扣款（I8 effect 幂等）
  const again = executeOrgPayout(deps, { taskId: "t-1", orgId: "org-1", memberSettles, voucherCosts });
  assert.equal(again.skipped, true);
  assert.equal(again.totalPayouts, 0);
  assert.equal(ledger.balance("org-1"), 25);

  // 审计：3 笔 currency.transfer（org → member）
  const transfers = deps.events.drain().filter((e) => e.kind === "currency.transfer");
  assert.equal(transfers.length, 3);
  assert.deepEqual(transfers.map((e) => e.data.amount).sort((a, b) => (a as number) - (b as number)), [15, 25, 35]);

  db.close();
});

// ============================================================================
// Test 2: 凭证成本优先：余额只够成本 → 成本全付 + 收益部分付（partial=true，先本后息）
// ============================================================================
test("凭证成本优先：余额只够成本 → 成本全付 + 收益部分付（partial=true，先本后息）", () => {
  const memberSettles = new Map([
    ["m1", 20],
    ["m2", 20],
  ]);
  const voucherCosts = new Map([
    ["m1", 10],
    ["m2", 10],
  ]);

  // 余额 = 总成本 20：成本全付（本），收益 0 付（息）——partial=true
  const p1 = planPayouts({ orgBalance: 20, memberSettles, voucherCosts });
  assert.equal(p1.partial, true);
  assert.deepEqual([...p1.payouts.entries()], [
    ["m1", 10],
    ["m2", 10],
  ]);

  // 余额 25：成本 20 全付 + 收益 5（按成员序先付 m1——先本后息 FIFO）
  const p2 = planPayouts({ orgBalance: 25, memberSettles, voucherCosts });
  assert.equal(p2.partial, true);
  assert.deepEqual([...p2.payouts.entries()], [
    ["m1", 15],
    ["m2", 10],
  ]);

  // 余额充足 60（= 成本 20 + 收益 40）：成本 + 收益全付，partial=false
  const p3 = planPayouts({ orgBalance: 60, memberSettles, voucherCosts });
  assert.equal(p3.partial, false);
  assert.deepEqual([...p3.payouts.entries()], [
    ["m1", 30],
    ["m2", 30],
  ]);

  // 负 settle 不垫付（成员负结算由内部结算另行收取——本函数只垫付正收益）
  const p4 = planPayouts({
    orgBalance: 100,
    memberSettles: new Map([["m1", -20]]),
    voucherCosts: new Map([["m1", 10]]),
  });
  assert.equal(p4.partial, false);
  assert.deepEqual([...p4.payouts.entries()], [["m1", 10]]);
});

// ============================================================================
// Test 3: 垫付失败：余额为零 → org_default 事件 + 成员 stake 退还 + 组织 elo majorError
// ============================================================================
test("垫付失败：余额为零 → org_default 事件 + 成员 stake 退还 + 组织 elo majorError（outcome=0）", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 0 });
  const repo = new CoreRepository(db);
  const deps = makeOrgDeps(db, ledger, { repository: repo });
  endow(ledger, "org-1", 0); // 余额为零 → 无法垫付
  endow(ledger, "m1", 20);
  endow(ledger, "m2", 10);
  repo.insertAgent(agentRecord("org-1", { eloGlobal: 1500 }));

  // 成员 stake 冻结在成员自身账户（内部任务 bid 冻结同构——M-1 成员面；O=2 → 冻结额=stake）
  freezeBid(ledger, "m1", "t-3", 20, 2);
  freezeBid(ledger, "m2", "t-3", 10, 2);

  const result = executeOrgPayout(deps, {
    taskId: "t-3",
    orgId: "org-1",
    memberSettles: new Map([
      ["m1", 30],
      ["m2", 20],
    ]),
    voucherCosts: new Map([
      ["m1", 5],
      ["m2", 5],
    ]),
    memberStakes: new Map([
      ["m1", 20],
      ["m2", 10],
    ]),
  });

  // 违约链触发
  assert.equal(result.defaulted, true);
  assert.equal(result.totalPayouts, 0); // 余额为零 → 无可垫付
  // 成员 stake 退还：冻结全额解冻回成员（资金守恒——退还自己的冻结，不凭空造币）
  assert.deepEqual([...result.refundedStakes.entries()], [
    ["m1", 20],
    ["m2", 10],
  ]);
  assert.equal(ledger.balance("m1"), 20);
  assert.equal(ledger.balance("m2"), 10);
  // 组织 elo 按 majorError：outcome=0 → simpleElo K×(0−0.5) = −16（Task 3 ruling）
  assert.equal(result.eloDelta, -16);
  assert.equal(repo.getAgent("org-1")!.eloGlobal, 1500 - 16);
  // org_default 事件（审计——Task 9 成员私域经验由本事件触发）
  const def = deps.events.drain().find((e) => e.kind === "economy.org_default");
  assert.ok(def, "economy.org_default 事件应发射");
  assert.equal(def!.data.taskId, "t-3");
  assert.equal(def!.data.orgId, "org-1");
  assert.deepEqual(def!.data.refundedStakes, { m1: 20, m2: 10 });

  db.close();
});

// ============================================================================
// Test 4: burnHistory traceId 精确取本次燃烧（多任务燃烧不混淆）
// ============================================================================
test("burnHistory traceId 精确取本次燃烧（多任务燃烧不混淆）", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 0 });
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: { llm: 1, time: 1, compute: 1 } } });
  const deps = makeOrgDeps(db, ledger);
  endow(ledger, "m1", 100);
  endow(ledger, "org-1", 100);

  // 两次任务燃烧（traceId 不同）
  voucher.buy("m1", "llm", 20);
  voucher.burn("m1", "llm", 8, { traceId: "task-x", transitionSeq: 1 });
  voucher.burn("m1", "llm", 4, { traceId: "task-y", transitionSeq: 1 });

  // 精确取本次燃烧（FIFO 折算：1 unit = 1 credit；多任务不混淆）
  assert.equal(voucherCostForTask(voucher, "m1", "task-x"), 8);
  assert.equal(voucherCostForTask(voucher, "m1", "task-y"), 4);
  const histX = voucher.burnHistory("m1", "llm", { traceId: "task-x" });
  assert.equal(histX.length, 1);
  assert.equal(histX[0].units, 8);

  // 垫付只补偿 task-x 的成本（task-y 的 4 不混入）
  const result = executeOrgPayout(deps, {
    taskId: "task-x",
    orgId: "org-1",
    memberSettles: new Map([["m1", 30]]),
    voucherCosts: new Map([["m1", voucherCostForTask(voucher, "m1", "task-x")]]),
  });
  assert.equal(result.defaulted, false);
  assert.equal(result.totalPayouts, 38); // 30 + 8（不含 task-y 的 4）
  assert.deepEqual([...result.plan.payouts.entries()], [["m1", 38]]);

  db.close();
});

// ============================================================================
// Test 5: 评审互斥对接：selectReviewers（Task 5 空实现 → SqliteOrgMembership 真实过滤）
// ============================================================================
test("评审互斥对接：selectReviewers 经 SqliteOrgMembership 真实过滤（同组织排除）", () => {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  const orgMembers = new SqliteOrgMembership(db);

  // 组织成员表（真实表）：执行者 + 2 名高 elo 评审者同组织
  orgMembers.addMember("org-1", "reviewer-9");
  orgMembers.addMember("org-1", "reviewer-8");
  orgMembers.addMember("org-1", "executor-10");

  // 候选池：域 elo 递增（reviewer-1 最低 → reviewer-10 最高）
  const pool: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const id = `reviewer-${i}`;
    repo.insertAgent(agentRecord(id, { accepts: ["code"], eloGlobal: 1400 + i * 10, eloByDomain: { code: 1500 + i * 10 } }));
    pool.push(id);
  }
  repo.insertAgent(agentRecord("executor-10", { accepts: ["code"], eloGlobal: 1600, eloByDomain: { code: 1600 } }));

  const deps: ReviewRoundDeps = {
    store: new MarketStore(db),
    ledger: mockLedger(),
    orgMembers, // ← SqliteOrgMembership 真实实现（Task 5 空实现替换——同组织成员真实过滤）
    reviewerCount: 5,
    minReviewers: 3,
    eloLookup: (agentId: string) => {
      const a = repo.getAgent(agentId);
      if (!a) return undefined;
      return { eloGlobal: a.eloGlobal, eloByDomain: a.eloByDomain };
    },
  };

  const task: MarketTask = {
    taskId: "t-5",
    typeId: "code",
    publisherId: "pub-1",
    maxStake: 15,
    odds: 3,
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    brief: "b",
    status: "reviewing",
    winnerId: "executor-10",
    winnerStake: 15,
    createdAt: Date.now(),
  };

  const selected = selectReviewers(deps, task, "executor-10", pool);
  // 同组织 3 人（executor-10 + reviewer-9/8——除 reviewer-10 外最高 elo 端）全部排除
  // → 剩余 reviewer-1..7 + reviewer-10（1600）→ 降序取前 5
  assert.deepEqual(selected, ["reviewer-10", "reviewer-7", "reviewer-6", "reviewer-5", "reviewer-4"]);
  assert.ok(!selected.includes("executor-10"));
  assert.ok(!selected.includes("reviewer-9"));
  assert.ok(!selected.includes("reviewer-8"));

  // 成员表真实查询/增删
  assert.deepEqual(orgMembers.membersOf("org-1").sort(), ["executor-10", "reviewer-8", "reviewer-9"]);
  assert.equal(orgMembers.orgOf("reviewer-8"), "org-1");
  assert.equal(orgMembers.orgOf("stranger"), undefined);
  orgMembers.removeMember("org-1", "reviewer-8");
  assert.equal(orgMembers.orgOf("reviewer-8"), undefined);
  assert.equal(orgMembers.membersOf("org-1").length, 2);

  db.close();
});

// ============================================================================
// Test 6: 嵌套市场：组织对外中标 → 内部 subflow（成员候选）→ 子结算回传 + 双重冻结（M-1）
// ============================================================================
// 注：D1 subflow 节点（子 run 创建 + in/out state 映射）由 PTL flow engine 执行（已交付，
// agent-lab 测试不引入 PTL——见报告适配说明）；本测试验证 org 层数据流形状：
// 组织对外中标（外部 bid 冻结）→ 内部任务（成员候选）→ 成员执行燃烧 → 组织垫付 →
// 子结算回传（payouts 汇总 → 组织利润）→ M-1 双重冻结资本需求。
test("嵌套市场：组织对外中标 → 内部 subflow（成员候选）→ 子结算回传 + 双重冻结（M-1）", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 0 });
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: { llm: 1, time: 1, compute: 1 } } });
  const deps = makeOrgDeps(db, ledger);
  const orgMembers = new SqliteOrgMembership(db);

  // 组织 + 成员候选（内部市场候选集 = org_members 查询）
  endow(ledger, "org-1", 200);
  endow(ledger, "m1", 50);
  endow(ledger, "m2", 50);
  orgMembers.addMember("org-1", "m1");
  orgMembers.addMember("org-1", "m2");

  // ── M-1 双重冻结：外部 bid 冻结（stake_org×(O−1)）+ 内部 escrow_max 冻结 ──
  const externalOdds = 3;
  const stakeOrg = 20;
  freezeBid(ledger, "org-1", "ext-task", stakeOrg, externalOdds); // 40
  const internalEscrowParams: EscrowParams = { maxStake: 10, odds: 2, reviewerCount: 3, stakeR: 5, oddsR: 2, voucherAllowance: 4 };
  freezeEscrowMax(ledger, "org-1", "int-task-1", internalEscrowParams); // 29
  freezeEscrowMax(ledger, "org-1", "int-task-2", internalEscrowParams); // 29
  // 资本需求 = 外部 bid 冻结 + 内部 escrow_max 之和（装配指引：启动资本需覆盖两者之和）
  const doubleFreeze = stakeOrg * (externalOdds - 1) + 2 * escrowMax(internalEscrowParams);
  assert.equal(doubleFreeze, 40 + 58);
  const frozenRow = db.prepare(`SELECT SUM(amount) AS total FROM arena_freezes WHERE agent = 'org-1'`).get() as { total: number };
  assert.equal(frozenRow.total, 98, "组织账面冻结 = 双重冻结之和");

  // M-1 负例：启动资本不足双重冻结之和 → 内部 escrow 冻结被拒（fail-fast，I1）
  endow(ledger, "org-2", 50);
  freezeBid(ledger, "org-2", "ext-task-2", stakeOrg, externalOdds); // 40 OK
  assert.throws(
    () => freezeEscrowMax(ledger, "org-2", "int-task-1", internalEscrowParams), // 剩 10 < 29
    /rejected/,
  );

  // ── 内部市场执行：成员烧自己的凭证（traceId = 内部任务 id，I2 精确补偿）──
  voucher.buy("m1", "llm", 20);
  voucher.buy("m2", "llm", 20);
  voucher.burn("m1", "llm", 6, { traceId: "int-task-1", transitionSeq: 1 });
  voucher.burn("m2", "llm", 4, { traceId: "int-task-2", transitionSeq: 1 });

  // ── 内部结算 → 组织垫付（每个内部任务一次 executeOrgPayout）──
  const r1 = executeOrgPayout(deps, {
    taskId: "int-task-1",
    orgId: "org-1",
    memberSettles: new Map([["m1", 25]]),
    voucherCosts: new Map([["m1", voucherCostForTask(voucher, "m1", "int-task-1")]]),
  });
  const r2 = executeOrgPayout(deps, {
    taskId: "int-task-2",
    orgId: "org-1",
    memberSettles: new Map([["m2", 15]]),
    voucherCosts: new Map([["m2", voucherCostForTask(voucher, "m2", "int-task-2")]]),
  });
  assert.equal(r1.defaulted, false);
  assert.equal(r2.defaulted, false);
  assert.equal(r1.totalPayouts, 31); // 25 + 6
  assert.equal(r2.totalPayouts, 19); // 15 + 4

  // ── 子结算回传：子图结算（payouts 汇总）回传父图 → 组织利润 = settle_org − Σpayouts − 税 ──
  const totalPayouts = r1.totalPayouts + r2.totalPayouts;
  assert.equal(totalPayouts, 50);
  const profit1 = orgProfitAfterPayouts({ settleOrg: 60, totalPayouts, tax: 60 * 0.05 });
  assert.equal(profit1, 7);
  // 利润允许为负（观测项，spec §6.4）：
  const profit2 = orgProfitAfterPayouts({ settleOrg: 40, totalPayouts, tax: 40 * 0.05 });
  assert.equal(profit2, -12);

  // 成员实收（资金守恒：50 余额 − 20 购凭证 + 垫付）
  assert.equal(ledger.balance("m1"), 61);
  assert.equal(ledger.balance("m2"), 49);

  db.close();
});
