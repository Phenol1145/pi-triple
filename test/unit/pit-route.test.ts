import { describe, it, expect } from "vitest";
import {
  resolveTuiPanel, TUI_PANELS, HUB_COMMANDS,
  DEPRECATED_COMMANDS, getDeprecatedMigration,
} from "../../src/ptl/pit/route.js";

describe("resolveTuiPanel", () => {
  it("无子命令 → dashboard", () => {
    expect(resolveTuiPanel(undefined)).toBe("dashboard");
    expect(resolveTuiPanel("")).toBe("dashboard");
  });
  it("dashboard/lab → 原样", () => {
    expect(resolveTuiPanel("dashboard")).toBe("dashboard");
    expect(resolveTuiPanel("lab")).toBe("lab");
  });
  it("未知面板 → throw", () => {
    expect(() => resolveTuiPanel("foo")).toThrow(/未知 TUI 面板/);
  });
  it("TUI_PANELS 含 dashboard 与 lab", () => {
    expect(TUI_PANELS).toContain("dashboard");
    expect(TUI_PANELS).toContain("lab");
  });
});

describe("HUB_COMMANDS", () => {
  it("含 submit/run/programs/dev", () => {
    expect(HUB_COMMANDS).toEqual(["submit", "run", "programs", "dev"]);
  });
});

describe("getDeprecatedMigration", () => {
  it("ui → pit tui dashboard", () => {
    expect(getDeprecatedMigration("ui")).toMatch(/pit tui dashboard/);
  });
  it("lab → pit tui lab", () => {
    expect(getDeprecatedMigration("lab")).toMatch(/pit tui lab/);
  });
  it("submit/run/programs/dev → pit hub …", () => {
    expect(getDeprecatedMigration("submit")).toMatch(/pit hub submit/);
    expect(getDeprecatedMigration("run")).toMatch(/pit hub run/);
    expect(getDeprecatedMigration("programs")).toMatch(/pit hub programs/);
    expect(getDeprecatedMigration("dev")).toMatch(/pit hub dev/);
  });
  it("未废弃命令 → null", () => {
    expect(getDeprecatedMigration("start")).toBeNull();
    expect(getDeprecatedMigration("tui")).toBeNull();
  });
  it("DEPRECATED_COMMANDS 恰好 6 条", () => {
    expect(Object.keys(DEPRECATED_COMMANDS).sort()).toEqual(["dev","lab","programs","run","submit","ui"]);
  });
});