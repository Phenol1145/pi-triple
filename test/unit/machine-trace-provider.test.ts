import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createMachineTraceProvider } from "../../packages/framework/src/session/trace-provider.js";
import type { TraceProvider } from "../../packages/framework/src/session/session-provider.js";

/** 当前 lab_events 真实 schema 的列子集（provider 查询只需这些列） */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE lab_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  const ins = db.prepare(`INSERT INTO lab_events (event_id, event_type, ts, trace_id, identity_json, payload_json) VALUES (?, ?, ?, ?, ?, ?)`);
  const id = (traceId: string, seq: number, agent: string, checkpointId?: string) =>
    JSON.stringify({ traceId, executionId: "exec-1", agentInstanceId: agent, transitionSeq: seq, checkpointId });
  const pl = (fromState: string, toState: string, eventType: string, checkpointId?: string) =>
    JSON.stringify({ seq: 1, fromState, toState, eventType, checkpointId });

  ins.run("evt-1", "machine.transition", 1785427805000, "trace-1", id("trace-1", 1, "agent-1", "cp-1"), pl("idle", "delegating", "start", "cp-1"));
  ins.run("evt-2", "machine.transition", 1785427806000, "trace-1", id("trace-1", 2, "agent-1"), pl("delegating", "terminal", "pi_terminal"));
  ins.run("evt-3", "machine.transition", 1785427807000, "trace-2", id("trace-2", 1, "agent-2"), pl("idle", "terminal", "start"));
  // 容错行：坏 JSON（identity）与缺 transitionSeq 字段
  ins.run("evt-4", "machine.transition", 1785427808000, "trace-3", "not-json{", "{}");
  ins.run("evt-5", "machine.transition", 1785427809000, "trace-3", JSON.stringify({ traceId: "trace-3", agentInstanceId: "agent-3" }), pl("idle", "done", "start"));
  // 非 machine.transition 事件不应出现
  ins.run("evt-6", "agent.started", 1785427810000, "trace-1", id("trace-1", 0, "agent-1"), pl("idle", "idle", "start"));
  return db;
}

describe("machine-trace-provider", () => {
  let provider: TraceProvider;
  beforeEach(() => {
    provider = createMachineTraceProvider(makeDb() as any);
  });

  it("list 返回 machine.transition 转移序列（id/summary/detail 格式）", () => {
    const traces = provider.list();
    expect(traces).toHaveLength(3);
    const first = traces.find((t) => t.id === "trace-1:1");
    expect(first?.kind).toBe("trace");
    expect(first?.workloop).toBe("machine");
    expect(first?.templateId).toBe("");
    expect(first?.timestamp).toBe(new Date(1785427805000).toISOString());
    expect(first?.summary).toBe("转移 #1: idle→delegating · start");
    expect(first?.detail).toEqual({
      fromState: "idle",
      toState: "delegating",
      eventType: "start",
      checkpointId: "cp-1",
      traceId: "trace-1",
      agent: "agent-1",
    });
  });

  it("坏 JSON / 缺字段行跳过，非 machine.transition 事件不出现", () => {
    const traces = provider.list();
    expect(traces.some((t) => t.id.startsWith("trace-3"))).toBe(false); // 坏 JSON + 缺 transitionSeq
    expect(traces.some((t) => t.id === "trace-1:0")).toBe(false); // agent.started 事件
  });

  it("timeline 按 agentInstanceId 过滤（LIKE identity_json）", () => {
    const tl = provider.timeline!("agent-1");
    expect(tl).toHaveLength(2);
    expect(tl.every((t) => t.detail["agent"] === "agent-1")).toBe(true);
    expect(tl.map((t) => t.id).sort()).toEqual(["trace-1:1", "trace-1:2"]);
  });

  it("show 返回详情文本", () => {
    const traces = provider.list();
    const shown = provider.show(traces[0]!);
    expect(typeof shown).toBe("string");
    expect(shown).toContain("WorkLoop: machine");
    expect(shown).toContain("fromState: idle");
  });

  it("空 DB 返回空列表", () => {
    const empty = createMachineTraceProvider(new DatabaseSync(":memory:") as any);
    expect(empty.list()).toEqual([]);
  });
});
