// 任务类型注册表测试（plan Task 5 / spec §4.1）——SqliteTaskTypeRegistry + AgentInstance.accepts 列。
// 4 场景：① register + get round-trip；② 重复 id 幂等 no-op（返回既有，createdAt 不变）；
// ③ list 全量；④ AgentInstance.accepts 列 round-trip（JSON array，含旧库 ALTER 迁移 +
// Task 4 minor 裁决：新库 CORE_SCHEMA 直建 elo_global/elo_by_domain/accepts 三列）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteTaskTypeRegistry } from "../src/economy/task-types.ts";
import type { TaskType } from "../src/economy/task-types.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { CORE_SCHEMA } from "../src/core/storage/schema.ts";
import type { AgentInstanceRecord } from "../src/core/contracts.ts";

function agentRecord(id: string, over: Partial<AgentInstanceRecord> = {}): AgentInstanceRecord {
  return {
    id,
    schedulerInstanceId: "si-1",
    definition: {
      standard: {
        name: "test-agent",
        capabilities: ["test"],
        executionKind: "workloop",
        labels: {},
      },
      workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
      custom: {},
    },
    createdAtRoundId: "",
    status: "ready",
    createdAt: 1000,
    ...over,
  };
}

// ── ① register + get round-trip ───────────────────────────────────
test("① register + get round-trip：注册后按 id 取回全量字段（含可选 baseDifficulty）", () => {
  const db = new DatabaseSync(":memory:");
  const reg = new SqliteTaskTypeRegistry(db);
  reg.register({ id: "market", description: "市场任务", registeredBy: "system", createdAt: 1000 });
  reg.register({ id: "review", description: "评审", baseDifficulty: "hard", registeredBy: "system", createdAt: 2000 });
  const got = reg.get("market");
  assert.ok(got !== undefined);
  assert.deepEqual(got, { id: "market", description: "市场任务", registeredBy: "system", createdAt: 1000 });
  assert.deepEqual(reg.get("review"), { id: "review", description: "评审", baseDifficulty: "hard", registeredBy: "system", createdAt: 2000 });
  assert.equal(reg.get("missing"), undefined);
  db.close();
});

// ── ② 重复 id 幂等 no-op ──────────────────────────────────────────
test("② 重复 id 幂等 no-op：返回既有，createdAt 不变", () => {
  const db = new DatabaseSync(":memory:");
  const reg = new SqliteTaskTypeRegistry(db);
  reg.register({ id: "review", description: "评审", registeredBy: "a", createdAt: 1000 });
  reg.register({ id: "review", description: "不应生效的覆盖", registeredBy: "b", createdAt: 9999 });
  const got = reg.get("review");
  assert.ok(got !== undefined);
  assert.equal(got.createdAt, 1000, "createdAt 不变");
  assert.equal(got.description, "评审", "description 保持首次注册值");
  assert.equal(got.registeredBy, "a", "registeredBy 保持首次注册值");
  assert.equal(reg.list().length, 1, "不产生第二行");
  db.close();
});

// ── ③ list 全量 ───────────────────────────────────────────────────
test("③ list 全量：按注册顺序返回全部类型", () => {
  const db = new DatabaseSync(":memory:");
  const reg = new SqliteTaskTypeRegistry(db);
  const types: TaskType[] = [
    { id: "a", description: "A", registeredBy: "x", createdAt: 1 },
    { id: "b", description: "B", baseDifficulty: "easy", registeredBy: "x", createdAt: 2 },
    { id: "c", description: "C", registeredBy: "y", createdAt: 3 },
  ];
  for (const t of types) reg.register(t);
  const all = reg.list();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(all[1], types[1]);
  // 空库 list = 空数组
  const emptyDb = new DatabaseSync(":memory:");
  const emptyReg = new SqliteTaskTypeRegistry(emptyDb);
  assert.deepEqual(emptyReg.list(), []);
  emptyDb.close();
  db.close();
});

// ── ④ AgentInstance.accepts 列 round-trip（JSON array） ───────────
test("④a insertAgent/getAgent round-trips accepts（JSON array）", () => {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  repo.insertAgent(agentRecord("agent-acc-1", { model: "openai/gpt-4o", sourceTemplateId: "template-A", accepts: ["market", "review"] }));
  const got = repo.getAgent("agent-acc-1");
  assert.ok(got !== undefined);
  assert.deepEqual(got.accepts, ["market", "review"]);
  // listAgents 同一列 round-trip
  const listed = repo.listAgents("si-1");
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].accepts, ["market", "review"]);
  // findAgentByModel 同一列 round-trip（fix round 1：补 accepts 路径覆盖）
  const found = repo.findAgentByModel("si-1", "openai/gpt-4o", "template-A");
  assert.ok(found !== undefined);
  assert.deepEqual(found.accepts, ["market", "review"]);
  db.close();
});

test("④b records without accepts round-trip as undefined (backward compatible)", () => {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  repo.insertAgent(agentRecord("agent-acc-2"));
  const got = repo.getAgent("agent-acc-2");
  assert.ok(got !== undefined);
  assert.equal(got.accepts, undefined);
  db.close();
});

test("④c old-schema DB gets accepts via ALTER migration, then round-trips", () => {
  const db = new DatabaseSync(":memory:");
  // 先跑当前 schema，再把 lab_agent_instances 替换成旧形状（无 elo/accepts 列）
  db.exec(CORE_SCHEMA);
  db.exec("DROP TABLE lab_agent_instances");
  db.exec(`CREATE TABLE lab_agent_instances (
    id TEXT PRIMARY KEY,
    scheduler_instance_id TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    model TEXT,
    source_template_id TEXT,
    source_agent_id TEXT,
    clone_operation_id TEXT,
    created_round_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_ts INTEGER NOT NULL
  )`);
  const repo = new CoreRepository(db);
  const cols = db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "accepts"), "accepts column added by migration");
  repo.insertAgent(agentRecord("agent-old-acc", { accepts: ["market"] }));
  const got = repo.getAgent("agent-old-acc");
  assert.ok(got !== undefined);
  assert.deepEqual(got.accepts, ["market"]);
  db.close();
});

test("④d fresh CORE_SCHEMA creates elo_global/elo_by_domain/accepts directly (Task 4 minor 新库直建完整性)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(CORE_SCHEMA);
  const cols = db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "elo_global"), "elo_global in CORE_SCHEMA");
  assert.ok(cols.some((c) => c.name === "elo_by_domain"), "elo_by_domain in CORE_SCHEMA");
  assert.ok(cols.some((c) => c.name === "accepts"), "accepts in CORE_SCHEMA");
  db.close();
});
