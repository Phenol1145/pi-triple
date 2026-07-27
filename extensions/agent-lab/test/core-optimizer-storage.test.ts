import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { OptimizerInstanceRecord, ProposalRecord } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import type { LabEvent } from "../src/core/contracts.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  return { db, repo };
}

function setupLog() {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  return { db, log };
}

// ── Optimizer instance helpers ──

function optInstance(overrides: Partial<OptimizerInstanceRecord> = {}): OptimizerInstanceRecord {
  return {
    id: "opt-1",
    definitionId: "weighted-tuner",
    definitionVersion: "1.0.0",
    config: { minSamples: 20 },
    targetSchedulers: ["scheduler-1"],
    status: "active",
    createdAt: 1000,
    ...overrides,
  };
}

// ── Proposal helpers ──

function proposal(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: "prop-1",
    optimizerInstanceId: "opt-1",
    schedulerInstanceId: "scheduler-1",
    baseRoundId: "round-0",
    parameters: { completion: 0.75 },
    status: "pending",
    createdAt: 2000,
    ...overrides,
  };
}

// ── Event helpers ──

function event(id: string, overrides: Partial<LabEvent> = {}): LabEvent {
  return {
    eventId: id,
    eventType: "test.started",
    schemaVersion: "1",
    timestamp: 100,
    identity: { traceId: "trace-1", schedulerInstanceId: "scheduler-1" },
    payload: {},
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Optimizer instance CRUD
// ═══════════════════════════════════════════════════════════════

test("insertOptimizerInstance stores and getOptimizerInstance retrieves full record", () => {
  const { db, repo } = setup();
  const rec = optInstance();
  repo.insertOptimizerInstance(rec);

  const got = repo.getOptimizerInstance("opt-1");
  assert.ok(got);
  assert.equal(got.id, "opt-1");
  assert.equal(got.definitionId, "weighted-tuner");
  assert.equal(got.definitionVersion, "1.0.0");
  assert.deepEqual(got.config, { minSamples: 20 });
  assert.deepEqual(got.targetSchedulers, ["scheduler-1"]);
  assert.equal(got.status, "active");
  assert.equal(got.createdAt, 1000);
  db.close();
});

test("getOptimizerInstance returns undefined for missing id", () => {
  const { db, repo } = setup();
  assert.equal(repo.getOptimizerInstance("nonexistent"), undefined);
  db.close();
});

test("listOptimizerInstances returns all instances ordered by created_at", () => {
  const { db, repo } = setup();
  repo.insertOptimizerInstance(optInstance({ id: "opt-2", createdAt: 2000 }));
  repo.insertOptimizerInstance(optInstance({ id: "opt-1", createdAt: 1000 }));
  repo.insertOptimizerInstance(optInstance({ id: "opt-3", createdAt: 3000 }));

  const list = repo.listOptimizerInstances();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, "opt-1");
  assert.equal(list[1].id, "opt-2");
  assert.equal(list[2].id, "opt-3");
  db.close();
});

test("listOptimizerInstances returns empty array when no instances", () => {
  const { db, repo } = setup();
  assert.deepEqual(repo.listOptimizerInstances(), []);
  db.close();
});

test("insertOptimizerInstance defensive copy of config is stored as JSON snapshot", () => {
  const { db, repo } = setup();
  const config = { minSamples: 20 };
  repo.insertOptimizerInstance(optInstance({ config }));
  config.minSamples = 0; // mutate after insert
  const got = repo.getOptimizerInstance("opt-1");
  assert.deepEqual(got?.config, { minSamples: 20 });
  db.close();
});

// ═══════════════════════════════════════════════════════════════
// Proposal CRUD
// ═══════════════════════════════════════════════════════════════

test("insertProposal stores and getProposal retrieves full record without optional fields", () => {
  const { db, repo } = setup();
  const prop = proposal();
  repo.insertProposal(prop);

  const got = repo.getProposal("prop-1");
  assert.ok(got);
  assert.equal(got.id, "prop-1");
  assert.equal(got.optimizerInstanceId, "opt-1");
  assert.equal(got.schedulerInstanceId, "scheduler-1");
  assert.equal(got.baseRoundId, "round-0");
  assert.deepEqual(got.parameters, { completion: 0.75 });
  assert.equal(got.evaluation, undefined);
  assert.equal(got.status, "pending");
  assert.equal(got.candidateRoundId, undefined);
  assert.equal(got.promotedRoundId, undefined);
  assert.equal(got.createdAt, 2000);
  db.close();
});

test("insertProposal with evaluation and candidate_round_id stores all optional fields", () => {
  const { db, repo } = setup();
  repo.insertProposal(proposal({
    evaluation: { summary: "ok", metrics: { runs: 50 } },
    candidateRoundId: "round-1",
    promotedRoundId: "round-2",
  }));

  const got = repo.getProposal("prop-1");
  assert.deepEqual(got?.evaluation, { summary: "ok", metrics: { runs: 50 } });
  assert.equal(got?.candidateRoundId, "round-1");
  assert.equal(got?.promotedRoundId, "round-2");
  db.close();
});

test("getProposal returns undefined for missing id", () => {
  const { db, repo } = setup();
  assert.equal(repo.getProposal("nonexistent"), undefined);
  db.close();
});

test("listProposals without filter returns all proposals ordered by created_at", () => {
  const { db, repo } = setup();
  repo.insertProposal(proposal({ id: "prop-2", createdAt: 3000, schedulerInstanceId: "sid-2" }));
  repo.insertProposal(proposal({ id: "prop-1", createdAt: 2000 }));
  repo.insertProposal(proposal({ id: "prop-3", createdAt: 4000, schedulerInstanceId: "sid-3" }));

  const list = repo.listProposals();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, "prop-1");
  assert.equal(list[1].id, "prop-2");
  assert.equal(list[2].id, "prop-3");
  db.close();
});

test("listProposals with schedulerInstanceId filters correctly", () => {
  const { db, repo } = setup();
  repo.insertProposal(proposal({ id: "prop-a", schedulerInstanceId: "sid-A", createdAt: 1000 }));
  repo.insertProposal(proposal({ id: "prop-b", schedulerInstanceId: "sid-B", createdAt: 2000 }));
  repo.insertProposal(proposal({ id: "prop-c", schedulerInstanceId: "sid-A", createdAt: 3000 }));

  const list = repo.listProposals("sid-A");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "prop-a");
  assert.equal(list[1].id, "prop-c");

  const emptyList = repo.listProposals("sid-nonexistent");
  assert.equal(emptyList.length, 0);
  db.close();
});

test("listProposals returns empty array when no proposals", () => {
  const { db, repo } = setup();
  assert.deepEqual(repo.listProposals(), []);
  db.close();
});

test("updateProposalStatus changes status and promotedRoundId", () => {
  const { db, repo } = setup();
  repo.insertProposal(proposal());

  repo.updateProposalStatus("prop-1", "accepted", "round-99");
  const got = repo.getProposal("prop-1");
  assert.equal(got?.status, "accepted");
  assert.equal(got?.promotedRoundId, "round-99");
  db.close();
});

test("updateProposalStatus without promotedRoundId sets it to null", () => {
  const { db, repo } = setup();
  repo.insertProposal(proposal({ promotedRoundId: "round-2" }));

  repo.updateProposalStatus("prop-1", "rejected");
  const got = repo.getProposal("prop-1");
  assert.equal(got?.status, "rejected");
  assert.equal(got?.promotedRoundId, undefined);
  db.close();
});

test("Proposal all status values round-trip", () => {
  const { db, repo } = setup();
  const statuses: ProposalRecord["status"][] = ["pending", "accepted", "rejected", "superseded"];
  for (const status of statuses) {
    const id = `prop-${status}`;
    repo.insertProposal(proposal({ id, status }));
    assert.equal(repo.getProposal(id)?.status, status);
  }
  db.close();
});

// ═══════════════════════════════════════════════════════════════
// Round mutation methods
// ═══════════════════════════════════════════════════════════════

test("updateInstanceCurrentRound changes the current_round_id on scheduler instance", () => {
  const { db, repo } = setup();

  // First create a scheduler instance so there's something to update
  repo.transaction(() => {
    repo.insertInstance(
      {
        id: "scheduler-1",
        definition: { kind: "scheduler", id: "ws", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: "round-0",
        fallbackChain: [{ type: "original-request" }],
        createdAt: Date.now(),
      },
      {},
    );
  });

  repo.updateInstanceCurrentRound("scheduler-1", "round-5");
  const inst = repo.getInstance("scheduler-1");
  assert.equal(inst?.currentRoundId, "round-5");
  db.close();
});

test("updateRoundStatus changes the status and activated_ts of a round", () => {
  const { db, repo } = setup();

  repo.insertRound({
    id: "round-1",
    schedulerInstanceId: "scheduler-1",
    sequence: 1,
    parameters: { completion: 0.7 },
    status: "proposed",
    createdAt: 1000,
  });

  repo.updateRoundStatus("round-1", "active", 2000);
  const round = repo.getRound("round-1");
  assert.equal(round?.status, "active");
  assert.equal(round?.activatedAt, 2000);
  db.close();
});

test("updateRoundStatus without activatedAt sets it to undefined", () => {
  const { db, repo } = setup();

  repo.insertRound({
    id: "round-2",
    schedulerInstanceId: "scheduler-1",
    sequence: 2,
    parameters: { completion: 0.8 },
    status: "active",
    createdAt: 1000,
    activatedAt: 1500,
  });

  repo.updateRoundStatus("round-2", "superseded");
  const round = repo.getRound("round-2");
  assert.equal(round?.status, "superseded");
  assert.equal(round?.activatedAt, undefined);
  db.close();
});

test("listRounds returns rounds for a scheduler instance ordered by sequence DESC", () => {
  const { db, repo } = setup();

  repo.insertRound({
    id: "r1", schedulerInstanceId: "sid-A", sequence: 1,
    parameters: {}, status: "active", createdAt: 1000,
  });
  repo.insertRound({
    id: "r2", schedulerInstanceId: "sid-A", sequence: 2,
    parameters: { c: 0.8 }, status: "superseded", createdAt: 2000,
  });
  repo.insertRound({
    id: "r3", schedulerInstanceId: "sid-B", sequence: 1,
    parameters: {}, status: "active", createdAt: 3000,
  });

  const list = repo.listRounds("sid-A");
  assert.equal(list.length, 2);
  // sequence DESC
  assert.equal(list[0].id, "r2");
  assert.equal(list[0].sequence, 2);
  assert.equal(list[1].id, "r1");
  assert.equal(list[1].sequence, 1);

  const empty = repo.listRounds("sid-nonexistent");
  assert.equal(empty.length, 0);
  db.close();
});

test("listRounds respects limit parameter", () => {
  const { db, repo } = setup();

  for (let i = 0; i < 5; i++) {
    repo.insertRound({
      id: `r${i}`, schedulerInstanceId: "sid-A", sequence: i,
      parameters: {}, status: "active", createdAt: 1000 + i,
    });
  }

  assert.equal(repo.listRounds("sid-A", 3).length, 3);
  assert.equal(repo.listRounds("sid-A", 10).length, 5); // capped by rows
  db.close();
});

test("listRounds returns empty array when no rounds for instance", () => {
  const { db, repo } = setup();
  assert.deepEqual(repo.listRounds("sid-nonexistent"), []);
  db.close();
});

// ═══════════════════════════════════════════════════════════════
// EventLog.query extended filters
// ═══════════════════════════════════════════════════════════════

test("EventLog query filters by schedulerInstanceId via json_extract", () => {
  const { db, log } = setupLog();
  log.append(event("e1", { identity: { traceId: "t1", schedulerInstanceId: "sid-A" } }));
  log.append(event("e2", { identity: { traceId: "t2", schedulerInstanceId: "sid-B" } }));
  log.append(event("e3", { identity: { traceId: "t3", schedulerInstanceId: "sid-A" } }));

  const results = log.query({ schedulerInstanceId: "sid-A" });
  assert.equal(results.length, 2);
  assert.equal(results[0].eventId, "e1");
  assert.equal(results[1].eventId, "e3");
  db.close();
});

test("EventLog query filters by since (ts >=)", () => {
  const { db, log } = setupLog();
  log.append(event("e1", { timestamp: 100 }));
  log.append(event("e2", { timestamp: 200 }));
  log.append(event("e3", { timestamp: 300 }));

  const results = log.query({ since: 200 });
  assert.equal(results.length, 2);
  assert.equal(results[0].eventId, "e2");
  assert.equal(results[1].eventId, "e3");
  db.close();
});

test("EventLog query filters by until (ts <)", () => {
  const { db, log } = setupLog();
  log.append(event("e1", { timestamp: 100 }));
  log.append(event("e2", { timestamp: 200 }));
  log.append(event("e3", { timestamp: 300 }));

  const results = log.query({ until: 300 });
  assert.equal(results.length, 2);
  assert.equal(results[0].eventId, "e1");
  assert.equal(results[1].eventId, "e2");
  db.close();
});

test("EventLog query combines all new filters with existing ones", () => {
  const { db, log } = setupLog();
  log.append(event("e1", { eventType: "type-A", timestamp: 100, identity: { traceId: "t1", schedulerInstanceId: "sid-A" } }));
  log.append(event("e2", { eventType: "type-A", timestamp: 200, identity: { traceId: "t2", schedulerInstanceId: "sid-A" } }));
  log.append(event("e3", { eventType: "type-A", timestamp: 300, identity: { traceId: "t3", schedulerInstanceId: "sid-B" } }));
  log.append(event("e4", { eventType: "type-B", timestamp: 150, identity: { traceId: "t4", schedulerInstanceId: "sid-A" } }));

  const results = log.query({
    eventType: "type-A",
    schedulerInstanceId: "sid-A",
    since: 100,
    until: 300,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].eventId, "e1");
  assert.equal(results[1].eventId, "e2");
  db.close();
});

test("EventLog query with no new filters is backward compatible", () => {
  const { db, log } = setupLog();
  log.append(event("e2", { eventType: "scheduler.completed", timestamp: 200 }));
  log.append(event("e1", { eventType: "scheduler.started", timestamp: 100 }));
  log.append(event("e3", { eventType: "scheduler.started", timestamp: 300, identity: { traceId: "trace-2" } }));

  assert.deepEqual(
    log.query({ traceId: "trace-1", eventType: "scheduler.started" }).map((x) => x.eventId),
    ["e1"],
  );
  db.close();
});

test("EventLog query with only since and until filters events by timestamp range", () => {
  const { db, log } = setupLog();
  log.append(event("e1", { timestamp: 100 }));
  log.append(event("e2", { timestamp: 200 }));
  log.append(event("e3", { timestamp: 300 }));
  log.append(event("e4", { timestamp: 400 }));

  const results = log.query({ since: 200, until: 400 });
  assert.equal(results.length, 2);
  assert.equal(results[0].eventId, "e2");
  assert.equal(results[1].eventId, "e3");
  db.close();
});

test("EventLog query with schedulerInstanceId but no matching events returns empty", () => {
  const { db, log } = setupLog();
  log.append(event("e1"));
  const results = log.query({ schedulerInstanceId: "nonexistent" });
  assert.equal(results.length, 0);
  db.close();
});

// ═══════════════════════════════════════════════════════════════
// transaction() nesting behavior unchanged
// ═══════════════════════════════════════════════════════════════

test("transaction() still throws on nested transaction", () => {
  const { db, repo } = setup();
  assert.throws(() => {
    repo.transaction(() => {
      repo.transaction(() => {
        repo.insertOptimizerInstance(optInstance());
      });
    });
  }, /nested core transaction is not supported/);
  db.close();
});

test("transaction() commits new methods on success", () => {
  const { db, repo } = setup();
  repo.transaction(() => {
    repo.insertOptimizerInstance(optInstance());
    repo.insertProposal(proposal());
  });
  assert.ok(repo.getOptimizerInstance("opt-1"));
  assert.ok(repo.getProposal("prop-1"));
  db.close();
});

test("transaction() rolls back new methods on error", () => {
  const { db, repo } = setup();
  assert.throws(() => {
    repo.transaction(() => {
      repo.insertOptimizerInstance(optInstance());
      repo.insertProposal(proposal());
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(repo.getOptimizerInstance("opt-1"), undefined);
  assert.equal(repo.getProposal("prop-1"), undefined);
  db.close();
});

// ═══════════════════════════════════════════════════════════════
// Existing methods unmodified
// ═══════════════════════════════════════════════════════════════

test("existing getInstance / listInstances / getRound still work after schema extension", () => {
  const { db, repo } = setup();
  // Insert a scheduler instance + round
  repo.transaction(() => {
    repo.insertInstance(
      {
        id: "sid-1",
        definition: { kind: "scheduler", id: "ws", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: "round-0",
        fallbackChain: [{ type: "original-request" }],
        createdAt: Date.now(),
      },
      {},
    );
    repo.insertRound({
      id: "round-0",
      schedulerInstanceId: "sid-1",
      sequence: 0,
      parameters: { completion: 0.7 },
      status: "active",
      createdAt: Date.now(),
    });
  });

  const inst = repo.getInstance("sid-1");
  assert.ok(inst);
  assert.equal(inst.status, "active");

  const list = repo.listInstances();
  assert.equal(list.length, 1);

  const round = repo.getRound("round-0");
  assert.ok(round);
  assert.deepEqual(round.parameters, { completion: 0.7 });
  db.close();
});

test("schema is additive: legacy tables still work after extension", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, role TEXT NOT NULL)");
  new CoreRepository(db);
  new EventLog(db);
  db.prepare("INSERT INTO runs (role) VALUES (?)").run("worker");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);
  db.close();
});
