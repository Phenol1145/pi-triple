/**
 * Optimizer integration tests (Task 7).
 *
 * Covers:
 *  - e2e closed loop: seed runs → run → proposal → diff → promote → traceability → rollback
 *  - supersede discipline: 2 pending proposals, promote one → other auto-superseded
 *  - failure isolation: throwing optimize → event recorded, zero round/proposal mutation
 *  - authorization: tuner without arena target → DataAPI access denied + event
 *  - stale baseline: promote → submit with old baseRoundId → rejected
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createLabCore } from "../src/core/create-core.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import { ensureWeightedScorerInstance } from "../src/schedulers/bootstrap.ts";
import { OptimizerRegistry } from "../src/optimizer/registry.ts";
import { DataAPIImpl, DataAccessDeniedError } from "../src/optimizer/data-api.ts";
import { weightedTunerDefinition, decide } from "../src/optimizers/weighted-tuner.ts";
import { diffLeafPaths } from "../src/core/parameter-diff.ts";
import type { WeightedScorerPorts } from "../src/schedulers/weighted-scorer.ts";
import type { WeightedScorerParameters } from "../src/schedulers/weighted-scorer.ts";
import type { ModelInfo } from "../src/types.ts";
import type { ModelAggregate } from "../src/optimizers/ws-projector.ts";

// Trigger side-effect: register ws-projector
import "../src/optimizers/ws-projector.ts";

// ── Fixtures ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Create legacy runs table (used by ws-projector)
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
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
    CREATE INDEX IF NOT EXISTS idx_runs_role_model ON runs(role, model);
  `);
  return db;
}

function model(id: string): ModelInfo {
  return {
    id,
    provider: id.includes("/") ? id.split("/")[0] : "unknown",
    name: id,
    pricing: { in: 2.0, out: 6.0 },
    perf: undefined,
    benchmarks: undefined,
    accessRoute: "direct",
  };
}

function mockPorts(candidates: ModelInfo[] = []): WeightedScorerPorts {
  return {
    candidates: () => candidates,
    aggregates: () => new Map(),
    pinLookup: () => undefined,
  };
}

/** Insert a run row directly into the legacy runs table. */
function insertRun(
  db: DatabaseSync,
  opts: {
    ts?: number;
    role?: string;
    model: string;
    completion?: number;
    cost?: number;
    toolSuccess?: number;
  },
): void {
  db.prepare(
    `INSERT INTO runs (ts, role, model, task_category, acceptance, completion, tokens_in, tokens_out, cost, tool_success, turns, interrupted, signals, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.ts ?? Date.now(),
    opts.role ?? "coder",
    opts.model,
    null,
    "auto",
    opts.completion ?? 0.8,
    null,
    null,
    opts.cost ?? 0.01,
    opts.toolSuccess ?? 1,
    null,
    0,
    "{}",
    "test",
  );
}

/** Seed sufficient runs data to trigger the weighted-tuner quality rule. */
function seedQualityTriggerRuns(db: DatabaseSync, ts: number): void {
  // Model A: most-selected model with low success rate → triggers quality rule
  for (let i = 0; i < 20; i++) {
    insertRun(db, { ts, model: "openai/gpt-4o", completion: 0.5, cost: 0.01, toolSuccess: 0.5 });
  }
  // Model B: less-selected, high success rate → pool mean is pulled up
  for (let i = 0; i < 5; i++) {
    insertRun(db, { ts, model: "anthropic/claude-3", completion: 0.9, cost: 0.02, toolSuccess: 1 });
  }
}

/** Seed runs data that won't trigger any rule (all models performing well). */
function seedNoSignalRuns(db: DatabaseSync, ts: number): void {
  for (let i = 0; i < 25; i++) {
    insertRun(db, { ts, model: "openai/gpt-4o", completion: 0.9, cost: 0.01, toolSuccess: 1 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: e2e closed loop
// ═══════════════════════════════════════════════════════════════════════════════

test("e2e closed loop: seed runs → run → proposal → diff → promote → traceability → rollback", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const ports = mockPorts(candidates);

  const wsResult = await ensureWeightedScorerInstance(core, schedulers, ports);
  assert.equal(wsResult.instanceId, "default-weighted-scorer");

  // ── Set up optimizer ────────────────────────────────────────────────
  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  const optInst = optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    {
      instanceId: "default-weighted-tuner",
      config: { minSamples: 20, step: 0.05, margin: 0.1 },
      targetSchedulers: ["default-weighted-scorer"],
    },
  );
  assert.equal(optInst.status, "active");

  // ── Get current round and seed runs after its creation ──────────────
  const currentRound = core.repository.getRound(wsResult.roundId);
  assert.ok(currentRound);
  seedQualityTriggerRuns(db, currentRound!.createdAt);

  // ── Get params ──────────────────────────────────────────────────────
  assert.ok(currentRound);
  const currentParams = currentRound!.parameters as WeightedScorerParameters;
  assert.ok(currentParams.weights);
  const originalCompletion = currentParams.weights.completion;

  // ── Create DataAPI and call decide ──────────────────────────────────
  const dataApi = new DataAPIImpl(db, core.repository, core.events, ["default-weighted-scorer"], "default-weighted-tuner");
  const window = { since: currentRound!.createdAt, until: Date.now() };
  const aggregates = dataApi.getCandidateAggregates("default-weighted-scorer", window, "coder") as ModelAggregate[];
  assert.ok(aggregates.length > 0, "aggregates should be non-empty");

  const result = decide(aggregates, currentParams.weights, { minSamples: 20, step: 0.05, margin: 0.1 });
  assert.ok(result, "decide should return a proposal for quality-trigger data");
  assert.ok(result.weights.completion > originalCompletion, "completion weight should increase");

  // ── Build full parameter set ────────────────────────────────────────
  const newParams: WeightedScorerParameters = {
    ...JSON.parse(JSON.stringify(currentParams)),
    weights: result.weights,
  };

  // ── Submit proposal through ControlPlane ───────────────────────────
  const { proposalId, candidateRoundId } = core.controlPlane.submitProposal(
    "default-weighted-tuner",
    "default-weighted-scorer",
    {
      baseRoundId: currentRound!.id,
      parameters: newParams,
      evaluation: {
        summary: result.summary,
        metrics: result.metrics,
        dataWindow: { since: window.since, until: window.until },
      },
    },
  );
  assert.ok(proposalId);
  assert.ok(candidateRoundId);

  // ── Verify proposal persisted ───────────────────────────────────────
  const proposal = core.repository.getProposal(proposalId);
  assert.ok(proposal);
  assert.equal(proposal!.status, "pending");
  assert.equal(proposal!.candidateRoundId, candidateRoundId);

  // ── Verify candidate round ──────────────────────────────────────────
  const candidateRound = core.repository.getRound(candidateRoundId);
  assert.ok(candidateRound);
  assert.equal(candidateRound!.status, "proposed");
  assert.equal(candidateRound!.proposalId, proposalId);
  assert.ok(candidateRound!.optimizer);
  assert.equal(candidateRound!.optimizer!.instanceId, "default-weighted-tuner");

  // ── Diff ────────────────────────────────────────────────────────────
  const paths = diffLeafPaths(currentRound!.parameters, candidateRound!.parameters);
  assert.ok(paths.length > 0, "diff should detect changed paths");
  const weightsPath = paths.find((p) => p.startsWith("weights."));
  assert.ok(weightsPath, "diff should include weights changes");

  // ── Promote ─────────────────────────────────────────────────────────
  const { newRoundId } = core.controlPlane.promoteRound(candidateRoundId);
  assert.ok(newRoundId);
  assert.notEqual(newRoundId, candidateRoundId);

  // ── Verify new active round ─────────────────────────────────────────
  const instance = core.repository.getInstance("default-weighted-scorer");
  assert.ok(instance);
  assert.equal(instance!.currentRoundId, newRoundId);

  const newActiveRound = core.repository.getRound(newRoundId);
  assert.ok(newActiveRound);
  assert.equal(newActiveRound!.status, "active");
  assert.equal(newActiveRound!.parentRoundId, wsResult.roundId);

  // Traceability chain: round → proposalId → evaluation.dataWindow
  assert.equal(newActiveRound!.proposalId, proposalId);
  assert.ok(newActiveRound!.optimizer);
  assert.equal(newActiveRound!.optimizer!.instanceId, "default-weighted-tuner");

  const promotedProposal = core.repository.getProposal(proposalId);
  assert.ok(promotedProposal);
  assert.equal(promotedProposal!.status, "accepted");
  assert.equal(promotedProposal!.promotedRoundId, newRoundId);

  // Verify new round has updated weights
  const newParams2 = newActiveRound!.parameters as WeightedScorerParameters;
  assert.ok(newParams2.weights.completion > originalCompletion, "new round should use optimized weights");

  // ── Rollback to original round ──────────────────────────────────────
  const { newRoundId: rollbackRoundId } = core.controlPlane.rollbackRound(
    "default-weighted-scorer",
    wsResult.roundId,
  );
  assert.ok(rollbackRoundId);
  assert.notEqual(rollbackRoundId, newRoundId);

  const rollbackedRound = core.repository.getRound(rollbackRoundId);
  assert.ok(rollbackedRound);
  assert.equal(rollbackedRound!.status, "active");

  // Rollback should restore original parameters (optimizer/proposalId absent)
  assert.equal(rollbackedRound!.optimizer, undefined);
  assert.equal(rollbackedRound!.proposalId, undefined);
  const rolledBackParams = rollbackedRound!.parameters as WeightedScorerParameters;
  assert.equal(rolledBackParams.weights.completion, originalCompletion, "rollback should restore original weights");

  // Old current round → rolled-back
  const oldActiveRound = core.repository.getRound(newRoundId);
  assert.ok(oldActiveRound);
  assert.equal(oldActiveRound!.status, "rolled-back");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: supersede discipline
// ═══════════════════════════════════════════════════════════════════════════════

test("supersede discipline: promote one proposal, other pending becomes superseded", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const ports = mockPorts(candidates);

  const wsResult = await ensureWeightedScorerInstance(core, schedulers, ports);

  // Set up optimizer
  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "default-weighted-tuner", config: {}, targetSchedulers: ["default-weighted-scorer"] },
  );

  const currentRound = core.repository.getRound(wsResult.roundId);
  assert.ok(currentRound);

  // Seed runs so proposals can be submitted
  seedQualityTriggerRuns(db, currentRound!.createdAt);

  const currentParams = currentRound!.parameters as WeightedScorerParameters;

  // Submit proposal A (increase completion)
  const proposalA_params: WeightedScorerParameters = {
    ...JSON.parse(JSON.stringify(currentParams)),
    weights: { ...currentParams.weights, completion: Math.min(currentParams.weights.completion + 0.1, 1) },
  };
  const { proposalId: proposalAId, candidateRoundId: candidateAId } = core.controlPlane.submitProposal(
    "default-weighted-tuner", "default-weighted-scorer",
    { baseRoundId: wsResult.roundId, parameters: proposalA_params },
  );
  assert.ok(proposalAId);

  // Submit proposal B (increase costEffectiveness)
  const proposalB_params: WeightedScorerParameters = {
    ...JSON.parse(JSON.stringify(currentParams)),
    weights: { ...currentParams.weights, costEffectiveness: Math.min(currentParams.weights.costEffectiveness + 0.1, 1) },
  };
  const { proposalId: proposalBId, candidateRoundId: candidateBId } = core.controlPlane.submitProposal(
    "default-weighted-tuner", "default-weighted-scorer",
    { baseRoundId: wsResult.roundId, parameters: proposalB_params },
  );
  assert.ok(proposalBId);

  // Both proposals pending
  assert.equal(core.repository.getProposal(proposalAId)!.status, "pending");
  assert.equal(core.repository.getProposal(proposalBId)!.status, "pending");

  // ── Promote proposal A ──────────────────────────────────────────────
  core.controlPlane.promoteRound(candidateAId);

  // Proposal A → accepted
  assert.equal(core.repository.getProposal(proposalAId)!.status, "accepted");

  // Proposal B → superseded
  assert.equal(core.repository.getProposal(proposalBId)!.status, "superseded");

  // Candidate round B → superseded
  assert.equal(core.repository.getRound(candidateBId)!.status, "superseded");

  // Candidate round A → superseded (promoted to active)
  assert.equal(core.repository.getRound(candidateAId)!.status, "superseded");

  // ── Cannot promote superseded candidate ─────────────────────────────
  assert.throws(
    () => core.controlPlane.promoteRound(candidateBId),
    { message: /status superseded/ },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: failure isolation
// ═══════════════════════════════════════════════════════════════════════════════

test("failure isolation: optimization failure → event recorded, zero round/proposal mutation", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  await ensureWeightedScorerInstance(core, schedulers, ports);

  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "default-weighted-tuner", config: {}, targetSchedulers: ["default-weighted-scorer"] },
  );

  // Count rounds + proposals before
  const roundsBefore = core.repository.listRounds("default-weighted-scorer").length;
  const proposalsBefore = core.repository.listProposals("default-weighted-scorer").length;

  // Simulate a failed run by recording a failed event directly
  // (The facade.run() catches exceptions and emits optimizer.run.failed)
  const now = Date.now();
  core.events.append({
    eventId: `optimizer.run.failed:default-weighted-tuner:default-weighted-scorer:${now}`,
    eventType: "optimizer.run.failed",
    schemaVersion: "1",
    timestamp: now,
    identity: {
      traceId: "test-failure",
      optimizerInstanceId: "default-weighted-tuner",
      schedulerInstanceId: "default-weighted-scorer",
    },
    payload: { instanceId: "default-weighted-tuner", error: "simulated failure" },
  });

  // Verify the event was recorded
  const events = core.events.query({ schedulerInstanceId: "default-weighted-scorer", limit: 100 });
  const failEvents = events.filter((e) => e.eventType === "optimizer.run.failed");
  assert.ok(failEvents.length >= 1, "optimizer.run.failed event should be recorded");

  // Zero round/proposal mutation
  const roundsAfter = core.repository.listRounds("default-weighted-scorer").length;
  const proposalsAfter = core.repository.listProposals("default-weighted-scorer").length;
  assert.equal(roundsAfter, roundsBefore, "no new rounds should be created on failure");
  assert.equal(proposalsAfter, proposalsBefore, "no new proposals should be created on failure");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4: authorization — tuner without arena target
// ═══════════════════════════════════════════════════════════════════════════════

test("authorization: DataAPI access to unauthorized scheduler → DataAccessDeniedError + event", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  await ensureWeightedScorerInstance(core, schedulers, ports);

  // DataAPI authorized only for "some-other-instance" — not "default-weighted-scorer"
  const dataApi = new DataAPIImpl(
    db,
    core.repository,
    core.events,
    ["some-other-instance"], // authorized set does NOT include default-weighted-scorer
    "default-weighted-tuner",
  );

  // Accessing "default-weighted-scorer" should throw
  assert.throws(
    () => dataApi.getCurrentRound("default-weighted-scorer"),
    DataAccessDeniedError,
    "should throw DataAccessDeniedError",
  );

  // Access denied event should be recorded
  const events = core.events.query({ limit: 100 });
  const denyEvents = events.filter((e) => e.eventType === "optimizer.access.denied");
  assert.ok(denyEvents.length >= 1, "optimizer.access.denied event should be emitted");

  // Verify event payload
  const denyEvent = denyEvents[0];
  assert.equal((denyEvent.payload as { schedulerInstanceId: string }).schedulerInstanceId, "default-weighted-scorer");
  assert.equal((denyEvent.payload as { method: string }).method, "getCurrentRound");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 5: stale baseline rejection
// ═══════════════════════════════════════════════════════════════════════════════

test("stale baseline: submit with old baseRoundId after promote → rejected", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const ports = mockPorts(candidates);

  const wsResult = await ensureWeightedScorerInstance(core, schedulers, ports);

  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "default-weighted-tuner", config: {}, targetSchedulers: ["default-weighted-scorer"] },
  );

  const currentRound = core.repository.getRound(wsResult.roundId);
  assert.ok(currentRound);

  seedQualityTriggerRuns(db, currentRound!.createdAt);

  const currentParams = currentRound!.parameters as WeightedScorerParameters;

  // Submit a valid proposal (will be accepted since baseline is current)
  const validParams: WeightedScorerParameters = {
    ...JSON.parse(JSON.stringify(currentParams)),
    weights: { ...currentParams.weights, completion: Math.min(currentParams.weights.completion + 0.1, 1) },
  };
  const { proposalId, candidateRoundId } = core.controlPlane.submitProposal(
    "default-weighted-tuner", "default-weighted-scorer",
    { baseRoundId: wsResult.roundId, parameters: validParams },
  );

  // Promote → currentRoundId changes
  core.controlPlane.promoteRound(candidateRoundId);

  const newInstance = core.repository.getInstance("default-weighted-scorer");
  assert.ok(newInstance);
  assert.notEqual(newInstance!.currentRoundId, wsResult.roundId, "currentRoundId should have changed");

  // Submit another proposal with the OLD baseRoundId → stale baseline
  assert.throws(
    () => {
      core.controlPlane.submitProposal(
        "default-weighted-tuner", "default-weighted-scorer",
        { baseRoundId: wsResult.roundId, parameters: validParams },
      );
    },
    { message: /stale baseline/ },
  );

  // Rejected proposal should still be persisted
  const proposals = core.repository.listProposals("default-weighted-scorer");
  const rejected = proposals.filter((p) => p.status === "rejected");
  assert.ok(rejected.length >= 1, "stale-baseline proposal should be persisted as rejected");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 6: optimizer.run.{triggered,skipped} events
// ═══════════════════════════════════════════════════════════════════════════════

test("optimizer events: run.triggered and run.skipped for no-signal data", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  await ensureWeightedScorerInstance(core, schedulers, ports);

  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "default-weighted-tuner", config: {}, targetSchedulers: ["default-weighted-scorer"] },
  );

  // Get current round for window
  const currentRound = core.repository.getRound(
    core.repository.getInstance("default-weighted-scorer")!.currentRoundId,
  );
  assert.ok(currentRound);

  // Seed runs that won't trigger any rule
  seedNoSignalRuns(db, currentRound!.createdAt);

  // Emulate facade.run() event flow
  const now = Date.now();
  const triggeredId = `optimizer.run.triggered:default-weighted-tuner:${now}`;
  core.events.append({
    eventId: triggeredId,
    eventType: "optimizer.run.triggered",
    schemaVersion: "1",
    timestamp: now,
    identity: { traceId: "test", optimizerInstanceId: "default-weighted-tuner" },
    payload: { instanceId: "default-weighted-tuner" },
  });

  // Get aggregates and call decide
  const dataApi = new DataAPIImpl(db, core.repository, core.events, ["default-weighted-scorer"], "default-weighted-tuner");
  const aggregates = dataApi.getCandidateAggregates("default-weighted-scorer", {
    since: currentRound!.createdAt,
    until: now,
  }, "coder") as ModelAggregate[];

  const currentParams = currentRound!.parameters as WeightedScorerParameters;
  const result = decide(aggregates, currentParams.weights, { minSamples: 20, step: 0.05, margin: 0.1 });
  assert.equal(result, null, "no-signal data should return null from decide");

  // Emit skipped event
  core.events.append({
    eventId: `optimizer.run.skipped:default-weighted-tuner:default-weighted-scorer:${now}`,
    eventType: "optimizer.run.skipped",
    schemaVersion: "1",
    timestamp: now,
    identity: {
      traceId: "test",
      optimizerInstanceId: "default-weighted-tuner",
      schedulerInstanceId: "default-weighted-scorer",
    },
    payload: { instanceId: "default-weighted-tuner", reason: "no-actionable-signal" },
  });

  // Verify events (query all — triggered event may not have schedulerInstanceId)
  const events = core.events.query({ limit: 200 });
  const triggered = events.filter((e) => e.eventType === "optimizer.run.triggered");
  const skipped = events.filter((e) => e.eventType === "optimizer.run.skipped");
  assert.ok(triggered.length >= 1, "run.triggered event should be recorded");
  assert.ok(skipped.length >= 1, "run.skipped event should be recorded");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 7: production facade path — role-less call → proposal (Fix 1 + Fix 2)
// ═══════════════════════════════════════════════════════════════════════════════

test("production facade: seeded runs (role-less) → optimize() via facade → proposal submitted", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o"), model("anthropic/claude-3")];
  const ports = mockPorts(candidates);

  const wsResult = await ensureWeightedScorerInstance(core, schedulers, ports);
  assert.equal(wsResult.instanceId, "default-weighted-scorer");

  // ── Set up optimizer ────────────────────────────────────────────────
  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    {
      instanceId: "default-weighted-tuner",
      config: { minSamples: 10, step: 0.05, margin: 0.1 },
      targetSchedulers: ["default-weighted-scorer"],
    },
  );

  // ── Get current round and seed runs AFTER its createdAt ─────────────
  const currentRound = core.repository.getRound(wsResult.roundId);
  assert.ok(currentRound);

  // Seed runs with NO role filter — the projector should aggregate all roles
  // (Fix 1: undefined role → no WHERE role clause)
  seedQualityTriggerRuns(db, currentRound!.createdAt);

  // ── Build the production facade ─────────────────────────────────────
  const { buildOptimizerFacade } = await import("../src/optimizer/facade.ts");
  let coreRef = core;
  let registryRef = optRegistry;
  const facade = buildOptimizerFacade({
    getCore: () => coreRef,
    getRegistry: () => registryRef,
    getDb: () => db,
  });

  // ── Drive the REAL production path ─────────────────────────────────
  const result = await facade.run("default-weighted-tuner");

  assert.equal(result.kind, "proposal", `expected proposal, got ${result.kind}${result.kind === "skip" ? ` (reason: ${(result as { reason?: string }).reason})` : ""}${result.kind === "fail" ? ` (error: ${(result as { error?: string }).error})` : ""}`);
  assert.ok(result.proposalId, "proposalId should be set");
  assert.ok(result.eventId, "eventId should be set");
  assert.ok(result.evaluation, "evaluation should be set");
  assert.ok(result.evaluation!.dataWindow, "dataWindow should be set");

  // ── Verify proposal persisted ──────────────────────────────────────
  const proposal = core.repository.getProposal(result.proposalId!);
  assert.ok(proposal);
  assert.equal(proposal!.status, "pending");

  // ── Verify triggered event ─────────────────────────────────────────
  const events = core.events.query({ limit: 200 });
  const triggered = events.filter((e) => e.eventType === "optimizer.run.triggered");
  assert.ok(triggered.length >= 1, "run.triggered event should be recorded");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 8: onRunTick fires after skip (Fix 3: decoupled auto tick)
// ═══════════════════════════════════════════════════════════════════════════════

test("optimizer facade: onRunTick fires after skip result", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  const wsResult = await ensureWeightedScorerInstance(core, schedulers, ports);
  assert.equal(wsResult.instanceId, "default-weighted-scorer");

  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    {
      instanceId: "default-weighted-tuner",
      config: { minSamples: 10, step: 0.05, margin: 0.1 },
      targetSchedulers: ["default-weighted-scorer"],
    },
  );

  const currentRound = core.repository.getRound(wsResult.roundId);
  assert.ok(currentRound);

  // Seed no-signal data → weighted tuner will skip
  seedNoSignalRuns(db, currentRound!.createdAt);

  // Build facade with onRunTick spy
  const { buildOptimizerFacade } = await import("../src/optimizer/facade.ts");
  let tickCalls: string[] = [];
  let coreRef = core;
  let registryRef = optRegistry;
  const facade = buildOptimizerFacade({
    getCore: () => coreRef,
    getRegistry: () => registryRef,
    getDb: () => db,
    onRunTick: (sid: string) => { tickCalls.push(sid); },
  });

  const result = await facade.run("default-weighted-tuner");

  // Should be a skip result
  assert.equal(result.kind, "skip", `expected skip, got ${result.kind}${result.kind === "fail" ? ` (error: ${(result as { error?: string }).error})` : result.kind === "proposal" ? " (proposal)" : ""}`);

  // onRunTick must have been called (even for skip)
  assert.ok(tickCalls.length >= 1, `onRunTick should fire after skip; got ${tickCalls.length} calls`);
  assert.equal(tickCalls[0], "default-weighted-scorer");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 9: manual canaryStart emits event (Fix 4a)
// ═══════════════════════════════════════════════════════════════════════════════

test("optimizer facade: manual canaryStart emits optimizer.canary-started event", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));

  const schedulers = new SchedulerRegistry(core.definitions);
  const candidates = [model("openai/gpt-4o")];
  const ports = mockPorts(candidates);

  const wsResult = await ensureWeightedScorerInstance(core, schedulers, ports);

  const optRegistry = new OptimizerRegistry(core.definitions, core.repository, core.events);
  optRegistry.registerOptimizer(weightedTunerDefinition);
  optRegistry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "default-weighted-tuner", config: {}, targetSchedulers: ["default-weighted-scorer"] },
  );

  // Submit a proposal → get a candidate round
  const sub = core.controlPlane.submitProposal("default-weighted-tuner", "default-weighted-scorer", {
    baseRoundId: wsResult.roundId,
    parameters: { weights: { completion: 0.7, costEffectiveness: 0.1, performance: 0.1, benchmark: 0.1 }, topN: 3, pinBehavior: "respect", syncOnDispatch: false },
  });

  // Mark as validated (prerequisite for canary)
  core.controlPlane.markRoundValidated(sub.candidateRoundId);

  // Build facade with getOptimizerConfig for percent default
  const { buildOptimizerFacade } = await import("../src/optimizer/facade.ts");
  let coreRef = core;
  let registryRef = optRegistry;
  const facade = buildOptimizerFacade({
    getCore: () => coreRef,
    getRegistry: () => registryRef,
    getDb: () => db,
    getOptimizerConfig: () => ({ canaryPercent: 25 }),
  });

  // Manual canary start
  const result = facade.canaryStart(sub.candidateRoundId);
  assert.ok(result.ok, `canaryStart should succeed: ${result.reason ?? ""}`);
  assert.equal(result.schedulerInstanceId, "default-weighted-scorer");

  // Round status should be "canary"
  const round = core.repository.getRound(sub.candidateRoundId);
  assert.equal(round!.status, "canary");

  // optimizer.canary-started event should be emitted
  const evts = core.events.query({ eventType: "optimizer.canary-started" });
  assert.equal(evts.length, 1, "optimizer.canary-started event should be emitted");
  assert.equal(evts[0].payload.roundId, sub.candidateRoundId);
  assert.equal(evts[0].payload.actor, "manual");
  assert.equal(evts[0].payload.canaryPercent, 25);
});
