// N-I9 迁移测试（spec §2.2 step 5 第三轮裁决）：lab_agent_instances 增加
// memory_spec/endowment 可空列（ALTER TABLE ADD COLUMN；新库直接入 CORE_SCHEMA），
// insertAgent/getAgent 列映射包含新列（读回 round-trip）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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

function setup() {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  return { db, repo };
}

test("insertAgent/getAgent round-trips memorySpec and endowment (N-I9)", () => {
  const { db, repo } = setup();
  repo.insertAgent(agentRecord("agent-1", {
    memorySpec: { dialect: "json", maxEntries: 500 },
    endowment: { K: 100, initialFloor: 0.05 },
  }));
  const got = repo.getAgent("agent-1");
  assert.ok(got !== undefined);
  assert.deepEqual(got.memorySpec, { dialect: "json", maxEntries: 500 });
  assert.deepEqual(got.endowment, { K: 100, initialFloor: 0.05 });
  db.close();
});

test("records without memorySpec/endowment round-trip as undefined (backward compatible)", () => {
  const { db, repo } = setup();
  repo.insertAgent(agentRecord("agent-2"));
  const got = repo.getAgent("agent-2");
  assert.ok(got !== undefined);
  assert.equal(got.memorySpec, undefined);
  assert.equal(got.endowment, undefined);
  db.close();
});

test("old-schema DB (no memory_spec/endowment columns) gets columns via migration, then round-trips", () => {
  const db = new DatabaseSync(":memory:");
  // 先跑当前 schema，再把 lab_agent_instances 替换成 N-I9 之前的旧形状（无 memory_spec/endowment）
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
  // CoreRepository 构造 = CORE_SCHEMA（IF NOT EXISTS no-op）+ _applyCoreMigrations（ALTER 补列）
  const repo = new CoreRepository(db);
  const cols = db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "memory_spec"), "memory_spec column added by migration");
  assert.ok(cols.some((c) => c.name === "endowment"), "endowment column added by migration");
  repo.insertAgent(agentRecord("agent-old", {
    memorySpec: { dialect: "markdown" },
    endowment: { K: 50, initialFloor: 0.1 },
  }));
  const got = repo.getAgent("agent-old");
  assert.ok(got !== undefined);
  assert.deepEqual(got.memorySpec, { dialect: "markdown" });
  assert.deepEqual(got.endowment, { K: 50, initialFloor: 0.1 });
  db.close();
});
