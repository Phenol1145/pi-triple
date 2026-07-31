import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createBiddingTraceProvider } from "../../src/ptl/session/trace-provider.js";
import type { TraceProvider } from "../../src/ptl/session/session-provider.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE credit_tx (id TEXT PRIMARY KEY, ts INTEGER, agent TEXT, delta REAL, reason TEXT, task_id TEXT);
    CREATE TABLE market_tasks (task_id TEXT PRIMARY KEY, round INTEGER, role TEXT, prompt TEXT, difficulty TEXT, odds REAL, reward REAL, winner TEXT, winner_model TEXT, stake REAL, status TEXT, created_ts INTEGER, template_id TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, task_category TEXT, acceptance TEXT, completion REAL NOT NULL, tokens_in INTEGER, tokens_out INTEGER, cost REAL, tool_success REAL, turns INTEGER, interrupted INTEGER, signals TEXT, source TEXT NOT NULL, trace_id TEXT, template_id TEXT, session_id TEXT, agent_instance_id TEXT);
    CREATE TABLE lab_events (event_id TEXT PRIMARY KEY, event_type TEXT, schema_version TEXT, timestamp INTEGER, identity TEXT);
  `);
  db.prepare(`INSERT INTO credit_tx (id, ts, agent, delta, reason, task_id) VALUES (?, ?, ?, ?, ?, ?)`).run("tx1", 1785427805000, "agent-a", -5, "settle-loss", "task-1");
  db.prepare(`INSERT INTO credit_tx (id, ts, agent, delta, reason, task_id) VALUES (?, ?, ?, ?, ?, ?)`).run("tx2", 1785427905000, "agent-a", 10, "settle-win", "task-2");
  db.prepare(`INSERT INTO market_tasks (task_id, round, role, prompt, difficulty, odds, reward, winner, winner_model, stake, status, created_ts, template_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("task-1", 1, "coder", "write tests", "easy", 2, 5, "agent-b", "model-x", 5, "settled", 1785427800000, "t1");
  db.prepare(`INSERT INTO runs (id, ts, role, model, completion, source, template_id) VALUES (?,?,?,?,?,?,?)`).run(1, 1785427801000, "coder", "model-x", 1.0, "bidding", "t1");
  return db;
}

describe("trace-provider", () => {
  let provider: TraceProvider;
  beforeEach(() => {
    const db = makeDb();
    provider = createBiddingTraceProvider(db as any);
  });

  it("list 合并 credit_tx + market_tasks + runs 为 trace 记录", () => {
    const traces = provider.list();
    expect(traces.length).toBeGreaterThanOrEqual(3); // tx1, tx2, task-1, run1
    const credit = traces.find((t) => t.id === "tx1");
    expect(credit?.summary).toContain("-5");
    expect(credit?.kind).toBe("trace");
    const task = traces.find((t) => t.id === "task-1");
    expect(task?.summary).toContain("settled");
  });

  it("show 返回详情文本", () => {
    const traces = provider.list();
    const shown = provider.show(traces[0]!);
    expect(typeof shown).toBe("string");
    expect(shown.length).toBeGreaterThan(0);
  });

  it("timeline 按 agent 返回完整轨迹", () => {
    const tl = provider.timeline!("agent-a");
    expect(tl.length).toBeGreaterThanOrEqual(2);
    expect(tl.every((t) => t.detail["agent"] === "agent-a" || t.summary.includes("agent-a"))).toBe(true);
  });

  it("空 DB 返回空列表", () => {
    const empty = createBiddingTraceProvider(new DatabaseSync(":memory:") as any);
    expect(empty.list()).toEqual([]);
  });
});
