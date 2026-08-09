import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { SorterEngine, matchesSelector } from "../src/taskpool/engine.ts";
import type { TaskRecord } from "../src/taskpool/tasks.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-engine-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  const repo = new CoreRepository(db);
  // 适配（协调者裁决 B）：engine 只配置既有 agent 的 selector，不创建 agent（lab_agent_instances 初始为空，
  // setSelector 的 UPDATE 需命中既有行；幽灵 agent 不得由 engine 造出）。测试先种子 agent-a/agent-b。
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
  // 修复波 B-1：engine 增设可选 appendEvent（构造第 3 参）——测试侧与 store 同源入账，便于断言 stale_reclaim 事件
  const engine = new SorterEngine(db, store, (e) => { events.push(e); return "inserted"; });
  return { dir, db, store, engine, events };
}

function task(labels: string[], text: string): Parameters<SqliteTaskStore["publish"]>[0] {
  return { templateId: "semantic-split", text, labels, params: {}, createdBy: "me" };
}

test("matchesSelector 纯函数：OR 标签 + textPattern + 空数组不设限", () => {
  assert.equal(matchesSelector({ labels: ["a", "b"], text: "hello world" }, { labelPatterns: ["^b$"] }), true);
  assert.equal(matchesSelector({ labels: ["a", "b"], text: "hello" }, { labelPatterns: ["^c$"] }), false);
  assert.equal(matchesSelector({ labels: ["a"], text: "hello world" }, { labelPatterns: [], textPattern: "world" }), true);
  assert.equal(matchesSelector({ labels: ["a"], text: "hello" }, { labelPatterns: [], textPattern: "world" }), false);
  assert.equal(matchesSelector({ labels: ["a"], text: "hello" }, { labelPatterns: [] }), true); // 空 = 不设限
});

test("setSelector/getSelector + 持久化", () => {
  const { dir, db, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^memory-maintenance$"] });
  assert.deepEqual(engine.getSelector("agent-a"), { labelPatterns: ["^memory-maintenance$"] });
  engine.setSelector("agent-a", null);
  assert.equal(engine.getSelector("agent-a"), undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("candidates 匹配 + 排除已拒 agent + 升序（裁决 I8：reflow 后排除名单真实生效）", () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^memory-maintenance$"] });
  engine.setSelector("agent-b", { labelPatterns: ["^memory-maintenance$"] });
  const t1 = store.publish(task(["memory-maintenance"], "任务一"));
  const t2 = store.publish(task(["other"], "任务二"));
  const t3 = store.publish(task(["memory-maintenance"], "任务三"));
  // 适配（修复轮1）：夹具固定 created_at 严格递增——连续 publish 同毫秒时 id tie-break 是随机 UUID 伪随机序，
  // 不保证发布序；升序/FIFO 形式断言语义需 distinct created_at 才确定（同 reflowRound 手动老化模式）
  for (const [i, t] of [t1, t2, t3].entries()) db.prepare(`UPDATE tasks SET created_at=? WHERE id=?`).run(1000 + i, t.id);
  assert.deepEqual(engine.candidates("agent-a").map((t) => t.id), [t1.id, t3.id]); // t2 不匹配
  // agent-a 拒绝过 t1 → 排除；reflow 回 pending 后排除名单仍生效
  store.claim("agent-a", t1.id);
  store.reject("agent-a", t1.id, "缺工具");
  assert.equal(store.reflow(t1.id), "reflowed"); // 保留 rejects 回 pending
  assert.equal(store.get(t1.id)!.status, "pending");
  assert.equal(store.get(t1.id)!.rejects.length, 1);
  // agent-a 的 candidates 不含 t1（排除名单生效，而非状态过滤）
  assert.deepEqual(engine.candidates("agent-a").map((t) => t.id), [t3.id]);
  // agent-b 未在排除名单 → 可见 t1
  assert.deepEqual(engine.candidates("agent-b").map((t) => t.id), [t1.id, t3.id]);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("claimTopN 原子认领前 n 个", () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const a = store.publish(task(["m"], "a"));
  const b = store.publish(task(["m"], "b"));
  const c = store.publish(task(["m"], "c"));
  // 适配（修复轮1）：同上——固定 created_at 严格递增，保证 FIFO 前 2 断言确定（同毫秒 id tie-break 不保证发布序）
  for (const [i, t] of [a, b, c].entries()) db.prepare(`UPDATE tasks SET created_at=? WHERE id=?`).run(1000 + i, t.id);
  const claimed = engine.claimTopN("agent-a", 2);
  assert.deepEqual(claimed.map((t) => t.id), [a.id, b.id]); // FIFO 前 2
  assert.equal(store.get(c.id)!.status, "pending");
  assert.equal(store.get(a.id)!.claimedBy, "agent-a");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reflowRound：时间维触发 rejected 回流 + 无候选升级 + pending 无候选升级", () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  engine.setSelector("agent-b", { labelPatterns: ["^m$"] }); // 适配：场景1 需要"仍有未排除匹配者"（agent-a 已拒 r1），否则实现按 N3 统一判据升级而非回流
  const now = Date.now();

  // 场景1：rejected 但仍有未排除匹配者 → reflow（时间维触发，保留排除）
  const r1 = store.publish(task(["m"], "r1"));
  store.claim("agent-a", r1.id);
  store.reject("agent-a", r1.id, "缺工具");
  // 手动把 rejects 最后一项的 at 改旧（age = now - rejects[last].at > reflowAgeMs）
  const row = db.prepare(`SELECT rejects FROM tasks WHERE id=?`).get(r1.id) as { rejects: string };
  const rejects = JSON.parse(row.rejects) as Array<{ agentId: string; reason: string; at: number }>;
  rejects[rejects.length - 1]!.at = now - 20 * 60_000;
  db.prepare(`UPDATE tasks SET rejects=? WHERE id=?`).run(JSON.stringify(rejects), r1.id);

  // 场景2：pending 从未认领 + 无匹配 agent → 升级（手动把 created_at 改旧）
  const p1 = store.publish(task(["unmatched-label"], "p1"));
  db.prepare(`UPDATE tasks SET created_at=? WHERE id=?`).run(now - 60 * 60_000, p1.id);

  const res = engine.reflowRound(now, { reflowAgeMs: 10 * 60_000, escalateAgeMs: 30 * 60_000 });
  assert.equal(store.get(r1.id)!.status, "pending"); // 时间维触发 reflow（保留排除）
  assert.equal(store.get(r1.id)!.rejects.length, 1);
  assert.equal(res.reflowed, 1);
  assert.equal(store.get(p1.id)!.status, "escalated"); // 无匹配 + claims_count=0 + age 超阈值
  assert.equal(res.escalated, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reclaimStale：claimed 超时回 pending 保留 claims_count", () => {
  const { dir, db, store, engine } = fresh();
  const t = store.publish(task(["m"], "t"));
  // 手动制造 claimed 且 claimed_at 陈旧
  db.prepare(`UPDATE tasks SET status='claimed', claimed_by='agent-x', claimed_at=?, claims_count=3 WHERE id=?`).run(Date.now() - 20 * 60_000, t.id);
  const n = engine.reclaimStale(10 * 60_000);
  assert.equal(n, 1);
  const got = store.get(t.id)!;
  assert.equal(got.status, "pending");
  assert.equal(got.claimsCount, 3); // 保留计数（N3：stale 产物走 claims_count 阈值路径）
  assert.equal(got.claimedBy, undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reclaimStale：成功回收发 task.stale_reclaim 事件（B-1 账本完整性）+ 计数按实际变更行", () => {
  const { dir, db, store, engine, events } = fresh();
  const now = 1_700_000_000_000;
  const t = store.publish(task(["m"], "t"));
  // 手动制造 claimed 且 claimed_at 陈旧（claims_count 保留语义随附断言）
  db.prepare(`UPDATE tasks SET status='claimed', claimed_by='agent-x', claimed_at=?, claims_count=2 WHERE id=?`).run(now - 20 * 60_000, t.id);
  const n = engine.reclaimStale(10 * 60_000, now);
  assert.equal(n, 1); // 计数按实际变更行（changes()===1），非 SELECT 命中行数
  const got = store.get(t.id)!;
  assert.equal(got.status, "pending");
  assert.equal(got.claimsCount, 2); // stale 回收保留计数
  const evs = events.filter((e) => (e as { eventType: string }).eventType === "task.stale_reclaim");
  assert.equal(evs.length, 1);
  const ev = evs[0] as { eventId: string; eventType: string; schemaVersion: string; timestamp: number; identity: { traceId: string }; payload: { taskId: string } };
  assert.equal(ev.eventType, "task.stale_reclaim");
  assert.equal(ev.schemaVersion, "1");
  assert.equal(ev.timestamp, now);
  assert.equal(ev.identity.traceId, "taskpool");
  assert.equal(ev.payload.taskId, t.id);
  assert.ok(ev.eventId.length > 0, "eventId 为 uuid 型唯一 id");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reclaimStale：0 行变更不发事件", () => {
  const { dir, db, store, engine, events } = fresh();
  const now = 1_700_000_000_000;
  store.publish(task(["m"], "t")); // pending + claimed_at NULL → 不命中 SELECT
  const n = engine.reclaimStale(10 * 60_000, now);
  assert.equal(n, 0);
  assert.equal(events.filter((e) => (e as { eventType: string }).eventType === "task.stale_reclaim").length, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("autoReject：供周期派发失败时调用（走 store 守卫 + 排除）", () => {
  const { dir, db, store, engine } = fresh();
  const t = store.publish(task(["m"], "t"));
  assert.equal(engine.autoReject("nobody", t.id, "x"), "not-claimed-by-you");
  store.claim("agent-a", t.id);
  assert.equal(engine.autoReject("agent-a", t.id, "dispatch-failed"), "rejected");
  assert.equal(store.get(t.id)!.rejects[0]!.reason, "dispatch-failed");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
