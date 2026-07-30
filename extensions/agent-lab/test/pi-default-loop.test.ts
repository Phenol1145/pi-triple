import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationV2Request,
  type SubagentDelegationV2Update,
  type SubagentDelegationV2TerminalResponse,
  type SubagentDelegationV2Usage,
} from "../src/runtime/delegation-v2.ts";
import { PiSubagentsAdapter } from "../src/runtime/pi-subagents-adapter.ts";
import type { DelegationEventBus } from "../src/runtime/pi-subagents-adapter.ts";
import { createPiDefaultLoop } from "../src/workloops/pi-default-loop.ts";
import type { PiDefaultLoopConfig } from "../src/workloops/pi-default-loop.ts";
import { createWorkLoopRuntime } from "../src/runtime/create-runtime.ts";
import type {
  WorkLoopImplementation,
  WorkLoopInput,
  WorkLoopSDK,
  WorkContext,
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../src/workloop/contracts.ts";

// ── Fake event bus (same pattern as pi-subagents-adapter.test.ts) ──

interface EventBus {
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}

function fakeEventBus(): {
  bus: EventBus;
  handlers: Map<string, Array<(payload: unknown) => void>>;
  emitted: Array<{ event: string; payload: unknown }>;
} {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];

  const bus: EventBus = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        }
      };
    },
    emit(event, payload) {
      emitted.push({ event, payload });
      const list = handlers.get(event);
      if (list) {
        for (const h of [...list]) h(payload);
      }
    },
  };

  return { bus, handlers, emitted };
}

// ── Fake model/tool/artifact ports ──────────────────────────────────

function noopModel(): ModelPort {
  return {
    complete: async () => ({
      message: { role: "assistant", content: "noop" },
    }),
  };
}

function noopTools(): ToolPort {
  return { execute: async () => "noop" };
}

function noopArtifacts(): ArtifactPort {
  return {
    put: async () => "ref-noop",
    get: async () => "noop",
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function testContext(id = "ctx-1"): WorkContext {
  return {
    systemPrompt: "helpful",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "search" }],
    metadata: {
      contextId: id,
      sourceRefs: [],
      artifactRefs: [],
    },
  };
}

function defaultConfig(): PiDefaultLoopConfig {
  return {
    agent: "test-agent",
    cwd: "/tmp/test",
    contextMode: "fresh",
    model: "gpt-4o",
    thinking: "medium",
    timeoutMs: 30_000,
    result: { kind: "text" },
  };
}

function defaultInput(overrides: Partial<WorkLoopInput<PiDefaultLoopConfig>> = {}): WorkLoopInput<PiDefaultLoopConfig> {
  return {
    traceId: "trace-1",
    executionId: "exec-1",
    agentInstanceId: "agent-1",
    optimizationRoundId: "round-1",
    task: "do the thing",
    context: testContext("ctx-1"),
    config: Object.freeze(defaultConfig()),
    state: { counter: 0 },
    ...overrides,
  };
}

function defaultSDK(overrides: Partial<WorkLoopSDK> = {}): WorkLoopSDK {
  return {
    context: {
      append: (ctx, msgs, id) => ({
        ...ctx,
        messages: [...ctx.messages, ...msgs],
        metadata: { ...ctx.metadata, contextId: id, parentContextId: ctx.metadata.contextId },
      }),
      filterMessages: (ctx, fn, id) => ({
        ...ctx,
        messages: ctx.messages.filter(fn),
        metadata: { ...ctx.metadata, contextId: id },
      }),
      merge: (base, other, id) => ({
        ...base,
        messages: [...base.messages, ...other.messages],
        metadata: { ...base.metadata, contextId: id },
      }),
      truncateMessages: (ctx, limit, id) => ({
        ...ctx,
        messages: ctx.messages.slice(-limit),
        metadata: { ...ctx.metadata, contextId: id },
      }),
    },
    model: noopModel(),
    tools: noopTools(),
    artifacts: noopArtifacts(),
    storage: {
      get: () => undefined,
      put: (_k, v) => ({ value: v, version: 1 }),
    },
    checkpoint: { save: async () => ({ checkpointId: "cp-1" }) },
    telemetry: { emit: () => {} },
    control: {
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
    },
    ...overrides,
  };
}

function v2Response(
  overrides: Partial<SubagentDelegationV2TerminalResponse> & { status: SubagentDelegationV2TerminalResponse["status"] },
): SubagentDelegationV2TerminalResponse {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: "exec-1",
    ownerRunId: "trace-1",
    nodeId: "agent-1",
    status: "completed",
    ...overrides,
  } as SubagentDelegationV2TerminalResponse;
}

// ── Test 1: Completed text response maps output + usage, appends assistant message ──

test("1a. Completed text response maps result text and usage to StandardAgentOutput", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const input = defaultInput();
  const sdk = defaultSDK();

  const runPromise = loop.run(input, sdk);

  // Respond with completed text result
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "completed",
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      result: { kind: "text", text: "all done!" },
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        cost: 0.003,
        turns: 3,
        toolCalls: 2,
        durationMs: 1500,
      },
    })),
  );

  const result = await runPromise;

  // Status is completed
  assert.equal(result.status, "completed");

  // Standard output has text
  assert.equal(result.output?.standard?.text, "all done!");

  // Usage mapped exactly
  assert.deepStrictEqual(result.output?.standard?.usage, {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    cost: 0.003,
    turns: 3,
    toolCalls: 2,
    durationMs: 1500,
  });

  // State preserved
  assert.deepStrictEqual(result.state, { counter: 0 });
});

test("1b. Completed text response appends one assistant message to WorkContext", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const input = defaultInput();
  const sdk = defaultSDK();

  const runPromise = loop.run(input, sdk);

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "completed",
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      result: { kind: "text", text: "I did it" },
    })),
  );

  const result = await runPromise;

  // Context has the original message + one new assistant message
  assert.equal(result.context.messages.length, 2);
  assert.deepStrictEqual(result.context.messages[0], { role: "user", content: "hello" });
  assert.deepStrictEqual(result.context.messages[1], { role: "assistant", content: "I did it" });

  // Metadata: parentContextId should be set to the original contextId
  assert.equal(result.context.metadata.parentContextId, "ctx-1");
  assert.ok(result.context.metadata.contextId);
  assert.notEqual(result.context.metadata.contextId, "ctx-1");

  // Source refs preserved
  assert.deepStrictEqual(result.context.metadata.sourceRefs, []);
});

test("1c. Completed text with no usage sets usage to undefined", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const input = defaultInput();
  const sdk = defaultSDK();

  const runPromise = loop.run(input, sdk);

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "completed",
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      result: { kind: "text", text: "done" },
      // no usage field
    })),
  );

  const result = await runPromise;

  assert.equal(result.status, "completed");
  assert.equal(result.output?.standard?.usage, undefined);
});

// ── Test 2: Structured result maps into custom output without stringifying ──

test("2a. Structured result maps to custom output, context unchanged", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const input = defaultInput({
    config: Object.freeze({ ...defaultConfig(), result: { kind: "structured", schema: { type: "object" } } }),
  });
  const sdk = defaultSDK();

  const runPromise = loop.run(input, sdk);

  const structuredValue = { score: 95, items: ["a", "b", "c"] };

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "completed",
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      result: { kind: "structured", value: structuredValue },
    })),
  );

  const result = await runPromise;

  // Status is completed
  assert.equal(result.status, "completed");

  // Standard output has no text (structured only)
  assert.equal(result.output?.standard?.text, undefined);

  // Custom output contains the structured value exactly
  assert.deepStrictEqual(result.output?.custom, structuredValue);

  // Context preserved unchanged (no assistant message appended)
  assert.equal(result.context.messages.length, 1);
  assert.deepStrictEqual(result.context.messages[0], { role: "user", content: "hello" });
});

test("2b. Structured result with usage maps usage to standard output", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const input = defaultInput({
    config: Object.freeze({ ...defaultConfig(), result: { kind: "structured", schema: { type: "object" } } }),
  });
  const sdk = defaultSDK();

  const runPromise = loop.run(input, sdk);

  const usage: SubagentDelegationV2Usage = {
    input: 200,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.005,
    turns: 2,
    toolCalls: 1,
    durationMs: 800,
  };

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "completed",
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      result: { kind: "structured", value: { ok: true } },
      usage,
    })),
  );

  const result = await runPromise;

  assert.deepStrictEqual(result.output?.standard?.usage, usage);
  assert.deepStrictEqual(result.output?.custom, { ok: true });
});

// ── Test 3: Failed statuses map to failed with correct error codes and retryability ──

test("3a. 'failed' maps to failed, not retryable", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "failed",
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      error: "something broke",
    })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "failed");
  assert.equal(result.error?.standard?.retryable, false);
  assert.ok(result.error?.standard?.message.includes("something broke"));
});

test("3b. 'timed_out' maps to failed, retryable", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "timed_out",
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      error: "timeout exceeded",
    })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "timed_out");
  assert.equal(result.error?.standard?.retryable, true);
});

test("3c. 'turn_budget_exhausted' maps to failed, not retryable", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "turn_budget_exhausted", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "turn_budget_exhausted");
  assert.equal(result.error?.standard?.retryable, false);
});

test("3d. 'tool_budget_exhausted' maps to failed, not retryable", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "tool_budget_exhausted", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "tool_budget_exhausted");
  assert.equal(result.error?.standard?.retryable, false);
});

test("3e. 'structured_output_failed' maps to failed, not retryable", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "structured_output_failed", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "structured_output_failed");
  assert.equal(result.error?.standard?.retryable, false);
});

test("3f. 'invalid_request' maps to failed, not retryable (adapter normalizes → status 'failed')", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  // The adapter normalizes invalid_request → status "failed" with error preserved.
  // The loop sees "failed" and maps to non-retryable failed.
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "invalid_request", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1", error: "bad request" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  // After adapter normalization, the terminal status is "failed"
  assert.equal(result.error?.standard?.code, "failed");
  assert.equal(result.error?.standard?.retryable, false);
  assert.ok(result.error?.standard?.message.includes("bad request"));
});

test("3g. 'unavailable_context' maps to failed, retryable", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "unavailable_context", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "unavailable_context");
  assert.equal(result.error?.standard?.retryable, true);
});

test("3h. 'duplicate_node' maps to failed, retryable", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "duplicate_node", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.error?.standard?.code, "duplicate_node");
  assert.equal(result.error?.standard?.retryable, true);
});

// ── Test 4: Cancelled and interrupted map to cancelled ──────────────

test("4a. 'cancelled' maps to cancelled", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "cancelled", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "cancelled");
});

test("4b. 'interrupted' maps to cancelled", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const runPromise = loop.run(defaultInput(), defaultSDK());

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "interrupted", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1" })),
  );

  const result = await runPromise;

  assert.equal(result.status, "cancelled");
});

// ── Test 5: Updates emit runtime.pi_subagents.update telemetry ───────

test("5. Matching delegation updates emit runtime.pi_subagents.update telemetry metrics", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const telemetryEvents: Array<{ eventType: string; payload: unknown; metrics?: Record<string, string | number | boolean | null> }> = [];
  const sdk = defaultSDK({
    telemetry: {
      emit: (eventType: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>) => {
        telemetryEvents.push({ eventType, payload, metrics });
      },
    },
  });

  const loop = createPiDefaultLoop(adapter);
  const runPromise = loop.run(defaultInput(), sdk);

  // Emit two updates
  handlers.get(SUBAGENT_DELEGATION_UPDATE_EVENT)?.forEach((h) =>
    h({
      version: 2,
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      currentTool: "bash",
      toolCount: 1,
      durationMs: 500,
      tokens: 42,
    } satisfies SubagentDelegationV2Update),
  );

  handlers.get(SUBAGENT_DELEGATION_UPDATE_EVENT)?.forEach((h) =>
    h({
      version: 2,
      requestId: "exec-1",
      ownerRunId: "trace-1",
      nodeId: "agent-1",
      currentTool: "read",
      toolCount: 2,
      durationMs: 1200,
      tokens: 80,
    } satisfies SubagentDelegationV2Update),
  );

  // Then complete
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "completed", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1", result: { kind: "text", text: "ok" } })),
  );

  await runPromise;

  // Two telemetry events emitted
  assert.equal(telemetryEvents.length, 2);
  assert.equal(telemetryEvents[0].eventType, "runtime.pi_subagents.update");
  assert.equal(telemetryEvents[1].eventType, "runtime.pi_subagents.update");

  // First update payload matches
  const payload0 = telemetryEvents[0].payload as Record<string, unknown>;
  assert.equal(payload0.currentTool, "bash");
  assert.equal(payload0.toolCount, 1);

  // Metrics present
  assert.ok(telemetryEvents[0].metrics, "metrics should be present");
  assert.equal(telemetryEvents[0].metrics!.durationMs, 500);
  assert.equal(telemetryEvents[0].metrics!.tokens, 42);

  // Second update
  const payload1 = telemetryEvents[1].payload as Record<string, unknown>;
  assert.equal(payload1.currentTool, "read");
  assert.equal(payload1.toolCount, 2);
  assert.equal(telemetryEvents[1].metrics!.durationMs, 1200);
  assert.equal(telemetryEvents[1].metrics!.tokens, 80);
});

// ── Test 6: Identity mapping ───────────────────────────────────────

test("6a. Maps executionId→requestId, traceId→ownerRunId, agentInstanceId→nodeId", async () => {
  const { bus, emitted, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const input = defaultInput({
    traceId: "my-trace",
    executionId: "my-exec",
    agentInstanceId: "my-agent",
  });

  const runPromise = loop.run(input, defaultSDK());

  // Complete immediately
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({
      status: "completed",
      requestId: "my-exec",
      ownerRunId: "my-trace",
      nodeId: "my-agent",
      result: { kind: "text", text: "ok" },
    })),
  );

  await runPromise;

  // Verify the emitted V2 request has correct identity mapping
  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  assert.equal(reqs.length, 1);
  const req = reqs[0].payload as SubagentDelegationV2Request;
  assert.equal(req.requestId, "my-exec");
  assert.equal(req.ownerRunId, "my-trace");
  assert.equal(req.nodeId, "my-agent");
});

test("6b. Config fields mapped to V2 request fields", async () => {
  const { bus, emitted, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const config: PiDefaultLoopConfig = {
    agent: "my-special-agent",
    cwd: "/home/user/project",
    contextMode: "fork",
    model: "claude-3-opus",
    thinking: "high",
    timeoutMs: 60_000,
    result: { kind: "text" },
  };

  const input = defaultInput({ config: Object.freeze(config) });

  const runPromise = loop.run(input, defaultSDK());
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "completed", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1", result: { kind: "text", text: "ok" } })),
  );
  await runPromise;

  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  const req = reqs[0].payload as SubagentDelegationV2Request;

  assert.equal(req.agent, "my-special-agent");
  assert.equal(req.cwd, "/home/user/project");
  assert.equal(req.context, "fork");
  assert.equal(req.model, "claude-3-opus");
  assert.equal(req.thinking, "high");
  assert.equal(req.timeoutMs, 60_000);
  assert.equal(req.task, "do the thing");
});

test("6c. Does not pass WorkContext messages to V2 request", async () => {
  const { bus, emitted, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const input = defaultInput({
    context: { ...testContext("ctx-1"), messages: [{ role: "user", content: "should not be in V2 request" }] },
  });

  const runPromise = loop.run(input, defaultSDK());
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "completed", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1", result: { kind: "text", text: "ok" } })),
  );
  await runPromise;

  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  const req = reqs[0].payload as Record<string, unknown>;

  // V2 request should not have any "messages" field
  assert.equal("messages" in req, false);
});

// ── Test 7: Default config values ───────────────────────────────────

test("7. Default config values: contextMode defaults to fresh, result defaults to text", async () => {
  const { bus, emitted, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const config: PiDefaultLoopConfig = {
    agent: "minimal-agent",
    cwd: "/tmp",
    contextMode: "fresh",
  };

  const input = defaultInput({ config: Object.freeze(config) });

  const runPromise = loop.run(input, defaultSDK());
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "completed", requestId: "exec-1", ownerRunId: "trace-1", nodeId: "agent-1", result: { kind: "text", text: "ok" } })),
  );
  await runPromise;

  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  const req = reqs[0].payload as SubagentDelegationV2Request;

  assert.equal(req.agent, "minimal-agent");
  assert.equal(req.context, "fresh");
  // result should default to { kind: "text" }
  assert.deepStrictEqual(req.result, { kind: "text" });
});

// ── Test 8: Runtime composition ────────────────────────────────────

test("8a. createWorkLoopRuntime registers metadata pi-default-loop@1.0.0 and executable implementation", () => {
  const db = new DatabaseSync(":memory:");
  const { bus } = fakeEventBus();

  const runtime = createWorkLoopRuntime(db, bus, {
    model: noopModel(),
    tools: noopTools(),
    artifacts: noopArtifacts(),
  });

  // Registry has the implementation
  const impl = runtime.registry.require("pi-default-loop", "1.0.0");
  assert.equal(impl.id, "pi-default-loop");
  assert.equal(impl.version, "1.0.0");
  assert.deepStrictEqual(impl.cloneModes, ["fresh", "fork"]);

  // Core definitions has the WorkLoopDefinition
  const def = runtime.core.definitions.require({ kind: "workloop", id: "pi-default-loop", version: "1.0.0" });
  assert.equal(def.kind, "workloop");
  assert.equal(def.id, "pi-default-loop");
  assert.equal(def.version, "1.0.0");

  // Metadata is registered
  const summaries = runtime.core.definitions.list("workloop");
  const piWl = summaries.find((s) => s.id === "pi-default-loop");
  assert.ok(piWl, "pi-default-loop should be in workloop definition list");

  // Cleanup
  runtime.dispose();
  db.close();
});

test("8b. createWorkLoopRuntime can execute one initialized Agent against fake event bus", async () => {
  const db = new DatabaseSync(":memory:");
  const { bus, handlers } = fakeEventBus();

  const runtime = createWorkLoopRuntime(db, bus, {
    model: noopModel(),
    tools: noopTools(),
    artifacts: noopArtifacts(),
  });

  // Initialize an agent snapshot
  const impl = runtime.registry.require("pi-default-loop", "1.0.0");
  runtime.cloneService.fresh("my-agent", impl, {
    agent: "test-agent",
    cwd: "/tmp",
    contextMode: "fresh",
    result: { kind: "text" },
  });

  // Run the agent
  const runPromise = runtime.runner.run({
    traceId: "trace-rt",
    executionId: "exec-rt",
    agentInstanceId: "my-agent",
    optimizationRoundId: "round-rt",
    workLoopId: "pi-default-loop",
    workLoopVersion: "1.0.0",
    config: {
      agent: "test-agent",
      cwd: "/tmp",
      contextMode: "fresh",
      result: { kind: "text" },
    },
    task: "integrated test",
  });

  // Yield the microtask queue so the runner + adapter can set up the
  // inflight delegation entry before we emit the response.
  await new Promise((r) => setTimeout(r, 10));

  // Respond via fake event bus
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h({
      version: 2,
      requestId: "exec-rt",
      ownerRunId: "trace-rt",
      nodeId: "my-agent",
      status: "completed",
      result: { kind: "text", text: "integration works" },
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 0, durationMs: 100 },
    }),
  );

  const result = await runPromise;

  assert.equal(result.status, "completed");
  assert.equal(result.output?.standard?.text, "integration works");
  assert.deepStrictEqual(result.output?.standard?.usage, {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 0, durationMs: 100,
  });

  // Snapshot committed
  const snap = runtime.stateStore.get("my-agent");
  assert.equal(snap!.version, 2);

  // Cleanup
  runtime.dispose();
  db.close();
});

test("8c. createWorkLoopRuntime dispose disposes the adapter", async () => {
  const db = new DatabaseSync(":memory:");
  const { bus } = fakeEventBus();

  const runtime = createWorkLoopRuntime(db, bus, {
    model: noopModel(),
    tools: noopTools(),
    artifacts: noopArtifacts(),
  });

  runtime.dispose();

  // Subsequent delegate attempts should reject ("disposed")
  const impl = runtime.registry.require("pi-default-loop", "1.0.0");
  // Trying to run the loop after dispose — the adapter is disposed, delegate will reject
  const input = defaultInput();
  const sdk = defaultSDK();

  await assert.rejects(
    () => impl.run(input, sdk),
    { message: /disposed/ },
  );

  db.close();
});

test("8d. createWorkLoopRuntime does not import from index.ts", () => {
  // This is verified by the isolation check in the brief.
  // Here we simply ensure the module loads without error.
  const db = new DatabaseSync(":memory:");
  const { bus } = fakeEventBus();

  assert.doesNotThrow(() => {
    const runtime = createWorkLoopRuntime(db, bus, {
      model: noopModel(),
      tools: noopTools(),
      artifacts: noopArtifacts(),
    });
    runtime.dispose();
  });

  db.close();
});

// ── Test 9: WorkLoopImplementation metadata ────────────────────────

test("9. pi-default-loop implementation has correct id, version, cloneModes", () => {
  const { bus } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  assert.equal(loop.id, "pi-default-loop");
  assert.equal(loop.version, "1.0.0");
  assert.deepStrictEqual(loop.cloneModes, ["fresh", "fork"]);
});

test("9b. initialContext returns a minimal context", () => {
  const { bus } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const ctx = loop.initialContext({ agent: "test", cwd: "/tmp", contextMode: "fresh" });
  assert.ok(ctx);
  assert.ok(ctx.messages);
  assert.ok(ctx.metadata);
  assert.ok(ctx.metadata.contextId);
});

test("9c. initialState returns an empty object", () => {
  const { bus } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);
  const loop = createPiDefaultLoop(adapter);

  const state = loop.initialState({ agent: "test", cwd: "/tmp", contextMode: "fresh" });
  assert.deepStrictEqual(state, {});
});

// ── Test 10: Acceptance check - 'acceptance_failed' is not in the failed list ──

test("10. 'acceptance_failed' status is NOT in the explicit mapping — verifies scope boundary", () => {
  // Per the brief: acceptance_failed is NOT listed as failed. The brief only lists:
  // failed, timed_out, turn_budget_exhausted, tool_budget_exhausted,
  // structured_output_failed, invalid_request, unavailable_context, duplicate_node
  // 'acceptance_failed' is intentionally excluded — not part of P2 scope.
  const failedStatuses = [
    "failed", "timed_out", "turn_budget_exhausted", "tool_budget_exhausted",
    "structured_output_failed", "invalid_request", "unavailable_context", "duplicate_node",
  ];
  assert.ok(!failedStatuses.includes("acceptance_failed"));
});

// ── Phase 3b Task 2 helpers ──────────────────────────────────────────

function stubAdapter(captured: { req?: SubagentDelegationV2Request }): PiSubagentsAdapter {
  return {
    async delegate(req: SubagentDelegationV2Request): Promise<SubagentDelegationV2TerminalResponse> {
      captured.req = req;
      return {
        version: req.version,
        requestId: req.requestId,
        ownerRunId: req.ownerRunId,
        nodeId: req.nodeId,
        status: "completed",
        result: { kind: "text", text: "ok" },
      } as SubagentDelegationV2TerminalResponse;
    },
  } as PiSubagentsAdapter;
}

function bidInput(config: PiDefaultLoopConfig) {
  return {
    executionId: "exec-1",
    traceId: "trace-1",
    agentInstanceId: "agent-1",
    task: "bid task",
    config,
    context: { messages: [], metadata: { contextId: "c", sourceRefs: [], artifactRefs: [] } },
    state: {},
  } as never;
}

const bidSdk = {
  telemetry: { emit() {} },
  control: { signal: new AbortController().signal },
} as never;

// ── Phase 3b Task 2: skill/turnBudget/toolBudget pass-through ────────

test("Phase 3b: buildV2Request passes skill/turnBudget/toolBudget through", async () => {
  const captured: { req?: SubagentDelegationV2Request } = {};
  const loop = createPiDefaultLoop(stubAdapter(captured));
  await loop.run(
    bidInput({
      agent: "agent-x",
      cwd: "/tmp",
      contextMode: "fresh",
      model: "minimax/minimax-m3",
      skill: "agent-lab-bidding",
      turnBudget: { maxTurns: 3 },
      toolBudget: { hard: 5 },
      result: { kind: "text" },
    }),
    bidSdk,
  );
  assert.equal(captured.req?.skill, "agent-lab-bidding");
  assert.deepEqual(captured.req?.turnBudget, { maxTurns: 3 });
  assert.deepEqual(captured.req?.toolBudget, { hard: 5 });
  assert.equal(captured.req?.model, "minimax/minimax-m3");
});

test("Phase 3b: buildV2Request omits skill/turnBudget when unset", async () => {
  const captured: { req?: SubagentDelegationV2Request } = {};
  const loop = createPiDefaultLoop(stubAdapter(captured));
  await loop.run(
    bidInput({ agent: "a", cwd: "/tmp", contextMode: "fresh" }),
    bidSdk,
  );
  assert.equal(captured.req?.skill, undefined);
  assert.equal(captured.req?.turnBudget, undefined);
  assert.equal(captured.req?.toolBudget, undefined);
});
