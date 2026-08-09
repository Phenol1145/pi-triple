import { test } from "node:test";
import assert from "node:assert/strict";
import { EndowmentPolicyV1, OddsPolicyV1, SettlementPolicyV1, CostModelV1, parseBidResponse, renderBidPrompt, DEFAULT_BID_PROMPT } from "../src/arena/policies.ts";
import { DEFAULT_MARKET_CONFIG } from "../src/config.ts";
import type { ModelInfo } from "../src/types.ts";
import type { ArenaTask, Outcome } from "../src/arena/types.ts";

const cfg = DEFAULT_MARKET_CONFIG;
function model(price?: { in: number; out: number }): ModelInfo {
  const free = price != null && price.in === 0 && price.out === 0;
  return { id: "x/y", provider: "x", name: "y", pricing: price, accessRoute: free ? "free" : "direct" };
}
const task: ArenaTask = { id: "t", role: "r", prompt: "p", difficulty: "medium", odds: 3.0, reward: 10 };
const clean: Outcome = { completion: 1, majorError: false, tokensIn: 0, tokensOut: 0, cost: 0, toolCalls: [], inferenceLatencyMs: 0 };

test("EndowmentPolicyV1 inverse price + floor cap", () => {
  const p = new EndowmentPolicyV1(cfg);
  assert.equal(p.initialCredits(model({ in: 0, out: 0 })), Math.round(100 / 0.05));
  assert.equal(p.initialCredits(model({ in: 0.27, out: 0.27 })), Math.round(100 / 0.27));
});

test("OddsPolicyV1 tiers + override", () => {
  const p = new OddsPolicyV1(cfg);
  assert.equal(p.odds({ ...task, difficulty: "easy", odds: 0 }), 1.5);
  assert.equal(p.odds({ ...task, difficulty: "hard", odds: 0 }), 5.0);
  assert.equal(p.odds({ ...task, difficulty: "medium", odds: 0 }), 3.0);
  assert.equal(p.odds({ ...task, odds: 7 }), 7);
});

test("SettlementPolicyV1 betting math", () => {
  const p = new SettlementPolicyV1(cfg);
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, completion: 1 }) - 200) < 1e-9);
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, completion: 0.5 }) - 0) < 1e-9);
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, completion: 0 }) - (-200)) < 1e-9);
  // majorError 恒 -stake（errorMode 钉死 stakeOnly，字段被忽略）
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, majorError: true }) - (-100)) < 1e-9);
});

test("CostModelV1 sums token+tool+inference (durations in seconds)", () => {
  const p = new CostModelV1(cfg);
  const o: Outcome = { completion: 1, majorError: false, tokensIn: 1_000_000, tokensOut: 0, cost: 0, toolCalls: [{ name: "bash", durationMs: 10000 }], inferenceLatencyMs: 5000 };
  const cost = p.usageCost(o, model({ in: 0.3, out: 0.3 }));
  // token = 0.3 ; tool = bash w1.0 * 10s * 1.0 * 1.0 = 10 ; inference = 5s * 1.0 = 5 -> total 15.3
  assert.ok(Math.abs(cost - 15.3) < 1e-9);
});

test("parseBidResponse caps and rejects", () => {
  assert.equal(parseBidResponse("150", 1000), 150);
  assert.equal(parseBidResponse("I stake 9999 credits", 1000), 1000);
  assert.equal(parseBidResponse("no idea", 1000), 0);
  assert.equal(parseBidResponse("-50", 1000), 0);
});

test("parseBidResponse boundary: empty, unparseable, zero, negative, clamp-to-balance", () => {
  // empty string → no number → 0
  assert.equal(parseBidResponse("", 1000), 0);
  // unparseable (no number) → 0
  assert.equal(parseBidResponse("I cannot bid", 1000), 0);
  // explicit zero → 0
  assert.equal(parseBidResponse("0", 1000), 0);
  // negative → 0
  assert.equal(parseBidResponse("-3.14", 1000), 0);
  // clamp to availableBalance (number exceeds balance)
  assert.equal(parseBidResponse("5000", 1000), 1000);
  // availableBalance=0 → clamp to 0
  assert.equal(parseBidResponse("50", 0), 0);
  // decimal parsing
  assert.equal(parseBidResponse("stake 42.5 credits", 1000), 42.5);
});

test("renderBidPrompt fills vars", () => {
  const s = renderBidPrompt(DEFAULT_BID_PROMPT, { prompt: "P", role: "R", difficulty: "easy", odds: 1.5, balance: 100 });
  assert.ok(s.includes("P") && s.includes("R") && s.includes("1.5") && s.includes("100"));
});
