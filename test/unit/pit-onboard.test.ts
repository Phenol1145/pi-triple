import { describe, it, expect } from "vitest";
import { cmdOnboard, type OnboardPrompter, type OnboardDeps } from "../../packages/framework/src/cli/onboard.js";

function fakeDeps(): OnboardDeps {
  return {
    doctor: async () => {},
    saveConfig: () => {},
    ensureTemplate: async () => ({ created: true, alias: "default" }),
    initShared: () => [],
    linkShared: () => {},
    migrateDirs: () => [],
    launchTui: async () => {},
  };
}

describe("cmdOnboard 向导", () => {
  it("TTY + prompter：询问后立即启动 TUI（confirm=true）", async () => {
    const launched: string[] = [];
    const deps = fakeDeps();
    deps.launchTui = async () => { launched.push("tui"); };
    const prompter: OnboardPrompter = {
      confirm: async () => true,
      text: async (_q, def) => def ?? "",
    };
    await cmdOnboard({}, prompter, deps);
    expect(launched).toEqual(["tui"]);
  });

  it("confirm=false → 不启动 TUI", async () => {
    const launched: string[] = [];
    const deps = fakeDeps();
    deps.launchTui = async () => { launched.push("tui"); };
    const prompter: OnboardPrompter = { confirm: async () => false, text: async (_q, d) => d ?? "" };
    await cmdOnboard({}, prompter, deps);
    expect(launched).toHaveLength(0);
  });

  it("无 prompter（非 TTY 退化）→ 线性流程，不启动 TUI、不抛错", async () => {
    const launched: string[] = [];
    const deps = fakeDeps();
    deps.launchTui = async () => { launched.push("tui"); };
    await cmdOnboard({}, undefined, deps);
    expect(launched).toHaveLength(0);
  });
});
