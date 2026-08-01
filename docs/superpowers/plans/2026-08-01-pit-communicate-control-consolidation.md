# pit-communicate / pit-control 整合实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 tmux 会话管理收敛到 pit-control、抽共享模块 `_shared/`、打通会话身份（tmux 名 ↔ sessionId ↔ registry/presence）、实现 name 持久化。

**Architecture:** 新建 `extensions/_shared/`（tmux-session.ts / registry.ts / presence.ts / paths.ts，无 index.ts 避免被 pi 误加载），pit-communicate 与 pit-control 均改为 import 共享模块；communicate 删除 tmux 三命令与本地 registry/presence 副本；control 用共享模块重构并增强（自动命名、tmux env 回写、ls 在线状态、name 持久化）。

**Tech Stack:** TypeScript 5.7（`.ts` 源码直接运行，无 build）、vitest 3、node:child_process / node:crypto、tmux CLI。

**Spec:** `docs/superpowers/specs/2026-08-01-pit-communicate-control-consolidation-design.md`

## Global Constraints

- **零外部依赖**：`_shared/` 模块只用 node 内置模块（fs/path/os/crypto/child_process），禁止 npm 包
- **`_shared/` 内禁止创建 index.ts**（pi 扩展自动发现匹配 `*/index.ts`，会误加载）
- **tmux 传参用 `-e` flag 或 argv 数组，禁 shell 字符串拼接**（平台硬约束）
- **所有 JSON 写用 tmp + rename** 原子写（registry/presence 既有协议）
- **消毒正则**：`/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g → "-"`；tmux 会话名禁 `.` 开头（tmux 硬约束）
- **import 后缀用 `.js`**（指向 `.ts` 源码，与现有扩展一致）
- 平台命令 `pit update --all` 已修复可用（bundled 同步）；`syncBundledExtensions` 的 `cpSync(force)` **不会删除目标多余文件**——communicate 删除的文件需手动从共享层清理

---

### Task 1: `_shared` 基础设施 — registry/presence/paths 迁移

**Files:**
- Create: `extensions/_shared/paths.ts`
- Create: `extensions/_shared/registry.ts`（内容 = 现 `extensions/pit-communicate/registry.ts` 原样，仅改头部注释）
- Create: `extensions/_shared/presence.ts`（内容 = 现 `extensions/pit-communicate/presence.ts` + 新增静态方法 `updateName`）
- Delete: `extensions/pit-communicate/registry.ts`、`extensions/pit-communicate/presence.ts`
- Modify: `extensions/pit-communicate/index.ts`（import 路径改 `../../_shared/...`）
- Test: `test/unit/intercom.test.ts`（import 路径改 `../../extensions/_shared/...` + 新增 updateName 测试）

**Interfaces:**
- Consumes: 无（纯文件逻辑，从 communicate 原样迁移）
- Produces:
  - `resolveMailboxRoot(): string`（env `PI_CODING_AGENT_DIR` → `resolve(agentDir,"..","..")/mailbox`，否则 `PI_TRIPLE_HOME ?? ~/.pi-triple` + `/data/mailbox`）
  - `resolveTenantId(): string`（`PI_CODING_AGENT_DIR` → basename，否则 `"local"`）
  - `class Registry { register(entry)/unregister(sessionId)/list()/get(sessionId)/cleanupStale() }`
  - `class Presence { static read(statePath)/static isOnline(statePath)/static updateName(statePath, name): boolean; 实例：start/setStatus/setMode/updateState/cleanup }`

- [ ] **Step 1: 创建 `extensions/_shared/paths.ts`**

```ts
/**
 * Pi-Triple 共享路径解析（_shared — 平台内部共享，非扩展，勿加 index.ts）
 */
import os from "node:os";
import path from "node:path";

export function resolveMailboxRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (agentDir) {
    const dataDir = path.resolve(agentDir, "..", "..");
    return path.join(dataDir, "mailbox");
  }
  return path.join(process.env.PI_TRIPLE_HOME ?? path.join(os.homedir(), ".pi-triple"), "data", "mailbox");
}

export function resolveTenantId(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (agentDir) return path.basename(agentDir);
  return "local";
}
```

- [ ] **Step 2: 迁移 registry.ts / presence.ts 到 `_shared/`**

用 `git mv` 保留历史（后续同步共享层时手动删除副本）：

```bash
cd /Users/anzhize/pi-platform
git mv extensions/pit-communicate/registry.ts extensions/_shared/registry.ts
git mv extensions/pit-communicate/presence.ts extensions/_shared/presence.ts
```

在 `extensions/_shared/presence.ts` 的 `cleanup()` 静态区（`isOnline` 之前）新增：

```ts
  /**
   * 一次性静态更新 state.json 的 name 字段（供 pit-control 使用，不启动心跳）。
   * 读-改-写原子（tmp + rename）；文件不存在或损坏返回 false。
   */
  static updateName(statePath: string, name: string): boolean {
    const state = Presence.read(statePath);
    if (!state) return false;
    state.name = name;
    state.lastHeartbeat = new Date().toISOString();
    const tmp = `${statePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, statePath);
      return true;
    } catch {
      return false;
    }
  }
```

- [ ] **Step 3: 更新 communicate 的 import 路径**

`extensions/pit-communicate/index.ts` 顶部两处：

```ts
import { Presence } from "./presence.js";
import type { SessionState } from "./presence.js";
import { Registry } from "./registry.js";
```

改为：

```ts
import { Presence } from "../../_shared/presence.js";
import type { SessionState } from "../../_shared/presence.js";
import { Registry } from "../../_shared/registry.js";
```

`index.ts` 中的本地函数 `resolveMailboxRoot` / `resolveTenantId`（约 30 行）删除，替换为：

```ts
import { resolveMailboxRoot, resolveTenantId } from "../../_shared/paths.js";
```

- [ ] **Step 4: 更新测试 import 路径 + 新增 updateName 测试**

`test/unit/intercom.test.ts` 两行：

```ts
import { Presence } from "../../extensions/pit-communicate/presence.js";
import { Registry } from "../../extensions/pit-communicate/registry.js";
```

改为：

```ts
import { Presence } from "../../extensions/_shared/presence.js";
import { Registry } from "../../extensions/_shared/registry.js";
```

在 `describe("Presence")` 内追加：

```ts
it("updateName 静态更新 name 且不破坏其他字段", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-updatename-"));
  try {
    const statePath = path.join(dir, "state.json");
    const p = new Presence(dir, {
      pid: 123, status: "idle", name: "old", model: "m", mode: "manual",
      startedAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    p.start();
    const ok = Presence.updateName(statePath, "new-name");
    expect(ok).toBe(true);
    const state = Presence.read(statePath);
    expect(state?.name).toBe("new-name");
    expect(state?.pid).toBe(123);
    p.cleanup();
    // 文件不存在 → false
    expect(Presence.updateName(path.join(dir, "nope.json"), "x")).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: 跑测试验证**

```bash
cd /Users/anzhize/pi-platform && npx vitest run test/unit/intercom.test.ts
```

预期：13 tests 全过（原 12 + 新增 updateName）——证明迁移无损、新方法正确。

- [ ] **Step 6: 类型检查 + 提交**

```bash
npm run build   # tsc 全量类型检查
git add -A extensions/_shared extensions/pit-communicate/index.ts test/unit/intercom.test.ts
git commit -m "refactor(extensions): registry/presence/paths 迁入 _shared 共享层（纯移动 + updateName 静态方法）"
```

---

### Task 2: `_shared/tmux-session.ts` 共享 tmux 模块

**Files:**
- Create: `extensions/_shared/tmux-session.ts`
- Test: `test/unit/ext-shared-tmux.test.ts`

**Interfaces:**
- Consumes: 无（Task 1 的 `_shared` 已有目录；本任务不依赖 Task 1 的产物，可并行）
- Produces:
  - `interface TmuxRunner { (args: string[], opts?: { encoding?: string }): { status: number | null; stdout: string; stderr: string } }`
  - `createDefaultRunner(): TmuxRunner`（封装 `spawnSync("tmux", args)`）
  - `class TmuxSession { constructor(runner?: TmuxRunner); hasTmux(): boolean; sanitizeName(name: string): string; listPitSessions(): string[]; listSessionsDetail(): Array<{ name: string; windows: number; ageSec: number }>; sessionExists(name: string): boolean; startSession(opts: { name?: string; env?: Record<string, string> }): { ok: boolean; name: string; error?: string }; stopSession(name: string): boolean; switchTo(name: string): boolean; detach(): boolean; currentSessionName(): string | null; setSessionEnv(name: string, key: string, value: string): boolean; getSessionEnv(name: string, key: string): string | null }`
  - 所有 `name` 参数均为**去 `pit-` 前缀**的会话名；内部拼 `pit-<name>`

- [ ] **Step 1: 写失败测试 `test/unit/ext-shared-tmux.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { TmuxSession, createDefaultRunner } from "../../extensions/_shared/tmux-session.js";
import type { TmuxRunner } from "../../extensions/_shared/tmux-session.js";

/** 记录 args 的可控 fake runner */
function fakeRunner(script: Array<{ match: (args: string[]) => boolean; status?: number; stdout?: string; stderr?: string }>, calls: string[][]) {
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    for (const s of script) {
      if (s.match(args)) return { status: s.status ?? 0, stdout: s.stdout ?? "", stderr: s.stderr ?? "" };
    }
    return { status: 1, stdout: "", stderr: "unmatched" };
  };
  return runner;
}

const NONE = { match: () => true, status: 1, stderr: "no session" };

describe("TmuxSession", () => {
  it("hasTmux: -V 状态判断", () => {
    const ok = new TmuxSession(fakeRunner([{ match: (a) => a[0] === "-V" }], []));
    expect(ok.hasTmux()).toBe(true);
    const no = new TmuxSession(fakeRunner([], [])); // 无匹配 → status 1
    expect(no.hasTmux()).toBe(false);
  });

  it("sanitizeName: 非法字符替换为 -，去开头 .", () => {
    const t = new TmuxSession();
    expect(t.sanitizeName("my agent")).toBe("my-agent");
    expect(t.sanitizeName("a:b")).toBe("a-b");
    expect(t.sanitizeName(".hidden")).toBe("hidden");
    expect(t.sanitizeName("正常中文名")).toBe("正常中文名");
  });

  it("listPitSessions: 过滤 pit- 前缀并去前缀", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "list-sessions", stdout: "pit-a\npit-b\nother\n0\n" },
    ], calls));
    expect(t.listPitSessions()).toEqual(["a", "b"]);
  });

  it("listSessionsDetail: 解析 name/windows/created", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "list-sessions", stdout: "pit-x 3 1700000000\npit-y 1 1700000100\n" },
    ], calls));
    const list = t.listSessionsDetail();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: "x", windows: 3 });
    expect(typeof list[0].ageSec).toBe("number");
  });

  it("startSession: 固定名参数组装（-d -s -x -y -e ... -- pi）", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([NONE], calls));
    const r = t.startSession({ name: "agent1", env: { PI_SESSION_NAME: "agent1", PI_TEMPLATE: "t1" } });
    expect(r).toEqual({ ok: true, name: "agent1", error: undefined });
    const args = calls[0]!;
    expect(args[0]).toBe("new-session");
    expect(args).toContain("-d");
    expect(args).toContain("-s");
    expect(args[args.indexOf("-s") + 1]).toBe("pit-agent1");
    expect(args).toContain("-e");
    expect(args[args.indexOf("-e") + 1]).toBe("PI_SESSION_NAME=agent1");
    expect(args[args.indexOf("-e") + 2]).toBe("PI_TEMPLATE=t1");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("pi");
  });

  it("startSession: 固定名已存在 → ok:false", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "has-session", status: 0 },
    ], calls));
    const r = t.startSession({ name: "agent1" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exists/i);
    expect(calls.filter((c) => c[0] === "new-session")).toHaveLength(0);
  });

  it("startSession: 无 name 自动生成 auto-xxxxxx（冲突重试）", () => {
    const calls: string[][] = [];
    let hasCount = 0;
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "has-session") {
        hasCount++;
        return { status: hasCount < 3 ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const t = new TmuxSession(runner);
    const r = t.startSession({});
    expect(r.ok).toBe(true);
    expect(r.name).toMatch(/^auto-[0-9a-z]{6}$/);
    expect(hasCount).toBe(3); // 2 次冲突 + 1 次成功
    const args = calls[calls.length - 1]!;
    expect(args[args.indexOf("-s") + 1]).toBe(`pit-${r.name}`);
  });

  it("stopSession: kill-session -t =pit-<name> 精确匹配", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([{ match: (a) => a[0] === "kill-session" }], calls));
    expect(t.stopSession("agent1")).toBe(true);
    const args = calls[0]!;
    expect(args).toEqual(["kill-session", "-t", "=pit-agent1"]);
  });

  it("switchTo / detach / currentSessionName / env 读写", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "switch-client" },
      { match: (a) => a[0] === "detach-client" },
      { match: (a) => a[0] === "display-message", stdout: "pit-mine\n" },
      { match: (a) => a[0] === "set-environment" },
      { match: (a) => a[0] === "show-environment", stdout: "PI_SESSION_ID=019fabc123\n" },
    ], calls));
    expect(t.switchTo("agent1")).toBe(true);
    expect(calls[0]).toEqual(["switch-client", "-t", "=pit-agent1"]);
    expect(t.detach()).toBe(true);
    expect(t.currentSessionName()).toBe("pit-mine");
    expect(t.setSessionEnv("mine", "PI_SESSION_ID", "019fabc123")).toBe(true);
    expect(calls[3]).toEqual(["set-environment", "-t", "pit-mine", "PI_SESSION_ID", "019fabc123"]);
    expect(t.getSessionEnv("mine", "PI_SESSION_ID")).toBe("019fabc123");
    expect(calls[4]).toEqual(["show-environment", "-t", "pit-mine", "PI_SESSION_ID"]);
  });

  it("getSessionEnv: 无该变量 → null", () => {
    const calls: string[][] = [];
    const t = new TmuxSession(fakeRunner([
      { match: (a) => a[0] === "show-environment", status: 1 },
    ], calls));
    expect(t.getSessionEnv("x", "PI_SESSION_ID")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/unit/ext-shared-tmux.test.ts
```

预期：`Cannot find module .../tmux-session.js`

- [ ] **Step 3: 实现 `extensions/_shared/tmux-session.ts`**

```ts
/**
 * Pi-Triple 共享 tmux 会话模块（_shared — 平台内部共享，非扩展，勿加 index.ts）
 *
 * 所有操作经可注入 runner（默认 spawnSync）执行，测试零真实 tmux 依赖。
 * 会话名统一为"去 pit- 前缀"的短名；tmux 实际名 = `pit-<name>`。
 */
import { spawnSync } from "node:child_process";

export interface TmuxResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface TmuxRunner {
  (args: string[], opts?: { encoding?: string }): TmuxResult;
}

export function createDefaultRunner(): TmuxRunner {
  return (args, opts) => {
    const r = spawnSync("tmux", args, { encoding: opts?.encoding ?? "utf-8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** tmux 会话名消毒：替换非法字符（禁 . 开头、禁 : 等），保留中文 */
const INVALID_RE = /[^a-zA-Z0-9_\-\u4e00-\u9fff]/g;

export class TmuxSession {
  constructor(private runner: TmuxRunner = createDefaultRunner()) {}

  hasTmux(): boolean {
    return this.runner(["-V"]).status === 0;
  }

  sanitizeName(name: string): string {
    const cleaned = name.replace(INVALID_RE, "-").replace(/^-+/, "");
    return cleaned.length === 0 ? "unnamed" : cleaned;
  }

  listPitSessions(): string[] {
    const r = this.runner(["list-sessions", "-F", "#{session_name}"]);
    return (r.stdout ?? "").trim().split("\n")
      .filter((l) => l.startsWith("pit-"))
      .map((l) => l.replace(/^pit-/, ""));
  }

  listSessionsDetail(): Array<{ name: string; windows: number; ageSec: number }> {
    const r = this.runner(["list-sessions", "-F", "#{session_name} #{session_windows} #{session_created}"]);
    const now = Math.floor(Date.now() / 1000);
    return (r.stdout ?? "").trim().split("\n")
      .filter((l) => l.startsWith("pit-"))
      .map((l) => {
        const [full, win, created] = l.split(" ");
        return {
          name: full.replace(/^pit-/, ""),
          windows: parseInt(win ?? "1", 10) || 1,
          ageSec: Math.max(0, now - parseInt(created ?? "0", 10)),
        };
      });
  }

  sessionExists(name: string): boolean {
    return this.runner(["has-session", "-t", `pit-${name}`]).status === 0;
  }

  /**
   * 启动后台 pi 会话。name 缺省时自动生成 auto-<6位base36>（唯一性重试 3 次）。
   * @returns {ok:false} 固定名已存在 / 自动名冲突耗尽
   */
  startSession(opts: { name?: string; env?: Record<string, string> }): { ok: boolean; name: string; error?: string } {
    const { name, env } = opts;
    if (name !== undefined) {
      if (this.sessionExists(name)) {
        return { ok: false, name, error: `Session "${name}" already running` };
      }
      return this.launch(name, env);
    }
    for (let i = 0; i < 3; i++) {
      const auto = `auto-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
      if (!this.sessionExists(auto)) return this.launch(auto, env);
    }
    return { ok: false, name: "", error: "auto name collision after 3 tries" };
  }

  private launch(name: string, env?: Record<string, string>): { ok: boolean; name: string; error?: string } {
    const args = ["new-session", "-d", "-s", `pit-${name}`, "-x", "200", "-y", "50"];
    for (const [k, v] of Object.entries(env ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    args.push("--", "pi");
    const r = this.runner(args);
    if (r.status === 0) return { ok: true, name, error: undefined };
    return { ok: false, name, error: r.stderr.trim() || "tmux new-session failed" };
  }

  stopSession(name: string): boolean {
    return this.runner(["kill-session", "-t", `=pit-${name}`]).status === 0;
  }

  switchTo(name: string): boolean {
    return this.runner(["switch-client", "-t", `=pit-${name}`]).status === 0;
  }

  detach(): boolean {
    return this.runner(["detach-client"]).status === 0;
  }

  /** 当前 tmux 会话名（原始名，含 pit- 前缀或任意其他会话）；非 tmux 内返回 null */
  currentSessionName(): string | null {
    const r = this.runner(["display-message", "-p", "#{session_name}"]);
    const out = (r.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  }

  setSessionEnv(name: string, key: string, value: string): boolean {
    return this.runner(["set-environment", "-t", `pit-${name}`, key, value]).status === 0;
  }

  getSessionEnv(name: string, key: string): string | null {
    const r = this.runner(["show-environment", "-t", `pit-${name}`, key]);
    if (r.status !== 0) return null;
    const line = (r.stdout ?? "").trim();
    if (!line.startsWith(`${key}=`)) return null;
    return line.slice(key.length + 1).replace(/^"(.*)"$/, "$1");
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run test/unit/ext-shared-tmux.test.ts
```

预期：10 tests 全过。

- [ ] **Step 5: 提交**

```bash
git add extensions/_shared/tmux-session.ts test/unit/ext-shared-tmux.test.ts
git commit -m "feat(extensions): _shared/tmux-session — runner 注入式 tmux 操作封装（自动命名/消毒/env 读写）"
```

---

### Task 3: pit-communicate 重构 — 删除 tmux 三命令 + 名字初始化

**Files:**
- Modify: `extensions/pit-communicate/index.ts`

**Interfaces:**
- Consumes: Task 1（`_shared/registry.js`、`_shared/paths.js`）
- Produces: communicate 命令面 = send/ask/share/broadcast/inbox/accept/reject/ps/mode/name/status/help；`PI_SESSION_NAME` 环境变量约定（Task 4 消费）

- [ ] **Step 1: 调整 sessionName 初始化顺序（registry 优先于默认名）**

`extensions/pit-communicate/index.ts` 中，将：

```ts
  let sessionName = `session-${sessionId.slice(0, 6)}`;
  let cachedCtx: any = null;

  const presence = new Presence(mailbox.baseDir, {
```

改为（注意 Registry 实例需在 sessionName 之前创建——若当前顺序不符，把 `const registry = new Registry(...)` 上移）：

```ts
  const existingEntry = registry.get(sessionId);
  let sessionName = process.env.PI_SESSION_NAME ?? existingEntry?.name ?? `session-${sessionId.slice(0, 6)}`;
  let cachedCtx: any = null;

  const presence = new Presence(mailbox.baseDir, {
```

- [ ] **Step 2: 删除 `/pit start|stop|sessions` 三个 handler 分支**

`index.ts` 中 `cmd === "start"`、`cmd === "stop"`、`cmd === "sessions"` 三个完整 if 块（含其 `execSync` 动态 import 与 tmux 字符串拼接代码）整体删除。注意 start/stop 分支以 `if (cmd === "start") {...}` 独立成块，删除后 `if (cmd === "sessions")` 之前的 `// ── SESSION MANAGEMENT (tmux) ────` 注释一并删除。

- [ ] **Step 3: 更新 subCmds 补全列表与帮助文本**

`getArgumentCompletions` 的 `subCmds` 数组中删除三项：`{ value: "start", ... }`、`{ value: "stop", ... }`、`{ value: "sessions", ... }`。同时删除第二级补全中 `start`/`stop` 的会话名补全分支（`["send", "ask", "share", "stop"]` → `["send", "ask", "share"]`）。

handler 末尾的 help 文本删除三行（`/pit sessions ...`、`/pit start ...`、`/pit stop ...`），并追加一行提示：

```ts
  "  /pit ps                   List registered sessions\n" +
  "  /pit status               Intercom status\n" +
  "\nSession management: /control start|stop|ls (pit-control)\n" +
  "\nSwitch sessions: Ctrl+B s (tmux)",
```

- [ ] **Step 4: 验证**

```bash
cd /Users/anzhize/pi-platform
npm run build   # 类型检查（index.ts 不再引用已删文件）
npx vitest run test/unit/intercom.test.ts test/unit/ext-shared-tmux.test.ts
grep -n "execSync\|/pit start\|/pit stop\|/pit sessions" extensions/pit-communicate/index.ts
```

预期：build 通过；13 + 10 tests 全过；grep 无输出（execSync 与三命令引用全部清除）。

- [ ] **Step 5: 提交**

```bash
git add extensions/pit-communicate/index.ts
git commit -m "refactor(pit-communicate): 删除 tmux 三命令（移交 pit-control），name 初始化支持 PI_SESSION_NAME 与 registry 恢复"
```

---

### Task 4: pit-control 重构 — 共享模块 + 增强命令面

**Files:**
- Modify: `extensions/pit-control/index.ts`

**Interfaces:**
- Consumes: Task 1（`_shared/paths.js`、`_shared/registry.js`、`_shared/presence.js`）、Task 2（`_shared/tmux-session.js`）
- Produces: 命令面 = `start [name]` / `stop` / `ls`（在线状态）/ `switch` / `attach` / `detach` / `name <y>`（持久化）/ `status`（增强）/ `ui`；`PI_SESSION_NAME` 环境变量（Task 3 消费）

- [ ] **Step 1: 顶部替换 — import 共享模块，删除本地 helpers**

`extensions/pit-control/index.ts` 中删除本地 `hasTmux` / `tmuxName` / `listPitSessions` / `sessionExists` 四个函数与 `spawnSync`/`randomUUID` 之外的逻辑，替换为：

```ts
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TmuxSession } from "../../_shared/tmux-session.js";
import { Registry } from "../../_shared/registry.js";
import { Presence } from "../../_shared/presence.js";
import { resolveMailboxRoot, resolveTenantId } from "../../_shared/paths.js";

export default function pitControl(api: any) {
  const templateId: string = process.env.PI_TEMPLATE ?? "unknown";
  const agentDir: string = process.env.PI_CODING_AGENT_DIR ?? "";
  const sessionId: string = process.env.PI_SESSION_ID ?? randomUUID();
  const tenantId: string = resolveTenantId();
  const mailboxRoot: string = resolveMailboxRoot();

  const tmux = new TmuxSession();
  const registry = new Registry(mailboxRoot, tenantId);
  const statePath = path.join(mailboxRoot, tenantId, sessionId, "state.json");

  const existingEntry = registry.get(sessionId);
  let sessionName: string = existingEntry?.name ?? `session-${sessionId.slice(0, 8)}`;

  // ── 自注册：把 sessionId 写入当前 tmux 会话环境（供 /control ls 反查）──
  try {
    const cur = tmux.currentSessionName();
    if (cur?.startsWith("pit-")) {
      tmux.setSessionEnv(cur.slice(4), "PI_SESSION_ID", sessionId);
    }
  } catch { /* 非 tmux 环境，忽略 */ }
```

- [ ] **Step 2: `start` 命令改造（可选 name + 自动命名 + PI_SESSION_NAME）**

将现有 `start` 分支替换为：

```ts
      if (cmd === "start") {
        const userProvided = rest.length > 0;
        const rawName = rest[0] ?? "";
        if (!tmux.hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }
        const name = userProvided ? tmux.sanitizeName(rawName) : undefined;

        const env: Record<string, string> = {};
        if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
        if (process.env.PI_TEMPLATE) env.PI_TEMPLATE = process.env.PI_TEMPLATE;
        if (process.env.PI_TEMPLATE_ALIAS) env.PI_TEMPLATE_ALIAS = process.env.PI_TEMPLATE_ALIAS;
        if (process.env.AGENT_LAB_DB_PATH) env.AGENT_LAB_DB_PATH = process.env.AGENT_LAB_DB_PATH;
        if (process.env.AGENT_LAB_CONFIG_DIR) env.AGENT_LAB_CONFIG_DIR = process.env.AGENT_LAB_CONFIG_DIR;
        if (name) env.PI_SESSION_NAME = name;

        const r = tmux.startSession({ name, env });
        if (r.ok) {
          const autoNote = userProvided ? "" : ` (auto-named)`;
          ctx.ui.notify(`\x1b[32m✅ Background session "${r.name}" started${autoNote}\x1b[0m`);
        } else {
          ctx.ui.notify(`Failed: ${r.error}`, "error");
        }
        return;
      }
```

- [ ] **Step 3: `ls` 增强（tmux 信息 + 在线状态）**

将现有 `ls` 分支替换为：

```ts
      if (cmd === "ls") {
        if (!tmux.hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }
        const details = tmux.listSessionsDetail();
        if (details.length === 0) {
          ctx.ui.notify("No background sessions\nStart: /control start [name]");
          return;
        }
        const lines = ["\x1b[1mBackground Sessions\x1b[0m", ""];
        for (const d of details) {
          const sid = tmux.getSessionEnv(d.name, "PI_SESSION_ID");
          if (sid) {
            const sp = path.join(mailboxRoot, tenantId, sid, "state.json");
            const state = Presence.read(sp);
            const online = Presence.isOnline(sp);
            const displayName = registry.get(sid)?.name ?? d.name;
            const statusIcon = !online ? "\x1b[2m○\x1b[0m" : state?.status === "busy" ? "\x1b[33m◐\x1b[0m" : "\x1b[32m●\x1b[0m";
            const model = state?.model ?? "?";
            const mode = state?.mode ?? "?";
            const age = d.ageSec < 60 ? `${d.ageSec}s` : d.ageSec < 3600 ? `${Math.floor(d.ageSec / 60)}m` : `${Math.floor(d.ageSec / 3600)}h`;
            lines.push(`  ${statusIcon} \x1b[1m${displayName.padEnd(16)}\x1b[0m${d.windows}w  ${age}  ${mode}  ${model}`);
          } else {
            lines.push(`  \x1b[1m${d.name.padEnd(16)}\x1b[0m${d.windows}w  ${d.ageSec}s  (no presence)`);
          }
        }
        lines.push("\nSwitch: /control switch <name>  ·  Stop: /control stop <name>");
        ctx.ui.notify(lines.join("\n"));
        ctx.ui.setWidget("pit-sessions", lines, { placement: "aboveEditor" });
        return;
      }
```

- [ ] **Step 4: `name` 持久化 + `status` 增强**

`name` 分支替换为：

```ts
      if (cmd === "name") {
        const name = argStr.trim();
        if (!name) { ctx.ui.notify("Usage: /control name <display-name>", "warning"); return; }
        sessionName = name;
        const existing = registry.get(sessionId);
        registry.register({
          sessionId, tenantId, name,
          pid: existing?.pid ?? process.pid,
          startedAt: existing?.startedAt ?? new Date().toISOString(),
        });
        Presence.updateName(statePath, name);
        try { api.setSessionName?.(name); } catch { /* ok */ }
        ctx.ui.notify(`\x1b[32mSession name: ${name}\x1b[0m`);
        return;
      }
```

`status` 分支替换为：

```ts
      if (cmd === "status") {
        const existing = registry.get(sessionId);
        const cur = tmux.currentSessionName();
        const lines = [
          "\x1b[1mSession Status\x1b[0m",
          `  name:    ${existing?.name ?? sessionName}`,
          `  session: ${sessionId.slice(0, 8)}`,
          `  tmux:    ${cur ?? "(not in tmux)"}`,
          `  template:  ${templateId.slice(0, 8)}…`,
          `  tenant:  ${tenantId.slice(0, 8)}…`,
        ];
        if (tmux.hasTmux()) {
          const pits = tmux.listPitSessions();
          lines.push(`  running: ${pits.length} pit session(s)`);
          if (pits.length > 0) lines.push(`  sessions: ${pits.join(", ")}`);
        } else {
          lines.push("  tmux:    not installed");
        }
        ctx.ui.notify(lines.join("\n"));
        return;
      }
```

- [ ] **Step 5: 更新 subCmds 补全（start 不再需要 name 必填）与帮助文本**

`subCmds` 数组：`{ value: "start", label: "start <name>", ... }` → `{ value: "start", label: "start [name]", description: "启动后台 pi 会话（缺省自动命名）" }`。帮助文本同步。

- [ ] **Step 6: 验证**

```bash
cd /Users/anzhize/pi-platform
npm run build
npx vitest run test/unit/ext-shared-tmux.test.ts test/unit/intercom.test.ts
grep -n "spawnSync\|hasTmux\|sessionExists\|listPitSessions" extensions/pit-control/index.ts
```

预期：build 通过；23 tests 全过；grep 仅匹配 `tmux.hasTmux()` 等共享模块调用（本地 helpers 已删）。

- [ ] **Step 7: 提交**

```bash
git add extensions/pit-control/index.ts
git commit -m "feat(pit-control): 共享模块重构 — start 自动命名/PI_SESSION_NAME、ls 在线状态、name 持久化、tmux env 自注册"
```

---

### Task 5: 端到端验证 + 共享层同步 + 收尾

**Files:**
- Modify: 无（仅验证与部署）

- [ ] **Step 1: 全量测试**

```bash
cd /Users/anzhize/pi-platform && npx vitest run test/unit 2>&1 | tail -5
```

预期：61 files 全过（含新增 2 个测试文件）。

- [ ] **Step 2: 同步共享层（pit update --all）+ 清理残留**

```bash
node dist/ptl/pit.js update --all 2>&1 | grep -E '✅|❌'
# cpSync(force) 不会删除目标多余文件 —— 手动清理 communicate 已删除的副本：
rm -f /Users/anzhize/.pi-triple/data/shared/extensions/pit-communicate/registry.ts
rm -f /Users/anzhize/.pi-triple/data/shared/extensions/pit-communicate/presence.ts
```

- [ ] **Step 3: 验证仓库=共享层零差异**

```bash
cd /Users/anzhize/pi-platform
for e in _shared pit-communicate pit-control; do
  echo "== $e =="; diff -rq extensions/$e /Users/anzhize/.pi-triple/data/shared/extensions/$e 2>&1
done
```

预期：`_shared` 存在于共享层（new-session 后同步已复制）；三项均无差异输出。

- [ ] **Step 4: tsx 加载验证（两个扩展 + 共享模块）**

```bash
npx tsx -e "
import('file:///Users/anzhize/.pi-triple/data/shared/extensions/_shared/tmux-session.ts').then(m => {
  const t = new m.TmuxSession();
  console.log('tmux-session ok:', typeof t.sanitizeName === 'function');
});
import('file:///Users/anzhize/.pi-triple/data/shared/extensions/pit-control/index.ts').then(m => console.log('pit-control export:', typeof m.default));
import('file:///Users/anzhize/.pi-triple/data/shared/extensions/pit-communicate/index.ts').then(m => console.log('pit-communicate export:', typeof m.default));
"
```

预期：三行均输出 ok / function（pit-communicate 走 ESM，default 为 function）。

- [ ] **Step 5: `/reload` 手动验证清单（当前会话或新会话）**

在 pi 会话中执行 `/reload` 后（或新开 `pit start` 会话）逐项验证：

1. `/pit help` → 无 start/stop/sessions，含"Session management: /control ..."提示
2. `/pit start x` → 提示未知子命令或 usage（不执行任何 tmux 操作）
3. `/control start` → 自动命名 `auto-xxxxxx`，提示 started (auto-named)
4. `/control ls` → 新会话显示 `●` 在线 + model + 名字；数秒后第二次 ls 有完整信息（env 回写后）
5. `/control name mybox` → 成功；重启该会话后 `/control status` 显示 `mybox`（持久化生效）
6. `/control start agent1` → `pit-agent1` 固定名；`/pit ps` 能看到 `agent1`（PI_SESSION_NAME 打通）
7. 与旧会话（如本会话）互不影响：`/pit ps` 仍列出所有 registry 会话

- [ ] **Step 6: 提交剩余改动 + 更新设计文档状态**

```bash
git add -A
git commit -m "chore: 同步共享层验证 + 端到端清单执行记录" || echo "（无剩余改动，跳过）"
```

> 设计文档 `docs/superpowers/specs/2026-08-01-...-design.md` 若验证中发现偏差，修正后一并提交。
