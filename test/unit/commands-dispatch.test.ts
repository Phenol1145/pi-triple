import { describe, it, expect } from "vitest";
import { resolveDispatch, dispatchCommand } from "../../src/ptl/commands/dispatch.js";

describe("resolveDispatch — exec 目标", () => {
  it("template ls / list / 无子命令 → exec", () => {
    expect(resolveDispatch("template", ["ls"])?.kind).toBe("exec");
    expect(resolveDispatch("template", ["list"])?.kind).toBe("exec");
    expect(resolveDispatch("template", [])?.kind).toBe("exec");
  });
  it("template new/rm/rename → exec", () => {
    expect(resolveDispatch("template", ["new", "x"])?.kind).toBe("exec");
    expect(resolveDispatch("template", ["rm", "x"])?.kind).toBe("exec");
    expect(resolveDispatch("template", ["rename", "a", "b"])?.kind).toBe("exec");
  });
  it("template 未知子命令 → null", () => {
    expect(resolveDispatch("template", ["bogus"])).toBeNull();
  });
  it("status/ls/stop/start/help → exec（参数直接透传）", () => {
    expect(resolveDispatch("status", [])?.kind).toBe("exec");
    expect(resolveDispatch("ls", [])?.kind).toBe("exec");
    expect(resolveDispatch("stop", ["coding"])?.kind).toBe("exec");
    expect(resolveDispatch("start", ["bg1", "dev"])?.kind).toBe("exec");
    expect(resolveDispatch("help", [])?.kind).toBe("exec");
  });
  it("shared status → exec；shared 其他 → null", () => {
    expect(resolveDispatch("shared", ["status"])?.kind).toBe("exec");
    expect(resolveDispatch("shared", ["init"])).toBeNull();
  });
  it("detach → exec", () => {
    expect(resolveDispatch("detach", [])?.kind).toBe("exec");
  });
});

describe("resolveDispatch — handoff 目标（新命令名）", () => {
  it("pi/attach/switch → ptl 子进程", () => {
    expect(resolveDispatch("pi", [])).toEqual({ kind: "handoff", cmd: "ptl", args: ["pi"] });
    expect(resolveDispatch("attach", ["coding"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["attach", "coding"] });
    expect(resolveDispatch("switch", ["coding"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["switch", "coding"] });
  });
  it("hub submit/run/programs/dev → ptl hub …（新命令名）", () => {
    expect(resolveDispatch("hub", ["submit", "my-agent"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["hub", "submit", "my-agent"] });
    expect(resolveDispatch("hub", ["run", "reviewer", "pr=1"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["hub", "run", "reviewer", "pr=1"] });
    expect(resolveDispatch("hub", ["programs"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["hub", "programs"] });
    expect(resolveDispatch("hub", ["dev", "dir"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["hub", "dev", "dir"] });
  });
  it("hub 无/未知子命令 → null", () => {
    expect(resolveDispatch("hub", [])).toBeNull();
    expect(resolveDispatch("hub", ["bogus"])).toBeNull();
  });
  it("tui dashboard/lab → ptl tui …；其他 → null", () => {
    expect(resolveDispatch("tui", ["dashboard"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["tui", "dashboard"] });
    expect(resolveDispatch("tui", ["lab"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["tui", "lab"] });
    expect(resolveDispatch("tui", [])).toBeNull();
    expect(resolveDispatch("tui", ["bogus"])).toBeNull();
  });
  it("flow 12 子命令 → ptl flow …；未知 → null", () => {
    expect(resolveDispatch("flow", ["run", "f.json", "k=v"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["flow", "run", "f.json", "k=v"] });
    expect(resolveDispatch("flow", ["ls"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["flow", "ls"] });
    expect(resolveDispatch("flow", ["approve", "r1"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["flow", "approve", "r1"] });
    expect(resolveDispatch("flow", ["validate", "f.json"])).toEqual({ kind: "handoff", cmd: "ptl", args: ["flow", "validate", "f.json"] });
    expect(resolveDispatch("flow", ["bogus"])).toBeNull();
  });
  it("未知命令 → null", () => {
    expect(resolveDispatch("bogus", [])).toBeNull();
  });
});

describe("dispatchCommand — 执行", () => {
  it("未知命令 → UNKNOWN_COMMAND 错误", async () => {
    const r = await dispatchCommand("bogus", []);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNKNOWN_COMMAND");
  });
  it("template rename 缺参 → INVALID_ARGS", async () => {
    const r = await dispatchCommand("template", ["rename"]);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_ARGS");
  });
  it("template rename 旧名不存在 → TEMPLATE_NOT_FOUND", async () => {
    const r = await dispatchCommand("template", ["rename", "no-such-template-xyz", "new"]);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TEMPLATE_NOT_FOUND");
  });
  it("hub submit → handoff 结果（不 spawn）", async () => {
    const r = await dispatchCommand("hub", ["submit", "my-agent"]);
    expect(r.ok).toBe(true);
    expect(r.handoff).toEqual({ cmd: "ptl", args: ["hub", "submit", "my-agent"] });
  });
  it("detach（非 tmux 环境）→ NOT_IN_TMUX 错误", async () => {
    // 隔离：测试进程可能继承真实 TMUX env——若不隔离，detach-client 会
    // 真的把当前 tmux client detach 掉（历史事故：跑 vitest 导致会话被 detach）
    const savedTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      const r = await dispatchCommand("detach", []);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("NOT_IN_TMUX");
    } finally {
      if (savedTmux !== undefined) process.env.TMUX = savedTmux;
    }
  });
});