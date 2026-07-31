import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderSchedulerStatus,
  renderSchedulerSelect,
  renderSchedulerSync,
  renderSchedulerEvents,
} from "../src/commands/register.ts";
import type { LabEvent } from "../src/core/contracts.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function fakeEvent(
  eventType: string,
  ts: number,
  overrides?: Partial<LabEvent>,
): LabEvent {
  return {
    eventId: `evt-${eventType}-${ts}`,
    eventType,
    schemaVersion: "1.0",
    timestamp: ts,
    identity: { traceId: "trace-1" },
    payload: {},
    ...overrides,
  } as LabEvent;
}

// ── Status tests ────────────────────────────────────────────────────

test("scheduler status: disabled, runtime unavailable", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: false,
    runtimeAvailable: false,
  });
  assert.ok(out.includes("Enabled: no"));
  assert.ok(out.includes("Runtime: unavailable"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
});

test("scheduler status: enabled, runtime unavailable", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: true,
    runtimeAvailable: false,
  });
  assert.ok(out.includes("Enabled: yes"));
  assert.ok(out.includes("Runtime: unavailable"));
});

test("scheduler status: ready — full info", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    definitionId: "weighted-scorer",
    definitionVersion: "1.0.0",
    roundId: "round-0",
    agentCount: 5,
    enabled: true,
    runtimeAvailable: true,
  });
  assert.ok(out.includes("Enabled: yes"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
  assert.ok(out.includes("Definition: weighted-scorer@1.0.0"));
  assert.ok(out.includes("Round: round-0"));
  assert.ok(out.includes("Agents: 5"));
  assert.ok(!out.includes("Runtime: unavailable"));
});

test("scheduler status: ready — partial info (no definition)", () => {
  const out = renderSchedulerStatus({
    instanceId: "custom-instance",
    enabled: true,
    runtimeAvailable: true,
    agentCount: 0,
  });
  assert.ok(out.includes("Instance: custom-instance"));
  assert.ok(out.includes("Agents: 0"));
  assert.ok(!out.includes("Definition:"));
  assert.ok(!out.includes("Round:"));
});

test("scheduler status: shows UUID when provided", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    instanceUuid: "550e8400-e29b-41d4-a716-446655440000",
    enabled: true,
    runtimeAvailable: true,
  });
  assert.ok(out.includes("ID: 550e8400-e29b-41d4-a716-446655440000"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
});

test("scheduler status: no UUID line when uuid not provided", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: true,
    runtimeAvailable: true,
    agentCount: 5,
  });
  assert.ok(!out.includes("ID:"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
});

// ── Select tests ────────────────────────────────────────────────────

test("scheduler select: completed with model", () => {
  const out = renderSchedulerSelect(
    { status: "completed", model: "deepseek/deepseek-v3.2", score: 0.852, reason: "top weighted score" },
    [{ model: { id: "deepseek/deepseek-v3.2" }, score: 0.852, reason: "top weighted score" }],
    "coder",
  );
  assert.ok(out.includes("Selected: deepseek/deepseek-v3.2"));
  assert.ok(out.includes("score=0.852"));
  assert.ok(out.includes("top weighted score"));
  assert.ok(out.includes("Legacy recommendation for coder:"));
  assert.ok(out.includes("Dual-run: MATCH"));
});

test("scheduler select: completed with mismatch", () => {
  const out = renderSchedulerSelect(
    { status: "completed", model: "anthropic/claude", score: 0.9, reason: "pin hit" },
    [{ model: { id: "deepseek/deepseek-v3.2" }, score: 0.852, reason: "top weighted score" }],
    "coder",
  );
  assert.ok(out.includes("Selected: anthropic/claude"));
  assert.ok(out.includes("Dual-run: MISMATCH"));
});

test("scheduler select: abstained", () => {
  const out = renderSchedulerSelect(
    { status: "abstained", reason: "no candidates in population" },
    [],
    "coder",
  );
  assert.ok(out.includes("Scheduler abstained: no candidates in population"));
  assert.ok(out.includes("(no candidates)"));
  assert.ok(!out.includes("Dual-run:"));
});

test("scheduler select: failed", () => {
  const out = renderSchedulerSelect(
    { status: "failed", errorMessage: "round not found" },
    [{ model: { id: "qwen/qwen3-coder" }, score: 0.75, reason: "cold start" }],
    "coder",
  );
  assert.ok(out.includes("Scheduler failed: round not found"));
  assert.ok(out.includes("qwen/qwen3-coder"));
  assert.ok(!out.includes("Dual-run:"));
});

test("scheduler select: fallback", () => {
  const out = renderSchedulerSelect(
    { status: "fallback" },
    [],
    "coder",
  );
  assert.ok(out.includes("fell back to original request"));
});

test("scheduler select: no model in completed result", () => {
  const out = renderSchedulerSelect(
    { status: "completed" },
    [{ model: { id: "deepseek/deepseek-v3.2" }, score: 0.852, reason: "top weighted score" }],
    "coder",
  );
  assert.ok(out.includes("No model selected"));
  assert.ok(!out.includes("Dual-run:"));
  assert.ok(!out.includes("Selected:"));
});

// ── Sync tests ──────────────────────────────────────────────────────

test("scheduler sync: added agents", () => {
  const out = renderSchedulerSync(3);
  assert.ok(out.includes("added 3 new agent(s)"));
});

test("scheduler sync: no additions", () => {
  const out = renderSchedulerSync(0);
  assert.ok(out.includes("up to date"));
  assert.ok(out.includes("0 new agents"));
});

// ── Events tests ────────────────────────────────────────────────────

test("scheduler events: empty", () => {
  const out = renderSchedulerEvents([], 20);
  assert.ok(out.includes("No scheduler events found"));
  assert.ok(out.includes("limit=20"));
});

test("scheduler events: with events", () => {
  const events: LabEvent[] = [
    fakeEvent("scheduling.requested", 1700000000000, {
      identity: { traceId: "abc123def456", schedulerInstanceId: "default-weighted-scorer" },
      payload: { role: "coder" },
    }),
    fakeEvent("scheduler.started", 1700000001000, {
      identity: { traceId: "abc123def456", schedulerInstanceId: "default-weighted-scorer", dispatchId: "disp-001" },
    }),
    fakeEvent("scheduler.completed", 1700000002000, {
      identity: { traceId: "abc123def456", schedulerInstanceId: "default-weighted-scorer" },
      payload: { model: "deepseek/deepseek-v3.2" },
    }),
  ];
  const out = renderSchedulerEvents(events, 20);
  assert.ok(out.includes("Last 3 scheduler events:"));
  assert.ok(out.includes("scheduling.requested"));
  assert.ok(out.includes("scheduler.started"));
  assert.ok(out.includes("scheduler.completed"));
  assert.ok(out.includes("trace=abc123def456"));
  assert.ok(out.includes("instance=default-weighted-scorer"));
});

test("scheduler events: respect limit", () => {
  const events: LabEvent[] = [
    fakeEvent("scheduling.requested", 1700000000000),
    fakeEvent("routing.resolved", 1700000001000),
    fakeEvent("scheduler.started", 1700000002000),
    fakeEvent("scheduler.completed", 1700000003000),
    fakeEvent("fallback.started", 1700000004000),
  ];
  const out = renderSchedulerEvents(events, 3);
  assert.ok(out.includes("Last 3 scheduler events:"));
  assert.ok(!out.includes("scheduling.requested"));
  assert.ok(!out.includes("routing.resolved"));
  assert.ok(out.includes("scheduler.started"));
  assert.ok(out.includes("scheduler.completed"));
  assert.ok(out.includes("fallback.started"));
});

test("scheduler events: empty payload omitted", () => {
  const events: LabEvent[] = [
    fakeEvent("routing.failed", 1700000000000),
  ];
  const out = renderSchedulerEvents(events, 20);
  assert.ok(out.includes("routing.failed"));
  assert.ok(!out.includes("{")); // No JSON appended for empty payload
});
