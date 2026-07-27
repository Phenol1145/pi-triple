/**
 * context-experiment OptimizationRound lifecycle integration tests
 *
 * Phase 6c T1: Prove the FULL generic lifecycle on a context-experiment instance.
 *
 * Covers:
 * - createExperimentInstance → active instance with round:0
 * - submitProposal (change assignments: add strategy variant / change strategyConfig)
 *   → all six gates tested:
 *     1. Instance/optimizer existence + targeting
 *     2. Version compatibility
 *     3. Baseline freshness (stale rejected)
 *     4. Schema validation (bad-shape parameters rejected)
 *     5. Transition validation
 *     6. Tunable-paths check (whole-leaf array diff → "assignments";
 *        untunable path change rejected)
 * - promoteRound → new active round (sequence MAX+1), old superseded,
 *   optimizer+proposalId traceability, supersedes other pending proposals
 * - dispatch/schedule under new round uses NEW assignments
 * - rollbackRound → assignments revert via new round
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { createLabCore } from "../src/core/create-core.ts";
import type { LabCore } from "../src/core/create-core.ts";
import {
  ProposalRejectedError,
  InstanceNotActiveError,
} from "../src/core/control-plane/service.ts";
import type {
  SchedulerDefinition,
  OptimizerDefinition,
} from "../src/core/contracts.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import {
  BUDGETED_HISTORY_DEFINITION,
  registerWorkLoopDefinition,
} from "../src/runtime/create-experiment-runtime.ts";
import {
  contextExperimentDefinition,
  createExperimentInstance,
  createContextExperiment,
  type Assignment,
  type ContextExperimentParameters,
} from "../src/schedulers/context-experiment.ts";
import type { SchedulingInput, SchedulerSDK } from "../src/scheduler/contracts.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function makeCore(db: DatabaseSync): LabCore {
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  registerWorkLoopDefinition(core, structuredClone(BUDGETED_HISTORY_DEFINITION));
  // Register selective-summary workloop definition stub
  core.definitions.register({
    kind: "workloop" as const,
    id: "selective-summary",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        budgetTokens: { type: "number", default: 8192 },
      },
      required: ["model"],
    },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
  });
  return core;
}

function optimizerDef(overrides: Partial<OptimizerDefinition> = {}): OptimizerDefinition {
  return {
    kind: "optimizer",
    id: "context-experiment-tuner",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configurationSchema: { type: "object" },
    requiredMetrics: ["runs"],
    compatibleSchedulers: [
      { id: "context-experiment", versionRange: "^1.0.0" },
    ],
    parameterModelVersionRange: "^1.0.0",
    ...overrides,
  };
}

function setup(opts: {
  instanceId?: string;
  initialAssignments?: Assignment[];
} = {}): {
  db: DatabaseSync;
  core: LabCore;
  schedulerInstanceId: string;
  optimizerInstanceId: string;
  round0Id: string;
  initialParams: ContextExperimentParameters;
} {
  const db = memoryDB();
  const core = makeCore(db);

  const instanceId = opts.instanceId ?? "context-experiment";
  const initialAssignments = opts.initialAssignments ?? [
    { model: "openai/gpt-4o", strategy: "default" as const },
    { model: "openai/gpt-4o", strategy: "budgeted-history" as const, strategyConfig: { budgetTokens: 4096 } },
  ];

  // Create the experiment instance (validates + activates)
  createExperimentInstance(core, {
    instanceId,
    assignments: initialAssignments,
  });

  // Register optimizer definition
  core.definitions.register(optimizerDef());

  // Create optimizer instance targeting this scheduler
  const optimizerInstanceId = "tuner-ctx";
  core.repository.insertOptimizerInstance({
    id: optimizerInstanceId,
    definitionId: "context-experiment-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: [instanceId],
    status: "active",
    createdAt: 900,
  });

  const round0 = core.repository.getRound(`${instanceId}:round:0`)!;

  return {
    db,
    core,
    schedulerInstanceId: instanceId,
    optimizerInstanceId,
    round0Id: round0.id,
    initialParams: round0.parameters as ContextExperimentParameters,
  };
}

function fakeSdk(agents: Array<{ id: string }> = []): SchedulerSDK & { _events: Array<{ name: string; data: unknown }> } {
  const agentList = [...agents];
  const events: Array<{ name: string; data: unknown }> = [];
  return {
    agents: {
      async list() {
        return agentList.map((a) => ({
          id: a.id,
          definition: { standard: {}, workLoop: {}, custom: {} } as any,
          status: "ready" as const,
        }));
      },
      async create(spec) {
        agentList.push({ id: spec.id });
        return { id: spec.id };
      },
      async run(agentId, _req) {
        return { status: "completed" as const, output: { text: `ran ${agentId}` } };
      },
    },
    storage: {
      get() { return undefined; },
      put(key, value) { return { value, version: 0 }; },
    },
    telemetry: {
      emit(name, data) {
        events.push({ name, data });
      },
    },
    control: { signal: new AbortController().signal },
    _events: events,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Section 1: Gate 1 — Instance / optimizer existence
// ═══════════════════════════════════════════════════════════════════

test("gate 1: rejects on missing scheduler instance", () => {
  const { core, optimizerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, "nonexistent", {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [
            { model: "openai/gpt-4o", strategy: "default" },
          ],
        },
      }),
    ProposalRejectedError,
  );
});

test("gate 1: rejects on missing optimizer instance", () => {
  const { core, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal("nonexistent", schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [
            { model: "openai/gpt-4o", strategy: "default" },
          ],
        },
      }),
    ProposalRejectedError,
  );
});

test("gate 1: rejects when optimizer does not target scheduler", () => {
  const { core, schedulerInstanceId } = setup();
  // Create second optimizer NOT targeting this scheduler
  core.definitions.register(
    optimizerDef({ id: "other-tuner", compatibleSchedulers: [{ id: "other", versionRange: "^1.0.0" }] }),
  );
  core.repository.insertOptimizerInstance({
    id: "tuner-other",
    definitionId: "other-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: ["other"],
    status: "active",
    createdAt: 950,
  });
  assert.throws(
    () =>
      core.controlPlane.submitProposal("tuner-other", schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
        },
      }),
    ProposalRejectedError,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Section 2: Gate 2 — Version compatibility
// ═══════════════════════════════════════════════════════════════════

test("gate 2: rejects on incompatible scheduler version", () => {
  const { core, schedulerInstanceId } = setup();
  // Re-register optimizer def with narrow version range
  core.definitions.register(
    optimizerDef({
      version: "2.0.0",
      compatibleSchedulers: [
        { id: "context-experiment", versionRange: "^9.0.0" },
      ],
    }),
  );
  core.repository.insertOptimizerInstance({
    id: "tuner-bad-ver",
    definitionId: "context-experiment-tuner",
    definitionVersion: "2.0.0",
    config: {},
    targetSchedulers: [schedulerInstanceId],
    status: "active",
    createdAt: 960,
  });
  assert.throws(
    () =>
      core.controlPlane.submitProposal("tuner-bad-ver", schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
        },
      }),
    ProposalRejectedError,
  );
});

test("gate 2: rejects on incompatible parameterModelVersion", () => {
  const { core, schedulerInstanceId } = setup();
  core.definitions.register(
    optimizerDef({
      version: "1.0.1",
      parameterModelVersionRange: "^5.0.0",
    }),
  );
  core.repository.insertOptimizerInstance({
    id: "tuner-bad-pmv",
    definitionId: "context-experiment-tuner",
    definitionVersion: "1.0.1",
    config: {},
    targetSchedulers: [schedulerInstanceId],
    status: "active",
    createdAt: 970,
  });
  assert.throws(
    () =>
      core.controlPlane.submitProposal("tuner-bad-pmv", schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
        },
      }),
    ProposalRejectedError,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Section 3: Gate 3 — Baseline freshness
// ═══════════════════════════════════════════════════════════════════

test("gate 3: rejects stale baseline", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:99",
        parameters: {
          assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
        },
      }),
    ProposalRejectedError,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Section 4: Gate 4 — Schema validation (bad-shape parameters)
// ═══════════════════════════════════════════════════════════════════

test("gate 4: rejects non-object parameters", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: null,
      }),
    ProposalRejectedError,
  );
});

test("gate 4: rejects missing assignments key", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {},
      }),
    ProposalRejectedError,
  );
});

test("gate 4: rejects non-array assignments", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: { assignments: "not-array" },
      }),
    ProposalRejectedError,
  );
});

test("gate 4: rejects unknown strategy name", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [{ model: "openai/gpt-4o", strategy: "magic-context" }],
        },
      }),
    ProposalRejectedError,
  );
});

test("gate 4: rejects missing model field", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [{ strategy: "default" }],
        },
      }),
    ProposalRejectedError,
  );
});

test("gate 4: rejects duplicate model+strategy pairs", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [
            { model: "openai/gpt-4o", strategy: "default" },
            { model: "openai/gpt-4o", strategy: "default" },
          ],
        },
      }),
    ProposalRejectedError,
  );
});

test("gate 4: rejects unknown top-level key", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();
  assert.throws(
    () =>
      core.controlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, {
        baseRoundId: "context-experiment:round:0",
        parameters: {
          assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
          extraField: 123,
        },
      }),
    ProposalRejectedError,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Section 5: Gate 5 — Transition validation
// ═══════════════════════════════════════════════════════════════════

test("gate 5: transition validation passes on valid assignments change", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  // Submit a proposal with a new assignments shape — transition validator
  // accepts any valid assignments (it just delegates to validateParameters)
  const result = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  assert.ok(result.proposalId);
  assert.ok(result.candidateRoundId);
});

test("gate 5: transition validation rejects invalid proposed shape", () => {
  // Isolated: register a scheduler with transition that rejects empty assignments
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  registerWorkLoopDefinition(core, structuredClone(BUDGETED_HISTORY_DEFINITION));
  core.definitions.register({
    kind: "workloop" as const, id: "selective-summary", version: "1.0.0",
    sdkVersionRange: "^1.0.0", configSchema: { type: "object" },
    requiredCapabilities: [], cloneModes: ["fresh"],
  });

  // Register a copy of contextExperimentDefinition with restrictive transition
  core.definitions.register({
    ...contextExperimentDefinition,
    id: "ctx-transition-test",
    validateTransition: (_current, proposed) => {
      const p = proposed as ContextExperimentParameters;
      if ((p as any)?.assignments?.length === 0) {
        return { ok: false, issues: [{ path: "assignments", code: "EMPTY", message: "must have at least one assignment" }] };
      }
      return contextExperimentDefinition.validateParameters(proposed);
    },
  } as SchedulerDefinition);

  // Register optimizer compatible with this custom scheduler
  core.definitions.register(optimizerDef({
    compatibleSchedulers: [{ id: "ctx-transition-test", versionRange: "^1.0.0" }],
  }));

  // Create instance manually
  core.controlPlane.createDraft({
    id: "ttest",
    schedulerDefinition: { kind: "scheduler", id: "ctx-transition-test", version: "1.0.0" },
    initialParameters: {
      assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
    },
    agents: [
      {
        id: "agent-openai__gpt-4o-default",
        definition: {
          standard: { name: "GPT-4o", capabilities: [], executionKind: "experiment-variant", labels: { strategy: "default" } },
          workLoop: { id: "pi-default-loop", version: "1.0.0", config: { model: "openai/gpt-4o" } },
          custom: {},
        },
      },
    ],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [],
  });
  core.controlPlane.validateDraft("ttest");
  core.controlPlane.activateDraft("ttest");

  core.repository.insertOptimizerInstance({
    id: "tuner-ttest",
    definitionId: "context-experiment-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: ["ttest"],
    status: "active",
    createdAt: 900,
  });

  // Proposing empty assignments should fail transition validation
  assert.throws(
    () =>
      core.controlPlane.submitProposal("tuner-ttest", "ttest", {
        baseRoundId: "ttest:round:0",
        parameters: { assignments: [] },
      }),
    ProposalRejectedError,
  );

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Section 6: Gate 6 — Tunable-paths check (whole-leaf array diff)
// ═══════════════════════════════════════════════════════════════════

test("gate 6: assignments change passes with tunablePaths=['assignments'] (whole-leaf)", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  // Context-experiment has tunablePaths: ["assignments"].
  // Changing assignments produces diff path "assignments" (whole-leaf array diff).
  // This matches tunablePaths exactly — should pass.
  const result = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  assert.ok(result.proposalId);
});

test("gate 6: rejects assignments change when tunablePaths is restrictive (whole-leaf diff)", () => {
  // Isolated setup: register context-experiment def with tunablePaths: []
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  registerWorkLoopDefinition(core, structuredClone(BUDGETED_HISTORY_DEFINITION));
  core.definitions.register({
    kind: "workloop" as const, id: "selective-summary", version: "1.0.0",
    sdkVersionRange: "^1.0.0", configSchema: { type: "object" },
    requiredCapabilities: [], cloneModes: ["fresh"],
  });

  // Register a copy with tunablePaths: [] (nothing tunable)
  const restrictedDef: SchedulerDefinition = {
    ...contextExperimentDefinition,
    id: "ctx-restricted",
    tunablePaths: [],
  };
  core.definitions.register(restrictedDef);

  core.definitions.register(optimizerDef({
    compatibleSchedulers: [{ id: "ctx-restricted", versionRange: "^1.0.0" }],
  }));

  // Create instance manually with the restricted def
  core.controlPlane.createDraft({
    id: "restr",
    schedulerDefinition: { kind: "scheduler", id: "ctx-restricted", version: "1.0.0" },
    initialParameters: {
      assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
    },
    agents: [
      {
        id: "agent-openai__gpt-4o-default",
        definition: {
          standard: { name: "GPT-4o", capabilities: [], executionKind: "experiment-variant", labels: { strategy: "default" } },
          workLoop: { id: "pi-default-loop", version: "1.0.0", config: { model: "openai/gpt-4o" } },
          custom: {},
        },
      },
    ],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [],
  });
  core.controlPlane.validateDraft("restr");
  core.controlPlane.activateDraft("restr");

  core.repository.insertOptimizerInstance({
    id: "tuner-restr",
    definitionId: "context-experiment-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: ["restr"],
    status: "active",
    createdAt: 900,
  });

  // Changing assignments should fail gate 6 because tunablePaths is []
  assert.throws(
    () =>
      core.controlPlane.submitProposal("tuner-restr", "restr", {
        baseRoundId: "restr:round:0",
        parameters: {
          assignments: [
            { model: "openai/gpt-4o", strategy: "default" },
            { model: "openai/gpt-4o", strategy: "budgeted-history" },
          ],
        },
      }),
    ProposalRejectedError,
  );

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Section 7: Successful submitProposal — pending proposal + candidate round
// ═══════════════════════════════════════════════════════════════════

test("submitProposal: creates pending proposal, candidate round, events with context-experiment params", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  const newAssignments: Assignment[] = [
    { model: "openai/gpt-4o", strategy: "default" },
    { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 8192 } },
    { model: "openai/gpt-4o", strategy: "selective-summary" },
  ];

  const result = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: { assignments: newAssignments },
    },
  );

  assert.ok(result.proposalId);
  assert.ok(result.candidateRoundId);
  assert.ok(result.candidateRoundId.startsWith("context-experiment:round:"));

  // Proposal persisted as pending
  const proposal = core.repository.getProposal(result.proposalId);
  assert.ok(proposal);
  assert.equal(proposal!.status, "pending");
  assert.equal(proposal!.candidateRoundId, result.candidateRoundId);

  // Candidate round: proposed status, sequence=1, correct parameters
  const candidate = core.repository.getRound(result.candidateRoundId);
  assert.ok(candidate);
  assert.equal(candidate!.status, "proposed");
  assert.equal(candidate!.sequence, 1);
  assert.equal(candidate!.parentRoundId, "context-experiment:round:0");
  assert.equal(candidate!.proposalId, result.proposalId);
  assert.equal(candidate!.optimizer?.instanceId, optimizerInstanceId);

  const params = candidate!.parameters as ContextExperimentParameters;
  assert.equal(params.assignments.length, 3);
  assert.equal(params.assignments[1].strategyConfig?.budgetTokens, 8192);
  assert.equal(params.assignments[2].strategy, "selective-summary");

  // Events emitted
  const submitted = core.events.query({ eventType: "optimizer.proposal.submitted" });
  assert.equal(submitted.length, 1);

  const proposed = core.events.query({ eventType: "round.proposed" });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].identity.optimizationRoundId, result.candidateRoundId);
});

// ═══════════════════════════════════════════════════════════════════
// Section 8: promoteRound — full lifecycle
// ═══════════════════════════════════════════════════════════════════

test("promoteRound: new active round, old superseded, traceability intact", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  // Submit a proposal adding a third variant
  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 8192 } },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );

  const result = core.controlPlane.promoteRound(sub.candidateRoundId);

  assert.ok(result.newRoundId);
  assert.ok(result.newRoundId.startsWith("context-experiment:round:"));

  // New round is active with sequence 2 (after candidate at seq 1)
  const newRound = core.repository.getRound(result.newRoundId);
  assert.ok(newRound);
  assert.equal(newRound!.status, "active");
  assert.equal(newRound!.sequence, 2);
  assert.equal(newRound!.parentRoundId, "context-experiment:round:0");

  // Parameters carry the new assignments
  const params = newRound!.parameters as ContextExperimentParameters;
  assert.equal(params.assignments.length, 3);
  assert.equal(params.assignments[1].strategy, "budgeted-history");
  assert.equal(params.assignments[1].strategyConfig?.budgetTokens, 8192);
  assert.equal(params.assignments[2].strategy, "selective-summary");

  // Traceability: optimizer + proposalId
  assert.equal(newRound!.proposalId, sub.proposalId);
  assert.equal(newRound!.optimizer?.instanceId, optimizerInstanceId);
  assert.ok(newRound!.activatedAt);

  // Old round 0 → superseded
  const oldRound = core.repository.getRound("context-experiment:round:0");
  assert.equal(oldRound!.status, "superseded");

  // Candidate → superseded
  const candidate = core.repository.getRound(sub.candidateRoundId);
  assert.equal(candidate!.status, "superseded");

  // Instance currentRoundId switched
  const instance = core.repository.getInstance(schedulerInstanceId);
  assert.equal(instance!.currentRoundId, result.newRoundId);

  // Proposal → accepted with promoted_round_id
  const proposal = core.repository.getProposal(sub.proposalId);
  assert.equal(proposal!.status, "accepted");
  assert.equal(proposal!.promotedRoundId, result.newRoundId);

  // Event: round.promoted
  const promoted = core.events.query({ eventType: "round.promoted" });
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].identity.optimizationRoundId, result.newRoundId);
});

test("promoteRound: supersedes other pending proposals and their candidate rounds", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  // Submit two proposals
  const sub1 = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );

  const sub2 = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 16384 } },
        ],
      },
    },
  );

  // Promote sub1
  core.controlPlane.promoteRound(sub1.candidateRoundId);

  // sub1 → accepted
  assert.equal(core.repository.getProposal(sub1.proposalId)!.status, "accepted");

  // sub2 → superseded
  const p2 = core.repository.getProposal(sub2.proposalId);
  assert.equal(p2!.status, "superseded");

  // sub2's candidate → superseded
  const c2 = core.repository.getRound(sub2.candidateRoundId);
  assert.equal(c2!.status, "superseded");

  // superseded events
  const supersededEvents = core.events.query({ eventType: "optimizer.proposal.superseded" });
  assert.equal(supersededEvents.length, 1);
  assert.equal(supersededEvents[0].identity.proposalId, sub2.proposalId);
});

test("promoteRound: re-validates against current round for context-experiment", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  // Submit valid proposal against round 0
  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );

  // Promote it
  core.controlPlane.promoteRound(sub.candidateRoundId);

  // Now create a corrupt candidate (unknown strategy) that would fail re-validation
  const instance = core.repository.getInstance(schedulerInstanceId);
  const fakeCandidateId = `${schedulerInstanceId}:round:fake`;
  core.repository.insertRound({
    id: fakeCandidateId,
    schedulerInstanceId,
    sequence: 99,
    parameters: {
      assignments: [{ model: "openai/gpt-4o", strategy: "magic-context" }],
    },
    optimizer: { instanceId: optimizerInstanceId, definitionId: "context-experiment-tuner", definitionVersion: "1.0.0" },
    proposalId: "fake-prop",
    status: "proposed",
    createdAt: 2000,
  });
  core.repository.insertProposal({
    id: "fake-prop",
    optimizerInstanceId,
    schedulerInstanceId,
    baseRoundId: instance!.currentRoundId,
    parameters: { assignments: [{ model: "openai/gpt-4o", strategy: "magic-context" }] },
    status: "pending",
    candidateRoundId: fakeCandidateId,
    createdAt: 2000,
  });

  // Promoting should fail because re-validation catches unknown strategy
  assert.throws(
    () => core.controlPlane.promoteRound(fakeCandidateId),
    { message: /re-validation schema/ },
  );
});

// ═══════════════════════════════════════════════════════════════════
// Section 9: Dispatch under new round uses NEW assignments
// ═══════════════════════════════════════════════════════════════════

test("dispatch: schedule uses promoted round's new assignments", async () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  // Submit + promote new assignments (add selective-summary variant)
  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 2048 } },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  const promoteResult = core.controlPlane.promoteRound(sub.candidateRoundId);

  // Get the new active round's parameters
  const newRound = core.repository.getRound(promoteResult.newRoundId);
  assert.ok(newRound);
  const newParams = newRound!.parameters as ContextExperimentParameters;

  // Schedule with the new round's params — should use new assignments
  const { implementation } = createContextExperiment();
  const sdk = fakeSdk();
  const result = await implementation.schedule(
    {
      traceId: "t-dispatch",
      dispatchId: "d-dispatch",
      role: "coder",
      task: "test dispatch under new round",
      mode: "execute",
      labels: { strategy: "selective-summary" },
    },
    newParams,
    sdk,
  );

  // Should pick the selective-summary variant (which exists only in new params)
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.selectedAgentId, "agent-openai__gpt-4o-selective-summary");
    assert.equal(result.model, "openai/gpt-4o");
    assert.ok((result.reason as string).includes("selective-summary"));
  }

  // Telemetry confirms 3 assignments were available
  const pickEvents = sdk._events.filter((e) => e.name === "scheduler.context_experiment.pick");
  assert.equal(pickEvents.length, 1);
  assert.equal((pickEvents[0].data as any).totalAssignments, 3);
  assert.equal((pickEvents[0].data as any).strategy, "selective-summary");
});

test("dispatch: initial round uses original assignments, promoted round uses new assignments", async () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  // Get initial round's params (2 variants: default, budgeted-history)
  const round0 = core.repository.getRound("context-experiment:round:0");
  const initialParams = round0!.parameters as ContextExperimentParameters;
  assert.equal(initialParams.assignments.length, 2);

  // Schedule with initial params — selective-summary shouldn't exist
  const { implementation } = createContextExperiment();
  const sdk0 = fakeSdk();
  const result0 = await implementation.schedule(
    {
      traceId: "t0",
      dispatchId: "d0",
      role: "coder",
      task: "test initial round",
      mode: "execute",
      labels: { strategy: "selective-summary" },
    },
    initialParams,
    sdk0,
  );
  // Falls back to first assignment
  assert.equal(result0.status, "completed");
  if (result0.status === "completed") {
    // Should fall back to default (first assignment) since selective-summary isn't found
    assert.equal(result0.selectedAgentId, "agent-openai__gpt-4o-default");
  }

  // Now promote new assignments with selective-summary
  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 2048 } },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  const promoteResult = core.controlPlane.promoteRound(sub.candidateRoundId);

  const newRound = core.repository.getRound(promoteResult.newRoundId);
  const newParams = newRound!.parameters as ContextExperimentParameters;
  assert.equal(newParams.assignments.length, 3);

  // Schedule with promoted params — selective-summary should be found
  const sdk1 = fakeSdk();
  const result1 = await implementation.schedule(
    {
      traceId: "t1",
      dispatchId: "d1",
      role: "coder",
      task: "test promoted round",
      mode: "execute",
      labels: { strategy: "selective-summary" },
    },
    newParams,
    sdk1,
  );
  assert.equal(result1.status, "completed");
  if (result1.status === "completed") {
    assert.equal(result1.selectedAgentId, "agent-openai__gpt-4o-selective-summary");
  }
});

// ═══════════════════════════════════════════════════════════════════
// Section 10: rollbackRound — assignments revert via new round
// ═══════════════════════════════════════════════════════════════════

test("rollbackRound: creates new active round with target parameters, rolls back current", () => {
  const { core, schedulerInstanceId } = setup();

  // First promote a change so we have a superseded round to roll back to
  const sub = core.controlPlane.submitProposal(
    "tuner-ctx",
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  const promoteResult = core.controlPlane.promoteRound(sub.candidateRoundId);

  // Now round:0 is superseded. Rollback to round:0
  const result = core.controlPlane.rollbackRound(
    schedulerInstanceId,
    "context-experiment:round:0",
  );

  assert.ok(result.newRoundId);
  assert.ok(result.newRoundId.startsWith("context-experiment:round:"));

  const newRound = core.repository.getRound(result.newRoundId);
  assert.ok(newRound);
  assert.equal(newRound!.status, "active");

  // Should copy round:0's original parameters (2 assignments, no selective-summary)
  const params = newRound!.parameters as ContextExperimentParameters;
  assert.equal(params.assignments.length, 2);
  assert.equal(params.assignments[0].strategy, "default");
  assert.equal(params.assignments[1].strategy, "budgeted-history");
  assert.equal(params.assignments[1].strategyConfig?.budgetTokens, 4096);

  // Optimizer/proposalId EMPTY (rollback doesn't carry optimizer trace)
  assert.equal(newRound!.optimizer, undefined);
  assert.equal(newRound!.proposalId, undefined);

  // Old current → rolled-back
  const oldCurrent = core.repository.getRound(promoteResult.newRoundId);
  assert.equal(oldCurrent!.status, "rolled-back");

  // Instance currentRoundId switched
  const instance = core.repository.getInstance(schedulerInstanceId);
  assert.equal(instance!.currentRoundId, result.newRoundId);

  // Event: round.rolled-back
  const rolledBackEvents = core.events.query({ eventType: "round.rolled-back" });
  assert.equal(rolledBackEvents.length, 1);
  assert.equal(rolledBackEvents[0].identity.optimizationRoundId, result.newRoundId);
  assert.equal((rolledBackEvents[0].payload as Record<string, unknown>).actor, "manual");
});

test("rollbackRound: supersedes pending proposals", () => {
  const { core, schedulerInstanceId } = setup();

  // Promote first change
  const sub = core.controlPlane.submitProposal(
    "tuner-ctx",
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  core.controlPlane.promoteRound(sub.candidateRoundId);

  // Submit another proposal (now pending)
  const instance = core.repository.getInstance(schedulerInstanceId);
  const pendingSub = core.controlPlane.submitProposal(
    "tuner-ctx",
    schedulerInstanceId,
    {
      baseRoundId: instance!.currentRoundId,
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 999 } },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );

  // Rollback to round:0
  core.controlPlane.rollbackRound(schedulerInstanceId, "context-experiment:round:0");

  // The pending proposal should be superseded
  const p = core.repository.getProposal(pendingSub.proposalId);
  assert.equal(p!.status, "superseded");
});

test("rollbackRound: dispatch after rollback uses reverted assignments", async () => {
  const { core, schedulerInstanceId } = setup();

  // Promote a change (add selective-summary)
  const sub = core.controlPlane.submitProposal(
    "tuner-ctx",
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  core.controlPlane.promoteRound(sub.candidateRoundId);

  // Rollback to round:0 (original: default + budgeted-history)
  const rollbackResult = core.controlPlane.rollbackRound(
    schedulerInstanceId,
    "context-experiment:round:0",
  );

  // Get the rollback round's parameters
  const newRound = core.repository.getRound(rollbackResult.newRoundId);
  assert.ok(newRound);
  const params = newRound!.parameters as ContextExperimentParameters;
  assert.equal(params.assignments.length, 2);
  // selective-summary was NOT in the original, so it should not be here
  const hasSelectiveSummary = params.assignments.some((a) => a.strategy === "selective-summary");
  assert.equal(hasSelectiveSummary, false);

  // Schedule with rollback params — selective-summary should NOT be found
  const { implementation } = createContextExperiment();
  const sdk = fakeSdk();
  const result = await implementation.schedule(
    {
      traceId: "t-rollback",
      dispatchId: "d-rollback",
      role: "coder",
      task: "test after rollback",
      mode: "execute",
      labels: { strategy: "selective-summary" },
    },
    params,
    sdk,
  );

  // Falls back to first assignment (default)
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.selectedAgentId, "agent-openai__gpt-4o-default");
  }
});

// ═══════════════════════════════════════════════════════════════════
// Section 11: Event identity carries trace fields
// ═══════════════════════════════════════════════════════════════════

test("submitProposal events carry schedulerInstanceId, optimizerInstanceId, proposalId", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );

  const submittedEvents = core.events.query({ eventType: "optimizer.proposal.submitted" });
  assert.equal(submittedEvents.length, 1);
  assert.equal(submittedEvents[0].identity.schedulerInstanceId, schedulerInstanceId);
  assert.equal(submittedEvents[0].identity.optimizerInstanceId, optimizerInstanceId);
  assert.equal(submittedEvents[0].identity.proposalId, sub.proposalId);
  assert.ok(submittedEvents[0].identity.optimizationRoundId);

  const proposedEvents = core.events.query({ eventType: "round.proposed" });
  assert.equal(proposedEvents.length, 1);
  assert.equal(proposedEvents[0].identity.schedulerInstanceId, schedulerInstanceId);
  assert.equal(proposedEvents[0].identity.optimizationRoundId, sub.candidateRoundId);
});

// ═══════════════════════════════════════════════════════════════════
// Section 12: promoteRound defensive checks
// ═══════════════════════════════════════════════════════════════════

test("promoteRound: rejects already-superseded candidate", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  const sub1 = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "selective-summary" },
        ],
      },
    },
  );
  const sub2 = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [
          { model: "openai/gpt-4o", strategy: "default" },
          { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 999 } },
        ],
      },
    },
  );

  // Promote sub1 → sub2's candidate becomes superseded
  core.controlPlane.promoteRound(sub1.candidateRoundId);

  // Trying to promote sub2's candidate should fail
  assert.throws(
    () => core.controlPlane.promoteRound(sub2.candidateRoundId),
    { message: /proposed or validated/ },
  );
});

test("promoteRound: throws InstanceNotActiveError for inactive instance", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
      },
    },
  );

  // Manually set instance inactive
  core.repository["db"].exec(
    `UPDATE lab_scheduler_instances SET status = 'inactive' WHERE id = 'context-experiment'`,
  );

  assert.throws(
    () => core.controlPlane.promoteRound(sub.candidateRoundId),
    InstanceNotActiveError,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Section 13: rollbackRound target constraints
// ═══════════════════════════════════════════════════════════════════

test("rollbackRound: rejects target = currentRoundId", () => {
  const { core, schedulerInstanceId } = setup();
  assert.throws(
    () => core.controlPlane.rollbackRound(schedulerInstanceId, "context-experiment:round:0"),
    { message: /cannot rollback to current round/ },
  );
});

test("rollbackRound: rejects target with disallowed status (proposed)", () => {
  const { core, optimizerInstanceId, schedulerInstanceId } = setup();

  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    schedulerInstanceId,
    {
      baseRoundId: "context-experiment:round:0",
      parameters: {
        assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
      },
    },
  );

  assert.throws(
    () => core.controlPlane.rollbackRound(schedulerInstanceId, sub.candidateRoundId),
    { message: /status proposed/ },
  );
});

// ═══════════════════════════════════════════════════════════════════
// Section 14: Custom instanceId lifecycle
// ═══════════════════════════════════════════════════════════════════

test("full lifecycle: works with custom instanceId", () => {
  const { core, optimizerInstanceId } = setup({ instanceId: "my-experiment" });

  // Submit + promote with custom instance
  const sub = core.controlPlane.submitProposal(
    optimizerInstanceId,
    "my-experiment",
    {
      baseRoundId: "my-experiment:round:0",
      parameters: {
        assignments: [
          { model: "anthropic/claude-3", strategy: "default" },
          { model: "anthropic/claude-3", strategy: "selective-summary" },
        ],
      },
    },
  );

  const promoteResult = core.controlPlane.promoteRound(sub.candidateRoundId);
  assert.ok(promoteResult.newRoundId.startsWith("my-experiment:round:"));

  const instance = core.repository.getInstance("my-experiment");
  assert.equal(instance!.currentRoundId, promoteResult.newRoundId);

  // Rollback
  const rbResult = core.controlPlane.rollbackRound("my-experiment", "my-experiment:round:0");
  assert.ok(rbResult.newRoundId);

  const rbParams = core.repository.getRound(rbResult.newRoundId)!
    .parameters as ContextExperimentParameters;
  assert.equal(rbParams.assignments.length, 2);
  assert.equal(rbParams.assignments[0].model, "openai/gpt-4o");
});
