// final fix wave I1 回归：ptl stop --all --json 不再报用法错
// 根因：mode.ts stop JSON router `execStop(sub || passthrough[0] || "")` 不传 flags
// → parseArgs 把 --all 解析为 flags.all，JSON router 丢 flags → execStop("") → !name
// 拦截 → "用法: ptl stop <name> | --all | --stale | --orphans"（--json 模式下也是错）。
// 修复：`execStop(sub || passthrough[0] || "", flags)`。
//
// 用 mock @pi-triple/shared 的 tmux 函数（对齐 test/stop-all.test.ts 做法）——
// 不走 E2E spawn：真实 tmux 环境下若机器上有 ptl-* 会话会被 stop --all 真杀。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  sessions: [] as { name: string }[],
  killed: [] as string[],
  stopped: [] as string[],
  hasTmux: true,
}));

vi.mock("@pi-triple/shared", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@pi-triple/shared")>();
  return {
    ...mod,
    hasTmux: () => mocks.hasTmux,
    listPtlSessions: () => mocks.sessions,
    killPtlSession: (name: string) => { mocks.killed.push(name); return true; },
    markStopped: (name: string) => { mocks.stopped.push(name); },
  };
});

import { routeJsonCommand } from "../packages/framework/src/cli/mode.js";

describe("stop --all --json（JSON router 传 flags）", () => {
  let dir: string;
  let prevHome: string | undefined;
  let prevTripleHome: string | undefined;
  let logs: any[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-stop-json-"));
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
    logs = [];
    mocks.sessions = [];
    mocks.killed = [];
    mocks.stopped = [];
    mocks.hasTmux = true;
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => { logs.push(args[0]); });
    // routeJsonCommand 失败路径 process.exit(1)：mock 掉防测试进程真退出
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stop --all --json（无会话）→ ok:true 无后台会话（修复前报用法错）", async () => {
    const routed = await routeJsonCommand("stop", undefined, { all: "true", json: "true" }, []);
    expect(routed).toBe(true);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ stopped: [] });
    expect(parsed.error).toBeNull();
  });

  it("stop --all --json（2 个会话）→ stopped 列出全部（flags.all 真正到达 execStop）", async () => {
    mocks.sessions = [{ name: "coding" }, { name: "research" }];
    const routed = await routeJsonCommand("stop", undefined, { all: "true", json: "true" }, []);
    expect(routed).toBe(true);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.stopped).toEqual(["coding", "research"]);
    expect(mocks.killed).toEqual(["coding", "research"]);
    expect(mocks.stopped).toEqual(["coding", "research"]);
  });
});
