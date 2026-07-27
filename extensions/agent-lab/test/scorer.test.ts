import { test } from "node:test";
import assert from "node:assert/strict";
import { recommend, scoreCandidates, minmax } from "../src/scorer/scorer.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Aggregate, ModelInfo } from "../src/types.ts";

function model(id: string, pricing?: { in: number; out: number }, perf?: number): ModelInfo {
  const free = pricing != null && pricing.in === 0 && pricing.out === 0;
  return { id, provider: id.split("/")[0], name: id, pricing, perf: perf != null ? { throughputP50: perf } : undefined, accessRoute: free ? "free" : "direct" };
}

test("minmax normalizes and inverts", () => {
  assert.deepEqual(minmax([0, 5, 10]), [0, 0.5, 1]);
  assert.deepEqual(minmax([0, 5, 10], true), [1, 0.5, 0]);
  assert.deepEqual(minmax([3, 3, 3]), [0.5, 0.5, 0.5]);
});

test("free model gets cost advantage", () => {
  const scored = scoreCandidates([model("a/free", { in: 0, out: 0 }), model("b/paid", { in: 1, out: 1 })], new Map(), DEFAULT_CONFIG);
  const sFree = scored.find((s) => s.model.id === "a/free")!;
  const sPaid = scored.find((s) => s.model.id === "b/paid")!;
  assert.ok(sFree.breakdown.costEffectiveness > sPaid.breakdown.costEffectiveness);
});

test("empirical completion beats cold start when high", () => {
  const m1 = model("x/m1", { in: 0.5, out: 0.5 });
  const m2 = model("x/m2", { in: 0.5, out: 0.5 });
  const aggs = new Map<string, Aggregate>([
    ["x/m1", { model: "x/m1", role: "r", runs: 5, avgCompletion: 0.95, avgCost: 0.5, successRate: 1 }],
  ]);
  const top = recommend([m1, m2], aggs, DEFAULT_CONFIG, 1);
  assert.equal(top[0].model.id, "x/m1");
  assert.equal(top[0].coldStart, false);
});

test("recommend respects topN and sorts desc", () => {
  const ms = [model("a/a", { in: 0, out: 0 }), model("b/b", { in: 1, out: 1 }), model("c/c", { in: 2, out: 2 })];
  const top = recommend(ms, new Map(), DEFAULT_CONFIG, 2);
  assert.equal(top.length, 2);
  assert.ok(top[0].score >= top[1].score);
});
