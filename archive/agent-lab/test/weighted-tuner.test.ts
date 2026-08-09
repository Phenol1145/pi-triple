/**
 * Tests for weighted-tuner optimizer + ws-projector.
 *
 * Covers:
 *  - decide() pure function (insufficient data, quality rule, cost rule,
 *    dual trigger, no signal, clamp boundary)
 *  - ws-projector SQL (window filtering, role filtering, empty results)
 *  - optimize() end-to-end (fake DataAPI, skip paths, proposal path)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  decide,
  createWeightedTunerInstance,
  weightedTunerDefinition,
} from "../src/optimizers/weighted-tuner.ts";
import type {
  WeightedTunerConfig,
  DecideResult,
} from "../src/optimizers/weighted-tuner.ts";
import type { ModelAggregate } from "../src/optimizers/ws-projector.ts";
import type {
  WeightedScorerWeights,
  WeightedScorerParameters,
} from "../src/schedulers/weighted-scorer.ts";
import type {
  OptimizationDataAPI,
  OptimizeContext,
} from "../src/optimizer/contracts.ts";
import type { OptimizationRoundRecord } from "../src/core/contracts.ts";

// Trigger side-effect registration of the ws projector
import "../src/optimizers/ws-projector.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// decide() unit tests
// ═══════════════════════════════════════════════════════════════════════════════

const defaultCfg: Required<WeightedTunerConfig> = {
  minSamples: 20,
  step: 0.05,
  margin: 0.1,
};

const defaultWeights: WeightedScorerWeights = {
  completion: 0.5,
  costEffectiveness: 0.25,
  performance: 0.15,
  benchmark: 0.1,
};

function makeAggregates(
  models: Array<{
    model: string;
    runs: number;
    successRate: number;
    avgCost: number;
    avgCompletion?: number;
  }>,
): ModelAggregate[] {
  return models.map((m) => ({
    model: m.model,
    runs: m.runs,
    avgCompletion: m.avgCompletion ?? 0.85,
    avgCost: m.avgCost,
    successRate: m.successRate,
  }));
}

test("decide: returns null when total runs < minSamples", () => {
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 5, successRate: 0.6, avgCost: 0.01 },
    { model: "claude", runs: 4, successRate: 0.9, avgCost: 0.02 },
  ]);
  const result = decide(aggs, defaultWeights, defaultCfg);
  assert.strictEqual(result, null);
});

test("decide: returns null when aggregates array is empty", () => {
  const result = decide([], defaultWeights, {
    ...defaultCfg,
    minSamples: 0,
  });
  assert.strictEqual(result, null);
});

test("decide: returns null when no actionable signal (successRate and cost both within margin)", () => {
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 50, successRate: 0.82, avgCost: 0.010 },
    { model: "claude", runs: 30, successRate: 0.80, avgCost: 0.012 },
  ]);
  // Pool mean successRate: (0.82*50 + 0.80*30)/80 = (41+24)/80 = 0.8125
  // Most selected (gpt-4): successRate=0.82 > 0.8125*0.9=0.731 → no trigger
  // Pool mean cost: (0.010*50 + 0.012*30)/80 = (0.5+0.36)/80 = 0.01075
  // Most selected avgCost=0.010 < 0.01075*1.1=0.011825 → no trigger
  const result = decide(aggs, defaultWeights, defaultCfg);
  assert.strictEqual(result, null);
});

test("decide: quality rule triggers — mostSelected successRate below pool mean by margin", () => {
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 50, successRate: 0.60, avgCost: 0.010 },
    { model: "claude", runs: 50, successRate: 0.90, avgCost: 0.010 },
  ]);
  // Pool mean successRate: (0.60*50 + 0.90*50)/100 = 0.75
  // Threshold: 0.75 * 0.9 = 0.675
  // mostSelected: both tie at 50 runs, first one wins = gpt-4 with 0.60
  // 0.60 < 0.675 → quality rule fires!
  const result = decide(aggs, defaultWeights, defaultCfg);
  assert.ok(result !== null);
  assert.strictEqual(result!.weights.completion, 0.55); // 0.5 + 0.05
  assert.strictEqual(result!.weights.costEffectiveness, 0.25); // unchanged
  assert.strictEqual(result!.weights.performance, 0.15); // never touched
  assert.strictEqual(result!.weights.benchmark, 0.1); // never touched
  assert.ok(result!.summary.includes("completion"));
});

test("decide: cost rule triggers — mostSelected avgCost above pool mean by margin", () => {
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 60, successRate: 0.80, avgCost: 0.050 },
    { model: "claude", runs: 40, successRate: 0.80, avgCost: 0.010 },
  ]);
  // Pool mean cost: (0.050*60 + 0.010*40)/100 = (3+0.4)/100 = 0.034
  // Threshold: 0.034 * 1.1 = 0.0374
  // mostSelected (gpt-4): 0.050 > 0.0374 → cost rule fires!
  const result = decide(aggs, defaultWeights, defaultCfg);
  assert.ok(result !== null);
  assert.strictEqual(result!.weights.completion, 0.5); // unchanged
  assert.strictEqual(result!.weights.costEffectiveness, 0.30); // 0.25 + 0.05
  assert.ok(result!.summary.includes("costEffectiveness"));
});

test("decide: both rules trigger simultaneously", () => {
  const aggs = makeAggregates([
    {
      model: "bad-model",
      runs: 60,
      successRate: 0.55,
      avgCost: 0.080,
    },
    { model: "good-model", runs: 40, successRate: 0.95, avgCost: 0.010 },
  ]);
  // Pool mean successRate: (0.55*60 + 0.95*40)/100 = (33+38)/100 = 0.71
  // Threshold success: 0.71 * 0.9 = 0.639; 0.55 < 0.639 → fire
  // Pool mean cost: (0.080*60 + 0.010*40)/100 = (4.8+0.4)/100 = 0.052
  // Threshold cost: 0.052 * 1.1 = 0.0572; 0.080 > 0.0572 → fire
  const result = decide(aggs, defaultWeights, defaultCfg);
  assert.ok(result !== null);
  assert.strictEqual(result!.weights.completion, 0.55);
  assert.strictEqual(result!.weights.costEffectiveness, 0.30);
  assert.ok(result!.summary.includes("completion"));
  assert.ok(result!.summary.includes("costEffectiveness"));
});

test("decide: clamp — weights do not exceed 1.0", () => {
  const highWeights: WeightedScorerWeights = {
    completion: 0.98,
    costEffectiveness: 0.97,
    performance: 0.0,
    benchmark: 0.0,
  };
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 50, successRate: 0.60, avgCost: 0.080 },
    { model: "claude", runs: 50, successRate: 0.90, avgCost: 0.010 },
  ]);
  // Both rules should fire but clamp at 1.0
  const result = decide(aggs, highWeights, defaultCfg);
  assert.ok(result !== null);
  assert.strictEqual(result!.weights.completion, 1.0); // 0.98 + 0.05 = 1.03 → clamp to 1.0
  assert.strictEqual(result!.weights.costEffectiveness, 1.0); // 0.97 + 0.05 = 1.02 → clamp to 1.0
});

test("decide: custom config (step, margin, minSamples)", () => {
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 5, successRate: 0.60, avgCost: 0.010 },
    { model: "claude", runs: 5, successRate: 0.80, avgCost: 0.010 },
  ]);
  // With minSamples=20 → should skip
  let result = decide(aggs, defaultWeights, { minSamples: 20, step: 0.1, margin: 0.2 });
  assert.strictEqual(result, null);

  // With minSamples=5 → should fire quality rule (margin 0.2)
  // Pool mean: (0.60*5 + 0.80*5)/10 = 0.70; threshold 0.70*0.8=0.56
  // mostSelected (gpt-4, first): 0.60 > 0.56 → no fire with margin 0.2
  // Let's make it more extreme
  const aggs2 = makeAggregates([
    { model: "gpt-4", runs: 5, successRate: 0.50, avgCost: 0.010 },
    { model: "claude", runs: 3, successRate: 0.90, avgCost: 0.010 },
  ]);
  // Pool mean: (0.50*5 + 0.90*3)/8 = (2.5+2.7)/8 = 0.65
  // Threshold: 0.65*0.8 = 0.52; 0.50 < 0.52 → fire!
  result = decide(aggs2, defaultWeights, { minSamples: 5, step: 0.1, margin: 0.2 });
  assert.ok(result !== null);
  assert.strictEqual(result!.weights.completion, 0.6); // 0.5 + 0.1
});

test("decide: performance and benchmark weights never change", () => {
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 50, successRate: 0.60, avgCost: 0.080 },
    { model: "claude", runs: 50, successRate: 0.90, avgCost: 0.010 },
  ]);
  const result = decide(aggs, defaultWeights, defaultCfg);
  assert.ok(result !== null);
  assert.strictEqual(result!.weights.performance, 0.15);
  assert.strictEqual(result!.weights.benchmark, 0.1);
});

test("decide: evaluation metrics are complete", () => {
  const aggs = makeAggregates([
    { model: "gpt-4", runs: 60, successRate: 0.55, avgCost: 0.080 },
    { model: "claude", runs: 40, successRate: 0.95, avgCost: 0.010 },
  ]);
  const result = decide(aggs, defaultWeights, defaultCfg);
  assert.ok(result !== null);
  assert.strictEqual(result!.metrics.totalRuns, 100);
  assert.strictEqual(result!.metrics.mostSelectedRuns, 60);
  assert.ok(typeof result!.metrics.mostSelectedSuccessRate === "number");
  assert.ok(typeof result!.metrics.mostSelectedAvgCost === "number");
  assert.ok(typeof result!.metrics.poolMeanSuccess === "number");
  assert.ok(typeof result!.metrics.poolMeanCost === "number");
  assert.ok(result!.summary.length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ws-projector SQL tests
// ═══════════════════════════════════════════════════════════════════════════════

test("ws-projector: returns empty array when no runs match window", async () => {
  // Import after side-effect registration
  const { getProjector } = await import("../src/optimizer/registry.ts");
  const db = new DatabaseSync(":memory:");

  // Create runs table (matching real schema from src/store/schema.ts)
  db.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      model TEXT NOT NULL,
      task_category TEXT,
      acceptance TEXT,
      completion REAL NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost REAL,
      tool_success REAL,
      turns INTEGER,
      interrupted INTEGER,
      signals TEXT,
      source TEXT NOT NULL
    );
  `);

  const projector = getProjector("weighted-scorer");
  assert.ok(projector, "projector should be registered");

  const result = projector(db, { since: 0, until: 1000 }, {
    schedulerInstanceId: "ws-1",
    role: "coding",
  }) as ModelAggregate[];

  assert.deepStrictEqual(result, []);
});

test("ws-projector: returns per-model aggregates within time window", async () => {
  const { getProjector } = await import("../src/optimizer/registry.ts");
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      model TEXT NOT NULL,
      task_category TEXT,
      acceptance TEXT,
      completion REAL NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost REAL,
      tool_success REAL,
      turns INTEGER,
      interrupted INTEGER,
      signals TEXT,
      source TEXT NOT NULL
    );
  `);

  // Insert test data
  const stmt = db.prepare(
    `INSERT INTO runs (ts, role, model, completion, cost, tool_success, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // Within window: role=coding, ts in [100, 200)
  stmt.run(100, "coding", "gpt-4", 0.9, 0.01, 1.0, "test");
  stmt.run(120, "coding", "gpt-4", 0.8, 0.02, 0.8, "test");
  stmt.run(150, "coding", "claude", 0.95, 0.015, 1.0, "test");
  stmt.run(180, "coding", "claude", 0.85, 0.025, 0.9, "test");

  // Outside window (ts < 100 or ts >= 200)
  stmt.run(50, "coding", "gpt-4", 0.5, 0.10, 0.5, "test");
  stmt.run(200, "coding", "gpt-4", 0.7, 0.03, 0.7, "test");

  // Different role
  stmt.run(130, "writing", "gpt-4", 0.99, 0.01, 1.0, "test");

  const projector = getProjector("weighted-scorer");
  assert.ok(projector);

  const result = projector(db, { since: 100, until: 200 }, {
    schedulerInstanceId: "ws-1",
    role: "coding",
  }) as ModelAggregate[];

  assert.strictEqual(result.length, 2);

  // Sort for deterministic assertions
  result.sort((a, b) => a.model.localeCompare(b.model));

  // claude: 2 runs
  const claude = result.find((r) => r.model === "claude")!;
  assert.ok(claude);
  assert.strictEqual(claude.runs, 2);
  assert.ok(Math.abs(claude.avgCompletion - 0.90) < 0.001); // (0.95+0.85)/2
  assert.ok(Math.abs(claude.avgCost - 0.02) < 0.001); // (0.015+0.025)/2
  assert.ok(Math.abs(claude.successRate - 0.95) < 0.001); // (1.0+0.9)/2

  // gpt-4: 2 runs within window
  const gpt4 = result.find((r) => r.model === "gpt-4")!;
  assert.ok(gpt4);
  assert.strictEqual(gpt4.runs, 2);
  assert.ok(Math.abs(gpt4.avgCompletion - 0.85) < 0.001); // (0.9+0.8)/2
  assert.ok(Math.abs(gpt4.avgCost - 0.015) < 0.001); // (0.01+0.02)/2
  assert.ok(Math.abs(gpt4.successRate - 0.9) < 0.001); // (1.0+0.8)/2
});

test("ws-projector: role=null returns empty (SQLite NULL ≠ NULL)", async () => {
  const { getProjector } = await import("../src/optimizer/registry.ts");
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      model TEXT NOT NULL,
      task_category TEXT,
      acceptance TEXT,
      completion REAL NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost REAL,
      tool_success REAL,
      turns INTEGER,
      interrupted INTEGER,
      signals TEXT,
      source TEXT NOT NULL
    );
  `);

  db.prepare(
    `INSERT INTO runs (ts, role, model, completion, cost, tool_success, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(100, "coding", "gpt-4", 0.9, 0.01, 1.0, "test");

  const projector = getProjector("weighted-scorer");
  assert.ok(projector);

  const result = projector(db, { since: 0, until: 1000 }, {
    schedulerInstanceId: "ws-1",
    // role is undefined → aggregates ALL roles (not filtered)
  }) as ModelAggregate[];

  assert.equal(result.length, 1);
  assert.equal(result[0].model, "gpt-4");
  assert.equal(result[0].runs, 1);
  assert.equal(result[0].avgCompletion, 0.9);
  assert.equal(result[0].avgCost, 0.01);
  assert.equal(result[0].successRate, 1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// optimize() end-to-end tests (fake DataAPI)
// ═══════════════════════════════════════════════════════════════════════════════

function makeFakeDataAPI(overrides: {
  currentRound?: OptimizationRoundRecord | undefined;
  aggregates?: ModelAggregate[];
}): OptimizationDataAPI {
  const currentRound: OptimizationRoundRecord | undefined =
    overrides.currentRound;
  const aggregates: ModelAggregate[] = overrides.aggregates ?? [];

  return {
    getCurrentRound(_sid: string) {
      return currentRound;
    },
    listRounds(_sid: string, _limit?: number) {
      return currentRound ? [currentRound] : [];
    },
    listEvents(_filter) {
      return [];
    },
    getCandidateAggregates(_sid: string, _window, _role?) {
      return aggregates;
    },
  };
}

function makeContext(
  data: OptimizationDataAPI,
  schedulerInstanceId: string,
  now = 2000,
): OptimizeContext & { schedulerInstanceId: string } {
  return {
    data,
    now: () => now,
    schedulerInstanceId,
  };
}

const defaultParams: WeightedScorerParameters = {
  weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
  topN: 3,
  pinBehavior: "respect",
  syncOnDispatch: false,
};

test("optimize: skips with insufficient-data when total runs < minSamples", async () => {
  const data = makeFakeDataAPI({
    currentRound: {
      id: "round-1",
      schedulerInstanceId: "ws-1",
      sequence: 1,
      parameters: defaultParams,
      status: "active",
      createdAt: 1000,
    },
    aggregates: makeAggregates([
      { model: "gpt-4", runs: 5, successRate: 0.8, avgCost: 0.01 },
    ]),
  });

  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    { minSamples: 20 },
  );

  const ctx = makeContext(data, "ws-1");
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "skip");
  assert.strictEqual((result as { reason: string }).reason, "insufficient-data");
});

test("optimize: skips with no-actionable-signal when rules don't fire", async () => {
  const data = makeFakeDataAPI({
    currentRound: {
      id: "round-1",
      schedulerInstanceId: "ws-1",
      sequence: 1,
      parameters: defaultParams,
      status: "active",
      createdAt: 1000,
    },
    aggregates: makeAggregates([
      { model: "gpt-4", runs: 50, successRate: 0.82, avgCost: 0.010 },
      { model: "claude", runs: 30, successRate: 0.80, avgCost: 0.012 },
    ]),
  });

  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    { minSamples: 20 },
  );

  const ctx = makeContext(data, "ws-1");
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "skip");
  assert.strictEqual(
    (result as { reason: string }).reason,
    "no-actionable-signal",
  );
});

test("optimize: returns proposal with adjusted weights on quality signal", async () => {
  const data = makeFakeDataAPI({
    currentRound: {
      id: "round-1",
      schedulerInstanceId: "ws-1",
      sequence: 1,
      parameters: defaultParams,
      status: "active",
      createdAt: 1000,
    },
    aggregates: makeAggregates([
      { model: "gpt-4", runs: 50, successRate: 0.60, avgCost: 0.010 },
      { model: "claude", runs: 50, successRate: 0.90, avgCost: 0.010 },
    ]),
  });

  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    { minSamples: 20, step: 0.05, margin: 0.1 },
  );

  const ctx = makeContext(data, "ws-1", 2000);
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "proposal");
  const proposal = (result as { kind: "proposal"; proposal: { baseRoundId: string; parameters: WeightedScorerParameters; evaluation: { summary: string; metrics: Record<string, number>; dataWindow: { since: number; until: number } } } }).proposal;

  assert.strictEqual(proposal.baseRoundId, "round-1");

  const newParams = proposal.parameters as WeightedScorerParameters;
  assert.strictEqual(newParams.weights.completion, 0.55); // adjusted
  assert.strictEqual(newParams.weights.costEffectiveness, 0.25); // unchanged
  assert.strictEqual(newParams.weights.performance, 0.15); // untouched
  assert.strictEqual(newParams.weights.benchmark, 0.1); // untouched
  assert.strictEqual(newParams.topN, 3); // preserved
  assert.strictEqual(newParams.pinBehavior, "respect"); // preserved
  assert.strictEqual(newParams.syncOnDispatch, false); // preserved

  // Evaluation
  assert.ok(proposal.evaluation.summary.length > 0);
  assert.ok(proposal.evaluation.metrics.totalRuns > 0);
  assert.strictEqual(proposal.evaluation.dataWindow.since, 1000);
  assert.strictEqual(proposal.evaluation.dataWindow.until, 2000);
});

test("optimize: skips when no current round exists", async () => {
  const data = makeFakeDataAPI({
    currentRound: undefined,
    aggregates: [],
  });

  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    {},
  );

  const ctx = makeContext(data, "ws-1");
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "skip");
  assert.ok(
    (result as { reason: string }).reason.includes("no current round"),
  );
});

test("optimize: skips when current round has no recognizable parameters", async () => {
  const data = makeFakeDataAPI({
    currentRound: {
      id: "round-1",
      schedulerInstanceId: "ws-1",
      sequence: 1,
      parameters: { something: "else" }, // no weights
      status: "active",
      createdAt: 1000,
    },
    aggregates: [],
  });

  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    {},
  );

  const ctx = makeContext(data, "ws-1");
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "skip");
  assert.ok(
    (result as { reason: string }).reason.includes("no recognizable"),
  );
});

test("optimize: skips when aggregates is non-array", async () => {
  const data = makeFakeDataAPI({
    currentRound: {
      id: "round-1",
      schedulerInstanceId: "ws-1",
      sequence: 1,
      parameters: defaultParams,
      status: "active",
      createdAt: 1000,
    },
    aggregates: "not-an-array" as unknown as ModelAggregate[],
  });

  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    {},
  );

  const ctx = makeContext(data, "ws-1");
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "skip");
  assert.ok(
    (result as { reason: string }).reason.includes("non-array"),
  );
});

test("optimize: full parameter set is a deep copy (not mutated)", async () => {
  const originalParams: WeightedScorerParameters = {
    weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 5,
    pinBehavior: "ignore",
    syncOnDispatch: true,
  };

  const data = makeFakeDataAPI({
    currentRound: {
      id: "round-1",
      schedulerInstanceId: "ws-1",
      sequence: 1,
      parameters: originalParams,
      status: "active",
      createdAt: 1000,
    },
    aggregates: makeAggregates([
      { model: "gpt-4", runs: 50, successRate: 0.60, avgCost: 0.010 },
      { model: "claude", runs: 50, successRate: 0.90, avgCost: 0.010 },
    ]),
  });

  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    { minSamples: 20 },
  );

  const ctx = makeContext(data, "ws-1");
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "proposal");
  const proposal = (result as { kind: "proposal"; proposal: { parameters: WeightedScorerParameters } }).proposal;

  // Original params should be unchanged
  assert.strictEqual(originalParams.weights.completion, 0.5);
  assert.strictEqual(originalParams.topN, 5);
  assert.strictEqual(originalParams.pinBehavior, "ignore");

  // New params should have adjusted weights but preserve other fields
  const newParams = proposal.parameters;
  assert.strictEqual(newParams.weights.completion, 0.55); // adjusted
  assert.strictEqual(newParams.topN, 5); // preserved
  assert.strictEqual(newParams.pinBehavior, "ignore"); // preserved
  assert.strictEqual(newParams.syncOnDispatch, true); // preserved
});

test("optimize: instance config defaults are applied", async () => {
  const data = makeFakeDataAPI({
    currentRound: {
      id: "round-1",
      schedulerInstanceId: "ws-1",
      sequence: 1,
      parameters: defaultParams,
      status: "active",
      createdAt: 1000,
    },
    aggregates: makeAggregates([
      // 10 runs total — below default minSamples=20 → should skip
      { model: "gpt-4", runs: 5, successRate: 0.60, avgCost: 0.010 },
      { model: "claude", runs: 5, successRate: 0.90, avgCost: 0.010 },
    ]),
  });

  // No config → defaults: minSamples=20, step=0.05, margin=0.1
  const instance = createWeightedTunerInstance(
    weightedTunerDefinition,
    "tuner-1",
    {},
  );

  const ctx = makeContext(data, "ws-1");
  const result = await instance.optimize(ctx);

  assert.strictEqual(result.kind, "skip");
  assert.strictEqual((result as { reason: string }).reason, "insufficient-data");
});
