import { describe, it, expect } from "vitest";
import {
  resolveTuiPanel, TUI_PANELS, HUB_COMMANDS,
  DEPRECATED_COMMANDS, getDeprecatedMigration,
} from "../../src/ptl/pit/route.js";
import { cmdTui, type TuiLaunchOpts } from "../../src/ptl/pit/route.js";

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

  it("pit tui（无子命令）→ 默认 dashboard", async () => {
    const { calls, fake } = collect();
    await cmdTui("", {}, fake);
    expect(calls).toEqual([{ panel: "dashboard", flags: {} }]);
  });

  it("pit tui dashboard → dashboard", async () => {
    const { calls, fake } = collect();
    await cmdTui("dashboard", {}, fake);
    expect(calls[0].panel).toBe("dashboard");
  });

  it("pit tui lab --template dev → lab + flags 透传", async () => {
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
