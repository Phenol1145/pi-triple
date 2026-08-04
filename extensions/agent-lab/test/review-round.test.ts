// 多评评审轮测试（plan Task 5 / spec §7a.1/2/8）。
// 6 测试：评审者互斥选择、bid 冻结、流标阶梯、重试 2 次 operator 兜底、review_refund 幂等、评审者负结算流向。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MarketStore } from "../src/economy/market-store.ts";
import { registerMarketCodeFns, type MarketFnsDeps, type CodeRegistry } from "../src/economy/market-fns.ts";
import { registerMarketEffectFns, type MarketEffectsDeps, type EffectRegistry } from "../src/economy/market-effects.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteVoucher, type VoucherPort } from "../src/economy/voucher-port.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { EconomyEventBus } from "../src/economy/economy-events.ts";
import { selectReviewers, type ReviewRoundDeps, type ReviewRoundResult } from "../src/economy/review-round.ts";
import { SqliteTaskTypeRegistry, type TaskType } from "../src/economy/task-types.ts";
import {
  EloFormulaRegistry,
  SelectionFormulaRegistry,
  simpleElo,
  stakeEloPower,
} from "../src/economy/elo.ts";
import type { Ledger } from "../src/arena/types.ts";
import { freezeBid } from "../src/economy/escrow.ts";

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

function mockVoucher(): VoucherPort {
  return {
    buy: () => {},
    balance: () => 0,
    burn: () => {},
    burnHistory: () => [],
  };
}

function makeCodeRegistry(): CodeRegistry & {
  resolve(name: string): ((args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) | undefined;
} {
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

function makeEffectRegistry(): EffectRegistry & {
  resolve(name: string): ((args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) | undefined;
} {
  const fns = new Map<string, (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
  return {
    register(name: string, fn: (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
      if (fns.has(name)) throw new Error(`effect fn already registered: ${name}`);
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

function makeDeps(
  db: DatabaseSync,
  over: Partial<MarketFnsDeps> = {}
): MarketFnsDeps {
  const taskTypes = new SqliteTaskTypeRegistry(db);
  const codeType: TaskType = {
    id: "code",
    description: "coding task",
    registeredBy: "test",
    createdAt: 1000,
  };
  taskTypes.register(codeType);

  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const selection = new SelectionFormulaRegistry();
  selection.register(stakeEloPower);

  const repo = new CoreRepository(db);

  return {
    store: new MarketStore(db),
    ledger: mockLedger(),
    voucher: mockVoucher(),
    elo,
    selection,
    taskTypes,
    calibrationRate: 0.1,
    rng: () => 0.99,
    agentLookup: (agentId: string) => {
      const a = repo.getAgent(agentId);
      if (!a) return undefined;
      return {
        accepts: a.accepts,
        eloGlobal: a.eloGlobal,
        eloByDomain: a.eloByDomain,
      };
    },
    ...over,
  };
}

function makeEffectsDeps(
  db: DatabaseSync,
  ledger: SqliteLedger,
  voucher: VoucherPort,
  over: Partial<MarketEffectsDeps> = {}
): MarketEffectsDeps {
  const repo = new CoreRepository(db);
  const events = new EconomyEventBus();
  return {
    store: new MarketStore(db),
    ledger,
    voucher,
    events,
    repository: repo,
    taxRate: 0.05,
    db,
    ...over,
  };
}

function baseTask(): Record<string, unknown> {
  return {
    taskId: "task-1",
    typeId: "code",
    publisherId: "pub-1",
    maxStake: 15,
    odds: 3,
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    brief: "fix the bug",
    status: "reviewing",
    winnerId: "executor-1",
    winnerStake: 15,
    createdAt: Date.now(),
    isCalibration: false,
  };
}

function setupReviewPool(db: DatabaseSync, poolSize: number = 10): string[] {
  const repo = new CoreRepository(db);
  const pool: string[] = [];
  for (let i = 1; i <= poolSize; i++) {
    const id = `reviewer-${i}`;
    // 域 elo 递增：reviewer-1 最低，reviewer-10 最高
    repo.insertAgent(agentRecord(id, { accepts: ["code"], eloGlobal: 1400 + i * 10, eloByDomain: { code: 1500 + i * 10 } }));
    pool.push(id);
  }
  return pool;
}

// ============================================================================
// Test 1: 评审者选择：10 候选 → 互斥过滤（执行者+同组织 2 人排除）→ elo 降序前 5
// ============================================================================
test("selectReviewers：10 候选 → 互斥过滤（执行者+同组织 2 人排除）→ elo 降序前 5", () => {
  const db = new DatabaseSync(":memory:");
  const pool = setupReviewPool(db, 10);
  // 执行者 = reviewer-1（elo 最低），同组织 = reviewer-2, reviewer-3
  const executorId = "reviewer-1";
  const orgMembers = ["reviewer-2", "reviewer-3"];

  // OrgMembership 最小实现（Task 6 前空实现接口，测试用内存假实现）
  const orgMembersImpl = {
    membersOf: (orgId: string) => (orgId === "org-1" ? orgMembers : []),
    orgOf: (agentId: string) => (orgMembers.includes(agentId) ? "org-1" : undefined),
    addMember: () => {},
    removeMember: () => {},
  };

  const deps: ReviewRoundDeps = {
    store: new MarketStore(db),
    ledger: mockLedger(),
    orgMembers: orgMembersImpl,
    reviewerCount: 5,
    minReviewers: 3,
    eloLookup: (agentId: string) => {
      const repo = new CoreRepository(db);
      const a = repo.getAgent(agentId);
      if (!a) return undefined;
      return { eloGlobal: a.eloGlobal, eloByDomain: a.eloByDomain };
    },
  };

  const task = {
    ...baseTask(),
    taskId: "task-1",
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    status: "reviewing",
    winnerId: executorId,
    isCalibration: false,
  };

  const selected = selectReviewers(deps, task, executorId, pool);
  // 应排除 executor-1、reviewer-2、reviewer-3，剩余 7 人中 elo 降序取前 5
  // pool = [reviewer-1...reviewer-10]，elo 域分 1510...1600 递增
  // 排除后剩余 reviewer-4(1540) 到 reviewer-10(1600)
  // 降序：reviewer-10(1600), reviewer-9(1590), reviewer-8(1580), reviewer-7(1570), reviewer-6(1560)
  assert.deepEqual(selected, ["reviewer-10", "reviewer-9", "reviewer-8", "reviewer-7", "reviewer-6"]);
  assert.equal(selected.length, 5);

  db.close();
});

// ============================================================================
// Test 2: 评审者 bid 冻结：stake_r×(O_r−1)=10×1=10/人（对称托管）
// ============================================================================
test("评审者 bid 冻结：stake_r×(O_r−1)=10×1=10/人（对称托管）", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 1000 });
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: { llm: 1, time: 1, compute: 1 } } });
  const repo = new CoreRepository(db);
  const pool = ["reviewer-a", "reviewer-b", "reviewer-c", "reviewer-d", "reviewer-e"];
  for (const id of pool) {
    repo.insertAgent(agentRecord(id, { accepts: ["code"], eloGlobal: 1500 }));
    ledger.ensureEndowed(id, { id, provider: "p", name: id, accessRoute: "free" });
    ledger.credit(id, 100, "endow");
  }

  const task = { ...baseTask(), taskId: "task-freeze", stakeR: 10, oddsR: 2, reviewerCount: 5 };
  const selected = pool; // 假设全部被选中

  // 执行冻结
  for (const reviewerId of selected) {
    const ok = freezeBid(ledger, reviewerId, task.taskId, task.stakeR, task.oddsR);
    // freezeBid 成功时不抛错，返回 void；我们检查冻结是否生效
    assert.ok(true, `${reviewerId} 冻结不应抛错`);
  }

  // 验证每人冻结 10 = 10 * (2 - 1)
  for (const reviewerId of selected) {
    const row = db.prepare(`SELECT frozen FROM credits WHERE agent = ?`).get(reviewerId) as { frozen: number } | undefined;
    assert.ok(row, `${reviewerId} 应有 credits 行`);
    assert.equal(row!.frozen, 10, `${reviewerId} 冻结应为 10`);
  }

  db.close();
});

// ============================================================================
// Test 3: 流标：激活 2 < 3 → shortfall + 重试计数 + 已接单 2 人退还 stake_r + 凭证成本补偿
// ============================================================================
test("流标：激活 2 < 3 → shortfall + 重试计数 + 已接单 2 人退还 stake_r + 凭证成本补偿", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 1000 });
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: { llm: 1, time: 1, compute: 1 } } });
  const repo = new CoreRepository(db);
  const events = new EconomyEventBus();

  // 设置 5 个评审者
  const reviewers = ["r1", "r2", "r3", "r4", "r5"];
  for (const id of reviewers) {
    repo.insertAgent(agentRecord(id, { accepts: ["code"], eloGlobal: 1500 }));
    ledger.ensureEndowed(id, { id, provider: "p", name: id, accessRoute: "free" });
    ledger.credit(id, 100, "endow");
  }
  ledger.ensureEndowed("pub-1", { id: "pub-1", provider: "p", name: "pub-1", accessRoute: "free" });
  ledger.credit("pub-1", 1000, "endow");
  ledger.ensureEndowed("executor-1", { id: "executor-1", provider: "p", name: "executor-1", accessRoute: "free" });
  ledger.credit("executor-1", 100, "endow");

  const effectsDeps = makeEffectsDeps(db, ledger, voucher);
  const effectsRegistry = makeEffectRegistry();
  registerMarketEffectFns(effectsRegistry, effectsDeps);

  const task = {
    ...baseTask(),
    taskId: "task-failed",
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    status: "reviewing",
    winnerId: "executor-1",
    winnerStake: 15,
    isCalibration: false,
  };
  effectsDeps.store.createTask(task);

  // 冻结 5 个评审者 bid
  for (const r of reviewers) {
    freezeBid(ledger, r, task.taskId, task.stakeR, task.oddsR);
  }

  // 模拟：只有 r1、r2 接单并提交评审（activated = 2 < minReviewers=3）
  const activatedReviews = [
    { reviewerId: "r1", score: 0.7 },
    { reviewerId: "r2", score: 0.8 },
  ];

  // 调用 review_refund effect（流标少数评审者保护）
  const reviewRefundFn = effectsRegistry.resolve("market.review_refund");
  assert.ok(reviewRefundFn, "market.review_refund effect 应已注册");

  // 执行 refund（第 1 轮）
  const result1 = reviewRefundFn(
    {
      taskId: task.taskId,
      round: 1,
      activatedReviews,
      stakeR: task.stakeR,
      oddsR: task.oddsR,
      voucherAllowance: task.voucherAllowance,
    },
    makeCtx({})
  );

  // 验证：r1、r2 冻结释放 + stake_r 退还 + 凭证成本补偿（capped voucherAllowance）
  assert.equal(result1.ok, true);
  assert.equal(result1.skipped, false);
  assert.deepEqual(result1.refundedReviewers.sort(), ["r1", "r2"]);
  assert.equal(result1.operatorFallback, false);

  // 验证 r1、r2 冻结已释放
  for (const r of ["r1", "r2"]) {
    const row = db.prepare(`SELECT frozen FROM credits WHERE agent = ?`).get(r) as { frozen: number } | undefined;
    assert.equal(row?.frozen ?? 0, 0, `${r} 冻结应已释放`);
  }

  // 验证 r1、r2 余额：
  // 初始 endowment 1000 + credit 100 = 1100
  // 冻结 10 -> balance 1090, frozen 10
  // 释放冻结 -> balance 1100, frozen 0
  // 退还 stakeR 10 -> balance 1110
  // 补偿 voucherAllowance/3 = 2 -> balance 1112
  for (const r of ["r1", "r2"]) {
    const balance = ledger.balance(r);
    assert.equal(balance, 1112, `${r} 余额应为 1112`);
  }

  db.close();
});

// ============================================================================
// Test 4: 重试 2 次仍流标 → operator 兜底标记（R=operator 评价，单评审）
// ============================================================================
test("重试 2 次仍流标 → operator 兜底标记（R=operator 评价，单评审）", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 1000 });
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: { llm: 1, time: 1, compute: 1 } } });
  const repo = new CoreRepository(db);
  const events = new EconomyEventBus();

  const reviewers = ["r1", "r2", "r3", "r4", "r5"];
  for (const id of reviewers) {
    repo.insertAgent(agentRecord(id, { accepts: ["code"], eloGlobal: 1500 }));
    ledger.ensureEndowed(id, { id, provider: "p", name: id, accessRoute: "free" });
    ledger.credit(id, 100, "endow");
  }
  ledger.ensureEndowed("pub-1", { id: "pub-1", provider: "p", name: "pub-1", accessRoute: "free" });
  ledger.credit("pub-1", 1000, "endow");

  const effectsDeps = makeEffectsDeps(db, ledger, voucher);
  const effectsRegistry = makeEffectRegistry();
  registerMarketEffectFns(effectsRegistry, effectsDeps);

  const task = {
    ...baseTask(),
    taskId: "task-operator-fallback",
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    status: "reviewing",
    winnerId: "executor-1",
    winnerStake: 15,
    isCalibration: false,
  };
  effectsDeps.store.createTask(task);

  const reviewRefundFn = effectsRegistry.resolve("market.review_refund");
  assert.ok(reviewRefundFn);

  // 第 1 轮：仅 1 人激活
  const r1 = reviewRefundFn(
    { taskId: task.taskId, round: 1, activatedReviews: [{ reviewerId: "r1", score: 0.7 }], stakeR: 10, oddsR: 2, voucherAllowance: 6 },
    makeCtx({})
  );
  assert.equal(r1.operatorFallback, false);
  assert.deepEqual(r1.refundedReviewers, ["r1"]);

  // 第 2 轮：仍仅 1 人激活
  const r2 = reviewRefundFn(
    { taskId: task.taskId, round: 2, activatedReviews: [{ reviewerId: "r1", score: 0.7 }], stakeR: 10, oddsR: 2, voucherAllowance: 6 },
    makeCtx({})
  );
  assert.equal(r2.operatorFallback, false);
  assert.deepEqual(r2.refundedReviewers, ["r1"]);

  // 第 3 轮：仍流标 → 应标记 operator 兜底（R=operator，单评审）
  const r3 = reviewRefundFn(
    { taskId: task.taskId, round: 3, activatedReviews: [{ reviewerId: "r1", score: 0.7 }], stakeR: 10, oddsR: 2, voucherAllowance: 6 },
    makeCtx({})
  );
  assert.equal(r3.operatorFallback, true);
  assert.equal(r3.refundedReviewers.length, 0); // 第 3 轮不退款，标记 operator 兜底

  db.close();
});

// ============================================================================
// Test 5: review_refund 幂等（同 taskId+round 重试 skip）
// ============================================================================
test("review_refund 幂等（同 taskId+round 重试 skip）", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 1000 });
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: { llm: 1, time: 1, compute: 1 } } });
  const repo = new CoreRepository(db);
  const events = new EconomyEventBus();

  const reviewers = ["r1", "r2"];
  for (const id of reviewers) {
    repo.insertAgent(agentRecord(id, { accepts: ["code"], eloGlobal: 1500 }));
    ledger.ensureEndowed(id, { id, provider: "p", name: id, accessRoute: "free" });
    ledger.credit(id, 100, "endow");
  }
  ledger.ensureEndowed("pub-1", { id: "pub-1", provider: "p", name: "pub-1", accessRoute: "free" });
  ledger.credit("pub-1", 1000, "endow");

  const effectsDeps = makeEffectsDeps(db, ledger, voucher);
  const effectsRegistry = makeEffectRegistry();
  registerMarketEffectFns(effectsRegistry, effectsDeps);

  const task = {
    ...baseTask(),
    taskId: "task-idempotent",
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    status: "reviewing",
    winnerId: "executor-1",
    winnerStake: 15,
    isCalibration: false,
  };
  effectsDeps.store.createTask(task);

  for (const r of reviewers) {
    freezeBid(ledger, r, task.taskId, task.stakeR, task.oddsR);
  }

  const reviewRefundFn = effectsRegistry.resolve("market.review_refund");
  assert.ok(reviewRefundFn);

  // 同 taskId+round 连续调用两次
  const r1 = reviewRefundFn(
    { taskId: task.taskId, round: 1, activatedReviews: [{ reviewerId: "r1", score: 0.7 }], stakeR: 10, oddsR: 2, voucherAllowance: 6 },
    makeCtx({})
  );
  const r2 = reviewRefundFn(
    { taskId: task.taskId, round: 1, activatedReviews: [{ reviewerId: "r1", score: 0.7 }], stakeR: 10, oddsR: 2, voucherAllowance: 6 },
    makeCtx({})
  );

  // 第二次应 skip（幂等）
  assert.equal(r1.ok, true);
  assert.equal(r1.skipped, false);
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true); // 幂等跳过
  assert.deepEqual(r2.refundedReviewers, []); // 跳过时不重复退款

  // 验证 r1 只被退款一次：余额应为 1112（仅退款一次）
  // 如果重复退款会是 1124
  assert.equal(ledger.balance("r1"), 1112, "r1 余额应为 1112（仅退款一次）");

  db.close();
});

// ============================================================================
// Test 6: 评审者负 settle 流向（与 Task 3 plan 对接）：入池非 publisher
// ============================================================================
test("评审者负 settle 流向：入池非 publisher", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, { initialCredits: () => 1000 });
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: { llm: 1, time: 1, compute: 1 } } });
  const repo = new CoreRepository(db);
  const events = new EconomyEventBus();

  // 设置：publisher、executor、reviewer（负 settle）
  ledger.ensureEndowed("pub-1", { id: "pub-1", provider: "p", name: "pub-1", accessRoute: "free" });
  ledger.credit("pub-1", 1000, "endow");
  ledger.ensureEndowed("executor-1", { id: "executor-1", provider: "p", name: "executor-1", accessRoute: "free" });
  ledger.credit("executor-1", 100, "endow");
  ledger.ensureEndowed("reviewer-neg", { id: "reviewer-neg", provider: "p", name: "reviewer-neg", accessRoute: "free" });
  ledger.credit("reviewer-neg", 100, "endow");
  repo.insertAgent(agentRecord("reviewer-neg", { accepts: ["code"], eloGlobal: 1500 }));

  const effectsDeps = makeEffectsDeps(db, ledger, voucher);
  const effectsRegistry = makeEffectRegistry();
  registerMarketEffectFns(effectsRegistry, effectsDeps);

  const task = {
    ...baseTask(),
    taskId: "task-neg-reviewer",
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    status: "reviewing",
    winnerId: "executor-1",
    winnerStake: 15,
    isCalibration: false,
  };
  effectsDeps.store.createTask(task);

  // 冻结 reviewer
  freezeBid(ledger, "reviewer-neg", task.taskId, task.stakeR, task.oddsR);

  // apply_settlement 传入负 settle_i
  const applySettlementFn = effectsRegistry.resolve("market.apply_settlement");
  assert.ok(applySettlementFn);

  const plan = {
    R: 0.7,
    accuracies: new Map([["reviewer-neg", 0.3]]), // a=0.3 < 0.5 → 负 settle
    executorSettle: 12,
    executorEloDelta: { global: 10, domain: 10 },
    reviewerSettles: new Map([["reviewer-neg", -4]]), // 负结算
    reviewerEloDeltas: new Map([["reviewer-neg", { global: -5, domain: -5 }]]),
    taxTotal: 0.6,
    negativeFlow: { from: "reviewer-neg", to: "central-pool" as const, amount: 4 },
    majorError: false,
  };

  applySettlementFn(
    { taskId: task.taskId, winnerId: "executor-1", plan, taxRate: 0.05 },
    makeCtx({})
  );

  // 验证：reviewer-neg 的负结算流向 central-pool，而非 publisher
  // publisher 余额不应增加该笔负结算金额
  // central-pool 余额应增加 4（评审者负结算）+ 0.6（执行者税收）= 4.6
  const poolBalance = ledger.balance("central-pool");
  assert.equal(poolBalance, 4.6, "central-pool 应收到评审者负结算 4 + 执行者税收 0.6 = 4.6");

  // publisher 余额：初始 endowment 1000 + credit 1000 = 2000，执行者结算 gross=12 tax=0.6 net=11.4 扣除，评审者负结算不扣 publisher
  // publisher 余额 = 2000 - 12 (executor gross) = 1988
  const pubBalance = ledger.balance("pub-1");
  assert.equal(pubBalance, 1988, "publisher 余额应为 1988（仅扣除执行者 gross）");

  db.close();
});