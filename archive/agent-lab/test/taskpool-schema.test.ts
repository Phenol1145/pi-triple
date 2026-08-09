import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-schema-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  return { dir, db };
}

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
}

function agentCols(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{ name: string }>).map((r) => r.name);
}

test("新库直建：task_templates/tasks 表 + 索引 + selector_json 列齐全", () => {
  const { dir, db } = freshDb();
  new CoreRepository(db); // 执行 CORE_SCHEMA + 迁移
  const ts = tables(db);
  assert.ok(ts.includes("task_templates"));
  assert.ok(ts.includes("tasks"));
  assert.ok(agentCols(db).includes("selector_json"));
  const idxs = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(idxs.includes("idx_tasks_status_created"));
  assert.ok(idxs.includes("idx_tasks_status_claimed"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("旧库迁移：无 selector_json 的既有表经 CoreRepository 构造补列（幂等）", () => {
  const { dir, db } = freshDb();
  // 模拟旧库：先建一个不含 selector_json 的 lab_agent_instances
  db.exec(`CREATE TABLE IF NOT EXISTS lab_agent_instances (
    id TEXT PRIMARY KEY, scheduler_instance_id TEXT NOT NULL, definition_json TEXT NOT NULL,
    created_round_id TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL)`);
  new CoreRepository(db); // 迁移补列
  assert.ok(agentCols(db).includes("selector_json"));
  new CoreRepository(db); // 幂等：二次构造不抛
  assert.equal(agentCols(db).filter((c) => c === "selector_json").length, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
