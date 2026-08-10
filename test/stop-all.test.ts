// UX 审计 #1 回归测试：ptl stop --all 坏命令
// 根因：parseArgs 把 --all 解析为 flag（flags.all=true），run.ts 传给 dispatch 的是
// ["", "--all"]，dispatch → execStop("", {all:"true"})；旧实现 `if (!name)` 先于
// `if (name === "--all")` 触发 → 用法错误（template rm 推荐"先执行: ptl stop --all"
// 却不可用）。
// 修复：execStop 入口处理 flags.all（在 !name 拦截之前），保留 name === "--all" 兼容。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mock @away_from/shared 的部分函数（importOriginal 保留真实 loadConfig/resolveDataDir/ERR 等）
const mocks = vi.hoisted(() => ({
  sessions: [] as { name: string }[],
  killed: [] as string[],
  stopped: [] as string[],
  hasTmux: true,
}));

vi.mock("@away_from/shared", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@away_from/shared")>();
  return {
    ...mod,
    hasTmux: () => mocks.hasTmux,
    listPtlSessions: () => mocks.sessions,
    killPtlSession: (name: string) => { mocks.killed.push(name); return true; },
    markStopped: (name: string) => { mocks.stopped.push(name); },
  };
});

import { execStop } from "../packages/framework/src/commands.js";
import { parseArgs } from "../packages/framework/src/cli/args.js";
import { dispatchCommand } from "../packages/framework/src/commands/dispatch.js";

describe("ptl stop --all（UX 审计 #1）", () => {
  let dir: string;
  let prevHome: string | undefined;
  let prevTripleHome: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-stop-all-"));
    prevTripleHome = process.env.PI_TRIPLE_HOME;
    process.env.PI_TRIPLE_HOME = dir;
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });

  afterAll(async () => {
    if (prevTripleHome === undefined) delete process.env.PI_TRIPLE_HOME;
    else process.env.PI_TRIPLE_HOME = prevTripleHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mocks.sessions = [{ name: "coding" }, { name: "research" }];
    mocks.killed = [];
    mocks.stopped = [];
    mocks.hasTmux = true;
  });

  it("parseArgs: ptl stop --all → --all 进 flags（run.ts 展平回 dispatch 的依据）", () => {
    const r = parseArgs(["stop", "--all"]);
    expect(r.command).toBe("stop");
    expect(r.flags.all).toBe("true");
    expect(r.passthrough).toEqual([]);
  });

  it("execStop 收到 flags.all → 停止所有会话（mock 2 个会话）", async () => {
    const r = await execStop("", { all: "true" });
    expect(r.ok).toBe(true);
    expect(r.data?.stopped).toEqual(["coding", "research"]);
    expect(mocks.killed).toEqual(["coding", "research"]);
    expect(mocks.stopped).toEqual(["coding", "research"]);
  });

  it("run.ts 分发形状 dispatchCommand('stop', ['', '--all']) → 两个会话都停（修复前报用法错）", async () => {
    const r = await dispatchCommand("stop", ["", "--all"]);
    expect(r.ok).toBe(true);
    expect(r.data?.stopped).toEqual(["coding", "research"]);
    expect(mocks.killed).toEqual(["coding", "research"]);
  });

  it("兼容旧调用形态：execStop('--all') 也停止所有会话", async () => {
    const r = await execStop("--all");
    expect(r.ok).toBe(true);
    expect(r.data?.stopped).toEqual(["coding", "research"]);
  });

  it("无会话 → ok:true '无后台会话'（stop --all 不报用法错）", async () => {
    mocks.sessions = [];
    const r = await execStop("", { all: "true" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("无后台会话");
    expect(r.data?.stopped).toEqual([]);
  });

  it("无 name 且无 flags → 用法提示须列出 --all（UX 修复：帮助文案补全）", async () => {
    const r = await execStop("");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("--all");
    expect(r.error?.message).toContain("--stale");
    expect(r.error?.message).toContain("--orphans");
  });

  it("tmux 未安装 → stop --all 返回 TMUX_NOT_INSTALLED（不误报用法错）", async () => {
    mocks.hasTmux = false;
    const r = await execStop("", { all: "true" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TMUX_NOT_INSTALLED");
  });
});
