import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/ptl/pit.js";

describe("parseArgs", () => {
  it("pit start local → local 进 passthrough（不是 subcommand）", () => {
    const r = parseArgs(["start", "local"]);
    expect(r.command).toBe("start");
    expect(r.subcommand).toBe("");
    expect(r.passthrough).toContain("local");
  });

  it("pit template ls → ls 是 subcommand", () => {
    const r = parseArgs(["template", "ls"]);
    expect(r.command).toBe("template");
    expect(r.subcommand).toBe("ls");
  });

  it("pit start --template --bg → 报错（valued flag 缺值）", () => {
    expect(() => parseArgs(["start", "--template", "--bg"])).toThrow(/--template/);
  });

  it("pit start --template（结尾无值）→ 报错", () => {
    expect(() => parseArgs(["start", "--template"])).toThrow(/--template/);
  });

  it("pit start --template local --bg → 正常解析", () => {
    const r = parseArgs(["start", "--template", "local", "--bg"]);
    expect(r.flags.template).toBe("local");
    expect(r.flags.bg).toBe("true");
  });

  it("pit start local --bg → passthrough 含 local，flags.bg=true", () => {
    const r = parseArgs(["start", "local", "--bg"]);
    expect(r.command).toBe("start");
    expect(r.passthrough).toContain("local");
    expect(r.flags.bg).toBe("true");
  });

  it("pit shared status → status 是 subcommand", () => {
    const r = parseArgs(["shared", "status"]);
    expect(r.command).toBe("shared");
    expect(r.subcommand).toBe("status");
  });

  it("pit attach coding → coding 进 passthrough（attach 不是子命令白名单）", () => {
    const r = parseArgs(["attach", "coding"]);
    expect(r.command).toBe("attach");
    expect(r.passthrough).toEqual(["coding"]);
  });

  it("pit tui dashboard → dashboard 是 subcommand", () => {
    const r = parseArgs(["tui", "dashboard"]);
    expect(r.command).toBe("tui");
    expect(r.subcommand).toBe("dashboard");
  });

  it("pit tui（无子命令）→ subcommand 为空", () => {
    const r = parseArgs(["tui"]);
    expect(r.command).toBe("tui");
    expect(r.subcommand).toBe("");
  });

  it("pit hub submit → submit 是 subcommand，目录进 passthrough", () => {
    const r = parseArgs(["hub", "submit", "my-agent"]);
    expect(r.command).toBe("hub");
    expect(r.subcommand).toBe("submit");
    expect(r.passthrough).toEqual(["my-agent"]);
  });

  it("pit tui lab --template dev → subcommand=lab，flags.template 不被吞", () => {
    const r = parseArgs(["tui", "lab", "--template", "dev"]);
    expect(r.command).toBe("tui");
    expect(r.subcommand).toBe("lab");
    expect(r.flags.template).toBe("dev");
  });
});

describe("parseArgs config 子命令", () => {
  it("pit config get redis → get 是 subcommand，redis 进 passthrough", () => {
    const r = parseArgs(["config", "get", "redis"]);
    expect(r.command).toBe("config");
    expect(r.subcommand).toBe("get");
    expect(r.passthrough).toEqual(["redis"]);
  });
});
