// test/unit/tui-lab-render.test.tsx — Task 8: tui-lab 页面渲染（ink-testing-library）
// 证据：Telemetry 表可选中 + 选中行下方 LineChart；Arena WORKLOOP 列（含 sanitize 回退）。
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { DatabaseSync } from "node:sqlite";
import { TelemetryPage } from "../../packages/framework/src/tui-lab/telemetry.js";
import { ArenaPage } from "../../packages/framework/src/tui-lab/arena.js";

afterEach(cleanup);

const RUNS_SCHEMA = `CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, task_category TEXT, acceptance TEXT, completion REAL NOT NULL, tokens_in INTEGER, tokens_out INTEGER, cost REAL, tool_success REAL, turns INTEGER, interrupted INTEGER, signals TEXT, source TEXT NOT NULL, trace_id TEXT, template_id TEXT, session_id TEXT, agent_instance_id TEXT)`;

function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function makeRunsDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(RUNS_SCHEMA);
  const day0 = localDayStart(Date.now()) - 86400_000; // 昨天
  const ins = db.prepare(`INSERT INTO runs (ts, role, model, completion, source) VALUES (?,?,?,?,?)`);
  // 昨天：m1 1/2 成功 + m2 1/1 成功；今天：m1 1/1 成功 → 两行聚合 + 非平坦真实趋势
  ins.run(day0, "coder", "m1", 1.0, "bidding");
  ins.run(day0 + 3600_000, "coder", "m1", 0.0, "bidding");
  ins.run(day0 + 3600_000, "coder", "m2", 1.0, "bidding");
  ins.run(day0 + 86400_000, "coder", "m1", 1.0, "bidding");
  return db;
}

describe("TelemetryPage", () => {
  it("TREND 列为真实 sparkline；选中行下方渲染 LineChart（label 随 ↑↓ 更新）", async () => {
    const db = makeRunsDb();
    const app = render(<TelemetryPage db={db} templateId={undefined} refreshKey={0} />);
    await new Promise((r) => setTimeout(r, 20));
    let frame = app.lastFrame() ?? "";

    // 表格 + TREND 列（sparkline 字符；首日 0.5/次日 1.0 → 非平坦，非 "n/a"）
    expect(frame).toContain("TREND");
    expect(frame).toContain("coder");
    expect(frame).not.toContain("n/a");
    expect(frame).toContain("▁");

    // 默认选中第 0 行（m1，runs 更多在前）→ LineChart 出现，label 含该行 model
    expect(frame).toContain("7日成功率 · coder/m1");
    expect(frame).toContain("100%");

    // ↓ 移动选中到第 1 行 → label 更新为 m2（受控 selection + useInput 联动）
    app.stdin.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 50));
    frame = app.lastFrame() ?? "";
    expect(frame).toContain("7日成功率 · coder/m2");
    db.close();
  });
});

describe("ArenaPage", () => {
  it("WORKLOOP 列渲染表头 + agent-arena-<sanitized> 回退命中的 workLoop.id", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE credits (agent TEXT, balance REAL, frozen REAL, updated_ts INTEGER)`);
    db.exec(`CREATE TABLE market_tasks (task_id TEXT, role TEXT, winner TEXT, stake REAL, status TEXT, created_ts INTEGER)`);
    db.exec(`CREATE TABLE arena_freezes (task_id TEXT, agent TEXT, amount REAL, created_ts INTEGER)`);
    db.exec(`CREATE TABLE lab_agent_instances (id TEXT PRIMARY KEY, scheduler_instance_id TEXT NOT NULL, definition_json TEXT NOT NULL, source_agent_id TEXT, clone_operation_id TEXT, created_round_id TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?,?,?,?)`).run("deepseek/deepseek-chat", 100, 0, 1);
    db.prepare(`INSERT INTO lab_agent_instances (id, scheduler_instance_id, definition_json, created_round_id, status, created_ts) VALUES (?,?,?,?,?,?)`).run(
      "agent-arena-deepseek-deepseek-chat",
      "s1",
      '{"workLoop":{"id":"pi-default-loop"}}',
      "r1",
      "ready",
      1,
    );

    const app = render(<ArenaPage db={db} refreshKey={0} templateAlias="local" />);
    await new Promise((r) => setTimeout(r, 20));
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("WORKLOOP"); // 表头
    expect(frame).toContain("pi-default-loop"); // 回退命中（credits.agent=模型名 → agent-arena-<sanitized>）
    expect(frame).toContain("deepseek/deepseek-chat");
    db.close();
  });

  it("无 agents（credits 空）→ 可操作空态文案", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE credits (agent TEXT, balance REAL, frozen REAL, updated_ts INTEGER)`);
    db.exec(`CREATE TABLE market_tasks (task_id TEXT, role TEXT, winner TEXT, stake REAL, status TEXT, created_ts INTEGER)`);
    db.exec(`CREATE TABLE arena_freezes (task_id TEXT, agent TEXT, amount REAL, created_ts INTEGER)`);
    const app = render(<ArenaPage db={db} refreshKey={0} templateAlias="local" />);
    await new Promise((r) => setTimeout(r, 20));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Arena 未初始化");
    expect(frame).toContain("运行竞价任务生成数据");
    db.close();
  });
});
