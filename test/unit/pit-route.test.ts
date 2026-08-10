import { describe, it, expect } from "vitest";
import {
  resolveTuiPanel, TUI_PANELS, HUB_COMMANDS,
  DEPRECATED_COMMANDS, getDeprecatedMigration,
} from "../../packages/framework/src/cli/route.js";
import { cmdTui, type TuiLaunchOpts, cmdHub, type HubHandlers } from "../../packages/framework/src/cli/route.js";

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
  it("含 submit/run/programs/dev/request/requests/respond/observe/debug + 容器运维族（deploy/status/logs/upgrade/exec）", () => {
    expect(HUB_COMMANDS).toEqual(["submit", "run", "programs", "dev", "request", "requests", "respond", "observe", "debug", "deploy", "status", "logs", "upgrade", "exec", "bench", "job", "console", "lineage"]);
  });
});

describe("getDeprecatedMigration", () => {
  it("ui → ptl tui dashboard", () => {
    expect(getDeprecatedMigration("ui")).toMatch(/ptl tui dashboard/);
  });
  it("lab → ptl tui lab", () => {
    expect(getDeprecatedMigration("lab")).toMatch(/ptl tui lab/);
  });
  it("submit/run/programs/dev → ptl hub …", () => {
    expect(getDeprecatedMigration("submit")).toMatch(/ptl hub submit/);
    expect(getDeprecatedMigration("run")).toMatch(/ptl hub run/);
    expect(getDeprecatedMigration("programs")).toMatch(/ptl hub programs/);
    expect(getDeprecatedMigration("dev")).toMatch(/ptl hub dev/);
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

describe("cmdHub", () => {
  function fakeHandlers() {
    const calls: Array<[string, unknown[]]> = [];
    const h: HubHandlers = {
      submit: async (...a: unknown[]) => { calls.push(["submit", a]); },
      run: async (...a: unknown[]) => { calls.push(["run", a]); },
      programs: async (...a: unknown[]) => { calls.push(["programs", a]); },
      dev: async (...a: unknown[]) => { calls.push(["dev", a]); },
      request: async (...a: unknown[]) => { calls.push(["request", a]); },
      requests: async (...a: unknown[]) => { calls.push(["requests", a]); },
      respond: async (...a: unknown[]) => { calls.push(["respond", a]); },
      observe: async (...a: unknown[]) => { calls.push(["observe", a]); },
      debug: async (...a: unknown[]) => { calls.push(["debug", a]); },
    };
    return { calls, h };
  }

  it("hub submit my-agent → handlers.submit([my-agent], flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("submit", ["my-agent"], { dry: "true" }, h);
    expect(calls[0][0]).toBe("submit");
    expect(calls[0][1][0]).toEqual(["my-agent"]);
    expect(calls[0][1][1]).toEqual({ dry: "true" });
  });

  it("hub run reviewer repo=./x → handlers.run(name, restArgs, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("run", ["reviewer", "repo=./x", "pr=42"], {}, h);
    expect(calls[0][0]).toBe("run");
    expect(calls[0][1][0]).toBe("reviewer");
    expect(calls[0][1][1]).toEqual(["repo=./x", "pr=42"]);
  });

  it("hub programs → handlers.programs(flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("programs", [], { json: "true" }, h);
    expect(calls[0][0]).toBe("programs");
    expect(calls[0][1][0]).toEqual({ json: "true" });
  });

  it("hub dev my-agent → handlers.dev(dir, rest, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("dev", ["my-agent"], {}, h);
    expect(calls[0][0]).toBe("dev");
    expect(calls[0][1][0]).toBe("my-agent");
  });

  it("hub request <desc> --slot s --urgency high → handlers.request(passthrough, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("request", ["缺一个审核 agent"], { slot: "slot-a", urgency: "high" }, h);
    expect(calls[0][0]).toBe("request");
    expect(calls[0][1][0]).toEqual(["缺一个审核 agent"]);
    expect(calls[0][1][1]).toEqual({ slot: "slot-a", urgency: "high" });
  });

  it("hub requests → handlers.requests(flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("requests", [], { json: "true" }, h);
    expect(calls[0][0]).toBe("requests");
    expect(calls[0][1][0]).toEqual({ json: "true" });
  });

  it("hub respond <id> <dir> → handlers.respond(passthrough, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("respond", ["req-1", "./my-agent"], {}, h);
    expect(calls[0][0]).toBe("respond");
    expect(calls[0][1][0]).toEqual(["req-1", "./my-agent"]);
    expect(calls[0][1][1]).toEqual({});
  });

  it("hub observe sessions --json → handlers.observe(passthrough, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("observe", ["sessions"], { json: "true" }, h);
    expect(calls[0][0]).toBe("observe");
    expect(calls[0][1][0]).toEqual(["sessions"]);
    expect(calls[0][1][1]).toEqual({ json: "true" });
  });

  it("hub observe trace <id> → handlers.observe(passthrough, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("observe", ["trace", "s-1"], {}, h);
    expect(calls[0][0]).toBe("observe");
    expect(calls[0][1][0]).toEqual(["trace", "s-1"]);
  });

  it("hub debug sandbox → handlers.debug(passthrough, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("debug", ["sandbox"], {}, h);
    expect(calls[0][0]).toBe("debug");
    expect(calls[0][1][0]).toEqual(["sandbox"]);
    expect(calls[0][1][1]).toEqual({});
  });

  it("hub debug <sessionId> → handlers.debug(passthrough, flags)", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("debug", ["sess-abc"], {}, h);
    expect(calls[0][0]).toBe("debug");
    expect(calls[0][1][0]).toEqual(["sess-abc"]);
  });

  it("hub（无子命令）→ 打印帮助，不调用任何 handler", async () => {
    const { calls, h } = fakeHandlers();
    await cmdHub("", [], {}, h);
    expect(calls).toHaveLength(0);
  });
});
