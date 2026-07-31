import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printHelp, printGettingStarted, printNamespaceHelp, printCommandHelp } from "../../src/ptl/pit/main.js";

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join("\n");
}

describe("printHelp（分组）", () => {
  it("含全部组标题", () => {
    const out = capture(printHelp);
    for (const g of ["日常使用", "可视化 TUI", "模板与配置", "远端程序", "工作流与 Agent", "系统与维护"]) {
      expect(out).toContain(g);
    }
  });
  it("含 tui/hub 命令", () => {
    const out = capture(printHelp);
    expect(out).toContain("tui dashboard");
    expect(out).toContain("tui lab");
    expect(out).toContain("hub submit");
  });
  it("无 tenant 残留（已改名 template）", () => {
    const out = capture(printHelp);
    expect(out).not.toContain("tenant");
    expect(out).toContain("template");
  });
});

describe("printGettingStarted", () => {
  it("含 onboard/start/tui dashboard/help 四条指引", () => {
    const out = capture(printGettingStarted);
    expect(out).toContain("pit onboard");
    expect(out).toContain("pit start");
    expect(out).toContain("pit tui dashboard");
    expect(out).toContain("pit help");
  });
});

describe("printNamespaceHelp", () => {
  it("hub → 列出 submit/run/programs/dev", () => {
    const out = capture(() => printNamespaceHelp("hub"));
    for (const c of ["submit", "run", "programs", "dev"]) expect(out).toContain(c);
  });
  it("tui → 列出 dashboard/lab", () => {
    const out = capture(() => printNamespaceHelp("tui"));
    expect(out).toContain("dashboard");
    expect(out).toContain("lab");
  });
});

describe("printCommandHelp", () => {
  it("start → 含用法与示例", () => {
    const out = capture(() => printCommandHelp("start"));
    expect(out).toContain("start");
    expect(out).toContain("--template");
  });
  it("未知命令 → 退化 printHelp（含分组标题）", () => {
    const out = capture(() => printCommandHelp("nonexistent-cmd"));
    expect(out).toContain("日常使用");
  });
});
