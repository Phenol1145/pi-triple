import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS credits (
      agent TEXT PRIMARY KEY, balance REAL NOT NULL, frozen REAL NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_tx (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, delta REAL NOT NULL,
      reason TEXT, task_id TEXT, round INTEGER, agent_turn INTEGER
    );
    CREATE TABLE IF NOT EXISTS market_tasks (
      task_id TEXT PRIMARY KEY, round INTEGER, role TEXT, prompt TEXT, difficulty TEXT,
      odds REAL, reward REAL, winner TEXT, winner_model TEXT, stake REAL, status TEXT, created_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS arena_freezes (
      task_id TEXT PRIMARY KEY, agent TEXT NOT NULL, amount REAL NOT NULL, created_ts INTEGER NOT NULL
    );
  `);
  return db;
}

// resolveAgentId: maps known model ids to agent UUIDs
function makeResolver(map: Record<string, string>): (v: string) => string | undefined {
  return (v) => map[v];
}

test("迁移：credits agent 从 model id → UUID，余额保留", () => {
  const db = freshDb();
  // 写入旧格式行（agent = model id）
  db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?, ?, ?, ?)`).run("openai/gpt-4o", 100, 0, Date.now());
  db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?, ?, ?, ?)`).run("anthropic/claude-3", 50, 10, Date.now());
  // 已迁移行（agent 已是 UUID）
  db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?, ?, ?, ?)`).run("uuid-99", 200, 0, Date.now());

  const resolveAgentId = makeResolver({ "openai/gpt-4o": "uuid-1", "anthropic/claude-3": "uuid-2" });
  new SqliteLedger(db, fixedEndow, resolveAgentId);

  const rows = db.prepare(`SELECT agent, balance, frozen FROM credits ORDER BY balance`).all() as { agent: string; balance: number; frozen: number }[];
  assert.equal(rows[0].agent, "uuid-2");  // anthropic → uuid-2
  assert.equal(rows[0].balance, 50);
  assert.equal(rows[0].frozen, 10);
  assert.equal(rows[1].agent, "uuid-1");  // openai → uuid-1
  assert.equal(rows[1].balance, 100);
  assert.equal(rows[2].agent, "uuid-99"); // 已是 UUID，不变
  assert.equal(rows[2].balance, 200);
});

test("迁移：credit_tx agent 字段同样迁", () => {
  const db = freshDb();
  db.prepare(`INSERT INTO credit_tx (ts, agent, delta, reason) VALUES (?, ?, ?, ?)`).run(Date.now(), "openai/gpt-4o", 50, "endowment");

  const resolveAgentId = makeResolver({ "openai/gpt-4o": "uuid-1" });
  new SqliteLedger(db, fixedEndow, resolveAgentId);

  const rows = db.prepare(`SELECT agent, delta, reason FROM credit_tx`).all() as { agent: string; delta: number; reason: string }[];
  assert.equal(rows[0].agent, "uuid-1");
  assert.equal(rows[0].delta, 50);
});

test("迁移：market_tasks winner 字段迁", () => {
  const db = freshDb();
  db.prepare(`INSERT INTO market_tasks (task_id, winner, stake, status, created_ts) VALUES (?, ?, ?, 'pending', ?)`).run("t1", "openai/gpt-4o", 100, Date.now());

  const resolveAgentId = makeResolver({ "openai/gpt-4o": "uuid-1" });
  new SqliteLedger(db, fixedEndow, resolveAgentId);

  const rows = db.prepare(`SELECT winner, stake FROM market_tasks`).all() as { winner: string; stake: number }[];
  assert.equal(rows[0].winner, "uuid-1");
  assert.equal(rows[0].stake, 100);
});

test("迁移：arena_freezes agent 字段迁", () => {
  const db = freshDb();
  db.prepare(`INSERT INTO arena_freezes (task_id, agent, amount, created_ts) VALUES (?, ?, ?, ?)`).run("f1", "openai/gpt-4o", 500, Date.now());

  const resolveAgentId = makeResolver({ "openai/gpt-4o": "uuid-1" });
  new SqliteLedger(db, fixedEndow, resolveAgentId);

  const rows = db.prepare(`SELECT agent, amount FROM arena_freezes`).all() as { agent: string; amount: number }[];
  assert.equal(rows[0].agent, "uuid-1");
  assert.equal(rows[0].amount, 500);
});

test("迁移：幂等 — 再初始化不变", () => {
  const db = freshDb();
  db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?, ?, ?, ?)`).run("openai/gpt-4o", 100, 0, Date.now());

  const resolveAgentId = makeResolver({ "openai/gpt-4o": "uuid-1" });
  new SqliteLedger(db, fixedEndow, resolveAgentId);
  // 第二次构造 — agent 已是 uuid-1，resolveAgentId 返回 undefined（不在映射中），幂等
  new SqliteLedger(db, fixedEndow, resolveAgentId);

  const rows = db.prepare(`SELECT agent, balance FROM credits`).all() as { agent: string; balance: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "uuid-1");
  assert.equal(rows[0].balance, 100);
});

test("迁移：resolveAgentId 返回相同值不更新", () => {
  const db = freshDb();
  db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?, ?, ?, ?)`).run("uuid-1", 100, 0, Date.now());

  // resolveAgentId returns same value → uuid !== row.agent is false → skip
  new SqliteLedger(db, fixedEndow, (v) => v);

  const rows = db.prepare(`SELECT agent, balance FROM credits`).all() as { agent: string; balance: number }[];
  assert.equal(rows[0].agent, "uuid-1");
  assert.equal(rows[0].balance, 100);
});
