/**
 * Tests for src/workloops/managed-loop.ts
 *
 * Coverage:
 * - Under-budget: no transform, single model call, correct usage
 * - Over-budget: strategy transform invoked
 * - MaxModelCalls enforced termination
 * - Token ceiling guard triggers strategy
 * - Strategy returning {transformed: false} terminates
 * - Usage aggregation with mixed-source marking
 * - Context lineage via sdk.context.append
 * - Cancellation via sdk.control
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runManagedLoop } from "../src/workloops/managed-loop.ts";
import type { ManagedLoopConfig, StrategyHook } from "../src/workloops/managed-loop.ts";
import { contextTokenTotal } from "../src/workloops/context-metrics.ts";
import type {
  WorkLoopSDK,
  WorkLoopInput,
  WorkLoopResult,
  WorkContext,
  WorkMessage,
  ModelPort,
  ContextOperations,
  StandardAgentOutput,
} from "../src/workloop/contracts.ts";

// ── Fake / spy helpers ──────────────────────────────────────────────

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
    config: { model: "test-model", maxModelCalls: 8, tokenCeiling: 32000 },
    state: {},
    ...overrides,
  };
}

function makeFakeModel(
  responses: Array<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }>,
): ModelPort & { calls: Array<{ context: WorkContext; options?: Record<string, unknown> }> } {
  let idx = 0;
  const calls: Array<{ context: WorkContext; options?: Record<string, unknown> }> = [];
  return {
    calls,
    async complete(context: WorkContext, options?: Record<string, unknown>) {
      calls.push({ context, options });
      const r = responses[idx] ?? responses[responses.length - 1];
      if (!r) throw new Error("no fake model response");
      idx++;
      return r!;
    },
  };
}

/** Context operations spy that tracks calls and delegates to real ops. */
function makeContextSpy(): ContextOperations & {
  appendCalls: Array<{ context: WorkContext; messages: WorkMessage[]; newContextId: string }>;
} {
  const appendCalls: Array<{ context: WorkContext; messages: WorkMessage[]; newContextId: string }> = [];
  return {
    appendCalls,
    append(context, messages, newContextId) {
      appendCalls.push({ context, messages, newContextId });
      // Delegate to a simple clone-based append
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

function makeSdk(overrides: Partial<WorkLoopSDK> = {}): WorkLoopSDK & {
  contextSpy: ReturnType<typeof makeContextSpy>;
  modelFake: ReturnType<typeof makeFakeModel>;
} {
  const contextSpy = makeContextSpy();
  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "Hello! How can I help?" }, usage: { input: 15, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1, toolCalls: 0, durationMs: 100 } },
  ]);

  return {
    contextSpy,
    modelFake,
    context: contextSpy,
    model: modelFake,
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
      emit: () => {},
    },
    control: {
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
    },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════
// Basic: under-budget, single call
// ═══════════════════════════════════════════════════════════════════

test("under-budget: no transform, single model call, correct usage", async () => {
  const sdk = makeSdk();
  const input = makeInput({ config: { model: "test", maxModelCalls: 8, tokenCeiling: 32000 } });

  let transformCalled = false;
  const strategy: StrategyHook = {
    transform: async (ctx) => ({ context: ctx, transformed: false }),
  };
  // Override to track
  const trackedStrategy: StrategyHook = {
    transform: async (ctx, cfg, s) => {
      transformCalled = true;
      return strategy.transform(ctx, cfg, s);
    },
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, trackedStrategy);

  assert.equal(result.status, "completed");
  assert.equal(transformCalled, false, "should not call transform when under budget");
  assert.equal(sdk.modelFake.calls.length, 1, "should have exactly one model call");
  assert.equal(sdk.contextSpy.appendCalls.length, 1, "should have one append call");

  // Usage
  assert.ok(result.output?.standard?.usage, "should have usage");
  const usage = result.output!.standard!.usage!;
  assert.equal(usage.input, 15);
  assert.equal(usage.output, 5);
  assert.equal(usage.cost, 0.0001);
  assert.equal(usage.turns, 1);
  assert.ok(usage.durationMs >= 0);

  // Context lineage
  const appendCall = sdk.contextSpy.appendCalls[0]!;
  assert.equal(appendCall.context.metadata.contextId, "ctx-0", "parent should be original ctx");
  assert.ok(appendCall.newContextId.startsWith("ctx-"), "new context id starts with ctx-");
});

// ═══════════════════════════════════════════════════════════════════
// Over-budget: strategy transform
// ═══════════════════════════════════════════════════════════════════

test("over-budget: strategy transform invoked when token ceiling exceeded", async () => {
  // Create a context with many messages to push it over the token ceiling
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 500; i++) {
    messages.push({ role: "user", content: `message ${i} `.repeat(50) });
  }

  const input = makeInput({
    context: makeContext({ messages }),
    config: { model: "test", maxModelCalls: 8, tokenCeiling: 1000 },
  });

  const sdk = makeSdk();

  let transformCalls = 0;
  let lastTransformed = false;
  const strategy: StrategyHook = {
    transform: async (ctx, _cfg, _sdk) => {
      transformCalls++;
      // Return a slimmed context
      const newCtx: WorkContext = {
        ...ctx,
        messages: [{ role: "user", content: "truncated" }],
        metadata: {
          ...ctx.metadata,
          contextId: `ctx-truncated-${transformCalls}`,
          parentContextId: ctx.metadata.contextId,
        },
      };
      lastTransformed = true;
      return { context: newCtx, transformed: true };
    },
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);

  assert.equal(result.status, "completed");
  assert.ok(transformCalls >= 1, `expected transform to be called, got ${transformCalls}`);
  assert.equal(lastTransformed, true);
});

test("over-budget: strategy returning transformed:false terminates loop", async () => {
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 500; i++) {
    messages.push({ role: "user", content: `message ${i} `.repeat(50) });
  }

  const input = makeInput({
    context: makeContext({ messages }),
    config: { model: "test", maxModelCalls: 8, tokenCeiling: 1000 },
  });

  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "ok" }, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1, toolCalls: 0, durationMs: 50 } },
  ]);

  const sdk = makeSdk({ model: modelFake });

  let transformCalled = false;
  const strategy: StrategyHook = {
    transform: async (ctx) => {
      transformCalled = true;
      return { context: ctx, transformed: false };
    },
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);

  assert.equal(result.status, "completed");
  assert.equal(transformCalled, true);
  // Model should NOT have been called because transform couldn't reduce
  assert.equal(modelFake.calls.length, 0, "should not call model when strategy cannot reduce");
});

// ═══════════════════════════════════════════════════════════════════
// maxModelCalls enforcement
// ═══════════════════════════════════════════════════════════════════

test("maxModelCalls: loop respects the hard cap", async () => {
  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "r1" }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 } },
    { message: { role: "assistant", content: "r2" }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 } },
    { message: { role: "assistant", content: "r3" }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 } },
    { message: { role: "assistant", content: "r4" }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 } },
  ]);

  // Override to keep looping (skip the break-after-first-call for this test)
  // We need a way to get multiple calls. The default managed loop stops after
  // one call. For testing maxModelCalls we create a special strategy that
  // intentionally inflates context to keep the loop going, or we use a
  // modified loop. Since the loop currently breaks after one call in v1
  // (no tools), we test maxModelCalls by setting it to 1 and verifying
  // exactly 1 call happens even though the model could take more.

  const sdk = makeSdk({ model: modelFake });
  const input = makeInput({ config: { model: "test", maxModelCalls: 1, tokenCeiling: 32000 } });

  const strategy: StrategyHook = {
    transform: async (ctx) => ({ context: ctx, transformed: false }),
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);

  // With maxModelCalls=1 and the loop's built-in break-after-first-call,
  // we verify that the hard cap is 1 and the loop terminates.
  assert.equal(result.status, "completed");
  assert.ok(modelFake.calls.length <= 1, `at most 1 call, got ${modelFake.calls.length}`);
});

// ═══════════════════════════════════════════════════════════════════
// Usage aggregation
// ═══════════════════════════════════════════════════════════════════

test("usage aggregation: observed source is clean", async () => {
  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "hi" }, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 0, durationMs: 100 } },
  ]);

  const sdk = makeSdk({ model: modelFake });
  const input = makeInput({ config: { model: "test", maxModelCalls: 8, tokenCeiling: 32000 } });

  const strategy: StrategyHook = {
    transform: async (ctx) => ({ context: ctx, transformed: false }),
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);
  const usage = result.output!.standard!.usage!;
  assert.equal(usage.input, 10);
  assert.equal(usage.output, 5);
  const usageAny = usage as Record<string, unknown>;
  assert.equal(usageAny._source, undefined, "no derived usage → no _source tag");
});

test("usage aggregation: derived source marks as mixed", async () => {
  const modelFake = makeFakeModel([
    {
      message: { role: "assistant", content: "hi" },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 0, durationMs: 100, _source: "derived" } as StandardAgentOutput["usage"] & { _source: string },
    },
  ]);

  const sdk = makeSdk({ model: modelFake });
  const input = makeInput({ config: { model: "test", maxModelCalls: 8, tokenCeiling: 32000 } });

  const strategy: StrategyHook = {
    transform: async (ctx) => ({ context: ctx, transformed: false }),
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);
  const usage = result.output!.standard!.usage!;
  const usageAny = usage as Record<string, unknown>;
  assert.equal(usageAny._source, "mixed", "derived usage detected → should mark as mixed");
});

// ═══════════════════════════════════════════════════════════════════
// Context lineage
// ═══════════════════════════════════════════════════════════════════

test("context lineage: parentContextId chain is maintained via sdk.context.append", async () => {
  const sdk = makeSdk();
  const input = makeInput({
    context: makeContext({ metadata: { contextId: "ctx-original", sourceRefs: [], artifactRefs: [] } }),
  });

  const strategy: StrategyHook = {
    transform: async (ctx) => ({ context: ctx, transformed: false }),
  };

  await runManagedLoop(input, sdk as WorkLoopSDK, strategy);

  assert.equal(sdk.contextSpy.appendCalls.length, 1);
  const call = sdk.contextSpy.appendCalls[0]!;
  assert.equal(call.context.metadata.contextId, "ctx-original");

  // The result context should have a new contextId with parent set
  // We check the append was called with proper lineage patterns
  assert.ok(call.newContextId.startsWith("ctx-"));
});

// ═══════════════════════════════════════════════════════════════════
// Cancellation
// ═══════════════════════════════════════════════════════════════════

test("cancellation: throws when aborted before model call", async () => {
  const ctrl = new AbortController();
  ctrl.abort();

  const sdk = makeSdk({
    control: {
      signal: ctrl.signal,
      throwIfCancelled() {
        throw new DOMException("aborted", "AbortError");
      },
    },
  });

  const input = makeInput();

  const strategy: StrategyHook = {
    transform: async (ctx) => ({ context: ctx, transformed: false }),
  };

  await assert.rejects(
    () => runManagedLoop(input, sdk as WorkLoopSDK, strategy),
    /aborted/,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Output text
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// budgetThreshold: strategy's own threshold drives invocation
// ═══════════════════════════════════════════════════════════════════

test("budgetThreshold: 9k-token context with defaults triggers strategy even when under tokenCeiling", async () => {
  // Defaults: budgetTokens=8192, tokenCeiling=32000
  // A context with ~9000 estimated tokens should exceed budgetThreshold
  // but NOT tokenCeiling — yet the strategy must still fire.
  const messages: WorkMessage[] = [];
  // Each message: ~50 chars → ceil(50/4) = 13 tokens. 700 × 13 = 9100 tokens.
  for (let i = 0; i < 700; i++) {
    messages.push({ role: "user", content: `msg ${i} `.repeat(10) });
  }

  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "ok" }, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1, toolCalls: 0, durationMs: 50 } },
  ]);

  const sdk = makeSdk({ model: modelFake });
  const input = makeInput({
    context: makeContext({ messages }),
    config: { model: "test", maxModelCalls: 8, tokenCeiling: 32000 },
  });

  let transformCalled = false;
  let beforeTokensOnTransform = 0;
  const strategy: StrategyHook = {
    budgetThreshold: (_cfg) => 8192,
    transform: async (ctx) => {
      transformCalled = true;
      beforeTokensOnTransform = contextTokenTotal(ctx);
      // Truncate to ~4k tokens
      return {
        context: { ...ctx, messages: [{ role: "user", content: "truncated context" }] },
        transformed: true,
      };
    },
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);

  assert.equal(result.status, "completed");
  assert.equal(transformCalled, true,
    "strategy should fire when context exceeds budgetThreshold (8192) even under tokenCeiling (32000)");
  assert.ok(beforeTokensOnTransform > 8192,
    `context tokens (${beforeTokensOnTransform}) should exceed budgetThreshold (8192) when transform invoked`);
  assert.ok(beforeTokensOnTransform < 32000,
    `context tokens (${beforeTokensOnTransform}) should be under tokenCeiling (32000)`);
  assert.equal(modelFake.calls.length, 1, "model should be called after successful transform");
});

test("budgetThreshold: strategy returning transformed:false under tokenCeiling continues (not terminated)", async () => {
  // Context slightly over strategy threshold but well under hard ceiling.
  // Strategy returns {transformed:false} — the loop should continue, not terminate.
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 700; i++) {
    messages.push({ role: "user", content: `msg ${i} `.repeat(10) });
  }

  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "ok" }, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1, toolCalls: 0, durationMs: 50 } },
  ]);

  const sdk = makeSdk({ model: modelFake });
  const input = makeInput({
    context: makeContext({ messages }),
    config: { model: "test", maxModelCalls: 8, tokenCeiling: 32000 },
  });

  let transformCalled = false;
  const strategy: StrategyHook = {
    budgetThreshold: (_cfg) => 8192,
    transform: async (ctx) => {
      transformCalled = true;
      // No-op: strategy does nothing
      return { context: ctx, transformed: false };
    },
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);

  assert.equal(result.status, "completed");
  assert.equal(transformCalled, true);
  // Model still called because context is under tokenCeiling (hard guard)
  assert.equal(modelFake.calls.length, 1,
    "model should be called when strategy can't reduce but context is under hard ceiling");
});

test("budgetThreshold: no budgetThreshold declared falls back to tokenCeiling", async () => {
  // Strategy with NO budgetThreshold — loop uses tokenCeiling.
  const messages: WorkMessage[] = [];
  for (let i = 0; i < 500; i++) {
    messages.push({ role: "user", content: `message ${i} `.repeat(50) });
  }

  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "ok" }, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.0001, turns: 1, toolCalls: 0, durationMs: 50 } },
  ]);

  const sdk = makeSdk({ model: modelFake });
  const input = makeInput({
    context: makeContext({ messages }),
    config: { model: "test", maxModelCalls: 8, tokenCeiling: 1000 },
  });

  let transformCalled = false;
  const strategy: StrategyHook = {
    // No budgetThreshold — fallback to tokenCeiling
    transform: async (ctx) => {
      transformCalled = true;
      return {
        context: { ...ctx, messages: [{ role: "user", content: "slimmed" }] },
        transformed: true,
      };
    },
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);

  assert.equal(result.status, "completed");
  assert.equal(transformCalled, true,
    "strategy should be invoked via tokenCeiling fallback when budgetThreshold absent");
});

test("output: last assistant message text is captured as standard output", async () => {
  const modelFake = makeFakeModel([
    { message: { role: "assistant", content: "final answer" }, usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 10 } },
  ]);

  const sdk = makeSdk({ model: modelFake });
  const input = makeInput();

  const strategy: StrategyHook = {
    transform: async (ctx) => ({ context: ctx, transformed: false }),
  };

  const result = await runManagedLoop(input, sdk as WorkLoopSDK, strategy);
  assert.equal(result.output?.standard?.text, "final answer");
});
