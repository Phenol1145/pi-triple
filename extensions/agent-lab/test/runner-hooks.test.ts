import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import type { WorkLoopDefinition } from "../src/core/contracts.ts";
import type {
  WorkLoopImplementation,
  WorkLoopResult,
  WorkLoopSDK,
  WorkContext,
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../src/workloop/contracts.ts";
import type { MachineEvent, StepResult } from "../src/workloop/machine.ts";

// ── helpers（复用 workloop-runner.test.ts fixture 模式） ──────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function testContext(id = "ctx-1"): WorkContext {
  return {
    systemPrompt: "helpful",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "search", description: "search the web" }],
    metadata: {
      contextId: id,
      sourceRefs: [],
      artifactRefs: [],
    },
  };
}

function workloopDef(overrides: Partial<WorkLoopDefinition> = {}): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: "test-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
    ...overrides,
  };
}

function noopModel(): ModelPort {
  return {
    complete: async (_ctx, _opts) => ({
      message: { role: "assistant", content: "ok" },
    }),
  };
}

function noopTools(): ToolPort {
  return { execute: async (_name, _args) => "done" };
}

function noopArtifacts(): ArtifactPort {
  return {
    put: async (_value, _mediaType) => "ref-1",
    get: async (_ref) => "artifact-value",
  };
}

function defaultRequest(overrides: Partial<WorkLoopRunRequest> = {}): WorkLoopRunRequest {
  return {
    traceId: "trace-1",
    executionId: "exec-1",
    agentInstanceId: "agent-1",
    optimizationRoundId: "round-1",
    workLoopId: "test-loop",
    workLoopVersion: "1.0.0",
    config: { mode: "test" },
    task: "do the thing",
    ...overrides,
  };
}

/** 单转移 machine impl（idle→done terminal completed） */
function machineImpl(opts?: {
  step?: (
    ctx: WorkContext,
    state: unknown,
    event: MachineEvent,
    sdk: WorkLoopSDK,
  ) => Promise<StepResult>;
}): WorkLoopImplementation {
  return {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: (_config: unknown) => testContext("init"),
    initialState: (_config: unknown) => ({ counter: 0 }),
    machine: {
      states: [{ id: "idle" }, { id: "done", terminal: true }],
      initial: "idle",
      transitions: (state, event) =>
        state === "idle" && event.type === "start" ? "done" : undefined,
      step: async (ctx, state, event, sdk) => {
        if (opts?.step) return opts.step(ctx, state, event, sdk);
        return {
          context: testContext("completed"),
          state: { counter: 1 },
          terminal: {
            status: "completed",
            output: { standard: { text: "done" } },
            context: testContext("completed"),
            state: { counter: 1 },
          },
        };
      },
    },
  };
}

/** 四状态自驱动机器（s0→s1→s2→s3 terminal）：3 次转移 → 3 个自动 checkpoint */
function selfDrivingImpl(): WorkLoopImplementation {
  return {
    id: "test-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",
    initialContext: () => testContext("init"),
    initialState: () => ({ step: 0 }),
    machine: {
      states: [{ id: "s0" }, { id: "s1" }, { id: "s2" }, { id: "s3", terminal: true }],
      initial: "s0",
      transitions: (s, e) => {
        if (s === "s0" && e.type === "start") return "s1";
        if (s === "s1" && e.type === "go") return "s2";
        if (s === "s2" && e.type === "go") return "s3";
        return undefined;
      },
      step: async (_ctx, state, event) => {
        if (event.type === "start") {
          return { context: testContext("cp1"), state: { step: 1 }, event: { type: "go" } };
        }
        const step = (state as { step: number }).step ?? 0;
        if (step === 1) {
          return { context: testContext("cp2"), state: { step: 2 }, event: { type: "go" } };
        }
        return {
          context: testContext("final"),
          state: { step: 3 },
          terminal: {
            status: "completed",
            output: { standard: { text: "chained" } },
            context: testContext("final"),
            state: { step: 3 },
          },
        };
      },
    },
  };
}

function buildRunner(opts?: {
  impl?: WorkLoopImplementation;
}): {
  runner: WorkLoopRunner;
  eventLog: EventLog;
  stateStore: AgentRuntimeStateStore;
  checkpointStore: CheckpointStore;
} {
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);

  const impl = opts?.impl ?? machineImpl();
  registry.register(impl);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  return { runner, eventLog, stateStore, checkpointStore };
}

// ── Test 1: onCheckpoint 注册/反注册 ────────────────────────────────

test("runner-hooks: onCheckpoint 注册 → 每轮 checkpoint 回调 {agentInstanceId, checkpointId, seq}；反注册后不再收", async () => {
  const { runner, stateStore } = buildRunner({ impl: selfDrivingImpl() });
  stateStore.initialize("agent-1", testContext("init"), { step: 0 });

  const received: Array<{ agentInstanceId: string; checkpointId: string; seq: number }> = [];
  const unregister = runner.onCheckpoint((info) => {
    received.push(info);
  });

  // Run 1：3 次转移 → 3 个 checkpoint 回调，seq 递增
  const r1 = await runner.run(defaultRequest());
  assert.equal(r1.status, "completed");
  assert.equal(received.length, 3, "3 checkpoints → 3 callbacks");
  assert.deepStrictEqual(
    received.map((info) => ({ agentInstanceId: info.agentInstanceId, seq: info.seq })),
    [
      { agentInstanceId: "agent-1", seq: 1 },
      { agentInstanceId: "agent-1", seq: 2 },
      { agentInstanceId: "agent-1", seq: 3 },
    ],
  );
  for (const info of received) {
    assert.ok(info.checkpointId, "checkpointId should be present");
    assert.equal(typeof info.checkpointId, "string");
    assert.ok(info.checkpointId.length > 0);
  }

  // 反注册后：Run 2 不再收到回调
  const before = received.length;
  const unregistered = unregister();
  assert.equal(unregistered, undefined, "反注册函数返回 void");
  const r2 = await runner.run(defaultRequest({ executionId: "exec-2" }));
  assert.equal(r2.status, "completed");
  assert.equal(received.length, before, "反注册后不应再收到回调");

  // 重复调用反注册安全（幂等）
  unregister();
});

// ── Test 2: currentSeqOf ────────────────────────────────────────────

test("runner-hooks: currentSeqOf run 中可读当前 seq；run 结束后 = 0", async () => {
  let resolveStep: ((v: StepResult) => void) | undefined;
  const stepGate = new Promise<StepResult>((resolve) => {
    resolveStep = resolve;
  });

  const impl = machineImpl({
    step: async () => stepGate,
  });
  // 重新用慢转移机器构建 runner
  const db = memoryDB();
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore2 = new AgentRuntimeStateStore(store);
  const checkpointStore2 = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);
  registry.register(impl);
  const runner2 = new WorkLoopRunner(
    registry,
    stateStore2,
    checkpointStore2,
    eventLog,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );
  stateStore2.initialize("agent-1", testContext("init"), { counter: 0 });

  // 未 in-flight → 0
  assert.equal(runner2.currentSeqOf("agent-1"), 0, "run 前应 = 0");
  assert.equal(runner2.currentSeqOf("never-ran"), 0, "未注册过的 agent 应 = 0");

  const runPromise = runner2.run(defaultRequest());

  // δ 在 step 内（seq 已递增为 1，但转移未完成）→ 可读当前 seq
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runner2.currentSeqOf("agent-1"), 1, "in-flight 应读到当前 seq");

  resolveStep!({
    context: testContext("completed"),
    state: { counter: 1 },
    terminal: {
      status: "completed",
      output: { standard: { text: "done" } },
      context: testContext("completed"),
      state: { counter: 1 },
    },
  });
  const result = await runPromise;
  assert.equal(result.status, "completed");

  // run 结束（注销）→ 0
  assert.equal(runner2.currentSeqOf("agent-1"), 0, "run 结束后应 = 0");

});

// ── Test 3: checkpoint.latest ───────────────────────────────────────

test("runner-hooks: checkpoint.latest(agentId) 返回最近 checkpoint（含 seq）；无 checkpoint → undefined", async () => {
  const { runner, stateStore, checkpointStore } = buildRunner({ impl: selfDrivingImpl() });
  stateStore.initialize("agent-1", testContext("init"), { step: 0 });

  // 尚无 checkpoint → undefined
  assert.equal(checkpointStore.latest("agent-1"), undefined);

  const result = await runner.run(defaultRequest());
  assert.equal(result.status, "completed");

  const latest = checkpointStore.latest("agent-1");
  assert.ok(latest, "latest 应存在");
  assert.equal(latest.label, "s3#3", "最近 checkpoint = 第 3 个");
  assert.equal(latest.seq, 3);
  assert.equal(latest.controlState, "s3");
  assert.equal(latest.agentInstanceId, "agent-1");
  assert.equal(latest.context.metadata.contextId, "final");
  assert.deepStrictEqual(latest.state, { step: 3 });

  // 返回防御拷贝：调用方突变不影响存储
  (latest.state as { step: number }).step = 999;
  const again = checkpointStore.latest("agent-1");
  assert.deepStrictEqual(again!.state, { step: 3 });

  // 不同 agent（无 checkpoint）→ undefined
  assert.equal(checkpointStore.latest("agent-ghost"), undefined);
});

// ── Test 4: checkpoint.created payload 含 seq ───────────────────────

test("runner-hooks: checkpoint.created payload 含 seq（= 转移序号）", async () => {
  const { runner, stateStore, eventLog } = buildRunner({ impl: selfDrivingImpl() });
  stateStore.initialize("agent-1", testContext("init"), { step: 0 });

  const result = await runner.run(defaultRequest());
  assert.equal(result.status, "completed");

  const cpEvents = eventLog
    .query({ traceId: "trace-1", eventType: "checkpoint.created" })
    .sort((a, b) => a.eventId.localeCompare(b.eventId));
  assert.equal(cpEvents.length, 3);

  const seqs = cpEvents.map((e) => (e.payload as { seq?: number }).seq);
  assert.deepStrictEqual(seqs, [1, 2, 3], "payload.seq 应随转移递增");

  // 既有字段（checkpointId/label）不变
  for (const ev of cpEvents) {
    const payload = ev.payload as { checkpointId?: string; label?: string; seq?: number };
    assert.ok(payload.checkpointId, "checkpointId should be present");
    assert.equal(typeof payload.seq, "number");
  }
  assert.equal((cpEvents[0].payload as { label?: string }).label, "s1#1");
  assert.equal((cpEvents[1].payload as { label?: string }).label, "s2#2");
  assert.equal((cpEvents[2].payload as { label?: string }).label, "s3#3");
});
