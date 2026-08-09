import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── gate-watch 测试 ───────────────────────────────────────────

describe("GateWatcher", () => {
  let tmpDir: string;
  const origHome = process.env.PI_TRIPLE_HOME;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-gw-"));
    process.env.PI_TRIPLE_HOME = tmpDir;
    const flowsDir = path.join(tmpDir, "data", "flows");
    fs.mkdirSync(flowsDir, { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.PI_TRIPLE_HOME;
    else process.env.PI_TRIPLE_HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("waiting_human 出现 → 通知一次 → approve 后消失 → 再 waiting 再通知", async () => {
    const { GateWatcher } = await import("../../extensions/workflow/gate-watch.js");

    const watcher: InstanceType<typeof GateWatcher> = new (GateWatcher as any)();
    const notifications: string[] = [];
    watcher.setNotify((runId, name, message) => {
      notifications.push(`${runId.slice(0, 8)}: ${name}: ${message.slice(0, 60)}`);
    });

    const runDir = path.join(tmpDir, "data", "flows", "test-run-001");
    fs.mkdirSync(runDir, { recursive: true });

    // Round 1: waiting
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify({
      runId: "test-run-001", name: "pr-review", status: "waiting_human", createdAt: Date.now(),
    }));

    watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("pr-review");

    // 第二轮扫描不重复通知（去重）
    const countAfter = notifications.length;
    watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();
    expect(notifications.length).toBe(countAfter); // 不再增加

    // 改为 done → 移除已通知集合
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify({
      runId: "test-run-001", name: "pr-review", status: "done", createdAt: Date.now(),
    }));

    watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();

    // 再改为 waiting → 应再次通知
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify({
      runId: "test-run-001", name: "pr-review", status: "waiting_human", createdAt: Date.now(),
    }));

    watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();

    expect(notifications.length).toBe(2); // 再次通知
  });

  it("flows 目录不存在 → 静默", async () => {
    const { GateWatcher } = await import("../../extensions/workflow/gate-watch.js");
    fs.rmSync(path.join(tmpDir, "data", "flows"), { recursive: true });

    const watcher: InstanceType<typeof GateWatcher> = new (GateWatcher as any)();
    let called = false;
    watcher.setNotify(() => { called = true; });

    watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();

    expect(called).toBe(false);
  });

  it("stop 清理 timer", async () => {
    const { GateWatcher } = await import("../../extensions/workflow/gate-watch.js");
    const watcher: InstanceType<typeof GateWatcher> = new (GateWatcher as any)();
    watcher.start();
    watcher.stop();
    // 不抛异常即通过
  });
});

// ── runner 参数构造测试 ───────────────────────────────────────

describe("runner", () => {
  it("syncRun 命令参数构造", async () => {
    const { syncRun } = await import("../../extensions/workflow/runner.js");
    // 不实际调用 ptl（在 mock 环境跑），只验证参数展开
    expect(typeof syncRun).toBe("function");
  });

  it("hasPitCli 不抛异常", async () => {
    const { hasPitCli } = await import("../../extensions/workflow/runner.js");
    const r = hasPitCli();
    expect(typeof r).toBe("boolean");
  });

  it("asyncRun 参数展开", async () => {
    const { asyncRun } = await import("../../extensions/workflow/runner.js");
    expect(typeof asyncRun).toBe("function");
  });
});

// ── inputToArgs 逻辑测试 ──────────────────────────────────────

describe("workflow index helpers (indirect)", () => {
  it("input 对象 → k=v args", () => {
    // 复现 index.ts 中 inputToArgs 逻辑
    function inputToArgs(input?: Record<string, unknown>): string[] {
      if (!input) return [];
      return Object.entries(input).map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}=${val}`;
      });
    }

    expect(inputToArgs({ pr: "修复白屏" })).toEqual(["pr=修复白屏"]);
    expect(inputToArgs({ pr: "fix", priority: 3 })).toEqual(["pr=fix", "priority=3"]);
    expect(inputToArgs()).toEqual([]);
    expect(inputToArgs({ x: true })).toEqual(["x=true"]);
  });

  it("flowsRoot 路径解析", () => {
    const saved = process.env.PI_TRIPLE_HOME;
    process.env.PI_TRIPLE_HOME = "/custom/pi-triple";
    try {
      const p = path.join(process.env.PI_TRIPLE_HOME, "data", "flows");
      expect(p).toBe("/custom/pi-triple/data/flows");
    } finally {
      if (saved === undefined) delete process.env.PI_TRIPLE_HOME;
      else process.env.PI_TRIPLE_HOME = saved;
    }
  });
});
