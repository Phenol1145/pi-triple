import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { OptimizerRegistry, registerMetricsProjector } from "../src/optimizer/registry.ts";
import { DataAPIImpl, DataAccessDeniedError } from "../src/optimizer/data-api.ts";
import { ProjectorNotRegisteredError } from "../src/optimizer/registry.ts";
import type {
  SchedulerDefinition,
  SchedulerInstanceRecord,
  OptimizerDefinition,
  LabEvent,
} from "../src/core/contracts.ts";
import type { MetricsProjector } from "../src/optimizer/contracts.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function setup() {
  const db = new DatabaseSync(":memory:");
  const definitions = new DefinitionRegistry();
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const registry = new OptimizerRegistry(definitions, repository, events);
  return { db, definitions, repository, events, registry };
}

function schedulerDef(overrides: Partial<SchedulerDefinition> = {}): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "weighted-scorer",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1.0.0",
    parameterSchema: {},
    agentDefinitionSchema: {},
    defaultParameters: {},
    tunablePaths: [],
    validateParameters: () => ({ ok: true, value: {} }),
    validateAgentDefinition: () => ({ ok: true, value: {} }),
    ...overrides,
  };
}

function schedulerInstance(overrides: Partial<SchedulerInstanceRecord> = {}): SchedulerInstanceRecord {
  const id = overrides.id ?? "ws-1";
  return {
    id,
    name: id,
    definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1.0.0",
    status: "active",
    currentRoundId: "round-0",
    fallbackChain: [],
    createdAt: 1000,
    ...overrides,
  };
}

function optimizerDef(overrides: Partial<OptimizerDefinition> = {}): OptimizerDefinition {
  return {
    kind: "optimizer",
    id: "weighted-tuner",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configurationSchema: {
      type: "object",
      properties: { minSamples: { type: "number" } },
      required: ["minSamples"],
    },
    requiredMetrics: ["runs", "avgCompletion"],
    compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "^1.0.0" }],
    parameterModelVersionRange: "^1.0.0",
    ...overrides,
  };
}

function insertRound(repo: CoreRepository, instanceId: string, roundId: string, extra: Partial<{ sequence: number; status: string; parameters: unknown }> = {}) {
  repo.insertRound({
    id: roundId,
    schedulerInstanceId: instanceId,
    sequence: extra.sequence ?? 0,
    parameters: extra.parameters ?? {},
    status: (extra.status ?? "active") as "active",
    createdAt: 1000,
    activatedAt: 1000,
  });
}

function makeEvent(overrides: Partial<LabEvent> = {}): LabEvent {
  return {
    eventId: "evt-1",
    eventType: "round.proposed",
    schemaVersion: "1",
    timestamp: 2000,
    identity: { traceId: "trace-1", schedulerInstanceId: "ws-1" },
    payload: {},
    ...overrides,
  };
}

function makeDataAPI(
  repo: CoreRepository,
  events: EventLog,
  db: DatabaseSync,
  authorizedIds: string[],
  instanceId = "tuner-1",
) {
  return new DataAPIImpl(db, repo, events, authorizedIds, instanceId);
}

// ═══════════════════════════════════════════════════════════════════════════
// Authorization — every method
// ═══════════════════════════════════════════════════════════════════════════

test("getCurrentRound denies unauthorized scheduler instance", () => {
  const { db, repository, events } = setup();
  const api = makeDataAPI(repository, events, db, ["ws-1"]);

  assert.throws(
    () => api.getCurrentRound("ws-2"),
    (e: unknown) => e instanceof DataAccessDeniedError && (e as DataAccessDeniedError).method === "getCurrentRound",
  );
});

test("listRounds denies unauthorized scheduler instance", () => {
  const { db, repository, events } = setup();
  const api = makeDataAPI(repository, events, db, ["ws-1"]);

  assert.throws(
    () => api.listRounds("ws-2"),
    (e: unknown) => e instanceof DataAccessDeniedError && (e as DataAccessDeniedError).method === "listRounds",
  );
});

test("listEvents denies unauthorized scheduler instance", () => {
  const { db, repository, events } = setup();
  const api = makeDataAPI(repository, events, db, ["ws-1"]);

  assert.throws(
    () => api.listEvents({ schedulerInstanceId: "ws-2" }),
    (e: unknown) => e instanceof DataAccessDeniedError && (e as DataAccessDeniedError).method === "listEvents",
  );
});

test("getCandidateAggregates denies unauthorized scheduler instance", () => {
  const { db, repository, events } = setup();
  const api = makeDataAPI(repository, events, db, ["ws-1"]);

  assert.throws(
    () => api.getCandidateAggregates("ws-2", { since: 0, until: 1000 }),
    (e: unknown) => e instanceof DataAccessDeniedError && (e as DataAccessDeniedError).method === "getCandidateAggregates",
  );
});

test("authorized access does not throw", () => {
  const { db, repository, events } = setup();
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");

  events.append(makeEvent({ eventId: "e1", identity: { traceId: "t1", schedulerInstanceId: "ws-1" } }));

  const api = makeDataAPI(repository, events, db, ["ws-1"]);

  // getCurrentRound
  const round = api.getCurrentRound("ws-1");
  assert.ok(round);
  assert.equal(round.id, "round-0");

  // listRounds
  const rounds = api.listRounds("ws-1");
  assert.equal(rounds.length, 1);

  // listEvents
  const evts = api.listEvents({ schedulerInstanceId: "ws-1" });
  assert.equal(evts.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Denial event emission
// ═══════════════════════════════════════════════════════════════════════════

test("access denial emits optimizer.access.denied event", () => {
  const { db, repository, events } = setup();
  const api = makeDataAPI(repository, events, db, ["ws-1"]);

  try {
    api.getCurrentRound("ws-2");
  } catch {
    // expected
  }

  const denialEvents = events.query({ eventType: "optimizer.access.denied", limit: 1 });
  assert.equal(denialEvents.length, 1);
  const p = denialEvents[0].payload as { schedulerInstanceId: string; method: string };
  assert.equal(p.schedulerInstanceId, "ws-2");
  assert.equal(p.method, "getCurrentRound");
});

// ═══════════════════════════════════════════════════════════════════════════
// getCurrentRound delegation
// ═══════════════════════════════════════════════════════════════════════════

test("getCurrentRound returns undefined for unknown instance", () => {
  const { db, repository, events } = setup();
  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  assert.equal(api.getCurrentRound("ws-1"), undefined);
});

test("getCurrentRound returns active round", () => {
  const { db, repository, events } = setup();
  repository.insertInstance(schedulerInstance({ currentRoundId: "round-0" }), {});
  insertRound(repository, "ws-1", "round-0", { sequence: 0, status: "active" });

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  const round = api.getCurrentRound("ws-1");
  assert.ok(round);
  assert.equal(round.id, "round-0");
  assert.equal(round.status, "active");
});

// ═══════════════════════════════════════════════════════════════════════════
// listRounds delegation
// ═══════════════════════════════════════════════════════════════════════════

test("listRounds returns rounds newest-first", () => {
  const { db, repository, events } = setup();
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0", { sequence: 0 });
  insertRound(repository, "ws-1", "round-1", { sequence: 1 });
  insertRound(repository, "ws-1", "round-2", { sequence: 2 });

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  const rounds = api.listRounds("ws-1");
  assert.equal(rounds.length, 3);
  assert.equal(rounds[0].sequence, 2); // newest first
  assert.equal(rounds[2].sequence, 0); // oldest last
});

test("listRounds respects limit", () => {
  const { db, repository, events } = setup();
  repository.insertInstance(schedulerInstance(), {});
  for (let i = 0; i < 5; i++) {
    insertRound(repository, "ws-1", `round-${i}`, { sequence: i });
  }

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  const rounds = api.listRounds("ws-1", 2);
  assert.equal(rounds.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// listEvents delegation + type filtering
// ═══════════════════════════════════════════════════════════════════════════

test("listEvents returns events for the scheduler instance", () => {
  const { db, repository, events } = setup();
  events.append(makeEvent({ eventId: "e1", identity: { traceId: "t1", schedulerInstanceId: "ws-1" }, eventType: "round.proposed" }));
  events.append(makeEvent({ eventId: "e2", identity: { traceId: "t2", schedulerInstanceId: "ws-1" }, eventType: "round.promoted" }));
  events.append(makeEvent({ eventId: "e3", identity: { traceId: "t3", schedulerInstanceId: "ws-other" }, eventType: "round.proposed" }));

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  const result = api.listEvents({ schedulerInstanceId: "ws-1" });
  assert.equal(result.length, 2);
  assert.ok(result.every((e) => e.identity.schedulerInstanceId === "ws-1"));
});

test("listEvents filters by types array", () => {
  const { db, repository, events } = setup();
  events.append(makeEvent({ eventId: "e1", identity: { traceId: "t1", schedulerInstanceId: "ws-1" }, eventType: "round.proposed" }));
  events.append(makeEvent({ eventId: "e2", identity: { traceId: "t2", schedulerInstanceId: "ws-1" }, eventType: "round.promoted" }));
  events.append(makeEvent({ eventId: "e3", identity: { traceId: "t3", schedulerInstanceId: "ws-1" }, eventType: "round.proposed" }));

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  const result = api.listEvents({
    schedulerInstanceId: "ws-1",
    types: ["round.proposed"],
  });
  assert.equal(result.length, 2);
  assert.ok(result.every((e) => e.eventType === "round.proposed"));
});

test("listEvents respects since/until filter", () => {
  const { db, repository, events } = setup();
  events.append(makeEvent({ eventId: "e1", identity: { traceId: "t1", schedulerInstanceId: "ws-1" }, timestamp: 100 }));
  events.append(makeEvent({ eventId: "e2", identity: { traceId: "t2", schedulerInstanceId: "ws-1" }, timestamp: 200 }));
  events.append(makeEvent({ eventId: "e3", identity: { traceId: "t3", schedulerInstanceId: "ws-1" }, timestamp: 300 }));

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  const result = api.listEvents({
    schedulerInstanceId: "ws-1",
    since: 150,
    until: 250,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].eventId, "e2");
});

// ═══════════════════════════════════════════════════════════════════════════
// getCandidateAggregates — projector delegation
// ═══════════════════════════════════════════════════════════════════════════

test("getCandidateAggregates throws ProjectorNotRegisteredError when no projector", () => {
  const { db, repository, events } = setup();
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  assert.throws(
    () => api.getCandidateAggregates("ws-1", { since: 0, until: 1000 }),
    ProjectorNotRegisteredError,
  );
});

test("getCandidateAggregates delegates to registered projector", () => {
  const { db, repository, events } = setup();
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");

  let capturedDb: unknown;
  let capturedWindow: unknown;
  let capturedOpts: unknown;

  registerMetricsProjector("weighted-scorer", ((dbParam, window, opts) => {
    capturedDb = dbParam;
    capturedWindow = window;
    capturedOpts = opts;
    return { runs: 10 };
  }) as MetricsProjector);

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  const result = api.getCandidateAggregates("ws-1", { since: 100, until: 200 }, "test-role");

  assert.deepEqual(result, { runs: 10 });
  assert.ok(capturedDb);
  assert.deepEqual(capturedWindow, { since: 100, until: 200 });
  assert.deepEqual(capturedOpts, { schedulerInstanceId: "ws-1", role: "test-role" });
});

test("getCandidateAggregates passes role as undefined when omitted", () => {
  const { db, repository, events } = setup();
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");

  let capturedOpts: { role?: string } | undefined;

  registerMetricsProjector("weighted-scorer", ((_db, _window, opts) => {
    capturedOpts = opts;
    return {};
  }) as MetricsProjector);

  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  api.getCandidateAggregates("ws-1", { since: 0, until: 1000 });

  assert.ok(capturedOpts);
  assert.equal(capturedOpts.role, undefined);
});

test("getCandidateAggregates throws ProjectorNotRegisteredError when instance not found", () => {
  const { db, repository, events } = setup();
  const api = makeDataAPI(repository, events, db, ["ws-1"]);
  assert.throws(
    () => api.getCandidateAggregates("ws-1", { since: 0, until: 1000 }),
    ProjectorNotRegisteredError,
  );
});
