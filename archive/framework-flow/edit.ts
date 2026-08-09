/**
 * ptl-flow edit — setValue / editGraph / approve / reject
 *
 * setValue: 点路径修改 graph.json 或 state.json。
 *   路径命名空间:
 *     nodes.N.x / edges.N.x / entry / name / maxSteps → graph.json (走 mutation 锁)
 *     state.x.y → state.json (走 mutation 锁)
 *   graph 修改流程: loadGraph → 应用点路径 → snapshotGraph → validateFlow → saveGraph
 *   state 修改流程: loadState → 应用点路径 → saveState
 *   值做 JSON.parse（"2"→string 需引号，2→number，true→boolean）
 *
 * editGraph: 拷 graph.json → $EDITOR 编辑（不持锁）→ 保存后 mutation 锁提交
 *
 * approve/reject: waiting_human → 写 state → 应用快照 writes → checkpoint → resumeFlow
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FlowStore } from "./store.js";
import type { Checkpoint } from "./store.js";
import type { FlowDef } from "./schema.js";
import { validateFlow } from "./schema.js";
import { makeResumeFlowV2, incrementFiredEpoch, type RunResult } from "./engine.js";
import { makeSpawnAgent } from "./pm.js";

// ── Types ─────────────────────────────────────────────────────

export interface EditResult {
  ok: boolean;
  status?: "done" | "failed" | "waiting_human" | "queued" | "editing";
  error?: string;
}

// ── propose ───────────────────────────────────────────────────

/**
 * 申请修改：标记 editRequested。
 * running → 标记，当前波完成后停波
 * waiting_human/failed → 直接进入 editing
 * done → 报错
 * editing → 幂等 ok
 */
export async function propose(store: FlowStore, runId: string): Promise<EditResult> {
  return await store.withMutationLock(runId, async () => {
    const meta = store.loadMeta(runId);

    switch (meta.status) {
      case "running":
        store.updateMeta(runId, { editRequested: true });
        return { ok: true };

      case "waiting_human":
      case "failed":
        store.updateMeta(runId, {
          status: "editing",
          editRequested: false,
          editBaseWave: undefined,
        });
        return { ok: true };

      case "editing":
        // 幂等
        return { ok: true };

      case "done":
        return { ok: false, error: `run "${runId.slice(0, 8)}…" is already done; cannot propose` };

      default:
        return { ok: false, error: `unknown status: ${meta.status}` };
    }
  });
}

// ── discard ───────────────────────────────────────────────────

/**
 * 放弃修改：editing → running，清 editRequested/pendingEdits/editBaseWave
 */
export async function discard(store: FlowStore, runId: string): Promise<EditResult> {
  return await store.withMutationLock(runId, async () => {
    const meta = store.loadMeta(runId);

    if (meta.status !== "editing") {
      return { ok: false, error: `run is not in editing state (current: ${meta.status})` };
    }

    store.updateMeta(runId, {
      status: "running",
      editRequested: false,
      editBaseWave: undefined,
      pendingEdits: undefined,
    });
    return { ok: true };
  });
}

// ── resumeV2 ──────────────────────────────────────────────────

/**
 * resumeV2: editing → re-validate graph → apply pendingEdits → clear → continue
 *
 * 流程：
 * 1. re-validate 最终图（失败保持 editing + 返回错误）
 * 2. 逐条应用 meta.pendingEdits（各自 re-validate，失败收集报告跳过）
 * 3. 清 editRequested/pendingEdits/editBaseWave
 * 4. 若存在 stale human pending：丢弃，按当前 graph 重进 human 节点 → waiting_human
 * 5. 否则调 engine resume 继续波循环
 */
export async function resumeV2(
  store: FlowStore,
  runId: string,
  engineResume: (store: FlowStore, runId: string) => Promise<RunResult>,
): Promise<EditResult> {
  const meta = store.loadMeta(runId);
  if (meta.status !== "editing") {
    return { ok: false, error: `run is not in editing state (current: ${meta.status})` };
  }

  // 1. Re-validate final graph
  const graph = store.loadGraph(runId);
  const vResult = validateFlow(graph);
  if (!vResult.ok) {
    return { ok: false, error: `re-validation failed: ${vResult.errors.join("; ")}` };
  }

  // 2. Apply pendingEdits (each re-validated, failures collected and skipped)
  const failedEdits: string[] = [];
  if (meta.pendingEdits && meta.pendingEdits.length > 0) {
    for (const edit of meta.pendingEdits) {
      try {
        const result = await setValue(store, runId, edit.path, String(edit.value));
        if (!result.ok) {
          failedEdits.push(`${edit.path}: ${result.error ?? "unknown"}`);
        }
      } catch (err: any) {
        failedEdits.push(`${edit.path}: ${err.message}`);
      }
    }
  }

  // 3. Clear barrier markers
  await store.withMutationLock(runId, async () => {
    store.updateMeta(runId, {
      status: "running",
      editRequested: false,
      editBaseWave: undefined,
      pendingEdits: undefined,
    });
  });

  // 4. Handle stale human pending
  const pending = store.loadPending(runId);
  if (pending) {
    // Discard stale pending, re-enter human node with current graph
    store.clearPending(runId);

    const nodeDef = graph.nodes.find((n) => n.id === pending.nodeId);
    if (nodeDef && nodeDef.type === "human" && nodeDef.message) {
      // Render message with current state
      const { interpolate } = await import("./template.js");
      const currentMeta = store.loadMeta(runId);
      const state = store.loadState(runId);
      const renderedMessage = interpolate(nodeDef.message, {
        state,
        input: currentMeta.input,
      });

      const newPending: import("./store.js").PendingPayload = {
        nodeId: nodeDef.id,
        graphVersion: currentMeta.graphVersion,
        nodeSnapshot: JSON.parse(JSON.stringify(nodeDef)),
        message: renderedMessage,
        createdAt: Date.now(),
      };
      store.writePending(runId, newPending);
      store.updateMeta(runId, { status: "waiting_human" });

      const warn =
        failedEdits.length > 0
          ? `\n\n⚠️ 部分修改失败: ${failedEdits.join("; ")}`
          : "";
      return {
        ok: true,
        status: "waiting_human",
        error: undefined,
      };
    }
  }

  // 5. Continue wave loop via engine resume
  const runResult = await engineResume(store, runId);

  const warn =
    failedEdits.length > 0
      ? `⚠️ 部分修改失败: ${failedEdits.join("; ")}`
      : undefined;
  return {
    ok: runResult.status === "done" || runResult.status === "waiting_human",
    status: runResult.status,
    error: runResult.status === "failed" ? runResult.error : warn,
  };
}

// ── setValue ───────────────────────────────────────────────────

/**
 * 点路径修改 graph.json 或 state.json。
 * 路径命名空间:
 *   nodes.N.x / edges.N.x / entry / name / maxSteps → graph.json
 *   state.x.y → state.json
 *
 * 值做 JSON.parse: "2"→string 需引号、2→number、true→boolean
 */
export async function setValue(
  store: FlowStore,
  runId: string,
  dotPath: string,
  rawValue: string,
  opts?: { forceImmediate?: boolean },
): Promise<EditResult> {
  // 值解析：优先 JSON parse（2→number、true→boolean、"x"→string），失败兜底为原始字符串
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawValue);
  } catch {
    parsedValue = rawValue;
  }

  // ── running guard: queue edits + auto-propose ─────────────
  const meta = store.loadMeta(runId);
  if (!opts?.forceImmediate && meta.status === "running" && !meta.editRequested) {
    return await store.withMutationLock(runId, async () => {
      // Re-read meta under lock
      const m2 = store.loadMeta(runId);
      if (m2.status !== "running") {
        // Status changed — fall through to immediate effect
        return await setValue(store, runId, dotPath, rawValue, { forceImmediate: true });
      }
      const pending: Array<{ path: string; value: unknown }> = [
        ...(m2.pendingEdits ?? []),
        { path: dotPath, value: parsedValue },
      ];
      store.updateMeta(runId, {
        pendingEdits: pending,
        editRequested: true,
      });
      return { ok: true, status: "queued" };
    });
  }

  // ── Normal path (failed/editing/waiting_human/done, or force)

  const parts = dotPath.split(".");
  const root = parts[0];

  // ── state.* → state.json ──────────────────────────────
  if (root === "state") {
    return await store.withMutationLock(runId, async () => {
      const state = store.loadState(runId);

      if (parts.length === 1) {
        return { ok: false, error: "state path requires at least one key: state.X" };
      }

      // state.x.y.z nested path
      const stateParts = parts.slice(1);
      setNested(state, stateParts, parsedValue);

      store.saveState(runId, state);
      return { ok: true };
    });
  }

  // ── graph.* → graph.json ──────────────────────────────
  const graphRoots = new Set(["nodes", "edges", "entry", "name", "maxSteps"]);

  if (!graphRoots.has(root!)) {
    return {
      ok: false,
      error: `unknown path namespace "${root}". Valid namespaces: nodes, edges, entry, name, maxSteps, state`,
    };
  }

  return await store.withMutationLock(runId, async () => {
    const graph = store.loadGraph(runId);

    if (root === "entry") {
      if (parts.length !== 1) return { ok: false, error: "entry is a scalar, not nested" };
      if (typeof parsedValue !== "string") return { ok: false, error: "entry must be a string" };
      graph.entry = parsedValue;
    } else if (root === "name") {
      if (parts.length !== 1) return { ok: false, error: "name is a scalar, not nested" };
      if (typeof parsedValue !== "string") return { ok: false, error: "name must be a string" };
      graph.name = parsedValue;
    } else if (root === "maxSteps") {
      if (parts.length !== 1) return { ok: false, error: "maxSteps is a scalar, not nested" };
      if (typeof parsedValue !== "number" || !Number.isInteger(parsedValue) || parsedValue < 1) {
        return { ok: false, error: "maxSteps must be a positive integer" };
      }
      graph.maxSteps = parsedValue;
    } else if (root === "nodes") {
      if (parts.length < 3) {
        return { ok: false, error: "nodes path requires at least 3 parts: nodes.N.key" };
      }
      const idx = parseInt(parts[1]!, 10);
      if (isNaN(idx) || idx < 0 || idx >= graph.nodes.length) {
        return { ok: false, error: `nodes index out of range: ${parts[1]} (max: ${graph.nodes.length - 1})` };
      }
      const field = parts[2]!;

      // Rejected field changes
      const rejected = new Set(["id", "type"]);
      if (rejected.has(field)) {
        return { ok: false, error: `cannot change node field "${field}" for live runs (id = checkpoint linkage, type = execution semantics)` };
      }

      const node = graph.nodes[idx]! as unknown as Record<string, unknown>;

      if (parts.length === 3) {
        node[field] = parsedValue;
      } else {
        // nested: nodes.0.writes.key
        if (field === "writes" && parts.length === 4) {
          const writes = node.writes as Record<string, string> | undefined;
          if (!writes) {
            return { ok: false, error: "node has no writes object yet; set nodes.N.writes {\"key\":\"value\"} first" };
          }
          if (parsedValue === null || parsedValue === undefined) {
            delete writes[parts[3]!];
          } else {
            writes[parts[3]!] = String(parsedValue);
          }
        } else {
          // Generic nested set
          setNested(node, parts.slice(2), parsedValue);
        }
      }
    } else if (root === "edges") {
      if (parts.length < 3) {
        return { ok: false, error: "edges path requires at least 3 parts: edges.N.key" };
      }
      const idx = parseInt(parts[1]!, 10);
      if (isNaN(idx) || idx < 0 || idx >= graph.edges.length) {
        return { ok: false, error: `edges index out of range: ${parts[1]} (max: ${graph.edges.length - 1})` };
      }
      const field = parts[2]!;
      const edge = graph.edges[idx]! as unknown as Record<string, unknown>;

      if (parts.length === 3) {
        edge[field] = parsedValue;
      } else {
        setNested(edge, parts.slice(2), parsedValue);
      }
    }

    // snapshot + validate + save
    const newVersion = store.snapshotGraph(runId);
    const vResult = validateFlow(graph);
    if (!vResult.ok) {
      // Restore old version (load from snapshot)
      const histDir = path.join(store["runDir"](runId), "graph.history");
      const prevSnapshot = path.join(histDir, `v${newVersion}.json`);
      const oldContent = fs.readFileSync(prevSnapshot, "utf-8");
      const tempGraphPath = path.join(store["runDir"](runId), "graph.json");
      fs.writeFileSync(tempGraphPath, oldContent);
      store.updateMeta(runId, { graphVersion: newVersion - 1 });
      return { ok: false, error: vResult.errors.join("; ") };
    }

    store.saveGraph(runId, vResult.def, newVersion);
    if (vResult.warnings.length > 0) {
      console.warn(`[ptl-flow] Validation warnings: ${vResult.warnings.join("; ")}`);
    }

    return { ok: true };
  });
}

// ── editGraph ──────────────────────────────────────────────────

/**
 * 拷 graph.json → $EDITOR 编辑（不持锁）→ mutation 锁提交。
 * 校验拒绝时保留临时文件并提示路径。
 */
export async function editGraph(store: FlowStore, runId: string): Promise<EditResult> {
  const runDir = store["runDir"](runId);
  if (!fs.existsSync(path.join(runDir, "meta.json"))) {
    return { ok: false, error: `run "${runId}" not found` };
  }

  const graphPath = path.join(runDir, "graph.json");
  if (!fs.existsSync(graphPath)) {
    return { ok: false, error: "graph.json not found" };
  }

  // Copy to tmp file
  const tmpPath = path.join(runDir, ".edit-tmp.json");
  fs.copyFileSync(graphPath, tmpPath);

  // Open editor (not holding any lock, arbitrary duration)
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const result = spawnSync(editor, [tmpPath], {
    stdio: "inherit",
    env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
  });

  if (result.status !== 0 || result.error) {
    fs.unlinkSync(tmpPath);
    return { ok: false, error: `editor exited with status ${result.status}: ${result.stderr?.toString() ?? result.error?.message ?? ""}` };
  }

  // Read edited content
  let edited: unknown;
  try {
    const content = fs.readFileSync(tmpPath, "utf-8");
    edited = JSON.parse(content);
  } catch (err: any) {
    return {
      ok: false,
      error: `invalid JSON: ${err.message}. Edited content preserved at ${tmpPath}`,
    };
  }

  // mutation lock → validate → submit
  return await store.withMutationLock(runId, async () => {
    const vResult = validateFlow(edited);
    if (!vResult.ok) {
      return { ok: false, error: `validation failed: ${vResult.errors.join("; ")}. Edited content preserved at ${tmpPath}` };
    }

    const newVersion = store.snapshotGraph(runId);
    store.saveGraph(runId, vResult.def, newVersion);

    // Clean up tmp
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }

    if (vResult.warnings.length > 0) {
      console.warn(`[ptl-flow] Validation warnings: ${vResult.warnings.join("; ")}`);
    }
    return { ok: true };
  });
}

// ── approve / reject ──────────────────────────────────────────

/**
 * approve: waiting_human → 执行锁 → state.approved=true → 应用快照 writes → checkpoint → resume
 */
export async function approve(store: FlowStore, runId: string, note?: string): Promise<EditResult> {
  const meta = store.loadMeta(runId);
  if (meta.status !== "waiting_human") {
    return { ok: false, error: `run "${runId}" is not in waiting_human state (current: ${meta.status})` };
  }

  const pending = store.loadPending(runId);
  if (!pending) {
    return { ok: false, error: "no pending payload found for this run" };
  }

  // Under mutation lock: apply state.approved + writes + checkpoint + clear pending
  await store.withMutationLock(runId, async () => {
    const state = store.loadState(runId);
    state.approved = true;
    state.approveNote = note ?? "";
    applyWrites(state, pending.nodeSnapshot.writes as Record<string, string> | undefined, "");
    store.saveState(runId, state);

    const cp: Checkpoint = {
      nodeId: pending.nodeId,
      graphVersion: pending.graphVersion,
      seq: meta.stepCount + 1,
      startedAt: pending.createdAt,
      finishedAt: Date.now(),
      status: "completed",
      output: note ?? "",
      stateAfter: { ...state },
    };
    store.writeCheckpoint(runId, cp);
    incrementFiredEpoch(store, runId, pending.nodeId);
    store.clearPending(runId);
    store.updateMeta(runId, { status: "running", stepCount: meta.stepCount + 1 });
  });

  // resumeFlowV2 handles its own exec lock acquisition (crash-recovery path detects approved/rejected)
  const resumeFlow = makeResumeFlowV2(makeSpawnAgent());
  const runResult = await resumeFlow(store, runId);

  return {
    ok: runResult.status === "done" || runResult.status === "waiting_human",
    status: runResult.status,
    error: runResult.status === "failed" ? runResult.error : undefined,
  };
}

/**
 * reject: waiting_human → 执行锁 → state.approved=false → 应用快照 writes → checkpoint → resume
 */
export async function reject(store: FlowStore, runId: string, note?: string): Promise<EditResult> {
  const meta = store.loadMeta(runId);
  if (meta.status !== "waiting_human") {
    return { ok: false, error: `run "${runId}" is not in waiting_human state (current: ${meta.status})` };
  }

  const pending = store.loadPending(runId);
  if (!pending) {
    return { ok: false, error: "no pending payload found for this run" };
  }

  // Under mutation lock: apply state.approved=false + writes + checkpoint + clear pending
  await store.withMutationLock(runId, async () => {
    const state = store.loadState(runId);
    state.approved = false;
    state.approveNote = note ?? "";
    applyWrites(state, pending.nodeSnapshot.writes as Record<string, string> | undefined, "");
    store.saveState(runId, state);

    const cp: Checkpoint = {
      nodeId: pending.nodeId,
      graphVersion: pending.graphVersion,
      seq: meta.stepCount + 1,
      startedAt: pending.createdAt,
      finishedAt: Date.now(),
      status: "completed",
      output: note ?? "",
      stateAfter: { ...state },
    };
    store.writeCheckpoint(runId, cp);
    incrementFiredEpoch(store, runId, pending.nodeId);
    store.clearPending(runId);
    store.updateMeta(runId, { status: "running", stepCount: meta.stepCount + 1 });
  });

  // resumeFlowV2 handles its own exec lock acquisition
  const resumeFlow = makeResumeFlowV2(makeSpawnAgent());
  const runResult = await resumeFlow(store, runId);

  return {
    ok: runResult.status === "done" || runResult.status === "waiting_human",
    status: runResult.status,
    error: runResult.status === "failed" ? runResult.error : undefined,
  };
}

// ── Helpers ────────────────────────────────────────────────────

/** Set a nested value by array of keys. Creates intermediate objects as needed. */
function setNested(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = keys[keys.length - 1]!;
  current[lastKey] = value;
}

/**
 * 应用 writes（复用 engine.applyWrites 语义）。
 * 三种形式: {{output}} / {{increment:state.x}} / 字面量
 */
function applyWrites(
  state: Record<string, unknown>,
  writes: Record<string, string> | undefined,
  output: string,
): void {
  if (!writes) return;
  for (const [key, raw] of Object.entries(writes)) {
    if (raw === "{{output}}") {
      state[key] = output;
      continue;
    }
    const incrMatch = raw.match(/^\{\{increment:state\.(.+)\}\}$/);
    if (incrMatch) {
      const current = state[incrMatch[1]!];
      const base = typeof current === "number" ? current : 0;
      state[key] = base + 1;
      continue;
    }
    state[key] = raw;
  }
}
