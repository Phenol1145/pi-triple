import { describe, it, expect } from "vitest";
import { TmuxSession, createDefaultRunner } from "../../extensions/_shared/tmux-session.js";
import type { TmuxRunner } from "../../extensions/_shared/tmux-session.js";

/** 记录 args 的可控 fake runner */
function fakeRunner(script: Array<{ match: (args: string[]) => boolean; status?: number; stdout?: string; stderr?: string }>, calls: string[][]) {
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    for (const s of script) {
      if (s.match(args)) return { status: s.status ?? 0, stdout: s.stdout ?? "", stderr: s.stderr ?? "" };
    }
    return { status: 1, stdout: "", stderr: "unmatched" };
  };
  return runner;
}

const NONE = { match: () => true, status: 1, stderr: "no session" };

describe("TmuxSession", () => {
  it("hasTmux: -V 状态判断", () => {
    const ok = new TmuxSession(fakeRunner([{ match: (a) => a[0] === "-V" }], []));
    expect(ok.hasTmux()).toBe(true);
    const no = new TmuxSession(fakeRunner([], [])); // 无匹配 → status 1
    expect(no.hasTmux()).toBe(false);
  });

  it("sanitizeName: 非法字符替换为 -，去开头 .", () => {
    const t = new TmuxSession();
    expect(t.sanitizeName("my agent")).toBe("my-agent");
    expect(t.sanitizeName("a:b")).toBe("a-b");
    expect(t.sanitizeName(".hidden")).toBe("hidden");
    expect(t.sanitizeName("正常中文名")).toBe("正常中文名");
  });

  it("listPitSessions: 过滤 pit- 前缀并去前缀", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "list-sessions", stdout: "pit-a\npit-b\nother\n0\n" },
    ], calls));
    expect(t.listPitSessions()).toEqual(["a", "b"]);
  });

  it("listSessionsDetail: 解析 name/windows/created", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "list-sessions", stdout: "pit-x 3 1700000000\npit-y 1 1700000100\n" },
    ], calls));
    const list = t.listSessionsDetail();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: "x", windows: 3 });
    expect(typeof list[0].ageSec).toBe("number");
  });

  it("startSession: 固定名参数组装（-d -s -x -y -e ... -- pi）", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "new-session" },
      NONE,
    ], calls));
    const r = t.startSession({ name: "agent1", env: { PI_SESSION_NAME: "agent1", PI_TEMPLATE: "t1" } });
    expect(r).toEqual({ ok: true, name: "agent1", error: undefined });
    const args = calls.find((c) => c[0] === "new-session")!;
    expect(args[0]).toBe("new-session");
    expect(args).toContain("-d");
    expect(args).toContain("-s");
    expect(args[args.indexOf("-s") + 1]).toBe("pit-agent1");
    expect(args).toContain("-e");
    expect(args[args.indexOf("-e") + 1]).toBe("PI_SESSION_NAME=agent1");
    expect(args[args.indexOf("-e") + 3]).toBe("PI_TEMPLATE=t1");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("pi");
  });

  it("startSession: 固定名已存在 → ok:false", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "has-session", status: 0 },
    ], calls));
    const r = t.startSession({ name: "agent1" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/running/i);
    expect(calls.filter((c) => c[0] === "new-session")).toHaveLength(0);
  });

  it("startSession: 无 name 自动生成 auto-xxxxxx（冲突重试）", () => {
    const calls: string[][] = [];
    let hasCount = 0;
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "has-session") {
        hasCount++;
        return { status: hasCount < 3 ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const t = new TmuxSession(runner);
    const r = t.startSession({});
    expect(r.ok).toBe(true);
    expect(r.name).toMatch(/^auto-[0-9a-z]{6}$/);
    expect(hasCount).toBe(3); // 2 次冲突 + 1 次成功
    const args = calls[calls.length - 1]!;
    expect(args[args.indexOf("-s") + 1]).toBe(`pit-${r.name}`);
  });

  it("stopSession: kill-session -t =pit-<name> 精确匹配", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([{ match: (a) => a[0] === "kill-session" }], calls));
    expect(t.stopSession("agent1")).toBe(true);
    const args = calls[0]!;
    expect(args).toEqual(["kill-session", "-t", "=pit-agent1"]);
  });

  it("switchTo / detach / currentSessionName / env 读写", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "switch-client" },
      { match: (a) => a[0] === "detach-client" },
      { match: (a) => a[0] === "display-message", stdout: "pit-mine\n" },
      { match: (a) => a[0] === "set-environment" },
      { match: (a) => a[0] === "show-environment", stdout: "PI_SESSION_ID=019fabc123\n" },
    ], calls));
    expect(t.switchTo("agent1")).toBe(true);
    expect(calls[0]).toEqual(["switch-client", "-t", "=pit-agent1"]);
    expect(t.detach()).toBe(true);
    expect(t.currentSessionName()).toBe("pit-mine");
    expect(t.setSessionEnv("mine", "PI_SESSION_ID", "019fabc123")).toBe(true);
    expect(calls[3]).toEqual(["set-environment", "-t", "pit-mine", "PI_SESSION_ID", "019fabc123"]);
    expect(t.getSessionEnv("mine", "PI_SESSION_ID")).toBe("019fabc123");
    expect(calls[4]).toEqual(["show-environment", "-t", "pit-mine", "PI_SESSION_ID"]);
  });

  it("getSessionEnv: 无该变量 → null", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "show-environment", status: 1 },
    ], calls));
    expect(t.getSessionEnv("x", "PI_SESSION_ID")).toBeNull();
  });
});
