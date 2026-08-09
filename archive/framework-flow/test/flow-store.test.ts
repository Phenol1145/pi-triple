/**
 * flow store 测试
 *
 * 覆盖：createRun / 原子写 / 执行锁(stale回收/启动时间守卫) / mutation锁 /
 * 快照历史 / rm状态守卫 / loadSave roundtrip
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { FlowStore } from "../../packages/framework/src/flow/store.js";
import type { FlowDef } from "../../packages/framework/src/flow/schema.js";

const SIMPLE_FLOW: FlowDef = {
  name: "test-flow",
  entry: "start",
  nodes: [
    { id: "start", type: "agent", prompt: "run task" },
    { id: "end-step", type: "agent", prompt: "wrap up" },
  ],
  edges: [
    { from: "start", to: "end-step" },
    { from: "end-step", to: "end" },
  ],
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ptl-flow-test-"));
}

describe("FlowStore", () => {
  let root: string;
  let store: FlowStore;

  beforeEach(() => {
    root = tempDir();
    store = new FlowStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("createRun 创建完整骨架目录", () => {
    const id = store.createRun(SIMPLE_FLOW, { key: "val" });
    const dir = path.join(root, id);
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "graph.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "checkpoints"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "workspace"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "graph.history"))).toBe(true);
  });

  it("createRun state 初始值插值 {{input.x}}", () => {
    const def: FlowDef = {
      name: "test", entry: "a",
      state: { pr: "{{input.pr}}", count: 0, static: "hello" },
      nodes: [{ id: "a", type: "agent", prompt: "ok" }],
      edges: [{ from: "a", to: "end" }],
    };
    const id = store.createRun(def, { pr: "42" });
    expect(store.loadState(id)).toEqual({ pr: "42", count: 0, static: "hello" });
  });

  it("createRun state 插值缺失 input 键 → 空串", () => {
    const def: FlowDef = {
      name: "test", entry: "a",
      state: { val: "{{input.missing}}" },
      nodes: [{ id: "a", type: "agent", prompt: "ok" }],
      edges: [{ from: "a", to: "end" }],
    };
    const id = store.createRun(def, {});
    expect(store.loadState(id)).toEqual({ val: "" });
  });

  it("saveState / loadState 完整 roundtrip", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.saveState(id, { a: 1, b: "two", c: { nested: true } });
    expect(store.loadState(id)).toEqual({ a: 1, b: "two", c: { nested: true } });
  });

  it("state 返回值引用隔离", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.saveState(id, { x: 1 });
    const s1 = store.loadState(id);
    s1.x = 999;
    expect(store.loadState(id).x).toBe(1);
  });

  it("原子写：tmp 残留不丢旧状态", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.saveState(id, { before: "crash" });
    const statePath = path.join(root, id, "state.json");
    fs.writeFileSync(statePath + ".tmp", "corrupted");
    expect(JSON.parse(fs.readFileSync(statePath, "utf-8"))).toEqual({ before: "crash" });
    fs.unlinkSync(statePath + ".tmp");
  });

  it("saveGraph / loadGraph / snapshotGraph", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.snapshotGraph(id);
    const def: FlowDef = { ...SIMPLE_FLOW, maxSteps: 50 };
    store.saveGraph(id, def, 3);
    expect(store.loadGraph(id).maxSteps).toBe(50);
  });

  it("snapshotGraph 记录历史文件", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.snapshotGraph(id);
    const files = fs.readdirSync(path.join(root, id, "graph.history")).sort();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toMatch(/^v\d+\.json$/);
    const content = JSON.parse(fs.readFileSync(path.join(root, id, "graph.history", files[0]!), "utf-8"));
    expect(content.name).toBe("test-flow");
  });

  it("writeCheckpoint / listCheckpoints / latestCheckpoint", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.writeCheckpoint(id, { nodeId: "start", graphVersion: 1, seq: 1, startedAt: 0, finishedAt: 1000, status: "completed", output: "done", stateAfter: {} });
    store.writeCheckpoint(id, { nodeId: "end-step", graphVersion: 1, seq: 2, startedAt: 1000, finishedAt: 2000, status: "completed", output: "all done", stateAfter: {} });
    const list = store.listCheckpoints(id);
    expect(list.length).toBe(2);
    expect(list[0]!.output).toBe("done");
    expect(list[1]!.output).toBe("all done");
    expect(store.latestCheckpoint(id)!.nodeId).toBe("end-step");
  });

  it("checkpoint 文件名 %03d-nodeId", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.writeCheckpoint(id, { nodeId: "start", graphVersion: 1, seq: 1, startedAt: 0, finishedAt: 0, status: "completed", output: "", stateAfter: {} });
    const files = fs.readdirSync(path.join(root, id, "checkpoints"));
    expect(files.some((f) => /^\d{3}-/.test(f))).toBe(true);
  });

  it("updateMeta patch 合并", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.updateMeta(id, { status: "running", stepCount: 5 });
    const meta = store.loadMeta(id);
    expect(meta.status).toBe("running");
    expect(meta.stepCount).toBe(5);
    expect(meta.name).toBe("test-flow");
  });

  it("loadMeta 必备字段", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const meta = store.loadMeta(id);
    expect(meta).toHaveProperty("runId");
    expect(meta).toHaveProperty("name");
    expect(meta).toHaveProperty("status");
    expect(meta).toHaveProperty("createdAt");
    expect(meta).toHaveProperty("input");
    expect(meta).toHaveProperty("graphVersion");
    expect(meta).toHaveProperty("stepCount");
    expect(meta.status).toBe("running");
    expect(meta.stepCount).toBe(0);
  });

  it("writePending / loadPending / clearPending", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.writePending(id, { message: "approve?", nodeId: "gate", graphVersion: 1, nodeSnapshot: { id: "gate" }, createdAt: Date.now() });
    expect(store.loadPending(id)!.message).toBe("approve?");
    store.clearPending(id);
    expect(store.loadPending(id)).toBeNull();
  });

  it("listRuns 返回所有 run", () => {
    const id1 = store.createRun(SIMPLE_FLOW, {});
    const id2 = store.createRun(SIMPLE_FLOW, {});
    const runs = store.listRuns();
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.runId).sort()).toEqual([id1, id2].sort());
  });

  it("removeRun done 状态", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.updateMeta(id, { status: "done" });
    expect(store.removeRun(id)).toBe(true);
    expect(store.listRuns().length).toBe(0);
  });

  it("removeRun 拒绝 running 状态", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    expect(store.removeRun(id)).toBe(false);
  });

  it("removeRun 拒绝 waiting_human 状态", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.updateMeta(id, { status: "waiting_human" });
    expect(store.removeRun(id)).toBe(false);
  });

  it("removeRun 允许 failed", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    store.updateMeta(id, { status: "failed" });
    expect(store.removeRun(id)).toBe(true);
  });

  it("removeRun 不存在 → false", () => {
    expect(store.removeRun("nonexist")).toBe(false);
  });

  // ── 执行锁 ─────────────────────────────────────

  it("acquireExecLock 可获取并释放", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const lock = store.acquireExecLock(id);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("acquireExecLock 互斥", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const lock1 = store.acquireExecLock(id);
    expect(() => store.acquireExecLock(id)).toThrow();
    lock1!.release();
  });

  it("release 后可重获", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const lock1 = store.acquireExecLock(id)!;
    lock1.release();
    const lock2 = store.acquireExecLock(id);
    expect(lock2).not.toBeNull();
    lock2!.release();
  });

  it("stale 回收：不存在的 pid", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const lockPath = path.join(root, id, "lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startTime: "never", ts: Date.now() }));
    const lock = store.acquireExecLock(id);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("锁内容包含 pid 和 startTime", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const lock = store.acquireExecLock(id)!;
    const raw = JSON.parse(fs.readFileSync(path.join(root, id, "lock"), "utf-8"));
    expect(raw).toHaveProperty("pid");
    expect(raw).toHaveProperty("startTime");
    expect(typeof raw.pid).toBe("number");
    lock.release();
  });

  it("release 删除锁文件", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const lock = store.acquireExecLock(id)!;
    const lockPath = path.join(root, id, "lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // ── mutation 锁 ──────────────────────────────

  it("withMutationLock 串行", async () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const order: number[] = [];
    await Promise.all([
      store.withMutationLock(id, async () => { order.push(1); await new Promise((r) => setTimeout(r, 20)); order.push(2); }),
      store.withMutationLock(id, async () => { order.push(3); await new Promise((r) => setTimeout(r, 10)); order.push(4); }),
    ]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("withMutationLock 正常不残留锁", async () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    await store.withMutationLock(id, async () => {});
    expect(fs.existsSync(path.join(root, id, "mutation.lock"))).toBe(false);
  });

  it("withMutationLock 异常时释放锁", async () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    try { await store.withMutationLock(id, async () => { throw new Error("boom"); }); } catch { /* ok */ }
    expect(fs.existsSync(path.join(root, id, "mutation.lock"))).toBe(false);
    await store.withMutationLock(id, async () => {}); // 能重获取
  });

  // ── 其他 ──────────────────────────────────────

  it("root 可注入", () => {
    const customRoot = tempDir();
    const s = new FlowStore(customRoot);
    const id = s.createRun(SIMPLE_FLOW, {});
    expect(path.join(customRoot, id).startsWith(customRoot)).toBe(true);
    s.updateMeta(id, { status: "done" });
    s.removeRun(id);
    expect(fs.existsSync(path.join(customRoot, id))).toBe(false);
    fs.rmSync(customRoot, { recursive: true, force: true });
  });

  it("createRun 初始 graphVersion = 1", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    expect(store.loadMeta(id).graphVersion).toBe(1);
  });

  it("snapshotGraph 递增版本号", () => {
    const id = store.createRun(SIMPLE_FLOW, {});
    const v1 = store.snapshotGraph(id);
    expect(v1).toBeGreaterThanOrEqual(1);
    expect(store.loadMeta(id).graphVersion).toBe(v1);
    const v2 = store.snapshotGraph(id);
    expect(v2).toBeGreaterThan(v1);
    expect(store.loadMeta(id).graphVersion).toBe(v2);
  });
});
