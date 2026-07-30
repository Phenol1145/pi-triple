import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { SchedulerInstanceDraftSpec } from "../src/core/contracts.ts";

function draft(): SchedulerInstanceDraftSpec {
  return {
    id: "coding-scheduler",
    schedulerDefinition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    initialParameters: { completion: 0.7 },
    agents: [],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [{ id: "coding", priority: 10, match: { role: "worker" } }],
    metadata: { owner: "test" },
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  return { db, repo };
}

test("CoreRepository stores draft as an immutable JSON snapshot", () => {
  const { db, repo } = setup();
  const value = draft();
  repo.saveDraft(value);
  value.initialParameters = { completion: 0 };
  assert.deepEqual(repo.getDraft("coding-scheduler")?.spec.initialParameters, { completion: 0.7 });
  db.close();
});

test("CoreRepository rejects duplicate draft ids", () => {
  const { db, repo } = setup();
  repo.saveDraft(draft());
  assert.throws(() => repo.saveDraft(draft()), /draft already exists/);
  db.close();
});

test("CoreRepository transaction rolls back every write on error", () => {
  const { db, repo } = setup();
  assert.throws(() => repo.transaction(() => {
    repo.saveDraft(draft());
    throw new Error("stop");
  }), /stop/);
  assert.equal(repo.getDraft("coding-scheduler"), undefined);
  db.close();
});

test("listRoutingBindings returns all bindings with parsed match JSON", () => {
  const { db, repo } = setup();
  repo.saveDraft(draft());

  // Activate the draft via transaction to insert routing bindings
  repo.transaction(() => {
    repo.insertInstance(
      {
        id: "coding-scheduler",
        name: "coding-scheduler",
        definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: "coding-scheduler:round:0",
        fallbackChain: [{ type: "original-request" }],
        createdAt: Date.now(),
      },
      { owner: "test" },
    );
    repo.insertRoutingBinding("coding-scheduler", {
      id: "coding",
      priority: 10,
      match: { role: "worker" },
    });
    repo.insertRoutingBinding("coding-scheduler", {
      id: "catch-all",
      priority: 0,
      match: {},
    });
  });

  const bindings = repo.listRoutingBindings();
  assert.equal(bindings.length, 2);

  // Sorted by priority DESC, id ASC
  assert.equal(bindings[0].id, "coding");
  assert.equal(bindings[0].schedulerInstanceId, "coding-scheduler");
  assert.equal(bindings[0].priority, 10);
  assert.deepEqual(bindings[0].match, { role: "worker" });

  assert.equal(bindings[1].id, "catch-all");
  assert.equal(bindings[1].schedulerInstanceId, "coding-scheduler");
  assert.equal(bindings[1].priority, 0);
  assert.deepEqual(bindings[1].match, {});

  db.close();
});

test("listRoutingBindings returns empty array when no bindings exist", () => {
  const { db, repo } = setup();
  assert.deepEqual(repo.listRoutingBindings(), []);
  db.close();
});

// ── UUID-identity: find by name methods ──

test("findInstanceByName returns instance when (definition_id, name) matches", () => {
  const { db, repo } = setup();
  const instanceId = crypto.randomUUID();
  const instance: SchedulerInstanceDraftSpec = {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler", id: "market", version: "1.0.0" },
    initialParameters: {},
    agents: [],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [],
  };
  repo.transaction(() => {
    repo.insertInstance(
      {
        id: instanceId,
        name: "default-market",
        definition: { kind: "scheduler", id: "market", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: `${instanceId}:round:0`,
        fallbackChain: [{ type: "original-request" }],
        createdAt: Date.now(),
      },
      { owner: "test" },
    );
  });

  const found = repo.findInstanceByName("market", "default-market");
  assert.ok(found, "should find instance by name");
  assert.equal(found!.id, instanceId, "should return the UUID id");
  assert.equal(found!.name, "default-market");
  assert.equal(found!.definition.id, "market");

  // getInstance by UUID id also works
  const byId = repo.getInstance(instanceId);
  assert.ok(byId);
  assert.equal(byId!.id, instanceId);
  assert.equal(byId!.name, "default-market");

  db.close();
});

test("findInstanceByName returns undefined for non-existent name", () => {
  const { db, repo } = setup();
  assert.equal(repo.findInstanceByName("market", "no-such-name"), undefined);
  db.close();
});

test("findRoutingBindingByName finds binding by (scheduler_instance_id, name)", () => {
  const { db, repo } = setup();
  const instanceId = crypto.randomUUID();
  repo.transaction(() => {
    repo.insertInstance(
      {
        id: instanceId,
        name: "test-scheduler",
        definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: `${instanceId}:round:0`,
        fallbackChain: [{ type: "original-request" }],
        createdAt: Date.now(),
      },
      { owner: "test" },
    );
    repo.insertRoutingBinding(instanceId, {
      id: crypto.randomUUID(),
      priority: 10,
      match: { role: "worker" },
    });
  });

  // insertRoutingBinding uses binding.id as the name, so look up by that id
  const bindings = repo.listRoutingBindings();
  assert.equal(bindings.length, 1);
  const bindingName = bindings[0].name;

  const found = repo.findRoutingBindingByName(instanceId, bindingName);
  assert.ok(found, "should find routing binding by name");
  assert.equal(found!.schedulerInstanceId, instanceId);
  assert.equal(found!.priority, 10);
  assert.deepEqual(found!.match, { role: "worker" });

  db.close();
});

test("findRoutingBindingByName returns undefined for non-existent name", () => {
  const { db, repo } = setup();
  assert.equal(repo.findRoutingBindingByName("no-such-si", "no-such-name"), undefined);
  db.close();
});

test("deleteRoutingBindingByName deletes by (scheduler_instance_id, name)", () => {
  const { db, repo } = setup();
  const instanceId = crypto.randomUUID();
  repo.transaction(() => {
    repo.insertInstance(
      {
        id: instanceId,
        name: "test-scheduler",
        definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: `${instanceId}:round:0`,
        fallbackChain: [{ type: "original-request" }],
        createdAt: Date.now(),
      },
      { owner: "test" },
    );
    repo.insertRoutingBinding(instanceId, {
      id: crypto.randomUUID(),
      priority: 5,
      match: {},
    });
  });

  const bindings = repo.listRoutingBindings();
  assert.equal(bindings.length, 1);
  const bindingName = bindings[0].name;

  const deleted = repo.deleteRoutingBindingByName(instanceId, bindingName);
  assert.equal(deleted, 1);
  assert.equal(repo.listRoutingBindings().length, 0);
  assert.equal(repo.findRoutingBindingByName(instanceId, bindingName), undefined);

  // Deleting again returns 0 changes
  assert.equal(repo.deleteRoutingBindingByName(instanceId, bindingName), 0);

  db.close();
});

test("findOptimizerByName finds optimizer by (definition_id, name)", () => {
  const { db, repo } = setup();
  const optimizerId = crypto.randomUUID();
  repo.insertOptimizerInstance({
    id: optimizerId,
    name: "default-optimizer",
    definitionId: "weighted-tuner",
    definitionVersion: "1.0.0",
    config: { stepSize: 0.1 },
    targetSchedulers: ["scheduler-1"],
    status: "active",
    createdAt: Date.now(),
  });

  const found = repo.findOptimizerByName("weighted-tuner", "default-optimizer");
  assert.ok(found, "should find optimizer by name");
  assert.equal(found!.id, optimizerId);
  assert.equal(found!.name, "default-optimizer");
  assert.equal(found!.definitionId, "weighted-tuner");
  assert.equal(found!.status, "active");

  // getOptimizerInstance by UUID id also works
  const byId = repo.getOptimizerInstance(optimizerId);
  assert.ok(byId);
  assert.equal(byId!.id, optimizerId);

  // Non-existent returns undefined
  assert.equal(repo.findOptimizerByName("weighted-tuner", "no-such"), undefined);

  db.close();
});

test("Core schema is additive and does not alter legacy tables", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, role TEXT NOT NULL)");
  new CoreRepository(db);
  db.prepare("INSERT INTO runs (role) VALUES (?)").run("worker");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);
  db.close();
});
