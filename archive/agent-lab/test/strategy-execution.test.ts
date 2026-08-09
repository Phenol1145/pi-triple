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
import type { AgentDefinition, SchedulerDefinition } from "../src/core/contracts.ts";
import type { SchedulingInput, SettleOutcome } from "../src/scheduler/contracts.ts";
import type { WorkLoopRunner } from "../src/workloop/runner.ts";

// ── Helpers (same pattern as strategy-dispatch.test.ts) ──────────────

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

/**
 * Minimal LabCore wired to an in-memory DB with one active scheduler
 * instance + round + a catch-all routing binding (same wiring as
 * strategy-dispatch.test.ts buildCore).
 */
function buildCore(opts?: {
  instanceId?: string;
}): { core: LabCore; db: DatabaseSync; instanceId: string } {
  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);
  const controlPlane = new ControlPlane(definitions, repository, events);

  const instanceId = opts?.instanceId ?? "test-instance";
  const roundId = `${instanceId}:round:0`;
  const now = Date.now();

  const draftSpec = {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler" as const, id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "original-request" as const }],
    routingBindings: [{ id: "r1", priority: 10, match: {} }],
    metadata: {},
  };

  repository.saveDraft(draftSpec);

  repository.transaction(() => {
    repository.insertInstance(
      {
        id: instanceId,
        name: instanceId,
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
    repository.insertRoutingBinding(instanceId, { id: "r1", priority: 10, match: {} });
  });

  const core: LabCore = { definitions, repository, events, storage, controlPlane };
  return { core, db, instanceId };
}

function defaultAgentDef(): AgentDefinition {
  return {
    standard: { name: "test-agent", capabilities: [], executionKind: "workloop", labels: {} },
    workLoop: { id: "wl-1", version: "1.0.0", config: { model: "test" } },
    custom: {},
  };
}

/**
 * Mock WorkLoopRunner：记录 run 调用；never=true 时 run 永不 resolve（超时用例）。
 * run 返回 { status: "completed", output: { standard: { text: "done" } } }。
 */
function mockWlRunner(opts?: { never?: boolean }) {
  const runCalls: unknown[] = [];
  const runner = {
    runCalls,
    run: (req: unknown) => {
      runCalls.push(req);
      if (opts?.never) return new Promise(() => {});
      return Promise.resolve({
        status: "completed",
        output: { standard: { text: "done" } },
        error: undefined,
        context: {},
        state: {},
      });
    },
  };
  return runner;
}

/** Build runner with a spy scheduler impl that records invocations + captured input. */
function buildRunner(opts?: {
  instanceId?: string;
  /** mock workloop runner（direct+execute 用例注入） */
  runner?: unknown;
  /** 预先插入仓库的 agent（direct execute 需要可解析的 agentId） */
  agents?: Array<{ id: string; definition?: unknown }>;
}) {
  const { core, db, instanceId } = buildCore(opts);
  for (const a of opts?.agents ?? []) {
    core.repository.insertAgent({
      id: a.id,
      schedulerInstanceId: instanceId,
      definition: (a.definition ?? defaultAgentDef()) as AgentDefinition,
      sourceAgentId: undefined,
      cloneOperationId: undefined,
      createdAtRoundId: `${instanceId}:round:0`,
      status: "ready",
      createdAt: Date.now(),
    });
  }
  const schedulers = new SchedulerRegistry(core.definitions);
  const calls: SchedulingInput[] = [];
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (input) => {
      calls.push(input);
      return { status: "completed", selectedAgentId: "agent-1", model: "gpt-4", reason: "ok" };
    },
  });
  const runner = new SchedulerRunner({
    core,
    schedulers,
    runner: opts?.runner as WorkLoopRunner | undefined,
  });
  return { core, db, instanceId, runner, calls };
}

/** Sort events by trailing seq segment of eventId (stable order). */
function sortEvents<T extends { eventId: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });
}

// ── E1: direct + mode=execute → 真正执行 workloop，output 透传 ────────

test("E1: dispatch strategy=direct + mode=execute → 真正执行 workloop（mock wlRunner.run 被调用），output 透传，无竞价事件，impl.schedule 未被调用", async () => {
  const wl = mockWlRunner();
  const { core, db, runner, calls } = buildRunner({
    runner: wl,
    agents: [{ id: "agent-x" }],
  });

  const result = await runner.dispatch({
    traceId: "e1",
    role: "architect",
    task: "t",
    strategy: "direct",
    agentId: "agent-x",
    mode: "execute",
    caller: "cli",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.selectedAgentId, "agent-x");
  assert.equal(result.schedulerInstanceId, "<direct>");
  // output 透传回 DispatchResult
  assert.equal(result.output?.text, "done");

  // 真正执行：mock wlRunner.run 被调用一次，且携带正确 agentInstanceId
  assert.equal(wl.runCalls.length, 1);
  assert.equal((wl.runCalls[0] as { agentInstanceId?: string }).agentInstanceId, "agent-x");

  // 绕过 bidding：scheduler impl 一次都未被调用
  assert.equal(calls.length, 0);

  // 事件序列精确等于直通三连（无 routing.resolved / scheduler.started /
  // bidding/market 类事件）
  const events = sortEvents(core.events.query({ traceId: "e1" }));
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "scheduling.requested",
    "scheduler.agent.selected",
    "scheduler.completed",
  ]);

  const reqEvt = events.find((e) => e.eventType === "scheduling.requested")!;
  assert.equal((reqEvt.payload as { strategy?: unknown }).strategy, "direct");

  const selected = events.find((e) => e.eventType === "scheduler.agent.selected")!;
  assert.equal((selected.payload as { agentInstanceId?: unknown }).agentInstanceId, "agent-x");
  assert.equal(selected.identity.agentInstanceId, "agent-x");

  const completed = events.find((e) => e.eventType === "scheduler.completed")!;
  assert.equal(completed.payload.selectedAgentId, "agent-x");
  assert.equal(completed.payload.reason, "direct execution");
  // model 未提供：payload 不携带 model 键（EventLog 序列化丢弃 undefined）
  assert.equal(completed.payload.model, undefined);
  assert.equal(completed.identity.schedulerInstanceId, "<direct>");

  db.close();
});

// ── E4: direct + mode=select → 仅指派不执行 ──────────────────────────

test("E4: dispatch strategy=direct + mode=select → 仅指派不执行（mock wlRunner.run 未被调用），completed/selectedAgentId", async () => {
  const wl = mockWlRunner();
  const { core, db, runner, calls } = buildRunner({
    runner: wl,
    agents: [{ id: "agent-x" }],
  });

  const result = await runner.dispatch({
    traceId: "e4",
    role: "architect",
    task: "t",
    strategy: "direct",
    agentId: "agent-x",
    mode: "select",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.selectedAgentId, "agent-x");
  assert.equal(result.schedulerInstanceId, "<direct>");
  assert.equal(result.output, undefined);
  // 仅指派：workloop 未被调用
  assert.equal(wl.runCalls.length, 0);
  assert.equal(calls.length, 0);

  const events = sortEvents(core.events.query({ traceId: "e4" }));
  assert.deepStrictEqual(events.map((e) => e.eventType), [
    "scheduling.requested",
    "scheduler.agent.selected",
    "scheduler.completed",
  ]);

  db.close();
});

// ── E5: direct + mode=execute 执行超时 → failed/execution-timeout ────

test("E5: dispatch strategy=direct + mode=execute 执行超时 → failed/execution-timeout，signal 尽力取消，scheduler.failed 事件", async () => {
  const wl = mockWlRunner({ never: true });
  const { core, db, runner } = buildRunner({
    runner: wl,
    agents: [{ id: "agent-x" }],
  });
  // 真实 AbortSignal 无实例 abort 方法（Node 24），尽力取消只能作用于暴露
  // abort 的 signal（照 execution-timeout.test.ts 先例用带 abort 的假 signal）
  const signal = {
    aborted: false,
    abort() {
      (this as { aborted: boolean }).aborted = true;
    },
  };

  const result = await runner.dispatch({
    traceId: "e5",
    role: "architect",
    task: "t",
    strategy: "direct",
    agentId: "agent-x",
    mode: "execute",
    executionTimeoutMs: 50,
    signal: signal as AbortSignal,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.standard.code, "execution-timeout");
  assert.equal(result.error.standard.retryable, true);
  // 尽力取消：signal.abort 被调用
  assert.equal(signal.aborted, true);
  // run 确实被调用（挂起），随后超时
  assert.equal(wl.runCalls.length, 1);

  const events = sortEvents(core.events.query({ traceId: "e5" }));
  assert.deepStrictEqual(events.map((e) => e.eventType), [
    "scheduling.requested",
    "scheduler.failed",
  ]);

  db.close();
});

// ── E6: direct + settlementRef → settle 失败路径 fail-open ──────────

test("E6: direct + settlementRef → settle 失败路径 fail-open（返回 false 不崩溃，<direct> instance 不可解析）", async () => {
  const { core, db, runner } = buildRunner({ agents: [{ id: "agent-x" }] });

  const result = await runner.dispatch({
    traceId: "e6",
    role: "architect",
    task: "t",
    strategy: "direct",
    agentId: "agent-x",
    mode: "select",
    settlementRef: "ref-e6",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.settlementRef, "ref-e6");

  const outcome: SettleOutcome = {
    completion: 1,
    majorError: false,
    tokensIn: 10,
    tokensOut: 5,
    cost: 0.01,
    toolCalls: [],
    inferenceLatencyMs: 100,
  };
  // <direct> 不是可解析 instance → fail-open：返回 false 且不抛异常
  const settled = await runner.settle("ref-e6", outcome);
  assert.equal(settled, false);

  db.close();
});

// ── E2: direct 缺 agentId → failed ──────────────────────────────────

test("E2: dispatch strategy=direct 缺 agentId → failed，message 含“需要 agentId”，attempts 空，无 completed 事件", async () => {
  const { core, db, runner, calls } = buildRunner();

  const result = await runner.dispatch({
    traceId: "e2",
    role: "architect",
    task: "t",
    strategy: "direct",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.standard.code, "scheduler-error");
  assert.match(result.error.standard.message, /需要 agentId/);
  assert.equal(result.error.standard.retryable, false);
  assert.deepStrictEqual(result.attempts, []);

  // 未走 impl，也未发 completed/started 事件
  assert.equal(calls.length, 0);
  const events = core.events.query({ traceId: "e2" });
  assert.deepStrictEqual(events.map((e) => e.eventType), ["scheduling.requested"]);

  db.close();
});

// ── E3: 非 direct 防回归——默认 market 仍走 binding 路由 ────────────

test("E3: dispatch 非 direct（默认 market）→ 仍走 binding 路由（routing.resolved + scheduler.started），impl 被调用", async () => {
  const { core, db, instanceId, runner, calls } = buildRunner();

  const result = await runner.dispatch({
    traceId: "e3",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.selectedAgentId, "agent-1");
  assert.equal(result.schedulerInstanceId, instanceId);
  assert.equal(calls.length, 1);

  const events = sortEvents(core.events.query({ traceId: "e3" }));
  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "scheduling.requested",
    "routing.resolved",
    "scheduler.started",
    "scheduler.agent.selected",
    "scheduler.completed",
  ]);
  // 不存在 direct 短路特征
  assert.ok(!events.some((e) => e.identity.schedulerInstanceId === "<direct>"));

  db.close();
});
