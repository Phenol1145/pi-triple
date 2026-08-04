// 市场 code fns 前半测试（plan Task 2 / spec §5.1 announce/shortlist/select）。
// 覆盖：announce 常规与校准分支、shortlist 承接过滤+elo 域分/回退+maxFanout 截断、
// select stake-elo-power 公式+同分字典序、未注册类型拒收；
// round 2 修复：表名隔离共存、select 域 elo、Store 方法幂等、校准占位回退、裁决去 elo 层。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MarketStore } from "../src/economy/market-store.ts";
import { registerMarketCodeFns, type MarketFnsDeps, type CodeRegistry } from "../src/economy/market-fns.ts";
import { SqliteTaskTypeRegistry, type TaskType } from "../src/economy/task-types.ts";
import {
  EloFormulaRegistry,
  SelectionFormulaRegistry,
  simpleElo,
  stakeEloPower,
} from "../src/economy/elo.ts";
import type { Ledger } from "../src/arena/types.ts";
import type { VoucherPort } from "../src/economy/voucher-port.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";

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

// ── announce 常规任务 ───────────────────────────────────────────────
test("announce：常规任务（rng=0.99 不触发校准）→ 新 taskId + status open + isCalibration false", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db, { rng: () => 0.99 });
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const fn = registry.resolve("market.announce")!;
  const result = fn({}, makeCtx({ taskSpec: baseTaskSpec() })) as { taskId: string; isCalibration: boolean };

  assert.equal(typeof result.taskId, "string");
  assert.equal(result.isCalibration, false);

  const task = deps.store.getTask(result.taskId);
  assert.ok(task, "任务应已落库");
  assert.equal(task!.status, "open");
  assert.equal(task!.isCalibration, false);
  assert.equal(task!.typeId, "code");
  assert.equal(task!.publisherId, "pub-1");

  db.close();
});

// ── announce 校准触发 ───────────────────────────────────────────────
test("announce：校准触发（rng=0.05 < 0.10）→ 从校准任务池取 + isCalibration true", () => {
  const db = new DatabaseSync(":memory:");
  // Task 6：真实 CalibrationPool 形状（CalibrationTask.groundTruthArtifact）。
  const calibration = {
    draw: (_rng: () => number) => ({
      taskId: "cal-task-1",
      brief: "calibration brief",
      groundTruthArtifact: "gt-artifact-ref",
      groundTruthScore: 0.9,
    }),
  };
  const deps = makeDeps(db, { rng: () => 0.05, calibration });
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const fn = registry.resolve("market.announce")!;
  const result = fn({}, makeCtx({ taskSpec: baseTaskSpec() })) as { taskId: string; isCalibration: boolean };

  assert.equal(result.isCalibration, true);
  assert.equal(result.taskId, "cal-task-1");

  const task = deps.store.getTask(result.taskId);
  assert.ok(task);
  assert.equal(task!.status, "open");
  assert.equal(task!.isCalibration, true);
  assert.equal(task!.groundTruth, "gt-artifact-ref");
  assert.equal(task!.brief, "calibration brief");

  db.close();
});

// ── shortlist 承接过滤 + elo 域分降序 + maxFanout 截断 ───────────────
test("shortlist：5 候选 3 承接 → elo 降序取前 2（maxFanout=2）", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const repo = new CoreRepository(db);
  repo.insertAgent(agentRecord("a1", { accepts: ["code"], eloGlobal: 1500, eloByDomain: { code: 1600 } }));
  repo.insertAgent(agentRecord("a2", { accepts: ["code"], eloGlobal: 1500, eloByDomain: { code: 1700 } }));
  repo.insertAgent(agentRecord("a3", { accepts: ["code"], eloGlobal: 1500, eloByDomain: { code: 1400 } }));
  repo.insertAgent(agentRecord("a4", { accepts: ["doc"], eloGlobal: 1500, eloByDomain: { code: 1800 } }));
  repo.insertAgent(agentRecord("a5", { accepts: ["code"], eloGlobal: 1490 })); // 无域分，回退 global

  const fn = registry.resolve("market.shortlist")!;
  const result = fn({}, makeCtx({ candidates: ["a1", "a2", "a3", "a4", "a5"], typeId: "code", maxFanout: 2 })) as { shortlist: string[] };

  // a2(1700) > a1(1600) > a5(1490) > a3(1400)；a4 因 accepts 不匹配被过滤
  assert.deepEqual(result.shortlist, ["a2", "a1"]);

  db.close();
});

// ── shortlist 域分缺失回退 global ───────────────────────────────────
test("shortlist：elo_byDomain 有域分用域分，无回退 global", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const repo = new CoreRepository(db);
  repo.insertAgent(agentRecord("d1", { accepts: ["code"], eloGlobal: 1500, eloByDomain: { code: 1650 } }));
  repo.insertAgent(agentRecord("d2", { accepts: ["code"], eloGlobal: 1600 })); // 无域分，回退 1600

  const fn = registry.resolve("market.shortlist")!;
  const result = fn({}, makeCtx({ candidates: ["d1", "d2"], typeId: "code" })) as { shortlist: string[] };

  assert.deepEqual(result.shortlist, ["d1", "d2"]);

  db.close();
});

// ── select stake-elo-power + 同分字典序 ─────────────────────────────
test("select：stake-elo-power 公式（stake 高者胜；同 stake elo 高者胜；全同分 agentId 字典序）", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const repo = new CoreRepository(db);
  repo.insertAgent(agentRecord("a1", { eloGlobal: 1500 }));
  repo.insertAgent(agentRecord("a2", { eloGlobal: 1600 }));
  repo.insertAgent(agentRecord("a3", { eloGlobal: 1500 }));

  const fn = registry.resolve("market.select")!;
  const result = fn(
    {},
    makeCtx({
      shortlist: ["a1", "a2", "a3"],
      bids: [
        { agentId: "a1", stake: 30 },
        { agentId: "a2", stake: 20 },
        { agentId: "a3", stake: 30 },
      ],
      odds: 2,
    })
  ) as { winnerId: string; winnerStake: number };

  // a1/a3 score = 30 * sqrt(1500/1500) = 30
  // a2 score = 20 * sqrt(1600/1500) ≈ 20.66
  // a1 与 a3 全同分，按 agentId 字典序 a1 < a3
  assert.equal(result.winnerId, "a1");
  assert.equal(result.winnerStake, 30);

  db.close();
});

// ── announce 未注册类型拒收 ─────────────────────────────────────────
test("announce：未注册类型 → 抛错（I5 市场拒收）", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const fn = registry.resolve("market.announce")!;
  const spec = { ...baseTaskSpec(), typeId: "not-registered" };

  assert.throws(
    () => fn({}, makeCtx({ taskSpec: spec })),
    /not registered|未注册|拒收/
  );

  db.close();
});

// ── round 2: SqliteLedger 与 MarketStore 同库共存（表名隔离）────────
test("round 2：同库 SqliteLedger 与 MarketStore 并存无冲突", () => {
  const db = new DatabaseSync(":memory:");
  const fixedEndow = { initialCredits: () => 1000 };
  const ledger = new SqliteLedger(db, fixedEndow);
  const store = new MarketStore(db);

  // arena 遗留 market_tasks 表写入
  ledger.ensureEndowed("m/a", { id: "m/a", provider: "p", name: "m/a", accessRoute: "free" });
  ledger.createTask(
    { id: "arena-task", role: "r", prompt: "p", difficulty: "easy", odds: 1.5, reward: 10 },
    "m/a",
    100,
    1,
    "m/a"
  );

  // economy 新 economy_tasks / economy_bids 表写入
  const taskId = "eco-task";
  store.createTask({
    taskId,
    typeId: "code",
    publisherId: "pub",
    maxStake: 10,
    odds: 2,
    reviewerCount: 3,
    stakeR: 5,
    oddsR: 1,
    voucherAllowance: 2,
    brief: "b",
    status: "open",
    createdAt: Date.now(),
  });
  store.recordBid(taskId, "bid-a", 5);

  // 两边数据各回各表
  const arenaTask = ledger.getTask("arena-task")!;
  assert.equal(arenaTask.winner, "m/a");
  assert.equal(arenaTask.status, "pending");

  const ecoTask = store.getTask(taskId)!;
  assert.equal(ecoTask.typeId, "code");
  assert.equal(ecoTask.status, "open");
  assert.deepEqual(store.getBids(taskId), [{ bidderId: "bid-a", stake: 5 }]);

  // 表级隔离：arena 的 market_tasks 与 economy 的 economy_tasks/economy_bids 同时存在
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('market_tasks','economy_tasks','economy_bids')")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((t) => t.name).sort(),
    ["economy_bids", "economy_tasks", "market_tasks"]
  );

  db.close();
});

// ── round 2: select 使用域 elo（eloByDomain → eloGlobal → INITIAL）────
test("round 2：select 使用域 elo 而非全局 elo", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const repo = new CoreRepository(db);
  // a1 域分高但全局低；a2 全局高但域分低
  repo.insertAgent(agentRecord("a1", { eloGlobal: 1400, eloByDomain: { code: 1700 } }));
  repo.insertAgent(agentRecord("a2", { eloGlobal: 1800, eloByDomain: { code: 1500 } }));

  const fn = registry.resolve("market.select")!;
  const result = fn(
    {},
    makeCtx({
      typeId: "code",
      shortlist: ["a1", "a2"],
      bids: [
        { agentId: "a1", stake: 10 },
        { agentId: "a2", stake: 10 },
      ],
      odds: 2,
    })
  ) as { winnerId: string; winnerStake: number };

  // 同 stake 同 odds 时，域 elo 高者 score 更高
  assert.equal(result.winnerId, "a1");
  assert.equal(result.winnerStake, 10);

  db.close();
});

// ── round 2: MarketStore 方法幂等第二次返回 false ───────────────────
test("round 2：MarketStore createTask / recordBid / updateTask / getBids 幂等行为", () => {
  const db = new DatabaseSync(":memory:");
  const store = new MarketStore(db);
  const task: import("../src/economy/market-store.ts").MarketTask = {
    taskId: "t1",
    typeId: "code",
    publisherId: "pub",
    maxStake: 10,
    odds: 2,
    reviewerCount: 3,
    stakeR: 5,
    oddsR: 1,
    voucherAllowance: 2,
    brief: "b",
    status: "open",
    createdAt: 1,
  };

  assert.equal(store.createTask(task), true, "第一次 createTask 应返回 true");
  assert.equal(store.createTask(task), false, "第二次 createTask 应返回 false");

  assert.equal(store.recordBid("t1", "b1", 5), true, "第一次 recordBid 应返回 true");
  assert.equal(store.recordBid("t1", "b1", 5), false, "第二次相同 recordBid 应返回 false");

  // getBids 是只读查询，两次结果一致即幂等
  const first = store.getBids("t1");
  const second = store.getBids("t1");
  assert.deepEqual(first, [{ bidderId: "b1", stake: 5 }]);
  assert.deepEqual(second, first);

  assert.equal(store.updateTask("t1", { status: "awarded" }), true, "第一次 updateTask 应返回 true");
  assert.equal(store.updateTask("t1", { status: "awarded" }), false, "第二次无变化 updateTask 应返回 false");

  db.close();
});

// ── round 2: calibration 占位回退（未提供/draw 返回 undefined）──────
test("round 2：rng 命中 calibrationRate 但 calibration 未提供时不触发校准", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db, { rng: () => 0.05, calibration: undefined });
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const fn = registry.resolve("market.announce")!;
  const result = fn({}, makeCtx({ taskSpec: baseTaskSpec() })) as { taskId: string; isCalibration: boolean };

  assert.equal(result.isCalibration, false);
  const task = deps.store.getTask(result.taskId)!;
  assert.equal(task.isCalibration, false);
  assert.equal(task.groundTruth, undefined);

  db.close();
});

test("round 2：rng 命中 calibrationRate 但 draw 返回 undefined 时不触发校准", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db, {
    rng: () => 0.05,
    calibration: { draw: () => undefined },
  });
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const fn = registry.resolve("market.announce")!;
  const result = fn({}, makeCtx({ taskSpec: baseTaskSpec() })) as { taskId: string; isCalibration: boolean };

  assert.equal(result.isCalibration, false);
  const task = deps.store.getTask(result.taskId)!;
  assert.equal(task.isCalibration, false);
  assert.equal(task.groundTruth, undefined);

  db.close();
});

// ── round 2: select 同分裁决去 elo 层（score → stake → agentId）─────
test("round 2：select 同分裁决 score 相同看 stake，不再比较 elo", () => {
  const db = new DatabaseSync(":memory:");
  const deps = makeDeps(db);
  const registry = makeCodeRegistry();
  registerMarketCodeFns(registry, deps);

  const repo = new CoreRepository(db);
  // a1 elo 高，a2 elo 低；通过调整 stake 使 score 相等
  // score = stake * sqrt(elo/1500)
  // a1: stake=10, elo=1600 → score = 10 * sqrt(1600/1500)
  // a2: stake=10 * sqrt(1600/1500), elo=1500 → score 相同
  const a1Stake = 10;
  const a2Stake = 10 * Math.sqrt(1600 / 1500);
  repo.insertAgent(agentRecord("a1", { eloGlobal: 1600 }));
  repo.insertAgent(agentRecord("a2", { eloGlobal: 1500 }));

  const fn = registry.resolve("market.select")!;
  const result = fn(
    {},
    makeCtx({
      typeId: "code",
      shortlist: ["a1", "a2"],
      bids: [
        { agentId: "a1", stake: a1Stake },
        { agentId: "a2", stake: a2Stake },
      ],
      odds: 2,
    })
  ) as { winnerId: string; winnerStake: number };

  // score 相同 → 比较 stake，a2 stake 更高
  assert.equal(result.winnerId, "a2");
  assert.equal(result.winnerStake, a2Stake);

  db.close();
});
