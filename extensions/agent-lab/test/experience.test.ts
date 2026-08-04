// 结算经验沉淀测试（plan Task 9 / spec §9）。
// 覆盖：执行经验（c=R / 税后 settle）、竞价经验（全体 bidder won×1+lost×N + meta）、
// 评审经验（accuracy/reward + 校准 ground-truth mode 标记）、组织违约经验（成员视角）、
// 沉淀入口（mock sink 验证调用形状 kind/content/anchors/idempotencyKey）。
// 数值钉死（spec §7/§7a）：settle=stake×(O−1)×(2c−1)；settle_i=stakeR×(O_r−1)×(2a_i−1)；
// 税后 = settle − max(0,settle)×rate（对称课税负收益不课——与 market-effects 划付一致）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  experiencesFromSettlement,
  orgDefaultExperiences,
  sedimentExperiences,
  type SettlementExperience,
} from "../src/economy/experience.ts";
import { planSettlement, type SettlementPlan } from "../src/economy/settlement.ts";
import { simpleElo, taskRatingFromOdds } from "../src/economy/elo.ts";
import type { MarketTask } from "../src/economy/market-store.ts";
import type { MemoryEntry } from "../src/memory/entry.ts";

const TAX_RATE = 0.05;

function closeTo(actual: number, expected: number, eps = 1e-9, msg?: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg ?? "value"} expected ${actual} ≈ ${expected} (±${eps})`);
}

function makeTask(overrides: Partial<MarketTask> = {}): MarketTask {
  return {
    taskId: "task-1",
    typeId: "codegen",
    publisherId: "pub-1",
    maxStake: 100,
    odds: 2,
    reviewerCount: 5,
    stakeR: 10,
    oddsR: 3,
    voucherAllowance: 50,
    brief: "deliverable brief",
    status: "settled",
    winnerId: "w1",
    winnerStake: 100,
    createdAt: 1,
    ...overrides,
  };
}

/** 标准评审（5 人，R=0.7——排序后 index 2）。 */
const REVIEWS_5 = [
  { reviewerId: "r1", score: 0.6 },
  { reviewerId: "r2", score: 0.65 },
  { reviewerId: "r3", score: 0.7 },
  { reviewerId: "r4", score: 0.75 },
  { reviewerId: "r5", score: 0.8 },
];

function settlePlan(task: MarketTask, reviews: { reviewerId: string; score: number }[], opts: { groundTruthScore?: number } = {}): SettlementPlan {
  return planSettlement({
    task,
    winnerId: task.winnerId ?? "w1",
    winnerStake: task.winnerStake ?? 0,
    reviews,
    ...(opts.groundTruthScore !== undefined ? { groundTruthScore: opts.groundTruthScore } : {}),
    eloFn: simpleElo,
    taxRate: TAX_RATE,
    executorElo: { global: 1500, byDomain: {} },
    reviewerElos: new Map(),
    taskRating: taskRatingFromOdds(task.odds),
  });
}

test("执行经验：c=0.7/settle 税后 → execution 字段正确", () => {
  const task = makeTask();
  // R = median(0.6, 0.7, 0.8) = 0.7 → c=R；settle = 100×(2−1)×(2×0.7−1) = 40；
  // 税后 = 40×(1−0.05) = 38
  const plan = settlePlan(task, [
    { reviewerId: "r1", score: 0.6 },
    { reviewerId: "r2", score: 0.7 },
    { reviewerId: "r3", score: 0.8 },
  ]);
  const exps = experiencesFromSettlement(plan, task, [{ bidderId: "w1", stake: 100 }]);
  const exec = exps.find((e): e is Extract<SettlementExperience, { kind: "execution" }> => e.kind === "execution");
  assert.ok(exec, "execution experience missing");
  assert.equal(exec.agentId, "w1");
  assert.equal(exec.scene, "codegen");
  assert.equal(exec.action, "execute");
  closeTo(exec.outcome, 0.7, 1e-9, "outcome = c (=R)");
  closeTo(exec.reward, 38, 1e-9, "reward = settle 税后");
});

test("竞价经验：3 bidder 1 winner → 3 条（won×1 + lost×2，meta 含 winnerId/winnerStake）", () => {
  const task = makeTask({ winnerId: "a2", winnerStake: 50 });
  const plan = settlePlan(task, [
    { reviewerId: "r1", score: 0.6 },
    { reviewerId: "r2", score: 0.7 },
    { reviewerId: "r3", score: 0.8 },
  ]);
  const bids = [
    { bidderId: "a1", stake: 30 },
    { bidderId: "a2", stake: 50 },
    { bidderId: "a3", stake: 20 },
  ];
  const exps = experiencesFromSettlement(plan, task, bids);
  const biddings = exps.filter((e): e is Extract<SettlementExperience, { kind: "bidding" }> => e.kind === "bidding");
  assert.equal(biddings.length, 3, "全体 bidder 各一条");
  const won = biddings.filter((b) => b.outcome === "won");
  const lost = biddings.filter((b) => b.outcome === "lost");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 2);

  const wonBid = won[0]!;
  assert.equal(wonBid.agentId, "a2");
  assert.equal(wonBid.action, "bid:50"); // action = bid:${stake}
  assert.equal(wonBid.meta.winnerId, "a2");
  assert.equal(wonBid.meta.winnerStake, 50);

  const lostA1 = lost.find((b) => b.agentId === "a1")!;
  assert.ok(lostA1);
  assert.equal(lostA1.action, "bid:30");
  assert.equal(lostA1.meta.winnerId, "a2");
  assert.equal(lostA1.meta.winnerStake, 50);
  assert.equal(lost.find((b) => b.agentId === "a3")!.action, "bid:20");

  for (const b of biddings) {
    assert.equal(b.scene, "codegen");
  }
});

test("评审经验：5 评审 → 5 条（accuracy/reward；校准任务 → ground-truth + outcome=groundTruthScore）", () => {
  const task = makeTask({ reviewerCount: 5 });
  const plan = settlePlan(task, REVIEWS_5);
  const exps = experiencesFromSettlement(plan, task, [{ bidderId: "w1", stake: 100 }]);
  const revs = exps.filter((e): e is Extract<SettlementExperience, { kind: "review" }> => e.kind === "review");
  assert.equal(revs.length, 5);
  const byId = new Map(revs.map((r) => [r.agentId, r]));
  // R=0.7 → a_i = 1−|r_i−0.7|；settle_i = 10×(3−1)×(2a−1)；税后 ×(1−0.05)
  const expect = [
    { id: "r1", accuracy: 0.9, reward: 16 * 0.95 },
    { id: "r2", accuracy: 0.95, reward: 18 * 0.95 },
    { id: "r3", accuracy: 1.0, reward: 20 * 0.95 },
    { id: "r4", accuracy: 0.95, reward: 18 * 0.95 },
    { id: "r5", accuracy: 0.9, reward: 16 * 0.95 },
  ];
  for (const exp of expect) {
    const r = byId.get(exp.id);
    assert.ok(r, `review experience missing for ${exp.id}`);
    assert.equal(r.evaluationMode, "consensus");
    assert.equal(r.action, "review:10"); // action = review:${stakeR}
    assert.equal(r.scene, "codegen");
    closeTo(r.outcome, 0.7, 1e-9, "outcome = c (=R)");
    closeTo(r.accuracy, exp.accuracy, 1e-9, `accuracy of ${exp.id}`);
    closeTo(r.reward, exp.reward, 1e-9, `reward of ${exp.id}`);
  }

  // 校准任务：evaluationMode="ground-truth" + outcome=groundTruthScore；执行经验 outcome 同锚点
  const calTask = makeTask({ taskId: "task-cal", isCalibration: true });
  const calPlan = settlePlan(calTask, REVIEWS_5, { groundTruthScore: 0.8 });
  const calExps = experiencesFromSettlement(calPlan, calTask, [{ bidderId: "w1", stake: 100 }]);
  const calRevs = calExps.filter((e): e is Extract<SettlementExperience, { kind: "review" }> => e.kind === "review");
  assert.equal(calRevs.length, 5);
  for (const r of calRevs) {
    assert.equal(r.evaluationMode, "ground-truth");
    closeTo(r.outcome, 0.8, 1e-9, "校准 outcome = groundTruthScore");
  }
  // 校准 accuracy 按 ground truth 锚定（1−|r_i−0.8|）
  const calById = new Map(calRevs.map((r) => [r.agentId, r]));
  closeTo(calById.get("r1")!.accuracy, 0.8, 1e-9, "校准 a_r1 = 1−|0.6−0.8|");
  closeTo(calById.get("r5")!.accuracy, 1.0, 1e-9, "校准 a_r5 = 1−|0.8−0.8|");
  const calExec = calExps.find((e): e is Extract<SettlementExperience, { kind: "execution" }> => e.kind === "execution");
  assert.ok(calExec);
  closeTo(calExec.outcome, 0.8, 1e-9, "校准执行经验 outcome = groundTruthScore");
});

test("组织违约经验：org_default 事件 → 成员视角经验（orgId 关联）", () => {
  const exps = orgDefaultExperiences({ orgId: "org-1", members: ["m1", "m2", "m3"], scene: "codegen" });
  assert.equal(exps.length, 3, "每位成员一条");
  assert.deepEqual(exps.map((e) => e.agentId).sort(), ["m1", "m2", "m3"]);
  for (const e of exps) {
    assert.equal(e.kind, "org_default");
    if (e.kind !== "org_default") continue;
    assert.equal(e.orgId, "org-1");
    assert.equal(e.scene, "codegen");
  }
});

test("沉淀入口：经验写入记忆域（mock sink——验证调用形状 kind/content/anchors/idempotencyKey）", () => {
  const task = makeTask({ winnerId: "a2", winnerStake: 50 });
  const plan = settlePlan(task, [
    { reviewerId: "r1", score: 0.6 },
    { reviewerId: "r2", score: 0.7 },
    { reviewerId: "r3", score: 0.8 },
  ]);
  const experiences = experiencesFromSettlement(plan, task, [
    { bidderId: "a1", stake: 30 },
    { bidderId: "a2", stake: 50 },
  ]);
  assert.ok(experiences.length >= 3, "四类经验至少覆盖 3 种");

  const calls: Array<{ idempotencyKey?: string; kind?: string; content?: string; anchors?: string[] }> = [];
  sedimentExperiences(
    {
      write: (entry: { idempotencyKey: string } & Partial<MemoryEntry>) => {
        calls.push({ idempotencyKey: entry.idempotencyKey, kind: entry.kind, content: entry.content, anchors: entry.anchors });
        return { ok: true, entry: entry as MemoryEntry };
      },
    },
    { taskId: task.taskId, experiences }
  );

  assert.equal(calls.length, experiences.length, "逐条写入");
  for (let i = 0; i < experiences.length; i++) {
    const exp = experiences[i]!;
    const call = calls[i]!;
    assert.equal(call.kind, "experience");
    assert.equal(call.idempotencyKey, `${exp.kind}:${task.taskId}:${exp.agentId}`, "幂等键 = kind:taskId:agentId");
    assert.deepEqual(JSON.parse(call.content ?? ""), exp, "content = 经验 JSON");
    assert.deepEqual(call.anchors, [task.taskId, exp.scene, exp.agentId]);
  }
  // 幂等键唯一性（同 task 多经验不撞键）
  const keys = calls.map((c) => c.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length, "幂等键互异");
});
