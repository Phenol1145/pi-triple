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

test("Core schema is additive and does not alter legacy tables", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, role TEXT NOT NULL)");
  new CoreRepository(db);
  db.prepare("INSERT INTO runs (role) VALUES (?)").run("worker");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);
  db.close();
});
