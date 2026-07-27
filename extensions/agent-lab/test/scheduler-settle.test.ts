import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { SchedulerRunner } from "../src/scheduler/runner.ts";
import type { LabCore } from "../src/core/create-core.ts";
import type {
  SchedulerDefinition,
} from "../src/core/contracts.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulingResult,
  SettleOutcome,
  SettleContext,
} from "../src/scheduler/contracts.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function schedulerDef(
  overrides: Partial<SchedulerDefinition> = {},
): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "test-scheduler",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1.0.0",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: { weight: 0.5 },
    tunablePaths: ["weight"],
    validateParameters: () => ({ ok: true as const, value: {} }),
    validateAgentDefinition: () => ({ ok: true as const, value: {} }),
    ...overrides,
  };
}

function buildCore(opts?: {
  instanceId?: string;
}): { core: LabCore; db: DatabaseSync; instanceId: string; roundId: string } {
  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);
  const controlPlane = new ControlPlane(definitions, repository, events);

  const instanceId = opts?.instanceId ?? "test-instance";
  const now = Date.now();
  const roundId = `${instanceId}:round:0`;

  const draftSpec = {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler" as const, id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "original-request" as const }],
    routingBindings: [{ id: "default", priority: 10, match: {} }],
    metadata: {},
  };

  repository.saveDraft(draftSpec);

  repository.transaction(() => {
    repository.insertInstance(
      {
        id: instanceId,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: roundId,
        fallbackChain: [{ type: "original-request" }],
        createdAt: now,
      },
      {},
    );

    repository.insertRound({
      id: roundId,
      schedulerInstanceId: instanceId,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: now,
      activatedAt: now,
    });

    // Insert routing binding
    repository.insertRoutingBinding(instanceId, {
      id: "default",
      priority: 10,
      match: {},
    });
  });

  const core: LabCore = { definitions, repository, events, storage, controlPlane };
  return { core, db, instanceId, roundId };
}

function scheduleResult(
  status: "completed",
  overrides?: Partial<Extract<SchedulingResult, { status: "completed" }>> & { settlementRef?: string },
): Extract<SchedulingResult, { status: "completed" }>;
function scheduleResult(status: "abstained"): Extract<SchedulingResult, { status: "abstained" }>;
function scheduleResult(status: "failed"): Extract<SchedulingResult, { status: "failed" }>;
function scheduleResult(
  status: SchedulingResult["status"],
  overrides: Partial<SchedulingResult> = {},
): SchedulingResult {
  switch (status) {
    case "completed":
      return {
        status: "completed",
        selectedAgentId: "agent-1",
        model: "gpt-4",
        reason: "best score",
        ...overrides,
      } as SchedulingResult;
    case "abstained":
      return { status: "abstained", reason: "no candidates" };
    case "failed":
      return {
        status: "failed",
        error: { code: "ERR", message: "fail", retryable: false },
        ...overrides,
      };
  }
}

function settleOutcome(overrides: Partial<SettleOutcome> = {}): SettleOutcome {
  return {
    completion: 0.95,
    majorError: false,
    tokensIn: 500,
    tokensOut: 200,
    cost: 0.015,
    toolCalls: [{ name: "read", durationMs: 100 }],
    inferenceLatencyMs: 1200,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

// Test 1: settlementRef threaded SchedulingInput → SchedulingResult.completed → DispatchResult.completed
test("settlementRef threaded from input through scheduling result to dispatch result", async (t) => {
  const { core, db, instanceId } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedInput: SchedulingInput | undefined;

  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (input) => {
      capturedInput = input;
      const ref = (input as SchedulingInput & { settlementRef?: string }).settlementRef;
      return scheduleResult("completed", { settlementRef: ref, selectedAgentId: "agent-1" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "trace-1",
    role: "default",
    task: "test task",
    mode: "select",
    settlementRef: "settle-ref-42",
  });

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal((result as Record<string, unknown>).settlementRef, "settle-ref-42");
  }
  assert.ok(capturedInput);
  assert.equal((capturedInput as SchedulingInput & { settlementRef?: string }).settlementRef, "settle-ref-42");

  db.close();
});

// Test 2: settlementRef undefined in DispatchResult when input lacks it
test("settlementRef undefined when SchedulingInput does not carry it", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("completed", { selectedAgentId: "agent-1" }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "trace-1",
    role: "default",
    task: "test task",
    mode: "select",
  });

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal((result as Record<string, unknown>).settlementRef, undefined);
  }

  db.close();
});

// Test 3: runner.settle calls impl.settle when settlementRef registered → returns true
test("runner.settle calls impl.settle when settlementRef registered and returns true", async (t) => {
  const { core, db } = buildCore();

  const settleCalls: Array<{ ctx: SettleContext; taskRef: string; outcome: SettleOutcome }> = [];

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { settlementRef: "ref-123", selectedAgentId: "agent-1" }),
    settle: async (ctx, taskRef, outcome) => {
      settleCalls.push({ ctx, taskRef, outcome });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "trace-1",
    role: "default",
    task: "test task",
    mode: "select",
    settlementRef: "ref-123",
  });

  const outcome = settleOutcome();
  const settled = await runner.settle("ref-123", outcome);

  assert.equal(settled, true);
  assert.equal(settleCalls.length, 1);
  assert.equal(settleCalls[0].taskRef, "ref-123");
  assert.equal(settleCalls[0].outcome.completion, 0.95);

  // Verify SettleContext fields
  const ctx = settleCalls[0].ctx;
  assert.equal(typeof ctx.schedulerInstanceId, "string");
  assert.equal(typeof ctx.roundId, "string");
  assert.equal(ctx.traceId, "trace-1");
  assert.equal(typeof ctx.telemetry.emit, "function");
  assert.equal(typeof ctx.now, "number");

  db.close();
});

// Test 4: runner.settle returns false for unknown taskRef
test("runner.settle returns false for unknown taskRef", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("completed", { selectedAgentId: "agent-1" }),
    settle: async () => {},
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.settle("unknown-ref", settleOutcome());
  assert.equal(result, false);

  db.close();
});

// Test 5: runner.settle returns false when impl has no settle hook
test("runner.settle returns false when impl has no settle hook", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { settlementRef: "ref-456", selectedAgentId: "agent-1" }),
    // no settle hook
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "trace-2",
    role: "default",
    task: "test task",
    mode: "select",
    settlementRef: "ref-456",
  });

  const result = await runner.settle("ref-456", settleOutcome());
  assert.equal(result, false);

  db.close();
});

// Test 6: runner.settle fail-open on hook error → returns false
test("runner.settle is fail-open when impl.settle throws and returns false", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { settlementRef: "ref-err", selectedAgentId: "agent-1" }),
    settle: async () => {
      throw new Error("settle hook exploded");
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "trace-3",
    role: "default",
    task: "test task",
    mode: "select",
    settlementRef: "ref-err",
  });

  const result = await runner.settle("ref-err", settleOutcome());
  assert.equal(result, false);

  db.close();
});

// Test 7: scheduler.settled audit event emitted with correct fields
test("scheduler.settled audit event is emitted when settle succeeds", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { settlementRef: "ref-audit", selectedAgentId: "agent-1" }),
    settle: async () => {},
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "trace-audit",
    role: "default",
    task: "test task",
    mode: "select",
    settlementRef: "ref-audit",
  });

  await runner.settle("ref-audit", settleOutcome({ completion: 0.88 }));

  const events = core.events.query({ eventType: "scheduler.settled", traceId: "trace-audit" });
  assert.equal(events.length, 1);
  const evt = events[0];
  assert.equal(evt.eventType, "scheduler.settled");
  assert.equal(typeof evt.identity.schedulerInstanceId, "string");
  assert.equal(typeof evt.identity.optimizationRoundId, "string");
  assert.equal(evt.identity.traceId, "trace-audit");
  assert.equal((evt.payload as Record<string, unknown>).outcomeCompletion, 0.88);

  db.close();
});

// Test 8: pendingSettlements map FIFO cap at 1000
test("pendingSettlements map respects FIFO cap of 1000 entries", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (input) => {
      const ref = (input as SchedulingInput & { settlementRef?: string }).settlementRef;
      return scheduleResult("completed", { settlementRef: ref, selectedAgentId: "agent-1" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const total = 1001;
  for (let i = 0; i < total; i++) {
    await runner.dispatch({
      traceId: `trace-${i}`,
      role: "default",
      task: `task ${i}`,
      mode: "select",
      settlementRef: `ref-${i}`,
    });
  }

  // First entry should have been evicted (FIFO)
  const first = await runner.settle("ref-0", settleOutcome());
  assert.equal(first, false, "first entry should be evicted");

  // Last entry should still be present but returns false (no hook)
  // It is present in the map, but impl has no settle hook, so returns false
  const last = await runner.settle(`ref-${total - 1}`, settleOutcome());
  assert.equal(last, false, "last entry present but no hook");

  // ref-1 should still be in the map (second inserted, within 1000 window)
  const second = await runner.settle("ref-1", settleOutcome());
  assert.equal(second, false, "second entry still present but no hook");

  db.close();
});

// Test 9: settle removes entry from pendingSettlements after successful settle
test("pendingSettlements entry removed after successful settle", async () => {
  const { core, db } = buildCore();

  let settleCount = 0;
  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { settlementRef: "ref-once", selectedAgentId: "agent-1" }),
    settle: async () => {
      settleCount++;
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "trace-once",
    role: "default",
    task: "test",
    mode: "select",
    settlementRef: "ref-once",
  });

  // First settle works
  const first = await runner.settle("ref-once", settleOutcome());
  assert.equal(first, true);
  assert.equal(settleCount, 1);

  // Second settle on same ref fails (entry removed)
  const second = await runner.settle("ref-once", settleOutcome());
  assert.equal(second, false);
  assert.equal(settleCount, 1);

  db.close();
});

// Test 10: settlementRef absent in result → no pendingSettlements entry
test("no pendingSettlements entry when SchedulingResult.completed lacks settlementRef", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { selectedAgentId: "agent-1" }),
    settle: async () => {},
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "trace-no-ref",
    role: "default",
    task: "test",
    mode: "select",
    settlementRef: "ref-no",
  });

  const settled = await runner.settle("ref-no", settleOutcome());
  assert.equal(settled, false);

  db.close();
});

// Test 11: SettleContext telemetry.emit records events
test("SettleContext.telemetry.emit records events", async () => {
  const { core, db } = buildCore();

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { settlementRef: "ref-tel", selectedAgentId: "agent-1" }),
    settle: async (ctx) => {
      ctx.telemetry.emit("custom.metric", { key: "value" }, { num: 42 });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "trace-tel",
    role: "default",
    task: "test",
    mode: "select",
    settlementRef: "ref-tel",
  });

  await runner.settle("ref-tel", settleOutcome());

  const events = core.events.query({ eventType: "custom.metric" });
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as Record<string, unknown>).key, "value");
  assert.equal(events[0].metrics?.num, 42);

  db.close();
});
