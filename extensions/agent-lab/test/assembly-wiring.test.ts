// C 接线包 10 项（plan Task 10 / spec §10）——装配层遗留钩子的逐项落地测试。
//
// 每项一测（附 1b 真实 runner 钩子验证 + 6 的注册面双路径）：
//   1.  attachSdk 真实钩子：runner sdkExtensions 注册 → memory.attachSdk 收到真实 SDK（非 stub）
//   1b. runner onSdkBuilt：扩展应用到 machine 可见的 SDK（真实 runner 全链路）
//   2.  seqProvider 注入：装配时传入 → runner.currentSeqOf 为 MemoryHost seq 来源
//       （观察面：watermark=5 的条目在 seq=99 可见——缺接线时 seq=0 被屏蔽）
//   3.  onCheckpoint→dsp.snapshot 注册：checkpoint 事件触发 snapshot（agentId 过滤）+ bridge.ack
//   4.  inbox drainInto 拼接 task 前缀：drain 消息带 "task:" 前缀；幂等去重；ack 清 inbox
//   5.  delivery=auto 覆写：装配配置 delivery=manual → 装配产物桥 delivery=auto
//   6.  IdentityMap 装配注册+刷新回调：装配 → 身份注册（identity.json 权威源）；
//       refreshSession → session 刷新；mock bridge 注册面 spy
//   7.  DSP 两段拼接：记忆入口区 = 私域段 + 公域段（顺序：私域在前；同 id 公域条目被私域优先去重）
//   8.  AssembleOptions 可选 agentId：指定 agentId 装配（非派生）；RESERVED 校验对显式 id 同样生效
//   9.  removeAccount 提进 LedgerPort：接口方法删账（credits 行移除）；装配失败路径经 port 调用
//   10. startSweeper unref：sweeper 定时器不阻进程退出（mock unref 断言）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteLedgerAdapter } from "../src/assembly/ledger-port.ts";
import type { LedgerPort } from "../src/assembly/ledger-port.ts";
import type { AgentAssemblerDeps } from "../src/assembly/assembler.ts";
import { createAgentAssembler } from "../src/assembly/assembler.ts";
import type { AgentRuntimeDeps } from "../src/assembly/agent-runtime.ts";
import { AgentRuntime } from "../src/assembly/agent-runtime.ts";
import { MemoryHost } from "../src/assembly/memory-host.ts";
import { CommsBridge } from "../src/assembly/comms-bridge.ts";
import type { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";
import { ASSEMBLY_DIR, IDENTITY_DIR, PUBLIC_DOMAIN_DIR } from "../src/assembly/types.ts";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import type { AgentDefinition, AgentInstanceRecord, WorkLoopDefinition } from "../src/core/contracts.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import type { WorkLoopImplementation, WorkLoopResult, WorkLoopSDK, WorkContext } from "../src/workloop/contracts.ts";
import type { MachineEvent, StepResult } from "../src/workloop/machine.ts";
import type { CommsIdentity, CommsTransport } from "../src/memory/comms.ts";
import { CommsChannel, IdentityMap } from "../src/memory/comms.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { WatermarkManager } from "../src/memory/watermark.ts";
import { createEntry } from "../src/memory/entry.ts";

const WL_ID = "wl-test";
const WL_VERSION = "1.0.0";
const NOW = 1_700_000_000_000;

// ── fixtures ─────────────────────────────────────────────────────────

function workloopDef(overrides: Partial<WorkLoopDefinition> = {}): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: WL_ID,
    version: WL_VERSION,
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh", "fork"],
    ...overrides,
  };
}

function done(): WorkLoopResult {
  return {
    status: "completed",
    context: { messages: [], metadata: { contextId: "", sourceRefs: [], artifactRefs: [] } },
    state: {},
  };
}

function ctx(id = "ctx-1"): WorkContext {
  return { messages: [], metadata: { contextId: id, sourceRefs: [], artifactRefs: [] } };
}

const DEF: AgentDefinition = {
  standard: { name: "t", capabilities: [], executionKind: "workloop", labels: {} },
  workLoop: { id: WL_ID, version: WL_VERSION, config: {} },
  custom: null,
};

/** mock ruleBootstrap（MemoryHost 构造用；resolveRule 恒 undefined）。 */
function mockRuleBootstrap(): RuleBootstrap {
  return {
    resolveRule: () => undefined,
    ensureInitialized: () => {},
  } as unknown as RuleBootstrap;
}

const LEDGER_MOCK: LedgerPort = {
  open: () => ({ created: true }),
  balance: () => 0,
  credit: () => {},
  debit: () => {},
  freeze: () => {},
  unfreeze: () => {},
  removeAccount: () => {},
};

function fakeTransport(): CommsTransport {
  return { send: () => {}, onReceive: () => {}, activePeers: () => [] };
}

interface AssemblerFixture {
  root: string;
  assembler: ReturnType<typeof createAgentAssembler>;
  openCalls: Array<[string, number]>;
  removeAccountCalls: string[];
  inserted: AgentInstanceRecord[];
  cleanup(): void;
}

/** 装配器 fixture（mock agentStore/ledger/runner；真实 registry + 临时 workDir）。 */
function makeAssembler(opts: {
  root?: string;
  idGen?: () => string;
  insertThrows?: Error;
  runner?: unknown;
  bridge?: unknown;
  comms?: { transport: CommsTransport; identity: CommsIdentity; delivery?: "auto" | "manual" | "hybrid" };
} = {}): AssemblerFixture {
  const root = opts.root ?? mkdtempSync(path.join(tmpdir(), "asm-wiring-"));
  const registry = new DefinitionRegistry();
  registry.register(workloopDef());

  const inserted: AgentInstanceRecord[] = [];
  const records = new Map<string, AgentInstanceRecord>();
  const agentStore = {
    getAgent: (id: string): AgentInstanceRecord | undefined => records.get(id),
    insertAgent: (r: AgentInstanceRecord): void => {
      if (opts.insertThrows) throw opts.insertThrows;
      inserted.push(r);
      records.set(r.id, r);
    },
  };

  const openCalls: Array<[string, number]> = [];
  const removeAccountCalls: string[] = [];
  const ledger = {
    open: (agentId: string, k: number): { created: boolean } => {
      openCalls.push([agentId, k]);
      return { created: true };
    },
    balance: (): number => 0,
    credit: (): void => {},
    debit: (): void => {},
    freeze: (): void => {},
    unfreeze: (): void => {},
    removeAccount: (id: string): void => {
      removeAccountCalls.push(id);
    },
  } as unknown as LedgerPort;

  const runner = opts.runner ?? { run: async (): Promise<WorkLoopResult> => done() };

  const deps: AgentAssemblerDeps = {
    registry,
    agentStore,
    ledger,
    ruleBootstrap: mockRuleBootstrap(),
    runner: runner as AgentAssemblerDeps["runner"],
    workDir: root,
    now: () => NOW,
    ...(opts.idGen !== undefined ? { idGen: opts.idGen } : {}),
    ...(opts.bridge !== undefined ? { bridge: opts.bridge as CommsBridge } : {}),
    ...(opts.comms !== undefined ? { comms: opts.comms } : {}),
  };
  const assembler = createAgentAssembler(deps);

  return {
    root,
    assembler,
    openCalls,
    removeAccountCalls,
    inserted,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const REF = { kind: "workloop" as const, id: WL_ID, version: WL_VERSION };

/** AgentRuntime 直接构造（mock runner/memory/bridge）。 */
function makeRuntime(deps: { runner: unknown; memory: unknown; bridge?: unknown }): AgentRuntime {
  return new AgentRuntime({
    agentId: "ag-1",
    definition: DEF,
    schedulerInstanceId: "sched-1",
    runner: deps.runner as AgentRuntimeDeps["runner"],
    memory: deps.memory as MemoryHost,
    ledger: LEDGER_MOCK,
    ...(deps.bridge !== undefined ? { bridge: deps.bridge as CommsBridge } : {}),
  });
}

/** 真实 runner（item 1b）：真实 DB/registry/stateStore/checkpointStore + 捕获 machine 可见 SDK。 */
function buildRealRunner(): {
  runner: WorkLoopRunner;
  stateStore: AgentRuntimeStateStore;
  seenSdk(): WorkLoopSDK | undefined;
} {
  const db = new DatabaseSync(":memory:");
  const store = new NamespacedStore(db);
  const eventLog = new EventLog(db);
  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);
  const definitions = new DefinitionRegistry();
  definitions.register(workloopDef());
  const registry = new WorkLoopRegistry(definitions);

  let seenSdk: WorkLoopSDK | undefined;
  const impl: WorkLoopImplementation = {
    id: WL_ID,
    version: WL_VERSION,
    cloneModes: ["fresh", "fork"],
    executorKind: "local-model",
    initialContext: () => ctx("init"),
    initialState: () => ({}),
    machine: {
      states: [{ id: "idle" }, { id: "done", terminal: true }],
      initial: "idle",
      transitions: (s: string, e: MachineEvent): string | undefined =>
        s === "idle" && e.type === "start" ? "done" : undefined,
      step: async (_c: WorkContext, _s: unknown, _e: MachineEvent, sdk: WorkLoopSDK): Promise<StepResult> => {
        seenSdk = sdk;
        return {
          context: ctx("completed"),
          state: {},
          terminal: { status: "completed", output: { standard: { text: "ok" } }, context: ctx("completed"), state: {} },
        };
      },
    },
  };
  registry.register(impl);

  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    eventLog,
    store,
    { complete: async () => ({ message: { role: "assistant", content: "ok" } }) },
    { execute: async () => "done" },
    { put: async () => "ref-1", get: async () => "artifact" },
  );
  return { runner, stateStore, seenSdk: () => seenSdk };
}

// ══════════════════════════════════════════════════════════════════
// 1. attachSdk 真实钩子（runner sdkExtensions）
// ══════════════════════════════════════════════════════════════════
test("1. attachSdk 真实钩子：runner sdkExtensions 注册 → memory.attachSdk 收到真实 SDK（非 stub）", async () => {
  const sdkExtensions: Array<(sdk: WorkLoopSDK) => void> = [];
  const runner = {
    run: async (): Promise<WorkLoopResult> => done(),
    onSdkBuilt: (cb: (sdk: WorkLoopSDK) => void): (() => void) => {
      sdkExtensions.push(cb);
      return () => {};
    },
  };
  const attached: WorkLoopSDK[] = [];
  const memory = {
    dsp: { build: () => "", snapshot: () => {} },
    attachSdk: (sdk: WorkLoopSDK): void => {
      attached.push(sdk);
    },
    startSweeper: () => () => {},
    retrieve: () => [],
    comms: { pruneDedup: () => {} },
    pipeline: { pruneIdem: () => {} },
  };
  const rt = makeRuntime({ runner, memory });
  await rt.run({ task: "t" });
  assert.equal(sdkExtensions.length, 1, "attachSdkOnce 只注册一次");

  const fakeSdk = {} as WorkLoopSDK;
  sdkExtensions[0](fakeSdk);
  assert.equal(attached.length, 1);
  assert.equal(attached[0], fakeSdk, "挂载的是 runner 构建的真实 SDK，而非内部 stub");

  await rt.run({ task: "t2" });
  assert.equal(sdkExtensions.length, 1, "二次 run 不重复注册");
  assert.equal(attached.length, 1);
  rt.dispose();
});

test("1b. runner onSdkBuilt：扩展应用到 machine 可见的 SDK（真实 runner 全链路）", async () => {
  const fx = buildRealRunner();
  fx.stateStore.initialize("agent-r1", ctx("init"), {});
  const extended: WorkLoopSDK[] = [];
  // 扩展在 buildSDK 后应用：打标记（machine 侧收到的 dspSdk 是展开克隆——扩展属性随之拷贝）
  fx.runner.onSdkBuilt((sdk) => {
    extended.push(sdk);
    (sdk as WorkLoopSDK & { __extMark?: string }).__extMark = "yes";
  });
  const result = await fx.runner.run({
    traceId: "t",
    executionId: "e",
    agentInstanceId: "agent-r1",
    optimizationRoundId: "",
    workLoopId: WL_ID,
    workLoopVersion: WL_VERSION,
    config: {},
    task: "go",
  });
  assert.equal(result.status, "completed");
  assert.equal(extended.length, 1, "buildSDK 应用扩展");
  assert.equal(
    (fx.seenSdk() as WorkLoopSDK & { __extMark?: string }).__extMark,
    "yes",
    "machine 收到的 SDK（展开克隆）带扩展标记——扩展应用到 buildSDK 产物",
  );
  fx.runner.onSdkBuilt(() => {})(); // 反注册可用性冒烟
});

// ══════════════════════════════════════════════════════════════════
// 2. seqProvider 注入
// ══════════════════════════════════════════════════════════════════
test("2. seqProvider 注入：装配时传入 → runner.currentSeqOf 为 MemoryHost seq 来源", () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-seq-"));
  try {
    const agentId = "ag-seq";
    const agentDir = path.join(root, ASSEMBLY_DIR, agentId);
    mkdirSync(agentDir, { recursive: true });
    // 预置：私域条目 watermark=5（seq 99 可见；若 seqProvider 缺接线 → seq 0 → 被屏蔽）
    const store = new MemoryStore(agentDir);
    store.write(createEntry({ id: "seed-1", kind: "fact", anchors: ["a"], content: "seed content" }));
    new WatermarkManager(store).recordVersion("seed-1", 5);

    const fx = makeAssembler({
      root,
      idGen: () => agentId,
      runner: {
        run: async (): Promise<WorkLoopResult> => done(),
        currentSeqOf: (): number => 99,
      },
    });
    try {
      const runtime = fx.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "s" });
      const out = runtime.memory.retrieve();
      assert.ok(
        out.some((e) => e.id === "seed-1"),
        "seqProvider 接线生效：watermark=5 条目在 runner seq=99 下可见（缺接线时 seq=0 被屏蔽）",
      );
      runtime.dispose();
    } finally {
      fx.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 3. onCheckpoint→dsp.snapshot 注册
// ══════════════════════════════════════════════════════════════════
test("3. onCheckpoint→dsp.snapshot 注册：checkpoint 事件触发 snapshot（agentId 过滤）+ bridge.ack", async () => {
  const checkpointCbs: Array<(info: { agentInstanceId: string; checkpointId: string; seq: number }) => void> = [];
  const runner = {
    run: async (): Promise<WorkLoopResult> => done(),
    onCheckpoint: (cb: (info: { agentInstanceId: string; checkpointId: string; seq: number }) => void): (() => void) => {
      checkpointCbs.push(cb);
      return () => {};
    },
  };
  const snapshots: Array<[number, string]> = [];
  const acks: number[] = [];
  const memory = {
    dsp: {
      build: () => "",
      snapshot: (seq: number, mode: string): void => {
        snapshots.push([seq, mode]);
      },
    },
    attachSdk: () => {},
    startSweeper: () => () => {},
    retrieve: () => [],
    comms: { pruneDedup: () => {} },
    pipeline: { pruneIdem: () => {} },
  };
  const bridge = {
    ack: (seq: number): void => {
      acks.push(seq);
    },
    drainInto: () => [],
  };
  const rt = makeRuntime({ runner, memory, bridge });
  await rt.run({ task: "t" });
  assert.equal(checkpointCbs.length, 1, "首次 run 注册 onCheckpoint");

  checkpointCbs[0]({ agentInstanceId: "ag-1", checkpointId: "cp-1", seq: 7 });
  assert.deepEqual(snapshots, [[7, "realtime"]], "checkpoint 事件 → dsp.snapshot(seq, realtime)");
  assert.deepEqual(acks, [7], "同钩子 → bridge.ack(seq)（契约⑥：mergedAtSeq ≤ seq 删除）");

  checkpointCbs[0]({ agentInstanceId: "other-agent", checkpointId: "cp-2", seq: 8 });
  assert.deepEqual(snapshots, [[7, "realtime"]], "他 agent 的 checkpoint 不触发（按 agentInstanceId 过滤）");
  rt.dispose();
});

// ══════════════════════════════════════════════════════════════════
// 4. inbox drainInto 拼接 task 前缀
// ══════════════════════════════════════════════════════════════════
test("4. inbox drainInto 拼接 task 前缀：drain 消息带 'task:' 前缀；幂等去重；ack 清 inbox", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-inbox-"));
  try {
    const agentId = "ag-inbox";
    const inboxDir = path.join(root, ASSEMBLY_DIR, agentId, "comms");
    const identity: CommsIdentity = { agentId, tenantId: "t1", sessionId: "s1" };
    const transport = fakeTransport();
    const channel = new CommsChannel(transport, identity);
    const identityMap = new IdentityMap(path.join(root, IDENTITY_DIR));
    // 预入 inbox（测试侧桥实例写同一 inbox 文件——装配器侧桥读同一文件）
    const probe = new CommsBridge({ inboxDir, channel, identityMap });
    probe.enqueue({ msgId: "m1", from: "peer-1", to: agentId, tapeFragment: "frag one", timestamp: 1 });
    probe.enqueue({ msgId: "m2", from: "peer-2", to: agentId, tapeFragment: "frag two", timestamp: 2 });

    const runRequests: WorkLoopRunRequest[] = [];
    const checkpointCbs: Array<(info: { agentInstanceId: string; checkpointId: string; seq: number }) => void> = [];
    const fx = makeAssembler({
      root,
      idGen: () => agentId,
      comms: { transport, identity },
      runner: {
        run: async (req: WorkLoopRunRequest): Promise<WorkLoopResult> => {
          runRequests.push(req);
          return done();
        },
        onCheckpoint: (cb: (info: { agentInstanceId: string; checkpointId: string; seq: number }) => void): (() => void) => {
          checkpointCbs.push(cb);
          return () => {};
        },
      },
    });
    try {
      const runtime = fx.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "s" });
      await runtime.run({ task: "T" });
      assert.equal(
        runRequests[0].task,
        "task: frag one\ntask: frag two\nT",
        "drain 消息带 'task:' 前缀拼接进任务文本",
      );

      // 幂等：二次 run 不再重复并入（条目已标记 mergedAtSeq）
      await runtime.run({ task: "T" });
      assert.equal(runRequests[1].task, "T", "已并入条目去重（不重复注入）");

      // ack：checkpoint seq ≥ mergedAtSeq → inbox 条目删除（防 resume 回滚后消息丢失的清理侧）
      checkpointCbs[0]({ agentInstanceId: agentId, checkpointId: "cp-1", seq: 5 });
      const probe2 = new CommsBridge({ inboxDir, channel, identityMap });
      assert.equal(probe2.pending(), 0, "ack 后 inbox 清空");
      runtime.dispose();
    } finally {
      fx.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 5. delivery=auto 覆写
// ══════════════════════════════════════════════════════════════════
test("5. delivery=auto 覆写：装配配置 delivery=manual → 装配产物桥 delivery=auto；无 comms → 无桥", () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-deliv-"));
  try {
    const fx = makeAssembler({
      comms: {
        transport: fakeTransport(),
        identity: { agentId: "x", tenantId: "t", sessionId: "s" },
        delivery: "manual",
      },
    });
    try {
      const runtime = fx.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "s" });
      assert.ok(runtime.bridge, "comms 配置 → 桥已装配");
      assert.equal(runtime.bridge!.delivery, "auto", "强制 auto 覆写 manual（agent↔agent 不可走 manual）");
      runtime.dispose();
    } finally {
      fx.cleanup();
    }

    const fx2 = makeAssembler();
    try {
      const rt2 = fx2.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "s" });
      assert.equal(rt2.bridge, undefined, "无 comms 配置 → 无桥");
      rt2.dispose();
    } finally {
      fx2.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 6. IdentityMap 装配注册+刷新回调
// ══════════════════════════════════════════════════════════════════
test("6. IdentityMap 装配注册+刷新回调：装配 → 身份注册（权威源）；refreshSession → 刷新；注册面 spy", () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-idm-"));
  try {
    const agentId = "ag-idm";
    const identity: CommsIdentity = { agentId, tenantId: "tenant-9", sessionId: "sess-1" };
    const fx = makeAssembler({
      root,
      idGen: () => agentId,
      comms: { transport: fakeTransport(), identity },
    });
    try {
      const runtime = fx.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "s" });
      // 权威源落盘 identity.json：新实例读盘可见
      const im = new IdentityMap(path.join(root, IDENTITY_DIR));
      assert.deepEqual(im.resolve(agentId), { tenantId: "tenant-9", sessionId: "sess-1" }, "装配时注册 agentId → tenant/session");
      // 刷新回调链：refreshSession → IdentityMap 刷新（sessionId 易失更新）
      runtime.bridge!.refreshSession(agentId, "sess-2");
      const im2 = new IdentityMap(path.join(root, IDENTITY_DIR));
      assert.deepEqual(im2.resolve(agentId), { tenantId: "tenant-9", sessionId: "sess-2" }, "session_start 刷新生效");
      runtime.dispose();
    } finally {
      fx.cleanup();
    }

    // 注册面（mock bridge spy）：registerIdentity + registerSessionRefresh 均在装配时调用
    const calls: string[] = [];
    let registeredCb: ((a: string, s: string) => void) | undefined;
    const mockBridge = {
      delivery: "auto",
      registerIdentity: (a: string, t: string, s: string): void => {
        calls.push(`identity:${a}:${t}:${s}`);
      },
      registerSessionRefresh: (cb: (a: string, s: string) => void): (() => void) => {
        registeredCb = cb;
        calls.push("refresh");
        return () => {};
      },
    } as unknown as CommsBridge;
    const fx2 = makeAssembler({
      root,
      idGen: () => agentId,
      bridge: mockBridge,
      comms: { transport: fakeTransport(), identity },
    });
    try {
      const rt2 = fx2.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "s" });
      assert.deepEqual(calls, [`identity:${agentId}:tenant-9:sess-1`, "refresh"], "装配时 registerIdentity + registerSessionRefresh");
      assert.equal(typeof registeredCb, "function", "刷新回调为函数（Task 12 session_start 通知出口）");
      assert.equal(rt2.bridge, mockBridge, "注入桥透传");
      rt2.dispose();
    } finally {
      fx2.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 7. DSP 两段拼接
// ══════════════════════════════════════════════════════════════════
test("7. DSP 两段拼接：记忆入口区 = 私域段 + 公域段（私域在前；同 id 公域被私域优先去重）", () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-dsp-"));
  try {
    const agentDir = path.join(root, ASSEMBLY_DIR, "ag-dsp");
    const pubDir = path.join(root, PUBLIC_DOMAIN_DIR);
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(pubDir, { recursive: true });
    // 公域 official 条目（直接可见段）
    new MemoryStore(pubDir).write(
      createEntry({ id: "pub-1", kind: "fact", anchors: ["pub"], content: "public knowledge", status: "official" }),
    );
    // 私域条目 + 同 id 公域条目（去重验证：私域优先）
    const priv = new MemoryStore(agentDir);
    priv.write(createEntry({ id: "priv-1", kind: "fact", anchors: ["p"], content: "private context" }));
    priv.write(createEntry({ id: "dup-1", kind: "fact", anchors: ["d"], content: "private wins" }));
    new MemoryStore(pubDir).write(
      createEntry({ id: "dup-1", kind: "fact", anchors: ["d"], content: "public dup", status: "official" }),
    );

    const host = new MemoryHost({
      workDir: agentDir,
      pubDir,
      ruleBootstrap: mockRuleBootstrap(),
      spec: {},
    });
    const out = host.dsp.build({ state: {}, memory: {}, env: {}, budget: { used: 0, max: 10000 } }, "realtime");
    const iPriv = out.indexOf("private context");
    const iPub = out.indexOf("public knowledge");
    assert.ok(iPriv >= 0 && iPub >= 0, "私域段与公域段均在输出");
    assert.ok(iPriv < iPub, "顺序正确：私域段在前、公域段在后");
    assert.ok(out.includes("private wins"), "私域条目渲染");
    assert.ok(!out.includes("public dup"), "同 id 公域条目被私域优先去重");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 8. AssembleOptions 可选 agentId
// ══════════════════════════════════════════════════════════════════
test("8. AssembleOptions 可选 agentId：指定 agentId 装配（非派生）；RESERVED 校验对显式 id 同样生效", () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-aid-"));
  try {
    const fx = makeAssembler();
    try {
      const runtime = fx.assembler.assembleAgent(REF, {
        cloneMode: "fresh",
        schedulerInstanceId: "s",
        agentId: "fixed-1",
      });
      assert.equal(runtime.agentId, "fixed-1", "使用指定 agentId（非派生 UUID）");
      assert.equal(fx.openCalls[0][0], "fixed-1", "开户使用指定 agentId");
      assert.equal(fx.inserted[0].id, "fixed-1", "注册记录使用指定 agentId");
      runtime.dispose();

      // RESERVED_IDS 黑名单对显式 agentId 同样生效（早于开户/记忆域）
      assert.throws(
        () =>
          fx.assembler.assembleAgent(REF, {
            cloneMode: "fresh",
            schedulerInstanceId: "s",
            agentId: "calibration-executor",
          }),
        /reserved agent id/,
      );
      assert.equal(fx.openCalls.length, 1, "黑名单拒绝发生在开户前");
    } finally {
      fx.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 9. removeAccount 提进 LedgerPort
// ══════════════════════════════════════════════════════════════════
test("9. removeAccount 提进 LedgerPort：接口方法删账（credits 行移除）；装配失败路径经 port 调用", () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-rm-"));
  try {
    // (a) adapter 层：真实 SqliteLedger 删账
    const db = new DatabaseSync(path.join(root, "ledger.db"));
    const adapter = new SqliteLedgerAdapter(new SqliteLedger(db));
    adapter.open("ag-del", 100);
    assert.equal(adapter.balance("ag-del"), 100);
    adapter.removeAccount("ag-del");
    assert.equal(adapter.balance("ag-del"), 0, "credits 行删除 → 余额归零");
    assert.equal(adapter.open("ag-del", 10).created, true, "行已删 → 重新开户 created=true（不再列出）");
    db.close();

    // (b) 装配失败路径：insertAgent 抛错 → removeAccount 经 LedgerPort 调用（不再经 impl 暗门）
    const fx = makeAssembler({ insertThrows: new Error("boom") });
    try {
      assert.throws(
        () => fx.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "s" }),
        /boom/,
      );
      assert.equal(fx.removeAccountCalls.length, 1, "失败清理经 port.removeAccount");
    } finally {
      fx.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════
// 10. startSweeper unref
// ══════════════════════════════════════════════════════════════════
test("10. startSweeper unref：sweeper 定时器不阻进程退出（mock unref 断言）", () => {
  const root = mkdtempSync(path.join(tmpdir(), "asm-sweep-"));
  try {
    const orig = globalThis.setInterval;
    let unrefCount = 0;
    const fakeTimer = {
      unref: (): void => {
        unrefCount += 1;
      },
    };
    globalThis.setInterval = ((_cb: () => void, _ms?: number) => fakeTimer) as unknown as typeof globalThis.setInterval;
    try {
      const agentDir = path.join(root, ASSEMBLY_DIR, "ag-sweep");
      mkdirSync(agentDir, { recursive: true });
      const host = new MemoryHost({
        workDir: agentDir,
        pubDir: path.join(root, PUBLIC_DOMAIN_DIR),
        ruleBootstrap: mockRuleBootstrap(),
        spec: {},
      });
      const stop = host.startSweeper(1000);
      assert.equal(unrefCount, 1, "sweeper 定时器调用 unref()");
      stop();
    } finally {
      globalThis.setInterval = orig;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
