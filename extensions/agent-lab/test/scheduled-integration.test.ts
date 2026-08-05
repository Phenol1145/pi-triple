/**
 * test/scheduled-integration.test.ts — F/WP5 Task 28 定时/事件管理面 + 常驻会话接线
 *
 * 覆盖：
 *  - /lab schedule add/ls/pause/resume/rm 命令（registerCommands + 真实 ScheduledJobsStore）
 *  - system-events 接线：外部事件（EXTERNAL_EVENT_CHANNEL）→ EventLog → 订阅派发器 → dispatch
 *  - observe RPC（OBSERVE_EVENTS_REQUEST → 查询 EventLog → 回响应通道）
 *  - component-bound 注册进框架层 ComponentBindingRegistry（Task 28c 接线子项）
 *  - 建定时 job → 到点 dispatch（时间压缩：scanDue 直驱）→ 审计事件断言
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  registerCommands,
  renderScheduleList,
  renderScheduleJobCreated,
} from "../src/commands/register.ts";
import { ScheduledJobsStore, TimedTrigger } from "../src/scheduler/timed-trigger.ts";
import { SubscriptionStore } from "../src/core/events/subscription-dispatcher.ts";
import { createLabCore } from "../src/core/create-core.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  wireSystemEvents,
  EXTERNAL_EVENT_CHANNEL,
  OBSERVE_EVENTS_REQUEST_CHANNEL,
  OBSERVE_EVENTS_RESPONSE_CHANNEL,
  COMPONENT_BOUND_CHANNEL,
} from "../src/federation/system-events.ts";
import type { DispatchRequest, DispatchResult } from "../src/scheduler/runner.ts";

// ── mock pi / ctx（命令测试用） ─────────────────────────────────────

interface NotifyCall {
  message: string;
  level: string;
}

function mockPi() {
  const notifies: NotifyCall[] = [];
  let handler: ((args: string, ctx: any) => void | Promise<void>) | undefined;
  return {
    notifies,
    pi: {
      registerCommand(_name: string, opts: { handler: typeof handler }) {
        handler = opts.handler;
      },
      registerTool(_opts: unknown) {},
    },
    ctx() {
      return {
        ui: {
          notify(msg: string, level: string) {
            notifies.push({ message: msg, level });
          },
        },
      };
    },
    run(args: string) {
      return handler!(args, this.ctx());
    },
  };
}

function defaultCfg(): any {
  return {
    weights: { completion: 1, costEffectiveness: 1, performance: 1, benchmark: 1 },
    autoApply: false,
    acceptanceScoreMap: {},
    interruptedPenalty: 0,
    toolFailPenalty: 0,
    topN: 5,
    catalogTtlMs: 60000,
    mode: "classic",
    market: {
      endowment: { K: 100, floor: 10 },
      odds: { easy: 1.5, medium: 2.0, hard: 2.5 },
      settlement: { tax: 0.1, errorMode: "stakeOnly" },
      cost: { tokenMult: 1, toolMult: 1, latencyMult: 1, resourceFactor: 1, toolWeights: {} },
      bidding: { timeoutMs: 5000, promptTemplate: "", maxCallsPerDispatch: 2 },
      market: { staleTaskTimeoutMs: 60000, eligibility: "all", maxBidders: 10, bidderSelector: "topBalance" },
      risk: { maxStakeRatio: 0.5 },
    },
    optimizer: {},
  };
}

function completedResult(): DispatchResult {
  return { status: "completed", schedulerInstanceId: "inst-1", roundId: "round-1", attempts: [] };
}

function makeDeps(overrides: Partial<Parameters<typeof registerCommands>[1]> = {}) {
  return {
    store: {
      aggregateByRole: () => [],
      listRoles: () => [],
      appendRun: () => {},
      getPin: () => undefined,
      setPin: () => {},
      clearPin: () => {},
    },
    catalog: { candidates: () => [], isFresh: true, refresh: async () => {} },
    cfg: defaultCfg(),
    ledger: {} as any,
    saveConfig: () => {},
    ...overrides,
  } as Parameters<typeof registerCommands>[1];
}

// ── /lab schedule 命令 ───────────────────────────────────────────────

test("/lab schedule: add creates job with computed nextFireAt, ls/pause/resume/rm operate on it", async () => {
  const db = new DatabaseSync(":memory:");
  const jobs = new ScheduledJobsStore(db);
  const m = mockPi();
  registerCommands(m.pi, makeDeps({ scheduledJobs: () => jobs }));
  const prevEnv = process.env.PI_TEMPLATE;
  process.env.PI_TEMPLATE = "tenant-x";

  try {
    // add interval job
    await m.run("schedule add weekly-report interval 60000 {\"report\":\"x\"}");
    assert.equal(m.notifies.length, 1);
    assert.match(m.notifies[0].message, /已创建定时任务/);
    assert.match(m.notifies[0].message, /interval/);
    const all = jobs.list({ tenantId: "tenant-x" });
    assert.equal(all.length, 1);
    const job = all[0]!;
    assert.equal(job.taskType, "weekly-report");
    assert.equal(job.scheduleKind, "interval");
    assert.equal(job.scheduleSpec, "60000");
    assert.deepEqual(job.payload, { report: "x" });
    assert.equal(job.tenantId, "tenant-x");
    assert.ok(job.nextFireAt > Date.now());

    // ls
    m.notifies.length = 0;
    await m.run("schedule ls");
    assert.equal(m.notifies.length, 1);
    assert.match(m.notifies[0].message, /weekly-report/);
    assert.match(m.notifies[0].message, new RegExp(job.id.slice(0, 8)));

    // pause / resume
    await m.run(`schedule pause ${job.id}`);
    assert.equal(jobs.get(job.id)!.status, "paused");
    await m.run(`schedule resume ${job.id}`);
    assert.equal(jobs.get(job.id)!.status, "active");

    // add 非法 spec → error
    m.notifies.length = 0;
    await m.run("schedule add bad interval not-a-number");
    assert.match(m.notifies[0]!.message, /调度表达式无效|interval/);

    // rm
    await m.run(`schedule rm ${job.id}`);
    assert.equal(jobs.get(job.id), undefined);
  } finally {
    if (prevEnv === undefined) delete process.env.PI_TEMPLATE;
    else process.env.PI_TEMPLATE = prevEnv;
    db.close();
  }
});

test("/lab schedule: malformed payload rejected; missing args usage", async () => {
  const db = new DatabaseSync(":memory:");
  const jobs = new ScheduledJobsStore(db);
  const m = mockPi();
  registerCommands(m.pi, makeDeps({ scheduledJobs: () => jobs }));
  await m.run("schedule add t interval 1000 not-json");
  assert.match(m.notifies[0]!.message, /JSON/);
  m.notifies.length = 0;
  await m.run("schedule add t");
  assert.match(m.notifies[0]!.message, /用法/);
  m.notifies.length = 0;
  await m.run("schedule pause nope");
  assert.match(m.notifies[0]!.message, /未找到/);
  db.close();
});

test("render helpers produce stable output", () => {
  const view = {
    id: "job-abc",
    tenantId: "t1",
    taskType: "daily",
    scheduleKind: "cron",
    scheduleSpec: "0 9 * * *",
    status: "active",
    nextFireAt: 1720000000000,
    lastFireAt: null,
    fireCount: 0,
    createdBy: "lab-schedule",
  };
  assert.match(renderScheduleList([view]), /daily/);
  assert.match(renderScheduleJobCreated(view), /job-abc/);
});

// ── system-events 接线（Task 27/28 通道） ────────────────────────────

function wireDeps() {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db);
  const bus = createEventBus();
  const dispatched: DispatchRequest[] = [];
  const pi = { events: bus };
  const handle = wireSystemEvents({
    pi: pi as any,
    ensureCore: async () => core,
    getRunner: () =>
      ({
        dispatch: async (req: DispatchRequest) => {
          dispatched.push(req);
          return completedResult();
        },
      }) as any,
    db,
    now: () => 100_000,
  });
  return { db, core, bus, dispatched, handle };
}

test("external event → EventLog append → subscription dispatcher → dispatch", async () => {
  const { db, core, bus, dispatched, handle } = wireDeps();
  try {
    // 建订阅：eventType=order.created + filter region=cn
    const subs = new SubscriptionStore(db);
    subs.create({
      id: "s1",
      tenantId: "t1",
      eventPattern: { eventType: "order.created", filter: { region: "cn" } },
      taskType: "notify-cn",
      payload: { channel: "sms" },
      status: "active",
      createdBy: "test",
    });

    // 启动接线（core 就绪 → onAppended → dispatcher）
    await handle.start();
    assert.ok(handle.dispatcher);

    // 经总线投递外部事件（模拟 pth emitExternalEvent）
    bus.emit(EXTERNAL_EVENT_CHANNEL, {
      eventId: "e-1",
      eventType: "order.created",
      payload: { region: "cn", amount: 1 },
      source: "shop",
      tenantId: "t1",
      receivedAt: 100_000,
    });

    // 事件落 EventLog（append-only 不变量）+ 订阅匹配派发
    await new Promise((r) => setTimeout(r, 20)); // 等接线微任务完成
    const evt = core.events.get("e-1");
    assert.ok(evt, "external event appended to EventLog");
    assert.equal(evt!.eventType, "order.created");

    // dispatch 异步——等一拍
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.role, "notify-cn");
    assert.equal(dispatched[0]!.labels?.tenantId, "t1");
    assert.equal(dispatched[0]!.labels?.subscriptionId, "s1");
    assert.match(dispatched[0]!.task, /order.created/);
    assert.equal(dispatched[0]!.caller, "subscription-dispatcher");
  } finally {
    handle.dispose();
    db.close();
  }
});

test("external event: 无匹配订阅 → EventLog 落库但不 dispatch", async () => {
  const { db, core, bus, dispatched, handle } = wireDeps();
  try {
    await handle.start();
    bus.emit(EXTERNAL_EVENT_CHANNEL, {
      eventId: "e-2",
      eventType: "other.event",
      payload: {},
      tenantId: "t9",
      receivedAt: 100_000,
    });
    await new Promise((r) => setTimeout(r, 20)); // 等接线微任务完成
    assert.ok(core.events.get("e-2"));
    assert.equal(dispatched.length, 0);
  } finally {
    handle.dispose();
    db.close();
  }
});

test("external event: malformed（无 eventType）→ 忽略不崩溃", async () => {
  const { db, bus, handle } = wireDeps();
  try {
    await handle.start();
    bus.emit(EXTERNAL_EVENT_CHANNEL, { payload: {} });
    bus.emit(EXTERNAL_EVENT_CHANNEL, null);
    assert.ok(true);
  } finally {
    handle.dispose();
    db.close();
  }
});

test("observe RPC: request → EventLog query → response channel（requestId 关联）", async () => {
  const { db, core, bus, handle } = wireDeps();
  try {
    // 预置事件
    core.events.append({
      eventId: "ev-a",
      eventType: "scheduled.fire",
      schemaVersion: "1",
      timestamp: 100,
      identity: { traceId: "t1" },
      payload: { jobId: "j1" },
    });
    await handle.start();

    // 模拟 pth 侧 querySystemEvents：监听响应通道 → 发请求
    const responses: any[] = [];
    const off = bus.on(OBSERVE_EVENTS_RESPONSE_CHANNEL, (data) => responses.push(data));
    bus.emit(OBSERVE_EVENTS_REQUEST_CHANNEL, { requestId: "req-1", filter: { eventType: "scheduled.fire" } });

    await new Promise((r) => setTimeout(r, 20));
    off();
    assert.equal(responses.length, 1);
    assert.equal(responses[0].requestId, "req-1");
    assert.equal(responses[0].events.length, 1);
    assert.equal(responses[0].events[0].eventId, "ev-a");
  } finally {
    handle.dispose();
    db.close();
  }
});

test("component-bound → 注册进框架层 ComponentBindingRegistry（Task 28c）", async () => {
  const { db, bus, handle } = wireDeps();
  try {
    await handle.start();
    bus.emit(COMPONENT_BOUND_CHANNEL, {
      slotId: "slot-sched-1",
      type: "scheduler",
      name: "my-scheduler",
      version: 3,
      tenantId: "t1",
    });
    const binding = handle.registry.get("slot-sched-1");
    assert.ok(binding, "bound component registered in framework-layer registry");
    assert.equal(binding!.type, "scheduler");
    assert.equal(binding!.name, "my-scheduler");
    assert.equal(binding!.version, 3);
    assert.equal(handle.registry.list().length, 1);
  } finally {
    handle.dispose();
    db.close();
  }
});

test("component-bound: 缺 slotId → 忽略", async () => {
  const { db, bus, handle } = wireDeps();
  try {
    bus.emit(COMPONENT_BOUND_CHANNEL, { type: "optimizer" });
    assert.equal(handle.registry.list().length, 0);
  } finally {
    handle.dispose();
    db.close();
  }
});

test("scheduled job → 到点 dispatch（时间压缩：scanDue 直驱）+ scheduled.fire 审计事件", async () => {
  const { db, core, dispatched, handle } = wireDeps();
  try {
    const jobs = new ScheduledJobsStore(db);
    const now = 200_000;
    jobs.create({
      id: "job-due",
      tenantId: "t1",
      taskType: "beat",
      scheduleKind: "interval",
      scheduleSpec: "5000",
      payload: { beat: 1 },
      status: "active",
      nextFireAt: now - 1, // 已到期
      createdBy: "test",
    });

    // 用同 db 的 TimedTrigger 直驱 scanDue（时间压缩——不启动真实定时器）
    const direct = new TimedTrigger({
      store: jobs,
      dispatch: async (req) => {
        dispatched.push(req);
        return completedResult();
      },
      appendEvent: (e) => core.events.append(e),
      now: () => now,
    });

    const fired = await direct.scanDue();
    assert.equal(fired, 1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.role, "beat");
    assert.equal(dispatched[0]!.labels?.scheduledJobId, "job-due");

    // scheduled.fire 审计事件落 EventLog
    const fires = core.events.query({ eventType: "scheduled.fire" });
    assert.equal(fires.length, 1);
    assert.equal((fires[0]!.payload as { jobId: string }).jobId, "job-due");
  } finally {
    handle.dispose();
    db.close();
  }
});
