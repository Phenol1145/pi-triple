import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import type { LabEvent } from "../src/core/contracts.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-tasks-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const events: LabEvent[] = [];
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "test" });
  return { dir, db, store, events };
}

function pub(store: SqliteTaskStore, overrides: Partial<Parameters<SqliteTaskStore["publish"]>[0]> = {}) {
  return store.publish({ templateId: "semantic-split", text: "任务文本", labels: ["memory-maintenance"], params: {}, createdBy: "me", ...overrides });
}

test("publish → pending + 事件", () => {
  const { dir, db, store, events } = fresh();
  const t = pub(store);
  assert.equal(t.status, "pending");
  assert.equal(t.claimsCount, 0);
  assert.deepEqual(t.rejects, []);
  assert.ok(t.id.length > 0);
  assert.ok(events.some((e) => e.eventType === "task.published"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("claim 守卫：pending 可认领；二次认领/他人认领被拒", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  assert.equal(store.claim("agent-a", t.id), "claimed");
  assert.equal(store.claim("agent-b", t.id), "not-pending");
  assert.equal(store.get(t.id)!.claimedBy, "agent-a");
  assert.equal(store.get(t.id)!.claimsCount, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reject 守卫：仅本人可拒绝，拒绝后带原因与排除记录", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  assert.equal(store.reject("someone-else", t.id, "x"), "not-claimed-by-you"); // 未认领
  store.claim("agent-a", t.id);
  assert.equal(store.reject("agent-b", t.id, "x"), "not-claimed-by-you");
  assert.equal(store.reject("agent-a", t.id, "缺工具"), "rejected");
  const got = store.get(t.id)!;
  assert.equal(got.status, "rejected");
  assert.equal(got.rejects.length, 1);
  assert.equal(got.rejects[0]!.agentId, "agent-a");
  assert.equal(got.rejects[0]!.reason, "缺工具");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("submit 守卫：仅本人可提交，提交即完成（瞬态 submitted）", () => {
  const { dir, db, store, events } = fresh();
  const t = pub(store);
  assert.equal(store.submit("nobody", t.id, "out"), "not-claimed-by-you");
  store.claim("agent-a", t.id);
  assert.equal(store.submit("agent-a", t.id, "memory:entry-1"), "submitted");
  const got = store.get(t.id)!;
  assert.equal(got.status, "completed");
  assert.ok(got.completedAt);
  const submittedEvt = events.find((e) => e.eventType === "task.submitted")!;
  assert.ok(submittedEvt.payload?.includes?.("memory:entry-1") || (submittedEvt.payload as { outputRef?: string })?.outputRef === "memory:entry-1");
  assert.ok(events.some((e) => e.eventType === "task.completed"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("requeue 清 rejects + 重置计数；reflow 保留 rejects", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  store.claim("agent-a", t.id);
  store.reject("agent-a", t.id, "r1");
  store.claim("agent-a", t.id);
  store.reject("agent-a", t.id, "r2");
  let got = store.get(t.id)!;
  assert.equal(got.rejects.length, 2);
  assert.equal(got.claimsCount, 2);

  assert.equal(store.requeue(t.id), "requeued"); // 清 + 重置
  got = store.get(t.id)!;
  assert.equal(got.status, "pending");
  assert.deepEqual(got.rejects, []);
  assert.equal(got.claimsCount, 0);

  store.claim("agent-b", t.id);
  store.reject("agent-b", t.id, "r3");
  assert.equal(store.reflow(t.id), "reflowed"); // 保留排除
  got = store.get(t.id)!;
  assert.equal(got.status, "pending");
  assert.equal(got.rejects.length, 1);
  assert.equal(got.claimsCount, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("escalate 仅从 rejected/pending/claimed 可入；requeue 可恢复", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  assert.equal(store.escalate(t.id, "no-candidate"), "escalated");
  assert.equal(store.get(t.id)!.status, "escalated");
  assert.equal(store.escalate(t.id, "again"), "not-escalatable");
  assert.equal(store.requeue(t.id), "requeued");
  assert.equal(store.get(t.id)!.status, "pending");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("escalate 支持 claimed 源态（claims_count≥3 阈值升级，裁决 N1）", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  store.claim("agent-a", t.id);
  store.reject("agent-a", t.id, "r1");
  store.claim("agent-b", t.id);
  store.reject("agent-b", t.id, "r2");
  store.claim("agent-c", t.id); // claims_count=3
  assert.equal(store.escalate(t.id, "claims-exceeded"), "escalated"); // claimed 源态可升级
  assert.equal(store.get(t.id)!.status, "escalated");
  assert.equal(store.get(t.id)!.claimsCount, 3);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("list 按状态过滤", () => {
  const { dir, db, store } = fresh();
  const a = pub(store);
  const b = pub(store);
  store.claim("agent-a", a.id);
  assert.equal(store.list({ status: "pending" }).length, 1);
  assert.equal(store.list({ status: "claimed" }).length, 1);
  assert.equal(store.list({ claimedBy: "agent-a" }).length, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
