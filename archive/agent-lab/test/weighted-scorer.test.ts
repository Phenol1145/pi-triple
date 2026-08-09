import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weightedScorerDefinition,
  validateParameters,
  validateAgentDefinition,
  validateTransition,
  createWeightedScorer,
  DEFAULT_WEIGHTED_SCORER_PARAMETERS,
} from "../src/schedulers/weighted-scorer.ts";
import type {
  WeightedScorerParameters,
  WeightedScorerPorts,
} from "../src/schedulers/weighted-scorer.ts";
import type {
  SchedulerSDK,
  SchedulingInput,
  SchedulerImplementation,
} from "../src/scheduler/contracts.ts";
import type { AgentCreateSpec } from "../src/core/contracts.ts";
import type { AgentSnapshot } from "../src/scheduler/contracts.ts";
import type { ModelInfo, Aggregate } from "../src/types.ts";
import {
  recommend,
  scoreCandidates,
  minmax,
  staticProxy,
  representativeBenchmark,
} from "../src/scorer/scorer.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

// ── Fixtures ───────────────────────────────────────────────────────

function model(
  id: string,
  pricing?: { in: number; out: number },
  perf?: number,
  benchmarks?: Record<string, number>,
): ModelInfo {
  const free = pricing != null && pricing.in === 0 && pricing.out === 0;
  return {
    id,
    provider: id.includes("/") ? id.split("/")[0] : "unknown",
    name: id,
    pricing,
    perf: perf != null ? { throughputP50: perf } : undefined,
    benchmarks,
    accessRoute: free ? "free" : "direct",
  };
}

function makeSDK(overrides: Partial<{
  agents: Partial<SchedulerSDK["agents"]>;
  storage: SchedulerSDK["storage"];
  telemetry: SchedulerSDK["telemetry"];
  control: SchedulerSDK["control"];
}> = {}): SchedulerSDK {
  const telemetryEvents: Array<{ type: string; payload: unknown; metrics?: Record<string, unknown> }> = [];
  const createdAgents: AgentCreateSpec[] = [];
  const runCalls: Array<{ agentId: string; task: string; configOverrides?: Record<string, unknown> }> = [];

  const sdk: SchedulerSDK = {
    agents: {
      list: overrides.agents?.list ?? (async () => []),
      create: overrides.agents?.create ?? (async (spec: AgentCreateSpec) => {
        createdAgents.push(spec);
        return { id: spec.id };
      }),
      run: overrides.agents?.run ?? (async (agentId: string, req) => {
        runCalls.push({ agentId, task: req.task, configOverrides: req.configOverrides });
        return {
          status: "completed" as const,
          output: {
            text: "result",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 100 },
          },
        };
      }),
    },
    storage: {
      get: <T>(key: string) => undefined as { value: T; version: number } | undefined,
      put: <T>(key: string, value: T, ver: number) => ({ value, version: ver + 1 }),
    },
    telemetry: {
      emit(type: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>) {
        telemetryEvents.push({ type, payload, metrics });
      },
    },
    control: { signal: new AbortController().signal },
  };

  return sdk;
}

function makeInput(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    traceId: "trace-1",
    dispatchId: "dispatch-1",
    role: "coder",
    task: "write a function",
    mode: "select",
    ...overrides,
  };
}

function makePorts(overrides: Partial<{
  candidates: ModelInfo[];
  aggregates: Map<string, Aggregate>;
  pin: string | undefined;
}> = {}): WeightedScorerPorts {
  const candidates = overrides.candidates ?? [
    model("a/fast", { in: 1, out: 1 }, 100),
    model("b/free", { in: 0, out: 0 }, 50),
    model("c/high-bench", { in: 2, out: 2 }, 80, { mmlu: 85, humaneval: 90 }),
  ];

  return {
    candidates: () => candidates,
    aggregates: () => overrides.aggregates ?? new Map(),
    pinLookup: () => overrides.pin,
  };
}

// ── Behavior 1: validateParameters ─────────────────────────────────

test("validateParameters accepts defaults", () => {
  const result = validateParameters(DEFAULT_WEIGHTED_SCORER_PARAMETERS);
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.value.weights, DEFAULT_WEIGHTED_SCORER_PARAMETERS.weights);
    assert.equal(result.value.topN, 3);
    assert.equal(result.value.pinBehavior, "respect");
    assert.equal(result.value.syncOnDispatch, false);
  }
});

test("validateParameters rejects non-numeric weights", () => {
  const result = validateParameters({
    weights: { completion: "bad", costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const weightIssue = result.issues.find((i) => i.path === "weights.completion");
    assert.ok(weightIssue);
    assert.equal(weightIssue!.code, "INVALID_TYPE");
  }
});

test("validateParameters rejects negative weights", () => {
  const result = validateParameters({
    weights: { completion: -0.1, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const negIssue = result.issues.find((i) => i.code === "NEGATIVE_WEIGHT");
    assert.ok(negIssue);
  }
});

test("validateParameters rejects all-zero weights", () => {
  const result = validateParameters({
    weights: { completion: 0, costEffectiveness: 0, performance: 0, benchmark: 0 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const zeroIssue = result.issues.find((i) => i.code === "ALL_ZERO");
    assert.ok(zeroIssue);
  }
});

test("validateParameters rejects topN < 1", () => {
  const result = validateParameters({
    weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 0,
    pinBehavior: "respect",
    syncOnDispatch: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const topIssue = result.issues.find((i) => i.code === "TOO_SMALL");
    assert.ok(topIssue);
  }
});

test("validateParameters rejects non-integer topN", () => {
  const result = validateParameters({
    weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 2.5,
    pinBehavior: "respect",
    syncOnDispatch: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const typeIssue = result.issues.find((i) => i.path === "topN");
    assert.ok(typeIssue);
  }
});

test("validateParameters rejects unknown pinBehavior", () => {
  const result = validateParameters({
    weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 3,
    pinBehavior: "random",
    syncOnDispatch: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const pinIssue = result.issues.find((i) => i.path === "pinBehavior");
    assert.ok(pinIssue);
  }
});

test("validateParameters rejects unknown top-level keys", () => {
  const result = validateParameters({
    weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
    extraField: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const unknownIssue = result.issues.find((i) => i.code === "UNKNOWN_KEY");
    assert.ok(unknownIssue);
  }
});

// ── Behavior 2: validateTransition ─────────────────────────────────

test("validateTransition rejects all-zero weights transition", () => {
  const result = validateTransition(DEFAULT_WEIGHTED_SCORER_PARAMETERS, {
    weights: { completion: 0, costEffectiveness: 0, performance: 0, benchmark: 0 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const issue = result.issues.find((i) => i.code === "ALL_ZERO");
    assert.ok(issue);
  }
});

test("validateTransition accepts weight tuning", () => {
  const result = validateTransition(DEFAULT_WEIGHTED_SCORER_PARAMETERS, {
    weights: { completion: 0.6, costEffectiveness: 0.2, performance: 0.1, benchmark: 0.1 },
    topN: 5,
    pinBehavior: "ignore",
    syncOnDispatch: true,
  });
  assert.equal(result.ok, true);
});

// ── validateAgentDefinition ────────────────────────────────────────

test("validateAgentDefinition accepts valid agent definition", () => {
  const result = validateAgentDefinition({
    standard: { name: "test", capabilities: [], executionKind: "model-candidate", labels: {} },
    workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
    custom: {},
  });
  assert.equal(result.ok, true);
});

test("validateAgentDefinition rejects missing standard", () => {
  const result = validateAgentDefinition({
    workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
    custom: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const issue = result.issues.find((i) => i.path === "standard");
    assert.ok(issue);
  }
});

// ── Behavior 3: Cold start parity ──────────────────────────────────

test("cold start: staticProxy completion path matches legacy scoreCandidates output", async () => {
  const candidates = [
    model("a/a", { in: 1, out: 1 }),
    model("b/b", { in: 0, out: 0 }),
    model("c/c", { in: 2, out: 2 }),
  ];

  // Legacy scoring
  const legacyScored = scoreCandidates(candidates, new Map(), DEFAULT_CONFIG);
  legacyScored.sort((a, b) => b.score - a.score);
  const legacyTop = legacyScored[0].model.id;

  // New scheduler scoring
  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);
  const sdk = makeSDK();

  const input = makeInput({ mode: "select" });

  const result = await implementation.schedule(input, DEFAULT_WEIGHTED_SCORER_PARAMETERS, sdk);
  if (result.status === "completed") {
    assert.equal(result.model, legacyTop, "selected model should match legacy top pick");
  } else {
    assert.fail(`expected completed, got ${result.status}`);
  }
});

// ── Behavior 4: Warm scoring parity ────────────────────────────────

test("warm: aggregates present -> same model as legacy recommend()", async () => {
  const candidates = [
    model("x/m1", { in: 0.5, out: 0.5 }),
    model("x/m2", { in: 0.5, out: 0.5 }),
    model("x/m3", { in: 0.5, out: 0.5 }),
  ];

  const aggs = new Map<string, Aggregate>([
    ["x/m1", { model: "x/m1", role: "coder", runs: 5, avgCompletion: 0.95, avgCost: 0.5, successRate: 1 }],
    ["x/m2", { model: "x/m2", role: "coder", runs: 3, avgCompletion: 0.60, avgCost: 0.3, successRate: 0.8 }],
  ]);

  // Legacy: m1 should win due to high completion
  const legacyTop = recommend(candidates, aggs, DEFAULT_CONFIG, 1);
  assert.equal(legacyTop[0].model.id, "x/m1");

  // New scheduler
  const ports = makePorts({ candidates, aggregates: aggs });
  const { implementation } = createWeightedScorer(ports);
  const sdk = makeSDK();

  const result = await implementation.schedule(
    makeInput({ role: "coder", mode: "select" }),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.model, "x/m1", "warm selection should match legacy");
  }
});

// ── Behavior 5: Pin respect ────────────────────────────────────────

test("pin respect: pinned model present in candidates -> selected regardless of score", async () => {
  const candidates = [
    model("x/high-score", { in: 0, out: 0 }, 1000),
    model("x/low-score", { in: 10, out: 10 }, 10),
  ];

  const aggs = new Map<string, Aggregate>([
    ["x/high-score", { model: "x/high-score", role: "coder", runs: 10, avgCompletion: 0.99, avgCost: 0, successRate: 1 }],
  ]);

  // Legacy recommendation without pin would pick high-score
  const legacyNoPin = recommend(candidates, aggs, DEFAULT_CONFIG, 1);
  assert.equal(legacyNoPin[0].model.id, "x/high-score");

  // With pin, low-score should be selected
  const ports = makePorts({
    candidates,
    aggregates: aggs,
    pin: "x/low-score",
  });
  const { implementation } = createWeightedScorer(ports);
  const sdk = makeSDK();

  const result = await implementation.schedule(
    makeInput({ role: "coder", mode: "select" }),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.model, "x/low-score", "pin should override score order");
    assert.ok(result.reason?.includes("pinned"), "reason should mention pin");
  }
});

// ── Behavior 6: Pin to absent model ────────────────────────────────

test("pin to model absent from candidates: completed with model, no selectedAgentId", async () => {
  const candidates = [
    model("x/available", { in: 0, out: 0 }),
  ];

  const ports = makePorts({
    candidates,
    pin: "x/absent-model",
  });
  const { implementation } = createWeightedScorer(ports);
  const sdk = makeSDK();

  const result = await implementation.schedule(
    makeInput({ role: "coder", mode: "select" }),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.model, "x/absent-model");
    assert.equal(result.selectedAgentId, undefined);
  }
});

// ── Behavior 7: Empty candidate list -> abstain ────────────────────

test("empty candidates: abstained (not failed)", async () => {
  const ports = makePorts({ candidates: [] });
  const { implementation } = createWeightedScorer(ports);
  const sdk = makeSDK();

  const result = await implementation.schedule(
    makeInput(),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "abstained");
  if (result.status === "abstained") {
    assert.ok(result.reason.includes("no candidates"));
  }
});

// ── Behavior 8: syncOnDispatch ─────────────────────────────────────

test("syncOnDispatch=true: creates agent for missing model", async () => {
  const candidates = [model("x/new-model", { in: 0, out: 0 })];

  const existingAgents: AgentSnapshot[] = [];
  let createdSpec: AgentCreateSpec | undefined;

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);

  const sdk = makeSDK({
    agents: {
      list: async () => existingAgents,
      create: async (spec: AgentCreateSpec) => {
        createdSpec = spec;
        existingAgents.push({
          id: spec.id,
          definition: spec.definition,
          status: "ready",
        });
        return { id: spec.id };
      },
      run: async () => ({
        status: "completed" as const,
        output: { text: "ok" },
      }),
    },
  });

  await implementation.schedule(
    makeInput({ mode: "select" }),
    { ...DEFAULT_WEIGHTED_SCORER_PARAMETERS, syncOnDispatch: true },
    sdk,
  );

  assert.ok(createdSpec, "agent should have been created");
  assert.equal(createdSpec!.definition.standard.name, "x/new-model", "agent definition should reference model");
  assert.equal(createdSpec!.definition.workLoop.id, "pi-default-loop");
  assert.equal(createdSpec!.definition.workLoop.version, "1.0.0");
});

test("syncOnDispatch=false: does NOT create agents", async () => {
  const candidates = [model("x/new-model", { in: 0, out: 0 })];

  let createCalled = false;

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);

  const sdk = makeSDK({
    agents: {
      list: async () => [],
      create: async () => { createCalled = true; return { id: "x" }; },
      run: async () => ({ status: "completed" as const }),
    },
  });

  await implementation.schedule(
    makeInput({ mode: "select" }),
    { ...DEFAULT_WEIGHTED_SCORER_PARAMETERS, syncOnDispatch: false },
    sdk,
  );

  assert.equal(createCalled, false, "syncOnDispatch=false should not create agents");
});

test("syncOnDispatch=true: does not duplicate existing agents", async () => {
  const candidates = [model("x/existing", { in: 0, out: 0 })];

  let createCallCount = 0;
  const existingAgents: AgentSnapshot[] = [
    {
      id: "agent-x-existing",
      definition: {
        standard: { name: "x/existing", capabilities: [], executionKind: "model-candidate", labels: { provider: "x" } },
        workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
        custom: {},
      },
      status: "ready",
    },
  ];

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);

  const sdk = makeSDK({
    agents: {
      list: async () => existingAgents,
      create: async () => { createCallCount++; return { id: "x" }; },
      run: async () => ({ status: "completed" as const }),
    },
  });

  await implementation.schedule(
    makeInput({ mode: "select" }),
    { ...DEFAULT_WEIGHTED_SCORER_PARAMETERS, syncOnDispatch: true },
    sdk,
  );

  assert.equal(createCallCount, 0, "should not duplicate existing agent");
});

// ── Behavior 9: Execute mode ───────────────────────────────────────

test("execute mode: sdk.agents.run called for selected agent", async () => {
  const candidates = [model("x/runner", { in: 0, out: 0 })];

  let runAgentId: string | undefined;
  let runTask: string | undefined;
  let runConfigOverrides: Record<string, unknown> | undefined;

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);

  const sdk = makeSDK({
    agents: {
      list: async () => [],
      run: async (agentId, req) => {
        runAgentId = agentId;
        runTask = req.task;
        runConfigOverrides = req.configOverrides;
        return {
          status: "completed" as const,
          output: { text: "hello", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 10 } },
        };
      },
    },
  });

  const result = await implementation.schedule(
    makeInput({ role: "coder", task: "do the thing", mode: "execute" }),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.ok(runAgentId);
    assert.equal(runTask, "do the thing");
    assert.ok(runConfigOverrides);
    assert.equal(runConfigOverrides!.agent, "coder", "config overrides should include agent role");
    assert.ok(result.output);
  }
});

test("execute mode: run failure -> failed with retryable", async () => {
  const candidates = [model("x/failer", { in: 0, out: 0 })];

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);

  const sdk = makeSDK({
    agents: {
      list: async () => [],
      run: async () => {
        throw { code: "BOOM", message: "failed" };
      },
    },
  });

  const result = await implementation.schedule(
    makeInput({ mode: "execute" }),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "BOOM");
    assert.equal(result.error.retryable, true);
  }
});

// ── Behavior 10: Select mode ───────────────────────────────────────

test("select mode: sdk.agents.run NEVER called", async () => {
  const candidates = [model("x/selector", { in: 0, out: 0 })];

  let runCalled = false;

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);

  const sdk = makeSDK({
    agents: {
      list: async () => [],
      run: async () => { runCalled = true; return { status: "completed" as const }; },
    },
  });

  const result = await implementation.schedule(
    makeInput({ mode: "select" }),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  assert.equal(runCalled, false, "agents.run must not be called in select mode");
});

// ── Behavior 11: Telemetry ─────────────────────────────────────────

test("telemetry: emits scheduler.weighted_scorer.score metrics", async () => {
  const candidates = [
    model("x/a", { in: 0, out: 0 }),
    model("x/b", { in: 1, out: 1 }),
  ];

  let capturedType: string | undefined;
  let capturedMetrics: Record<string, unknown> | undefined;

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);

  const sdk = makeSDK();
  sdk.telemetry.emit = (type, payload, metrics) => {
    capturedType = type;
    capturedMetrics = metrics as Record<string, unknown>;
  };

  await implementation.schedule(
    makeInput({ mode: "select" }),
    DEFAULT_WEIGHTED_SCORER_PARAMETERS,
    sdk,
  );

  assert.equal(capturedType, "scheduler.weighted_scorer.score");
  assert.ok(capturedMetrics);
  assert.ok(typeof capturedMetrics!["scheduler.weighted_scorer.top_score"] === "number");
  assert.equal(capturedMetrics!["scheduler.weighted_scorer.candidate_count"], 2);
});

// ── Behavior 12: Legacy parity ─────────────────────────────────────

test("parity: new selection == legacy (recommend + pin logic) for fixture matrix", async () => {
  // Test multiple scenarios: cold/warm/pinned/free-only/single-candidate/all-equal-scores

  interface ParityCase {
    name: string;
    candidates: ModelInfo[];
    aggs: Map<string, Aggregate>;
    pin?: string;
    role: string;
  }

  const baseModels = [
    model("p/fast", { in: 1, out: 1 }, 100),
    model("p/free", { in: 0, out: 0 }, 50),
    model("p/good-bench", { in: 2, out: 2 }, 80, { mmlu: 90, humaneval: 85 }),
    model("p/bad", { in: 5, out: 5 }, 10),
  ];

  const cases: ParityCase[] = [
    {
      name: "cold-start",
      candidates: [...baseModels],
      aggs: new Map(),
      role: "coder",
    },
    {
      name: "warm",
      candidates: [...baseModels],
      aggs: new Map([
        ["p/fast", { model: "p/fast", role: "coder", runs: 10, avgCompletion: 0.9, avgCost: 1.0, successRate: 0.9 }],
        ["p/free", { model: "p/free", role: "coder", runs: 5, avgCompletion: 0.7, avgCost: 0, successRate: 0.8 }],
      ]),
      role: "coder",
    },
    {
      name: "pinned",
      candidates: [...baseModels],
      aggs: new Map(),
      pin: "p/bad",
      role: "coder",
    },
    {
      name: "free-only",
      candidates: [
        model("p/free1", { in: 0, out: 0 }, 30),
        model("p/free2", { in: 0, out: 0 }, 60),
      ],
      aggs: new Map(),
      role: "coder",
    },
    {
      name: "single-candidate",
      candidates: [model("p/only", { in: 1, out: 1 }, 50)],
      aggs: new Map(),
      role: "coder",
    },
    {
      name: "all-equal-scores",
      candidates: [
        model("p/same1", { in: 1, out: 1 }, 50, { mmlu: 50 }),
        model("p/same2", { in: 1, out: 1 }, 50, { mmlu: 50 }),
      ],
      aggs: new Map(),
      role: "coder",
    },
  ];

  for (const c of cases) {
    // Legacy reference: recommend + pin logic (comparing new scheduler against prior behavior)
    const legacyAg = new Map(c.aggs);
    const legacyRecs = recommend(c.candidates, legacyAg, DEFAULT_CONFIG, DEFAULT_CONFIG.topN);

    let legacyModel: string | undefined;
    if (c.pin) {
      // Pin takes priority (exact match in candidates is checked by modelAllowed)
      const pinned = c.candidates.find((m) => m.id === c.pin);
      if (pinned) {
        legacyModel = c.pin;
      }
    }
    if (!legacyModel && legacyRecs.length > 0) {
      legacyModel = legacyRecs[0].model.id;
    }

    if (!legacyModel) continue; // skip if no legacy selection

    // New: scheduler
    const ports = makePorts({
      candidates: c.candidates,
      aggregates: c.aggs,
      pin: c.pin,
    });
    const { implementation } = createWeightedScorer(ports);
    const sdk = makeSDK();

    const result = await implementation.schedule(
      makeInput({ role: c.role, mode: "select" }),
      DEFAULT_WEIGHTED_SCORER_PARAMETERS,
      sdk,
    );

    if (result.status === "completed") {
      assert.equal(
        result.model,
        legacyModel,
        `[${c.name}] new model "${result.model}" should match legacy "${legacyModel}"`,
      );
    } else if (result.status === "abstained") {
      assert.fail(`[${c.name}] got abstained but legacy had model "${legacyModel}"`);
    }
  }
});

// ── Definition shape tests ─────────────────────────────────────────

test("weightedScorerDefinition has correct metadata", () => {
  assert.equal(weightedScorerDefinition.kind, "scheduler");
  assert.equal(weightedScorerDefinition.id, "weighted-scorer");
  assert.equal(weightedScorerDefinition.version, "1.0.0");
  assert.equal(weightedScorerDefinition.parameterModelVersion, "1.0.0");
  assert.equal(weightedScorerDefinition.agentDefinitionSchemaVersion, "1.0.0");
});

test("weightedScorerDefinition tunablePaths match plan", () => {
  assert.deepEqual(weightedScorerDefinition.tunablePaths, [
    "weights.completion",
    "weights.costEffectiveness",
    "weights.performance",
    "weights.benchmark",
    "topN",
    "pinBehavior",
    "syncOnDispatch",
  ]);
});

test("weightedScorerDefinition defaultParameters mirror LabConfig defaults", () => {
  const def = weightedScorerDefinition.defaultParameters as WeightedScorerParameters;
  assert.equal(def.weights.completion, DEFAULT_CONFIG.weights.completion);
  assert.equal(def.weights.costEffectiveness, DEFAULT_CONFIG.weights.costEffectiveness);
  assert.equal(def.weights.performance, DEFAULT_CONFIG.weights.performance);
  assert.equal(def.weights.benchmark, DEFAULT_CONFIG.weights.benchmark);
  assert.equal(def.topN, DEFAULT_CONFIG.topN);
  assert.equal(def.pinBehavior, "respect");
  assert.equal(def.syncOnDispatch, false);
});

// ── Pin ignore behavior ────────────────────────────────────────────

test("pinBehavior=ignore: pin is ignored, score order used", async () => {
  const candidates = [
    model("x/high-score", { in: 0, out: 0 }, 1000, { mmlu: 95 }),
    model("x/pinned-but-ignored", { in: 10, out: 10 }, 10),
  ];

  const ports = makePorts({
    candidates,
    pin: "x/pinned-but-ignored",
  });
  const { implementation } = createWeightedScorer(ports);
  const sdk = makeSDK();

  const result = await implementation.schedule(
    makeInput({ role: "coder", mode: "select" }),
    { ...DEFAULT_WEIGHTED_SCORER_PARAMETERS, pinBehavior: "ignore" },
    sdk,
  );

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.model, "x/high-score", "ignore pin should use score order");
  }
});

// ── AgentDefinition mapping ────────────────────────────────────────

test("candidate->AgentDefinition mapping: custom = { model } snapshot", async () => {
  const candidates = [model("z/test-model", { in: 0, out: 0 }, 100, { mmlu: 80 })];
  let createdDef: unknown;

  const ports = makePorts({ candidates });
  const { implementation } = createWeightedScorer(ports);
  const sdk = makeSDK({
    agents: {
      list: async () => [],
      create: async (spec) => {
        createdDef = spec.definition;
        return { id: spec.id };
      },
      run: async () => ({ status: "completed" as const }),
    },
  });

  await implementation.schedule(
    makeInput({ mode: "select" }),
    { ...DEFAULT_WEIGHTED_SCORER_PARAMETERS, syncOnDispatch: true },
    sdk,
  );

  const def = createdDef as {
    standard: Record<string, unknown>;
    workLoop: Record<string, unknown>;
    custom: unknown;
  };

  assert.ok(def);
  assert.equal(def.standard.executionKind, "model-candidate");
  assert.equal(def.standard.name, "z/test-model");
  assert.equal(def.workLoop.id, "pi-default-loop");
  assert.equal(def.workLoop.version, "1.0.0");

  const wlConfig = def.workLoop.config as Record<string, unknown>;
  assert.equal(wlConfig.model, "z/test-model");
  assert.equal(wlConfig.contextMode, "fresh");

  const custom = def.custom as { model: ModelInfo };
  assert.ok(custom.model);
  assert.equal(custom.model.id, "z/test-model");
});
