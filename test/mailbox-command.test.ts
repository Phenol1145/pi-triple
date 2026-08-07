/**
 * /mail 命令注册验证（原 /pit，Task 1 改名）
 * 调用默认导出工厂（@pi-triple/mailbox），验证：
 *   1. registerCommand 注册的是 "mail"（非 "pit"）
 *   2. help 输出使用 /mail 前缀、无 /pit 残留
 * mailbox root 用 tmpdir 隔离；结束时触发 session_shutdown 清理 watcher（fs.watch）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pitMail from "@pi-triple/mailbox";

let root: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedTripleHome = process.env.PI_TRIPLE_HOME;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-cmd-"));
  // 隔离 mailbox root：指向 tmpdir，避免读/写真实 ~/.pi-triple
  process.env.PI_TRIPLE_HOME = root;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterAll(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedTripleHome === undefined) delete process.env.PI_TRIPLE_HOME;
  else process.env.PI_TRIPLE_HOME = savedTripleHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("/mail 命令注册", () => {
  it("工厂注册 mail 命令（非 pit），并提供 handler", () => {
    const api = {
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      setSessionName: vi.fn(),
    };

    pitMail(api);

    const calls = api.registerCommand.mock.calls;
    expect(calls.length).toBe(1);
    const [name, def] = calls[0];
    expect(name).toBe("mail");
    expect(typeof def.handler).toBe("function");
    expect(def.description).toContain("mailbox");

    // 清理：触发 session_shutdown（停 watcher fs.watch + 心跳 + 注册表）
    const shutdown = api.on.mock.calls.find(([ev]) => ev === "session_shutdown");
    expect(shutdown).toBeDefined();
    shutdown[1]({ reason: "shutdown" });
  });

  it("help 输出使用 /mail 前缀，无 /pit 残留", () => {
    const api = {
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      setSessionName: vi.fn(),
    };

    pitMail(api);

    const [name, def] = api.registerCommand.mock.calls[0];
    expect(name).toBe("mail");

    const notify = vi.fn();
    const ctx = { ui: { notify }, cwd: root };
    def.handler("help", ctx);

    const text = notify.mock.calls.map(([t]) => t).join("\n");
    expect(text).toContain("/mail send");
    expect(text).toContain("/mail inbox");
    expect(text).toContain("/mail ps");
    expect(text).not.toContain("/pit");

    const shutdown = api.on.mock.calls.find(([ev]) => ev === "session_shutdown");
    shutdown[1]({ reason: "shutdown" });
  });
});
