import type { ArenaConfig, LabConfig, OptimizerConfig } from "../src/types.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig, DEFAULT_ARENA_CONFIG, DEFAULT_OPTIMIZER_CONFIG } from "../src/config.ts";

test("mergeConfig returns defaults when no partial", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.weights.completion, 0.5);
  assert.equal(cfg.autoApply, true);
  assert.equal(cfg.topN, 3);
});

test("mergeConfig deep-merges weights and keeps others", () => {
  const cfg = mergeConfig({ weights: { completion: 0.8 } as LabConfig["weights"], topN: 5 });
  assert.equal(cfg.weights.completion, 0.8);
  assert.equal(cfg.weights.costEffectiveness, 0.25);
  assert.equal(cfg.topN, 5);
});

test("default weights sum to 1", () => {
  const w = DEFAULT_CONFIG.weights;
  assert.ok(Math.abs(w.completion + w.costEffectiveness + w.performance + w.benchmark - 1) < 1e-9);
});

test("mode defaults to classic and arena defaults present", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.mode, "classic");
  assert.equal(cfg.arena.endowment.K, 100);
  assert.equal(cfg.arena.odds.hard, 5.0);
  assert.equal(cfg.arena.settlement.errorMode, "stakeTimesOdds");
});

test("arena deep-merge keeps siblings", () => {
  const cfg = mergeConfig({ arena: { endowment: { K: 200 } } as ArenaConfig });
  assert.equal(cfg.arena.endowment.K, 200);
  assert.equal(cfg.arena.endowment.floor, 0.05);
  assert.equal(cfg.arena.odds.easy, 1.5);
});

test("scheduler absent in defaults", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.scheduler, undefined);
});

test("scheduler merge keeps block", () => {
  const cfg = mergeConfig({ scheduler: { enabled: true, instanceId: "my-id" } });
  assert.deepEqual(cfg.scheduler, { enabled: true, instanceId: "my-id" });
});

test("scheduler partial merge preserves subset", () => {
  const cfg = mergeConfig({ scheduler: { enabled: true } });
  assert.deepEqual(cfg.scheduler, { enabled: true });
});

// ── optimizer ──

test("optimizer absent in defaults", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.optimizer, undefined);
});

test("optimizer merge defaults all-off when partial is empty", () => {
  const cfg = mergeConfig({ optimizer: {} });
  assert.ok(cfg.optimizer);
  assert.equal(cfg.optimizer!.shadow?.enabled, false);
  assert.equal(cfg.optimizer!.canaryPercent, 0);
  assert.equal(cfg.optimizer!.autoTrigger?.enabled, false);
  assert.equal(cfg.optimizer!.autoPromote?.enabled, false);
  assert.equal(cfg.optimizer!.autoRollback?.enabled, false);
});

test("default optimizer config shape", () => {
  assert.deepEqual(DEFAULT_OPTIMIZER_CONFIG, {
    shadow: { enabled: false },
    canaryPercent: 0,
    autoTrigger: { enabled: false },
    autoPromote: { enabled: false },
    autoRollback: { enabled: false },
  });
});

test("optimizer partial override deep-merges shadow", () => {
  const cfg = mergeConfig({ optimizer: { shadow: { enabled: true } } });
  assert.equal(cfg.optimizer!.shadow?.enabled, true);
  assert.equal(cfg.optimizer!.canaryPercent, 0); // sibling untouched
});

test("optimizer partial override sets canaryPercent", () => {
  const cfg = mergeConfig({ optimizer: { canaryPercent: 25 } });
  assert.equal(cfg.optimizer!.canaryPercent, 25);
  assert.equal(cfg.optimizer!.shadow?.enabled, false); // sibling untouched
});

test("optimizer partial override deep-merges autoTrigger", () => {
  const cfg = mergeConfig({ optimizer: { autoTrigger: { enabled: true, everyNRuns: 100 } } });
  assert.equal(cfg.optimizer!.autoTrigger?.enabled, true);
  assert.equal(cfg.optimizer!.autoTrigger?.everyNRuns, 100);
  assert.equal(cfg.optimizer!.autoTrigger?.everyTMs, undefined);
  assert.equal(cfg.optimizer!.autoPromote?.enabled, false); // sibling untouched
});

test("optimizer partial override deep-merges autoPromote", () => {
  const cfg = mergeConfig({ optimizer: { autoPromote: { enabled: true, minSamples: 50, epsilonCompletion: 0.02, epsilonCost: 0.03 } } });
  assert.equal(cfg.optimizer!.autoPromote?.enabled, true);
  assert.equal(cfg.optimizer!.autoPromote?.minSamples, 50);
  assert.equal(cfg.optimizer!.autoPromote?.epsilonCompletion, 0.02);
  assert.equal(cfg.optimizer!.autoPromote?.epsilonCost, 0.03);
  assert.equal(cfg.optimizer!.autoRollback?.enabled, false); // sibling untouched
});

test("optimizer partial override deep-merges autoRollback", () => {
  const cfg = mergeConfig({ optimizer: { autoRollback: { enabled: true, minSamples: 30, epsilonCompletion: 0.05, epsilonCost: 0.1 } } });
  assert.equal(cfg.optimizer!.autoRollback?.enabled, true);
  assert.equal(cfg.optimizer!.autoRollback?.minSamples, 30);
  assert.equal(cfg.optimizer!.autoRollback?.epsilonCompletion, 0.05);
  assert.equal(cfg.optimizer!.autoRollback?.epsilonCost, 0.1);
});

test("optimizer unknown keys are silently dropped", () => {
  const cfg = mergeConfig({ optimizer: { shadow: { enabled: true }, unknownFoo: 42 } as any });
  assert.equal(cfg.optimizer!.shadow?.enabled, true);
  // unknownFoo is not present on the typed result
  assert.equal((cfg.optimizer as any).unknownFoo, undefined);
});

test("optimizer merge does not break existing config sections", () => {
  const cfg = mergeConfig({ weights: { completion: 0.9 } as LabConfig["weights"], optimizer: { shadow: { enabled: true }, canaryPercent: 10 } });
  assert.equal(cfg.weights.completion, 0.9);
  assert.equal(cfg.weights.costEffectiveness, 0.25);
  assert.equal(cfg.arena.endowment.K, 100);
  assert.equal(cfg.optimizer!.shadow?.enabled, true);
  assert.equal(cfg.optimizer!.canaryPercent, 10);
});
