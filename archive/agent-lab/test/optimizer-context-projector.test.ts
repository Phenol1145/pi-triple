/**
 * Context projector tests — event-sourced aggregation correctness.
 *
 * Covers:
 * - Aggregation per bucket (model calls, tokens, cost observed/derived split)
 * - Executions from agent.completed
 * - Transforms by kind
 * - Summary calls + cost
 * - Empty window
 * - Missing metrics_json defense
 * - Unattributed bucket count
 * - Scheduler instance id filter
 * - Time window filter (since/until)
 * - Strategy derivation from agent instance id suffix + workLoopId fallback
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventLog } from "../src/core/events/event-log.ts";
import {
  projectContextStrategies,
  projectContextStrategiesByRound,
  type ContextStrategyBucket,
  type ContextProjection,
} from "../src/optimizer/context-projector.ts";
import type { LabEvent } from "../src/core/contracts.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function setup() {
  const db = new DatabaseSync(":memory:");
  const events = new EventLog(db);
  return { db, events };
}

let seq = 0;
function nextSeq(): number {
  return seq++;
}

function makeIdentity(overrides: Partial<LabEvent["identity"]> = {}): LabEvent["identity"] {
  return {
    traceId: "trace-1",
    executionId: "exec-1",
    agentInstanceId: "agent-test-default",
    optimizationRoundId: "round-1",
    workLoopId: "pi-default-loop",
    workLoopVersion: "1.0.0",
    schedulerInstanceId: "sched-1",
    ...overrides,
  };
}

function appendModelCompleted(
  events: EventLog,
  opts: {
    agentInstanceId?: string;
    executionId?: string;
    input?: number;
    output?: number;
    cost?: number;
    durationMs?: number;
    source?: "observed" | "derived";
    timestamp?: number;
    schedulerInstanceId?: string;
  } = {},
): void {
  const id = nextSeq();
  events.append({
    eventId: `model-completed-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: opts.timestamp ?? 1000,
    identity: makeIdentity({
      agentInstanceId: opts.agentInstanceId ?? "agent-test-default",
      executionId: opts.executionId ?? `exec-${id}`,
      schedulerInstanceId: opts.schedulerInstanceId ?? "sched-1",
    }),
    payload: {},
    metrics: {
      input: opts.input ?? 100,
      output: opts.output ?? 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: opts.cost ?? 0.01,
      durationMs: opts.durationMs ?? 500,
      source: opts.source ?? "observed",
    },
  });
}

function appendAgentCompleted(
  events: EventLog,
  opts: {
    agentInstanceId?: string;
    executionId?: string;
    timestamp?: number;
    schedulerInstanceId?: string;
  } = {},
): void {
  const id = nextSeq();
  events.append({
    eventId: `agent-completed-${id}`,
    eventType: "agent.completed",
    schemaVersion: "1.0",
    timestamp: opts.timestamp ?? 1000,
    identity: makeIdentity({
      agentInstanceId: opts.agentInstanceId ?? "agent-test-default",
      executionId: opts.executionId ?? `exec-${id}`,
      schedulerInstanceId: opts.schedulerInstanceId ?? "sched-1",
    }),
    payload: {},
  });
}

function appendContextTransformed(
  events: EventLog,
  opts: {
    agentInstanceId?: string;
    kind?: string;
    timestamp?: number;
    schedulerInstanceId?: string;
  } = {},
): void {
  const id = nextSeq();
  events.append({
    eventId: `ctx-xform-${id}`,
    eventType: "context.transformed",
    schemaVersion: "1.0",
    timestamp: opts.timestamp ?? 1000,
    identity: makeIdentity({
      agentInstanceId: opts.agentInstanceId ?? "agent-test-default",
      schedulerInstanceId: opts.schedulerInstanceId ?? "sched-1",
    }),
    payload: {
      strategyId: "test",
      kind: opts.kind ?? "truncate",
      source: "estimated",
    },
    metrics: {
      beforeTokens: 1000,
      afterTokens: 500,
      droppedSegments: 2,
    },
  });
}

function appendSummaryCreated(
  events: EventLog,
  opts: {
    agentInstanceId?: string;
    cost?: number;
    timestamp?: number;
    schedulerInstanceId?: string;
  } = {},
): void {
  const id = nextSeq();
  events.append({
    eventId: `summary-created-${id}`,
    eventType: "context.summary.created",
    schemaVersion: "1.0",
    timestamp: opts.timestamp ?? 1000,
    identity: makeIdentity({
      agentInstanceId: opts.agentInstanceId ?? "agent-test-default",
      schedulerInstanceId: opts.schedulerInstanceId ?? "sched-1",
    }),
    payload: {
      strategyId: "selective-summary",
      source: "observed",
    },
    metrics: {
      inputTokens: 8000,
      outputTokens: 400,
      cost: opts.cost ?? 0.012,
      durationMs: 2000,
    },
  });
}

function appendEventWithoutAgent(
  events: EventLog,
  eventType: string,
  timestamp?: number,
): void {
  const id = nextSeq();
  events.append({
    eventId: `no-agent-${id}`,
    eventType,
    schemaVersion: "1.0",
    timestamp: timestamp ?? 1000,
    identity: {
      traceId: "trace-no-agent",
      executionId: `exec-no-agent-${id}`,
      schedulerInstanceId: "sched-1",
    },
    payload: {},
    metrics: {},
  });
}

function findBucket(
  projection: ContextProjection,
  agentInstanceId: string,
): ContextStrategyBucket | undefined {
  return projection.buckets.find((b) => b.agentInstanceId === agentInstanceId);
}

// ── Tests ─────────────────────────────────────────────────────────────

// ── Basic aggregation ──────────────────────────────────────────────

test("single agent: aggregates model.completed correctly", () => {
  const { db, events } = setup();

  // 3 model calls for same agent
  appendModelCompleted(events, { agentInstanceId: "agent-test-default", input: 100, output: 50, cost: 0.01, durationMs: 500, source: "observed" });
  appendModelCompleted(events, { agentInstanceId: "agent-test-default", input: 200, output: 80, cost: 0.02, durationMs: 700, source: "observed" });
  appendModelCompleted(events, { agentInstanceId: "agent-test-default", input: 300, output: 100, cost: 0.03, durationMs: 300, source: "derived" });

  const result = projectContextStrategies(db);

  assert.equal(result.unattributed, 0);
  assert.equal(result.buckets.length, 1);

  const bucket = result.buckets[0]!;
  assert.equal(bucket.agentInstanceId, "agent-test-default");
  assert.equal(bucket.modelCalls, 3);
  assert.equal(bucket.totalInputTokens, 600);
  assert.equal(bucket.totalOutputTokens, 230);
  assert.equal(bucket.totalCostObserved, 0.03); // 0.01 + 0.02
  assert.equal(bucket.totalCostDerived, 0.03);  // 0.03
  assert.equal(bucket.avgDurationMs, 500);       // (500+700+300)/3
});

test("multiple agents: separate buckets", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a-budgeted-history", input: 100, output: 50, cost: 0.01, source: "observed" });
  appendModelCompleted(events, { agentInstanceId: "agent-a-budgeted-history", input: 150, output: 60, cost: 0.015, source: "observed" });
  appendModelCompleted(events, { agentInstanceId: "agent-b-selective-summary", input: 200, output: 80, cost: 0.02, source: "derived" });

  const result = projectContextStrategies(db);

  assert.equal(result.unattributed, 0);
  assert.equal(result.buckets.length, 2);

  const bucketA = findBucket(result, "agent-a-budgeted-history")!;
  assert.equal(bucketA.modelCalls, 2);
  assert.equal(bucketA.totalInputTokens, 250);
  assert.equal(bucketA.totalCostObserved, 0.025);

  const bucketB = findBucket(result, "agent-b-selective-summary")!;
  assert.equal(bucketB.modelCalls, 1);
  assert.equal(bucketB.totalInputTokens, 200);
  assert.equal(bucketB.totalCostDerived, 0.02);
});

// ── Executions ──────────────────────────────────────────────────────

test("executions: counts distinct executionIds from agent.completed", () => {
  const { db, events } = setup();

  // 3 agent.completed — 2 with same executionId, 1 distinct
  appendAgentCompleted(events, { agentInstanceId: "agent-test-default", executionId: "exec-A" });
  appendAgentCompleted(events, { agentInstanceId: "agent-test-default", executionId: "exec-A" }); // duplicate
  appendAgentCompleted(events, { agentInstanceId: "agent-test-default", executionId: "exec-B" });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;
  assert.equal(bucket.executions, 2);
});

test("executions: zero when no agent.completed events", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-test-default" });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;
  assert.equal(bucket.executions, 0);
});

// ── Transforms ──────────────────────────────────────────────────────

test("transforms: counts by kind", () => {
  const { db, events } = setup();

  appendContextTransformed(events, { agentInstanceId: "agent-test-default", kind: "truncate" });
  appendContextTransformed(events, { agentInstanceId: "agent-test-default", kind: "truncate" });
  appendContextTransformed(events, { agentInstanceId: "agent-test-default", kind: "summarize" });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;

  assert.deepEqual(bucket.transforms, { truncate: 2, summarize: 1 });
});

test("transforms: empty when no context.transformed events", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-test-default" });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;
  assert.deepEqual(bucket.transforms, {});
});

// ── Summary ─────────────────────────────────────────────────────────

test("summaryCalls + summaryCost: aggregates context.summary.created", () => {
  const { db, events } = setup();

  appendSummaryCreated(events, { agentInstanceId: "agent-test-default", cost: 0.012 });
  appendSummaryCreated(events, { agentInstanceId: "agent-test-default", cost: 0.008 });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;

  assert.equal(bucket.summaryCalls, 2);
  assert.equal(bucket.summaryCost, 0.02);
});

test("summary: zero when no summary events", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-test-default" });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;
  assert.equal(bucket.summaryCalls, 0);
  assert.equal(bucket.summaryCost, 0);
});

// ── Empty window ────────────────────────────────────────────────────

test("empty window: returns empty buckets, unattributed=0", () => {
  const { db } = setup();

  const result = projectContextStrategies(db);

  assert.deepEqual(result.buckets, []);
  assert.equal(result.unattributed, 0);
});

// ── Missing metrics_json defense ────────────────────────────────────

test("missing metrics_json: handles NULL metrics gracefully", () => {
  const { db, events } = setup();

  // Insert a model.completed with metrics = null (simulate missing metrics_json)
  const id = nextSeq();
  events.append({
    eventId: `model-completed-null-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({ agentInstanceId: "agent-test-default", executionId: `exec-null-${id}` }),
    payload: {},
    // metrics is undefined → stored as null
  });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;

  assert.equal(bucket.modelCalls, 1);
  assert.equal(bucket.totalInputTokens, 0);
  assert.equal(bucket.totalOutputTokens, 0);
  assert.equal(bucket.totalCostObserved, 0);
  assert.equal(bucket.totalCostDerived, 0);
  assert.equal(bucket.avgDurationMs, 0);
});

test("partial metrics_json: handles missing fields", () => {
  const { db, events } = setup();

  // Insert model.completed with only input and no output/cost/source
  const id = nextSeq();
  events.append({
    eventId: `model-completed-partial-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({ agentInstanceId: "agent-test-default", executionId: `exec-partial-${id}` }),
    payload: {},
    metrics: { input: 500 } as unknown as Record<string, string | number | boolean | null>,
  });

  const result = projectContextStrategies(db);
  const bucket = result.buckets[0]!;

  assert.equal(bucket.modelCalls, 1);
  assert.equal(bucket.totalInputTokens, 500);
  assert.equal(bucket.totalOutputTokens, 0);
  assert.equal(bucket.totalCostObserved, 0);
  assert.equal(bucket.totalCostDerived, 0);
});

// ── Unattributed ────────────────────────────────────────────────────

test("unattributed: counts events with NULL agentInstanceId", () => {
  const { db, events } = setup();

  appendEventWithoutAgent(events, "model.completed");
  appendEventWithoutAgent(events, "model.completed");
  appendEventWithoutAgent(events, "context.transformed");

  // Also add a normal event to ensure it's NOT counted as unattributed
  appendModelCompleted(events, { agentInstanceId: "agent-test-default" });

  const result = projectContextStrategies(db);

  assert.equal(result.unattributed, 3);
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0]!.modelCalls, 1);
});

test("unattributed: zero when all events have agentInstanceId", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a" });
  appendAgentCompleted(events, { agentInstanceId: "agent-a" });

  const result = projectContextStrategies(db);
  assert.equal(result.unattributed, 0);
});

test("unattributed: counts empty string agentInstanceId", () => {
  const { db, events } = setup();

  // Insert event with empty agentInstanceId
  const id = nextSeq();
  events.append({
    eventId: `empty-agent-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({ agentInstanceId: "", executionId: `exec-empty-${id}` }),
    payload: {},
    metrics: { input: 100, output: 50, cost: 0.01, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategies(db);
  assert.equal(result.unattributed, 1);
  assert.equal(result.buckets.length, 0);
});

// ── Scheduler instance id filter ────────────────────────────────────

test("schedulerInstanceId filter: includes only matching events", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a", schedulerInstanceId: "sched-1", input: 100 });
  appendModelCompleted(events, { agentInstanceId: "agent-b", schedulerInstanceId: "sched-2", input: 200 });

  const result = projectContextStrategies(db, { schedulerInstanceId: "sched-1" });

  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0]!.agentInstanceId, "agent-a");
  assert.equal(result.buckets[0]!.totalInputTokens, 100);
});

test("schedulerInstanceId filter: no match returns empty", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a", schedulerInstanceId: "sched-1" });

  const result = projectContextStrategies(db, { schedulerInstanceId: "sched-nonexistent" });

  assert.equal(result.buckets.length, 0);
  assert.equal(result.unattributed, 0);
});

// ── Time window filter ──────────────────────────────────────────────

test("since filter: includes events at and after timestamp", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 900, input: 100 });
  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 1000, input: 200 });
  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 1100, input: 300 });

  const result = projectContextStrategies(db, { since: 1000 });

  assert.equal(result.buckets.length, 1);
  // Only the 1000 and 1100 events should be included
  assert.equal(result.buckets[0]!.totalInputTokens, 500);
  assert.equal(result.buckets[0]!.modelCalls, 2);
});

test("until filter: excludes events at and after until", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 900, input: 100 });
  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 1000, input: 200 });
  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 1100, input: 300 });

  const result = projectContextStrategies(db, { until: 1000 });

  assert.equal(result.buckets.length, 1);
  // Only the 900 event should be included (ts < 1000)
  assert.equal(result.buckets[0]!.totalInputTokens, 100);
  assert.equal(result.buckets[0]!.modelCalls, 1);
});

test("since + until combined", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 900, input: 100 });
  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 1000, input: 200 });
  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 1100, input: 300 });
  appendModelCompleted(events, { agentInstanceId: "agent-a", timestamp: 1200, input: 400 });

  const result = projectContextStrategies(db, { since: 1000, until: 1200 });

  assert.equal(result.buckets[0]!.totalInputTokens, 500); // 200 + 300
  assert.equal(result.buckets[0]!.modelCalls, 2);
});

test("unattributed respects time window", () => {
  const { db, events } = setup();

  appendEventWithoutAgent(events, "model.completed", 900);
  appendEventWithoutAgent(events, "model.completed", 1100);

  const result = projectContextStrategies(db, { since: 1000 });

  assert.equal(result.unattributed, 1); // only the 1100 event
});

// ── Strategy derivation ─────────────────────────────────────────────

test("strategy derived from workLoopId for budgeted-history", () => {
  const { db, events } = setup();

  const id = nextSeq();
  events.append({
    eventId: `model-bh-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "agent-claude-sonnet-4.5-budgeted-history",
      executionId: `exec-bh-${id}`,
      workLoopId: "budgeted-history",
    }),
    payload: {},
    metrics: { input: 100, output: 50, cost: 0.01, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategies(db);
  assert.equal(result.buckets[0]!.strategy, "budgeted-history");
});

test("strategy: pi-default-loop maps to 'default'", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-gpt4o-default" });
  // makeIdentity default workLoopId is "pi-default-loop" → strategy = "default"

  const result = projectContextStrategies(db);
  assert.equal(result.buckets[0]!.strategy, "default");
});

test("strategy derived from workLoopId for selective-summary", () => {
  const { db, events } = setup();

  const id = nextSeq();
  events.append({
    eventId: `model-ss-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "agent-claude-haiku-selective-summary",
      executionId: `exec-ss-${id}`,
      workLoopId: "selective-summary",
    }),
    payload: {},
    metrics: { input: 100, output: 50, cost: 0.01, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategies(db);
  assert.equal(result.buckets[0]!.strategy, "selective-summary");
});

test("strategy fallback to workLoopId when agentInstanceId has no dash", () => {
  const { db, events } = setup();

  const id = nextSeq();
  events.append({
    eventId: `model-completed-nodash-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "simpleAgent",
      executionId: `exec-nodash-${id}`,
      workLoopId: "budgeted-history",
    }),
    payload: {},
    metrics: { input: 100, output: 50, cost: 0.01, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategies(db);
  assert.equal(result.buckets[0]!.strategy, "budgeted-history");
});

test("strategy fallback to 'unknown' when no dash and no workLoopId", () => {
  const { db, events } = setup();

  const id = nextSeq();
  events.append({
    eventId: `model-completed-nofallback-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "simpleAgent",
      executionId: `exec-nofallback-${id}`,
      workLoopId: "",
    }),
    payload: {},
    metrics: { input: 100, output: 50, cost: 0.01, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategies(db);
  assert.equal(result.buckets[0]!.strategy, "unknown");
});

// ── Full integration: all event types for one agent ─────────────────

test("full aggregation: all event types merged per agent", () => {
  const { db, events } = setup();

  const aid = "agent-claude-budgeted-history";

  // Use workLoopId "budgeted-history" so strategy derivation is correct
  function appendForAgent(
    fn: (events: EventLog, opts: Record<string, unknown>) => void,
    overrides: Record<string, unknown> = {},
  ) {
    fn(events, {
      agentInstanceId: aid,
      ...overrides,
    } as Parameters<typeof fn>[1]);
  }

  // Override makeIdentity per-event to set correct workLoopId
  const id1 = nextSeq();
  events.append({
    eventId: `model-comp-full-${id1}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: aid,
      executionId: `exec-full-${id1}`,
      workLoopId: "budgeted-history",
    }),
    payload: {},
    metrics: { input: 1000, output: 200, cost: 0.05, durationMs: 600, source: "observed" },
  });

  const id2 = nextSeq();
  events.append({
    eventId: `model-comp-full-${id2}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: aid,
      executionId: `exec-full-${id2}`,
      workLoopId: "budgeted-history",
    }),
    payload: {},
    metrics: { input: 800, output: 150, cost: 0.04, durationMs: 400, source: "derived" },
  });

  // agent.completed
  const id3 = nextSeq();
  events.append({
    eventId: `agent-comp-full-${id3}`,
    eventType: "agent.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: aid,
      executionId: "exec-run-1",
      workLoopId: "budgeted-history",
    }),
    payload: {},
  });

  const id4 = nextSeq();
  events.append({
    eventId: `agent-comp-full-${id4}`,
    eventType: "agent.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: aid,
      executionId: "exec-run-1",
      workLoopId: "budgeted-history",
    }),
    payload: {},
  });

  // context.transformed
  for (const kind of ["truncate", "truncate", "summarize"]) {
    const id = nextSeq();
    events.append({
      eventId: `ctx-xform-full-${id}`,
      eventType: "context.transformed",
      schemaVersion: "1.0",
      timestamp: 1000,
      identity: makeIdentity({
        agentInstanceId: aid,
        workLoopId: "budgeted-history",
      }),
      payload: { strategyId: "test", kind, source: "estimated" },
      metrics: { beforeTokens: 1000, afterTokens: 500, droppedSegments: 2 },
    });
  }

  // context.summary.created
  const id5 = nextSeq();
  events.append({
    eventId: `summary-created-full-${id5}`,
    eventType: "context.summary.created",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: aid,
      workLoopId: "budgeted-history",
    }),
    payload: { strategyId: "selective-summary", source: "observed" },
    metrics: { inputTokens: 8000, outputTokens: 400, cost: 0.012, durationMs: 2000 },
  });

  const result = projectContextStrategies(db);

  assert.equal(result.unattributed, 0);
  assert.equal(result.buckets.length, 1);

  const b = result.buckets[0]!;
  assert.equal(b.agentInstanceId, aid);
  assert.equal(b.strategy, "budgeted-history");
  assert.equal(b.executions, 1);
  assert.equal(b.modelCalls, 2);
  assert.equal(b.totalInputTokens, 1800);
  assert.equal(b.totalOutputTokens, 350);
  assert.equal(b.totalCostObserved, 0.05);
  assert.equal(b.totalCostDerived, 0.04);
  assert.equal(b.avgDurationMs, 500);
  assert.deepEqual(b.transforms, { truncate: 2, summarize: 1 });
  assert.equal(b.summaryCalls, 1);
  assert.equal(b.summaryCost, 0.012);
});

// ── Buckets sorted ──────────────────────────────────────────────────

test("buckets are sorted by agentInstanceId", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-c" });
  appendModelCompleted(events, { agentInstanceId: "agent-a" });
  appendModelCompleted(events, { agentInstanceId: "agent-b" });

  const result = projectContextStrategies(db);
  assert.equal(result.buckets.length, 3);
  assert.equal(result.buckets[0]!.agentInstanceId, "agent-a");
  assert.equal(result.buckets[1]!.agentInstanceId, "agent-b");
  assert.equal(result.buckets[2]!.agentInstanceId, "agent-c");
});

// ── Agent with no model.completed but has other events ──────────────

test("agent with only context events still appears in buckets", () => {
  const { db, events } = setup();

  appendContextTransformed(events, { agentInstanceId: "agent-sidecar", kind: "inject" });

  const result = projectContextStrategies(db);

  assert.equal(result.buckets.length, 1);
  const b = result.buckets[0]!;
  assert.equal(b.agentInstanceId, "agent-sidecar");
  assert.equal(b.modelCalls, 0);
  assert.equal(b.executions, 0);
  assert.deepEqual(b.transforms, { inject: 1 });
});

// ── T2: roundId filter ─────────────────────────────────────────────

test("roundId filter: includes only events with matching optimizationRoundId", () => {
  const { db, events } = setup();

  // Events for round-1
  appendModelCompleted(events, { agentInstanceId: "agent-a" });
  // makeIdentity default optimizationRoundId is "round-1"

  // Events for round-2 — use custom identity
  const id = nextSeq();
  events.append({
    eventId: `model-comp-r2-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "agent-b",
      executionId: `exec-r2-${id}`,
      optimizationRoundId: "round-2",
    }),
    payload: {},
    metrics: { input: 200, output: 100, cost: 0.02, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategies(db, { roundId: "round-2" });

  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0]!.agentInstanceId, "agent-b");
  assert.equal(result.buckets[0]!.totalInputTokens, 200);
  assert.equal(result.unattributed, 0);
});

test("roundId filter: no match returns empty", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a" });

  const result = projectContextStrategies(db, { roundId: "round-nonexistent" });

  assert.equal(result.buckets.length, 0);
  assert.equal(result.unattributed, 0);
});

test("roundId filter: works with schedulerInstanceId combined", () => {
  const { db, events } = setup();

  appendModelCompleted(events, {
    agentInstanceId: "agent-a",
    schedulerInstanceId: "sched-1",
  });
  // default optimizationRoundId = "round-1"

  const id = nextSeq();
  events.append({
    eventId: `model-comp-s2r2-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "agent-b",
      executionId: `exec-s2r2-${id}`,
      optimizerInstanceId: undefined as unknown as string,
      schedulerInstanceId: "sched-1",
      optimizationRoundId: "round-2",
    }),
    payload: {},
    metrics: { input: 300, output: 100, cost: 0.03, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategies(db, {
    schedulerInstanceId: "sched-1",
    roundId: "round-2",
  });

  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0]!.agentInstanceId, "agent-b");
  assert.equal(result.buckets[0]!.totalInputTokens, 300);
});

test("roundId filter: unattributed events still counted when round matches", () => {
  const { db, events } = setup();

  // unattributed event with round-2
  const id = nextSeq();
  events.append({
    eventId: `no-agent-r2-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: {
      traceId: "trace-no-agent",
      executionId: `exec-na-r2-${id}`,
      schedulerInstanceId: "sched-1",
      optimizationRoundId: "round-2",
    },
    payload: {},
    metrics: {},
  });

  const result = projectContextStrategies(db, { roundId: "round-2" });

  assert.equal(result.unattributed, 1);
  assert.equal(result.buckets.length, 0);
});

// ── T2: projectContextStrategiesByRound ─────────────────────────────

test("projectContextStrategiesByRound: groups by roundId", () => {
  const { db, events } = setup();

  // Round 1: two agents
  appendModelCompleted(events, { agentInstanceId: "agent-a" });
  // default optimizationRoundId = "round-1"
  appendModelCompleted(events, { agentInstanceId: "agent-a" });

  // Round 2: different agent, different round
  const id = nextSeq();
  events.append({
    eventId: `model-r2-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "agent-b",
      executionId: `exec-r2-${id}`,
      optimizationRoundId: "round-2",
    }),
    payload: {},
    metrics: { input: 500, output: 200, cost: 0.05, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategiesByRound(db);

  const roundIds = Object.keys(result).sort();
  assert.deepEqual(roundIds, ["round-1", "round-2"]);

  assert.equal(result["round-1"]!.buckets.length, 1);
  assert.equal(result["round-1"]!.buckets[0]!.agentInstanceId, "agent-a");
  assert.equal(result["round-1"]!.buckets[0]!.modelCalls, 2);

  assert.equal(result["round-2"]!.buckets.length, 1);
  assert.equal(result["round-2"]!.buckets[0]!.agentInstanceId, "agent-b");
  assert.equal(result["round-2"]!.buckets[0]!.totalInputTokens, 500);
});

test("projectContextStrategiesByRound: empty when no events", () => {
  const { db } = setup();

  const result = projectContextStrategiesByRound(db);

  assert.deepEqual(result, {});
});

test("projectContextStrategiesByRound: respects schedulerInstanceId filter", () => {
  const { db, events } = setup();

  appendModelCompleted(events, {
    agentInstanceId: "agent-a",
    schedulerInstanceId: "sched-1",
  });

  const id = nextSeq();
  events.append({
    eventId: `model-s2-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: makeIdentity({
      agentInstanceId: "agent-b",
      executionId: `exec-s2-${id}`,
      schedulerInstanceId: "sched-2",
      optimizationRoundId: "round-2",
    }),
    payload: {},
    metrics: { input: 500, output: 200, cost: 0.05, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategiesByRound(db, {
    schedulerInstanceId: "sched-1",
  });

  assert.deepEqual(Object.keys(result), ["round-1"]);
  assert.equal(result["round-1"]!.buckets[0]!.agentInstanceId, "agent-a");
});

test("projectContextStrategiesByRound: skips null roundId", () => {
  const { db, events } = setup();

  // Event with non-null roundId
  appendModelCompleted(events, { agentInstanceId: "agent-a" });

  // Event with null optimizationRoundId
  const id = nextSeq();
  events.append({
    eventId: `model-noround-${id}`,
    eventType: "model.completed",
    schemaVersion: "1.0",
    timestamp: 1000,
    identity: {
      traceId: "trace-no-round",
      executionId: `exec-nr-${id}`,
      agentInstanceId: "agent-b",
      schedulerInstanceId: "sched-1",
    },
    payload: {},
    metrics: { input: 500, output: 200, cost: 0.05, durationMs: 500, source: "observed" },
  });

  const result = projectContextStrategiesByRound(db);

  // Only round-1 should be present; null round is skipped
  assert.deepEqual(Object.keys(result), ["round-1"]);
  assert.equal(result["round-1"]!.buckets.length, 1);
  assert.equal(result["round-1"]!.buckets[0]!.agentInstanceId, "agent-a");
});

// ── T2: backward compat — no roundId → same behavior ───────────────

test("backward compat: no roundId produces same result as before", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a", input: 100, output: 50, cost: 0.01, source: "observed" });
  appendModelCompleted(events, { agentInstanceId: "agent-b", input: 200, output: 80, cost: 0.02, source: "derived" });
  appendAgentCompleted(events, { agentInstanceId: "agent-a", executionId: "exec-1" });

  const result = projectContextStrategies(db);

  assert.equal(result.buckets.length, 2);
  assert.equal(result.unattributed, 0);

  const bucketA = findBucket(result, "agent-a")!;
  assert.equal(bucketA.modelCalls, 1);
  assert.equal(bucketA.totalInputTokens, 100);
  assert.equal(bucketA.totalCostObserved, 0.01);
  assert.equal(bucketA.executions, 1);

  const bucketB = findBucket(result, "agent-b")!;
  assert.equal(bucketB.modelCalls, 1);
  assert.equal(bucketB.totalInputTokens, 200);
  assert.equal(bucketB.totalCostDerived, 0.02);
});

test("backward compat: empty opts produces same result as undefined opts", () => {
  const { db, events } = setup();

  appendModelCompleted(events, { agentInstanceId: "agent-a" });

  const result1 = projectContextStrategies(db);
  const result2 = projectContextStrategies(db, {});

  assert.equal(result1.buckets.length, result2.buckets.length);
  assert.equal(result1.buckets[0]!.agentInstanceId, result2.buckets[0]!.agentInstanceId);
  assert.equal(result1.buckets[0]!.modelCalls, result2.buckets[0]!.modelCalls);
  assert.equal(result1.unattributed, result2.unattributed);
});
