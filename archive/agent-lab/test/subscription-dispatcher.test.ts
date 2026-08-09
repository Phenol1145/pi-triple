import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventLog } from "../src/core/events/event-log.ts";
import {
  SubscriptionStore,
  SubscriptionDispatcher,
  matchesPattern,
} from "../src/core/events/subscription-dispatcher.ts";
import type { DispatchRequest } from "../src/scheduler/runner.ts";
import type { LabEvent } from "../src/core/contracts.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeEvent(
  id: string,
  eventType = "order.created",
  payload: unknown = { region: "cn", amount: 1 },
): LabEvent {
  return {
    eventId: id,
    eventType,
    schemaVersion: "1",
    timestamp: 100,
    sequence: 1,
    identity: { traceId: `trace-${id}` },
    payload,
    metrics: { durationMs: 1 },
    artifactRefs: [],
  };
}

function memoryStore(): { db: DatabaseSync; store: SubscriptionStore } {
  const db = new DatabaseSync(":memory:");
  return { db, store: new SubscriptionStore(db) };
}

// ── CRUD ─────────────────────────────────────────────────────────────

test("subscription CRUD: create/get/list/remove with tenant+status filters", () => {
  const { db, store } = memoryStore();
  store.create({
    id: "s1",
    tenantId: "t1",
    eventPattern: { eventType: "order.created", filter: { region: "cn" } },
    taskType: "notify-cn",
    payload: { channel: "sms" },
    status: "active",
    createdBy: "alice",
  });
  store.create({
    id: "s2",
    tenantId: "t2",
    eventPattern: { eventType: "order.created" },
    taskType: "notify-all",
    payload: {},
    status: "paused",
    createdBy: "bob",
  });

  const got = store.get("s1")!;
  assert.equal(got.tenantId, "t1");
  assert.deepEqual(got.eventPattern, { eventType: "order.created", filter: { region: "cn" } });
  assert.equal(got.taskType, "notify-cn");
  assert.equal(got.status, "active");

  // tenant isolation
  assert.deepEqual(store.list({ tenantId: "t1" }).map((s) => s.id), ["s1"]);
  assert.deepEqual(store.list({ tenantId: "t2" }).map((s) => s.id), ["s2"]);
  assert.deepEqual(store.list({ tenantId: "nope" }).map((s) => s.id), []);
  assert.equal(store.list().length, 2);

  // status filter + active listing
  assert.deepEqual(store.list({ status: "paused" }).map((s) => s.id), ["s2"]);
  assert.deepEqual(store.listActive().map((s) => s.id), ["s1"]);

  store.remove("s1");
  assert.equal(store.get("s1"), undefined);
  db.close();
});

test("subscription create rejects malformed pattern and invalid status", () => {
  const { db, store } = memoryStore();
  const base = { tenantId: "t1", taskType: "x", payload: {}, createdBy: "alice" };
  assert.throws(
    () => store.create({ ...base, id: "a", status: "active", eventPattern: { filter: {} } as never }),
    /eventType/,
  );
  assert.throws(
    () => store.create({ ...base, id: "b", status: "weird" as never, eventPattern: { eventType: "e" } }),
    /status/,
  );
  db.close();
});

// ── Matching ─────────────────────────────────────────────────────────

test("matchesPattern: eventType exact + filter deep-equal against payload", () => {
  const event = makeEvent("e1", "order.created", { region: "cn", amount: 1 });
  assert.equal(matchesPattern({ eventType: "order.created" }, event), true);
  assert.equal(matchesPattern({ eventType: "order.created", filter: { region: "cn" } }, event), true);
  assert.equal(matchesPattern({ eventType: "order.created", filter: { region: "us" } }, event), false);
  assert.equal(matchesPattern({ eventType: "other.event" }, event), false);
  // filter against nested payload value
  assert.equal(
    matchesPattern({ eventType: "order.created", filter: { detail: { priority: 1 } } },
      makeEvent("e2", "order.created", { detail: { priority: 1 } })),
    true,
  );
});

// ── Dispatch ─────────────────────────────────────────────────────────

test("handleEvent matches eventType+filter and dispatches with tenant labels + task template", async () => {
  const { db, store } = memoryStore();
  store.create({
    id: "s1",
    tenantId: "t1",
    eventPattern: { eventType: "order.created", filter: { region: "cn" } },
    taskType: "notify-cn",
    payload: { channel: "sms" },
    status: "active",
    createdBy: "alice",
  });
  store.create({
    id: "s2",
    tenantId: "t2",
    eventPattern: { eventType: "order.created", filter: { region: "us" } },
    taskType: "notify-us",
    payload: {},
    status: "active",
    createdBy: "bob",
  });
  store.create({
    id: "s3",
    tenantId: "t1",
    eventPattern: { eventType: "unrelated.event" },
    taskType: "ignore",
    payload: {},
    status: "active",
    createdBy: "alice",
  });
  store.create({
    id: "s4",
    tenantId: "t1",
    eventPattern: { eventType: "order.created" },
    taskType: "paused-sub",
    payload: {},
    status: "paused", // paused → not dispatched
    createdBy: "alice",
  });

  const calls: DispatchRequest[] = [];
  const dispatcher = new SubscriptionDispatcher({
    store,
    dispatch: async (req) => {
      calls.push(req);
      return { status: "completed" };
    },
    appendEvent: () => "inserted",
  });

  await dispatcher.handleEvent(makeEvent("e1", "order.created", { region: "cn", amount: 2 }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "notify-cn");
  assert.equal(calls[0].taskCategory, "event");
  assert.equal(calls[0].labels?.tenantId, "t1");
  assert.equal(calls[0].labels?.subscriptionId, "s1");
  assert.match(calls[0].traceId, /^event:e1/);
  const task = JSON.parse(calls[0].task) as Record<string, unknown>;
  assert.equal(task.channel, "sms"); // payload template preserved
  assert.deepEqual(task.event, {
    eventId: "e1",
    eventType: "order.created",
    payload: { region: "cn", amount: 2 },
    traceId: "trace-e1",
  });
  db.close();
});

test("in-memory callback registry fires for every event, unsubscribe works", async () => {
  const { db, store } = memoryStore();
  const dispatcher = new SubscriptionDispatcher({
    store,
    dispatch: async () => "ok",
    appendEvent: () => "inserted",
  });
  const received: string[] = [];
  const off = dispatcher.subscribeCallback((ev) => received.push(ev.eventId));
  await dispatcher.handleEvent(makeEvent("e1"));
  assert.deepEqual(received, ["e1"]);
  off();
  await dispatcher.handleEvent(makeEvent("e2"));
  assert.deepEqual(received, ["e1"]);
  db.close();
});

// ── Failure isolation (评审 I4) ───────────────────────────────────────

test("dispatcher dispatch failure: logged+audited, handleEvent does not reject, next event still processed", async () => {
  const { db, store } = memoryStore();
  store.create({
    id: "s1",
    tenantId: "t1",
    eventPattern: { eventType: "order.created" },
    taskType: "notify",
    payload: {},
    status: "active",
    createdBy: "alice",
  });
  const audits: LabEvent[] = [];
  let calls = 0;
  const dispatcher = new SubscriptionDispatcher({
    store,
    dispatch: async () => {
      calls++;
      if (calls === 1) throw new Error("dispatch boom");
      return "ok";
    },
    appendEvent: (e) => {
      audits.push(e);
      return "inserted";
    },
  });
  await assert.doesNotReject(dispatcher.handleEvent(makeEvent("e1")));
  const failed = audits.find((a) => a.eventType === "subscription.dispatch.failed");
  assert.ok(failed, "audit event for dispatch failure present");
  // subscription still active → next event processed
  await assert.doesNotReject(dispatcher.handleEvent(makeEvent("e2")));
  assert.equal(calls, 2);
  db.close();
});

// ── EventLog integration: append-only 语义不变 + 旁路通知 ─────────────

test("EventLog append-only semantics unchanged with dispatcher wired as onAppended hook", async () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  const store = new SubscriptionStore(db);
  store.create({
    id: "s1",
    tenantId: "t1",
    eventPattern: { eventType: "order.created" },
    taskType: "notify",
    payload: {},
    status: "active",
    createdBy: "alice",
  });
  const calls: DispatchRequest[] = [];
  const dispatcher = new SubscriptionDispatcher({
    store,
    dispatch: async (req) => {
      calls.push(req);
      return "ok";
    },
    appendEvent: (e) => log.append(e),
  });
  log.onAppended((event) => {
    void dispatcher.handleEvent(event);
  });

  // append 主路径返回值不变
  assert.equal(log.append(makeEvent("e1")), "inserted");
  assert.equal(log.append(makeEvent("e1")), "duplicate"); // 幂等语义不变
  assert.deepEqual(log.get("e1"), makeEvent("e1"));

  // 旁路派发触发（异步 fire-and-forget，轮询等待）
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].labels?.subscriptionId, "s1");
  db.close();
});

test("a throwing onAppended hook does not block append and records an audit event", async () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  log.onAppended(() => {
    throw new Error("hook boom");
  });
  // append 不阻断
  assert.equal(log.append(makeEvent("e1")), "inserted");
  assert.deepEqual(log.get("e1"), makeEvent("e1"));
  // 审计事件（自身也不阻断、不递归）
  const failed = log.query({ eventType: "subscription.notify.failed" });
  assert.equal(failed.length, 1);
  // 后续事件仍可 append
  assert.equal(log.append(makeEvent("e2")), "inserted");
  db.close();
});

test("onAppended disposer removes the hook", async () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  const seen: string[] = [];
  const off = log.onAppended((ev) => seen.push(ev.eventId));
  log.append(makeEvent("e1"));
  off();
  log.append(makeEvent("e2"));
  assert.deepEqual(seen, ["e1"]);
  db.close();
});
