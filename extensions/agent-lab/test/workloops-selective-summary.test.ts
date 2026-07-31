/**
 * Tests for src/workloops/selective-summary.ts
 *
 * Coverage:
 * - Implementation shape: id, version, cloneModes match SELECTIVE_SUMMARY_DEFINITION
 * - initialContext / initialState from config
 * - Under-budget: no-op, no events emitted
 * - Over-budget: summarization correctness (oldest segment replaced, system kept,
 *   recency preserved)
 * - Event order: context.summary.created BEFORE context.transformed
 * - Event fields: summary.created carries usage + source; transformed carries kind "summarize"
 * - maxSummaryCalls: enforced via storage, defaults to 1 per run
 * - Fallback truncation on summary model failure (kind "truncate", fallback:true)
 * - definition/impl consistency + registry acceptance
 * - Clone modes match definition
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { selectiveSummary, createSelectiveSummaryLoop } from "../src/workloops/selective-summary.ts";
import type { ManagedLoopConfig } from "../src/workloops/managed-loop.ts";
import { MachineRuntime } from "../src/workloop/machine-runtime.ts";
import {
  SELECTIVE_SUMMARY_DEFINITION,
  registerWorkLoopDefinition,
  createExperimentRuntime,
} from "../src/runtime/create-experiment-runtime.ts";
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
    config: {
      model: "test-model",
      budgetTokens: 8192,
      maxModelCalls: 8,
      tokenCeiling: 32000,
      maxSummaryCalls: 1,
      summaryWindow: 0.5,
    },
    state: {},
    ...overrides,
  };
}

function makeFakeModel(
  response: { message: WorkMessage; usage?: StandardAgentOutput["usage"] },
): ModelPort & { calls: Array<{ context: WorkContext; options?: Record<string, unknown> }> } {
  const calls: Array<{ context: WorkContext; options?: Record<string, unknown> }> = [];
  return {
    calls,
    async complete(context: WorkContext, options?: Record<string, unknown>) {
      calls.push({ context, options });
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
      const newMessages = [
        ...context.messages.map((m) => ({ ...m })),
        ...messages.map((m) => ({ ...m })),
      ];
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
        messages: [
          ...base.messages.map((m) => ({ ...m })),
          ...other.messages.map((m) => ({ ...m })),
        ],
        metadata: {
          contextId: newContextId,
          parentContextId: undefined,
          sourceRefs: [],
          artifactRefs: [],
        },
      };
    },
    truncateMessages(context, limit, newContextId) {
      const kept =
        limit === 0
          ? []
          : context.messages.map((m) => ({ ...m })).slice(-limit);
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

function makeSdk(overrides: {
  model?: ModelPort;
  telemetryCalls?: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }>;
} = {}): WorkLoopSDK & {
  contextSpy: ReturnType<typeof makeContextSpy>;
  telemetryCalls: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }>;
} {
  const contextSpy = makeContextSpy();
  const telemetryCalls: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }> = [];

  // In-memory storage map for per-run state tracking
  const storageMap = new Map<string, { value: unknown; version: number }>();

  return {
    contextSpy,
    telemetryCalls: overrides.telemetryCalls ?? telemetryCalls,
    context: contextSpy,
    model:
      overrides.model ??
      makeFakeModel({
        message: { role: "assistant", content: "ok" },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.001,
          turns: 1,
          toolCalls: 0,
          durationMs: 100,
        },
      }),
    tools: {
      execute: async () => {
        throw new Error("no tools");
      },
    },
    artifacts: { put: async () => "r", get: async () => "v" },
    storage: {
      get<T = unknown>(key: string): { value: T; version: number } | undefined {
        const entry = storageMap.get(key);
        if (!entry) return undefined;
        return { value: entry.value as T, version: entry.version };
      },
      put<T>(key: string, value: T, expectedVersion: number): { value: T; version: number } {
        const entry = storageMap.get(key);
        if (entry && entry.version !== expectedVersion) {
          throw new Error(`version conflict for key: ${key}`);
        }
        const newVersion = (entry?.version ?? 0) + 1;
        storageMap.set(key, { value, version: newVersion });
        return { value, version: newVersion };
      },
    },
    checkpoint: {
      save: async () => ({ checkpointId: "ck-1" }),
    },
    telemetry: {
      emit(
        eventType: string,
        payload: unknown,
        metrics?: Record<string, string | number | boolean | null>,
      ) {
        (overrides.telemetryCalls ?? telemetryCalls).push({
          eventType,
          payload,
          metrics,
        });
      },
    },
    control: {
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
    },
  };
}

// ── Machine 驱动 helper（Task 4 迁移：selectiveSummary.run → factory.machine + MachineRuntime） ──

async function driveSelective(
  config: Record<string, unknown>,
  input: WorkLoopInput,
  sdk: WorkLoopSDK,
) {
  const impl = createSelectiveSummaryLoop(config as ManagedLoopConfig);
  const runtime = new MachineRuntime({ machine: impl.machine, input, sdk });
  return runtime.run();
}

// ── Implementation shape ────────────────────────────────────────────

test("selectiveSummary: id, version, cloneModes match SELECTIVE_SUMMARY_DEFINITION", () => {
  assert.equal(selectiveSummary.id, SELECTIVE_SUMMARY_DEFINITION.id);
  assert.equal(
    selectiveSummary.version,
    SELECTIVE_SUMMARY_DEFINITION.version,
  );
  assert.deepEqual(
    [...selectiveSummary.cloneModes].sort(),
    [...SELECTIVE_SUMMARY_DEFINITION.cloneModes].sort(),
  );
  assert.ok(selectiveSummary.cloneModes.includes("fresh"));
});

test("selectiveSummary: has required implementation fields", () => {
  assert.equal(typeof selectiveSummary.initialContext, "function");
  assert.equal(typeof selectiveSummary.initialState, "function");
  assert.equal(selectiveSummary.executorKind, "local-model");
  assert.ok(selectiveSummary.machine, "machine 取代 run（Task 4）");
  assert.equal(selectiveSummary.run, undefined, "新实现不提供 run");
});

// ── initialContext / initialState ────────────────────────────────────

test("initialContext: empty context with no config", () => {
  const ctx = selectiveSummary.initialContext({});
  assert.deepEqual(ctx.messages, []);
  assert.equal(ctx.systemPrompt, undefined);
  assert.equal(ctx.metadata.contextId, "ctx-initial");
});

test("initialContext: systemPrompt from config", () => {
  const ctx = selectiveSummary.initialContext({ systemPrompt: "be concise" });
  assert.equal(ctx.systemPrompt, "be concise");
});

test("initialState: returns empty object", () => {
  const state = selectiveSummary.initialState({});
  assert.deepEqual(state, {});
});

// ═══════════════════════════════════════════════════════════════════
// Under-budget: no-op, no events
// ═══════════════════════════════════════════════════════════════════

test("under-budget: no transform, no events emitted", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown }> = [];
  const sdk = makeSdk({ telemetryCalls });

  const input = makeInput({
    context: makeContext({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "short" }],
    }),
    config: {
      model: "test",
      budgetTokens: 8192,
      maxModelCalls: 8,
      tokenCeiling: 32000,
    },
  });

  const { result } = await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  assert.equal(result.status, "completed");

  // No context.summary.created or context.transformed should be emitted
  const summaryEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.summary.created",
  );
  assert.equal(summaryEvents.length, 0, "no summary created when under budget");

  const transformEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.transformed",
  );
  assert.equal(transformEvents.length, 0, "no transform when under budget");
});

// ═══════════════════════════════════════════════════════════════════
// Over-budget: summarization correctness
// ═══════════════════════════════════════════════════════════════════

test("over-budget: summarization replaces oldest segment with one summary message", async () => {
  const telemetryCalls: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }> = [];

  // Create a context with many messages to exceed budget
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: "user",
      content: `old message ${i} with enough text to consume tokens `.repeat(5),
    });
  }
  // Add newer messages that should be kept
  messages.push({ role: "user", content: "recent question about AI" });
  messages.push({ role: "assistant", content: "recent answer from assistant" });

  // A model port that provides a summary response for the summary call
  // AND a normal response for the main model call (the skeleton always makes one)
  let summaryCallCount = 0;
  const model: ModelPort & {
    calls: Array<{ context: WorkContext; options?: Record<string, unknown> }>;
  } = {
    calls: [],
    async complete(context: WorkContext, options?: Record<string, unknown>) {
      (this as typeof model).calls.push({ context, options });
      // First call is the summary call (from the strategy)
      // Second call is the main model call (from the skeleton)
      if (summaryCallCount === 0) {
        summaryCallCount++;
        return {
          message: { role: "assistant", content: "SUMMARY OF OLD CONVERSATION" },
          usage: {
            input: 500,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.002,
            turns: 1,
            toolCalls: 0,
            durationMs: 200,
          },
        };
      }
      return {
        message: { role: "assistant", content: "final reply" },
        usage: {
          input: 50,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.001,
          turns: 1,
          toolCalls: 0,
          durationMs: 100,
        },
      };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({
      systemPrompt: "IMPORTANT SYSTEM PROMPT",
      messages,
    }),
    config: {
      model: "test",
      budgetTokens: 100,
      maxModelCalls: 8,
      tokenCeiling: 32000,
      summaryWindow: 0.5,
    },
  });

  const { result } = await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  assert.equal(result.status, "completed");

  // Check that the summary call was made to the model
  assert.ok(model.calls.length >= 2, "should have summary call + main model call");

  // Verify the summary model call context
  const summaryCall = model.calls[0]!;
  assert.ok(
    summaryCall.context.systemPrompt !== undefined,
    "summary call should have a system prompt",
  );

  // Check context.summary.created was emitted
  const summaryEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.summary.created",
  );
  assert.ok(summaryEvents.length >= 1, "should emit context.summary.created");

  const summaryEvent = summaryEvents[0]!;
  const summaryPayload = summaryEvent.payload as Record<string, unknown>;
  assert.equal(summaryPayload.strategyId, "selective-summary");
  assert.ok(
    summaryPayload.source === "observed" || summaryPayload.source === "derived",
  );
  assert.ok(
    typeof summaryEvent.metrics?.inputTokens === "number",
    "summary.created should have inputTokens",
  );
  assert.ok(
    typeof summaryEvent.metrics?.outputTokens === "number",
    "summary.created should have outputTokens",
  );
  assert.ok(
    typeof summaryEvent.metrics?.cost === "number",
    "summary.created should have cost",
  );

  // Check context.transformed was emitted
  const transformEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.transformed",
  );
  assert.ok(transformEvents.length >= 1, "should emit context.transformed");

  const transformEvent = transformEvents[0]!;
  const transformPayload = transformEvent.payload as Record<string, unknown>;
  assert.equal(transformPayload.strategyId, "selective-summary");
  assert.equal(transformPayload.kind, "summarize");
  assert.ok(
    typeof transformEvent.metrics?.beforeTokens === "number",
  );
  assert.ok(
    typeof transformEvent.metrics?.afterTokens === "number",
  );
  assert.ok(
    typeof transformEvent.metrics?.droppedSegments === "number",
  );
  assert.ok(
    transformEvent.metrics!.droppedSegments > 0,
    "should have dropped some segments (replaced by summary)",
  );
});

test("over-budget: system prompt and newest messages preserved", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown }> = [];

  const messages: WorkMessage[] = [];
  // 25 old filler messages
  for (let i = 0; i < 25; i++) {
    messages.push({
      role: "user",
      content: `filler message ${i} `.repeat(10),
    });
  }
  // 3 newest messages that should be preserved
  const newestMsg1: WorkMessage = { role: "user", content: "THE NEWEST QUESTION" };
  const newestMsg2: WorkMessage = {
    role: "assistant",
    content: "THE NEWEST ANSWER",
  };
  const newestMsg3: WorkMessage = { role: "user", content: "FINAL FOLLOW-UP" };
  messages.push(newestMsg1, newestMsg2, newestMsg3);

  const systemPrompt = "CRITICAL SYSTEM INSTRUCTIONS";

  let mainModelContext: WorkContext | undefined;
  const model: ModelPort & {
    calls: Array<{ context: WorkContext; options?: Record<string, unknown> }>;
  } = {
    calls: [],
    async complete(context: WorkContext, options?: Record<string, unknown>) {
      (this as typeof model).calls.push({ context, options });
      if (mainModelContext === undefined && options?.strategyId === "selective-summary") {
        // Summary call
        return {
          message: { role: "assistant", content: "summary of old stuff" },
          usage: {
            input: 100, output: 5, cacheRead: 0, cacheWrite: 0,
            cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
          },
        };
      }
      // Main model call
      mainModelContext = context;
      return {
        message: { role: "assistant", content: "answer" },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({ systemPrompt, messages }),
    config: {
      model: "test",
      budgetTokens: 150,
      maxModelCalls: 8,
      tokenCeiling: 32000,
      summaryWindow: 0.5,
    },
  });

  await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // The main model call should receive a context with preserved system prompt
  // （MachineRuntime 会附加 DSP 派生段——原 systemPrompt 必须作为前缀保留）
  assert.ok(mainModelContext !== undefined, "main model should have been called");
  assert.ok(
    mainModelContext!.systemPrompt?.startsWith(systemPrompt),
    "system prompt must be preserved as prefix (DSP 派生段允许附加在后)",
  );

  // The newest messages should be in the main model context
  const mainMessages = mainModelContext!.messages;
  const mainContent = mainMessages.map((m) =>
    typeof m.content === "string" ? m.content : "",
  );

  // The summary message should have [summary] prefix
  const summaryMsg = mainMessages.find((m) => {
    return typeof m.content === "string" && m.content.startsWith("[summary]");
  });
  assert.ok(summaryMsg !== undefined, "should have a [summary] message");

  // Newest messages should be present after the summary
  assert.ok(
    mainContent.some((c) => c.includes("THE NEWEST QUESTION")),
    "newest user message should be present",
  );
  assert.ok(
    mainContent.some((c) => c.includes("THE NEWEST ANSWER")),
    "newest assistant message should be present",
  );
  assert.ok(
    mainContent.some((c) => c.includes("FINAL FOLLOW-UP")),
    "final follow-up should be present",
  );

  // Old filler messages should NOT be present
  // (they were in the summarised segment)
  assert.ok(
    !mainContent.some((c) => c.includes("filler message 0")),
    "old filler messages should be gone (summarised)",
  );
});

// ═══════════════════════════════════════════════════════════════════
// Event order: summary.created BEFORE context.transformed
// ═══════════════════════════════════════════════════════════════════

test("event order: context.summary.created before context.transformed", async () => {
  const telemetryCalls: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }> = [];

  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: "user",
      content: `msg ${i} `.repeat(10),
    });
  }

  const model: ModelPort = {
    async complete(_context: WorkContext, options?: Record<string, unknown>) {
      if (options?.strategyId === "selective-summary") {
        return {
          message: { role: "assistant", content: "summary" },
          usage: {
            input: 100, output: 5, cacheRead: 0, cacheWrite: 0,
            cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
          },
        };
      }
      return {
        message: { role: "assistant", content: "answer" },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({ messages }),
    config: {
      model: "test",
      budgetTokens: 100,
      maxModelCalls: 8,
      tokenCeiling: 32000,
    },
  });

  await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // Find the indices of the events in the telemetry stream
  const summaryCreatedIdx = telemetryCalls.findIndex(
    (c) => c.eventType === "context.summary.created",
  );
  const contextTransformedIdx = telemetryCalls.findIndex(
    (c) => c.eventType === "context.transformed",
  );

  assert.ok(summaryCreatedIdx >= 0, "context.summary.created should be emitted");
  assert.ok(contextTransformedIdx >= 0, "context.transformed should be emitted");
  assert.ok(
    summaryCreatedIdx < contextTransformedIdx,
    `summary.created (idx ${summaryCreatedIdx}) must come before context.transformed (idx ${contextTransformedIdx})`,
  );
});

// ═══════════════════════════════════════════════════════════════════
// maxSummaryCalls enforcement
// ═══════════════════════════════════════════════════════════════════

test("maxSummaryCalls: second over-budget trigger falls back to truncation", async () => {
  // maxSummaryCalls=1: first time summarisation runs, second time the
  // storage counter is already at 1 so it falls back to truncation.
  // We need to run the workloop twice with the same storage to simulate
  // this. Actually, the strategy stores the count in sdk.storage and
  // we can pre-seed it.

  const telemetryCalls: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }> = [];

  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: "user",
      content: `msg ${i} `.repeat(10),
    });
  }

  let callIdx = 0;
  const model: ModelPort & {
    calls: Array<{ context: WorkContext; options?: Record<string, unknown> }>;
  } = {
    calls: [],
    async complete(context: WorkContext, options?: Record<string, unknown>) {
      (this as typeof model).calls.push({ context, options });
      callIdx++;
      // The first run: summary call (idx=1) + main call (idx=2)
      // The second run: no summary call → just main call (idx=3)
      if (options?.strategyId === "selective-summary") {
        return {
          message: { role: "assistant", content: "summary-of-old" },
          usage: {
            input: 100, output: 5, cacheRead: 0, cacheWrite: 0,
            cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
          },
        };
      }
      return {
        message: { role: "assistant", content: `answer-${callIdx}` },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  // Pre-seed storage with callCount=1 to simulate maxSummaryCalls already hit
  const storageMap = new Map<string, { value: unknown; version: number }>();
  storageMap.set("_selective-summary:callCount", { value: 1, version: 1 });

  const contextSpy = makeContextSpy();
  const sdk: WorkLoopSDK & {
    contextSpy: ReturnType<typeof makeContextSpy>;
    telemetryCalls: typeof telemetryCalls;
  } = {
    contextSpy,
    telemetryCalls,
    context: contextSpy,
    model,
    tools: { execute: async () => { throw new Error("no tools"); } },
    artifacts: { put: async () => "r", get: async () => "v" },
    storage: {
      get<T = unknown>(key: string): { value: T; version: number } | undefined {
        const entry = storageMap.get(key);
        if (!entry) return undefined;
        return { value: entry.value as T, version: entry.version };
      },
      put<T>(key: string, value: T, expectedVersion: number): { value: T; version: number } {
        const entry = storageMap.get(key);
        if (entry && entry.version !== expectedVersion) {
          throw new Error(`version conflict for key: ${key}`);
        }
        const newVersion = (entry?.version ?? 0) + 1;
        storageMap.set(key, { value, version: newVersion });
        return { value, version: newVersion };
      },
    },
    checkpoint: { save: async () => ({ checkpointId: "ck-1" }) },
    telemetry: {
      emit(eventType: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>) {
        telemetryCalls.push({ eventType, payload, metrics });
      },
    },
    control: {
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
    },
  };

  const input = makeInput({
    context: makeContext({ messages }),
    config: {
      model: "test",
      budgetTokens: 100,
      maxModelCalls: 8,
      tokenCeiling: 32000,
      maxSummaryCalls: 1,
    },
  });

  await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // Should NOT have a summary.created event (maxSummaryCalls already at 1)
  const summaryEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.summary.created",
  );
  assert.equal(
    summaryEvents.length,
    0,
    "no summary.created when maxSummaryCalls exceeded",
  );

  // Should have context.transformed with kind "truncate" and fallback:true
  const transformEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.transformed",
  );
  assert.ok(transformEvents.length >= 1, "should emit context.transformed");

  const transformEvent = transformEvents[0]!;
  const transformPayload = transformEvent.payload as Record<string, unknown>;
  assert.equal(transformPayload.strategyId, "selective-summary");
  assert.equal(transformPayload.kind, "truncate", "should be truncate (fallback)");
  assert.equal(transformPayload.fallback, true, "should mark fallback:true");

  // The model should only have been called once (the main model call),
  // NOT a summary call
  const summaryModelCalls = model.calls.filter(
    (c) => c.options?.strategyId === "selective-summary",
  );
  assert.equal(
    summaryModelCalls.length,
    0,
    "no summary model call when maxSummaryCalls exceeded",
  );
});

// ═══════════════════════════════════════════════════════════════════
// Fallback truncation on summary model failure
// ═══════════════════════════════════════════════════════════════════

test("fail-open: summarization model call failure falls back to truncation", async () => {
  const telemetryCalls: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }> = [];

  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: "user",
      content: `msg ${i} `.repeat(10),
    });
  }

  // Model that throws on summary call but works for main call
  let callCount = 0;
  const model: ModelPort & {
    calls: Array<{ context: WorkContext; options?: Record<string, unknown> }>;
  } = {
    calls: [],
    async complete(_context: WorkContext, options?: Record<string, unknown>) {
      (this as typeof model).calls.push({ context: _context, options });
      callCount++;
      if (options?.strategyId === "selective-summary") {
        throw new Error("summary model API error");
      }
      return {
        message: { role: "assistant", content: "normal reply" },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({ messages }),
    config: {
      model: "test",
      budgetTokens: 150,
      maxModelCalls: 8,
      tokenCeiling: 32000,
    },
  });

  const { result } = await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // Should NOT crash — run completes normally
  assert.equal(result.status, "completed");

  // No context.summary.created (the call failed)
  const summaryEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.summary.created",
  );
  assert.equal(summaryEvents.length, 0, "no summary.created on failure");

  // Should have context.transformed with kind "truncate" and fallback:true
  const transformEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.transformed",
  );
  assert.ok(transformEvents.length >= 1, "should emit context.transformed on fallback");

  const transformEvent = transformEvents[0]!;
  const transformPayload = transformEvent.payload as Record<string, unknown>;
  assert.equal(transformPayload.strategyId, "selective-summary");
  assert.equal(transformPayload.kind, "truncate");
  assert.equal(transformPayload.fallback, true, "should mark as fallback");

  // Metrics should show dropped segments
  assert.ok(
    typeof transformEvent.metrics?.droppedSegments === "number",
  );
  assert.ok(
    transformEvent.metrics!.droppedSegments > 0,
    "should have dropped segments in fallback truncation",
  );

  // Main model call should still have happened
  assert.ok(model.calls.length >= 1, "main model should have been called");
});

// ═══════════════════════════════════════════════════════════════════
// Event field correctness
// ═══════════════════════════════════════════════════════════════════

test("event fields: context.summary.created has correct usage fields", async () => {
  const telemetryCalls: Array<{
    eventType: string;
    payload: unknown;
    metrics?: Record<string, string | number | boolean | null>;
  }> = [];

  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "user", content: `msg ${i} `.repeat(10) });
  }

  const summaryUsage = {
    input: 450,
    output: 30,
    cacheRead: 20,
    cacheWrite: 10,
    cost: 0.003,
    turns: 1,
    toolCalls: 0,
    durationMs: 150,
  };

  const model: ModelPort = {
    async complete(_context: WorkContext, options?: Record<string, unknown>) {
      if (options?.strategyId === "selective-summary") {
        return {
          message: { role: "assistant", content: "summary" },
          usage: summaryUsage,
        };
      }
      return {
        message: { role: "assistant", content: "answer" },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({ messages }),
    config: {
      model: "test",
      budgetTokens: 100,
      maxModelCalls: 8,
      tokenCeiling: 32000,
    },
  });

  await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  const summaryEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.summary.created",
  );
  assert.ok(summaryEvents.length >= 1);

  const summaryEvent = summaryEvents[0]!;
  assert.equal(summaryEvent.metrics?.inputTokens, 450);
  assert.equal(summaryEvent.metrics?.outputTokens, 30);
  assert.equal(summaryEvent.metrics?.cost, 0.003);
  assert.equal(summaryEvent.metrics?.durationMs, 150);

  const summaryPayload = summaryEvent.payload as Record<string, unknown>;
  assert.equal(summaryPayload.strategyId, "selective-summary");
  assert.equal(summaryPayload.source, "observed");
});

// ═══════════════════════════════════════════════════════════════════
// Registry acceptance + definition/impl consistency
// ═══════════════════════════════════════════════════════════════════

test("registry: selectiveSummary is accepted by WorkLoopRegistry", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(SELECTIVE_SUMMARY_DEFINITION);

  const registry = new WorkLoopRegistry(definitions);
  assert.doesNotThrow(() => registry.register(selectiveSummary));

  const resolved = registry.require("selective-summary", "1.0.0");
  assert.equal(resolved.id, "selective-summary");
  assert.equal(resolved.version, "1.0.0");
});

test("registry: cloneModes consistency between definition and implementation", () => {
  const defModes = [...SELECTIVE_SUMMARY_DEFINITION.cloneModes].sort();
  const implModes = [...selectiveSummary.cloneModes].sort();

  assert.deepEqual(
    defModes,
    implModes,
    "definition and implementation cloneModes must match",
  );
  assert.ok(defModes.includes("fresh"), "must include fresh mode");
});

test("registry: both definition and impl cloneModes are exactly ['fresh']", () => {
  assert.deepEqual(SELECTIVE_SUMMARY_DEFINITION.cloneModes, ["fresh"]);
  assert.deepEqual(selectiveSummary.cloneModes, ["fresh"]);
});

// ═══════════════════════════════════════════════════════════════════
// Integration: createExperimentRuntime + selectiveSummary
// ═══════════════════════════════════════════════════════════════════

test("integration: selectiveSummary can be registered in experiment runtime", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: {
      complete: async () => ({
        message: { role: "assistant", content: "ok" },
      }),
    },
    tools: { execute: async () => "done" },
    artifacts: { put: async () => "r", get: async () => "v" },
  });

  // Register definition
  registerWorkLoopDefinition(rt.core, SELECTIVE_SUMMARY_DEFINITION);

  // Register implementation
  assert.doesNotThrow(() => rt.workloopRegistry.register(selectiveSummary));

  // Verify it's resolvable
  const impl = rt.workloopRegistry.require("selective-summary", "1.0.0");
  assert.equal(impl.id, "selective-summary");
});

// ═══════════════════════════════════════════════════════════════════
// budgetThreshold: strategy's own threshold drives invocation
// ═══════════════════════════════════════════════════════════════════

test("budgetThreshold: defaults to config.budgetTokens (8192)", async () => {
  const telemetryCalls: Array<{ eventType: string; payload: unknown }> = [];

  // Context with ~9000 tokens — exceeds 8192 default
  // Each message: ~50 chars → ceil(50/4) = ~13 tokens. 700 × 13 ≈ 9100 tokens.
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 700; i++) {
    messages.push({ role: "user", content: `msg ${i} `.repeat(10) });
  }

  const model: ModelPort = {
    async complete(_context: WorkContext, options?: Record<string, unknown>) {
      if (options?.strategyId === "selective-summary") {
        return {
          message: { role: "assistant", content: "summary" },
          usage: {
            input: 100, output: 5, cacheRead: 0, cacheWrite: 0,
            cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
          },
        };
      }
      return {
        message: { role: "assistant", content: "answer" },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  const sdk = makeSdk({ telemetryCalls, model });
  const input = makeInput({
    context: makeContext({ messages }),
    config: {
      model: "test",
      // budgetTokens not set — defaults to 8192 internally
      maxModelCalls: 8,
      tokenCeiling: 32000,
    },
  });

  await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // Should have triggered summarization (context > 8192)
  const summaryEvents = telemetryCalls.filter(
    (c) => c.eventType === "context.summary.created",
  );
  assert.ok(summaryEvents.length >= 1, "should summarize with default budget");
});

// ═══════════════════════════════════════════════════════════════════
// summaryModel override
// ═══════════════════════════════════════════════════════════════════

test("summaryModel: config.summaryModel passed to summary call options", async () => {
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "user", content: `msg ${i} `.repeat(10) });
  }

  const model: ModelPort & {
    calls: Array<{ context: WorkContext; options?: Record<string, unknown> }>;
  } = {
    calls: [],
    async complete(context: WorkContext, options?: Record<string, unknown>) {
      (this as typeof model).calls.push({ context, options });
      if (options?.strategyId === "selective-summary") {
        return {
          message: { role: "assistant", content: "summary" },
          usage: {
            input: 100, output: 5, cacheRead: 0, cacheWrite: 0,
            cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
          },
        };
      }
      return {
        message: { role: "assistant", content: "answer" },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  const sdk = makeSdk({ model });
  const input = makeInput({
    context: makeContext({ messages }),
    config: {
      model: "test",
      budgetTokens: 100,
      maxModelCalls: 8,
      tokenCeiling: 32000,
      summaryModel: "anthropic/claude-haiku",
    },
  });

  await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // Find the summary call's options
  const summaryCall = model.calls.find(
    (c) => c.options?.strategyId === "selective-summary",
  );
  assert.ok(summaryCall !== undefined, "summary model call should exist");
  assert.equal(
    summaryCall!.options?.model,
    "anthropic/claude-haiku",
    "summaryModel should be passed to the summary call",
  );
});

// ═══════════════════════════════════════════════════════════════════
// summaryWindow: oldest segment fraction
// ═══════════════════════════════════════════════════════════════════

test("summaryWindow: config.summaryWindow controls which segment is summarized", async () => {
  const messages: WorkMessage[] = [];
  // 20 messages — with summaryWindow=0.25, only first 5 should be summarized
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: "user",
      content: `msg-${String(i).padStart(2, "0")} `.repeat(5),
    });
  }

  let summaryContextMessages: WorkMessage[] = [];
  const model: ModelPort = {
    async complete(context: WorkContext, options?: Record<string, unknown>) {
      if (options?.strategyId === "selective-summary") {
        summaryContextMessages = context.messages;
        return {
          message: { role: "assistant", content: "summary" },
          usage: {
            input: 100, output: 5, cacheRead: 0, cacheWrite: 0,
            cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
          },
        };
      }
      return {
        message: { role: "assistant", content: "answer" },
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10,
        },
      };
    },
  };

  const sdk = makeSdk({ model });
  const input = makeInput({
    context: makeContext({ messages }),
    config: {
      model: "test",
      budgetTokens: 100,
      maxModelCalls: 8,
      tokenCeiling: 32000,
      summaryWindow: 0.25,
    },
  });

  await driveSelective(input.config as Record<string, unknown>, input, sdk as WorkLoopSDK);

  // With 20 messages and summaryWindow=0.25: splitIdx = floor(20*0.25) = 5
  // So oldest 5 messages should be summarized
  assert.equal(
    summaryContextMessages.length,
    5,
    "summaryWindow=0.25 → oldest 5 of 20 messages should be summarized",
  );

  // Verify the content: first message should be "msg-00", last should be "msg-04"
  const firstContent = typeof summaryContextMessages[0]?.content === "string"
    ? summaryContextMessages[0].content
    : "";
  const lastContent = typeof summaryContextMessages[4]?.content === "string"
    ? summaryContextMessages[4].content
    : "";
  assert.ok(firstContent.includes("msg-00"), "should contain oldest message");
  assert.ok(lastContent.includes("msg-04"), "should end with 5th oldest message");
});
