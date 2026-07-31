// test/unit/commands-startbg-register.test.ts — task 5 修复验证:
// execStartBg（TUI 命令栏 /start --bg 路径）启动成功后必须登记注册表，
// 字段与 cmdStartBg 一致，使 TUI 启动的会话可被 pit restore 恢复。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock spawnSync to control hasTmux/hasPitSession/startPitSession/getPanePid
const mockSpawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: mockSpawnSync }));

import { execStartBg } from "../../src/ptl/commands.js";
import { loadRegistry } from "../../src/ptl/session-registry.js";

describe("execStartBg — TUI 命令栏启动路径登记注册表", () => {
  const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
  let home: string;
  let dataDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "startbg-"));
    dataDir = path.join(home, "data");
    fs.mkdirSync(path.join(dataDir, "state"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "pi-triple.json"),
      JSON.stringify({
        version: 3,
        defaultTemplate: TEMPLATE_ID,
        dataDir: "data",
        sharedDir: path.join("data", "shared"),
        redis: "redis://localhost:6379",
        gateway: { port: 3000 },
        templates: {
          [TEMPLATE_ID]: {
            alias: "dev",
            model: "gpt-4.1",
            provider: "openai",
            thinking: "high",
          },
        },
      }),
    );
    process.env.PI_TRIPLE_HOME = home;
    delete process.env.DATA_DIR;
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    delete process.env.PI_TRIPLE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("startPitSession 成功后 markStarted 写入注册表（字段与 cmdStartBg 一致）", async () => {
    // tmux -V → 有 tmux；has-session → 会话不存在；new-session → 成功；display-message → pid
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "-V") return { status: 0, stdout: "tmux 3.6" };
      if (cmd === "tmux" && args[0] === "has-session") return { status: 1 };
      if (cmd === "tmux" && args[0] === "new-session") return { status: 0, stderr: "" };
      if (cmd === "tmux" && args[0] === "display-message") return { status: 0, stdout: "4242" };
      return { status: 0, stdout: "" };
    });

    const r = await execStartBg("smoke-tui-reg", "dev", ["--extra", "x"]);
    expect(r.ok).toBe(true);
    expect(r.data?.name).toBe("smoke-tui-reg");

    const entry = loadRegistry(dataDir).sessions["smoke-tui-reg"];
    expect(entry).toBeDefined();
    expect(entry?.templateId).toBe(TEMPLATE_ID);
    expect(entry?.model).toBe("gpt-4.1");
    expect(entry?.provider).toBe("openai");
    expect(entry?.thinking).toBe("high");
    expect(entry?.extraArgs).toEqual(["--extra", "x"]);
    expect(entry?.pid).toBe(4242);
    expect(typeof entry?.startedAt).toBe("number");
  });

  it("startPitSession 失败时不登记注册表", async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "-V") return { status: 0, stdout: "tmux 3.6" };
      if (cmd === "tmux" && args[0] === "has-session") return { status: 1 };
      if (cmd === "tmux" && args[0] === "new-session") return { status: 1, stderr: "boom" };
      return { status: 0, stdout: "" };
    });

    const r = await execStartBg("smoke-fail", "dev");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TMUX_ERROR");
    expect(loadRegistry(dataDir).sessions["smoke-fail"]).toBeUndefined();
  });
});
