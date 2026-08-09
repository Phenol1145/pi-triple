import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { ControlPlane, InstanceNotActiveError } from "../src/core/control-plane/service.ts";
import type { SchedulerDefinition, WorkLoopDefinition } from "../src/core/contracts.ts";

function scheduler(): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "weighted-scorer",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: { topN: 1 },
    tunablePaths: ["topN"],
    validateParameters: (value) => {
      const topN = (value as { topN?: unknown })?.topN;
      return Number.isInteger(topN) && Number(topN) > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "topN", code: "range", message: "topN must be a positive integer" }] };
    },
    validateAgentDefinition: (value) => {
      const name = (value as { standard?: { name?: unknown } })?.standard?.name;
      return typeof name === "string" && name.length > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "standard.name", code: "required", message: "agent name is required" }] };
    },
  };
}

const loop: WorkLoopDefinition = {
  kind: "workloop",
  id: "pi-default-loop",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: { type: "object" },
  requiredCapabilities: [],
  cloneModes: ["fresh", "fork"],
};

function setup() {
  const db = new DatabaseSync(":memory:");
  const definitions = new DefinitionRegistry();
  definitions.register(scheduler());
  definitions.register(loop);
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const service = new ControlPlane(definitions, repository, events, () => 1_000);
  return { db, definitions, repository, events, service };
}

function insertActiveInstance(repo: CoreRepository, id: string) {
  repo.insertInstance(
    {
      id,
      name: id,
      definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
      parameterModelVersion: "1",
      agentDefinitionSchemaVersion: "1",
      status: "active",
      currentRoundId: `${id}:round:0`,
      fallbackChain: [{ type: "original-request" }],
      createdAt: 1_000,
    },
    {},
  );
}

// ── upsertRoutingBinding ──────────────────────────────────────────

test("upsertRoutingBinding creates a new binding", () => {
  const { db, repository } = setup();
  repository.upsertRoutingBinding("arena-1", {
    id: "arena-default",
    priority: 10,
    match: {},
  });
  const bindings = repository.listRoutingBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].id, "arena-default");
  assert.equal(bindings[0].schedulerInstanceId, "arena-1");
  assert.equal(bindings[0].priority, 10);
  assert.deepEqual(bindings[0].match, {});
  db.close();
});

test("upsertRoutingBinding updates an existing binding by id (idempotent)", () => {
  const { db, repository } = setup();
  repository.upsertRoutingBinding("arena-1", {
    id: "arena-default",
    priority: 10,
    match: {},
  });
  // Same id, different priority and match
  repository.upsertRoutingBinding("arena-2", {
    id: "arena-default",
    priority: 5,
    match: { role: "worker" },
  });
  const bindings = repository.listRoutingBindings();
  assert.equal(bindings.length, 1); // still one row
  assert.equal(bindings[0].id, "arena-default");
  assert.equal(bindings[0].schedulerInstanceId, "arena-2");
  assert.equal(bindings[0].priority, 5);
  assert.deepEqual(bindings[0].match, { role: "worker" });
  db.close();
});

test("upsertRoutingBinding is idempotent when called twice with same data", () => {
  const { db, repository } = setup();
  repository.upsertRoutingBinding("arena-1", {
    id: "arena-default",
    priority: 10,
    match: {},
  });
  repository.upsertRoutingBinding("arena-1", {
    id: "arena-default",
    priority: 10,
    match: {},
  });
  assert.equal(repository.listRoutingBindings().length, 1);
  db.close();
});

// ── deleteRoutingBinding ───────────────────────────────────────────

test("deleteRoutingBinding removes a binding and returns count 1", () => {
  const { db, repository } = setup();
  repository.upsertRoutingBinding("arena-1", {
    id: "arena-default",
    priority: 10,
    match: {},
  });
  const deleted = repository.deleteRoutingBinding("arena-default");
  assert.equal(deleted, 1);
  assert.equal(repository.listRoutingBindings().length, 0);
  db.close();
});

test("deleteRoutingBinding returns 0 when binding does not exist", () => {
  const { db, repository } = setup();
  const deleted = repository.deleteRoutingBinding("nonexistent");
  assert.equal(deleted, 0);
  db.close();
});

// ── setCatchAllBinding: active-instance validation ──────────────────

test("setCatchAllBinding throws InstanceNotActiveError when instance not found", () => {
  const { db, service } = setup();
  assert.throws(
    () => service.setCatchAllBinding("missing", "arena-default", true),
    InstanceNotActiveError,
  );
  db.close();
});

test("setCatchAllBinding throws InstanceNotActiveError when instance is not active", () => {
  const { db, repository, service } = setup();
  // Insert instance with inactive status
  repository.insertInstance(
    {
      id: "arena-1",
      name: "arena-1",
      definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
      parameterModelVersion: "1",
      agentDefinitionSchemaVersion: "1",
      status: "inactive",
      currentRoundId: "arena-1:round:0",
      fallbackChain: [{ type: "original-request" }],
      createdAt: 1_000,
    },
    {},
  );
  assert.throws(
    () => service.setCatchAllBinding("arena-1", "arena-default", true),
    InstanceNotActiveError,
  );
  db.close();
});

test("setCatchAllBinding succeeds when instance is active", () => {
  const { db, repository, service } = setup();
  insertActiveInstance(repository, "arena-1");
  // Should not throw
  service.setCatchAllBinding("arena-1", "arena-default", true);
  db.close();
});

// ── setCatchAllBinding: enabled=true upserts arena-default ──────────

test("setCatchAllBinding enabled=true creates arena-default binding", () => {
  const { db, repository, service } = setup();
  insertActiveInstance(repository, "arena-1");
  service.setCatchAllBinding("arena-1", "arena-default", true);

  const bindings = repository.listRoutingBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].id, "arena-default");
  assert.equal(bindings[0].schedulerInstanceId, "arena-1");
  assert.equal(bindings[0].priority, 10);
  assert.deepEqual(bindings[0].match, {});
  db.close();
});

test("setCatchAllBinding enabled=true is idempotent (does not duplicate)", () => {
  const { db, repository, service } = setup();
  insertActiveInstance(repository, "arena-1");
  service.setCatchAllBinding("arena-1", "arena-default", true);
  service.setCatchAllBinding("arena-1", "arena-default", true);
  assert.equal(repository.listRoutingBindings().length, 1);
  db.close();
});

// ── setCatchAllBinding: enabled=false removes arena-default ─────────

test("setCatchAllBinding enabled=false removes arena-default binding", () => {
  const { db, repository, service } = setup();
  insertActiveInstance(repository, "arena-1");
  service.setCatchAllBinding("arena-1", "arena-default", true);
  assert.equal(repository.listRoutingBindings().length, 1);

  service.setCatchAllBinding("arena-1", "arena-default", false);
  assert.equal(repository.listRoutingBindings().length, 0);
  db.close();
});

test("setCatchAllBinding enabled=false is idempotent (no error when binding absent)", () => {
  const { db, repository, service } = setup();
  insertActiveInstance(repository, "arena-1");
  // No binding exists yet
  service.setCatchAllBinding("arena-1", "arena-default", false);
  assert.equal(repository.listRoutingBindings().length, 0);
  db.close();
});

// ── setCatchAllBinding: audit events ────────────────────────────────

test("setCatchAllBinding enabled=true emits routing.binding.added event", () => {
  const { db, repository, events, service } = setup();
  insertActiveInstance(repository, "arena-1");
  service.setCatchAllBinding("arena-1", "arena-default", true);

  const evts = events.query({ eventType: "routing.binding.added" });
  assert.equal(evts.length, 1);
  const evt = evts[0];
  assert.equal(evt.identity.schedulerInstanceId, "arena-1");
  assert.deepEqual(evt.payload, {
    schedulerInstanceId: "arena-1",
    binding: { id: "arena-default", priority: 10, match: {} },
  });
  db.close();
});

test("setCatchAllBinding enabled=false emits routing.binding.removed event", () => {
  const { db, repository, events, service } = setup();
  insertActiveInstance(repository, "arena-1");
  service.setCatchAllBinding("arena-1", "arena-default", true);
  service.setCatchAllBinding("arena-1", "arena-default", false);

  const evts = events.query({ eventType: "routing.binding.removed" });
  assert.equal(evts.length, 1);
  const evt = evts[0];
  assert.equal(evt.identity.schedulerInstanceId, "arena-1");
  assert.deepEqual(evt.payload, {
    schedulerInstanceId: "arena-1",
    binding: { id: "arena-default", priority: 10, match: {} },
  });
  db.close();
});

test("setCatchAllBinding emits no removed event when binding did not exist", () => {
  const { db, repository, events, service } = setup();
  insertActiveInstance(repository, "arena-1");
  // No binding was ever added
  service.setCatchAllBinding("arena-1", "arena-default", false);

  const evts = events.query({ eventType: "routing.binding.removed" });
  assert.equal(evts.length, 0);
  db.close();
});

// ── setCatchAllBinding: round-trip ──────────────────────────────────

test("setCatchAllBinding round-trip: enable → binding exists, disable → gone", () => {
  const { db, repository, service } = setup();
  insertActiveInstance(repository, "arena-1");

  // Enable
  service.setCatchAllBinding("arena-1", "arena-default", true);
  assert.equal(repository.listRoutingBindings().length, 1);
  assert.equal(repository.listRoutingBindings()[0].id, "arena-default");

  // Disable
  service.setCatchAllBinding("arena-1", "arena-default", false);
  assert.equal(repository.listRoutingBindings().length, 0);

  // Re-enable
  service.setCatchAllBinding("arena-1", "arena-default", true);
  assert.equal(repository.listRoutingBindings().length, 1);
  assert.equal(repository.listRoutingBindings()[0].id, "arena-default");

  db.close();
});

// ── setCatchAllBinding: atomicity (transaction) ─────────────────────

test("setCatchAllBinding is atomic: binding + event in same transaction", () => {
  const { db, repository, events, service } = setup();
  insertActiveInstance(repository, "arena-1");

  // Simulate post-transaction verification: both binding and event must be visible
  service.setCatchAllBinding("arena-1", "arena-default", true);

  const bindings = repository.listRoutingBindings();
  const evts = events.query({ eventType: "routing.binding.added" });
  assert.equal(bindings.length, 1);
  assert.equal(evts.length, 1);
  db.close();
});
