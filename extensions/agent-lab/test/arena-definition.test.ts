import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARENA_DEFINITION,
  ARENA_DEFAULT_PARAMETERS,
  validateArenaParameters,
  type ArenaSchedulerParameters,
} from "../src/schedulers/arena-definition.ts";
import { DEFAULT_ARENA_CONFIG, mergeConfig } from "../src/config.ts";

// ── Definition shape ───────────────────────────────────────────────

test("ARENA_DEFINITION has correct id, version, kind", () => {
  assert.equal(ARENA_DEFINITION.kind, "scheduler");
  assert.equal(ARENA_DEFINITION.id, "arena");
  assert.equal(ARENA_DEFINITION.version, "1.0.0");
});

test("ARENA_DEFINITION defaultParameters maps full ArenaConfig fields", () => {
  const p = ARENA_DEFINITION.defaultParameters as ArenaSchedulerParameters;
  // endowment
  assert.equal(typeof p.endowment.K, "number");
  assert.equal(typeof p.endowment.floor, "number");
  // odds
  assert.equal(typeof p.odds.easy, "number");
  assert.equal(typeof p.odds.medium, "number");
  assert.equal(typeof p.odds.hard, "number");
  // settlement
  assert.equal(typeof p.settlement.tax, "number");
  assert.ok(p.settlement.errorMode === "stakeOnly" || p.settlement.errorMode === "stakeTimesOdds");
  // cost
  assert.equal(typeof p.cost.tokenMult, "number");
  assert.equal(typeof p.cost.toolMult, "number");
  assert.equal(typeof p.cost.latencyMult, "number");
  assert.equal(typeof p.cost.resourceFactor, "number");
  // bidding
  assert.equal(typeof p.bidding.timeoutMs, "number");
  assert.equal(typeof p.bidding.promptTemplate, "string");
  assert.equal(typeof p.bidding.maxCallsPerDispatch, "number");
  // market
  assert.equal(typeof p.market.staleTaskTimeoutMs, "number");
  assert.equal(typeof p.market.eligibility, "string");
  assert.equal(typeof p.market.maxBidders, "number");
  assert.equal(typeof p.market.bidderSelector, "string");
  // risk
  assert.equal(typeof p.risk.maxStakeRatio, "number");
});

test("ARENA_DEFINITION defaultParameters risk.maxStakeRatio default is 0.5", () => {
  const p = ARENA_DEFINITION.defaultParameters as ArenaSchedulerParameters;
  assert.equal(p.risk.maxStakeRatio, 0.5);
});

test("ARENA_DEFINITION defaultParameters bidding.maxCallsPerDispatch default equals market.maxBidders", () => {
  const p = ARENA_DEFINITION.defaultParameters as ArenaSchedulerParameters;
  assert.equal(p.bidding.maxCallsPerDispatch, p.market.maxBidders);
  assert.ok(p.bidding.maxCallsPerDispatch > 0);
});

test("ARENA_DEFINITION tunablePaths covers exactly the specified paths", () => {
  const expected = [
    "endowment.K",
    "endowment.floor",
    "odds.easy",
    "odds.medium",
    "odds.hard",
    "settlement.tax",
    "settlement.errorMode",
    "market.maxBidders",
    "market.staleTaskTimeoutMs",
    "market.eligibility",
    "market.diversityFactor",
    "bidding.timeoutMs",
    "bidding.maxCallsPerDispatch",
    "bidding.minStake",
    "bidding.engine",
    "bidding.maxConcurrentBids",
    "bidding.bidTurnBudget",
    "bidding.bidSkill",
    "risk.maxStakeRatio",
  ];
  assert.deepEqual([...ARENA_DEFINITION.tunablePaths].sort(), [...expected].sort());
  assert.equal(ARENA_DEFINITION.tunablePaths.length, expected.length,
    "tunablePaths count must match exactly — no extras or missing");
});

test("ARENA_DEFINITION has validateParameters function", () => {
  assert.equal(typeof ARENA_DEFINITION.validateParameters, "function");
});

test("ARENA_DEFINITION has validateAgentDefinition function", () => {
  assert.equal(typeof ARENA_DEFINITION.validateAgentDefinition, "function");
});

// ── ARENA_DEFAULT_PARAMETERS ───────────────────────────────────────

test("ARENA_DEFAULT_PARAMETERS derives from DEFAULT_ARENA_CONFIG", () => {
  const d = DEFAULT_ARENA_CONFIG;
  const p = ARENA_DEFAULT_PARAMETERS;
  assert.equal(p.endowment.K, d.endowment.K);
  assert.equal(p.endowment.floor, d.endowment.floor);
  assert.equal(p.odds.easy, d.odds.easy);
  assert.equal(p.odds.medium, d.odds.medium);
  assert.equal(p.odds.hard, d.odds.hard);
  assert.equal(p.settlement.tax, d.settlement.tax);
  assert.equal(p.settlement.errorMode, d.settlement.errorMode);
  assert.equal(p.cost.tokenMult, d.cost.tokenMult);
  assert.equal(p.bidding.timeoutMs, d.bidding.timeoutMs);
  assert.equal(p.bidding.promptTemplate, d.bidding.promptTemplate);
  assert.equal(p.market.maxBidders, d.market.maxBidders);
  assert.equal(p.market.eligibility, d.market.eligibility);
});

// ── validateArenaParameters: valid defaults ────────────────────────

test("validateArenaParameters accepts defaults", () => {
  const result = validateArenaParameters(ARENA_DEFAULT_PARAMETERS);
  assert.ok(result.ok);
});

test("validateArenaParameters accepts valid overrides", () => {
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    endowment: { K: 200, floor: 0.1 },
    odds: { easy: 2.0, medium: 4.0, hard: 8.0 },
    settlement: { tax: 10, errorMode: "stakeOnly" },
    market: { ...ARENA_DEFAULT_PARAMETERS.market, maxBidders: 4 },
    risk: { maxStakeRatio: 0.8 },
  };
  const result = validateArenaParameters(params);
  assert.ok(result.ok);
});

// ── validateArenaParameters: reject invalid values ─────────────────

test("validateArenaParameters rejects maxStakeRatio <= 0", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, risk: { maxStakeRatio: 0 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "risk.maxStakeRatio"));
});

test("validateArenaParameters rejects maxStakeRatio > 1", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, risk: { maxStakeRatio: 1.5 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "risk.maxStakeRatio"));
});

test("validateArenaParameters accepts maxStakeRatio = 1", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, risk: { maxStakeRatio: 1.0 } };
  const result = validateArenaParameters(params);
  assert.ok(result.ok);
});

test("validateArenaParameters accepts maxStakeRatio close to 0", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, risk: { maxStakeRatio: 0.01 } };
  const result = validateArenaParameters(params);
  assert.ok(result.ok);
});

test("validateArenaParameters rejects K <= 0", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, endowment: { ...ARENA_DEFAULT_PARAMETERS.endowment, K: 0 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "endowment.K"));
});

test("validateArenaParameters rejects floor <= 0", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, endowment: { ...ARENA_DEFAULT_PARAMETERS.endowment, floor: 0 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "endowment.floor"));
});

test("validateArenaParameters rejects odds <= 0", () => {
  for (const key of ["easy", "medium", "hard"] as const) {
    const params = { ...ARENA_DEFAULT_PARAMETERS, odds: { ...ARENA_DEFAULT_PARAMETERS.odds, [key]: 0 } };
    const result = validateArenaParameters(params);
    assert.equal(result.ok, false, `odds.${key}=0 should be rejected`);
    assert.ok(result.issues.some((i) => i.path === `odds.${key}`), `odds.${key}=0 should produce an issue`);
  }
});

test("validateArenaParameters accepts tax = 0", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 } };
  const result = validateArenaParameters(params);
  assert.ok(result.ok);
});

test("validateArenaParameters rejects negative tax", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: -1 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "settlement.tax"));
});

test("validateArenaParameters rejects invalid errorMode", () => {
  const params = {
    ...ARENA_DEFAULT_PARAMETERS,
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, errorMode: "bogus" as any },
  };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "settlement.errorMode"));
});

test("validateArenaParameters rejects maxBidders < 1", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, market: { ...ARENA_DEFAULT_PARAMETERS.market, maxBidders: 0 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "market.maxBidders"));
});

test("validateArenaParameters rejects empty eligibility string", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, market: { ...ARENA_DEFAULT_PARAMETERS.market, eligibility: "" } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "market.eligibility"));
});

test("validateArenaParameters rejects whitespace-only eligibility", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, market: { ...ARENA_DEFAULT_PARAMETERS.market, eligibility: "   " } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "market.eligibility"));
});

test("validateArenaParameters rejects null parameters", () => {
  const result = validateArenaParameters(null);
  assert.equal(result.ok, false);
});

test("validateArenaParameters rejects non-object parameters", () => {
  const result = validateArenaParameters("string");
  assert.equal(result.ok, false);
});

test("validateArenaParameters rejects bidding.timeoutMs <= 0", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, bidding: { ...ARENA_DEFAULT_PARAMETERS.bidding, timeoutMs: 0 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "bidding.timeoutMs"));
});

test("validateArenaParameters accepts valid staleTaskTimeoutMs", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS };
  const result = validateArenaParameters(params);
  assert.ok(result.ok);
});

test("validateArenaParameters rejects staleTaskTimeoutMs <= 0", () => {
  for (const v of [0, -1]) {
    const params = { ...ARENA_DEFAULT_PARAMETERS, market: { ...ARENA_DEFAULT_PARAMETERS.market, staleTaskTimeoutMs: v } };
    const result = validateArenaParameters(params);
    assert.equal(result.ok, false, `staleTaskTimeoutMs=${v} should be rejected`);
    assert.ok(result.issues.some((i) => i.path === "market.staleTaskTimeoutMs"), `staleTaskTimeoutMs=${v} should produce an issue`);
  }
});

test("validateArenaParameters rejects non-finite staleTaskTimeoutMs", () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    const params = { ...ARENA_DEFAULT_PARAMETERS, market: { ...ARENA_DEFAULT_PARAMETERS.market, staleTaskTimeoutMs: v } };
    const result = validateArenaParameters(params);
    assert.equal(result.ok, false, `staleTaskTimeoutMs=${v} should be rejected`);
    assert.ok(result.issues.some((i) => i.path === "market.staleTaskTimeoutMs"), `staleTaskTimeoutMs=${v} should produce an issue`);
  }
});

test("validateArenaParameters rejects bidding.maxCallsPerDispatch < 1", () => {
  const params = { ...ARENA_DEFAULT_PARAMETERS, bidding: { ...ARENA_DEFAULT_PARAMETERS.bidding, maxCallsPerDispatch: 0 } };
  const result = validateArenaParameters(params);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "bidding.maxCallsPerDispatch"));
});

// ── Config merge: risk.maxStakeRatio and bidding.maxCallsPerDispatch round-trip ──

test("config: risk.maxStakeRatio merges from partial ArenaConfig", () => {
  const cfg = mergeConfig({ arena: { risk: { maxStakeRatio: 0.3 } } as any });
  assert.equal(cfg.arena.risk.maxStakeRatio, 0.3);
});

test("config: bidding.maxCallsPerDispatch merges from partial ArenaConfig", () => {
  const cfg = mergeConfig({ arena: { bidding: { maxCallsPerDispatch: 4 } } as any });
  assert.equal(cfg.arena.bidding.maxCallsPerDispatch, 4);
});

test("config: default risk.maxStakeRatio is 0.5", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.arena.risk.maxStakeRatio, 0.5);
});

test("config: default bidding.maxCallsPerDispatch equals market.maxBidders", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.arena.bidding.maxCallsPerDispatch, cfg.arena.market.maxBidders);
});

// ── eligibility glob matching via modelAllowed ──────────────────────

test("eligibility: 'all' matches any model", () => {
  assert.ok(matchEligibility("all", "claude/opus-4"));
  assert.ok(matchEligibility("all", "gpt-5"));
  assert.ok(matchEligibility("all", ""));
});

test("eligibility: single glob pattern", () => {
  assert.ok(matchEligibility("claude/*", "claude/opus-4"));
  assert.ok(matchEligibility("claude/*", "claude/sonnet"));
  assert.equal(matchEligibility("claude/*", "gpt-5"), false);
});

test("eligibility: comma-separated globs", () => {
  assert.ok(matchEligibility("claude/*,gpt-5", "claude/opus-4"));
  assert.ok(matchEligibility("claude/*,gpt-5", "gpt-5"));
  assert.equal(matchEligibility("claude/*,gpt-5", "gemini/pro"), false);
});

test("eligibility: whitespace around commas", () => {
  assert.ok(matchEligibility(" claude/* , gpt-5 ", "claude/sonnet"));
  assert.ok(matchEligibility(" claude/* , gpt-5 ", "gpt-5"));
});

test("eligibility: empty string means nothing matches", () => {
  assert.equal(matchEligibility("", "claude/opus-4"), false);
});

test("eligibility: wildcard-only matches anything", () => {
  assert.ok(matchEligibility("*", "anything"));
  assert.ok(matchEligibility("*", ""));
});

test("eligibility: exact match without wildcards", () => {
  assert.ok(matchEligibility("claude/opus-4", "claude/opus-4"));
  assert.equal(matchEligibility("claude/opus-4", "claude/opus-4-2025"), false);
});

test("eligibility: case insensitive", () => {
  assert.ok(matchEligibility("Claude/*", "claude/Opus-4"));
  assert.ok(matchEligibility("GPT-5", "gpt-5"));
});

// ── validateAgentDefinition ────────────────────────────────────────

test("validateAgentDefinition requires standard and workLoop", () => {
  const result = ARENA_DEFINITION.validateAgentDefinition({});
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.path === "standard"));
  assert.ok(result.issues.some((i) => i.path === "workLoop"));
});

test("validateAgentDefinition accepts valid agent definition", () => {
  const result = ARENA_DEFINITION.validateAgentDefinition({
    standard: { name: "test", capabilities: [], executionKind: "model-candidate", labels: {} },
    workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
  });
  assert.ok(result.ok);
});

// ── validateTransition ─────────────────────────────────────────────

test("validateTransition passes valid transition", () => {
  const result = ARENA_DEFINITION.validateTransition!(
    ARENA_DEFAULT_PARAMETERS,
    { ...ARENA_DEFAULT_PARAMETERS, risk: { maxStakeRatio: 0.7 } },
  );
  assert.ok(result.ok);
});

// ── Phase 3b: new bidding fields ─────────────────────────────────

test("bidding new fields: defaults applied when absent", () => {
  const r = validateArenaParameters({
    endowment: { K: 100, floor: 0.05 },
    odds: { easy: 1.5, medium: 3, hard: 5 },
    settlement: { tax: 5, errorMode: "stakeTimesOdds" },
    cost: { tokenMult: 1, toolMult: 1, latencyMult: 1, resourceFactor: 1, toolWeights: {} },
    bidding: { timeoutMs: 10000, promptTemplate: "p", maxCallsPerDispatch: 6, minStake: 10 },
    market: { staleTaskTimeoutMs: 600000, eligibility: "all", maxBidders: 6, bidderSelector: "top-balance", diversityFactor: 0.1 },
    risk: { maxStakeRatio: 0.5 },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.bidding.engine, "model-caller");
    assert.equal(r.value.bidding.maxConcurrentBids, 3);
    assert.equal(r.value.bidding.bidTurnBudget, 3);
    assert.equal(r.value.bidding.bidSkill, "agent-lab-bidding");
  }
});

test("bidding engine: workloop accepted, invalid rejected", () => {
  const base = {
    endowment: { K: 100, floor: 0.05 },
    odds: { easy: 1.5, medium: 3, hard: 5 },
    settlement: { tax: 5, errorMode: "stakeTimesOdds" },
    cost: { tokenMult: 1, toolMult: 1, latencyMult: 1, resourceFactor: 1, toolWeights: {} },
    market: { staleTaskTimeoutMs: 600000, eligibility: "all", maxBidders: 6, bidderSelector: "top-balance", diversityFactor: 0.1 },
    risk: { maxStakeRatio: 0.5 },
  };
  const ok = validateArenaParameters({ ...base, bidding: { timeoutMs: 1, promptTemplate: "p", maxCallsPerDispatch: 1, minStake: 1, engine: "workloop", maxConcurrentBids: 2, bidTurnBudget: 4, bidSkill: "s" } });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.bidding.engine, "workloop");

  const bad = validateArenaParameters({ ...base, bidding: { timeoutMs: 1, promptTemplate: "p", maxCallsPerDispatch: 1, minStake: 1, engine: "nope" } });
  assert.equal(bad.ok, false);
});

test("ARENA_DEFAULT_PARAMETERS carries new bidding defaults", () => {
  assert.equal(ARENA_DEFAULT_PARAMETERS.bidding.engine, "model-caller");
  assert.equal(ARENA_DEFAULT_PARAMETERS.bidding.maxConcurrentBids, 3);
});

// ── Helper: import matchEligibility ────────────────────────────────

import { matchEligibility } from "../src/schedulers/arena-definition.ts";
