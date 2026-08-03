/**
 * pit-flow engine — 执行循环
 *
 * v1: 单链串行（makeRunFlow / makeResumeFlow）
 * v2: 波次并行（makeRunFlowV2 / makeResumeFlowV2）
 *
 * spawnAgent 抽象依赖注入（构造函数捕获），测试可 mock。
 */

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { FlowStore, ExecLock, Checkpoint, PendingPayload, WaveCheckpoint, EffectRecord } from "./store.js";
import { appendMetrics } from "./store.js";
import type { FlowDef, NodeDef, EdgeDef } from "./schema.js";
import { interpolate } from "./template.js";
import { evalExpr } from "./expr.js";
import { parseStateField, applyReducer, type StateFieldDef } from "./reducers.js";
import { resolveCodeFn } from "./code-registry.js";
import { hasEffect, resolveEffect } from "./effect-registry.js";
import { hasSubflow, resolveSubflow } from "./subflow-registry.js";

// ── Types ──────────────────────────────────────────────────────

export interface RunResult {
  status: "done" | "failed" | "waiting_human";
  error?: string;
}

export interface SpawnResult {
  output: string;
  exitCode: number;
  signal: string | null;
}

export interface SpawnAgent {
  (node: NodeDef, renderedPrompt: string, cwd: string, env: NodeJS.ProcessEnv): Promise<SpawnResult>;
}

// ── Engine ─────────────────────────────────────────────────────

export function makeRunFlow(spawnAgent: SpawnAgent) {
  return async function runFlow(store: FlowStore, runId: string): Promise<RunResult> {
    const meta = store.loadMeta(runId);
    const lock = store.acquireExecLock(runId);

    try {
      return await executeLoop(store, runId, meta.stepCount, spawnAgent, lock);
    } finally {
      // 不在 waiting_human 路径释放锁（human 路径已在 executeLoop 中释放）
      const currentMeta = store.loadMeta(runId);
      if (currentMeta.status !== "waiting_human") {
        lock.release();
      }
    }
  };
}

export function makeResumeFlow(spawnAgent: SpawnAgent) {
  return async function resumeFlow(store: FlowStore, runId: string): Promise<RunResult> {
    const meta = store.loadMeta(runId);

    // 只允许 waiting_human / failed / running-but-dead 状态 resume
    if (meta.status !== "waiting_human" && meta.status !== "failed" && meta.status !== "running") {
      throw new Error(`Cannot resume run "${runId}": status is "${meta.status}". Only waiting_human, failed, or running (but dead) runs can be resumed.`);
    }

    // 崩溃恢复路径：state.approved=true 已写但 checkpoint/clearPending 未完成
    if (meta.status === "waiting_human") {
      const pending = store.loadPending(runId);
      if (pending) {
        const state = store.loadState(runId);
        if (state.approved === true) {
          // 补应用 writes + checkpoint + clear pending
          applyWrites(state, pending.nodeSnapshot.writes as Record<string, string>, runId);
          store.saveState(runId, state);

          const cp: Checkpoint = {
            nodeId: pending.nodeId,
            graphVersion: pending.graphVersion,
            seq: meta.stepCount + 1,
            startedAt: pending.createdAt,
            finishedAt: Date.now(),
            status: "completed",
            output: "",
            stateAfter: { ...state },
          };
          store.writeCheckpoint(runId, cp);
          store.clearPending(runId);
          store.updateMeta(runId, { status: "running", stepCount: meta.stepCount + 1 });

          // 直接过 gate，继续循环
          const lock = store.acquireExecLock(runId);
          try {
            const resumedMeta = store.loadMeta(runId);
            return await executeLoop(store, runId, resumedMeta.stepCount, spawnAgent, lock);
          } finally {
            const currentMeta = store.loadMeta(runId);
            if (currentMeta.status !== "waiting_human") {
              lock.release();
            }
          }
        }
      }
    }

    // 正常 resume（waiting_human 但非崩溃恢复，或 failed/running-but-dead）
    const lock = store.acquireExecLock(runId);
    store.updateMeta(runId, { status: "running" });

    try {
      const currentMeta = store.loadMeta(runId);
      return await executeLoop(store, runId, currentMeta.stepCount, spawnAgent, lock);
    } finally {
      const currentMeta = store.loadMeta(runId);
      if (currentMeta.status !== "waiting_human") {
        lock.release();
      }
    }
  };
}

// ── 执行循环 ───────────────────────────────────────────────────

async function executeLoop(
  store: FlowStore,
  runId: string,
  stepCount: number,
  spawnAgent: SpawnAgent,
  _lock: ExecLock,
): Promise<RunResult> {
  const dir = store["runDir"](runId);
  const workspaceDir = path.join(dir, "workspace");

  // graphVersion 不一致警告
  const meta = store.loadMeta(runId);
  const latestCP = store.latestCheckpoint(runId);
  if (latestCP && meta.graphVersion !== latestCP.graphVersion) {
    console.warn(
      `[pit-flow] Warning: meta.graphVersion (${meta.graphVersion}) != latest checkpoint.graphVersion (${latestCP.graphVersion}). State may be from an older graph version.`,
    );
  }

  // 确定起始节点
  let currentNodeId: string | null = meta.status === "running" || meta.status === "failed"
    ? findNextFromCheckpoint(store, runId)
    : findEntryNode(store, runId);

  while (true) {
    // 死路检测：未找到下一节点
    if (!currentNodeId) {
      await failRun(store, runId, "dead end: no matching edge found from " + (store.latestCheckpoint(runId)?.nodeId ?? "entry"));
      return { status: "failed", error: "dead end: no matching edge" };
    }

    // maxSteps 检查
    if (stepCount >= (getMaxSteps(store, runId))) {
      await failRun(store, runId, `maxSteps (${getMaxSteps(store, runId)}) exceeded`);
      return { status: "failed", error: "maxSteps exceeded" };
    }

    // 终止节点
    if (currentNodeId === "end") {
      store.updateMeta(runId, { status: "done", stepCount });
      return { status: "done" };
    }

    // 获取当前图（出边求值用最新版）
    const graph = store.loadGraph(runId);
    const nodeDef = graph.nodes.find((n) => n.id === currentNodeId);
    if (!nodeDef) {
      await failRun(store, runId, `node "${currentNodeId}" not found in graph (may have been removed while running)`);
      return { status: "failed", error: `node "${currentNodeId}" not found` };
    }

    // 节点定义进入时快照（deep clone）
    const nodeSnapshot = JSON.parse(JSON.stringify(nodeDef)) as NodeDef;

    // 执行节点
    if (nodeSnapshot.type === "agent") {
      const state = store.loadState(runId);
      const input = meta.input;
      const renderedPrompt = interpolate(nodeSnapshot.prompt ?? "", { state, input });

      const nodeCwd = nodeSnapshot.cwd
        ? path.join(workspaceDir, nodeSnapshot.cwd)
        : workspaceDir;
      fs.mkdirSync(nodeCwd, { recursive: true });

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (nodeSnapshot.template) {
        // 尝试 resolves template for PI_CODING_AGENT_DIR
        try {
          const { resolveTemplateId, resolveDataDir } = await import("../config.js");
          const config = (await import("../config.js")).loadConfig();
          const resolved = resolveTemplateId(nodeSnapshot.template, config);
          if (resolved.ok) {
            const dataDir = resolveDataDir(config);
            env.PI_CODING_AGENT_DIR = path.resolve(dataDir, "pi-config", resolved.id);
            env.PI_TEMPLATE = resolved.id;
          }
        } catch {
          // config unavailable — continue without template env
        }
      }

      const { output, exitCode, signal } = await spawnAgent(nodeSnapshot, renderedPrompt, nodeCwd, env);

      const startedAt = Date.now();
      const finishedAt = Date.now();

      if (exitCode !== 0 || signal) {
        const cp: Checkpoint = {
          nodeId: currentNodeId,
          graphVersion: meta.graphVersion,
          seq: stepCount + 1,
          startedAt,
          finishedAt,
          status: "failed",
          output,
          stateAfter: { ...store.loadState(runId) },
        };
        store.writeCheckpoint(runId, cp);

        await failRun(store, runId, `agent node "${currentNodeId}" failed: exit=${exitCode} signal=${signal ?? "none"}`);
        return { status: "failed", error: `agent "${currentNodeId}" failed` };
      }

      // 应用 writes（快照版本）
      const stateAfter = store.loadState(runId);
      applyWrites(stateAfter, nodeSnapshot.writes ?? {}, output);
      store.saveState(runId, stateAfter);

      stepCount++;

      const cp: Checkpoint = {
        nodeId: currentNodeId,
        graphVersion: meta.graphVersion,
        seq: stepCount,
        startedAt,
        finishedAt,
        status: "completed",
        output,
        stateAfter: { ...stateAfter },
      };
      store.writeCheckpoint(runId, cp);
      store.updateMeta(runId, { stepCount });

      // 出边求值用完成时的 graph.json
      const latestGraph = store.loadGraph(runId);
      currentNodeId = evaluateEdges(currentNodeId, latestGraph.edges, state);

    } else if (nodeSnapshot.type === "human") {
      const state = store.loadState(runId);
      const renderedMessage = interpolate(nodeSnapshot.message ?? "", { state, input: meta.input });

      // 写 pending（含进入时快照 + graphVersion）
      const pending: PendingPayload = {
        nodeId: currentNodeId,
        graphVersion: meta.graphVersion,
        nodeSnapshot: nodeSnapshot as unknown as Record<string, unknown>,
        message: renderedMessage,
        createdAt: Date.now(),
      };
      store.writePending(runId, pending);
      store.updateMeta(runId, { status: "waiting_human" });

      // 释放锁，退出进程
      _lock.release();
      return { status: "waiting_human" };
    } else {
      // code 节点仅 v2 引擎支持（spec: 兼容性约束）；effect 节点同理（v1 报同错）
      await failRun(store, runId, `node "${currentNodeId}": code nodes require v2 engine`);
      return { status: "failed", error: `node "${currentNodeId}": code nodes require v2 engine` };
    }
  }
}

// ── V2 Engine (waves) ──────────────────────────────────────────

export function makeRunFlowV2(spawnAgent: SpawnAgent) {
  return async function runFlowV2(store: FlowStore, runId: string): Promise<RunResult> {
    const meta = store.loadMeta(runId);
    const lock = store.acquireExecLock(runId);

    try {
      return await executeWaveLoop(store, runId, lock, spawnAgent);
    } finally {
      const currentMeta = store.loadMeta(runId);
      if (currentMeta.status !== "waiting_human" && currentMeta.status !== "editing") {
        lock.release();
      }
    }
  };
}

export function makeResumeFlowV2(spawnAgent: SpawnAgent) {
  return async function resumeFlowV2(store: FlowStore, runId: string): Promise<RunResult> {
    const meta = store.loadMeta(runId);

    // editing → resume (barrier): clear flags, validate, continue
    if (meta.status === "editing") {
      // Apply pending edits
      if (meta.pendingEdits && meta.pendingEdits.length > 0) {
        for (const edit of meta.pendingEdits) {
          applyPendingEdit(store, runId, edit);
        }
      }
      // Handle stale human pending: discard and re-enter with current graph
      const pending = store.loadPending(runId);
      if (pending) {
        store.clearPending(runId);
        // Will re-enter human node from current graph
      }
      // Clear barrier state
      store.updateMeta(runId, {
        status: "running",
        editRequested: false,
        editBaseWave: undefined,
        pendingEdits: undefined,
      });

      const lock = store.acquireExecLock(runId);
      try {
        return await executeWaveLoop(store, runId, lock, spawnAgent);
      } finally {
        const m = store.loadMeta(runId);
        if (m.status !== "waiting_human" && m.status !== "editing") lock.release();
      }
    }

    // waiting_human, failed, running-but-dead: v1 compatible paths
    // waiting_human: crash recovery or normal human gate
    if (meta.status === "waiting_human") {
      const pending = store.loadPending(runId);
      if (pending) {
        const state = store.loadState(runId);
        // approve 与 reject 同理：approved 为布尔即表示门已决策，完成该 human 节点
        if (typeof state.approved === "boolean") {
          // Crash-recovery: apply pending writes + checkpoint + clear
          applyWrites(state, pending.nodeSnapshot.writes as Record<string, string>, "");
          store.saveState(runId, state);
          const cp: Checkpoint = {
            nodeId: pending.nodeId,
            graphVersion: pending.graphVersion,
            seq: meta.stepCount + 1,
            startedAt: pending.createdAt,
            finishedAt: Date.now(),
            status: "completed",
            output: "",
            stateAfter: { ...state },
          };
          store.writeCheckpoint(runId, cp);
          store.clearPending(runId);
          // Bump firedEpoch
          incrementFiredEpoch(store, runId, pending.nodeId);
          store.updateMeta(runId, { status: "running", stepCount: meta.stepCount + 1 });

          const lock = store.acquireExecLock(runId);
          try {
            return await executeWaveLoop(store, runId, lock, spawnAgent);
          } finally {
            const m = store.loadMeta(runId);
            if (m.status !== "waiting_human" && m.status !== "editing") lock.release();
          }
        }
      }
    }

    // Normal resume: failed or running-but-dead
    const lock = store.acquireExecLock(runId);
    store.updateMeta(runId, { status: "running" });
    try {
      return await executeWaveLoop(store, runId, lock, spawnAgent);
    } finally {
      const m = store.loadMeta(runId);
      if (m.status !== "waiting_human" && m.status !== "editing") lock.release();
    }
  };
}

// ── Wave execution loop ───────────────────────────────────────

async function executeWaveLoop(
  store: FlowStore,
  runId: string,
  lock: ExecLock,
  spawnAgent: SpawnAgent,
  _resumeFromWave?: number,
): Promise<RunResult> {
  const dir = store["runDir"](runId);
  const workspaceDir = path.join(dir, "workspace");
  // 本执行进程内失败的节点不再重试（防无限重试）；外部 resume（新进程）可重跑
  const failedThisRun = new Set<string>();
  // 本波成功执行的 effect 幂等记录（波末随 state/checkpoint 原子落库）
  const pendingEffectRecords = new Map<string, EffectRecord>();

  // Ensure epoch state is initialized
  let meta = store.loadMeta(runId);
  if (!meta.firedEpoch) store.updateMeta(runId, { firedEpoch: {} });
  if (!meta.consumed) store.updateMeta(runId, { consumed: {} });

  let waveSeq = (store.latestWaveCheckpoint(runId)?.waveSeq ?? 0) + 1;

  // Resume from wave checkpoint: recover epoch (merge: keep max of existing + checkpoint)
  const lastWave = store.latestWaveCheckpoint(runId);
  if (lastWave) {
    const existingFired = meta.firedEpoch ?? {};
    const existingConsumed = meta.consumed ?? {};
    const mergedFired: Record<string, number> = {};
    const mergedConsumed: Record<string, number> = {};
    for (const k of new Set([...Object.keys(existingFired), ...Object.keys(lastWave.epochSnapshot.fired)])) {
      mergedFired[k] = Math.max(existingFired[k] ?? 0, lastWave.epochSnapshot.fired[k] ?? 0);
    }
    for (const k of new Set([...Object.keys(existingConsumed), ...Object.keys(lastWave.epochSnapshot.consumed)])) {
      mergedConsumed[k] = Math.max(existingConsumed[k] ?? 0, lastWave.epochSnapshot.consumed[k] ?? 0);
    }
    store.updateMeta(runId, {
      firedEpoch: mergedFired,
      consumed: mergedConsumed,
    });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    meta = store.loadMeta(runId);
    const graph = store.loadGraph(runId);

    // Find ready nodes
    const activeCandidates = findAllActiveTargets(graph, store, runId);
    const ready = findReadyNodes(graph, meta.firedEpoch ?? {}, meta.consumed ?? {}, activeCandidates)
      .filter((nid) => !failedThisRun.has(nid));

    // Initialize mutable epoch copies for this wave
    const firedEpoch = { ...(meta.firedEpoch ?? {}) };
    const consumed = { ...(meta.consumed ?? {}) };
    const preWaveConsumed = { ...consumed };  // 失败节点回滚用

    // Consume inbound edges for all ready nodes (they're about to execute)
    for (const target of ready) {
      const tDef = graph.nodes.find((n) => n.id === target);
      if (!tDef || target === "end") continue;
      for (const edge of graph.edges) {
        if (edge.to !== target) continue;
        const pred = edge.from;
        const edgeKey = `${pred}→${target}`;
        const c = consumed[edgeKey] ?? 0;
        const f = firedEpoch[pred] ?? 0;
        if (f > c) consumed[edgeKey] = f;
      }
    }
    // Persist consumed immediately (human gate waves exit before merge)
    store.updateMeta(runId, { consumed });

    if (ready.length === 0) {
      // Check for hunger
      if (activeCandidates.length > 0) {
        // I2 裁决：allFailed 语义扩展为“所有 active candidate 在本进程内均已失败”。
        // 动机：scenario ③（drain 失败后重试仍全部失败）需要把真实失败原因传播出去，
        // 而不是饥饿；静态分析显示既有 hunger 测试不依赖旧的“全部节点都曾失败过”语义。
        const allFailed = activeCandidates.every((t) => failedThisRun.has(t));
        if (allFailed) {
          const latestWc = store.latestWaveCheckpoint(runId);
          let failedOutput: string | undefined;
          if (latestWc?.partialFailures && latestWc.partialFailures.length > 0) {
            const failedNodeId = latestWc.partialFailures[0]!;
            const cps = store.listCheckpoints(runId).filter(
              (c) => c.nodeId === failedNodeId && c.status === "failed",
            );
            failedOutput = cps.length > 0 ? cps[cps.length - 1]!.output : undefined;
          }
          const error = failedOutput ?? "flow failed";
          await failRunV2(store, runId, error, lock);
          return { status: "failed", error };
        }

        const blocked: string[] = [];
        for (const t of activeCandidates) {
          if (!ready.includes(t)) {
            const nodeDef = graph.nodes.find((n) => n.id === t);
            const needs = nodeDef?.needs ?? [];
            const missing = needs.filter((p) => {
              const consumed = meta.consumed?.[`${p}→${t}`] ?? 0;
              const fired = meta.firedEpoch?.[p] ?? 0;
              return consumed >= fired;
            });
            if (missing.length > 0) {
              blocked.push(`${t}(missing: ${missing.join(",")})`);
            }
          }
        }
        const msg = `needs hunger: candidates exist but none ready. ${blocked.join("; ")}`;
        await failRunV2(store, runId, msg, lock);
        return { status: "failed", error: msg };
      }
      // No active candidates and no ready → done
      store.updateMeta(runId, { status: "done" });
      return { status: "done" };
    }

    // Check maxSteps
    if (meta.stepCount >= (graph.maxSteps ?? 100)) {
      await failRunV2(store, runId, `maxSteps (${graph.maxSteps ?? 100}) exceeded`, lock);
      return { status: "failed", error: "maxSteps exceeded" };
    }

    // Execute wave: parallel spawn
    const waveStartedAt = Date.now();
    const maxParallel = graph.maxParallel ?? 4;
    const nodeResults: Map<string, { ok: boolean; output: string; exitCode: number; signal: string | null }> = new Map();

    // Capture pre-wave state (nodes in same wave must NOT see each other's outputs)
    const preWaveState = store.loadState(runId);

    // Split into batches of maxParallel (scheduling only, merge at wave end)
    const batches: string[][] = [];
    for (let i = 0; i < ready.length; i += maxParallel) {
      batches.push(ready.slice(i, i + maxParallel));
    }

    for (const batch of batches) {
      const batchPromises = batch.map(async (nodeId) => {
        const nodeDef = graph.nodes.find((n) => n.id === nodeId);
        if (!nodeDef) {
          nodeResults.set(nodeId, { ok: false, output: "", exitCode: -1, signal: "node not found" });
          return;
        }
        const nodeSnapshot = JSON.parse(JSON.stringify(nodeDef)) as NodeDef;

        if (nodeSnapshot.type === "human") {
          const renderedMessage = interpolate(nodeSnapshot.message ?? "", { state: preWaveState, input: meta.input });
          const pending: PendingPayload = {
            nodeId,
            graphVersion: meta.graphVersion,
            nodeSnapshot: nodeSnapshot as unknown as Record<string, unknown>,
            message: renderedMessage,
            createdAt: Date.now(),
          };
          store.writePending(runId, pending);
          store.updateMeta(runId, { status: "waiting_human" });
          lock.release();
          nodeResults.set(nodeId, { ok: true, output: "", exitCode: 0, signal: null });
          return;
        }

        // Effect node: same-process deterministic side effect（幂等保护）
        if (nodeSnapshot.type === "effect") {
          const fnName = nodeSnapshot.effect ?? "";
          if (!hasEffect(fnName)) {
            nodeResults.set(nodeId, { ok: false, output: `effect not registered: ${fnName}`, exitCode: -1, signal: "effect not registered" });
            return;
          }
          const argNames = nodeSnapshot.args ?? Object.keys(preWaveState);
          const idempotencyKey = computeIdempotencyKey(nodeId, fnName, argNames, preWaveState);
          // 幂等检测：flow_effects 已有记录 → skip（输出 = 存储的 result_summary）
          const existingRecord = store.loadEffectRecords(runId).find(
            (r) => r.nodeId === nodeId && r.idempotencyKey === idempotencyKey,
          );
          if (existingRecord) {
            nodeResults.set(nodeId, { ok: true, output: existingRecord.resultSummary, exitCode: 0, signal: null });
            return;
          }
          const fn = resolveEffect(fnName);
          try {
            // state 传浅拷贝：防 fn 运行时篡改污染波状态（同波后续节点/波末 reducer 初值）
            const result = await fn({ state: { ...preWaveState }, runId, nodeId, idempotencyKey, log: () => {} });
            const output = JSON.stringify(result ?? null);
            pendingEffectRecords.set(nodeId, {
              flowRunId: runId,
              nodeId,
              idempotencyKey,
              resultSummary: output,
              createdAt: Date.now(),
            });
            nodeResults.set(nodeId, { ok: true, output, exitCode: 0, signal: null });
          } catch (err: any) {
            nodeResults.set(nodeId, { ok: false, output: err?.message ?? String(err), exitCode: -1, signal: "effect fn threw" });
          }
          return;
        }

        // Code node: same-process deterministic execution（纯函数 + 只读 state）
        if (nodeSnapshot.type === "code") {
          const fn = resolveCodeFn(nodeSnapshot.fn ?? "");
          if (!fn) {
            nodeResults.set(nodeId, { ok: false, output: `code fn not registered: ${nodeSnapshot.fn}`, exitCode: -1, signal: "code fn not registered" });
            return;
          }
          const argNames = nodeSnapshot.args ?? Object.keys(preWaveState);
          const args: Record<string, unknown> = {};
          for (const k of argNames) args[k] = preWaveState[k];
          try {
            // state 传浅拷贝：防 fn 运行时篡改污染波状态（同波后续节点/波末 reducer 初值）
            const result = await fn(args, { state: { ...preWaveState }, runId, nodeId, log: () => {} });
            const output = JSON.stringify(result ?? null);
            nodeResults.set(nodeId, { ok: true, output, exitCode: 0, signal: null });
          } catch (err: any) {
            nodeResults.set(nodeId, { ok: false, output: err?.message ?? String(err), exitCode: -1, signal: "code fn threw" });
          }
          return;
        }

        // Fanout node: expand into multiple item branches
        if (nodeSnapshot.type === "fanout") {
          const fanoutId = nodeId;
          const itemsFrom = nodeSnapshot.itemsFrom ?? "items";
          const bodyNodes = nodeSnapshot.body ?? [];
          const maxFanout = nodeSnapshot.maxFanout ?? 32;

          // Resume path: use the snapshot captured on the first wave.
          const snapshot = store.getFanoutSnapshot(runId, fanoutId);
          const items: unknown[] = snapshot !== undefined ? snapshot : (preWaveState[itemsFrom] as unknown[] ?? []);

          // Validate items length
          if (items.length > maxFanout) {
            nodeResults.set(nodeId, {
              ok: false,
              output: `fanout "${fanoutId}": ${items.length} items exceed maxFanout of ${maxFanout}. Increase maxFanout or truncate items.`,
              exitCode: -1,
              signal: "fanout: items exceed maxFanout",
            });
            return;
          }

          // Store snapshot for resume (write to meta) — idempotent; first wave wins.
          store.setFanoutSnapshot(runId, fanoutId, items as unknown[]);

          // Execute body for each item. Branch failures are isolated: the failed
          // branch produces no element, but the fanout node itself succeeds so the
          // flow can continue.
          const results: unknown[] = [];

          for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];

            // Per-item state: inject nested `{ [fanoutId]: { item } }` so that
            // `{{state.fanoutId.item}}` resolves naturally via the existing path
            // interpolation, and `{{fanoutId.item}}` reads the same nested value.
            const itemState: Record<string, unknown> = { ...preWaveState, [fanoutId]: { item } };

            let branchOk = true;
            for (const bodyNodeDef of bodyNodes) {
              const bodyNodeSnapshot = JSON.parse(JSON.stringify(bodyNodeDef)) as NodeDef;

              // Render prompt from item-scoped state for agent-like bodies.
              const bodyPrompt = interpolate(bodyNodeSnapshot.prompt ?? "", { state: itemState, input: meta.input });
              const bodyCwd = bodyNodeSnapshot.cwd
                ? path.join(workspaceDir, bodyNodeSnapshot.cwd)
                : workspaceDir;
              fs.mkdirSync(bodyCwd, { recursive: true });

              let bodyOutput: string;
              let bodyOk: boolean;
              try {
                const spawnRes = await spawnAgent(bodyNodeSnapshot, bodyPrompt, bodyCwd, process.env);
                bodyOutput = spawnRes.output;
                bodyOk = spawnRes.exitCode === 0 && spawnRes.signal === null;
              } catch (err: any) {
                bodyOutput = err?.message ?? String(err);
                bodyOk = false;
              }

              if (!bodyOk) {
                branchOk = false;
                break;
              }

              // Apply body-node writes into the per-item state.
              const bodyWrites = bodyNodeSnapshot.writes ?? {};
              const resolvedState = applyFanoutBodyWrites(bodyWrites, itemState, bodyOutput, idx, item, fanoutId);
              Object.assign(itemState, resolvedState);
            }

            if (branchOk) {
              // Collect the branch result: explicit `${fanoutId}.result` write wins,
              // otherwise fall back to the original item.
              const result = itemState[`${fanoutId}.result`] ?? item;
              results.push(result);
            }
            // Failed branches do not emit anything (failure isolation).
          }

          const output = JSON.stringify(results);
          nodeResults.set(nodeId, {
            ok: true,
            output,
            exitCode: 0,
            signal: null,
          });
          return;
        }

        // Subflow node: execute a nested flow in a new run, map inputs/outputs
        if (nodeSnapshot.type === "subflow") {
          // 已知限制（I1）：嵌套 resume = 各层按自身 checkpoint 独立恢复；
          // 父 resume 不重连既有子 run（human 节点的子 flow 进度不跨父 resume 保留）。
          const subflowId = nodeId;
          const flowRef = nodeSnapshot.flow;
          let childDef: FlowDef;

          if (typeof flowRef === "string") {
            if (!hasSubflow(flowRef)) {
              nodeResults.set(nodeId, {
                ok: false,
                output: `subflow not registered: ${flowRef}`,
                exitCode: -1,
                signal: "subflow not registered",
              });
              return;
            }
            childDef = resolveSubflow(flowRef);
          } else if (flowRef && typeof flowRef === "object" && !Array.isArray(flowRef)) {
            childDef = flowRef as FlowDef;
          } else {
            nodeResults.set(nodeId, {
              ok: false,
              output: `subflow "${subflowId}": missing or invalid flow`,
              exitCode: -1,
              signal: "subflow invalid",
            });
            return;
          }

          // Create child run in the same store; checkpoints are isolated per run.
          // 持久化父 runId 关联，满足 subflow 子图审计/追踪契约。
          const childRunId = store.createRun(childDef, meta.input, runId);
          const childState = store.loadState(childRunId);

          // Apply in mapping: parent state key -> child state key
          const inMap = nodeSnapshot.in ?? {};
          for (const [parentKey, childKey] of Object.entries(inMap)) {
            childState[childKey] = preWaveState[parentKey];
          }
          store.saveState(childRunId, childState);

          // Execute child flow recursively using the same spawnAgent dependency.
          const runChild = makeRunFlowV2(spawnAgent);
          const childResult = await runChild(store, childRunId);

          if (childResult.status === "done") {
            const childFinalState = store.loadState(childRunId);
            nodeResults.set(nodeId, {
              ok: true,
              output: JSON.stringify(childFinalState),
              exitCode: 0,
              signal: null,
            });
          } else if (childResult.status === "waiting_human") {
            // Propagate human gate to parent. Parent releases its lock; the subflow
            // node is not checkpointed, so parent resume will re-enter this node.
            store.updateMeta(runId, { status: "waiting_human" });
            lock.release();
            nodeResults.set(nodeId, {
              ok: false,
              output: "subflow waiting for human",
              exitCode: -1,
              signal: "subflow waiting_human",
            });
          } else {
            nodeResults.set(nodeId, {
              ok: false,
              output: childResult.error ?? `subflow "${subflowId}" failed`,
              exitCode: -1,
              signal: "subflow failed",
            });
          }
          return;
        }

        // Agent node: render from pre-wave state
        const renderedPrompt = interpolate(nodeSnapshot.prompt ?? "", { state: preWaveState, input: meta.input });
        const nodeCwd = nodeSnapshot.cwd
          ? path.join(workspaceDir, nodeSnapshot.cwd)
          : workspaceDir;
        fs.mkdirSync(nodeCwd, { recursive: true });

        const env: NodeJS.ProcessEnv = { ...process.env };
        if (nodeSnapshot.template) {
          try {
            const { resolveTemplateId, resolveDataDir } = await import("../config.js");
            const config = (await import("../config.js")).loadConfig();
            const resolved = resolveTemplateId(nodeSnapshot.template, config);
            if (resolved.ok) {
              const dataDir = resolveDataDir(config);
              env.PI_CODING_AGENT_DIR = path.resolve(dataDir, "pi-config", resolved.id);
              env.PI_TEMPLATE = resolved.id;
            }
          } catch {
            console.error("[flow] 模板环境注入失败 — 无法设置 PI_CODING_AGENT_DIR / PI_TEMPLATE，节点将在无模板上下文环境中运行");
          }
        }

        const nodeStartedAt = Date.now();
        let result: SpawnResult;
        try {
          result = await spawnAgent(nodeSnapshot, renderedPrompt, nodeCwd, env);
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          result = {
            output: "",
            exitCode: -1,
            signal: /ENOENT/.test(msg) ? "spawn 失败：pi CLI 未安装或不在 PATH 中（运行 pit doctor 检查）" : msg,
          };
        }
        const nodeFinishedAt = Date.now();

        const ok = result.exitCode === 0 && result.signal === null;
        nodeResults.set(nodeId, {
          ok,
          output: result.output,
          exitCode: result.exitCode,
          signal: result.signal,
        });
      });

      await Promise.allSettled(batchPromises);

      // Check for human pause
      const currentMeta = store.loadMeta(runId);
      if (currentMeta.status === "waiting_human") {
        return { status: "waiting_human" };
      }
    }

    // Fanout configuration errors (e.g. items > maxFanout) should fail the run
    // immediately with a clear message, rather than leaving the graph hungry.
    for (const nodeId of ready) {
      const r = nodeResults.get(nodeId);
      if (!r?.ok) {
        const nodeDef = graph.nodes.find((n) => n.id === nodeId);
        if (nodeDef?.type === "fanout") {
          await failRunV2(store, runId, r?.output ?? `fanout "${nodeId}" failed`, lock);
          return { status: "failed", error: r?.output ?? `fanout "${nodeId}" failed` };
        }
      }
    }

    const waveFinishedAt = Date.now();

    // Collect writing nodes for reducer merge (nodeId order for determinism)
    const sortedReady = [...ready].sort();

    // Start with pre-wave state
    const mergedState = JSON.parse(JSON.stringify(preWaveState)) as Record<string, unknown>;

    // Collect bare (last-wins) and reducer writes
    const reducerAdditions: Record<string, Array<{ node: string; value: unknown }>> = {};
    const bareAdditions: Record<string, Array<{ node: string; value: unknown }>> = {};
    const incrementAdditions: Record<string, Array<{ node: string }>> = {};

    for (const nodeId of sortedReady) {
      const r = nodeResults.get(nodeId);
      if (!r?.ok) continue;
      const nodeDef = graph.nodes.find((n) => n.id === nodeId);
      if (!nodeDef) continue;
      const nodeSnapshot = JSON.parse(JSON.stringify(nodeDef)) as NodeDef;

      for (const [writeKey, writeVal] of Object.entries(nodeSnapshot.writes ?? {})) {
        // {{increment:state.x}}
        if (writeVal.startsWith("{{increment:state.")) {
          if (!incrementAdditions[writeKey]) incrementAdditions[writeKey] = [];
          incrementAdditions[writeKey].push({ node: nodeId });
          continue;
        }
        const resolved = resolveWriteValue(writeKey, writeVal, r.output);
        if (resolved === undefined) continue;

        const fieldDefs = graph.state ? parseStateField(graph.state[writeKey]) : { initial: undefined, reducer: "last-wins" as const };
        if (fieldDefs.reducer !== "last-wins") {
          if (!reducerAdditions[writeKey]) reducerAdditions[writeKey] = [];
          reducerAdditions[writeKey].push({ node: nodeId, value: resolved });
        } else {
          if (!bareAdditions[writeKey]) bareAdditions[writeKey] = [];
          bareAdditions[writeKey].push({ node: nodeId, value: resolved });
        }
      }

      firedEpoch[nodeId] = (firedEpoch[nodeId] ?? 0) + 1;
    }

    // Apply state changes: first increments (deterministic, nodeId order, serial)
    for (const [key, additions] of Object.entries(incrementAdditions)) {
      let current = (typeof mergedState[key] === "number" ? mergedState[key] : 0) as number;
      for (const { node } of [...additions].sort((a, b) => a.node.localeCompare(b.node))) {
        current = (typeof current === "number" ? current : 0) + 1;
      }
      mergedState[key] = current;
    }

    // Apply bare (last-wins) keys: last by nodeId order
    for (const [key, additions] of Object.entries(bareAdditions)) {
      if (additions.length > 0) {
        const sorted = [...additions].sort((a, b) => a.node.localeCompare(b.node));
        mergedState[key] = sorted[sorted.length - 1]!.value;
      }
    }

    // Apply reducer-based keys
    for (const [key, additions] of Object.entries(reducerAdditions)) {
      const fieldDefs = graph.state ? parseStateField(graph.state[key]) : { initial: undefined, reducer: "last-wins" as const };
      const current = preWaveState[key];
      mergedState[key] = applyReducer(fieldDefs.reducer, current, additions);
    }

    // Fanout nodes materialise their collected result arrays directly into the
    // configured `out` state key.
    for (const nodeId of sortedReady) {
      const r = nodeResults.get(nodeId);
      if (!r?.ok) continue;
      const nodeDef = graph.nodes.find((n) => n.id === nodeId);
      if (nodeDef?.type !== "fanout") continue;
      const outKey = (nodeDef.out as string | undefined) ?? "results";
      try {
        mergedState[outKey] = JSON.parse(r.output) as unknown[];
      } catch {
        mergedState[outKey] = [];
      }
    }

    // Subflow nodes materialise out mappings: child state key -> parent state key.
    for (const nodeId of sortedReady) {
      const r = nodeResults.get(nodeId);
      if (!r?.ok) continue;
      const nodeDef = graph.nodes.find((n) => n.id === nodeId);
      if (nodeDef?.type !== "subflow") continue;
      const outMap = nodeDef.out;
      if (typeof outMap !== "object" || !outMap || Array.isArray(outMap)) continue;
      const outMapTyped = outMap as Record<string, string>;
      let childState: Record<string, unknown>;
      try {
        childState = JSON.parse(r.output) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [childKey, parentKey] of Object.entries(outMapTyped)) {
        mergedState[parentKey] = childState[childKey];
      }
    }

    // effect 幂等记录先落库，再写 state（保证幂等记录与 checkpoint 一起持久化）
    if (pendingEffectRecords.size > 0) {
      store.appendEffectRecords(runId, [...pendingEffectRecords.values()]);
      pendingEffectRecords.clear();
    }

    store.saveState(runId, mergedState);

    // Update stepCount and rewrite node checkpoints with correct seq + stateAfter
    const finalState = store.loadState(runId);
    const newStepCount = meta.stepCount + ready.length;
    const partialFailures = [...ready].filter((nid) => !(nodeResults.get(nid)?.ok ?? false));

    // 失败节点回滚入边消费（外部 resume 时因入边有未消费完成而重新就绪重跑）；
    // 同时记入 failedThisRun——本进程内不再重试
    for (const failedId of partialFailures) {
      failedThisRun.add(failedId);
      for (const edge of graph.edges) {
        if (edge.to !== failedId) continue;
        const edgeKey = `${edge.from}→${failedId}`;
        if (edgeKey in preWaveConsumed || edgeKey in consumed) {
          consumed[edgeKey] = preWaveConsumed[edgeKey] ?? 0;
        }
      }
    }

    // Rewrite node checkpoints with proper seq and stateAfter
    let seqCounter = meta.stepCount;
    for (const nodeId of sortedReady) {
      seqCounter++;
      const r = nodeResults.get(nodeId);
      if (!r) continue;
      const cp: Checkpoint = {
        nodeId,
        graphVersion: meta.graphVersion,
        seq: seqCounter,
        startedAt: waveStartedAt,
        finishedAt: waveFinishedAt,
        status: r.ok ? "completed" : "failed",
        output: r.output,
        stateAfter: { ...finalState },
      };
      store.writeCheckpoint(runId, cp);

      // metrics 事件记录：只声明 + 记录（零经济依赖），seq = 该节点 checkpoint 的 seq
      if (r.ok) {
        const nodeDef = graph.nodes.find((n) => n.id === nodeId);
        if (nodeDef?.metrics) {
          const result: unknown = (() => {
            if (nodeDef.type === "code" || nodeDef.type === "effect") {
              try { return JSON.parse(r.output) as unknown; } catch { return r.output; }
            }
            return r.output;
          })();
          appendMetrics(store, runId, {
            seq: seqCounter,
            nodeId,
            graphVersion: meta.graphVersion,
            metrics: renderMetrics(nodeDef.metrics, { state: finalState, input: meta.input, result }),
            timestamp: Date.now(),
          });
        }
      }
    }

    // Write wave checkpoint (always, including drain waves)
    const wc: WaveCheckpoint = {
      waveSeq,
      nodes: [...ready],
      startedAt: waveStartedAt,
      finishedAt: waveFinishedAt,
      stateAfter: { ...finalState },
      graphVersion: meta.graphVersion,
      epochSnapshot: { fired: { ...firedEpoch }, consumed: { ...consumed } },
      partialFailures,
    };
    store.writeWaveCheckpoint(runId, wc);

    // Persist epoch
    store.updateMeta(runId, {
      firedEpoch,
      consumed,
      stepCount: newStepCount,
    });

    // Check editRequested barrier
    const updatedMeta = store.loadMeta(runId);
    if (updatedMeta.editRequested) {
      store.updateMeta(runId, {
        status: "editing",
        editBaseWave: waveSeq,
      });
      lock.release();
      return { status: "done" }; // signal: stopped at barrier, but run is in editing state
    }

    waveSeq++;
  }
}

// ── V2 Helpers ───────────────────────────────────────────────

/** Find all target nodes that should be activated from ALL completed nodes in the graph */
function findAllActiveTargets(graph: FlowDef, store: FlowStore, runId: string): string[] {
  const meta = store.loadMeta(runId);
  const firedEpoch = meta.firedEpoch ?? {};
  const consumed = meta.consumed ?? {};
  const state = store.loadState(runId);
  const targets = new Set<string>();

  // Entry node: always active if not yet fired (run start)
  if (!(graph.entry in firedEpoch)) {
    targets.add(graph.entry);
  }

  // Find all nodes that have un-consumed completions (outgoing edges to propagate)
  for (const nodeDef of graph.nodes) {
    const nodeId = nodeDef.id;
    const f = firedEpoch[nodeId] ?? 0;
    if (f === 0) continue; // hasn't fired

    const outTargets = findAllOutTargets(graph, nodeId, state);
    for (const t of outTargets) {
      const edgeKey = `${nodeId}→${t}`;
      const c = consumed[edgeKey] ?? 0;
      const f = firedEpoch[nodeId] ?? 0;
      if (f > c) {
        if (t !== "end") targets.add(t);
      }
    }
  }

  // Also add "end" if any completed node has an edge to "end"
  // (end is not a real node, just a sentinel)
  for (const nodeDef of graph.nodes) {
    const nodeId = nodeDef.id;
    const allOut = findAllOutTargets(graph, nodeId, state);
    if (allOut.length === 0) {
      // This node has no activated edges → dead end for this node
      // But other nodes might still activate targets
    }
  }

  return [...targets];
}

/** Find all target nodes reachable from a source via edge evaluation */
function findAllOutTargets(graph: FlowDef, nodeId: string, state: Record<string, unknown>): string[] {
  // Check if node is end or nonexistent
  const nodeDef = graph.nodes.find((n) => n.id === nodeId);
  if (!nodeDef && nodeId !== graph.entry) return [];

  const whenMatches: string[] = [];
  const unconditionals: string[] = [];

  for (const edge of graph.edges) {
    if (edge.from !== nodeId) continue;
    if (edge.when) {
      // 表达式错误（如未加引号的字符串字面量）直接抛出——静默跳过会让图走死路且无法排查
      if (evalExpr(edge.when, state)) {
        whenMatches.push(edge.to);
      }
    } else {
      unconditionals.push(edge.to);
    }
  }

  if (whenMatches.length > 0) return whenMatches; // when fan-out
  return unconditionals; // fallback：所有无条件边全部触发（fan-out）
}

/** Pure counter-based ready detection */
function findReadyNodes(
  graph: FlowDef,
  firedEpoch: Record<string, number>,
  consumed: Record<string, number>,
  activeCandidates: string[],
): string[] {
  const ready: string[] = [];

  for (const target of activeCandidates) {
    if (target === "end") continue; // end is implicit

    const nodeDef = graph.nodes.find((n) => n.id === target);
    if (!nodeDef) continue;

    // Check all incoming edges: any with consumed < fired?
    const needs = nodeDef.needs ?? [];
    let hasAnyUnconsumed = false;
    let allNeedsSatisfied = true;

    // Gather all predecessors (nodes that have edges pointing to target)
    const predecessors = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.to === target) predecessors.add(edge.from);
    }

    // Node with no predecessors: ready if activated
    if (predecessors.size === 0) {
      ready.push(target);
      continue;
    }

    // Entry node with back-edges from cycles: first wave, all preds unfired
    const allPredsNeverFired = [...predecessors].every((p) => (firedEpoch[p] ?? 0) === 0);
    if (target === graph.entry && allPredsNeverFired) {
      ready.push(target);
      continue;
    }

    for (const pred of predecessors) {
      const edgeKey = `${pred}→${target}`;
      const c = consumed[edgeKey] ?? 0;
      const f = firedEpoch[pred] ?? 0;
      if (f > c) {
        hasAnyUnconsumed = true;
      }
      if (needs.includes(pred) && !(f > c)) {
        allNeedsSatisfied = false;
      }
    }

    if (!hasAnyUnconsumed) continue; // no triggering edge

    if (needs.length > 0 && !allNeedsSatisfied) continue; // AND-join not satisfied

    ready.push(target);
  }

  return ready;
}

/** Increment firedEpoch for a node (used in crash-recovery human gate path) */
export function incrementFiredEpoch(store: FlowStore, runId: string, nodeId: string): void {
  const meta = store.loadMeta(runId);
  const fe = { ...(meta.firedEpoch ?? {}) };
  fe[nodeId] = (fe[nodeId] ?? 0) + 1;
  store.updateMeta(runId, { firedEpoch: fe });
}

async function failRunV2(store: FlowStore, runId: string, error: string, lock: ExecLock): Promise<void> {
  store.updateMeta(runId, { status: "failed" });
  lock.release();
}

function applyPendingEdit(store: FlowStore, runId: string, edit: { path: string; value: unknown }): void {
  // Apply edits that were queued during running
  // For now, just notify — full implementation is in edit.ts
  // The resume path in edit.ts handles this via setValue
}

/**
 * effect 幂等键：确定性哈希（effect 名 + 读取的 args 值）。
 * 同 (runId, nodeId) 下相同输入 → 同 key → 引擎 skip；输入变化 → 不同 key → 重新执行。
 * fn 抛错不落记录 → 重试同输入仍同 key 但无记录 → 重新执行。
 */
function computeIdempotencyKey(
  nodeId: string,
  effectName: string,
  argNames: string[],
  state: Record<string, unknown>,
): string {
  const payload = [effectName, ...argNames.map((k) => state[k])];
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  return `${nodeId}:${digest}`;
}

/** Resolve a write value: plain value, {{output}} substitution, {{increment:x}} */
function resolveWriteValue(key: string, raw: string, output: string): unknown {
  if (raw === "{{output}}") return output;
  const outPathMatch = raw.match(/^\{\{output\.(.+)\}\}$/);
  if (outPathMatch) {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      let val: unknown = parsed;
      for (const seg of outPathMatch[1]!.split(".")) {
        if (val === null || val === undefined || typeof val !== "object") return undefined;
        val = (val as Record<string, unknown>)[seg];
      }
      return val;
    } catch {
      return undefined; // 非 JSON 输出（agent 节点）或路径不存在 → 跳过写入
    }
  }
  const incrMatch = raw.match(/^\{\{increment:state\.(.+)\}\}$/);
  if (incrMatch) {
    // Increment is handled separately in applyWrites, return undefined here
    return undefined;
  }
  return raw;
}

/**
 * Resolve fanout body-node writes within a single item branch.
 * Supports the same substitutions as resolveWriteValue, scoped to the
 * per-item state (`state.*`), the raw `item`, and the current `output`.
 */
function applyFanoutBodyWrites(
  writes: Record<string, string>,
  state: Record<string, unknown>,
  output: string,
  _idx: number,
  _item: unknown,
  fanoutId: string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(writes)) {
    // {{output}} → body node output
    if (raw === "{{output}}") {
      resolved[key] = output;
      continue;
    }

    // {{output.path}} → JSON path into body output
    const outPathMatch = raw.match(/^\{\{output\.(.+)\}\}$/);
    if (outPathMatch) {
      try {
        const parsed = JSON.parse(output) as Record<string, unknown>;
        let val: unknown = parsed;
        for (const seg of outPathMatch[1]!.split(".")) {
          if (val === null || val === undefined || typeof val !== "object") {
            val = undefined;
            break;
          }
          val = (val as Record<string, unknown>)[seg];
        }
        resolved[key] = val;
      } catch {
        resolved[key] = undefined;
      }
      continue;
    }

    // {{item}} → current item
    if (raw === "{{item}}") {
      resolved[key] = _item;
      continue;
    }

    // {{state.*}} → read from per-item state
    const stateMatch = raw.match(/^\{\{state\.(.+)\}\}$/);
    if (stateMatch) {
      let val: unknown = state;
      for (const seg of stateMatch[1]!.split(".")) {
        if (val === null || val === undefined || typeof val !== "object") {
          val = undefined;
          break;
        }
        val = (val as Record<string, unknown>)[seg];
      }
      resolved[key] = val;
      continue;
    }

    // {{fanoutId.item}} → convenience alias for the nested injected item
    if (raw === `{{${fanoutId}.item}}`) {
      const nested = state[fanoutId];
      if (nested !== null && typeof nested === "object" && "item" in (nested as Record<string, unknown>)) {
        resolved[key] = (nested as Record<string, unknown>).item;
      } else {
        resolved[key] = _item;
      }
      continue;
    }

    // 字面量
    resolved[key] = raw;
  }

  return resolved;
}

async function failRun(store: FlowStore, runId: string, error: string): Promise<void> {
  store.updateMeta(runId, { status: "failed" });
}

function findEntryNode(store: FlowStore, runId: string): string {
  const graph = store.loadGraph(runId);
  return graph.entry ?? "";
}

function findNextFromCheckpoint(store: FlowStore, runId: string): string | null {
  const latestCP = store.latestCheckpoint(runId);
  if (!latestCP) {
    return findEntryNode(store, runId);
  }

  const graph = store.loadGraph(runId);
  const state = store.loadState(runId);
  return evaluateEdges(latestCP.nodeId, graph.edges, state);
}

function getMaxSteps(store: FlowStore, runId: string): number {
  try {
    const graph = store.loadGraph(runId);
    return graph.maxSteps ?? 100;
  } catch {
    return 100;
  }
}

/**
 * 出边求值：先按声明顺序评估 when 边，全部不命中走无条件 fallback。
 * 无匹配返回 null（死路）。"end" 是有效目标。
 */
function evaluateEdges(nodeId: string, edges: EdgeDef[], state: Record<string, unknown>): string | null {
  let fallback: string | null = null;

  for (const edge of edges) {
    if (edge.from !== nodeId) continue;

    if (edge.when) {
      try {
        if (evalExpr(edge.when, state)) {
          return edge.to;
        }
      } catch {
        // 表达式求值失败 → 跳过此边（日志后移）
      }
    } else {
      fallback = edge.to;
    }
  }

  return fallback;
}

/**
 * 应用 writes。支持三种值形式：
 * - "{{output}}" → 替换为节点 output
 * - "{{increment:state.x}}" → 数值自增
 * - 其他字面量 → 原样写入
 */
function applyWrites(
  state: Record<string, unknown>,
  writes: Record<string, string>,
  output: string,
): void {
  for (const [key, raw] of Object.entries(writes)) {
    // {{output}} → output text
    if (raw === "{{output}}") {
      state[key] = output;
      continue;
    }

    // {{increment:state.x}} → 自增
    const incrMatch = raw.match(/^\{\{increment:state\.(.+)\}\}$/);
    if (incrMatch) {
      const current = state[incrMatch[1]!];
      const base = typeof current === "number" ? current : 0;
      state[key] = base + 1;
      continue;
    }

    // 字面量
    state[key] = raw;
  }
}

// ── Metrics 模板求值 ───────────────────────────────────────────

// metrics 模板求值：state / input / result 三作用域，缺失 → 空字符串（与 interpolate 同语义）
export function renderMetrics(
  metrics: Record<string, Record<string, string>>,
  ctx: { state: Record<string, unknown>; input: Record<string, unknown>; result: unknown },
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [domain, fields] of Object.entries(metrics)) {
    out[domain] = {};
    for (const [k, v] of Object.entries(fields)) {
      out[domain][k] = v.replace(/\{\{([^}]+)\}\}/g, (_m, expr: string) => {
        const t = expr.trim();
        if (t.startsWith("input.")) return String((ctx.input as Record<string, unknown>)[t.slice(6)] ?? "");
        if (t.startsWith("state.")) {
          let val: unknown = ctx.state;
          for (const seg of t.slice(6).split(".")) {
            if (val === null || val === undefined || typeof val !== "object") return "";
            val = (val as Record<string, unknown>)[seg];
          }
          return val === null || val === undefined ? "" : String(val);
        }
        if (t.startsWith("result.")) {
          let val: unknown = ctx.result;
          for (const seg of t.slice(7).split(".")) {
            if (val === null || val === undefined || typeof val !== "object") return "";
            val = (val as Record<string, unknown>)[seg];
          }
          return val === null || val === undefined ? "" : String(val);
        }
        return `{{${t}}}`;
      });
    }
  }
  return out;
}
