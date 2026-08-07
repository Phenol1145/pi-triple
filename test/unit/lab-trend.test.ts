// test/unit/lab-trend.test.ts — Task 8: dailyTrend 按天分桶 + getWorkloops 解析
// 夹具用 sqlite :memory:（node:sqlite），不依赖真实 DB 文件。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { dailyTrend } from "../../packages/framework/src/lab-data/telemetry.js";
import { getWorkloops, agentKeyFromModel } from "../../packages/framework/src/lab-data/arena.js";

const RUNS_SCHEMA = `CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, task_category TEXT, acceptance TEXT, completion REAL NOT NULL, tokens_in INTEGER, tokens_out INTEGER, cost REAL, tool_success REAL, turns INTEGER, interrupted INTEGER, signals TEXT, source TEXT NOT NULL, trace_id TEXT, template_id TEXT, session_id TEXT, agent_instance_id TEXT)`;

/** 本地日零点 */
function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 夹具：昨天（本地日）2 条 run（1 成功），今天 1 条 run（成功）。
 * 用相对「现在」的时间戳而非固定日期，保证 dailyTrend 的 days 窗口
 * （[今天-(days-1)天, 今天]）在任何运行日期下都覆盖夹具数据。
 */
function makeRunsDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(RUNS_SCHEMA);
  const day0 = localDayStart(Date.now()) - 86400_000; // 昨天
  const ins = db.prepare(`INSERT INTO runs (ts, role, model, completion, source) VALUES (?,?,?,?,?)`);
  ins.run(day0, "coder", "m1", 1.0, "bidding");
  ins.run(day0 + 3600_000, "coder", "m1", 0.0, "bidding");
  ins.run(day0 + 86400_000, "coder", "m1", 1.0, "bidding");
  return db;
}

describe("dailyTrend", () => {
  it("按天分桶成功率，空日补 0", () => {
    const db = makeRunsDb();
    const trend = dailyTrend(db, undefined, 2);
    expect(trend).toHaveLength(2);
    expect(trend[0]!.successRate).toBe(0.5); // 第一天 1/2
    expect(trend[1]!.successRate).toBe(1); // 第二天 1/1
    // 日期为 "M/D" 格式（非空）
    expect(trend[0]!.date).toMatch(/^\d{1,2}\/\d{1,2}$/);
    expect(trend[1]!.date).toMatch(/^\d{1,2}\/\d{1,2}$/);
  });

  it("无数据返回全 0 序列（长度 = days）", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(RUNS_SCHEMA);
    const trend = dailyTrend(db, undefined, 7);
    expect(trend).toHaveLength(7);
    expect(trend.every((t) => t.successRate === 0)).toBe(true);
  });
});

describe("getWorkloops", () => {
  it("从 definition_json 解析 workLoop.id", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE lab_agent_instances (id TEXT PRIMARY KEY, scheduler_instance_id TEXT NOT NULL, definition_json TEXT NOT NULL, source_agent_id TEXT, clone_operation_id TEXT, created_round_id TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, created_round_id, status, created_ts) VALUES (?,?,?,?,?,?)`).run(
      "agent-a",
      "s1",
      '{"workLoop":{"id":"pi-default-loop","version":"1.0.0"}}',
      "r1",
      "ready",
      1,
    );
    const wl = getWorkloops(db);
    expect(wl["agent-a"]).toBe("pi-default-loop");
  });

  it("definition_json 无 workLoop → (none)；非法 JSON → (unparsed)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE lab_agent_instances (id TEXT PRIMARY KEY, scheduler_instance_id TEXT NOT NULL, definition_json TEXT NOT NULL, source_agent_id TEXT, clone_operation_id TEXT, created_round_id TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL)`);
    const ins = db.prepare(`INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, created_round_id, status, created_ts) VALUES (?,?,?,?,?,?)`);
    ins.run("agent-b", "s1", '{"model":"m1"}', "r1", "ready", 1);
    ins.run("agent-c", "s1", "not-json", "r1", "ready", 1);
    const wl = getWorkloops(db);
    expect(wl["agent-b"]).toBe("(none)");
    expect(wl["agent-c"]).toBe("(unparsed)");
  });

  it("空表返回 {}（lab_agent_instances 不存在也返回 {}）", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE lab_agent_instances (id TEXT PRIMARY KEY, scheduler_instance_id TEXT NOT NULL, definition_json TEXT NOT NULL, source_agent_id TEXT, clone_operation_id TEXT, created_round_id TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL)`);
    expect(getWorkloops(db)).toEqual({});
    // 表缺失 → 不抛错，返回 {}
    const bare = new DatabaseSync(":memory:");
    expect(getWorkloops(bare)).toEqual({});
  });
});

describe("agentKeyFromModel + 消费侧两级查找", () => {
  const LAB_SCHEMA = `CREATE TABLE lab_agent_instances (id TEXT PRIMARY KEY, scheduler_instance_id TEXT NOT NULL, definition_json TEXT NOT NULL, source_agent_id TEXT, clone_operation_id TEXT, created_round_id TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL)`;

  it("sanitize 规则与 agent-lab 命名约定一致（非字母数字 → -）", () => {
    expect(agentKeyFromModel("deepseek/deepseek-chat")).toBe("agent-arena-deepseek-deepseek-chat");
    expect(agentKeyFromModel("cohere/north-mini-code:free")).toBe("agent-arena-cohere-north-mini-code-free");
    expect(agentKeyFromModel("openai/gpt-4o")).toBe("agent-arena-openai-gpt-4o");
  });

  it("exact 命中：credits.agent 直接等于 instance id", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(LAB_SCHEMA);
    db.prepare(`INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, created_round_id, status, created_ts) VALUES (?,?,?,?,?,?)`).run(
      "agent-a",
      "s1",
      '{"workLoop":{"id":"pi-default-loop"}}',
      "r1",
      "ready",
      1,
    );
    const wl = getWorkloops(db);
    const lookup = (agent: string): string => wl[agent] ?? wl[agentKeyFromModel(agent)] ?? "-";
    expect(lookup("agent-a")).toBe("pi-default-loop");
  });

  it("sanitize 命中：credits.agent 为模型名，instance id 带 agent-arena- 前缀", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(LAB_SCHEMA);
    db.prepare(`INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, created_round_id, status, created_ts) VALUES (?,?,?,?,?,?)`).run(
      "agent-arena-deepseek-deepseek-chat",
      "s1",
      '{"workLoop":{"id":"pi-default-loop"}}',
      "r1",
      "ready",
      1,
    );
    const wl = getWorkloops(db);
    const lookup = (agent: string): string => wl[agent] ?? wl[agentKeyFromModel(agent)] ?? "-";
    expect(lookup("deepseek/deepseek-chat")).toBe("pi-default-loop");
    // 两级都不中 → "-"
    expect(lookup("missing/model")).toBe("-");
  });
});
