// 校准任务测试（plan Task 6 / spec §7a.7——合成执行者 + ground truth 锚定）。
// 覆盖：announce 校准分支（真实 CalibrationPool 替换占位）、合成执行者短路（凭证燃烧=0）、
//   ground truth 评定对接 Task 3 planSettlement（c/a_i 按 ground truth）、stake_cal=0
//   escrow（无执行者 stake 项）、校准 settle 入池（operator 无利可图——池流水审计）、
//   isCalibration:true 事件全链路透传。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MarketStore } from "../src/economy/market-store.ts";
import {
  CalibrationPool,
  calibrationExecutorRun,
  CALIBRATION_EXECUTOR_ID,
  type CalibrationTask,
} from "../src/economy/calibration.ts";
import {
  registerMarketCodeFns,
  type MarketFnsDeps,
  type CodeRegistry,
} from "../src/economy/market-fns.ts";
import {
  registerMarketEffectFns,
} from "../src/economy/market-effects.ts";
import { SqliteTaskTypeRegistry, type TaskType } from "../src/economy/task-types.ts";
import {
  EloFormulaRegistry,
  SelectionFormulaRegistry,
  simpleElo,
  stakeEloPower,
  taskRatingFromOdds,
} from "../src/economy/elo.ts";
import { planSettlement, type SettlementPlan } from "../src/economy/settlement.ts";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteVoucher } from "../src/economy/voucher-port.ts";
import { EconomyEventBus } from "../src/economy/economy-events.ts";
import { ensureCentralPool, CENTRAL_POOL_ID } from "../src/economy/central-pool.ts";
import type { Ledger } from "../src/arena/types.ts";
import type { VoucherPort } from "../src/economy/voucher-port.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import type { ModelInfo } from "../src/types.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";

function closeTo(actual: number, expected: number, eps = 1e-9, msg?: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg ?? "value"} expected ${actual} ≈ ${expected} (±${eps})`);
}

// ── code fn 侧 helpers（同 market-fns.test.ts 模式）─────────────────
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

function baseTaskSpec(): Record<string, unknown> {
  return {
    typeId: "code",
    publisherId: "pub-1",
    maxStake: 15,
    odds: 3,
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 2,
    voucherAllowance: 6,
    brief: "fix the bug",
  };
}

function calTask(over: Partial<CalibrationTask> = {}): CalibrationTask {
  return {
    taskId: "cal-1",
    brief: "calibration brief",
    groundTruthArtifact: "gt-artifact-ref",
    groundTruthScore: 0.8,
    ...over,
  };
}

// ── effect 侧 helpers（同 market-effects.test.ts 模式）──────────────
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

function makeRegistry() {
  const fns = new Map<string, (args: Record<string, unknown>) => unknown>();
  const registry = {
    register(name: string, fn: (args: Record<string, unknown>) => unknown) { fns.set(name, fn); },
    call(name: string, args: Record<string, unknown>) { return fns.get(name)!({ ...args }); },
  };
  return registry;
}

/** 校准任务已 persist（escrow 冻结 = 评审项 + voucherAllowance，stake_cal=0）。 */
function setupCalTask(m: ReturnType<typeof mk>) {
  m.ledger.ensureEndowed("pub1", model("pub1"));
  const reg = makeRegistry();
  registerMarketEffectFns(reg, {
    store: m.mstore, ledger: m.ledger, voucher: m.voucher, events: m.events, taxRate: 0.05,
  });
  const r = reg.call("market.persist_task", {
    ...TASK_ARGS, taskId: "cal-1", isCalibration: true, groundTruth: "gt-artifact-ref",
  }) as { ok: boolean; skipped: boolean };
  assert.equal(r.skipped, false);
  return { reg, taskId: "cal-1" };
}

/** 校准结算 plan（groundTruthScore=0.9：r1 准 +10；r2 偏 −6；执行者 settle=0）。 */
function calSettlePlan(m: ReturnType<typeof mk>): SettlementPlan {
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  return planSettlement({
    task: m.mstore.getTask("cal-1")!,
    winnerId: CALIBRATION_EXECUTOR_ID,
    winnerStake: 0,
    reviews: [
      { reviewerId: "r1", score: 0.9 },
      { reviewerId: "r2", score: 0.1 },
    ],
    groundTruthScore: 0.9,
    eloFn: elo.get("simple-elo"),
    taxRate: 0.05,
    executorElo: { global: 1500, byDomain: {} },
    reviewerElos: new Map([
      ["r1", { global: 1500, byDomain: {} }],
      ["r2", { global: 1500, byDomain: {} }],
    ]),
    taskRating: taskRatingFromOdds(3),
  });
}

// ── 1. announce 校准分支（真实 CalibrationPool）─────────────────────
test("announce：rng 触发 → CalibrationPool.draw → 任务带 groundTruth + isCalibration", () => {
  const db = new DatabaseSync(":memory:");
  const pool = new CalibrationPool();
  pool.add(calTask());
  const deps = makeDeps(db, { rng: () => 0.05, calibration: pool });
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const fn = registry.resolve("market.announce")!;
  const result = fn({}, makeCtx({ taskSpec: baseTaskSpec() })) as { taskId: string; isCalibration: boolean };

  assert.equal(result.isCalibration, true);
  assert.equal(result.taskId, "cal-1");

  const task = deps.store.getTask(result.taskId);
  assert.ok(task);
  assert.equal(task!.status, "open");
  assert.equal(task!.isCalibration, true);
  assert.equal(task!.groundTruth, "gt-artifact-ref"); // CalibrationTask.groundTruthArtifact → MarketTask.groundTruth
  assert.equal(task!.brief, "calibration brief");

  db.close();
});

// ── 2. 合成执行者：短路产出预制交付物（凭证燃烧=0）──────────────────
test("calibrationExecutorRun：短路产出预制交付物（凭证燃烧=0——burnHistory 空）", () => {
  const pool = new CalibrationPool();
  pool.add(calTask());
  const task = pool.draw(() => 0)!;
  assert.ok(task);

  const voucher = mockVoucher();
  assert.deepEqual(voucher.burnHistory(), []);

  // 合成执行者运行：无 LLM/不耗凭证——burnHistory 保持为空。
  const out = calibrationExecutorRun(task);
  assert.equal(out.output, "gt-artifact-ref");
  assert.deepEqual(voucher.burnHistory(), []);
});

// ── 3. ground truth 评定对接 Task 3 planSettlement ─────────────────
test("ground truth 评定：CalibrationTask.groundTruthScore → market.settle c/a_i 按 ground truth（非 R）", () => {
  const db = new DatabaseSync(":memory:");
  const pool = new CalibrationPool();
  pool.add(calTask({ groundTruthScore: 0.8 }));
  const deps = makeDeps(db, { rng: () => 0.05, calibration: pool });
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  registry.resolve("market.announce")!({}, makeCtx({ taskSpec: baseTaskSpec() }));
  const drawn = pool.draw(() => 0)!;
  assert.equal(drawn.groundTruthScore, 0.8);

  const fn = registry.resolve("market.settle")!;
  const plan = fn(
    {},
    makeCtx({
      taskId: "cal-1",
      winnerId: CALIBRATION_EXECUTOR_ID,
      winnerStake: 0,
      reviews: [
        { reviewerId: "r1", score: 0.7 },
        { reviewerId: "r2", score: 0.9 },
        { reviewerId: "r3", score: 1.0 },
      ],
      groundTruthScore: drawn.groundTruthScore,
      executorElo: { global: 1500, byDomain: { code: 1500 } },
    })
  ) as SettlementPlan;

  // R=中位数=0.9；c=groundTruthScore=0.8（非 R）——a_i 按 ground truth 偏差。
  assert.equal(plan.R, 0.9);
  closeTo(plan.accuracies.get("r1")!, 0.9); // 1−|0.7−0.8|
  closeTo(plan.accuracies.get("r2")!, 0.9); // 1−|0.9−0.8|
  closeTo(plan.accuracies.get("r3")!, 0.8); // 1−|1.0−0.8|
  // 执行者 settle = stake_cal×(O−1)×(2c−1) = 0（stake_cal=0）
  closeTo(plan.executorSettle, 0);
  // 评审者 settle_i = stakeR×(O_r−1)×(2a_i−1) = 10×(2a−1)
  closeTo(plan.reviewerSettles.get("r1")!, 8);
  closeTo(plan.reviewerSettles.get("r2")!, 8);
  closeTo(plan.reviewerSettles.get("r3")!, 6);

  db.close();
});

// ── 4. stake_cal=0：escrow 公式无执行者 stake 项 ────────────────────
test("stake_cal=0：校准任务 escrow 冻结 = 评审项 + voucherAllowance（无执行者 stake 项）", () => {
  const m = mk();
  m.ledger.ensureEndowed("pub1", model("pub1"));
  const reg = makeRegistry();
  registerMarketEffectFns(reg, {
    store: m.mstore, ledger: m.ledger, voucher: m.voucher, events: m.events, taxRate: 0.05,
  });
  reg.call("market.persist_task", {
    ...TASK_ARGS, taskId: "cal-1", isCalibration: true, groundTruth: "gt-artifact-ref",
  });

  // 常规 escrowMax = 20×2 + 5×10×1 + 6 = 96；校准（stake_cal=0）省略执行者项 → 56。
  assert.equal(m.ledger.balance("pub1"), 1000 - 56);
  assert.equal(frozenOf(m.ledger, "pub1"), 56);
  const evt = m.events.drain().find((e) => e.kind === "economy.escrow_freeze");
  assert.equal((evt!.data as { amount: number }).amount, 56);
});

// ── 5. 校准 settle 入池（operator 无利可图——池流水审计可见）────────
test("校准 settle 入池：operator 无利可图——池流水审计可见", () => {
  const m = mk();
  const { reg, taskId } = setupCalTask(m);
  // 评审者对称托管冻结（stake_r×(O_r−1)=10/人）
  m.ledger.ensureEndowed("r1", model("r1"));
  m.ledger.ensureEndowed("r2", model("r2"));
  m.ledger.freeze("r1", 10, taskId);
  m.ledger.freeze("r2", 10, taskId);
  // adjust：合成执行者中标（stake_cal=0 → escrow 保持 56）
  reg.call("market.adjust_escrow", {
    taskId, winnerId: CALIBRATION_EXECUTOR_ID, winnerStake: 0, bids: [],
  });
  const plan = calSettlePlan(m);
  closeTo(plan.executorSettle, 0);
  closeTo(plan.reviewerSettles.get("r1")!, 10);
  closeTo(plan.reviewerSettles.get("r2")!, -6);

  reg.call("market.apply_settlement", { taskId, plan, winnerId: CALIBRATION_EXECUTOR_ID });

  // 池余额 = 税(10×0.05=0.5) + r2 负 settle 入池(6) = 6.5——池流水审计可见。
  closeTo(m.ledger.balance(CENTRAL_POOL_ID), 6.5);
  const poolHist = m.ledger.history(CENTRAL_POOL_ID);
  assert.ok(poolHist.some((t) => t.reason.startsWith("tax")), "税入池流水可见");
  assert.ok(poolHist.some((t) => t.reason.startsWith("reviewer-negative")), "评审负 settle 入池流水可见");

  // operator（calibration-executor）无利可图：无收入、余额 0。
  assert.equal(m.ledger.balance(CALIBRATION_EXECUTOR_ID), 0);
  assert.equal(m.ledger.history(CALIBRATION_EXECUTOR_ID).length, 0);

  // publisher：escrow 56 全额解冻回账 + 支付 r1 gross 10 → 990（其余留在 publisher）。
  assert.equal(m.ledger.balance("pub1"), 1000 - 56 + 56 - 10);
  assert.equal(frozenOf(m.ledger, "pub1"), 0);
  // 评审者：r1 冻结返还 + 净 9.5；r2 冻结返还 − 6 入池。
  closeTo(m.ledger.balance("r1"), 1000 - 10 + 10 + 9.5);
  closeTo(m.ledger.balance("r2"), 1000 - 10 + 10 - 6);
  const task = m.mstore.getTask(taskId);
  assert.equal(task!.status, "settled");
});

// ── 6. 事件 isCalibration:true 全链路透传 ───────────────────────────
test("事件 isCalibration:true 全链路透传（persist→adjust→settle）", () => {
  const m = mk();
  const { reg, taskId } = setupCalTask(m);
  m.ledger.ensureEndowed("r1", model("r1"));
  m.ledger.ensureEndowed("r2", model("r2"));
  m.ledger.freeze("r1", 10, taskId);
  m.ledger.freeze("r2", 10, taskId);
  reg.call("market.adjust_escrow", {
    taskId, winnerId: CALIBRATION_EXECUTOR_ID, winnerStake: 0, bids: [],
  });
  reg.call("market.apply_settlement", {
    taskId, plan: calSettlePlan(m), winnerId: CALIBRATION_EXECUTOR_ID,
  });

  const events = m.events.drain();
  assert.ok(events.length >= 4, `至少 escrow_freeze/escrow_adjust/settle/tax 事件（实际 ${events.length}）`);
  for (const e of events) {
    assert.equal(e.isCalibration, true, `事件 ${e.kind} 应带 isCalibration:true`);
  }
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("economy.escrow_freeze"));
  assert.ok(kinds.includes("economy.escrow_adjust"));
  assert.ok(kinds.includes("economy.settle"));
  assert.ok(kinds.includes("currency.tax"));
});
