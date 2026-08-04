// D2 Task 11：市场 runner + 端到端集成 bench（spec §5.1 全图 + §12 端到端）。
// 7 测试（plan Task 11 Step 1 逐字）：
//   1. 完整市场闭环（发布/5 竞价/选择/调减/执行/5 评审/共识/结算 + 税/elo/事件/经验/投影对账）
//   2. 生存性冒烟（100 credit 起步 → 结算正收益 → 余额 > 100）
//   3. 多轮市场 elo 分化（高完成度 agent elo 上升 → 后续优先入围）
//   4. 负 settle 轮（majorError → −stake 直付 publisher + elo 下降）
//   5. 流标轮（激活 2/5 → 重试 → operator 兜底 + 未接单评审者冻结回收）
//   6. 校准轮（calibrationRate=1.0 → ground truth 评定 + isCalibration 事件）
//   7. resume（市场流程中途重启 → checkpoint 恢复——fanout 快照/effect 幂等）
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteVoucher } from "../src/economy/voucher-port.ts";
import { MarketStore } from "../src/economy/market-store.ts";
import { EconomyEventBus } from "../src/economy/economy-events.ts";
import { SqliteOrgMembership } from "../src/economy/org.ts";
import { SqliteTaskTypeRegistry } from "../src/economy/task-types.ts";
import {
  EloFormulaRegistry,
  SelectionFormulaRegistry,
  simpleElo,
  stakeEloPower,
} from "../src/economy/elo.ts";
import { CalibrationPool } from "../src/economy/calibration.ts";
import { ensureCentralPool, CENTRAL_POOL_ID } from "../src/economy/central-pool.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { MarketRunner, type MarketRunnerDeps } from "../src/economy/market-runner.ts";
import { emitBurn } from "../src/economy/market-effects.ts";
import { projectEconomy } from "../src/economy/projections.ts";

// ── helpers ──────────────────────────────────────────────────────
const RATES = { llm: 2, time: 1, compute: 1 };
const fixedEndow = { initialCredits: () => 1000 };
function model(id: string) {
  return { id, provider: "test", name: id, accessRoute: "free" as const };
}

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

interface Env {
  db: DatabaseSync;
  ledger: SqliteLedger;
  voucher: SqliteVoucher;
  store: MarketStore;
  events: EconomyEventBus;
  repo: CoreRepository;
  org: SqliteOrgMembership;
  taskTypes: SqliteTaskTypeRegistry;
  elo: EloFormulaRegistry;
  selection: SelectionFormulaRegistry;
  cal: CalibrationPool;
}

function mkEnv(): Env {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, fixedEndow);
  ensureCentralPool(ledger);
  const store = new MarketStore(db);
  const events = new EconomyEventBus(db);
  // Task 3 接线：eventBus 注入 SqliteVoucher——buy 在事务内发射 currency.buy_voucher，
  // 投影对账基源不依赖测试手工补发（跨层挂空闭合）。
  const voucher = new SqliteVoucher({ db, ledger, rates: { creditPerUnit: RATES }, poolId: CENTRAL_POOL_ID, eventBus: events });
  const repo = new CoreRepository(db);
  const org = new SqliteOrgMembership(db);
  const taskTypes = new SqliteTaskTypeRegistry(db);
  taskTypes.register({ id: "code", description: "coding task", registeredBy: "test", createdAt: 1 });
  const elo = new EloFormulaRegistry();
  elo.register(simpleElo);
  const selection = new SelectionFormulaRegistry();
  selection.register(stakeEloPower);
  const cal = new CalibrationPool();
  return { db, ledger, store, events, voucher, repo, org, taskTypes, elo, selection, cal };
}

function addAgent(h: Env, id: string, opts: { eloGlobal?: number; accepts?: string[]; balance?: number } = {}): void {
  const { eloGlobal = 1500, accepts = ["code"], balance = 0 } = opts;
  h.repo.insertAgent(agentRecord(id, { accepts, eloGlobal }));
  h.ledger.credit(id, balance, "endow");
}

function makeDeps(h: Env, over: Partial<MarketRunnerDeps> = {}): MarketRunnerDeps {
  const codes = new Map<string, unknown>();
  const effects = new Map<string, unknown>();
  return {
    store: h.store,
    ledger: h.ledger,
    voucher: h.voucher,
    events: h.events,
    elo: h.elo,
    selection: h.selection,
    taskTypes: h.taskTypes,
    calibrationRate: 0,
    rng: () => 0.99,
    calibration: h.cal,
    orgMembers: h.org,
    codes: { register: (n: string, fn: unknown) => void codes.set(n, fn) },
    effects: { register: (n: string, fn: unknown) => void effects.set(n, fn) },
    repository: h.repo,
    taxRate: 0.05,
    ...over,
  };
}

function assertClose(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? "浮点值"}: ${actual} ≈ ${expected}`);
}

function frozenOf(ledger: SqliteLedger, agent: string): number {
  const row = (ledger as unknown as { db: { prepare: (sql: string) => { get: (...a: string[]) => { frozen: number } | undefined } } }).db
    .prepare(`SELECT frozen FROM credits WHERE agent = ?`).get(agent);
  return row?.frozen ?? 0;
}

function drainByKind(h: Env, kind: string): Array<{ kind: string; data: Record<string, unknown>; isCalibration?: boolean }> {
  return h.events.drain().filter((e) => e.kind === kind);
}

// ── 1. 完整市场闭环 ──────────────────────────────────────────────
// 数值钉死：maxStake=20 O=3 N=5 stakeR=10 O_r=2 voucher=6 → escrowMax=96；stake=15 → actual=86。
// 评审全 0.9 → c=0.9；executor settle=24 gross（net 22.8，tax 1.2）；评审者 settle=10 gross（net 9.5，tax 0.5）。
test("1. 完整市场闭环：发布→5 竞价→选择→调减→执行→5 评审→共识→结算（税/elo/事件/经验/投影对账）", async () => {
  const h = mkEnv();
  for (const id of ["a1", "a2", "a3", "a4", "a5", "a6"]) addAgent(h, id, { balance: 150 });
  addAgent(h, "pub1", { balance: 100, accepts: [] });
  const written: Array<{ idempotencyKey: string; content: string }> = [];
  const runner = new MarketRunner(
    makeDeps(h, {
      candidates: () => ["a1", "a2", "a3", "a4", "a5", "a6"],
      spawnBidder: async (agentId) => ({ stake: { a1: 15, a2: 12, a3: 10, a4: 8, a5: 5, a6: 0 }[agentId] ?? 0 }),
      spawnReviewer: async () => ({ score: 0.9 }),
      burnUnits: { execute: 2 },
      experienceSink: {
        write: (e) => {
          written.push({ idempotencyKey: e.idempotencyKey, content: e.content ?? "" });
          return { ok: true, entry: e as never };
        },
      },
    })
  );
  // a1 预购凭证（llm 3 units @2 = 6 credit）——执行阶段燃烧 2 units → FIFO creditCost 4。
  // Task 3 闭合：buy 自身在事务内发射 currency.buy_voucher（投影基源真实事件）。
  h.voucher.buy("a1", "llm", 3);

  const res = await runner.runMarket({ typeId: "code", publisherId: "pub1", maxStake: 20, odds: 3, brief: "write tests" });
  assert.equal(res.status, "settled");
  const taskId = res.taskId;

  // ── 任务状态 ──
  const task = h.store.getTask(taskId)!;
  assert.equal(task.status, "settled");
  assert.equal(task.winnerId, "a1");
  assert.equal(task.winnerStake, 15);
  assert.ok(task.settledAt);

  // ── 资金（发布方 escrow 96 → 支付 gross 74 → 余 26；winner net 22.8；评审 net 9.5×5）──
  assert.equal(h.ledger.balance("pub1"), 26, "publisher 余额");
  assert.equal(h.ledger.balance("a1"), 166.8, "winner 余额（settle 税后）");
  for (const id of ["a2", "a3", "a4", "a5", "a6"]) {
    assert.equal(h.ledger.balance(id), 159.5, `${id} 评审者余额`);
  }
  assert.equal(h.ledger.balance(CENTRAL_POOL_ID), 9.7, "池余额（税 3.7 + 凭证销售 6）");

  // ── elo 更新（odds=3 → taskRating=1900 → expected = 1/(1+10^1) = 1/11）──
  const eloA1 = h.repo.getAgent("a1")!.eloGlobal!;
  const eloReviewer = h.repo.getAgent("a2")!.eloGlobal!;
  assert.ok(Math.abs(eloA1 - (1500 + 32 * (0.9 - 1 / 11))) < 0.01, `a1 elo ${eloA1}`);
  assert.ok(Math.abs(eloReviewer - (1500 + 32 * (1 - 1 / 11))) < 0.01, `评审 elo ${eloReviewer}`);

  // ── 事件全量 ──
  const evs = h.events.drain();
  const kinds = evs.map((e) => e.kind) as string[];
  for (const k of ["economy.escrow_freeze", "economy.escrow_adjust", "economy.bid_freeze", "economy.bid_release",
    "currency.buy_voucher", "currency.burn", "currency.tax", "economy.settle", "economy.elo_update",
    "economy.review_consensus"]) {
    assert.ok(kinds.includes(k), `缺事件 ${k}`);
  }
  assert.equal(evs.filter((e) => e.kind === "economy.bid_freeze").length, 5);
  assert.equal(evs.filter((e) => e.kind === "economy.bid_release").length, 4);
  const freeze = evs.find((e) => e.kind === "economy.escrow_freeze")!;
  assert.equal(freeze.data.amount, 96);
  const adjust = evs.find((e) => e.kind === "economy.escrow_adjust")!;
  assert.equal(adjust.data.from, 96);
  assert.equal(adjust.data.to, 86);
  const burn = evs.find((e) => e.kind === "currency.burn")!;
  assert.equal(burn.data.units, 2);
  assert.equal(burn.data.creditCost, 4, "Task 8 审查遗留：burn 事件带 creditCost");
  const executorSettle = evs.find((e) => e.kind === "economy.settle" && e.data.role === "executor")!;
  assertClose(executorSettle.data.settle as number, 22.8);
  assert.equal(executorSettle.data.gross, 24);
  assertClose(executorSettle.data.tax as number, 1.2);
  const reviewerSettles = evs.filter((e) => e.kind === "economy.settle" && e.data.role === "reviewer");
  assert.equal(reviewerSettles.length, 5);
  for (const s of reviewerSettles) assertClose(s.data.settle as number, 9.5);
  const taxTotal = evs.filter((e) => e.kind === "currency.tax").reduce((s, e) => s + (e.data.amount as number), 0);
  assertClose(taxTotal, 3.7);
  const consensusEv = evs.find((e) => e.kind === "economy.review_consensus")!;
  assert.equal(consensusEv.data.R, 0.9);
  assert.equal((consensusEv.data.reviews as unknown[]).length, 5);
  assert.equal(evs.filter((e) => e.kind === "economy.elo_update").length, 6);

  // ── 经验沉淀（execution/bidding/review——settle 侧三类）──
  assert.equal(written.length, 11, "1 execution + 5 bidding + 5 review");
  // Task 1 适配：content 已改行式管道格式（`${kind}|${scene}|${agentId}|${action}|${outcome}|${reward}|${evaluationMode ?? "-"}`）
  // —— 原 JSON.parse 断言随旧格式失效（brief 未列本消费点；为保全绿最小适配，kind=字段0/action=字段3/outcome=字段4）
  const exps = written.map((w) => {
    const f = w.content.split("|");
    return { kind: f[0]!, action: f[3]!, outcome: f[4]! };
  });
  assert.equal(exps.filter((x) => x.kind === "execution").length, 1);
  assert.equal(exps.filter((x) => x.kind === "bidding").length, 5);
  assert.equal(exps.filter((x) => x.kind === "review").length, 5);
  const bidding = exps.find((x) => x.kind === "bidding" && x.outcome === "won")!;
  assert.equal(bidding.action, "bid:15");

  // ── 投影与真实账本交叉核对（Task 11 必修）──
  const report = projectEconomy(h.events.replayAll());
  assert.equal(report.poolBalance, h.ledger.balance(CENTRAL_POOL_ID), "投影池余额 == 真实账本池余额");
  assert.equal(report.burned, 4, "投影 burned == burn creditCost");
  assert.equal(report.minted, 0);
  assert.equal(report.voucherStock.llm, 1, "买 3 燃 2 → 存量 1");
  assert.equal(report.physicalCreditReconciliation[0].creditValue, 2, "存量 1 unit @2 = credit 2");
  assert.ok(report.eloDistribution.buckets.some((b) => b.range === "[1300,1700)" && b.count === 6), "elo 分布重建（投影 == 事件 Σdelta）");
  assert.equal(report.reviewerAccuracy.length, 5);
  for (const r of report.reviewerAccuracy) assert.equal(r.avgAccuracy, 1);
  assert.deepEqual(report.calibrationBias, []);
});

// ── 2. 生存性冒烟 ────────────────────────────────────────────────
test("2. 生存性冒烟：100 credit 起步 → bid 30 冻结 → 中标 → 结算正收益 → 余额 > 100", async () => {
  const h = mkEnv();
  addAgent(h, "s1", { balance: 100 });
  for (const r of ["r1", "r2", "r3", "r4"]) addAgent(h, r, { balance: 200 });
  addAgent(h, "pub2", { balance: 1000, accepts: [] });
  const runner = new MarketRunner(
    makeDeps(h, {
      candidates: () => ["s1", "r1", "r2", "r3", "r4"],
      spawnBidder: async (id) => ({ stake: id === "s1" ? 30 : 0 }),
      spawnReviewer: async () => ({ score: 1 }),
    })
  );

  const res = await runner.runMarket({ typeId: "code", publisherId: "pub2", maxStake: 40, odds: 3, brief: "survive" });
  assert.equal(res.status, "settled");

  const bal = h.ledger.balance("s1");
  assert.equal(bal, 157, "100 − 60(冻结) + 60(解冻) + 57(settle 税后) = 157");
  assert.ok(bal > 100, "生存闭环：结算后余额 > 起步 100");
  assert.equal(h.ledger.balance("pub2"), 900);
  assert.equal(frozenOf(h.ledger, "s1"), 0, "无残留冻结");
});

// ── 3. 多轮市场：elo 分化（市场学习信号）──────────────────────────
// odds=2 → taskRating=1700 → expected = 1/(1+10^0.5) = 0.2402530733520421。
// a1（完成度 0.95）每轮 +22.71；a5（噪声评审 a=0.15 < expected）每轮 −2.89。
test("3. 多轮市场：3 任务 → 高完成度 agent elo 上升并持续中标，低准确评审 elo 下降", async () => {
  const h = mkEnv();
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) addAgent(h, id, { balance: 300 });
  addAgent(h, "pub3", { balance: 2000, accepts: [] });
  const runner = new MarketRunner(
    makeDeps(h, {
      candidates: () => ["a1", "a2", "a3", "a4", "a5"],
      spawnBidder: async () => ({ stake: 8 }),
      spawnReviewer: async (reviewerId, deliverable) => {
        if (reviewerId === "a5") return { score: 0.1 }; // 噪声评审
        const m = /winner:([a-zA-Z0-9-]+)/.exec(deliverable ?? "");
        return { score: m?.[1] === "a1" ? 1 : 0.5 }; // 高完成度 1.0（与评审准确性同分 → 同分裁决 a1 胜）
      },
    })
  );

  const taskIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await runner.runMarket({ typeId: "code", publisherId: "pub3", maxStake: 20, odds: 2, brief: `round-${i}` });
    assert.equal(r.status, "settled");
    taskIds.push(r.taskId);
  }

  // 同分裁决 → a1 首轮胜；elo 上升后持续优先入围（每轮中标）
  for (const tid of taskIds) {
    const t = h.store.getTask(tid)!;
    assert.equal(t.winnerId, "a1", `任务 ${tid} 由 a1 中标（elo 领先）`);
  }
  const eloA1 = h.repo.getAgent("a1")!.eloGlobal!;
  const eloA5 = h.repo.getAgent("a5")!.eloGlobal!;
  assert.ok(eloA1 > 1560, `a1 elo 应显著上升（${eloA1}）`);
  assert.ok(eloA5 < 1495, `a5 elo 应下降（噪声评审 ${eloA5}）`);
  assert.ok(eloA1 > eloA5, "elo 分化");
});

// ── 4. 负 settle 轮 ──────────────────────────────────────────────
test("4. 负 settle 轮：majorError → −stake 直付 publisher + elo 下降", async () => {
  const h = mkEnv();
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) addAgent(h, id, { balance: 200 });
  addAgent(h, "pub4", { balance: 200, accepts: [] });
  const runner = new MarketRunner(
    makeDeps(h, {
      candidates: () => ["a1", "a2", "a3", "a4", "a5"],
      spawnBidder: async (id) => ({ stake: id === "a1" ? 15 : 8 }),
      spawnReviewer: async () => ({ score: 0.8 }),
      spawnExecutor: async () => ({ output: "broken", majorError: true }),
    })
  );

  const res = await runner.runMarket({ typeId: "code", publisherId: "pub4", maxStake: 20, odds: 3, brief: "risky" });
  assert.equal(res.status, "settled");

  // a1: 200 − 30(冻结) + 30(解冻) − 15(负 settle 直付) = 185
  assert.equal(h.ledger.balance("a1"), 185);
  // pub4: 200 − 96 + 10(调减) + 86(解冻) + 15(负流) − 40(评审 gross 4×10) = 175
  assert.equal(h.ledger.balance("pub4"), 175);
  const eloA1 = h.repo.getAgent("a1")!.eloGlobal!;
  assert.ok(eloA1 < 1500, `majorError → elo 下降（${eloA1}）`);
  const settleEvents = drainByKind(h, "economy.settle").filter((e) => e.data.role === "executor");
  assert.equal(settleEvents.length, 1);
  assert.equal(settleEvents[0].data.settle, -15, "负 settle 金额 = −stake");
  assert.equal(settleEvents[0].data.to, "pub4", "负流直付 publisher（C-2）");
});

// ── 5. 流标轮 ────────────────────────────────────────────────────
test("5. 流标轮：激活 2/5 → 重试 2 次 → operator 兜底（少数者退款 + 未接单冻结回收）", async () => {
  const h = mkEnv();
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) addAgent(h, id, { balance: 200 });
  addAgent(h, "pub5", { balance: 200, accepts: [] });
  const runner = new MarketRunner(
    makeDeps(h, {
      candidates: () => ["a1", "a2", "a3", "a4", "a5"],
      spawnBidder: async (id) => ({ stake: id === "a1" ? 15 : 8 }),
      spawnReviewer: async (reviewerId) => {
        if (reviewerId === "a2") return { score: 0.7 };
        if (reviewerId === "a3") return { score: 0.8 };
        throw new Error("reviewer not activated");
      },
    })
  );

  const res = await runner.runMarket({ typeId: "code", publisherId: "pub5", maxStake: 20, odds: 3, brief: "understaffed" });
  assert.equal(res.status, "settled");

  // operator 兜底（R=0.5）→ executor settle 0；operator 单评审 gross 10（net 9.5）
  assert.equal(h.ledger.balance("a1"), 200, "executor settle 0");
  assert.equal(h.ledger.balance("operator"), 9.5, "operator 兜底评审收入");
  // pub5: 200 − 96 + 10 + 86 − 24(退款) − 10(operator gross) = 166
  assert.equal(h.ledger.balance("pub5"), 166);
  // 已接单少数者（a2/a3）：stake_r 10 + 凭证补偿 2 = 12（冻结已释放）
  assert.equal(h.ledger.balance("a2"), 212, "a2 退款 12");
  assert.equal(h.ledger.balance("a3"), 212, "a3 退款 12");
  // 未接单者（a4/a5）：冻结回收（I5 不 stranded）
  assert.equal(h.ledger.balance("a4"), 200);
  assert.equal(h.ledger.balance("a5"), 200);
  assert.equal(frozenOf(h.ledger, "a4"), 0);
  assert.equal(frozenOf(h.ledger, "a5"), 0);

  const evs = h.events.drain();
  const consensusEvents = evs.filter((e) => e.kind === "economy.review_consensus");
  assert.ok(consensusEvents.some((e) => e.data.operatorFallback === true), "operator 兜底事件");
  assert.equal(evs.filter((e) => e.kind === "economy.settle" && e.data.refund === true).length, 2, "2 名少数者退款");
});

// ── 6. 校准轮 ────────────────────────────────────────────────────
test("6. 校准轮：calibrationRate=1.0 → ground truth 评定 + isCalibration 事件 + 校准偏差榜", async () => {
  const h = mkEnv();
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) addAgent(h, id, { balance: 200 });
  addAgent(h, "pub6", { balance: 200, accepts: [] });
  h.cal.add({ taskId: "cal-1", brief: "calibrate me", groundTruthArtifact: "gt-artifact", groundTruthScore: 0.9 });
  const runner = new MarketRunner(
    makeDeps(h, {
      calibrationRate: 1.0,
      rng: () => 0.05,
      candidates: () => ["a1", "a2", "a3", "a4", "a5"],
      spawnBidder: async () => ({ stake: 8 }),
      spawnReviewer: async () => ({ score: 0.9 }),
    })
  );

  const res = await runner.runMarket({ typeId: "code", publisherId: "pub6", maxStake: 20, odds: 3, brief: "x" });
  assert.equal(res.status, "settled");
  assert.equal(res.taskId, "cal-1");

  const task = h.store.getTask("cal-1")!;
  assert.equal(task.isCalibration, true);
  assert.equal(task.winnerId, "calibration-executor", "合成执行者（stake_cal=0）");
  assert.equal(task.winnerStake, 0);
  assert.equal(h.ledger.balance("pub6"), 150, "escrow 56 全退 − 评审 gross 50");
  assert.equal(h.ledger.balance("calibration-executor"), 0, "合成执行者 settle 0 直接入池（无结算款）");

  const evs = h.events.drain();
  const freeze = evs.find((e) => e.kind === "economy.escrow_freeze")!;
  assert.equal(freeze.isCalibration, true);
  assert.equal(freeze.data.amount, 56, "stake_cal=0 → escrow 56（无执行者 stake 项）");
  const consensusEv = evs.find((e) => e.kind === "economy.review_consensus")!;
  assert.equal(consensusEv.isCalibration, true);
  assert.equal(consensusEv.data.groundTruthScore, 0.9, "ground truth 评定锚点");
  for (const s of evs.filter((e) => e.kind === "economy.settle")) assert.equal(s.isCalibration, true);

  // 校准偏差榜（投影——真实事件基源）
  const report = projectEconomy(h.events.replayAll());
  assert.equal(report.calibrationBias.length, 5);
  for (const b of report.calibrationBias) assert.equal(b.bias, 0, "评审 r_i 与 ground truth 一致 → 偏差 0");
  assert.equal(report.poolBalance, h.ledger.balance(CENTRAL_POOL_ID));
});

// ── 7. resume：checkpoint 恢复 ────────────────────────────────────
test("7. resume：collect_bids 后崩溃 → 新 runner 实例重启 → 快照/幂等恢复，最终余额与全流程一致", async () => {
  const h = mkEnv();
  for (const id of ["a1", "a2", "a3", "a4", "a5", "a6"]) addAgent(h, id, { balance: 150 });
  addAgent(h, "pub1", { balance: 100, accepts: [] });
  const deps = makeDeps(h, {
    candidates: () => ["a1", "a2", "a3", "a4", "a5", "a6"],
    spawnBidder: async (agentId) => ({ stake: { a1: 15, a2: 12, a3: 10, a4: 8, a5: 5, a6: 0 }[agentId] ?? 0 }),
    spawnReviewer: async () => ({ score: 0.9 }),
  });

  // 第一次运行：collect_bids 后"崩溃"（stopAfter——相位持久化，effect 未推进）
  const runner1 = new MarketRunner(deps);
  const crash = await runner1.runMarket(
    { typeId: "code", publisherId: "pub1", maxStake: 20, odds: 3, brief: "write tests" },
    { stopAfter: "collect_bids" }
  );
  assert.equal(crash.status, "open");
  const taskId = crash.taskId;

  // 崩溃点状态：fanout 快照已落库（economy_bids 5 行）、escrow 未调减、发布方冻结 96
  assert.equal(h.store.getBids(taskId).length, 5);
  assert.equal(h.ledger.balance("pub1"), 4);
  assert.equal(frozenOf(h.ledger, "pub1"), 96);
  assert.equal(h.ledger.balance("a1"), 120, "150 − 30(bid 冻结)");
  const crashedEvents = h.events.drain();
  assert.equal(crashedEvents.filter((e) => e.kind === "economy.bid_freeze").length, 5);
  assert.equal(crashedEvents.filter((e) => e.kind === "economy.escrow_freeze").length, 1);

  // 重启：新 runner 实例（同 deps——内存 checkpoint 丢失，从 store 重建）
  const runner2 = new MarketRunner(deps);
  const resumed = await runner2.resumeMarket(taskId);
  assert.equal(resumed.status, "settled");

  // 最终余额与未崩溃全流程一致（无重复冻结/重复划付）
  assert.equal(h.ledger.balance("a1"), 172.8, "winner 余额与全流程一致");
  assert.equal(h.ledger.balance("pub1"), 26);
  assert.equal(h.ledger.balance(CENTRAL_POOL_ID), 3.7);
  assert.equal(h.store.getBids(taskId).length, 5, "fanout 快照无重复行");

  // effect 幂等：resume 不重复 escrow_freeze / bid_freeze；adjust/settle 各一次
  const resumeEvents = h.events.drain();
  assert.equal(resumeEvents.filter((e) => e.kind === "economy.escrow_freeze").length, 0, "persist 幂等 skip");
  assert.equal(resumeEvents.filter((e) => e.kind === "economy.bid_freeze").length, 0, "fanout 快照复用");
  assert.equal(resumeEvents.filter((e) => e.kind === "economy.escrow_adjust").length, 1);
  assert.equal(resumeEvents.filter((e) => e.kind === "economy.settle").length, 6);

  // 已结算再 resume → no-op（幂等）
  const again = await runner2.resumeMarket(taskId);
  assert.equal(again.status, "settled");
  assert.equal(h.events.drain().length, 0);
  h.db.close();
});

// ── 8. emitBurn 凭证幂等（Task 2——resume 窄窗双燃闭合）────────────
// 崩溃窗口：emitBurn 之后、updateTask(executing) 之前崩溃 → task.status 仍是 awarded →
// resume 重放 execute → 同 traceId（taskId）再次 emitBurn。业务键 = (agentId, kind, traceId)。
test("8. emitBurn 幂等：同 (agentId, kind, traceId) 二次调用跳过（不重复燃/不发事件）；异 traceId/异 kind/periodic 正常", () => {
  const h = mkEnv();
  addAgent(h, "x1", { balance: 100 });
  h.voucher.buy("x1", "llm", 6); // 6 units @2 = 12 credit（FIFO creditCost = 2/unit）
  h.voucher.buy("x1", "time", 3);
  const deps = { events: h.events, voucher: h.voucher };

  // 首次燃烧（cause traceId=task-t1）→ 燃 2 units，burnHistory 1 条，事件 1 发
  emitBurn(deps, "x1", "llm", 2, { traceId: "task-t1", transitionSeq: 1 });
  assert.equal(h.voucher.balance("x1", "llm"), 4);
  let burns = h.voucher.burnHistory("x1", "llm");
  assert.equal(burns.length, 1);
  assert.equal(burns[0]!.creditCost, 4, "FIFO 历史成本");
  assert.equal(drainByKind(h, "currency.burn").length, 1);

  // resume 重放：同 traceId 二次 emitBurn → 幂等跳过（不重复燃、不发新事件）
  emitBurn(deps, "x1", "llm", 2, { traceId: "task-t1", transitionSeq: 1 });
  assert.equal(h.voucher.balance("x1", "llm"), 4, "不重复燃");
  burns = h.voucher.burnHistory("x1", "llm");
  assert.equal(burns.length, 1, "burnHistory 仅 1 条（非 2）");
  assert.equal(drainByKind(h, "currency.burn").length, 0, "不发新 burn 事件（resume 语义——该 burn 已发生）");

  // 不同 traceId（另一任务）→ 正常各燃
  emitBurn(deps, "x1", "llm", 2, { traceId: "task-t2", transitionSeq: 1 });
  assert.equal(h.voucher.balance("x1", "llm"), 2);
  assert.equal(h.voucher.burnHistory("x1", "llm").length, 2);

  // 同 traceId 不同 kind → 正常燃烧（业务键含 kind）
  emitBurn(deps, "x1", "time", 1, { traceId: "task-t1", transitionSeq: 1 });
  assert.equal(h.voucher.burnHistory("x1", "time").length, 1);

  // periodic 形态（无 traceId）→ 不查幂等，每次正常燃烧
  emitBurn(deps, "x1", "time", 1, { periodic: "memory-storage" });
  emitBurn(deps, "x1", "time", 1, { periodic: "memory-storage" });
  assert.equal(h.voucher.burnHistory("x1", "time").length, 3);
  assert.equal(h.voucher.balance("x1", "time"), 0, "买 3 燃 3（1 task-t1 + 2 periodic）");
  h.db.close();
});
