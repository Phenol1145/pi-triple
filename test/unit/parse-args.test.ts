import { describe, it, expect } from "vitest";
import { parseArgs } from "../../packages/framework/src/cli/args.js";

describe("parseArgs", () => {
  it("ptl start local → local 进 passthrough（不是 subcommand）", () => {
    const r = parseArgs(["start", "local"]);
    expect(r.command).toBe("start");
    expect(r.subcommand).toBe("");
    expect(r.passthrough).toContain("local");
  });

  it("ptl template ls → ls 是 subcommand", () => {
    const r = parseArgs(["template", "ls"]);
    expect(r.command).toBe("template");
    expect(r.subcommand).toBe("ls");
  });

  it("ptl start --template --bg → 报错（valued flag 缺值）", () => {
    expect(() => parseArgs(["start", "--template", "--bg"])).toThrow(/--template/);
  });

  it("ptl start --template（结尾无值）→ 报错", () => {
    expect(() => parseArgs(["start", "--template"])).toThrow(/--template/);
  });

  it("ptl start --template local --bg → 正常解析", () => {
    const r = parseArgs(["start", "--template", "local", "--bg"]);
    expect(r.flags.template).toBe("local");
    expect(r.flags.bg).toBe("true");
  });

  it("ptl start local --bg → passthrough 含 local，flags.bg=true", () => {
    const r = parseArgs(["start", "local", "--bg"]);
    expect(r.command).toBe("start");
    expect(r.passthrough).toContain("local");
    expect(r.flags.bg).toBe("true");
  });

  it("模板参数（url/anchors/entryId 等）作为 valued flags 完整保留", () => {
    const r = parseArgs(["hub", "kernel", "tasks", "add", "--template", "recon-doc", "--url", "https://go.dev/blog/waza-talk", "--anchors", "go,concurrency", "--entryId", "go-waza-talk", "--kind", "research-note", "--tags", "memory"]);
    expect(r.flags.url).toBe("https://go.dev/blog/waza-talk");
    expect(r.flags.anchors).toBe("go,concurrency");
    expect(r.flags.entryId).toBe("go-waza-talk");
    expect(r.flags.kind).toBe("research-note");
    expect(r.flags.tags).toBe("memory");
    expect(r.flags.template).toBe("recon-doc");
  });

  it("ptl shared status → status 是 subcommand", () => {
    const r = parseArgs(["shared", "status"]);
    expect(r.command).toBe("shared");
    expect(r.subcommand).toBe("status");
  });

  it("ptl attach coding → coding 进 passthrough（attach 不是子命令白名单）", () => {
    const r = parseArgs(["attach", "coding"]);
    expect(r.command).toBe("attach");
    expect(r.passthrough).toEqual(["coding"]);
  });

  it("ptl tui dashboard → dashboard 是 subcommand", () => {
    const r = parseArgs(["tui", "dashboard"]);
    expect(r.command).toBe("tui");
    expect(r.subcommand).toBe("dashboard");
  });

  it("ptl tui（无子命令）→ subcommand 为空", () => {
    const r = parseArgs(["tui"]);
    expect(r.command).toBe("tui");
    expect(r.subcommand).toBe("");
  });

  it("ptl hub submit → submit 是 subcommand，目录进 passthrough", () => {
    const r = parseArgs(["hub", "submit", "my-agent"]);
    expect(r.command).toBe("hub");
    expect(r.subcommand).toBe("submit");
    expect(r.passthrough).toEqual(["my-agent"]);
  });

  it("ptl tui lab --template dev → subcommand=lab，flags.template 不被吞", () => {
    const r = parseArgs(["tui", "lab", "--template", "dev"]);
    expect(r.command).toBe("tui");
    expect(r.subcommand).toBe("lab");
    expect(r.flags.template).toBe("dev");
  });
});

describe("parseArgs config 子命令", () => {
  it("ptl config get redis → get 是 subcommand，redis 进 passthrough", () => {
    const r = parseArgs(["config", "get", "redis"]);
    expect(r.command).toBe("config");
    expect(r.subcommand).toBe("get");
    expect(r.passthrough).toEqual(["redis"]);
  });
});

describe("parseArgs operator 命令", () => {
  it("ptl operator → command=operator，无子命令", () => {
    const r = parseArgs(["operator"]);
    expect(r.command).toBe("operator");
    expect(r.subcommand).toBe("");
    expect(r.passthrough).toEqual([]);
  });

  it("ptl operator --port 8787 --host 127.0.0.1 --no-open → valued flags 与 boolean flag 正确解析", () => {
    const r = parseArgs(["operator", "--port", "8787", "--host", "127.0.0.1", "--no-open"]);
    expect(r.command).toBe("operator");
    expect(r.flags.port).toBe("8787");
    expect(r.flags.host).toBe("127.0.0.1");
    expect(r.flags["no-open"]).toBe("true");
  });

  it("ptl operator --port（缺值）→ 报错", () => {
    expect(() => parseArgs(["operator", "--port"])).toThrow(/--port/);
  });
});
