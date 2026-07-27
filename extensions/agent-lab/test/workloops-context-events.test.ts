import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emitContextTransform,
  emitSummaryCreated,
} from "../src/workloops/context-events.ts";
import type {
  ContextTransformDetails,
  ContextSummaryDetails,
} from "../src/workloops/context-events.ts";
import type { WorkLoopTelemetry } from "../src/workloop/contracts.ts";

// ── helpers ──────────────────────────────────────────────────────────

interface CapturedEmit {
  eventType: string;
  payload: unknown;
  metrics: Record<string, string | number | boolean | null> | undefined;
}

function captureTelemetry(): {
  telemetry: WorkLoopTelemetry;
  calls: CapturedEmit[];
} {
  const calls: CapturedEmit[] = [];
  return {
    calls,
    telemetry: {
      emit(
        eventType: string,
        payload: unknown,
        metrics?: Record<string, string | number | boolean | null>,
      ) {
        calls.push({ eventType, payload, metrics });
      },
    },
  };
}

function throwingTelemetry(): WorkLoopTelemetry {
  return {
    emit(): void {
      throw new Error("telemetry failure");
    },
  };
}

// ── emitContextTransform ────────────────────────────────────────────

test("emitContextTransform: emits context.transformed with payload + metrics", () => {
  const { telemetry, calls } = captureTelemetry();

  emitContextTransform(telemetry, {
    strategyId: "budgeted-history",
    kind: "truncate",
    beforeTokens: 12000,
    afterTokens: 7800,
    droppedSegments: 5,
    roundId: "round-2",
  });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.eventType, "context.transformed");

  const payload = call.payload as Record<string, unknown>;
  assert.equal(payload.strategyId, "budgeted-history");
  assert.equal(payload.kind, "truncate");
  assert.equal(payload.source, "estimated");
  assert.equal(payload.roundId, "round-2");

  assert.ok(call.metrics !== undefined);
  assert.equal(call.metrics!.beforeTokens, 12000);
  assert.equal(call.metrics!.afterTokens, 7800);
  assert.equal(call.metrics!.droppedSegments, 5);
});

test("emitContextTransform: roundId is optional (omitted when undefined)", () => {
  const { telemetry, calls } = captureTelemetry();

  emitContextTransform(telemetry, {
    strategyId: "test-strat",
    kind: "select",
    beforeTokens: 5000,
    afterTokens: 5000,
    droppedSegments: 0,
  });

  assert.equal(calls.length, 1);
  const payload = calls[0]!.payload as Record<string, unknown>;
  assert.equal(payload.roundId, undefined);
});

test("emitContextTransform: all four kinds accepted", () => {
  const kinds: ContextTransformDetails["kind"][] = [
    "truncate",
    "summarize",
    "select",
    "inject",
  ];
  for (const kind of kinds) {
    const { telemetry, calls } = captureTelemetry();
    emitContextTransform(telemetry, {
      strategyId: "test",
      kind,
      beforeTokens: 100,
      afterTokens: 50,
      droppedSegments: 1,
    });
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.payload as Record<string, unknown>).kind, kind);
  }
});

test("emitContextTransform: does not throw when telemetry throws (fail-open)", () => {
  assert.doesNotThrow(() => {
    emitContextTransform(throwingTelemetry(), {
      strategyId: "test",
      kind: "truncate",
      beforeTokens: 100,
      afterTokens: 50,
      droppedSegments: 1,
    });
  });
});

// ── emitSummaryCreated ──────────────────────────────────────────────

test("emitSummaryCreated: emits context.summary.created with payload + metrics", () => {
  const { telemetry, calls } = captureTelemetry();

  emitSummaryCreated(telemetry, {
    strategyId: "selective-summary",
    inputTokens: 8000,
    outputTokens: 400,
    cost: 0.012,
    durationMs: 2340,
    source: "observed",
    roundId: "round-3",
  });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.eventType, "context.summary.created");

  const payload = call.payload as Record<string, unknown>;
  assert.equal(payload.strategyId, "selective-summary");
  assert.equal(payload.source, "observed");
  assert.equal(payload.roundId, "round-3");

  assert.ok(call.metrics !== undefined);
  assert.equal(call.metrics!.inputTokens, 8000);
  assert.equal(call.metrics!.outputTokens, 400);
  assert.equal(call.metrics!.cost, 0.012);
  assert.equal(call.metrics!.durationMs, 2340);
});

test("emitSummaryCreated: roundId is optional", () => {
  const { telemetry, calls } = captureTelemetry();

  emitSummaryCreated(telemetry, {
    strategyId: "summary",
    inputTokens: 1000,
    outputTokens: 100,
    cost: 0.001,
    durationMs: 500,
    source: "derived",
  });

  assert.equal(calls.length, 1);
  const payload = calls[0]!.payload as Record<string, unknown>;
  assert.equal(payload.roundId, undefined);
  assert.equal(payload.strategyId, "summary");
  assert.equal(payload.source, "derived");
});

test("emitSummaryCreated: does not throw when telemetry throws (fail-open)", () => {
  assert.doesNotThrow(() => {
    emitSummaryCreated(throwingTelemetry(), {
      strategyId: "test",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      durationMs: 100,
      source: "observed",
    });
  });
});

// ── event shape consistency ─────────────────────────────────────────

test("payload + metrics keys: context.transformed has expected shape", () => {
  const { telemetry, calls } = captureTelemetry();

  emitContextTransform(telemetry, {
    strategyId: "s1",
    kind: "truncate",
    beforeTokens: 10,
    afterTokens: 5,
    droppedSegments: 3,
  });

  const payload = calls[0]!.payload as Record<string, unknown>;
  const metrics = calls[0]!.metrics!;

  // payload keys
  assert.ok("strategyId" in payload);
  assert.ok("kind" in payload);
  assert.ok("source" in payload);
  assert.equal(payload.source, "estimated");

  // metrics keys
  assert.ok("beforeTokens" in metrics);
  assert.ok("afterTokens" in metrics);
  assert.ok("droppedSegments" in metrics);
});

test("payload + metrics keys: context.summary.created has expected shape", () => {
  const { telemetry, calls } = captureTelemetry();

  emitSummaryCreated(telemetry, {
    strategyId: "s2",
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.005,
    durationMs: 300,
    source: "derived",
  });

  const payload = calls[0]!.payload as Record<string, unknown>;
  const metrics = calls[0]!.metrics!;

  assert.ok("strategyId" in payload);
  assert.ok("source" in payload);
  assert.equal(payload.source, "derived");

  assert.ok("inputTokens" in metrics);
  assert.ok("outputTokens" in metrics);
  assert.ok("cost" in metrics);
  assert.ok("durationMs" in metrics);
});

test("metrics values are typed as numbers where expected", () => {
  const { telemetry, calls } = captureTelemetry();

  emitContextTransform(telemetry, {
    strategyId: "s",
    kind: "truncate",
    beforeTokens: 100,
    afterTokens: 50,
    droppedSegments: 2,
  });

  const m = calls[0]!.metrics!;
  assert.equal(typeof m.beforeTokens, "number");
  assert.equal(typeof m.afterTokens, "number");
  assert.equal(typeof m.droppedSegments, "number");
});

test("emitSummaryCreated: source field is required and validated", () => {
  const tests: Array<{ source: "observed" | "derived"; label: string }> = [
    { source: "observed", label: "observed" },
    { source: "derived", label: "derived" },
  ];

  for (const { source, label } of tests) {
    const { telemetry, calls } = captureTelemetry();

    emitSummaryCreated(telemetry, {
      strategyId: "s",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      durationMs: 100,
      source,
    });

    const payload = calls[0]!.payload as Record<string, unknown>;
    assert.equal(payload.source, source, `source should be "${label}"`);
  }
});
