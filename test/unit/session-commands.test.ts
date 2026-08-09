import { describe, it, expect } from "vitest";
import { resolveDispatch } from "../../packages/framework/src/commands/dispatch.js";

describe("dispatch session/trace", () => {
  it("session 子命令解析到 exec", () => {
    expect(resolveDispatch("session", ["ls"])?.kind).toBe("exec");
    expect(resolveDispatch("session", ["show", "abc"])?.kind).toBe("exec");
    expect(resolveDispatch("session", ["fork", "abc"])?.kind).toBe("exec");
    expect(resolveDispatch("session", ["branch", "abc"])?.kind).toBe("exec");
    expect(resolveDispatch("session", ["bogus"])).toBeNull();
  });

  it("trace 子命令解析到 exec", () => {
    expect(resolveDispatch("trace", ["ls"])?.kind).toBe("exec");
    expect(resolveDispatch("trace", ["timeline", "agent-a"])?.kind).toBe("exec");
    expect(resolveDispatch("trace", ["bogus"])).toBeNull();
  });

  it("execSessionBranch 缺 --at 返回用法错误", async () => {
    const { execSessionBranch } = await import("../../packages/framework/src/commands/session.js");
    const r = await execSessionBranch("abc", []);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("--at");
  });
});

describe("session/trace 命令契约", () => {
  it("execSessionLs 支持 --template/--workloop 过滤与 --json", async () => {
    const store = await import("../../packages/framework/src/session/session-store.js");
    store._resetForTests();
    store.registerSessionProvider({
      workloop: "pi",
      capabilities: [],
      list: () => [
        { id: "aaaaaaaa-1111-4111-8111-111111111111", kind: "session", workloop: "pi", templateId: "t1", templateAlias: "dev", status: "running", timestamp: "2026-07-01T00:00:00.000Z", summary: "● 运行中 · 3 事件", detail: {} },
        { id: "bbbbbbbb-2222-4222-8222-222222222222", kind: "session", workloop: "pi", templateId: "t2", templateAlias: "prod", status: "stopped", timestamp: "2026-07-01T00:00:00.000Z", summary: "○ 停止 · 1 事件", detail: {} },
      ],
      show: () => "",
    });
    const { execSessionLs } = await import("../../packages/framework/src/commands/session.js");
    const byTpl = await execSessionLs(["--template", "dev"]);
    expect(byTpl.ok).toBe(true);
    expect(byTpl.data?.sessions).toHaveLength(1);
    expect(byTpl.message).toContain("●");
    const byWorkloop = await execSessionLs(["--workloop", "pi"]);
    expect(byWorkloop.data?.sessions).toHaveLength(2);
    const json = await execSessionLs(["--json"]);
    expect(json.ok).toBe(true);
    expect(json.data?.sessions).toHaveLength(2);
    expect(json.message).toBe("");
  });

  it("execTraceLs --json 返回 traces 数据并支持 --agent 过滤", async () => {
    const store = await import("../../packages/framework/src/session/session-store.js");
    store._resetForTests();
    store.registerTraceProvider({
      workloop: "bidding",
      list: () => [
        { id: "trace-1", kind: "trace", workloop: "bidding", templateId: "t1", timestamp: "2026-07-01T00:00:00.000Z", summary: "credit -5 · agent-a", detail: { agent: "agent-a" } },
      ],
      show: () => "trace",
    });
    const { execTraceLs } = await import("../../packages/framework/src/commands/trace.js");
    const json = execTraceLs(["--json"]);
    expect(json.ok).toBe(true);
    expect(json.data?.traces).toHaveLength(1);
    const filtered = execTraceLs(["--agent", "nobody"]);
    expect(filtered.data?.traces).toHaveLength(0);
    expect(filtered.message).toContain("无追踪");
  });

  it("traceTimeline 聚合 provider 的 timeline", async () => {
    const store = await import("../../packages/framework/src/session/session-store.js");
    store._resetForTests();
    store.registerTraceProvider({
      workloop: "bidding",
      list: () => [],
      show: () => "",
      timeline: (agentId) => [
        { id: "tl-1", kind: "trace", workloop: "bidding", templateId: "", timestamp: "2026-07-01T00:00:00.000Z", summary: `credit -5 · ${agentId}`, detail: { agent: agentId } },
      ],
    });
    expect(store.traceTimeline("agent-a")).toHaveLength(1);
    expect(store.traceTimeline("agent-b")[0]?.detail["agent"]).toBe("agent-b");
  });
});
