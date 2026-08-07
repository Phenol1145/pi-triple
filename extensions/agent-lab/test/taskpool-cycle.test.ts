import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { SorterEngine } from "../src/taskpool/engine.ts";
import { runSorterCycleOnce, startSorterCycle } from "../src/taskpool/cycle.ts";
import type { DispatchRequest, DispatchResult } from "../src/scheduler/runner-types.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-cycle-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  const repo = new CoreRepository(db);
  // 适配（协调者裁决 B）：engine 只配置既有 agent 的 selector，不创建 agent（lab_agent_instances 初始为空，
  // setSelector 的 UPDATE 需命中既有行；幽灵 agent 不得由 engine 造出）。brief 自带测试未含种子，补上（同 engine 测试）。
  for (const id of ["agent-a", "agent-b"]) {
    repo.insertAgent({
      id,
      schedulerInstanceId: "sched-1",
      definition: {
        standard: { name: id, capabilities: [], executionKind: "sync", labels: {} },
        workLoop: { id: "wl-1", version: "1", config: {} },
        custom: null,
      },
      createdAtRoundId: "round-1",
      status: "ready",
      createdAt: Date.now(),
    } satisfies AgentInstanceRecord);
  }
  const events: unknown[] = [];
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "test" });
  const engine = new SorterEngine(db, store);
  return { dir, db, store, engine, events };
}

function task(labels: string[], text: string) {
  return { templateId: "semantic-split", text, labels, params: {}, createdBy: "me" };
}

test("单轮：认领→派发（[task:id] 前缀 + direct 参数）→ 成功", async () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const t = store.publish(task(["m"], "做语义分解"));
  const calls: DispatchRequest[] = [];
  const res = await runSorterCycleOnce({
    engine,
    dispatch: async (req) => { calls.push(req); return { status: "completed", schedulerInstanceId: "s", attempts: [], selectedAgentId: "agent-a", output: { text: "ok" } } as DispatchResult; },
    intervalMs: 60_000,
    now: () => Date.now(),
  });
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.agentId, "agent-a");
  assert.equal(req.strategy, "direct");
  assert.equal(req.mode, "execute");
  assert.ok(req.task.startsWith(`[task:${t.id}]`)); // 前缀注入
  assert.ok(req.task.includes("做语义分解"));
  assert.equal(res.claimed, 1);
  assert.equal(store.get(t.id)!.status, "claimed"); // 派发成功仍 claimed（提交由 agent 会话完成）
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("单轮：派发 failed → 自动 reject（dispatch-failed）", async () => {
  const { dir, db, store, engine, events } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const t = store.publish(task(["m"], "x"));
  const res = await runSorterCycleOnce({
    engine,
    dispatch: async () => ({ status: "failed", error: { code: "execution-timeout", message: "timeout", retryable: true }, attempts: [] }) as DispatchResult,
    intervalMs: 60_000,
  });
  assert.equal(res.failed, 1);
  const got = store.get(t.id)!;
  assert.equal(got.status, "rejected");
  assert.equal(got.rejects[0]!.reason, "dispatch-failed");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("单轮：派发永不 resolve → withTimeout 超时（裁决 N4/I1）→ 自动 reject", async () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const t = store.publish(task(["m"], "hang"));
  const res = await runSorterCycleOnce({
    engine,
    dispatch: () => new Promise(() => {}), // 永不 resolve
    intervalMs: 60_000,
    executionTimeoutMs: 50, // 小超时让测试快速通过
  });
  assert.equal(res.failed, 1);
  const got = store.get(t.id)!;
  assert.equal(got.status, "rejected");
  assert.equal(got.rejects[0]!.reason, "dispatch-failed");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("单轮：无候选不派发不报错", async () => {
  const { dir, db, store, engine } = fresh();
  const calls: DispatchRequest[] = [];
  const res = await runSorterCycleOnce({ engine, dispatch: async (r) => { calls.push(r); return { status: "completed", schedulerInstanceId: "s", attempts: [] } as DispatchResult; }, intervalMs: 60_000 });
  assert.equal(calls.length, 0);
  assert.equal(res.claimed, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("startSorterCycle 返回 stop，stop 后不再触发", async () => {
  const { dir, db, store, engine } = fresh();
  const handle = startSorterCycle({ engine, dispatch: async () => { throw new Error("不应调用"); }, intervalMs: 60_000 });
  handle.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
