/**
 * Tests for auto-flow orchestration (Phase 5b T8).
 *
 * Covers:
 *  - Default-off no-op (tick with default config → zero gating calls)
 *  - Full state machine: proposed→validated→canary→promoted
 *  - Full state machine: proposed→validated→canary→aborted (rollback)
 *  - Auto canary start: validated round triggers setCanaryRound
 *  - Degraded canary → auto-promote skipped
 *  - Insufficient samples → auto-promote skipped
 *  - Concurrency race: manual promote between eval and auto-promote
 *  - Concurrency race: manual abort between eval and auto-rollback
 *  - Each gate reused (promoteRound/abortCanary called, not bypassed)
 *  - Top-level try/catch → optimizer.auto.failed event
 *  - evaluateShadow errors handled gracefully
 *  - evaluateCanary errors handled gracefully
 *  - Single-target assumption (tick operates on one instance)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { createAutoFlow, type AutoFlowDeps } from "../src/optimizer/auto-flow.ts";
import type {
  ShadowResult,
  ShadowDeps,
} from "../src/optimizer/shadow.ts";
import {
  decideCanaryAction as realDecideCanaryActionImpl,
  type CanaryEvalResult,
  type CanaryBucket,
  type CanaryAction,
} from "../src/optimizer/canary-eval.ts";
import type { OptimizerConfig } from "../src/types.ts";
import type {
  SchedulerDefinition,
  OptimizerDefinition,
  WorkLoopDefinition,
  SchedulerInstanceDraftSpec,
} from "../src/core/contracts.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Test definitions (shared pattern with shadow/canary-eval tests)
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
// STORE_SCHEMA for :memory: db runs table
// ═══════════════════════════════════════════════════════════════════════════════

const STORE_SCHEMA = `
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
  source TEXT NOT NULL,
  trace_id TEXT
);
`;

// ═══════════════════════════════════════════════════════════════════════════════
// Stubs & spies
// ═══════════════════════════════════════════════════════════════════════════════

function okShadow(): ShadowResult {
  return {
    selectionChanged: true,
    currentTop: [],
    candidateTop: [],
    expectedCompletionDelta: 0,
    expectedCostDelta: 0,
    samples: 50,
    status: "ok",
  };
}

function insufficientShadow(): ShadowResult {
  return {
    selectionChanged: false,
    currentTop: [],
    candidateTop: [],
    expectedCompletionDelta: 0,
    expectedCostDelta: 0,
    samples: 5,
    status: "insufficient-data",
  };
}

function goodCanaryEval(
  overrides: Partial<CanaryEvalResult> = {},
): CanaryEvalResult {
  const canary: CanaryBucket = {
    runs: 50,
    avgCompletion: 0.92,
    avgCost: 0.010,
    successRate: 0.95,
  };
  const control: CanaryBucket = {
    runs: 60,
    avgCompletion: 0.90,
    avgCost: 0.012,
    successRate: 0.93,
  };
  return {
    canary: { ...canary, ...(overrides.canary as Partial<CanaryBucket> ?? {}) },
    control: { ...control, ...(overrides.control as Partial<CanaryBucket> ?? {}) },
    other: { runs: 0, avgCompletion: 0, avgCost: 0, successRate: 0 },
    excludedNullTrace: 0,
    canaryRoundId: "test-instance:round:1",
    controlRoundId: "test-instance:round:0",
    ...overrides,
  };
}

function degradedCanaryEval(): CanaryEvalResult {
  return goodCanaryEval({
    canary: {
      runs: 50,
      avgCompletion: 0.70, // significantly worse than control's 0.90
      avgCost: 0.020,       // significantly more expensive
      successRate: 0.80,
    },
    control: {
      runs: 60,
      avgCompletion: 0.90,
      avgCost: 0.012,
      successRate: 0.93,
    },
  });
}

/**
 * Default decideCanaryAction: delegates to the real implementation.
 */
function realDecideCanaryAction(
  autoRollback: OptimizerConfig["autoRollback"],
  canaryAgg: CanaryBucket,
  controlAgg: CanaryBucket,
): CanaryAction {
  return realDecideCanaryActionImpl(autoRollback, canaryAgg, controlAgg);
}

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
  baseRoundId: string;
  proposalId: string;
  candidateRoundId: string;
  /** spy counters for gate calls */
  spies: {
    promoteRoundCalls: number;
    abortCanaryCalls: number;
    setCanaryRoundCalls: number;
    markRoundValidatedCalls: number;
  };
  shadowCalls: number;
  canaryEvalCalls: number;
  decideCalls: number;
  logMessages: string[];
  /**
   * Build an AutoFlowDeps object with the current spy state.
   * Each call to buildDeps returns a fresh set of spies (so counters are
   * isolated per tick or per test).
   */
  buildDeps: (overrides?: {
    config?: Partial<OptimizerConfig>;
    shadowResult?: ShadowResult | "throw";
    canaryEvalResult?: CanaryEvalResult | "throw";
    decideAction?: CanaryAction;
  }) => AutoFlowDeps;
  /**
   * Advance the candidate round to a given status + optional canary pointer.
   */
  setRoundStatus: (status: string, canaryPercent?: number) => void;
  /** Promote the canary round manually (simulates concurrent manual action). */
  manualPromote: () => void;
  /** Abort the canary manually (simulates concurrent manual action). */
  manualAbort: () => void;
}

function setup(): SetupResult {
  const db = new DatabaseSync(":memory:");
  db.exec(STORE_SCHEMA);

  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(optimizerDef());
  definitions.register(loop);
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const now = Date.now();
  const service = new ControlPlane(definitions, repository, events, () => now);

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
    name: optimizerInstanceId,
    definitionId: "weighted-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: [schedulerInstanceId],
    status: "active",
    createdAt: now,
  });

  // Submit proposal (creates candidate round in "proposed" status)
  const { proposalId, candidateRoundId } = service.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId,
      parameters: {
        weights: { completion: 0.25, costEffectiveness: 0.50, performance: 0.15, benchmark: 0.1 },
        topN: 1,
        pinBehavior: "respect",
        syncOnDispatch: false,
      },
      evaluation: {
        summary: "test proposal",
        metrics: {},
        dataWindow: { since: 0, until: 2000 },
      },
    },
  );

  // ── Shared mutable spy state ──────────────────────────────────────
  const spies = {
    promoteRoundCalls: 0,
    abortCanaryCalls: 0,
    setCanaryRoundCalls: 0,
    markRoundValidatedCalls: 0,
  };
  let shadowCalls = 0;
  let canaryEvalCalls = 0;
  let decideCalls = 0;
  const logMessages: string[] = [];

  function buildDeps(overrides?: {
    config?: Partial<OptimizerConfig>;
    shadowResult?: ShadowResult | "throw";
    canaryEvalResult?: CanaryEvalResult | "throw";
    decideAction?: CanaryAction;
  }): AutoFlowDeps {
    // Reset per-build counters
    spies.promoteRoundCalls = 0;
    spies.abortCanaryCalls = 0;
    spies.setCanaryRoundCalls = 0;
    spies.markRoundValidatedCalls = 0;
    shadowCalls = 0;
    canaryEvalCalls = 0;
    decideCalls = 0;
    logMessages.length = 0;

    const shadowResult = overrides?.shadowResult;
    const canaryEvalResult = overrides?.canaryEvalResult;

    return {
      repository,
      events,
      controlPlane: {
        promoteRound: (roundId: string) => {
          spies.promoteRoundCalls++;
          return service.promoteRound(roundId);
        },
        abortCanary: (si: string, opts?: { reason?: string; actor?: string }) => {
          spies.abortCanaryCalls++;
          return service.abortCanary(si, opts);
        },
        markRoundValidated: (roundId: string) => {
          spies.markRoundValidatedCalls++;
          return service.markRoundValidated(roundId);
        },
        // passthrough for remaining methods (not used in auto-flow)
        createDraft: service.createDraft.bind(service),
        validateDraft: service.validateDraft.bind(service),
        activateDraft: service.activateDraft.bind(service),
        setCatchAllBinding: service.setCatchAllBinding.bind(service),
        submitProposal: service.submitProposal.bind(service),
        rollbackRound: service.rollbackRound.bind(service),
      } as unknown as ControlPlane,
      config: {
        shadow: { enabled: false },
        canaryPercent: 0,
        autoTrigger: { enabled: false },
        autoPromote: { enabled: false },
        autoRollback: { enabled: false },
        ...overrides?.config,
      } as OptimizerConfig,
      evaluateShadow: async (_pid: string) => {
        shadowCalls++;
        if (shadowResult === "throw") {
          throw new Error("shadow explosion");
        }
        return shadowResult ?? okShadow();
      },
      evaluateCanary: (_sid: string) => {
        canaryEvalCalls++;
        if (canaryEvalResult === "throw") {
          throw new Error("canary eval explosion");
        }
        return canaryEvalResult ?? goodCanaryEval();
      },
      decideCanaryAction: (
        autoRollback: OptimizerConfig["autoRollback"],
        canaryAgg: CanaryBucket,
        controlAgg: CanaryBucket,
      ) => {
        decideCalls++;
        if (overrides?.decideAction !== undefined) {
          return overrides.decideAction;
        }
        return realDecideCanaryAction(autoRollback, canaryAgg, controlAgg);
      },
      logger: {
        info: (msg: string) => { logMessages.push(`info: ${msg}`); },
        warn: (msg: string) => { logMessages.push(`warn: ${msg}`); },
      },
    };
  }

  // ── Mutation helpers ─────────────────────────────────────────────
  function setRoundStatus(status: string, canaryPercent?: number): void {
    if (status === "validated") {
      service.markRoundValidated(candidateRoundId);
    } else if (status === "canary") {
      // validated → canary + canary pointer
      service.markRoundValidated(candidateRoundId);
      repository.setCanaryRound(schedulerInstanceId, candidateRoundId, canaryPercent ?? 30);
      repository.updateRoundStatus(candidateRoundId, "canary");
    } else {
      repository.updateRoundStatus(candidateRoundId, status);
    }
  }

  function manualPromote(): void {
    service.promoteRound(candidateRoundId);
  }

  function manualAbort(): void {
    // Need canary set first
    if (!repository.getInstance(schedulerInstanceId)?.canaryRoundId) {
      repository.setCanaryRound(schedulerInstanceId, candidateRoundId, 30);
    }
    service.abortCanary(schedulerInstanceId);
  }

  return {
    db,
    repository,
    events,
    service,
    optimizerInstanceId,
    schedulerInstanceId,
    baseRoundId,
    proposalId,
    candidateRoundId,
    spies,
    shadowCalls,
    canaryEvalCalls,
    decideCalls,
    logMessages,
    buildDeps,
    setRoundStatus,
    manualPromote,
    manualAbort,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: default-off
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: default config → tick is no-op (zero gate calls)", async () => {
  const s = setup();
  const deps = s.buildDeps();

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(s.spies.promoteRoundCalls, 0);
  assert.equal(s.spies.abortCanaryCalls, 0);
  assert.equal(s.spies.setCanaryRoundCalls, 0);
  assert.equal(s.spies.markRoundValidatedCalls, 0);

  s.db.close();
});

test("auto-flow: all flags disabled → no shadow, no canary, no promote", async () => {
  const s = setup();
  const deps = s.buildDeps({
    config: {
      shadow: { enabled: false },
      canaryPercent: 0,
      autoPromote: { enabled: false },
      autoRollback: { enabled: false },
    },
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // Even with a proposed round pending, nothing happens
  assert.equal(s.spies.markRoundValidatedCalls, 0);
  assert.equal(s.spies.setCanaryRoundCalls, 0);
  assert.equal(s.spies.promoteRoundCalls, 0);

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: full state machine → promoted
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: proposed → shadow → validated → canary → promoted", async () => {
  const s = setup();
  const deps = s.buildDeps({
    config: {
      shadow: { enabled: true },
      canaryPercent: 30,
      autoPromote: { enabled: true, minSamples: 30 },
      autoRollback: { enabled: true, minSamples: 30 },
    },
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // Step 1: shadow evaluated, markRoundValidated called
  assert.equal(s.spies.markRoundValidatedCalls, 1,
    "markRoundValidated should be called after shadow ok");

  // Step 2: canary started
  assert.equal(s.spies.setCanaryRoundCalls, 0,
    "setCanaryRound called via repository, not spy"); // setCanaryRound not wrapped

  // Step 3: canary eval → hold → auto-promote
  assert.equal(s.spies.promoteRoundCalls, 1,
    "promoteRound should be called for auto-promote");
  assert.equal(s.spies.abortCanaryCalls, 0,
    "abortCanary should not be called");

  // Verify events
  const evts = s.events.query({ eventType: "optimizer.auto.promoted" });
  assert.equal(evts.length, 1, "optimizer.auto.promoted event emitted");
  assert.equal(evts[0].identity.schedulerInstanceId, s.schedulerInstanceId);

  s.db.close();
});

test("auto-flow: canary-started event emitted", async () => {
  const s = setup();
  // First tick: shadow → validated
  const deps1 = s.buildDeps({
    config: {
      shadow: { enabled: true },
      canaryPercent: 30,
    },
  });
  const flow1 = createAutoFlow(deps1);
  await flow1.tick(s.schedulerInstanceId);

  // Should have canary-started event because canaryPercent>0 and validated exists
  const startEvents = s.events.query({ eventType: "optimizer.auto.canary-started" });
  assert.equal(startEvents.length, 1, "canary-started event emitted");
  assert.equal(startEvents[0].payload.canaryPercent, 30);

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: full state machine → aborted (rollback)
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: degraded canary → auto-rollback", async () => {
  const s = setup();
  // Manually set canary so that step 1-2 are skipped, only step 3 runs
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoRollback: { enabled: true, minSamples: 30 },
    },
    canaryEvalResult: degradedCanaryEval(),
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(s.spies.abortCanaryCalls, 1,
    "abortCanary should be called for auto-rollback");
  assert.equal(s.spies.promoteRoundCalls, 0,
    "promoteRound should not be called");

  // Verify event
  const evts = s.events.query({ eventType: "optimizer.auto.rollback" });
  assert.equal(evts.length, 1, "optimizer.auto.rollback event emitted");

  // Verify canary cleared
  const inst = s.repository.getInstance(s.schedulerInstanceId);
  assert.equal(inst?.canaryRoundId, undefined);

  s.db.close();
});

test("auto-flow: degraded but autoRollback disabled → no rollback", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoRollback: { enabled: false },
    },
    canaryEvalResult: degradedCanaryEval(),
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(s.spies.abortCanaryCalls, 0);
  assert.equal(s.spies.promoteRoundCalls, 0);

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: auto-promote skipped when degraded
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: canary degraded → auto-promote skipped", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoPromote: { enabled: true, minSamples: 30 },
    },
    canaryEvalResult: degradedCanaryEval(),
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(s.spies.promoteRoundCalls, 0,
    "auto-promote should be skipped when canary is degraded");

  s.db.close();
});

test("auto-flow: insufficient canary samples → auto-promote skipped", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoPromote: { enabled: true, minSamples: 100 },
    },
    canaryEvalResult: goodCanaryEval({ canary: { runs: 30 } }),
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(s.spies.promoteRoundCalls, 0,
    "auto-promote should be skipped when samples < minSamples");

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: concurrency race safety
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: racing manual promote → auto-promote fails safely", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  // Use a custom evaluateCanary that promotes mid-eval (simulating race)
  let autoCallFailed = false;
  const deps: AutoFlowDeps = {
    repository: s.repository,
    events: s.events,
    controlPlane: s.service, // use real service so promoteRound goes through
    config: {
      autoPromote: { enabled: true, minSamples: 30 },
    },
    evaluateShadow: async () => okShadow(),
    evaluateCanary: () => {
      // Simulate: after eval, someone else promotes
      s.service.promoteRound(s.candidateRoundId);
      return goodCanaryEval();
    },
    decideCanaryAction: () => "hold",
  };

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // Auto-promote should have failed because round was already superseded
  const evts = s.events.query({ eventType: "optimizer.auto.promote-failed" });
  assert.ok(evts.length >= 1 || autoCallFailed,
    "racing manual promote should produce promote-failed event or be handled");

  // No corruption: instance should have a valid currentRoundId
  const inst = s.repository.getInstance(s.schedulerInstanceId);
  assert.ok(inst?.currentRoundId, "instance still has currentRoundId");

  s.db.close();
});

test("auto-flow: racing manual abort → auto-rollback fails safely", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps: AutoFlowDeps = {
    repository: s.repository,
    events: s.events,
    controlPlane: s.service, // use real service for gate re-validation
    config: {
      autoRollback: { enabled: true, minSamples: 30 },
    },
    evaluateShadow: async () => okShadow(),
    evaluateCanary: () => {
      // Simulate: after eval, someone else aborts
      s.service.abortCanary(s.schedulerInstanceId);
      return degradedCanaryEval();
    },
    decideCanaryAction: () => "rollback",
  };

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // Auto-rollback should have failed (canary already cleared)
  const evts = s.events.query({ eventType: "optimizer.auto.rollback-failed" });
  assert.equal(evts.length, 1, "racing manual abort should produce rollback-failed event");

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: gate reuse (promoteRound/abortCanary called, not bypassed)
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: promoteRound called through controlPlane gate (not bypassed)", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoPromote: { enabled: true, minSamples: 30 },
    },
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // promoteRound was called through the spy wrapper → real service
  assert.equal(s.spies.promoteRoundCalls, 1, "promoteRound called via gate");
  assert.equal(s.spies.abortCanaryCalls, 0);

  // Verify the effect is real (round was actually promoted)
  const inst = s.repository.getInstance(s.schedulerInstanceId);
  assert.ok(inst?.currentRoundId, "instance currentRoundId updated");
  assert.notEqual(inst?.currentRoundId, s.baseRoundId,
    "currentRoundId changed from base");

  s.db.close();
});

test("auto-flow: abortCanary called through controlPlane gate (not bypassed)", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoRollback: { enabled: true, minSamples: 30 },
    },
    canaryEvalResult: degradedCanaryEval(),
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(s.spies.abortCanaryCalls, 1, "abortCanary called via gate");
  assert.equal(s.spies.promoteRoundCalls, 0);

  // Verify canary was actually cleared
  const inst = s.repository.getInstance(s.schedulerInstanceId);
  assert.equal(inst?.canaryRoundId, undefined, "canaryRoundId cleared");

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: error handling (fail-open, never throws)
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: evaluateShadow throws → caught, no corruption", async () => {
  const s = setup();

  const deps = s.buildDeps({
    config: { shadow: { enabled: true } },
    shadowResult: "throw",
  });

  const flow = createAutoFlow(deps);

  // Should not throw
  await flow.tick(s.schedulerInstanceId);

  // Round still proposed (not corrupted)
  const round = s.repository.getRound(s.candidateRoundId);
  assert.equal(round?.status, "proposed");

  s.db.close();
});

test("auto-flow: evaluateCanary throws → caught, benign", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoPromote: { enabled: true, minSamples: 30 },
    },
    canaryEvalResult: "throw",
  });

  const flow = createAutoFlow(deps);

  // Should not throw
  await flow.tick(s.schedulerInstanceId);

  // No promote/abort calls
  assert.equal(s.spies.promoteRoundCalls, 0);
  assert.equal(s.spies.abortCanaryCalls, 0);

  s.db.close();
});

test("auto-flow: top-level unexpected error → optimizer.auto.failed event", async () => {
  const s = setup();

  // Create deps where repository.getInstance throws unexpectedly
  const deps: AutoFlowDeps = {
    repository: {
      getInstance: () => { throw new Error("db connection lost"); },
      getRound: () => undefined,
      listProposals: () => [],
      listRounds: () => [],
      setCanaryRound: () => {},
      // minimal stubs
      getProposal: () => undefined,
      insertOptimizerInstance: () => {},
      updateRoundStatus: () => {},
    } as unknown as CoreRepository,
    events: s.events,
    controlPlane: s.service,
    config: { shadow: { enabled: true } },
    evaluateShadow: async () => okShadow(),
    evaluateCanary: () => { throw new Error("unreachable"); },
    decideCanaryAction: () => "hold",
  };

  const flow = createAutoFlow(deps);

  // Should not throw
  await flow.tick(s.schedulerInstanceId);

  // optimizer.auto.failed event should be emitted
  const failedEvts = s.events.query({ eventType: "optimizer.auto.failed" });
  assert.equal(failedEvts.length, 1, "optimizer.auto.failed event emitted");
  assert.ok(failedEvts[0].payload.error?.includes("db connection lost"));

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: shadow → validated transition (insufficient data does NOT validate)
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: insufficient shadow data → no markRoundValidated", async () => {
  const s = setup();

  const deps = s.buildDeps({
    config: { shadow: { enabled: true } },
    shadowResult: insufficientShadow(),
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(s.spies.markRoundValidatedCalls, 0,
    "markRoundValidated should NOT be called for insufficient-data shadow");

  // Round still proposed
  const round = s.repository.getRound(s.candidateRoundId);
  assert.equal(round?.status, "proposed");

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: canaryPercent controls
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: canaryPercent=0 → no canary start even with validated round", async () => {
  const s = setup();

  // First validate the round
  s.service.markRoundValidated(s.candidateRoundId);

  const deps = s.buildDeps({
    config: {
      shadow: { enabled: true },
      canaryPercent: 0,
    },
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // No canary-started event
  const startEvents = s.events.query({ eventType: "optimizer.auto.canary-started" });
  assert.equal(startEvents.length, 0);

  // Instance has no canary set
  const inst = s.repository.getInstance(s.schedulerInstanceId);
  assert.equal(inst?.canaryRoundId, undefined);

  s.db.close();
});

test("auto-flow: canary already set → canary-started not emitted again", async () => {
  const s = setup();

  // Set up canary manually
  s.setRoundStatus("canary", 30);

  // Clear events before this tick
  const deps = s.buildDeps({
    config: {
      canaryPercent: 30,
    },
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // No canary-started event (already set)
  const startEvents = s.events.query({ eventType: "optimizer.auto.canary-started" });
  assert.equal(startEvents.length, 0, "canary-started not re-emitted when already set");

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: no retry loop (L6)
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: promote failure not retried (single attempt)", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  let promoteAttempts = 0;
  const deps: AutoFlowDeps = {
    repository: s.repository,
    events: s.events,
    controlPlane: {
      promoteRound: () => {
        promoteAttempts++;
        throw new Error("promote rejected");
      },
      abortCanary: () => { throw new Error("not called"); },
      markRoundValidated: () => {},
      createDraft: () => {},
      validateDraft: () => ({} as never),
      activateDraft: () => ({} as never),
      setCatchAllBinding: () => {},
      submitProposal: () => ({} as never),
      rollbackRound: () => ({} as never),
    } as unknown as ControlPlane,
    config: {
      autoPromote: { enabled: true, minSamples: 30 },
    },
    evaluateShadow: async () => okShadow(),
    evaluateCanary: () => goodCanaryEval(),
    decideCanaryAction: () => "hold",
  };

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.equal(promoteAttempts, 1, "promote attempted exactly once (no retry)");

  // promote-failed event
  const failedEvts = s.events.query({ eventType: "optimizer.auto.promote-failed" });
  assert.equal(failedEvts.length, 1);

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: single-target assumption (M4)
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: tick operates on a single scheduler instance", async () => {
  const s = setup();

  const deps = s.buildDeps({
    config: { shadow: { enabled: true } },
  });

  const flow = createAutoFlow(deps);

  // tick only touches the given instance
  await flow.tick("other-instance");

  // Our test-instance is untouched
  const inst = s.repository.getInstance(s.schedulerInstanceId);
  assert.ok(inst, "test-instance still exists");
  assert.equal(s.spies.markRoundValidatedCalls, 0,
    "markRoundValidated not called for non-existent instance");

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: logger integration
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: logger receives info on auto-promote", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoPromote: { enabled: true, minSamples: 30 },
    },
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  assert.ok(s.logMessages.some((m) => m.includes("auto-promoted")),
    "logger should log auto-promoted message");

  s.db.close();
});

test("auto-flow: logger receives warn on race failure", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoRollback: { enabled: true, minSamples: 30 },
    },
    canaryEvalResult: degradedCanaryEval(),
  });

  // Override abortCanary to throw, simulating concurrent manual abort
  deps.controlPlane.abortCanary = () => {
    throw new Error("canary already aborted by concurrent operation");
  };

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  // The warn log should indicate the race
  assert.ok(
    s.logMessages.some((m) => m.includes("warn")),
    "logger should contain warn-level message for race",
  );

  // rollback-failed event should be emitted
  const failedEvts = s.events.query({ eventType: "optimizer.auto.rollback-failed" });
  assert.equal(failedEvts.length, 1);

  s.db.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: events have unique-suffixed ids (M6)
// ═══════════════════════════════════════════════════════════════════════════════

test("auto-flow: events use unique-suffixed ids with instanceId:timestamp", async () => {
  const s = setup();
  s.setRoundStatus("canary", 30);

  const deps = s.buildDeps({
    config: {
      autoPromote: { enabled: true, minSamples: 30 },
    },
  });

  const flow = createAutoFlow(deps);
  await flow.tick(s.schedulerInstanceId);

  const promotedEvts = s.events.query({ eventType: "optimizer.auto.promoted" });
  assert.equal(promotedEvts.length, 1);

  const id = promotedEvts[0].eventId;
  assert.ok(
    id.startsWith(`optimizer.auto.promoted:${s.schedulerInstanceId}:`),
    `eventId starts with expected prefix, got: ${id}`,
  );

  s.db.close();
});
