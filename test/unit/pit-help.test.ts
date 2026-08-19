import { describe, it, expect, vi } from "vitest";
import { printHelp, printGettingStarted, printNamespaceHelp, printCommandHelp } from "../../packages/framework/src/cli/main.js";

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join("\n");
}

describe("printHelp（分组）", () => {
  it("含全部组标题", () => {
    const out = capture(printHelp);
    for (const g of ["日常使用", "可视化 TUI", "Operator Console", "模板与配置", "远端程序", "Agent", "系统与维护"]) {
      expect(out).toContain(g);
    }
  });
  it("含 tui/hub/operator 命令", () => {
    const out = capture(printHelp);
    expect(out).toContain("tui dashboard");
    expect(out).toContain("tui lab");
    expect(out).toContain("hub submit");
    expect(out).toContain("operator [--port p] [--no-open]");
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
    expect(out).toContain("ptl onboard");
    expect(out).toContain("ptl start");
    expect(out).toContain("ptl tui dashboard");
    expect(out).toContain("ptl help");
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
  it("operator → 含用法、--port 与 --no-open", () => {
    const out = capture(() => printCommandHelp("operator"));
    expect(out).toContain("ptl operator");
    expect(out).toContain("--port");
    expect(out).toContain("--no-open");
    expect(out).toContain("127.0.0.1");
  });
  it("未知命令 → 退化 printHelp（含分组标题）", () => {
    const out = capture(() => printCommandHelp("nonexistent-cmd"));
    expect(out).toContain("日常使用");
  });
});
