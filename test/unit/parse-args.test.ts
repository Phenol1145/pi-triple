import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/ptl/pit.js";

describe("parseArgs", () => {
  it("pit start local → local 进 passthrough（不是 subcommand）", () => {
    const r = parseArgs(["start", "local"]);
    expect(r.command).toBe("start");
    expect(r.subcommand).toBe("");
    expect(r.passthrough).toContain("local");
  });

  it("pit tenant ls → ls 是 subcommand", () => {
    const r = parseArgs(["tenant", "ls"]);
    expect(r.command).toBe("tenant");
    expect(r.subcommand).toBe("ls");
  });

  it("pit start --tenant --bg → 报错（valued flag 缺值）", () => {
    expect(() => parseArgs(["start", "--tenant", "--bg"])).toThrow(/--tenant/);
  });

  it("pit start --tenant（结尾无值）→ 报错", () => {
    expect(() => parseArgs(["start", "--tenant"])).toThrow(/--tenant/);
  });

  it("pit start --tenant local --bg → 正常解析", () => {
    const r = parseArgs(["start", "--tenant", "local", "--bg"]);
    expect(r.flags.tenant).toBe("local");
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
});

describe("parseArgs config 子命令", () => {
  it("pit config get redis → get 是 subcommand，redis 进 passthrough", () => {
    const r = parseArgs(["config", "get", "redis"]);
    expect(r.command).toBe("config");
    expect(r.subcommand).toBe("get");
    expect(r.passthrough).toEqual(["redis"]);
  });
});
