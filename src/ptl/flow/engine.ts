/**
 * pit-flow engine — 执行循环
 *
 * runFlow:   主循环（agent/human 节点调度 + checkpoint + 死路检测）
 * resumeFlow: 从 waiting_human / failed / running-but-dead 恢复
 *
 * spawnAgent 抽象依赖注入（构造函数捕获），测试可 mock。
 */

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { FlowStore, ExecLock, Checkpoint, PendingPayload } from "./store.js";
import type { FlowDef, NodeDef, EdgeDef } from "./schema.js";
import { interpolate } from "./template.js";
import { evalExpr } from "./expr.js";

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
      if (nodeSnapshot.tenant) {
        // 尝试 resolves tenant for PI_CODING_AGENT_DIR
        try {
          const { resolveTenantId, resolveDataDir } = await import("../config.js");
          const config = (await import("../config.js")).loadConfig();
          const resolved = resolveTenantId(nodeSnapshot.tenant, config);
          if (resolved.ok) {
            const dataDir = resolveDataDir(config);
            env.PI_CODING_AGENT_DIR = path.resolve(dataDir, "pi-config", resolved.id);
            env.PI_TENANT = resolved.id;
          }
        } catch {
          // config unavailable — continue without tenant env
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
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────

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
