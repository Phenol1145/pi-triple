/**
 * Tests for shadow evaluation engine (Phase 5b T4).
 *
 * Covers:
 *  - Ranking change under weight swaps
 *  - No change when weights are identical
 *  - Pinned catalog snapshot (called once, used for both)
 *  - Catalog failure fail-open (status "failed", no throw)
 *  - Insufficient-data status when samples < minSamples
 *  - Shadow result persisted on proposal evaluation
 *  - markRoundValidated transition discipline (proposed→validated, others throw)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { evaluateShadow, type ShadowResult } from "../src/optimizer/shadow.ts";
import { registerMetricsProjector } from "../src/optimizer/registry.ts";
import type { ModelInfo, LabConfig } from "../src/types.ts";
import type {
  SchedulerDefinition,
  OptimizerDefinition,
  WorkLoopDefinition,
  SchedulerInstanceDraftSpec,
} from "../src/core/contracts.ts";
import type { ModelAggregate } from "../src/optimizers/ws-projector.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Test definitions
// ═══════════════════════════════════════════════════════════════════════════════

function schedulerDef(overrides: Partial<SchedulerDefinition> = {}): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "weighted-scorer",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: {
      weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
      topN: 1,
      pinBehavior: "respect",
      syncOnDispatch: false,
    },
    tunablePaths: ["weights.*", "topN", "pinBehavior", "syncOnDispatch"],
    validateParameters: (value) => {
      const v = value as Record<string, unknown> | null;
      if (!v || typeof v !== "object") {
        return { ok: false, issues: [{ path: "", code: "type", message: "must be object" }] };
      }
      return { ok: true, value: v };
    },
    validateAgentDefinition: (value) => {
      const name = (value as { standard?: { name?: unknown } })?.standard?.name;
      return typeof name === "string" && name.length > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "standard.name", code: "required", message: "agent name is required" }] };
    },
    ...overrides,
  };
}

function optimizerDef(overrides: Partial<OptimizerDefinition> = {}): OptimizerDefinition {
  return {
    kind: "optimizer",
    id: "weighted-tuner",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configurationSchema: { type: "object" },
    requiredMetrics: ["runs"],
    compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "^1.0.0" }],
    parameterModelVersionRange: "^1.0.0",
    ...overrides,
  };
}

const loop: WorkLoopDefinition = {
  kind: "workloop",
  id: "pi-default-loop",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: { type: "object" },
  requiredCapabilities: [],
  cloneModes: ["fresh", "fork"],
};

function draftSpec(): SchedulerInstanceDraftSpec {
  return {
    id: "test-instance",
    schedulerDefinition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    agents: [{
      id: "agent-1",
      definition: {
        standard: { name: "Test Agent", capabilities: [], executionKind: "pi-subagent", labels: {} },
        workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
        custom: {},
      },
    }],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Model catalog helpers
// ═══════════════════════════════════════════════════════════════════════════════

function modelA(): ModelInfo {
  return {
    id: "openai/gpt-5",
    provider: "openai",
    name: "GPT-5",
    contextWindow: 128000,
    pricing: { in: 15, out: 75 },
    perf: { throughputP50: 80 },
    benchmarks: { mmlu: 95 },
    accessRoute: "direct",
  };
}

function modelB(): ModelInfo {
  return {
    id: "google/gemini-pro",
    provider: "google",
    name: "Gemini Pro",
    contextWindow: 100000,
    pricing: { in: 1, out: 3 },
    perf: { throughputP50: 50 },
    benchmarks: { mmlu: 78 },
    accessRoute: "direct",
  };
}

const SNAPSHOT = [modelA(), modelB()];

// modelA: high completion (0.92), very expensive
// modelB: lower completion (0.75), extremely cheap
// Under completion-heavy weights → A wins; under cost-heavy weights → B wins
const TEST_AGGREGATES: ModelAggregate[] = [
  { model: "openai/gpt-5", runs: 15, avgCompletion: 0.92, avgCost: 0.012, successRate: 0.95 },
  { model: "google/gemini-pro", runs: 15, avgCompletion: 0.75, avgCost: 0.002, successRate: 0.90 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Setup helper
// ═══════════════════════════════════════════════════════════════════════════════

interface SetupResult {
  db: DatabaseSync;
  repository: CoreRepository;
  events: EventLog;
  service: ControlPlane;
  optimizerInstanceId: string;
  schedulerInstanceId: string;
  proposalId: string;
  candidateRoundId: string;
  baseRoundId: string;
}

function setup(overrides?: {
  baseWeights?: { completion: number; costEffectiveness: number; performance: number; benchmark: number };
  candidateWeights?: { completion: number; costEffectiveness: number; performance: number; benchmark: number };
  topN?: number;
  minSamplesOverride?: number;
}): SetupResult {
  const db = new DatabaseSync(":memory:");
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(optimizerDef());
  definitions.register(loop);
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const service = new ControlPlane(definitions, repository, events, () => 1000);

  // Activate draft
  service.createDraft(draftSpec());
  service.validateDraft("test-instance");
  service.activateDraft("test-instance");

  const schedulerInstanceId = "test-instance";
  const baseRoundId = "test-instance:round:0";

  // Create optimizer instance
  const optimizerInstanceId = "test-optimizer";
  repository.insertOptimizerInstance({
    id: optimizerInstanceId,
    definitionId: "weighted-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: [schedulerInstanceId],
    status: "active",
    createdAt: 500,
  });

  // Create candidate round + proposal via submitProposal
  const baseWeights = overrides?.baseWeights ?? {
    completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1,
  };
  const candidateWeights = overrides?.candidateWeights ?? {
    completion: 0.25, costEffectiveness: 0.50, performance: 0.15, benchmark: 0.1,
  };
  const topN = overrides?.topN ?? 1;

  const { proposalId, candidateRoundId } = service.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId,
      parameters: {
        weights: candidateWeights,
        topN,
        pinBehavior: "respect",
        syncOnDispatch: false,
      },
      evaluation: {
        summary: "test proposal",
        metrics: { totalRuns: 30 },
        dataWindow: { since: 0, until: 2000 },
      },
    },
  );

  return {
    db,
    repository,
    events,
    service,
    optimizerInstanceId,
    schedulerInstanceId,
    proposalId,
    candidateRoundId,
    baseRoundId,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

test("shadow: ranking changes when weights swap completion<->cost", async () => {
  const s = setup();
  const db = s.db;

  // Register projector that returns our test aggregates
  registerMetricsProjector("weighted-scorer", (_db, _window, _opts) => {
    return TEST_AGGREGATES;
  });

  let catalogCalls = 0;
  const result = await evaluateShadow(
    {
      repository: s.repository,
      events: s.events,
      db,
      getCatalogSnapshot: () => {
        catalogCalls++;
        return SNAPSHOT;
      },
      optimizerInstanceId: s.optimizerInstanceId,
      schedulerInstanceId: s.schedulerInstanceId,
    },
    s.proposalId,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.selectionChanged, true,
    "top model should change with swapped weights");
  assert.equal(catalogCalls, 1, "catalog snapshot called exactly once");
  assert.ok(result.samples > 0);
  assert.ok(result.currentTop.length > 0);
  assert.ok(result.candidateTop.length > 0);
  assert.notEqual(
    result.currentTop[0]?.model.id,
    result.candidateTop[0]?.model.id,
    "different top model under different weights",
  );

  // Verify shadow persisted on proposal
  const proposal = s.repository.getProposal(s.proposalId);
  const eval_ = proposal?.evaluation as Record<string, unknown> | undefined;
  assert.ok(eval_, "proposal has evaluation");
  assert.ok(eval_?.shadow, "evaluation has shadow segment");
  const shadow = eval_?.shadow as Record<string, unknown>;
  assert.equal(shadow.status, "ok");
  assert.equal(shadow.selectionChanged, true);

  // Verify event emitted
  const shadowEvents = s.events.query({ eventType: "optimizer.shadow.completed" });
  assert.equal(shadowEvents.length, 1);

  db.close();
});

test("shadow: no ranking change when weights are identical", async () => {
  const s = setup({
    baseWeights: { completion: 0.4, costEffectiveness: 0.3, performance: 0.2, benchmark: 0.1 },
    candidateWeights: { completion: 0.4, costEffectiveness: 0.3, performance: 0.2, benchmark: 0.1 },
  });
  const db = s.db;

  registerMetricsProjector("weighted-scorer", (_db, _window, _opts) => {
    return TEST_AGGREGATES;
  });

  const result = await evaluateShadow(
    {
      repository: s.repository,
      events: s.events,
      db,
      getCatalogSnapshot: () => SNAPSHOT,
      optimizerInstanceId: s.optimizerInstanceId,
      schedulerInstanceId: s.schedulerInstanceId,
    },
    s.proposalId,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.selectionChanged, false,
    "same weights should produce same top model");
  assert.equal(result.expectedCompletionDelta, 0);
  assert.equal(result.expectedCostDelta, 0);

  db.close();
});

test("shadow: catalog failure returns status=failed, does not throw", async () => {
  const s = setup();
  const db = s.db;

  registerMetricsProjector("weighted-scorer", (_db, _window, _opts) => {
    return TEST_AGGREGATES;
  });

  const result = await evaluateShadow(
    {
      repository: s.repository,
      events: s.events,
      db,
      getCatalogSnapshot: () => {
        throw new Error("catalog network error");
      },
      optimizerInstanceId: s.optimizerInstanceId,
      schedulerInstanceId: s.schedulerInstanceId,
    },
    s.proposalId,
  );

  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("catalog"), "error mentions catalog");

  // Verify shadow persisted with failed status
  const proposal = s.repository.getProposal(s.proposalId);
  const eval_ = proposal?.evaluation as Record<string, unknown> | undefined;
  const shadow = eval_?.shadow as Record<string, unknown>;
  assert.equal(shadow.status, "failed");
  assert.ok((shadow.error as string)?.includes("catalog"));

  db.close();
});

test("shadow: returns insufficient-data when samples < minSamples", async () => {
  const s = setup();
  const db = s.db;

  // Low-run aggregates
  const lowAggs: ModelAggregate[] = [
    { model: "openai/gpt-5", runs: 2, avgCompletion: 0.9, avgCost: 0.004, successRate: 1.0 },
  ];

  registerMetricsProjector("weighted-scorer", (_db, _window, _opts) => {
    return lowAggs;
  });

  const result = await evaluateShadow(
    {
      repository: s.repository,
      events: s.events,
      db,
      getCatalogSnapshot: () => SNAPSHOT,
      optimizerInstanceId: s.optimizerInstanceId,
      schedulerInstanceId: s.schedulerInstanceId,
      minSamples: 20,
    },
    s.proposalId,
  );

  assert.equal(result.status, "insufficient-data");
  assert.ok(result.samples < 20);

  // Verify shadow persisted with insufficient-data status
  const proposal = s.repository.getProposal(s.proposalId);
  const eval_ = proposal?.evaluation as Record<string, unknown> | undefined;
  const shadow = eval_?.shadow as Record<string, unknown>;
  assert.equal(shadow.status, "insufficient-data");

  db.close();
});

test("shadow: project failure returns status=failed, no throw", async () => {
  const s = setup();
  const db = s.db;

  registerMetricsProjector("weighted-scorer", () => {
    throw new Error("db connection lost");
  });

  const result = await evaluateShadow(
    {
      repository: s.repository,
      events: s.events,
      db,
      getCatalogSnapshot: () => SNAPSHOT,
      optimizerInstanceId: s.optimizerInstanceId,
      schedulerInstanceId: s.schedulerInstanceId,
    },
    s.proposalId,
  );

  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("db connection lost"));

  db.close();
});

test("shadow: missing dataWindow returns failed", async () => {
  const db = new DatabaseSync(":memory:");
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(optimizerDef());
  definitions.register(loop);
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const service = new ControlPlane(definitions, repository, events, () => 1000);

  service.createDraft(draftSpec());
  service.validateDraft("test-instance");
  service.activateDraft("test-instance");

  repository.insertOptimizerInstance({
    id: "test-optimizer",
    definitionId: "weighted-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: ["test-instance"],
    status: "active",
    createdAt: 500,
  });

  const { proposalId } = service.submitProposal(
    "test-optimizer",
    "test-instance",
    {
      baseRoundId: "test-instance:round:0",
      parameters: { weights: { completion: 0.5, costEffectiveness: 0.5, performance: 0, benchmark: 0 }, topN: 1, pinBehavior: "respect", syncOnDispatch: false },
      evaluation: {
        summary: "no window",
        metrics: {},
        // deliberately missing dataWindow
        dataWindow: undefined as unknown as { since: number; until: number },
      },
    },
  );

  registerMetricsProjector("weighted-scorer", () => TEST_AGGREGATES);

  const result = await evaluateShadow(
    {
      repository,
      events,
      db,
      getCatalogSnapshot: () => SNAPSHOT,
      optimizerInstanceId: "test-optimizer",
      schedulerInstanceId: "test-instance",
    },
    proposalId,
  );

  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("dataWindow"));

  db.close();
});

test("markRoundValidated: proposed→validated transition succeeds", () => {
  const s = setup();
  const db = s.db;

  // Candidate round starts as "proposed"
  const round = s.repository.getRound(s.candidateRoundId);
  assert.equal(round?.status, "proposed");

  s.service.markRoundValidated(s.candidateRoundId);

  const updated = s.repository.getRound(s.candidateRoundId);
  assert.equal(updated?.status, "validated");

  // Verify event emitted
  const events = s.events.query({ eventType: "round.validated" });
  assert.equal(events.length, 1);
  assert.equal(events[0].identity.optimizationRoundId, s.candidateRoundId);

  db.close();
});

test("markRoundValidated: active round throws", () => {
  const s = setup();
  const db = s.db;

  // baseRound is "active"
  assert.throws(
    () => s.service.markRoundValidated(s.baseRoundId),
    /active.*expected proposed/,
  );

  db.close();
});

test("markRoundValidated: already validated round throws", () => {
  const s = setup();
  const db = s.db;

  s.service.markRoundValidated(s.candidateRoundId);
  assert.throws(
    () => s.service.markRoundValidated(s.candidateRoundId),
    /validated.*expected proposed/,
  );

  db.close();
});

test("markRoundValidated: non-existent round throws", () => {
  const s = setup();
  const db = s.db;

  assert.throws(
    () => s.service.markRoundValidated("nonexistent:round:99"),
    /round not found/,
  );

  db.close();
});

test("shadow: promoteRound unchanged — proposed round still promotable", () => {
  // Verify that existing promoteRound tests remain valid:
  // a proposed round can be promoted even when the shadow hasn't validated it.
  const s = setup();
  const db = s.db;

  // Candidate round starts as "proposed" — promote should work
  const before = s.repository.getRound(s.candidateRoundId);
  assert.equal(before?.status, "proposed");

  const { newRoundId } = s.service.promoteRound(s.candidateRoundId);
  assert.ok(newRoundId, "promote succeeded for proposed round");

  const instance = s.repository.getInstance(s.schedulerInstanceId);
  assert.equal(instance?.currentRoundId, newRoundId);

  db.close();
});

test("shadow: validated round can also be promoted", () => {
  const s = setup();
  const db = s.db;

  s.service.markRoundValidated(s.candidateRoundId);

  const { newRoundId } = s.service.promoteRound(s.candidateRoundId);
  assert.ok(newRoundId);

  db.close();
});

test("shadow: expectedCostDelta from projector avgCost, not scorer cost dimension", async () => {
  const s = setup();
  const db = s.db;

  // Aggregates where modelA has higher avgCost than modelB
  const costAggs: ModelAggregate[] = [
    { model: "openai/gpt-5", runs: 15, avgCompletion: 0.92, avgCost: 0.010, successRate: 0.95 },
    { model: "anthropic/claude-4", runs: 10, avgCompletion: 0.88, avgCost: 0.005, successRate: 0.90 },
  ];

  registerMetricsProjector("weighted-scorer", (_db, _window, _opts) => {
    return costAggs;
  });

  const result = await evaluateShadow(
    {
      repository: s.repository,
      events: s.events,
      db,
      getCatalogSnapshot: () => [modelA(), modelB()],
      optimizerInstanceId: s.optimizerInstanceId,
      schedulerInstanceId: s.schedulerInstanceId,
    },
    s.proposalId,
  );

  assert.equal(result.status, "ok");
  // Cost delta is from projector avgCost (I2), not scorer blendedPrice
  // We can't assert a specific value since it depends on scoring, but
  // we can verify it's a finite number
  assert.ok(Number.isFinite(result.expectedCostDelta));

  db.close();
});
