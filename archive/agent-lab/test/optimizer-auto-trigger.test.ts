/**
 * Tests for auto-trigger (Phase 5b T7).
 *
 * Covers:
 *  - Throttle by count (everyNRuns)
 *  - Throttle by time (everyTMs) with injectable now
 *  - Both thresholds (OR logic)
 *  - Disabled → zero calls
 *  - run() rejection swallowed (fail-open)
 *  - maybeTrigger never throws (fail-open)
 *  - status() snapshot correctness
 *  - Telemetry integration: onRunRecorded called after appendRun
 *  - Telemetry: handler never throws when callback misbehaves
 *  - Default config (no optimizer section) — existing tests pass
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoTrigger } from "../src/optimizer/auto-trigger.ts";
import { registerTelemetry } from "../src/telemetry/register.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Store } from "../src/store/store.ts";
import type { RunRecord } from "../src/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

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

// ── Auto-trigger unit tests ──────────────────────────────────────────────

test("auto-trigger: disabled config → zero calls", () => {
  let callCount = 0;
  const trigger = createAutoTrigger({
    config: { enabled: false, everyNRuns: 1 },
    run: async () => { callCount++; },
  });

  for (let i = 0; i < 10; i++) trigger.maybeTrigger("inst-1");

  assert.equal(callCount, 0);
  assert.equal(trigger.status().fires, 0);
  assert.equal(trigger.status().runsSinceLast, 0);
});

test("auto-trigger: undefined config → disabled (zero calls)", () => {
  let callCount = 0;
  const trigger = createAutoTrigger({
    config: undefined,
    run: async () => { callCount++; },
  });

  for (let i = 0; i < 10; i++) trigger.maybeTrigger("inst-1");

  assert.equal(callCount, 0);
});

test("auto-trigger: everyNRuns=5 fires on 5th call, resets counter", () => {
  const firedFor: string[] = [];
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 5 },
    run: async (id) => { firedFor.push(id); },
  });

  // Calls 1-4: no fire
  for (let i = 0; i < 4; i++) trigger.maybeTrigger("inst-1");
  assert.equal(firedFor.length, 0);
  assert.equal(trigger.status().runsSinceLast, 4);

  // Call 5: fire
  trigger.maybeTrigger("inst-1");
  assert.equal(firedFor.length, 1);
  assert.equal(firedFor[0], "inst-1");
  assert.equal(trigger.status().runsSinceLast, 0);
  assert.equal(trigger.status().fires, 1);
  assert.ok(trigger.status().lastFiredAt !== null);

  // Calls 6-9: no fire
  for (let i = 0; i < 4; i++) trigger.maybeTrigger("inst-1");
  assert.equal(firedFor.length, 1);
  assert.equal(trigger.status().runsSinceLast, 4);

  // Call 10: fire again
  trigger.maybeTrigger("inst-2");
  assert.equal(firedFor.length, 2);
  assert.equal(firedFor[1], "inst-2");
  assert.equal(trigger.status().runsSinceLast, 0);
  assert.equal(trigger.status().fires, 2);
});

test("auto-trigger: everyNRuns=1 fires on every call", () => {
  const firedFor: string[] = [];
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 1 },
    run: async (id) => { firedFor.push(id); },
  });

  trigger.maybeTrigger("a");
  trigger.maybeTrigger("b");
  trigger.maybeTrigger("c");

  assert.deepEqual(firedFor, ["a", "b", "c"]);
  assert.equal(trigger.status().fires, 3);
  assert.equal(trigger.status().runsSinceLast, 0);
});

test("auto-trigger: everyTMs fires when elapsed time >= threshold", () => {
  let clock = 0;
  const fired: string[] = [];
  // Use everyNRuns=2 so the first call does NOT fire (gives us time to
  // establish a baseline via count on the second call).
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 2, everyTMs: 1000 },
    run: async (id) => { fired.push(id); },
    now: () => clock,
  });

  // Call 1: count=1 (<2), time baseline null → no fire
  trigger.maybeTrigger("c1");
  assert.equal(fired.length, 0);
  assert.equal(trigger.status().runsSinceLast, 1);

  // Call 2: count=2 → fires by count, sets baseline at clock=0
  trigger.maybeTrigger("c2");
  assert.equal(fired.length, 1);
  assert.equal(fired[0], "c2");
  assert.equal(trigger.status().lastFiredAt, 0);
  assert.equal(trigger.status().runsSinceLast, 0);

  // Advance clock past time threshold (1200 >= 1000)
  clock = 1200;
  // Call 3: count=1 (<2), but time elapsed → fires by time
  trigger.maybeTrigger("c3");
  assert.equal(fired.length, 2);
  assert.equal(fired[1], "c3");
  assert.equal(trigger.status().lastFiredAt, 1200);
  assert.equal(trigger.status().runsSinceLast, 0);

  // Call 4: clock=1200, lastFiredAt=1200, only 0ms elapsed, count=1 (<2) → no fire
  trigger.maybeTrigger("c4");
  assert.equal(fired.length, 2);
  assert.equal(trigger.status().runsSinceLast, 1);
});

test("auto-trigger: OR logic — count fires even when time hasn't elapsed", () => {
  let clock = 0;
  const fired: string[] = [];
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 3, everyTMs: 10000 },
    run: async (id) => { fired.push(id); },
    now: () => clock,
  });

  // First 3 calls: count threshold reached
  trigger.maybeTrigger("c1");
  trigger.maybeTrigger("c2");
  trigger.maybeTrigger("c3");
  assert.equal(fired.length, 1);
  assert.equal(fired[0], "c3");

  // Advance clock to hit time threshold
  clock = 12000;
  trigger.maybeTrigger("c4"); // time threshold reached (only 1 run since last fire)
  assert.equal(fired.length, 2);
  assert.equal(fired[1], "c4");
});

test("auto-trigger: run() rejection swallowed (fail-open)", async () => {
  let rejected = false;
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 1 },
    run: async () => { throw new Error("boom"); },
  });

  // This should not throw
  trigger.maybeTrigger("inst-1");

  // Give the microtask a moment to run
  await new Promise((r) => setTimeout(r, 10));

  // Verify fire was counted even though run rejected
  assert.equal(trigger.status().fires, 1);
  assert.equal(trigger.status().runsSinceLast, 0);
});

test("auto-trigger: maybeTrigger never throws even when run throws synchronously", () => {
  // Simulate a misbehaving run function that throws synchronously (unusual but possible)
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 1 },
    run: () => {
      throw new Error("sync boom");
    },
  });

  // Should not throw
  trigger.maybeTrigger("inst-1");

  // Fire still counted (incremented before run call)
  assert.equal(trigger.status().fires, 1);
});

test("auto-trigger: status() snapshot accurate", () => {
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 10 },
    run: async () => {},
  });

  assert.deepEqual(trigger.status(), { runsSinceLast: 0, lastFiredAt: null, fires: 0 });

  trigger.maybeTrigger("i");
  assert.equal(trigger.status().runsSinceLast, 1);
  assert.equal(trigger.status().lastFiredAt, null);
  assert.equal(trigger.status().fires, 0);

  for (let i = 0; i < 8; i++) trigger.maybeTrigger("i");
  assert.equal(trigger.status().runsSinceLast, 9);

  trigger.maybeTrigger("i"); // 10th → fire
  assert.equal(trigger.status().runsSinceLast, 0);
  assert.equal(trigger.status().fires, 1);
  assert.ok(typeof trigger.status().lastFiredAt === "number");
});

test("auto-trigger: everyNRuns=0 treated as no-op threshold (fires never by count)", () => {
  // everyNRuns=0 is nonsensical — treated as disabled threshold
  const fired: string[] = [];
  const trigger = createAutoTrigger({
    config: { enabled: true, everyNRuns: 0 },
    run: async (id) => { fired.push(id); },
  });

  for (let i = 0; i < 5; i++) trigger.maybeTrigger("i");
  assert.equal(fired.length, 0);
});

test("auto-trigger: everyTMs=0 treated as no-op threshold", () => {
  let clock = 0;
  const fired: string[] = [];
  const trigger = createAutoTrigger({
    config: { enabled: true, everyTMs: 0 },
    run: async (id) => { fired.push(id); },
    now: () => clock,
  });

  trigger.maybeTrigger("i");
  assert.equal(fired.length, 0);
});

// ── Telemetry integration tests ──────────────────────────────────────────

test("telemetry: onRunRecorded called after appendRun success", () => {
  const pi = mockPi();
  const store = mockStore();
  let callbackCalls = 0;
  let callbackRunCount = 0;

  registerTelemetry(
    pi as never, store, DEFAULT_CONFIG, undefined,
    () => { callbackCalls++; callbackRunCount = store.runs.length; },
  );

  pi.emit("tool_execution_end", subagentEndEvent());

  assert.equal(callbackCalls, 1);
  assert.equal(callbackRunCount, 1); // run was appended before callback
});

test("telemetry: onRunRecorded not called for non-subagent events", () => {
  const pi = mockPi();
  const store = mockStore();
  let callbackCalls = 0;

  registerTelemetry(
    pi as never, store, DEFAULT_CONFIG, undefined,
    () => { callbackCalls++; },
  );

  pi.emit("tool_execution_end", { toolName: "read", toolCallId: "r1", result: {} });

  assert.equal(callbackCalls, 0);
});

test("telemetry: handler never throws when onRunRecorded misbehaves", () => {
  const pi = mockPi();
  const store = mockStore();

  registerTelemetry(
    pi as never, store, DEFAULT_CONFIG, undefined,
    () => { throw new Error("callback boom"); },
  );

  // Should not throw
  pi.emit("tool_execution_end", subagentEndEvent());

  // Run was still stored (callback is after appendRun, fail-open)
  assert.equal(store.runs.length, 1);
});

test("telemetry: onRunRecorded not called when parseSubagentRun returns null", () => {
  const pi = mockPi();
  const store = mockStore();
  let callbackCalls = 0;

  registerTelemetry(
    pi as never, store, DEFAULT_CONFIG, undefined,
    () => { callbackCalls++; },
  );

  // Send an event with no result → parseSubagentRun returns null → appendRun skipped
  // onRunRecorded should only fire after successful appendRun
  pi.emit("tool_execution_end", {
    toolName: "subagent",
    toolCallId: "call-no-result",
    args: {},
    result: undefined,
  });

  assert.equal(callbackCalls, 0);
  assert.equal(store.runs.length, 0);
});

test("telemetry: default config (no optimizer section) → existing behavior unchanged", () => {
  // This test verifies that registerTelemetry works identically without the 6th param
  const pi = mockPi();
  const store = mockStore();

  // No 6th param — backward compat
  registerTelemetry(pi as never, store, DEFAULT_CONFIG);

  pi.emit("tool_execution_end", subagentEndEvent());

  // Run was stored
  assert.equal(store.runs.length, 1);
  const run = store.runs[0];
  assert.equal(run.completion, 0.9);
  assert.equal(run.model, "deepseek/deepseek-v3.2");
});
