import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventLog } from "../src/core/events/event-log.ts";
import type { LabEvent } from "../src/core/contracts.ts";

function event(id: string, type = "scheduler.started", traceId = "trace-1"): LabEvent {
  return {
    eventId: id,
    eventType: type,
    schemaVersion: "1",
    timestamp: 100,
    sequence: 1,
    identity: { traceId, schedulerInstanceId: "scheduler-1" },
    payload: { answer: 42 },
    metrics: { durationMs: 12 },
    artifactRefs: ["artifact-1"],
  };
}

test("EventLog appends and reads an event without losing envelope fields", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  assert.equal(log.append(event("e1")), "inserted");
  assert.deepEqual(log.get("e1"), event("e1"));
  db.close();
});

test("EventLog treats repeated eventId as an idempotent duplicate", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  assert.equal(log.append(event("e1")), "inserted");
  assert.equal(log.append(event("e1")), "duplicate");
  assert.equal(log.query({ traceId: "trace-1" }).length, 1);
  db.close();
});

test("EventLog rejects conflicting payload reuse for the same eventId", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  log.append(event("e1"));
  const conflict = event("e1");
  conflict.payload = { answer: 7 };
  assert.throws(() => log.append(conflict), /event id conflict/);
  db.close();
});

test("EventLog queries deterministically by trace and type", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  log.append(event("e2", "scheduler.completed"));
  log.append(event("e1", "scheduler.started"));
  log.append(event("e3", "scheduler.started", "trace-2"));
  assert.deepEqual(log.query({ traceId: "trace-1", eventType: "scheduler.started" }).map((x) => x.eventId), ["e1"]);
  db.close();
});
