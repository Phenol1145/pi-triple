/**
 * Context experiment integration test — end-to-end with fake ModelPort.
 *
 * Task 5 of `docs/plans/2026-07-27-agent-lab-phase-6b-selective-summary-projection.md`:
 *
 * (a) Per-strategy event chains: budgeted-history → context.transformed truncate;
 *     selective-summary → context.summary.created + context.transformed summarize;
 *     default → model.requested/completed only, no transforms.
 * (b) Projection compare output aggregates per strategy correctly,
 *     incl. summaryCost in the summary bucket.
 * (c) Storage/checkpoint namespace isolation across 3 variants (same model).
 * (d) Round/agents traceable: instance currentRoundId, agent createdAtRoundId.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import {
  createExperimentRuntime,
  registerWorkLoopDefinition,
  BUDGETED_HISTORY_DEFINITION,
  SELECTIVE_SUMMARY_DEFINITION,
} from "../src/runtime/create-experiment-runtime.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import { budgetedHistory } from "../src/workloops/budgeted-history.ts";
import { selectiveSummary } from "../src/workloops/selective-summary.ts";
import {
  contextExperimentDefinition,
  createExperimentInstance,
  experimentAgentId,
  type Assignment,
  type ContextExperimentParameters,
} from "../src/schedulers/context-experiment.ts";
import { projectContextStrategies } from "../src/optimizer/context-projector.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import type {
  ModelPort,
  ToolPort,
  ArtifactPort,
  WorkContext,
  WorkMessage,
  StandardAgentOutput,
  WorkLoopImplementation,
  LabEvent,
} from "../src/core/contracts.ts";

// ── Fake ModelPort ──────────────────────────────────────────────────

class FakeModelPort implements ModelPort {
  callLog: Array<{ context: WorkContext; options?: Record<string, unknown> }> = [];
  private responses: Array<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }>;
  private idx = 0;

  constructor(responses: Array<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }>) {
    this.responses = responses;
  }

  async complete(
    context: WorkContext,
    options?: Record<string, unknown>,
  ): Promise<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }> {
    this.callLog.push({ context, options });
    const r = this.responses[this.idx] ?? this.responses[this.responses.length - 1];
    if (!r) throw new Error("no fake response configured");
    this.idx++;
    return { ...r, message: { ...r.message }, usage: r.usage ? { ...r.usage } : undefined };
  }
}

// ── Fake ToolPort / ArtifactPort ─────────────────────────────────────

function fakeTools(): ToolPort {
  return { execute: async () => { throw new Error("no tools in managed loop"); } };
}

function fakeArtifacts(): ArtifactPort {
  const store = new Map<string, unknown>();
  return {
    put: async (v: unknown) => {
      const ref = `art-${crypto.randomUUID()}`;
      store.set(ref, v);
      return ref;
    },
    get: async (ref: string) => store.get(ref),
  };
}

// ── Over-budget context builder ──────────────────────────────────────

/**
 * Build a context with enough messages to exceed a budgetTokens of 8192.
 * 700 messages × ~50 chars each → ~8750 estimated tokens (chars/4).
 */
function overBudgetContext(): WorkContext {
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 700; i++) {
    messages.push({ role: "user" as const, content: `msg ${i} `.repeat(10) });
  }
  return {
    systemPrompt: "you are a helpful assistant",
    messages,
    metadata: {
      contextId: "ctx-large",
      sourceRefs: [],
      artifactRefs: [],
    },
  };
}

// ── pi-default-loop stub (simple model-complete only) ───────────────

const piDefaultLoopStub: WorkLoopImplementation = {
  id: "pi-default-loop",
  version: "1.0.0",
  cloneModes: ["fresh", "fork"],

  initialContext(config: unknown): WorkContext {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      systemPrompt: typeof cfg?.systemPrompt === "string" ? cfg.systemPrompt : undefined,
      messages: [],
      metadata: { contextId: "ctx-initial", sourceRefs: [], artifactRefs: [] },
    };
  },

  initialState(_config: unknown): unknown {
    return {};
  },

  async run(input: { context: WorkContext; config: unknown; task: string; state: unknown },
    sdk: { model: ModelPort; context: { append: (ctx: WorkContext, msgs: WorkMessage[], id: string) => WorkContext } },
  ) {
    const result = await sdk.model.complete(input.context);

    const newContextId = `ctx-${crypto.randomUUID()}`;
    const newContext = sdk.context.append(
      input.context,
      [result.message],
      newContextId,
    );

    const usage = result.usage ?? {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
      toolCalls: 0,
      durationMs: 0,
    };

    return {
      status: "completed" as const,
      output: {
        standard: {
          text: typeof result.message.content === "string" ? result.message.content : "",
          usage,
        },
      },
      context: newContext,
      state: input.state,
    };
  },
};

// ── Setup ────────────────────────────────────────────────────────────

interface SetupResult {
  rt: ReturnType<typeof createExperimentRuntime>;
  db: DatabaseSync;
  fakeModel: FakeModelPort;
  agents: string[];
  instanceId: string;
  roundId: string;
}

async function setupFullExperiment(overBudget?: boolean): SetupResult {
  const db = new DatabaseSync(":memory:");
  const over = overBudget ?? true;

  // More responses for summary + main calls per variant
  const fakeModel = new FakeModelPort([
    // default variant: simple model call
    {
      message: { role: "assistant", content: "default response" },
      usage: { input: 30, output: 15, cacheRead: 0, cacheWrite: 0, cost: 0.0003, turns: 1, toolCalls: 0, durationMs: 120 },
    },
    // budgeted-history: simple model call (transform is pure truncation)
    {
      message: { role: "assistant", content: "budgeted response" },
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.0002, turns: 1, toolCalls: 0, durationMs: 100 },
    },
    // selective-summary: summary call
    {
      message: { role: "assistant", content: "summary of old stuff" },
      usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.002, turns: 1, toolCalls: 0, durationMs: 200 },
    },
    // selective-summary: main model call after summary
    {
      message: { role: "assistant", content: "selective response" },
      usage: { input: 15, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1, toolCalls: 0, durationMs: 80 },
    },
  ]);

  const rt = createExperimentRuntime(db, {
    model: fakeModel,
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  // Register workloop definitions
  rt.core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  registerWorkLoopDefinition(rt.core, structuredClone(BUDGETED_HISTORY_DEFINITION));
  registerWorkLoopDefinition(rt.core, structuredClone(SELECTIVE_SUMMARY_DEFINITION));

  // Register implementations
  rt.workloopRegistry.register(piDefaultLoopStub);
  rt.workloopRegistry.register(budgetedHistory);
  rt.workloopRegistry.register(selectiveSummary);

  // Register scheduler definition
  try {
    rt.core.definitions.register(contextExperimentDefinition);
  } catch {
    // idempotent
  }

  // Create experiment instance
  const assignments: Assignment[] = [
    { model: "test-model", strategy: "default" },
    { model: "test-model", strategy: "budgeted-history", strategyConfig: { budgetTokens: 8192 } },
    { model: "test-model", strategy: "selective-summary", strategyConfig: { budgetTokens: 8192, maxSummaryCalls: 2 } },
  ];

  return createExperimentInstance(rt.core, { assignments }).then((result) => {
    const agents = result.agentIds;
    const instanceId = result.instanceId;
    const roundId = result.roundId;

    // Initialize state for each agent
    if (over) {
      // Over-budget context for budgeted-history and selective-summary
      const largeCtx = overBudgetContext();
      for (const agentId of agents) {
        // Use the workloop's initial state via the implementation
        const wlMap: Record<string, WorkLoopImplementation> = {
          "agent-test-model-default": piDefaultLoopStub,
          "agent-test-model-budgeted-history": budgetedHistory,
          "agent-test-model-selective-summary": selectiveSummary,
        };
        const impl = wlMap[agentId];
        if (impl) {
          const config = impl.id === "pi-default-loop"
            ? { model: "test-model" }
            : { model: "test-model", budgetTokens: 8192, maxSummaryCalls: 2, maxModelCalls: 8, tokenCeiling: 32000 };
          const ctx = over
            ? largeCtx
            : impl.initialContext(config);
          const state = impl.initialState(config);
          rt.stateStore.initialize(agentId, ctx, state);
        }
      }
    }

    return {
      rt,
      db,
      fakeModel,
      agents,
      instanceId,
      roundId,
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(
  agentId: string,
  wlId: string,
  config: Record<string, unknown>,
  overrides: Partial<WorkLoopRunRequest> = {},
): WorkLoopRunRequest {
  return {
    traceId: `trace-${agentId}`,
    executionId: `exec-${agentId}-${Date.now()}`,
    agentInstanceId: agentId,
    optimizationRoundId: "context-experiment:round:0",
    workLoopId: wlId,
    workLoopVersion: "1.0.0",
    config,
    task: "integration test task",
    schedulerInstanceId: "context-experiment",
    dispatchId: `dispatch-${agentId}`,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Test (a): Per-strategy event chains
// ═══════════════════════════════════════════════════════════════════

test("(a) event chains: budgeted-history → context.transformed.truncate", async () => {
  const { rt, agents, db } = await setupFullExperiment(true);

  const bhAgent = agents.find((a) => a.includes("budgeted-history"))!;
  assert.ok(bhAgent, "budgeted-history agent must exist");

  // Run the budgeted-history agent
  const bhResult = await rt.workloopRunner.run(
    makeRequest(bhAgent, "budgeted-history", {
      model: "test-model",
      budgetTokens: 8192,
      maxModelCalls: 8,
      tokenCeiling: 32000,
    }),
  );

  assert.equal(bhResult.status, "completed");

  // Query events
  const events = rt.core.events.query({ schedulerInstanceId: "context-experiment" });
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });

  const bhEvents = events.filter(
    (e) => e.identity.agentInstanceId === bhAgent,
  );

  const types = bhEvents.map((e) => e.eventType);

  // context.transformed must be present (over-budget → truncation fires)
  assert.ok(types.includes("context.transformed"), `missing context.transformed in ${types.join(", ")}`);

  // No context.summary.created for budgeted-history
  assert.ok(
    !types.includes("context.summary.created"),
    `budgeted-history should NOT emit context.summary.created; got: ${types.join(", ")}`,
  );

  // Verify the transform event
  const xformEvent = bhEvents.find((e) => e.eventType === "context.transformed");
  assert.ok(xformEvent);
  const payload = xformEvent!.payload as Record<string, unknown>;
  assert.equal(payload.strategyId, "budgeted-history");
  assert.equal(payload.kind, "truncate");
  assert.ok(xformEvent!.metrics !== undefined);
  assert.ok(
    (xformEvent!.metrics!.beforeTokens as number) > (xformEvent!.metrics!.afterTokens as number),
    "beforeTokens should exceed afterTokens after truncation",
  );

  // model.requested and model.completed should exist
  assert.ok(types.includes("model.requested"), `missing model.requested in ${types}`);
  assert.ok(types.includes("model.completed"), `missing model.completed in ${types}`);

  // Verify ordering: context.transformed before model.requested
  const xformIdx = types.indexOf("context.transformed");
  const reqIdx = types.indexOf("model.requested");
  assert.ok(xformIdx < reqIdx, `context.transformed (${xformIdx}) should precede model.requested (${reqIdx})`);

  db.close();
});

test("(a) event chains: selective-summary → context.summary.created + context.transformed summarize", async () => {
  const result = await setupFullExperiment(true);
  const { rt, agents, db } = result;

  const ssAgent = agents.find((a) => a.includes("selective-summary"))!;
  assert.ok(ssAgent, "selective-summary agent must exist");

  // Run the selective-summary agent
  const ssResult = await rt.workloopRunner.run(
    makeRequest(ssAgent, "selective-summary", {
      model: "test-model",
      budgetTokens: 8192,
      maxModelCalls: 8,
      tokenCeiling: 32000,
      maxSummaryCalls: 2,
    }),
  );

  assert.equal(ssResult.status, "completed");

  // Query events
  const events = rt.core.events.query({ schedulerInstanceId: "context-experiment" });
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });

  const ssEvents = events.filter(
    (e) => e.identity.agentInstanceId === ssAgent,
  );

  const types = ssEvents.map((e) => e.eventType);

  // context.summary.created must be present
  assert.ok(types.includes("context.summary.created"),
    `missing context.summary.created in ${types.join(", ")}`);

  // context.transformed must be present
  assert.ok(types.includes("context.transformed"),
    `missing context.transformed in ${types.join(", ")}`);

  // Verify summary event
  const summaryEvent = ssEvents.find((e) => e.eventType === "context.summary.created");
  assert.ok(summaryEvent);
  const summaryPayload = summaryEvent!.payload as Record<string, unknown>;
  assert.equal(summaryPayload.strategyId, "selective-summary");

  // Verify transform event
  const xformEvent = ssEvents.find((e) => e.eventType === "context.transformed");
  assert.ok(xformEvent);
  const xformPayload = xformEvent!.payload as Record<string, unknown>;
  assert.equal(xformPayload.strategyId, "selective-summary");
  assert.equal(xformPayload.kind, "summarize");

  // Verify ordering: summary.created BEFORE context.transformed
  const summaryIdx = types.indexOf("context.summary.created");
  const xformIdx = types.indexOf("context.transformed");
  assert.ok(
    summaryIdx < xformIdx,
    `summary.created (${summaryIdx}) must come before context.transformed (${xformIdx})`,
  );

  db.close();
});

test("(a) event chains: default → model.requested/completed only, no transforms", async () => {
  const result = await setupFullExperiment(true);
  const { rt, agents, db } = result;

  const defAgent = agents.find((a) => a.includes("-default"))!;
  assert.ok(defAgent, "default agent must exist");

  // Run the default agent
  const defResult = await rt.workloopRunner.run(
    makeRequest(defAgent, "pi-default-loop", {
      model: "test-model",
    }),
  );

  assert.equal(defResult.status, "completed");

  // Query events
  const events = rt.core.events.query({ schedulerInstanceId: "context-experiment" });
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });

  const defEvents = events.filter(
    (e) => e.identity.agentInstanceId === defAgent,
  );

  const types = defEvents.map((e) => e.eventType);

  // Should have model.requested and model.completed
  assert.ok(types.includes("model.requested"), `missing model.requested in ${types}`);
  assert.ok(types.includes("model.completed"), `missing model.completed in ${types}`);

  // Should NOT have context.transformed or context.summary.created
  assert.ok(
    !types.includes("context.transformed"),
    `default should NOT have context.transformed; got: ${types.join(", ")}`,
  );
  assert.ok(
    !types.includes("context.summary.created"),
    `default should NOT have context.summary.created; got: ${types.join(", ")}`,
  );

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Test (b): Projection compare output aggregates per strategy
// ═══════════════════════════════════════════════════════════════════

test("(b) projection: aggregates per strategy incl. summaryCost in summary bucket", async () => {
  const result = await setupFullExperiment(true);
  const { rt, agents, db } = result;

  // Run all 3 variants so events are populated
  for (const agentId of agents) {
    const wlId = agentId.includes("budgeted-history") ? "budgeted-history"
      : agentId.includes("selective-summary") ? "selective-summary"
      : "pi-default-loop";

    const config: Record<string, unknown> = agentId.includes("selective-summary")
      ? { model: "test-model", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000, maxSummaryCalls: 2 }
      : agentId.includes("budgeted-history")
        ? { model: "test-model", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000 }
        : { model: "test-model" };

    await rt.workloopRunner.run(makeRequest(agentId, wlId, config));
  }

  // Run projection
  const projection = projectContextStrategies(db, { schedulerInstanceId: "context-experiment" });

  assert.equal(projection.unattributed, 0, "no unattributed events expected");
  assert.equal(projection.buckets.length, 3, "should have 3 buckets (one per strategy)");

  // Find each bucket
  const defaultBucket = projection.buckets.find((b) => b.strategy === "default");
  const bhBucket = projection.buckets.find((b) => b.strategy === "budgeted-history");
  const ssBucket = projection.buckets.find((b) => b.strategy === "selective-summary");

  assert.ok(defaultBucket, "default bucket must exist");
  assert.ok(bhBucket, "budgeted-history bucket must exist");
  assert.ok(ssBucket, "selective-summary bucket must exist");

  // Default: should have modelCalls but 0 transforms and 0 summaryCalls
  assert.ok(defaultBucket!.modelCalls > 0, "default should have model calls");
  assert.deepEqual(defaultBucket!.transforms, {}, "default should have no transforms");
  assert.equal(defaultBucket!.summaryCalls, 0, "default should have 0 summary calls");
  assert.equal(defaultBucket!.summaryCost, 0, "default should have 0 summary cost");

  // Budgeted-history: should have model calls + 1 truncate transform
  assert.ok(bhBucket!.modelCalls > 0, "budgeted-history should have model calls");
  assert.ok(Object.keys(bhBucket!.transforms).includes("truncate"),
    "budgeted-history should have truncate transform");
  assert.equal(bhBucket!.summaryCalls, 0, "budgeted-history should have 0 summary calls");

  // Selective-summary: should have model calls + summarize transform + summaryCalls + summaryCost
  assert.ok(ssBucket!.modelCalls > 0, "selective-summary should have model calls");
  assert.ok(Object.keys(ssBucket!.transforms).includes("summarize"),
    "selective-summary should have summarize transform");
  assert.ok(ssBucket!.summaryCalls > 0,
    `selective-summary should have summary calls, got ${ssBucket!.summaryCalls}`);
  assert.ok(ssBucket!.summaryCost > 0,
    "selective-summary should have non-zero summaryCost");

  // Observed/derived cost split
  assert.ok(
    (ssBucket!.totalCostObserved ?? 0) + (ssBucket!.totalCostDerived ?? 0) > 0,
    "should have some total cost",
  );

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Test (c): Storage/checkpoint namespace isolation across 3 variants
// ═══════════════════════════════════════════════════════════════════

test("(c) storage isolation: 3 variants share no state/checkpoint namespace", async () => {
  const result = await setupFullExperiment(true);
  const { rt, agents, db } = result;

  // Run each variant and collect their states
  const originalStates = new Map<string, { context: WorkContext }>();

  for (const agentId of agents) {
    const wlId = agentId.includes("budgeted-history") ? "budgeted-history"
      : agentId.includes("selective-summary") ? "selective-summary"
      : "pi-default-loop";

    const config: Record<string, unknown> = agentId.includes("selective-summary")
      ? { model: "test-model", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000, maxSummaryCalls: 2 }
      : agentId.includes("budgeted-history")
        ? { model: "test-model", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000 }
        : { model: "test-model" };

    await rt.workloopRunner.run(makeRequest(agentId, wlId, config));

    const snap = rt.stateStore.get(agentId);
    assert.ok(snap, `snapshot must exist for ${agentId}`);
    originalStates.set(agentId, {
      context: snap!.value.context,
    });
  }

  // All agents should be independently accessible
  for (const agentId of agents) {
    const snap = rt.stateStore.get(agentId);
    assert.ok(snap, `${agentId} snapshot should still exist`);
  }

  // Save checkpoints for each agent — should not collide
  const checkpoints = new Map<string, string[]>();
  for (const agentId of agents) {
    const snap = rt.stateStore.get(agentId);
    const ckId = `ck-${agentId}-1`;
    rt.checkpointStore.save(agentId, {
      checkpointId: ckId,
      agentInstanceId: agentId,
      executionId: `exec-${agentId}`,
      workLoopId: snap!.value.state?.["workLoopId"] ?? "pi-default-loop",
      workLoopVersion: "1.0.0",
      optimizationRoundId: "context-experiment:round:0",
      label: `checkpoint for ${agentId}`,
      context: snap!.value.context,
      state: snap!.value.state,
      createdAt: Date.now(),
    });
    checkpoints.set(agentId, [ckId]);
  }

  // Verify each checkpoint is retrievable only by its owner
  for (const agentId of agents) {
    const ckId = checkpoints.get(agentId)?.[0]!;
    const ck = rt.checkpointStore.get(agentId, ckId);
    assert.equal(ck.checkpointId, ckId);
    assert.equal(ck.label, `checkpoint for ${agentId}`);
  }

  // Cross-read should fail for all pairwise combinations
  for (const agentId of agents) {
    const otherCheckpointId = checkpoints.get(
      agents.find((a) => a !== agentId)!
    )?.[0]!;
    assert.throws(
      () => rt.checkpointStore.get(agentId, otherCheckpointId),
      /checkpoint not found/,
      `agent ${agentId} should not be able to read ${otherCheckpointId}`,
    );
  }

  // Storage namespacing: write keys for each agent
  const storageValues = new Map<string, string>();
  for (const agentId of agents) {
    const key = `test-key-${agentId}`;
    rt.core.storage.put("test-ns", key, `value-for-${agentId}`, 0);
    storageValues.set(agentId, key);
  }

  // Each agent's value should be independently retrievable
  for (const agentId of agents) {
    const key = storageValues.get(agentId)!;
    const entry = rt.core.storage.get("test-ns", key);
    assert.ok(entry);
    assert.equal(entry!.value, `value-for-${agentId}`);
  }

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Test (d): Round/agents traceable
// ═══════════════════════════════════════════════════════════════════

test("(d) traceability: instance currentRoundId and agent createdAtRoundId", async () => {
  const result = await setupFullExperiment(true);
  const { rt, instanceId, roundId, db } = result;

  // Verify instance exists and has a currentRoundId
  const inst = rt.core.repository.getInstance(instanceId);
  assert.ok(inst, "instance must exist");
  assert.equal(inst!.status, "active");
  assert.equal(inst!.currentRoundId, roundId);
  assert.ok(roundId.length > 0, "roundId must be non-empty");
  assert.ok(roundId.includes(":round:"), "roundId must follow convention");

  // Verify round exists
  const round = rt.core.repository.getRound(roundId);
  assert.ok(round, "round must exist");
  assert.equal(round!.status, "active");

  // Verify agents exist and have createdAtRoundId
  const agents = rt.core.repository.listAgents(instanceId);
  assert.equal(agents.length, 3, "should have 3 agents");

  for (const agent of agents) {
    assert.ok(agent.id.startsWith("agent-test-model-"), `agent id should follow convention: ${agent.id}`);
    assert.equal(agent.status, "ready");
    assert.equal(
      agent.createdAtRoundId,
      roundId,
      `agent ${agent.id} should be created at round ${roundId}, got ${agent.createdAtRoundId}`,
    );

    // Verify agent definition is correct
    assert.ok(agent.definition.workLoop);
    assert.ok(agent.definition.workLoop.id, `agent ${agent.id} workLoop.id must be defined`);
    assert.ok(agent.definition.workLoop.config, `agent ${agent.id} workLoop.config must be defined`);
  }

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Additional: createExperimentInstance idempotency
// ═══════════════════════════════════════════════════════════════════

test("createExperimentInstance: idempotent across re-creation with full 3-strategy setup", async () => {
  const db = new DatabaseSync(":memory:");
  const fakeModel = new FakeModelPort([
    { message: { role: "assistant", content: "ok" } },
  ]);

  const rt = createExperimentRuntime(db, {
    model: fakeModel,
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  // Register definitions
  rt.core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  registerWorkLoopDefinition(rt.core, structuredClone(BUDGETED_HISTORY_DEFINITION));
  registerWorkLoopDefinition(rt.core, structuredClone(SELECTIVE_SUMMARY_DEFINITION));

  const assignments: Assignment[] = [
    { model: "test-model", strategy: "default" },
    { model: "test-model", strategy: "budgeted-history" },
    { model: "test-model", strategy: "selective-summary" },
  ];

  // First call
  const first = await createExperimentInstance(rt.core, { assignments });
  assert.equal(first.agentIds.length, 3);

  // Second call — must return the same instance/round, agents same set
  const second = await createExperimentInstance(rt.core, { assignments });
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(second.roundId, first.roundId);
  assert.deepEqual([...second.agentIds].sort(), [...first.agentIds].sort());

  // Third call with different assignments — still returns original (idempotent)
  const third = await createExperimentInstance(rt.core, {
    assignments: [{ model: "test-model", strategy: "default" }],
  });
  assert.equal(third.instanceId, first.instanceId);
  assert.equal(third.roundId, first.roundId);
  assert.deepEqual([...third.agentIds].sort(), [...first.agentIds].sort()); // returns original agents, not the new smaller set

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Additional: Event identity carries correct workLoopId per strategy
// ═══════════════════════════════════════════════════════════════════

test("event identity: workLoopId matches strategy for each variant", async () => {
  const result = await setupFullExperiment(true);
  const { rt, agents, db } = result;

  for (const agentId of agents) {
    const expectedWorkLoopId = agentId.includes("budgeted-history") ? "budgeted-history"
      : agentId.includes("selective-summary") ? "selective-summary"
      : "pi-default-loop";

    const config: Record<string, unknown> = agentId.includes("selective-summary")
      ? { model: "test-model", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000, maxSummaryCalls: 2 }
      : agentId.includes("budgeted-history")
        ? { model: "test-model", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000 }
        : { model: "test-model" };

    await rt.workloopRunner.run(makeRequest(agentId, expectedWorkLoopId, config));

    // Check events for this agent
    const events = rt.core.events.query({ schedulerInstanceId: "context-experiment" });
    const agentEvents = events.filter((e) => e.identity.agentInstanceId === agentId);

    assert.ok(agentEvents.length > 0, `agent ${agentId} should have events`);
    for (const event of agentEvents) {
      // non-control-plane events should carry the workLoopId
      if (event.eventType.startsWith("agent.") ||
          event.eventType.startsWith("workloop.") ||
          event.eventType === "model.requested" ||
          event.eventType === "model.completed" ||
          event.eventType === "context.transformed" ||
          event.eventType === "context.summary.created") {
        assert.equal(
          event.identity.workLoopId,
          expectedWorkLoopId,
          `event ${event.eventType} for ${agentId} should have workLoopId=${expectedWorkLoopId}, got ${event.identity.workLoopId}`,
        );
      }
    }
  }

  db.close();
});
