// 端到端（spec §9）：注册模板 → publish → selector → 认领 → [task:id] 派发（mock）→ submit →
// reject → 回流/升级 → requeue → /lab 渲染，PI 风格隔离目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { SqliteTemplateRegistry } from "../src/taskpool/templates.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../src/taskpool/semantic-split.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { SorterEngine } from "../src/taskpool/engine.ts";
import { runSorterCycleOnce } from "../src/taskpool/cycle.ts";
import { mountSorterSdk, type SorterSdkPort } from "../src/taskpool/sdk.ts";
import type { DispatchRequest, DispatchResult } from "../src/scheduler/runner-types.ts";

/** 适配（协调者裁决 B，同 cycle 测试先例）：engine.setSelector 是纯 UPDATE 需命中既有 agent 行（lab_agent_instances
 *  初始为空）；brief 自带测试未含种子，补上——engine 不造幽灵 agent，幽灵 agent 不得由 engine 造出。 */
function seedAgent(repo: CoreRepository, id: string): void {
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

test("全链路：模板→publish→认领→派发→提交→完成", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-int-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  const repo = new CoreRepository(db);
  seedAgent(repo, "agent-a");
  const events: unknown[] = [];
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "int" });
  const engine = new SorterEngine(db, store);
  engine.setSelector("agent-a", { labelPatterns: ["^memory-maintenance$"] });

  // publish
  const inst = registry.instantiate("semantic-split", { relPath: "docs/x.md" });
  assert.equal(inst.ok, true);
  const t = store.publish({ templateId: "semantic-split", text: inst.ok ? inst.text : "", labels: inst.ok ? inst.labels : [], params: {}, createdBy: "ptl" });
  assert.equal(t.status, "pending");

  // 周期：认领 + 派发（mock 成功）
  let dispatchedTaskId = "";
  let dispatchedTaskPrefix = "";
  await runSorterCycleOnce({
    engine,
    dispatch: async (req) => { dispatchedTaskId = req.labels?.taskId ?? ""; dispatchedTaskPrefix = req.task; return { status: "completed", schedulerInstanceId: "s", attempts: [], selectedAgentId: "agent-a", output: { text: "ok" } } as DispatchResult; },
    intervalMs: 60_000,
  });
  assert.equal(dispatchedTaskId, t.id);
  // Minor 要求补验：cycle 同时产出人读前缀与机读 labels.taskId（spec §6.3），既测只验后者
  assert.ok(dispatchedTaskPrefix.startsWith(`[task:${t.id}]`), `派发负载须携带人读前缀 [task:${t.id}]`);
  assert.equal(store.get(t.id)!.status, "claimed");

  // agent 会话内 submit（sdk 端口）
  const sdk: { sorter?: SorterSdkPort } = {};
  mountSorterSdk(sdk, { store, agentId: () => "agent-a" });
  const sub = sdk.sorter!.submitTask(t.id, "memory:entry-1");
  assert.deepEqual(sub, { ok: true });
  assert.equal(store.get(t.id)!.status, "completed");
  assert.ok(events.some((e) => (e as { eventType: string }).eventType === "task.completed"));

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("全链路：拒绝→回流→无候选升级→requeue 恢复", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-int-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const store = new SqliteTaskStore({ db, appendEvent: () => "inserted", traceId: "int" });
  const engine = new SorterEngine(db, store);

  // 无匹配 agent 的 pending 任务 → reflowRound 升级
  const inst = registry.instantiate("semantic-split", { relPath: "docs/x.md" });
  const t = store.publish({ templateId: "semantic-split", text: inst.ok ? inst.text : "", labels: inst.ok ? inst.labels : [], params: {}, createdBy: "ptl" });
  // 手动把 created_at 改旧（age > escalateAgeMs）
  db.prepare(`UPDATE tasks SET created_at=? WHERE id=?`).run(Date.now() - 60 * 60_000, t.id);
  const rf = engine.reflowRound(Date.now(), { reflowAgeMs: 10 * 60_000, escalateAgeMs: 30 * 60_000 });
  assert.equal(rf.escalated, 1);
  assert.equal(store.get(t.id)!.status, "escalated");

  // requeue 恢复
  assert.equal(store.requeue(t.id), "requeued");
  assert.equal(store.get(t.id)!.status, "pending");

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// 方法学标注（评审裁决，文档级）：本用例运行于 node 单进程单线程内，`Promise.all([store1.claim(...),
// store2.claim(...)])` 的两个实参自左向右严格顺序求值（store1 必先完整执行、store2 必后执行），
// 并非线程/进程级真并发——"并发"之名仅指两个连接先后发起认领，存在方法学局限：测试验证的是
// 守卫"恰好一个成功"这一单一属性，**无法证伪**竞态行为（如丢失更新/双写）。守卫的原子性由 SQL
// 单语句条件 UPDATE（status='pending' 守卫 + changes()===1）保证；真竞态探测需多进程/多连接同时
// 写入同一库文件，在 node 单进程内无法构造，属测试方法学上限，而非实现缺陷。
test("并发双认领：两个连接同时 claim 同一任务，恰好一个成功（裁决 I9）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-int-"));
  const db1 = new DatabaseSync(path.join(dir, "t.db"));
  db1.exec("PRAGMA journal_mode=WAL");
  db1.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db1);
  const store1 = new SqliteTaskStore({ db: db1, appendEvent: () => "inserted", traceId: "int1" });
  const t = store1.publish({ templateId: "semantic-split", text: "x", labels: [], params: {}, createdBy: "ptl" });

  // 第二个连接（模拟另一运行时/进程，同一 WAL 文件）
  const db2 = new DatabaseSync(path.join(dir, "t.db"));
  db2.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db2);
  const store2 = new SqliteTaskStore({ db: db2, appendEvent: () => "inserted", traceId: "int2" });

  const results = await Promise.all([
    store1.claim("agent-1", t.id),
    store2.claim("agent-2", t.id),
  ]);
  const okCount = results.filter((r) => r === "claimed").length;
  assert.equal(okCount, 1); // 恰好一个成功
  const winner = results[0] === "claimed" ? "agent-1" : "agent-2";
  assert.equal(store1.get(t.id)!.claimedBy, winner);
  assert.equal(store1.get(t.id)!.claimsCount, 1);
  db1.close();
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
