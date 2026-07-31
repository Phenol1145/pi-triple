// test/unit/commands-session-state.test.ts — task 3: execLs 状态列（●/○/×）+ execStop --stale/--orphans
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execLs, execStop } from "../../src/ptl/commands.js";
import { markStarted, loadRegistry } from "../../src/ptl/session-registry.js";
import { ERR } from "../../src/ptl/output.js";

describe("execLs / execStop 状态增强", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cmdstate-"));
    process.env.PI_TRIPLE_HOME = root; // loadConfig 读取 pitHome
  });
  afterEach(() => {
    delete process.env.PI_TRIPLE_HOME;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("execStop --orphans 清理注册表孤儿（无 tmux 动作，返回 ok）", async () => {
    // 无配置文件 → defaultConfig dataDir = <pitHome>/data → execStop 读取同一位置
    const dataDir = path.join(root, "data");
    markStarted({ name: "ghost-1", templateId: "t1", startedAt: 1 }, dataDir);
    const r = await execStop("", { orphans: "true" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("孤儿");
    // 注册表条目已删（重新加载验证）
    expect(loadRegistry(dataDir).sessions["ghost-1"]).toBeUndefined();
  });

  it("execStop 缺 name 且无 flags → 用法错误（保持原行为，提示 --stale/--orphans）", async () => {
    const r = await execStop("");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(ERR.INTERACTIVE_REQUIRED);
    expect(r.error?.message).toContain("--stale");
  });

  it("execLs 显示注册表孤儿（× 状态列；tmux 分支 Task 5 覆盖）", async () => {
    markStarted({ name: "ghost-1", templateId: "t1", startedAt: 1 }, path.join(root, "data"));
    const r = await execLs();
    expect(r.ok).toBe(true);
    const s = r.data.sessions.find((x: any) => x.name === "ghost-1");
    expect(s).toBeDefined();
    expect(s.status).toBe("orphan");
    expect(s.template).toBe("t1");
  });
});
