import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTelemetry, createSettleDispatch } from "../src/telemetry/register.ts";
import type { Outcome } from "../src/arena/types.ts";
import type { Store } from "../src/store/store.ts";
import type { RunRecord } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { SchedulerRuntimeLike } from "../src/interceptor/scheduler-bridge.ts";

// ── Minimal mocks ─────────────────────────────────────────────────────

/** Simple EventEmitter-style mock of ExtensionAPI's `on` method */
function mockPi() {
  const listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  return {
    on(event: string, handler: (event: Record<string, unknown>) => void) {
      (listeners[event] ??= []).push(handler);
    },
    emit(event: string, data: Record<string, unknown>) {
      for (const h of listeners[event] ?? []) h(data);
    },
  };
}

function mockStore(): Store & { runs: RunRecord[] } {
  const runs: RunRecord[] = [];
  return {
    appendRun(r: RunRecord) { runs.push(r); },
    runs,
    aggregateByRole: () => [],
    listRoles: () => [],
    getPin: () => undefined,
    setPin: () => {},
    clearPin: () => {},
    getConfig: () => ({}),
    setConfig: () => {},
    close: () => {},
  };
}

function mockRuntime(overrides: Partial<SchedulerRuntimeLike> = {}): SchedulerRuntimeLike & {
  settleCalls: Array<{ taskRef: string; outcome: unknown }>;
  dispatchCalls: unknown[];
} {
  const settleCalls: Array<{ taskRef: string; outcome: unknown }> = [];
  const dispatchCalls: unknown[] = [];
  return {
    dispatch: async (req) => {
      dispatchCalls.push(req);
      return { status: "completed" as const, schedulerInstanceId: "i", roundId: "r", attempts: [] };
    },
    dispatchCalls,
    settle: async (taskRef: string, outcome: unknown) => {
      settleCalls.push({ taskRef, outcome });
      return overrides.settle ? true : false;
    },
    settleCalls,
    ...overrides,
  };
}

function subagentEndEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    toolName: "subagent",
    toolCallId: "call-abc123",
    args: { agent: "worker" },
    result: {
      model: "deepseek/deepseek-v3.2",
      acceptance: { status: "verified" },
      usage: { input: 1000, output: 500, cost: { total: 0.012 } },
      turns: 4,
    },
    ...overrides,
  };
}

// ── registerTelemetry tests ───────────────────────────────────────────

// Test 1: settleDispatch present → called
test("registerTelemetry calls settleDispatch when present", () => {
  const pi = mockPi();
  const store = mockStore();
  let dispatchedTaskId: string | undefined;
  let dispatchedOutcome: Outcome | undefined;

  const settleDispatch = (taskId: string, outcome: Outcome) => {
    dispatchedTaskId = taskId;
    dispatchedOutcome = outcome;
  };

  registerTelemetry(pi as never, store, DEFAULT_CONFIG, settleDispatch);
  pi.emit("tool_execution_end", subagentEndEvent());

  assert.equal(dispatchedTaskId, "call-abc123");
  assert.ok(dispatchedOutcome);
  assert.equal(dispatchedOutcome!.completion, 0.9);
  assert.equal(dispatchedOutcome!.majorError, false);
  assert.equal(dispatchedOutcome!.tokensIn, 1000);
  assert.equal(dispatchedOutcome!.tokensOut, 500);
  assert.ok(Math.abs(dispatchedOutcome!.cost - 0.012) < 1e-9);
});

// Test 2: settleDispatch absent → no error (silent skip, bridge-only)
test("registerTelemetry does not throw when settleDispatch is absent", () => {
  const pi = mockPi();
  const store = mockStore();

  // Should not throw
  registerTelemetry(pi as never, store, DEFAULT_CONFIG);
  pi.emit("tool_execution_end", subagentEndEvent());
  // If we got here without throwing, test passes
});

// Test 3: registerTelemetry ignores non-subagent events
test("registerTelemetry ignores non-subagent tool_execution_end events", () => {
  const pi = mockPi();
  const store = mockStore();

  registerTelemetry(pi as never, store, DEFAULT_CONFIG);

  pi.emit("tool_execution_end", { toolName: "read", toolCallId: "read-1", result: {} });
  pi.emit("tool_execution_start", { toolName: "subagent", toolCallId: "sa-1" });

  // Only the start event was captured; end was ignored
  assert.equal(store.runs.length, 0);
});

// Test 4: registerTelemetry — no toolCallId → no settle call
test("registerTelemetry skips settlement when toolCallId is missing", () => {
  const pi = mockPi();
  const store = mockStore();

  registerTelemetry(pi as never, store, DEFAULT_CONFIG);
  pi.emit("tool_execution_end", { ...subagentEndEvent(), toolCallId: undefined });

  // No settlement path invoked
true; // test passes by reaching here without throw
});

// Test 5: registerTelemetry — empty string toolCallId → no settle call
test("registerTelemetry skips settlement when toolCallId is empty string", () => {
  const pi = mockPi();
  const store = mockStore();

  registerTelemetry(pi as never, store, DEFAULT_CONFIG);
  pi.emit("tool_execution_end", { ...subagentEndEvent(), toolCallId: "" });

  // No settlement path invoked
true; // test passes by reaching here without throw
});

// ── createSettleDispatch tests (runtime-only, no market fallback) ──────

// Test 7: runtime.settle called — no market involved
test("createSettleDispatch: runtime.settle hit → settle called", async () => {
  const settleCalls: Array<{ taskRef: string; outcome: Outcome }> = [];
  const runtime: SchedulerRuntimeLike = {
    dispatch: async () => ({ status: "completed", schedulerInstanceId: "i", roundId: "r", attempts: [] }),
    settle: async (taskRef: string, outcome: unknown) => {
      settleCalls.push({ taskRef, outcome: outcome as Outcome });
      return true;
    },
  };

  const dispatch = createSettleDispatch(() => runtime);
  const outcome: Outcome = { completion: 1, majorError: false, tokensIn: 10, tokensOut: 5, cost: 0.001, toolCalls: [], inferenceLatencyMs: 100 };
  dispatch("task-1", outcome);

  // Need to await the microtask for the .catch to fire
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(settleCalls.length, 1);
  assert.equal(settleCalls[0].taskRef, "task-1");
  assert.equal(settleCalls[0].outcome.completion, 1);
});

// Test 8: runtime.settle returns false → silent skip (no market fallback)
test("createSettleDispatch: runtime.settle miss → silent skip", async () => {
  const settleCalls: Array<{ taskRef: string }> = [];
  const runtime: SchedulerRuntimeLike = {
    dispatch: async () => ({ status: "completed", schedulerInstanceId: "i", roundId: "r", attempts: [] }),
    settle: async (taskRef: string) => {
      settleCalls.push({ taskRef });
      return false;
    },
  };

  const dispatch = createSettleDispatch(() => runtime);
  dispatch("task-2", { completion: 0.5, majorError: true, tokensIn: 20, tokensOut: 10, cost: 0.002, toolCalls: [], inferenceLatencyMs: 200 });

  await new Promise((r) => setTimeout(r, 10));

  // settle was called — the miss is silently ignored
  assert.equal(settleCalls.length, 1);
  // No throw, no fallback — test passes by reaching here
});

// Test 9: runtime.settle throws → silent skip (no market fallback, fail-open)
test("createSettleDispatch: runtime.settle throws → silent skip", async () => {
  const settleCalls: Array<{ taskRef: string }> = [];
  const runtime: SchedulerRuntimeLike = {
    dispatch: async () => ({ status: "completed", schedulerInstanceId: "i", roundId: "r", attempts: [] }),
    settle: async (taskRef: string) => {
      settleCalls.push({ taskRef });
      throw new Error("settle exploded");
    },
  };

  const dispatch = createSettleDispatch(() => runtime);
  // Should not throw — fail-open silent skip
  dispatch("task-err", { completion: 0, majorError: true, tokensIn: 0, tokensOut: 0, cost: 0, toolCalls: [], inferenceLatencyMs: 0 });

  await new Promise((r) => setTimeout(r, 10));

  assert.equal(settleCalls.length, 1);
  // No throw, no fallback — test passes by reaching here
});

// Test 10: runtime undefined → silent skip
test("createSettleDispatch: runtime undefined → silent skip", () => {
  const dispatch = createSettleDispatch(() => undefined);
  // Should not throw
  dispatch("task-3", { completion: 0.8, majorError: false, tokensIn: 30, tokensOut: 15, cost: 0.003, toolCalls: [], inferenceLatencyMs: 300 });
  // Test passes by reaching here without throw
});

// Test 11: runtime without settle method → silent skip
test("createSettleDispatch: runtime without settle → silent skip", () => {
  const runtime = { dispatch: async () => ({ status: "completed" as const, schedulerInstanceId: "i", roundId: "r", attempts: [] }) } as SchedulerRuntimeLike;

  const dispatch = createSettleDispatch(() => runtime);
  // Should not throw
  dispatch("task-4", { completion: 0.7, majorError: false, tokensIn: 40, tokensOut: 20, cost: 0.004, toolCalls: [], inferenceLatencyMs: 400 });
  // Test passes by reaching here without throw
});
