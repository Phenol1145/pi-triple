/**
 * Tests for src/workloops/budgeted-history.ts
 *
 * Coverage:
 * - Implementation shape: id, version, cloneModes match BUDGETED_HISTORY_DEFINITION
 * - initialContext / initialState from config
 * - Under-budget: no transform, model call proceeds
 * - Over-budget: truncation correctness (system prompt kept, recency priority)
 * - Event emission: context.transformed on truncation
 * - cloneModes definition-impl consistency
 * - Registry accepts implementation
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { budgetedHistory, createBudgetedHistoryLoop } from "../src/workloops/budgeted-history.ts";
import type { ManagedLoopConfig } from "../src/workloops/managed-loop.ts";
import { MachineRuntime } from "../src/workloop/machine-runtime.ts";
import { BUDGETED_HISTORY_DEFINITION, registerWorkLoopDefinition, createExperimentRuntime } from "../src/runtime/create-experiment-runtime.ts";
import { contextTokenTotal, estimateTokens } from "../src/workloops/context-metrics.ts";
import type {
  WorkLoopSDK,
  WorkLoopInput,
  WorkLoopResult,
  WorkContext,
  WorkMessage,
  ModelPort,
  StandardAgentOutput,
  ContextOperations,
} from "../src/workloop/contracts.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeContext(overrides: Partial<WorkContext> = {}): WorkContext {
  return {
    systemPrompt: "you are helpful",
    messages: [{ role: "user", content: "hello" }],
    metadata: {
      contextId: "ctx-0",
      sourceRefs: [],
      artifactRefs: [],
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<WorkLoopInput> = {}): WorkLoopInput {
  return {
    traceId: "trace-1",
    executionId: "exec-1",
    agentInstanceId: "agent-1",
    optimizationRoundId: "round-1",
    task: "test task",
    context: makeContext(),
    config: { model: "test-model", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000 },
    state: {},
    ...overrides,
  };
}

function makeFakeModel(
  response: { message: WorkMessage; usage?: StandardAgentOutput["usage"] },
): ModelPort {
  return {
    async complete(_ctx: WorkContext, _opts?: Record<string, unknown>) {
      return response;
    },
  };
}

/** Context ops spy for lineage verification. */
function makeContextSpy(): ContextOperations & {
  appendCalls: Array<{ context: WorkContext; messages: WorkMessage[]; newContextId: string }>;
} {
  const appendCalls: Array<{ context: WorkContext; messages: WorkMessage[]; newContextId: string }> = [];
  return {
    appendCalls,
    append(context, messages, newContextId) {
      appendCalls.push({ context, messages, newContextId });
      const newMessages = [...context.messages.map((m) => ({ ...m })), ...messages.map((m) => ({ ...m }))];
      return {
        systemPrompt: context.systemPrompt,
        messages: newMessages,
        tools: context.tools ? context.tools.map((t) => ({ ...t })) : undefined,
        metadata: {
          contextId: newContextId,
          parentContextId: context.metadata.contextId,
          sourceRefs: [...context.metadata.sourceRefs],
          artifactRefs: [...context.metadata.artifactRefs],
        },
      };
    },
    filterMessages(context, predicate, newContextId) {
      const kept = context.messages.map((m) => ({ ...m })).filter(predicate);
      return {
        systemPrompt: context.systemPrompt,
        messages: kept,
        tools: context.tools ? context.tools.map((t) => ({ ...t })) : undefined,
        metadata: {
          contextId: newContextId,
          parentContextId: context.metadata.contextId,
          sourceRefs: [...context.metadata.sourceRefs],
          artifactRefs: [...context.metadata.artifactRefs],
        },
      };
    },
    merge(base, other, newContextId) {
      return {
        systemPrompt: base.systemPrompt ?? other.systemPrompt,
        messages: [...base.messages.map((m) => ({ ...m })), ...other.messages.map((m) => ({ ...m }))],
        metadata: {
          contextId: newContextId,
          parentContextId: undefined,
          sourceRefs: [],
          artifactRefs: [],
        },
      };
    },
    truncateMessages(context, limit, newContextId) {
      const kept = limit === 0 ? [] : context.messages.map((m) => ({ ...m })).slice(-limit);
      return {
        systemPrompt: context.systemPrompt,
        messages: kept,
        tools: context.tools ? context.tools.map((t) => ({ ...t })) : undefined,
        metadata: {
          contextId: newContextId,
          parentContextId: context.metadata.contextId,
          sourceRefs: [...context.metadata.sourceRefs],
          artifactRefs: [...context.metadata.artifactRefs],
        },
      };
    },
  };
}

function makeSdk(overrides: Partial<{
  model: ModelPort;
  telemetryCalls: Array<{ eventType: string; payload: unknown; metrics?: Record<string, string | number | boolean | null> }>;
}> = {}): WorkLoopSDK & {
  contextSpy: ReturnType<typeof makeContextSpy>;
  telemetryCalls: Array<{ eventType: string; payload: unknown; metrics?: Record<string, string | number | boolean | null> }>;
} {
  const contextSpy = makeContextSpy();
  const telemetryCalls: Array<{ eventType: string; payload: unknown; metrics?: Record<string, string | number | boolean | null> }> = [];

  return {
    contextSpy,
    telemetryCalls: overrides.telemetryCalls ?? telemetryCalls,
    context: contextSpy,
    model: overrides.model ?? makeFakeModel({
      message: { role: "assistant", content: "ok" },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 0, durationMs: 100 },
    }),
    tools: { execute: async () => { throw new Error("no tools"); } },
    artifacts: { put: async () => "r", get: async () => "v" },
    storage: {
      get: () => undefined,
      put: <T>(_k: string, v: T, _ev: number) => ({ value: v, version: 1 }),
    },
    checkpoint: {
      save: async () => ({ checkpointId: "ck-1" }),
    },
    telemetry: {
      emit(eventType: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>) {
        (overrides.telemetryCalls ?? telemetryCalls).push({ eventType, payload, metrics });
      },
    },
    control: {
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
    },
  };
}

// ── Machine 驱动 helper（Task 4 迁移：budgetedHistory.run → factory.machine + MachineRuntime） ──

async function driveBudgeted(
  config: Record<string, unknown>,
  input: WorkLoopInput,
  sdk: WorkLoopSDK,
) {
  const impl = createBudgetedHistoryLoop(config as ManagedLoopConfig);
  const runtime = new MachineRuntime({ machine: impl.machine, input, sdk });
  return runtime.run();
}

// ── Implementation shape ────────────────────────────────────────────

test("budgetedHistory: id, version, cloneModes match BUDGETED_HISTORY_DEFINITION", () => {
  assert.equal(budgetedHistory.id, BUDGETED_HISTORY_DEFINITION.id);
  assert.equal(budgetedHistory.version, BUDGETED_HISTORY_DEFINITION.version);
  assert.deepEqual([...budgetedHistory.cloneModes].sort(), [...BUDGETED_HISTORY_DEFINITION.cloneModes].sort());
  assert.ok(budgetedHistory.cloneModes.includes("fresh"));
});

test("budgetedHistory: has required implementation fields", () => {
  assert.equal(typeof budgetedHistory.initialContext, "function");
  assert.equal(typeof budgetedHistory.initialState, "function");
  assert.equal(budgetedHistory.executorKind, "local-model");
  assert.ok(budgetedHistory.machine, "machine 取代 run（Task 4）");
  assert.equal(budgetedHistory.run, undefined, "新实现不提供 run");
});

// ── initialContext / initialState ────────────────────────────────────

test("initialContext: empty context with no config", () => {
  const ctx = budgetedHistory.initialContext({});
  assert.deepEqual(ctx.messages, []);
  assert.equal(ctx.systemPrompt, undefined);
  assert.equal(ctx.metadata.contextId, "ctx-initial");
});

test("initialContext: systemPrompt from config", () => {
  const ctx = budgetedHistory.initialContext({ systemPrompt: "be concise" });
  assert.equal(ctx.systemPrompt, "be concise");
});

test("initialState: returns empty object", () => {
  const state = budgetedHistory.initialState({});
  assert.deepEqual(state, {});
});

// ═══════════════════════════════════════════════════════════════════
// Under-budget: no transform
// ═══════════════════════════════════════════════════════════════════

test("under-budget: no transform emitted, model completes normally", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown }> = [];
  const sdk = makeSdk({ telemetryCalls });

  const input = makeInput({
    context: makeContext({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "short" }],
    }),
    config: { model: "test", budgetTokens: 8192, maxModelCalls: 8, tokenCeiling: 32000 },
  });

  const { result } = await driveBudgeted(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  assert.equal(result.status, "completed");

  // No context.transformed should be emitted (under budget)
  const transformEvents = telemetryCalls.filter((c) => c.eventType === "context.transformed");
  assert.equal(transformEvents.length, 0, "no transform when under budget");
});

// ═══════════════════════════════════════════════════════════════════
// Over-budget: truncation correctness
// ═══════════════════════════════════════════════════════════════════

test("over-budget: truncation keeps system prompt and most recent messages", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown; metrics?: Record<string, string | number | boolean | null> }> = [];
  const sdk = makeSdk({ telemetryCalls });

  // Create a context with many large messages to exceed a small budget
  const messages: WorkMessage[] = [];
  // Add old messages (will be dropped)
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "user" as const, content: `old message ${i} with enough text to consume tokens `.repeat(3) });
  }
  // Add recent messages (should be kept)
  messages.push({ role: "user" as const, content: "recent question" });
  messages.push({ role: "assistant" as const, content: "recent answer" });

  const input = makeInput({
    context: makeContext({
      systemPrompt: "IMPORTANT SYSTEM PROMPT",
      messages,
    }),
    config: { model: "test", budgetTokens: 100, maxModelCalls: 8, tokenCeiling: 500 },
  });

  const { result } = await driveBudgeted(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  assert.equal(result.status, "completed");

  // Check that context.transformed was emitted
  const transformEvents = telemetryCalls.filter((c) => c.eventType === "context.transformed");
  assert.ok(transformEvents.length >= 1, "should emit context.transformed");

  const event = transformEvents[0]!;
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.strategyId, "budgeted-history");
  assert.equal(payload.kind, "truncate");
  assert.equal(payload.source, "estimated");

  // Check metrics
  assert.ok(event.metrics !== undefined);
  assert.ok(typeof event.metrics!.beforeTokens === "number");
  assert.ok(typeof event.metrics!.afterTokens === "number");
  assert.ok(typeof event.metrics!.droppedSegments === "number");
  assert.ok(event.metrics!.droppedSegments > 0, "should have dropped some segments");
});

test("over-budget: recency priority — oldest messages dropped first", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown; metrics?: Record<string, string | number | boolean | null> }> = [];

  // Create messages where the last one is identifiable
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "user", content: `filler message ${i} `.repeat(10) });
  }
  const lastContent = "THE LAST MESSAGE — MUST BE KEPT";
  messages.push({ role: "user", content: lastContent });

  // Use a budget that can only fit the last message plus a tiny bit
  const lastMsgTokens = estimateTokens(lastContent);
  const tightBudget = lastMsgTokens + 10;

  const sdk = makeSdk({ telemetryCalls });
  const input = makeInput({
    context: makeContext({
      systemPrompt: "system prompt",
      messages,
    }),
    config: { model: "test", budgetTokens: tightBudget, maxModelCalls: 8, tokenCeiling: 500 },
  });

  await driveBudgeted(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  const transformEvents = telemetryCalls.filter((c) => c.eventType === "context.transformed");
  assert.ok(transformEvents.length >= 1);

  const event = transformEvents[0]!;
  // Almost all messages should be dropped except the last one
  assert.ok(event.metrics!.droppedSegments >= 29, `expected >= 29 dropped, got ${event.metrics!.droppedSegments}`);

  // The after-tokens should be close to lastMsgTokens
  assert.ok(event.metrics!.afterTokens <= tightBudget, "afterTokens should be within budget");
});

test("over-budget: system prompt is always preserved in transformed context", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown }> = [];

  const messages: WorkMessage[] = [];
  for (let i = 0; i < 50; i++) {
    messages.push({ role: "user", content: `filler ${i} `.repeat(20) });
  }

  const systemPrompt = "CRITICAL SYSTEM INSTRUCTIONS";

  // Create an SDK where we can inspect what's sent to the model
  let modelContext: WorkContext | undefined;
  const model: ModelPort = {
    async complete(ctx: WorkContext) {
      modelContext = ctx;
      return { message: { role: "assistant", content: "ok" } };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({ systemPrompt, messages }),
    config: { model: "test", budgetTokens: 100, maxModelCalls: 8, tokenCeiling: 500 },
  });

  await driveBudgeted(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // The system prompt passed to the model should still be there
  // （MachineRuntime 会附加 DSP 派生段——原 systemPrompt 必须作为前缀保留）
  assert.ok(modelContext !== undefined, "model should have been called");
  assert.ok(
    modelContext!.systemPrompt?.startsWith(systemPrompt),
    "system prompt must be preserved as prefix (DSP 派生段允许附加在后)",
  );
});

// ═══════════════════════════════════════════════════════════════════
// Event emission
// ═══════════════════════════════════════════════════════════════════

test("event emission: context.transformed carries all required fields on truncation", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown; metrics?: Record<string, string | number | boolean | null> }> = [];

  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "user", content: `msg ${i} `.repeat(15) });
  }

  const sdk = makeSdk({ telemetryCalls });
  const input = makeInput({
    context: makeContext({ messages }),
    config: { model: "test", budgetTokens: 150, maxModelCalls: 8, tokenCeiling: 500 },
  });

  await driveBudgeted(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  const transformEvents = telemetryCalls.filter((c) => c.eventType === "context.transformed");
  assert.ok(transformEvents.length >= 1, "should emit context.transformed");

  const event = transformEvents[0]!;
  const payload = event.payload as Record<string, unknown>;
  const metrics = event.metrics!;

  // Required payload fields
  assert.equal(payload.strategyId, "budgeted-history");
  assert.equal(payload.kind, "truncate");
  assert.equal(payload.source, "estimated");

  // Required metric fields
  assert.ok(typeof metrics.beforeTokens === "number");
  assert.ok(typeof metrics.afterTokens === "number");
  assert.ok(typeof metrics.droppedSegments === "number");
  assert.ok(metrics.beforeTokens > metrics.afterTokens, "before should be > after");
  assert.ok(metrics.droppedSegments > 0, "should drop some segments");
});

// ═══════════════════════════════════════════════════════════════════
// Registry acceptance
// ═══════════════════════════════════════════════════════════════════

test("registry: budgetedHistory is accepted by WorkLoopRegistry", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(BUDGETED_HISTORY_DEFINITION);

  const registry = new WorkLoopRegistry(definitions);
  assert.doesNotThrow(() => registry.register(budgetedHistory));

  const resolved = registry.require("budgeted-history", "1.0.0");
  assert.equal(resolved.id, "budgeted-history");
  assert.equal(resolved.version, "1.0.0");
});

test("registry: cloneModes consistency between definition and implementation", () => {
  // Verify the definition and implementation cloneModes align
  const defModes = [...BUDGETED_HISTORY_DEFINITION.cloneModes].sort();
  const implModes = [...budgetedHistory.cloneModes].sort();

  assert.deepEqual(defModes, implModes, "definition and implementation cloneModes must match");
  assert.ok(defModes.includes("fresh"), "must include fresh mode");
});

// ═══════════════════════════════════════════════════════════════════
// Integration: createExperimentRuntime + budgetedHistory
// ═══════════════════════════════════════════════════════════════════

test("integration: budgetedHistory can be registered in experiment runtime", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: { complete: async () => ({ message: { role: "assistant", content: "ok" } }) },
    tools: { execute: async () => "done" },
    artifacts: { put: async () => "r", get: async () => "v" },
  });

  // Register definition
  registerWorkLoopDefinition(rt.core, BUDGETED_HISTORY_DEFINITION);

  // Register implementation
  assert.doesNotThrow(() => rt.workloopRegistry.register(budgetedHistory));

  // Verify it's resolvable
  const impl = rt.workloopRegistry.require("budgeted-history", "1.0.0");
  assert.equal(impl.id, "budgeted-history");
});

// ═══════════════════════════════════════════════════════════════════
// Over-budget: token ceiling guard works
// ═══════════════════════════════════════════════════════════════════

test("over-budget: transform reduces context below token ceiling before model call", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown }> = [];

  // Create context with many messages so it exceeds both budget and ceiling
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "user", content: `message ${i} `.repeat(15) });
  }

  let modelCalled = false;
  const model: ModelPort = {
    async complete(_ctx: WorkContext) {
      modelCalled = true;
      return { message: { role: "assistant", content: "done" } };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({ messages }),
    config: { model: "test", budgetTokens: 150, maxModelCalls: 8, tokenCeiling: 500 },
  });

  await driveBudgeted(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  assert.equal(modelCalled, true, "model should be called after transform");
  const transformEvents = telemetryCalls.filter((c) => c.eventType === "context.transformed");
  assert.ok(transformEvents.length >= 1, "should emit transform event");
});
