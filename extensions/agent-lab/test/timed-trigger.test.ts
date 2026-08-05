import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  TimedTrigger,
  ScheduledJobsStore,
  computeNextFireAt,
  nextCronFire,
} from "../src/scheduler/timed-trigger.ts";
import type { DispatchRequest, DispatchResult } from "../src/scheduler/runner.ts";
import type { LabEvent } from "../src/core/contracts.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

function completedResult(): DispatchResult {
  return {
    status: "completed",
    schedulerInstanceId: "inst-1",
    roundId: "round-1",
    attempts: [],
  };
}

function memoryStore(): { db: DatabaseSync; store: ScheduledJobsStore } {
  const db = new DatabaseSync(":memory:");
  return { db, store: new ScheduledJobsStore(db) };
}

function makeTrigger(opts: {
  store: ScheduledJobsStore;
  dispatch?: (req: DispatchRequest) => Promise<DispatchResult>;
  now?: () => number;
  audits?: LabEvent[];
}) {
  const audits = opts.audits ?? [];
  return new TimedTrigger({
    store: opts.store,
    dispatch:
      opts.dispatch ??
      (async () => {
        return completedResult();
      }),
    appendEvent: (e) => {
      audits.push(e);
      return "inserted";
    },
    now: opts.now ?? (() => 10_000),
  });
}

// ── CRUD ─────────────────────────────────────────────────────────────

test("scheduled job CRUD: create/get/list/remove with tenant+status filters", () => {
  const { db, store } = memoryStore();
  store.create({
    id: "j1",
    tenantId: "t1",
    taskType: "weekly-report",
    scheduleKind: "interval",
    scheduleSpec: "60000",
    payload: { report: "x" },
    status: "active",
    nextFireAt: 1000,
    createdBy: "alice",
    legalRef: "L-1",
  });
  store.create({
    id: "j2",
    tenantId: "t2",
    taskType: "other",
    scheduleKind: "interval",
    scheduleSpec: "60000",
    payload: {},
    status: "paused",
    nextFireAt: 2000,
    createdBy: "bob",
  });

  const got = store.get("j1");
  assert.equal(got?.tenantId, "t1");
  assert.equal(got?.taskType, "weekly-report");
  assert.equal(got?.scheduleKind, "interval");
  assert.deepEqual(got?.payload, { report: "x" });
  assert.equal(got?.legalRef, "L-1");
  assert.equal(got?.fireCount, 0);
  assert.equal(got?.lastFireAt, null);

  // tenant isolation
  assert.deepEqual(store.list({ tenantId: "t1" }).map((j) => j.id), ["j1"]);
  assert.deepEqual(store.list({ tenantId: "t2" }).map((j) => j.id), ["j2"]);
  assert.deepEqual(store.list({ tenantId: "nope" }).map((j) => j.id), []);

  // status filter
  assert.deepEqual(store.list({ status: "paused" }).map((j) => j.id), ["j2"]);
  // no filter → all
  assert.equal(store.list().length, 2);

  store.remove("j1");
  assert.equal(store.get("j1"), undefined);
  db.close();
});

test("create rejects malformed schedule specs per scheduleKind", () => {
  const { db, store } = memoryStore();
  const base = {
    tenantId: "t1",
    taskType: "task",
    payload: {},
    status: "active" as const,
    nextFireAt: 1000,
    createdBy: "alice",
  };
  assert.throws(
    () => store.create({ ...base, id: "a", scheduleKind: "interval", scheduleSpec: "abc" }),
    /interval/,
  );
  assert.throws(
    () => store.create({ ...base, id: "b", scheduleKind: "at", scheduleSpec: "not-a-date" }),
    /at/,
  );
  assert.throws(
    () => store.create({ ...base, id: "c", scheduleKind: "cron", scheduleSpec: "0 0" }),
    /5 fields/,
  );
  // valid specs do not throw
  store.create({ ...base, id: "d", scheduleKind: "interval", scheduleSpec: "5000" });
  store.create({ ...base, id: "e", scheduleKind: "at", scheduleSpec: "2026-08-06T00:00:00Z" });
  store.create({ ...base, id: "f", scheduleKind: "cron", scheduleSpec: "*/15 9 * * 1-5" });
  db.close();
});

// ── nextFireAt computation ───────────────────────────────────────────

test("computeNextFireAt: interval adds period, at parses ISO, cron advances", () => {
  assert.equal(computeNextFireAt("interval", "5000", 1000), 6000);
  assert.equal(
    computeNextFireAt("at", "2026-08-06T00:00:00Z", 0),
    Date.parse("2026-08-06T00:00:00Z"),
  );
  const from = new Date(2026, 7, 5, 10, 30, 0).getTime();
  assert.equal(
    computeNextFireAt("cron", "15 * * * *", from),
    new Date(2026, 7, 5, 11, 15, 0).getTime(),
  );
});

test("nextCronFire handles step/list/range and day-of-week", () => {
  const from = new Date(2026, 7, 5, 10, 30, 0).getTime(); // Wednesday
  // every 10 minutes
  assert.equal(
    nextCronFire("*/10 * * * *", from),
    new Date(2026, 7, 5, 10, 40, 0).getTime(),
  );
  // every 30 minutes → next at :30 already passed, jump to 11:00
  assert.equal(
    nextCronFire("0,30 * * * *", from),
    new Date(2026, 7, 5, 11, 0, 0).getTime(),
  );
  // next Monday 09:00
  assert.equal(
    nextCronFire("0 9 * * 1", from),
    new Date(2026, 7, 10, 9, 0, 0).getTime(),
  );
  // month range: next fire in September
  assert.equal(
    nextCronFire("0 0 1 9 *", from),
    new Date(2026, 8, 1, 0, 0, 0).getTime(),
  );
  // 09:00 on the 1st OR Mondays (dom/dow OR semantics)
  assert.equal(
    nextCronFire("0 9 1 * 1", from),
    new Date(2026, 7, 10, 9, 0, 0).getTime(), // next Monday comes before next month's 1st
  );
});

// ── Fire + bookkeeping ───────────────────────────────────────────────

test("scanDue fires due interval jobs once and advances nextFireAt", async () => {
  const { db, store } = memoryStore();
  const now = 10_000;
  store.create({
    id: "j1",
    tenantId: "t1",
    taskType: "weekly-report",
    scheduleKind: "interval",
    scheduleSpec: "60000",
    payload: { report: "x" },
    status: "active",
    nextFireAt: now - 1,
    createdBy: "alice",
  });
  const calls: DispatchRequest[] = [];
  const audits: LabEvent[] = [];
  const trigger = makeTrigger({
    store,
    dispatch: async (req) => {
      calls.push(req);
      return completedResult();
    },
    now: () => now,
    audits,
  });

  assert.equal(await trigger.scanDue(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "weekly-report");
  assert.equal(calls[0].task, JSON.stringify({ report: "x" }));
  assert.equal(calls[0].labels?.tenantId, "t1");
  assert.equal(calls[0].caller, "timed-trigger");
  assert.match(calls[0].traceId, /^scheduled:j1:/);

  const job = store.get("j1")!;
  assert.equal(job.fireCount, 1);
  assert.equal(job.lastFireAt, now);
  assert.equal(job.nextFireAt, now + 60_000);
  assert.equal(job.status, "active");

  const fireAudit = audits.find((a) => a.eventType === "scheduled.fire");
  assert.ok(fireAudit);
  assert.equal((fireAudit!.payload as { jobId: string }).jobId, "j1");
  assert.equal((fireAudit!.payload as { dispatchStatus: string }).dispatchStatus, "completed");

  // Not due again (nextFireAt advanced past now)
  assert.equal(await trigger.scanDue(), 0);
  assert.equal(calls.length, 1);
  db.close();
});

test("at jobs become done after a single fire", async () => {
  const { db, store } = memoryStore();
  const now = 20_000;
  store.create({
    id: "j-at",
    tenantId: "t1",
    taskType: "one-shot",
    scheduleKind: "at",
    scheduleSpec: new Date(now).toISOString(),
    payload: {},
    status: "active",
    nextFireAt: now,
    createdBy: "alice",
  });
  const trigger = makeTrigger({ store, now: () => now });
  assert.equal(await trigger.scanDue(), 1);
  const job = store.get("j-at")!;
  assert.equal(job.status, "done");
  assert.equal(job.fireCount, 1);
  assert.equal(await trigger.scanDue(), 0);
  db.close();
});

test("missed-fire: overdue job fires exactly once on recovery then reschedules forward", async () => {
  const { db, store } = memoryStore();
  const now = 50_000;
  store.create({
    id: "j-missed",
    tenantId: "t1",
    taskType: "beat",
    scheduleKind: "interval",
    scheduleSpec: "10000",
    payload: {},
    status: "active",
    nextFireAt: 10_000, // was due at 10s, missed until now (50s)
    createdBy: "alice",
  });
  let fired = 0;
  const trigger = makeTrigger({
    store,
    dispatch: async () => {
      fired++;
      return completedResult();
    },
    now: () => now,
  });
  assert.equal(await trigger.scanDue(), 1);
  assert.equal(fired, 1); // 补火一次 — no replay of the 4 missed periods
  const job = store.get("j-missed")!;
  assert.equal(job.fireCount, 1);
  assert.equal(job.nextFireAt, now + 10_000);
  assert.equal(await trigger.scanDue(), 0);
  assert.equal(fired, 1);
  db.close();
});

test("cron jobs fire and reschedule to the next cron minute", async () => {
  const { db, store } = memoryStore();
  const now = new Date(2026, 7, 5, 9, 30, 0).getTime();
  store.create({
    id: "j-cron",
    tenantId: "t1",
    taskType: "daily-digest",
    scheduleKind: "cron",
    scheduleSpec: "45 9 * * *",
    payload: { kind: "digest" },
    status: "active",
    nextFireAt: now,
    createdBy: "alice",
  });
  const trigger = makeTrigger({ store, now: () => now });
  assert.equal(await trigger.scanDue(), 1);
  const job = store.get("j-cron")!;
  assert.equal(job.fireCount, 1);
  // 09:30 触发后 → 下一次 09:45 仍在当日
  assert.equal(job.nextFireAt, new Date(2026, 7, 5, 9, 45, 0).getTime());
  db.close();
});

test("tenantId isolation: due scan processes each tenant's jobs independently", async () => {
  const { db, store } = memoryStore();
  const now = 30_000;
  store.create({
    id: "j-t1",
    tenantId: "t1",
    taskType: "task-a",
    scheduleKind: "interval",
    scheduleSpec: "1000",
    payload: {},
    status: "active",
    nextFireAt: now,
    createdBy: "a",
  });
  store.create({
    id: "j-t2",
    tenantId: "t2",
    taskType: "task-b",
    scheduleKind: "interval",
    scheduleSpec: "1000",
    payload: {},
    status: "active",
    nextFireAt: now,
    createdBy: "b",
  });
  const calls: DispatchRequest[] = [];
  const trigger = makeTrigger({
    store,
    dispatch: async (req) => {
      calls.push(req);
      return completedResult();
    },
    now: () => now,
  });
  assert.equal(await trigger.scanDue(), 2);
  assert.deepEqual(
    calls.map((c) => [c.labels?.tenantId, c.role]).sort(),
    [
      ["t1", "task-a"],
      ["t2", "task-b"],
    ],
  );
  db.close();
});

test("dispatch failure does not crash the scan; job still reschedules and audits error", async () => {
  const { db, store } = memoryStore();
  const now = 40_000;
  store.create({
    id: "j-err",
    tenantId: "t1",
    taskType: "task",
    scheduleKind: "interval",
    scheduleSpec: "5000",
    payload: {},
    status: "active",
    nextFireAt: now,
    createdBy: "alice",
  });
  const audits: LabEvent[] = [];
  const trigger = makeTrigger({
    store,
    dispatch: async () => {
      throw new Error("dispatch boom");
    },
    now: () => now,
    audits,
  });
  assert.equal(await trigger.scanDue(), 1); // still counted as fired (bookkeeping proceeds)
  const job = store.get("j-err")!;
  assert.equal(job.fireCount, 1);
  assert.equal(job.status, "active");
  assert.equal(job.nextFireAt, now + 5000);
  assert.ok(audits.find((a) => a.eventType === "scheduled.error"));
  db.close();
});

test("start/stop lifecycle is idempotent and does not hold the event loop open", async () => {
  const { db, store } = memoryStore();
  const trigger = makeTrigger({ store });
  trigger.start();
  trigger.start(); // second start is a no-op
  assert.equal(trigger.isRunning(), true);
  trigger.stop();
  trigger.stop();
  assert.equal(trigger.isRunning(), false);
  trigger.start();
  trigger.stop();
  db.close();
});
