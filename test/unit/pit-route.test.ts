import { describe, it, expect } from "vitest";
import {
  resolveTuiPanel, TUI_PANELS,
  DEPRECATED_COMMANDS, getDeprecatedMigration,
} from "../../packages/framework/src/cli/route.js";
import { cmdTui, type TuiLaunchOpts } from "../../packages/framework/src/cli/route.js";

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

describe("getDeprecatedMigration", () => {
  it("ui → ptl tui dashboard", () => {
    expect(getDeprecatedMigration("ui")).toMatch(/ptl tui dashboard/);
  });
  it("lab → ptl tui lab", () => {
    expect(getDeprecatedMigration("lab")).toMatch(/ptl tui lab/);
  });
  it("submit/run/programs/dev → pth program / ptl program dev", () => {
    expect(getDeprecatedMigration("submit")).toMatch(/pth program submit/);
    expect(getDeprecatedMigration("run")).toMatch(/pth program run/);
    expect(getDeprecatedMigration("programs")).toMatch(/pth program list/);
    expect(getDeprecatedMigration("dev")).toMatch(/ptl program dev/);
  });
  it("hub → pth CLI / ptl stack 迁移提示", () => {
    expect(getDeprecatedMigration("hub")).toMatch(/pth <submit|program|request|observe|debug|bench|job|console|lineage|trigger|kernel>/);
    expect(getDeprecatedMigration("hub")).toMatch(/ptl stack/);
  });
  it("未废弃命令 → null", () => {
    expect(getDeprecatedMigration("start")).toBeNull();
    expect(getDeprecatedMigration("tui")).toBeNull();
  });
  it("DEPRECATED_COMMANDS 恰好 7 条", () => {
    expect(Object.keys(DEPRECATED_COMMANDS).sort()).toEqual(["dev", "hub", "lab", "programs", "run", "submit", "ui"]);
  });
  it("原型链键（toString/constructor/__proto__）→ null", () => {
    expect(getDeprecatedMigration("toString")).toBeNull();
    expect(getDeprecatedMigration("constructor")).toBeNull();
    expect(getDeprecatedMigration("__proto__")).toBeNull();
  });
});

describe("cmdTui", () => {
  const collect = () => {
    const calls: TuiLaunchOpts[] = [];
    const fake = async (o: TuiLaunchOpts) => { calls.push(o); };
    return { calls, fake };
  };

  it("ptl tui（无子命令）→ 默认 dashboard", async () => {
    const { calls, fake } = collect();
    await cmdTui("", {}, fake);
    expect(calls).toEqual([{ panel: "dashboard", flags: {} }]);
  });

  it("ptl tui dashboard → dashboard", async () => {
    const { calls, fake } = collect();
    await cmdTui("dashboard", {}, fake);
    expect(calls[0].panel).toBe("dashboard");
  });

  it("ptl tui lab --template dev → lab + flags 透传", async () => {
    const { calls, fake } = collect();
    await cmdTui("lab", { template: "dev", global: "true" }, fake);
    expect(calls[0]).toEqual({ panel: "lab", flags: { template: "dev", global: "true" } });
  });

  it("未知面板 → 抛错（不调用 launcher）", async () => {
    const { calls, fake } = collect();
    await expect(cmdTui("foo", {}, fake)).rejects.toThrow(/未知 TUI 面板/);
    expect(calls).toHaveLength(0);
  });
});

describe("operator 命令边界", () => {
  it("operator 不是 deprecated 命令，也不属于 TUI 面板", () => {
    expect(getDeprecatedMigration("operator")).toBeNull();
    expect(TUI_PANELS).not.toContain("operator");
  });
});
