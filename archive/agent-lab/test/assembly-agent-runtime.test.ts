// AgentRuntime 测试（plan Task 7 / spec §3.1）：run 自填身份字段 / resume 委托 /
// dispose 停 sweeper / run 前 DSP restore 顺序（契约⑦）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDefinition } from "../src/core/contracts.ts";
import type { WorkLoopResult } from "../src/workloop/contracts.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import type { CheckpointStore } from "../src/workloop/checkpoints.ts";
import type { MemoryHost } from "../src/assembly/memory-host.ts";
import type { LedgerPort } from "../src/assembly/ledger-port.ts";
import { ROUND_SENTINEL } from "../src/assembly/types.ts";
import { AgentRuntime } from "../src/assembly/agent-runtime.ts";

const DEFINITION: AgentDefinition = {
  standard: {
    name: "test-agent",
    description: "task 7 fixture",
    capabilities: [],
    executionKind: "workloop",
    labels: {},
  },
  workLoop: { id: "wl-1", version: "v1", config: { k: 1 } },
  custom: null,
};

function done(): WorkLoopResult {
  return {
    status: "completed",
    context: { messages: [], metadata: { contextId: "", sourceRefs: [], artifactRefs: [] } },
    state: {},
  };
}

/** mock 集合：runner 捕获 request；memory 挂 dsp（可选 loadSnapshot）/attachSdk/startSweeper spy。 */
function fresh(opts: { withLoadSnapshot: boolean }) {
  const runRequests: WorkLoopRunRequest[] = [];
  const runner = {
    run: async (req: WorkLoopRunRequest): Promise<WorkLoopResult> => {
      runRequests.push(req);
      return done();
    },
  };

  const dspCalls: string[] = [];
  const loadSnapshotSeqs: number[] = [];
  const buildModes: string[] = [];
  const dsp = {
    ...(opts.withLoadSnapshot
      ? {
          loadSnapshot(seq: number): void {
            loadSnapshotSeqs.push(seq);
            dspCalls.push("loadSnapshot");
          },
        }
      : {}),
    build(_input: unknown, mode: "realtime" | "restore"): string {
      buildModes.push(mode);
      dspCalls.push("build");
      return "";
    },
  };

  let attachCount = 0;
  let stopCount = 0;
  const pruneDedupSeqs: number[] = [];
  const pruneIdemSeqs: number[] = [];
  const memory = {
    dsp,
    attachSdk(): void {
      attachCount += 1;
    },
    startSweeper(): () => void {
      return () => {
        stopCount += 1;
      };
    },
    retrieve(): never[] {
      return [];
    },
    // 契约⑩ + ② 同钩子：resume 水位 prune（comms.pruneDedup / pipeline.pruneIdem）
    comms: {
      pruneDedup(seq: number): void {
        pruneDedupSeqs.push(seq);
      },
    },
    pipeline: {
      pruneIdem(seq: number): void {
        pruneIdemSeqs.push(seq);
      },
    },
  };

  const ledger: LedgerPort = {
    open: () => ({ created: true }),
    balance: () => 0,
    credit: () => {},
    debit: () => {},
    freeze: () => {},
    unfreeze: () => {},
  };

  let seq = 0;
  const idGen = (): string => `id-${++seq}`;

  const checkpointStore = {
    latest: () => ({ checkpointId: "cp-latest", seq: 9 }),
    get: (_agentId: string, checkpointId: string) => ({ checkpointId, seq: 12 }),
  };

  return {
    runRequests,
    dspCalls,
    loadSnapshotSeqs,
    buildModes,
    attachCount: () => attachCount,
    stopCount: () => stopCount,
    pruneDedupSeqs,
    pruneIdemSeqs,
    runner: runner as unknown as ConstructorParameters<typeof AgentRuntime>[0]["runner"],
    memory: memory as unknown as MemoryHost,
    ledger,
    idGen,
    checkpointStore: checkpointStore as unknown as CheckpointStore,
  };
}

function makeRuntime(f: ReturnType<typeof fresh>, opts: { withCheckpointStore?: boolean } = {}) {
  return new AgentRuntime({
    agentId: "ag-1",
    definition: DEFINITION,
    schedulerInstanceId: "sched-1",
    runner: f.runner,
    memory: f.memory,
    ledger: f.ledger,
    idGen: f.idGen,
    ...(opts.withCheckpointStore === false ? {} : { checkpointStore: f.checkpointStore }),
  });
}

// 1. run 自填身份字段（N-I1）：agentInstanceId/workLoopId/traceId 非空且绑定 definition
test("run 自填身份字段：绑定 definition + idGen 生成 traceId/executionId", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f, { withCheckpointStore: false });
  const result = await rt.run({
    task: "do the thing",
    config: { k: 2 },
    optimizationRoundId: "round-1",
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "completed");
  const req = f.runRequests[0];
  assert.ok(req, "runner.run 被调用");
  assert.equal(req.agentInstanceId, "ag-1");
  assert.equal(req.workLoopId, "wl-1");
  assert.equal(req.workLoopVersion, "v1");
  assert.equal(req.schedulerInstanceId, "sched-1");
  assert.ok(req.traceId.startsWith("id-"), `traceId 来自 idGen: ${req.traceId}`);
  assert.ok(req.executionId.startsWith("id-"), `executionId 来自 idGen: ${req.executionId}`);
  assert.notEqual(req.traceId, req.executionId);
  assert.equal(req.optimizationRoundId, "round-1");
  assert.deepEqual(req.config, { k: 2 });
  assert.equal(req.task, "do the thing");
  assert.ok(req.signal, "signal 透传");
});

test("run 缺省：optimizationRoundId 用哨兵 \"\"，config 用 definition.workLoop.config", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f, { withCheckpointStore: false });
  await rt.run({ task: "t" });
  const req = f.runRequests[0];
  assert.equal(req.optimizationRoundId, ROUND_SENTINEL);
  assert.deepEqual(req.config, DEFINITION.workLoop.config);
});

// 2. resume 委托 resumeFromCheckpointId
test("resume(checkpointId) 委托 resumeFromCheckpointId；task 无恢复文本 → \"\"", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f, { withCheckpointStore: false });
  await rt.resume("cp-1");
  const req = f.runRequests[0];
  assert.equal(req.resumeFromCheckpointId, "cp-1");
  assert.equal(req.task, "");
  // 身份自填与 run 一致
  assert.equal(req.agentInstanceId, "ag-1");
  assert.equal(req.workLoopId, "wl-1");
});

test("resume() 无参 → 经 checkpointStore.latest 解析 latest checkpoint", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f); // 带 checkpointStore
  await rt.resume();
  const req = f.runRequests[0];
  assert.equal(req.resumeFromCheckpointId, "cp-latest");
});

test("resume() 无 checkpointStore 依赖 → 不带 resumeFromCheckpointId（退化为新 run）", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f, { withCheckpointStore: false });
  await rt.resume();
  const req = f.runRequests[0];
  assert.equal(req.resumeFromCheckpointId, undefined);
});

// 6. 契约⑩ + ② 同钩子：resume 水位 prune（comms pruneDedup + idem pruneIdem，seq = resume 目标 checkpoint seq）
test("resume(checkpointId) prunes comms dedup + idem at target checkpoint seq", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f);   // 带 checkpointStore（get → seq 12）
  await rt.resume("cp-5");
  const req = f.runRequests[0];
  assert.equal(req.resumeFromCheckpointId, "cp-5");
  assert.deepEqual(f.pruneDedupSeqs, [12], "pruneDedup 用显式 checkpoint 的 seq");
  assert.deepEqual(f.pruneIdemSeqs, [12], "pruneIdem 用显式 checkpoint 的 seq");
});

test("resume() 无参 prunes at latest checkpoint seq", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f);   // latest → seq 9
  await rt.resume();
  const req = f.runRequests[0];
  assert.equal(req.resumeFromCheckpointId, "cp-latest");
  assert.deepEqual(f.pruneDedupSeqs, [9]);
  assert.deepEqual(f.pruneIdemSeqs, [9]);
});

test("resume() 无 checkpointStore → prune at seq 0（latest ?? 0）", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f, { withCheckpointStore: false });
  await rt.resume();
  const req = f.runRequests[0];
  assert.equal(req.resumeFromCheckpointId, undefined);
  assert.deepEqual(f.pruneDedupSeqs, [0]);
  assert.deepEqual(f.pruneIdemSeqs, [0]);
});

// 3. dispose 停止 sweeper（mock timer）
test("dispose 停止 sweeper（startSweeper 返回的停止函数被调用）", () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f, { withCheckpointStore: false });
  assert.equal(f.stopCount(), 0);
  rt.dispose();
  assert.equal(f.stopCount(), 1);
});

// 4. run 前 DSP restore 顺序（契约⑦：loadSnapshot(latest seq) → build("restore")；无快照回退 realtime）
test("run 前 DSP restore 顺序：先 loadSnapshot(latest seq) 后 build(\"restore\")", async () => {
  const f = fresh({ withLoadSnapshot: true });
  const rt = makeRuntime(f); // 带 checkpointStore（latest seq = 9）
  await rt.run({ task: "t" });
  assert.deepEqual(f.dspCalls, ["loadSnapshot", "build"], "先 loadSnapshot 后 build");
  assert.deepEqual(f.loadSnapshotSeqs, [9], "loadSnapshot 用 latest checkpoint seq");
  assert.deepEqual(f.buildModes, ["restore"]);
});

test("dsp 无 loadSnapshot（当前 DspBuilder 交付面）→ 回退 build(\"realtime\")", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f); // 带 checkpointStore
  await rt.run({ task: "t" });
  assert.deepEqual(f.buildModes, ["realtime"], "无 loadSnapshot → 无快照回退（新鲜检索）");
});

// 5. run 前序：memory.attachSdk 仅首次
test("attachSdk 首次语义：多次 run/resume 只 attach 一次", async () => {
  const f = fresh({ withLoadSnapshot: false });
  const rt = makeRuntime(f, { withCheckpointStore: false });
  await rt.run({ task: "a" });
  await rt.run({ task: "b" });
  await rt.resume("cp-1");
  assert.equal(f.attachCount(), 1, "attachSdk 仅首次调用");
});
