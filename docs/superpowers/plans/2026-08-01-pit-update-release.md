# pit 全量更新 + 会话内更新提示 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pit update` 成为全量更新命令（pi SDK + Pi-Triple 本体 GitHub Release 拉包 + 扩展 + 共享层），并在 pi 会话内（扩展 notify）与 CLI 启动时显示更新可用提示。

**Architecture:** 本体更新走 GitHub Release（`releases/latest` → tarball → sha256 校验 → `npm install -g`）；更新提示双通道：扩展 `extensions/_shared/version-check.ts`（会话内 `ctx.ui.notify`）+ CLI 读共享缓存文件（`dataDir/version-check.json`，24h TTL）stderr 提示。pi 源码完全不修改（R0）。

**Tech Stack:** Node 18+（global fetch、AbortSignal.timeout）、TypeScript ESM（nodenext，import 后缀 `.js`）、vitest、node:crypto（sha256）。

## Global Constraints

- 零新增运行时依赖（版本比较手写 x.y.z，不引 semver）
- 缓存文件 `dataDir/version-check.json`：格式 `{checkedAt: string(ISO), pit?: string, piSdk?: string}`，**CLI 侧与扩展侧共用同一格式**；写入一律 tmp+rename 原子写
- 尊重 `PI_OFFLINE` / `PI_SKIP_VERSION_CHECK`（任一设置则跳过检查与提示）
- GitHub API 请求带 `User-Agent` 头 + `AbortSignal.timeout(10_000)`；所有检查类异常**静默吞掉**（catch → undefined/空）
- 仓库常量 `PIT_REPO = "Phenol1145/pi-triple"`（两侧各一份常量，值相同）
- `pit update` 阶段语义：默认/`--all` = ①+②+③+④ 全量；`--extensions` = ①+③（向后兼容）；`--pi-only` = 仅①；`--dry-run` = 只检查报告不下载不安装
- 阶段②失败（网络/校验/安装）**不中断** ③④，打印 ❌ 原因
- `extensions/_shared/` 内禁止创建 `index.ts`；扩展模块 import 用 `../_shared/xxx.js`
- 测试：`npx vitest run`（新增测试文件放 `test/unit/`）；扩展严格 tsc：`npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --allowImportingTsExtensions extensions/pit-communicate/index.ts extensions/_shared/version-check.ts`

---

### Task 1: CLI 侧版本检查模块 `src/ptl/version-check.ts`

**Files:**
- Create: `src/ptl/version-check.ts`
- Test: `test/unit/version-check.test.ts`

**Interfaces:**
- Produces:
  - `export const PIT_REPO = "Phenol1145/pi-triple"`
  - `export function compareVersions(a: string, b: string): number | undefined`（`/^v?(\d+)\.(\d+)\.(\d+)/` 解析，缺段补 0；解析失败返回 undefined）
  - `export function isUpdateAvailable(latest: string, current: string): boolean`（compare 失败时 fallback 字符串不等）
  - `export function cachePath(): string`（`path.join(resolveDataDir(), "version-check.json")`）
  - `export function readCache(): VersionCheckCache | null`
  - `export function writeCache(data: VersionCheckCache): void`（tmp+rename）
  - `export function isCacheFresh(cache: VersionCheckCache): boolean`（`Date.now() - Date.parse(checkedAt) < 24h`）
  - `export interface VersionCheckCache { checkedAt: string; pit?: string; piSdk?: string }`
  - `export async function fetchLatestPitVersion(fetchImpl?: typeof fetch): Promise<string | undefined>`（返回去 `v` 前缀的 tag）
  - `export async function fetchLatestPiSdkVersion(shell?: Shell): Promise<string | undefined>`（`npm view @earendil-works/pi-coding-agent version` stdout.trim()）
  - `export async function checkForUpdates(deps?: { fetchImpl?: typeof fetch; shell?: Shell }): Promise<{ pit?: string; piSdk?: string }>`（env 跳过 → 缓存新鲜直接返回缓存 → 否则并行查询 → 写缓存 → 返回）
  - `export type Shell = (cmd: string, args: string[]) => { status: number | null; stdout: string }`

- [ ] **Step 1: 写失败测试**

创建 `test/unit/version-check.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  compareVersions, isUpdateAvailable, cachePath, readCache, writeCache,
  isCacheFresh, fetchLatestPitVersion, fetchLatestPiSdkVersion, checkForUpdates,
} from "../../src/ptl/version-check.js";
import { loadConfig, resolveDataDir } from "../../src/ptl/config.js";

// 用 DATA_DIR 环境变量隔离缓存路径（resolveDataDir 支持 process.env.DATA_DIR）
let tmpRoot: string;
let savedDataDir: string | undefined;
let savedOffline: string | undefined;
let savedSkip: string | undefined;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pit-vc-"));
  savedDataDir = process.env.DATA_DIR;
  savedOffline = process.env.PI_OFFLINE;
  savedSkip = process.env.PI_SKIP_VERSION_CHECK;
  process.env.DATA_DIR = tmpRoot;
  delete process.env.PI_OFFLINE;
  delete process.env.PI_SKIP_VERSION_CHECK;
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedDataDir;
  if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
  if (savedSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK; else process.env.PI_SKIP_VERSION_CHECK = savedSkip;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("compareVersions", () => {
  it("比较 x.y.z 三段", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
  });
  it("接受 v 前缀与缺段", () => {
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
  });
  it("无效版本返回 undefined", () => {
    expect(compareVersions("abc", "0.1.0")).toBeUndefined();
    expect(compareVersions("0.1.0", "")).toBeUndefined();
  });
});

describe("isUpdateAvailable", () => {
  it("最新大于当前 → true", () => {
    expect(isUpdateAvailable("0.2.0", "0.1.0")).toBe(true);
  });
  it("相同或更小 → false", () => {
    expect(isUpdateAvailable("0.1.0", "0.1.0")).toBe(false);
    expect(isUpdateAvailable("0.1.0", "0.2.0")).toBe(false);
  });
  it("比较失败 fallback 字符串不等", () => {
    expect(isUpdateAvailable("dev", "0.1.0")).toBe(true);
    expect(isUpdateAvailable("dev", "dev")).toBe(false);
  });
});

describe("缓存", () => {
  it("writeCache → readCache 往返一致", () => {
    const data = { checkedAt: new Date().toISOString(), pit: "0.2.0", piSdk: "0.84.0" };
    writeCache(data);
    expect(readCache()).toEqual(data);
  });
  it("损坏缓存 readCache 返回 null", () => {
    fs.writeFileSync(cachePath(), "{ not json");
    expect(readCache()).toBeNull();
  });
  it("isCacheFresh：24h 内新鲜，超过过期", () => {
    expect(isCacheFresh({ checkedAt: new Date().toISOString() })).toBe(true);
    expect(isCacheFresh({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })).toBe(false);
  });
});

describe("fetchLatestPitVersion", () => {
  it("解析 GitHub releases/latest 的 tag_name（去 v 前缀）", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: "v0.2.0" }),
    })) as unknown as typeof fetch;
    expect(await fetchLatestPitVersion(fakeFetch)).toBe("0.2.0");
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/Phenol1145/pi-triple/releases/latest",
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": "pi-triple" }) }),
    );
  });
  it("非 200 返回 undefined", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await fetchLatestPitVersion(fakeFetch)).toBeUndefined();
  });
});

describe("fetchLatestPiSdkVersion", () => {
  it("npm view 成功返回版本", async () => {
    const shell = vi.fn(() => ({ status: 0, stdout: "0.84.0\n" }));
    expect(await fetchLatestPiSdkVersion(shell as never)).toBe("0.84.0");
    expect(shell).toHaveBeenCalledWith("npm", ["view", "@earendil-works/pi-coding-agent", "version"]);
  });
  it("失败返回 undefined", async () => {
    expect(await fetchLatestPiSdkVersion((() => ({ status: 1, stdout: "" })) as never)).toBeUndefined();
  });
});

describe("checkForUpdates", () => {
  it("env PI_OFFLINE 跳过（不查不写）", async () => {
    process.env.PI_OFFLINE = "1";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await checkForUpdates({ fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    delete process.env.PI_OFFLINE;
  });
  it("PI_SKIP_VERSION_CHECK 跳过", async () => {
    process.env.PI_SKIP_VERSION_CHECK = "1";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await checkForUpdates({ fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    delete process.env.PI_SKIP_VERSION_CHECK;
  });
  it("缓存新鲜时直接返回缓存不查询", async () => {
    writeCache({ checkedAt: new Date().toISOString(), pit: "0.2.0" });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await checkForUpdates({ fetchImpl });
    expect(r).toEqual({ pit: "0.2.0" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("无缓存/过期时并行查询并写缓存", async () => {
    fs.rmSync(cachePath(), { force: true });
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ tag_name: "v0.3.0" }) })) as unknown as typeof fetch;
    const shell = (() => ({ status: 0, stdout: "0.85.0" })) as never;
    const r = await checkForUpdates({ fetchImpl, shell });
    expect(r).toEqual({ pit: "0.3.0", piSdk: "0.85.0" });
    expect(readCache()).toMatchObject({ pit: "0.3.0", piSdk: "0.85.0" });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/version-check.test.ts`
Expected: FAIL（模块不存在 / 函数未定义）

- [ ] **Step 3: 实现 `src/ptl/version-check.ts`**

```ts
/**
 * pit/version-check — pit 本体 + pi SDK 更新检查（CLI 侧）
 *
 * 缓存文件 dataDir/version-check.json 与 extensions/_shared/version-check.ts 共用格式：
 *   { checkedAt: string(ISO), pit?: string, piSdk?: string }
 * 约定：CLI 启动提示只读缓存（零网络）；扩展侧兜底查询并写缓存。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDataDir } from "./config.js";

export const PIT_REPO = "Phenol1145/pi-triple";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GITHUB_API = `https://api.github.com/repos/${PIT_REPO}/releases/latest`;
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

export interface VersionCheckCache {
  checkedAt: string;
  pit?: string;
  piSdk?: string;
}

export type Shell = (cmd: string, args: string[]) => { status: number | null; stdout: string };

export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string): number[] | undefined => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m) return undefined;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(latest: string, current: string): boolean {
  const c = compareVersions(latest, current);
  return c === undefined ? latest.trim() !== current.trim() : c > 0;
}

export function cachePath(): string {
  return path.join(resolveDataDir(), "version-check.json");
}

export function readCache(): VersionCheckCache | null {
  try {
    const raw = fs.readFileSync(cachePath(), "utf-8");
    const data = JSON.parse(raw) as VersionCheckCache;
    if (typeof data.checkedAt !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

export function writeCache(data: VersionCheckCache): void {
  const p = cachePath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}

export function isCacheFresh(cache: VersionCheckCache): boolean {
  return Date.now() - Date.parse(cache.checkedAt) < CACHE_TTL_MS;
}

export async function fetchLatestPitVersion(fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const res = await fetchImpl(GITHUB_API, {
    headers: { "User-Agent": "pi-triple", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { tag_name?: string };
  return typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : undefined;
}

export async function fetchLatestPiSdkVersion(shell: Shell = (cmd, args) => spawnSync(cmd, args, { encoding: "utf-8" })): Promise<string | undefined> {
  const r = shell("npm", ["view", PI_SDK_PACKAGE, "version"]);
  if (r.status !== 0) return undefined;
  const v = r.stdout.trim();
  return v || undefined;
}

export async function checkForUpdates(deps: { fetchImpl?: typeof fetch; shell?: Shell } = {}): Promise<{ pit?: string; piSdk?: string }> {
  if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return {};
  const cache = readCache();
  if (cache && isCacheFresh(cache)) {
    return { pit: cache.pit, piSdk: cache.piSdk };
  }
  const [pit, piSdk] = await Promise.all([
    fetchLatestPitVersion(deps.fetchImpl).catch(() => undefined),
    fetchLatestPiSdkVersion(deps.shell).catch(() => undefined),
  ]);
  const report: { pit?: string; piSdk?: string } = {};
  if (pit) report.pit = pit;
  if (piSdk) report.piSdk = piSdk;
  try {
    writeCache({ checkedAt: new Date().toISOString(), ...report });
  } catch {
    /* 缓存写失败静默 */
  }
  return report;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/unit/version-check.test.ts`
Expected: PASS（全绿）

- [ ] **Step 5: Commit**

```bash
git add src/ptl/version-check.ts test/unit/version-check.test.ts
git commit -m "feat(ptl): version-check — CLI 侧更新检查模块（GitHub release / npm view / 24h 缓存原子写）"
```

---

### Task 2: VERSION 单源化 + CLI 启动提示接入

**Files:**
- Create: `src/ptl/version.ts`
- Modify: `src/ptl/pit/main.ts`（`const VERSION = "0.1.0"` → 动态读取）、`src/ptl/pit/run.ts`（main() 中 start/pi 分支前加提示）
- Test: `test/unit/version.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readCache` / `isCacheFresh` / `isUpdateAvailable`
- Produces:
  - `export function getPitVersion(): string`（读 `../package.json` 的 `version`，相对 `import.meta.url` 解析）
  - `export function maybePrintUpdateHint(currentPit: string, currentPiSdk: string): void`（只读缓存；有更新打印 stderr 一行；异常静默）

- [ ] **Step 1: 写失败测试** `test/unit/version.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getPitVersion, maybePrintUpdateHint } from "../../src/ptl/version.js";
import { writeCache } from "../../src/ptl/version-check.js";
import { resolveDataDir } from "../../src/ptl/config.js";

describe("getPitVersion", () => {
  it("返回 package.json 的 version", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    expect(getPitVersion()).toBe(pkg.version);
  });
});

describe("maybePrintUpdateHint", () => {
  let tmpRoot: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pit-hint-"));
    process.env.DATA_DIR = tmpRoot;
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
    stderrSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("缓存有本体更新 → 打印提示", () => {
    writeCache({ checkedAt: new Date().toISOString(), pit: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("pit 更新可用: v9.9.9"));
  });

  it("缓存有 pi SDK 更新 → 打印提示", () => {
    writeCache({ checkedAt: new Date().toISOString(), piSdk: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("pi SDK 更新可用: v9.9.9"));
  });

  it("无更新 / 无缓存 → 不打印", () => {
    writeCache({ checkedAt: new Date().toISOString(), pit: "0.1.0", piSdk: "0.83.0" });
    stderrSpy.mockClear();
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
    fs.rmSync(path.join(resolveDataDir(), "version-check.json"), { force: true });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("过期缓存 → 不打印（CLI 不查询）", () => {
    writeCache({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), pit: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/version.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 `src/ptl/version.ts`**

```ts
/**
 * pit/version — 版本单源（package.json）+ 启动更新提示（CLI 辅通道，只读缓存零网络）
 */

import fs from "node:fs";
import { readCache, isCacheFresh, isUpdateAvailable } from "./version-check.js";

let cachedVersion: string | null = null;

export function getPitVersion(): string {
  if (cachedVersion) return cachedVersion;
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version?: string };
  cachedVersion = pkg.version ?? "0.0.0";
  return cachedVersion;
}

export function currentPiSdkVersion(): string {
  try {
    const r = spawnSyncPiVersion();
    return r.stdout.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function spawnSyncPiVersion(): { stdout: string } {
  // 延迟 require 避免顶层 import child_process 拖慢纯版本查询
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  return spawnSync("pi", ["--version"], { encoding: "utf-8" });
}

export function maybePrintUpdateHint(): void {
  try {
    if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return;
    const cache = readCache();
    if (!cache || !isCacheFresh(cache)) return; // CLI 只读缓存，不查询（扩展兜底）
    const hints: string[] = [];
    if (cache.pit && isUpdateAvailable(cache.pit, getPitVersion())) {
      hints.push(`pit 更新可用: v${cache.pit}（当前 v${getPitVersion()}）`);
    }
    const piSdk = currentPiSdkVersion();
    if (cache.piSdk && isUpdateAvailable(cache.piSdk, piSdk)) {
      hints.push(`pi SDK 更新可用: v${cache.piSdk}（当前 v${piSdk}）`);
    }
    if (hints.length > 0) {
      console.error(`\x1b[33m⚠ ${hints.join(" · ")} → 运行 pit update 一次更新全部\x1b[0m`);
    }
  } catch {
    /* 提示失败静默 */
  }
}
```

> 注：`require` 在 ESM 中不可用——若报错改为顶层 `import { spawnSync } from "node:child_process"`（本模块仅被 run.ts 启动路径引用，import 成本可接受）。

- [ ] **Step 4: 接入 `main.ts`（VERSION 单源）与 `run.ts`（启动提示）**

`src/ptl/pit/main.ts`：删除 `const VERSION = "0.1.0";`，改为：

```ts
import { getPitVersion } from "../version.js";
export function getVersion(): string { return getPitVersion(); }
```

（`printBanner` 内 `"v" + VERSION` 改为 `"v" + getVersion()`；`VERSION` 引用全部替换。）

`src/ptl/pit/run.ts`：在 `main()` 中参数解析成功后、`if (flags.help === "true")` 之前插入：

```ts
  // 启动更新提示（只读缓存，零网络；仅交互启动类命令）
  if (command === "start" || command === "pi") {
    try { (await import("../version.js")).maybePrintUpdateHint(); } catch { /* 静默 */ }
  }
```

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `npx vitest run test/unit/version.test.ts test/unit/version-check.test.ts`
Expected: PASS
Run: `npm run build`
Expected: exit 0（无 tsc 错误——`version.ts` 中 `require` 若报错按 Step 3 注处理）

- [ ] **Step 6: Commit**

```bash
git add src/ptl/version.ts src/ptl/pit/main.ts src/ptl/pit/run.ts test/unit/version.test.ts
git commit -m "feat(ptl): VERSION 单源化（读 package.json）+ start/pi 启动时更新提示（只读缓存）"
```

---

### Task 3: 扩展侧版本检查 `extensions/_shared/version-check.ts`

**Files:**
- Create: `extensions/_shared/version-check.ts`（**禁止**创建 index.ts）
- Test: `test/unit/ext-version-check.test.ts`

**Interfaces:**
- Consumes: Task 1 的缓存文件格式约定（同一 `dataDir/version-check.json`）
- Produces:
  - `export function compareVersions(a: string, b: string): number | undefined`（与 Task 1 同逻辑）
  - `export function isUpdateAvailable(latest: string, current: string): boolean`
  - `export function resolveInstalledPitVersion(shell?: Shell): string | undefined`（`npm root -g` → 读 `pi-triple/package.json` version；失败 undefined）
  - `export function checkForUpdates(deps?: { fetchImpl?: typeof fetch; shell?: Shell }): Promise<{ pit?: string; piSdk?: string; currentPit?: string; currentPiSdk?: string }>`
  - `export type Shell = (cmd: string, args: string[]) => { status: number | null; stdout: string }`

说明：扩展侧与 CLI 侧**独立实现**（扩展不能 import src/），但缓存格式、常量、env 语义一致；扩展侧多返回 `currentPit`/`currentPiSdk`（供 notify 文案直接使用）。

- [ ] **Step 1: 写失败测试** `test/unit/ext-version-check.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  compareVersions, isUpdateAvailable, resolveInstalledPitVersion, checkForUpdates,
} from "../../extensions/_shared/version-check.js";

describe("compareVersions / isUpdateAvailable", () => {
  it("三段比较与 v 前缀", () => {
    expect(compareVersions("v0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("x", "0.1.0")).toBeUndefined();
  });
  it("isUpdateAvailable", () => {
    expect(isUpdateAvailable("0.2.0", "0.1.0")).toBe(true);
    expect(isUpdateAvailable("0.1.0", "0.2.0")).toBe(false);
  });
});

describe("resolveInstalledPitVersion", () => {
  it("npm root -g + package.json 读取", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pit-ver-"));
    fs.mkdirSync(path.join(tmp, "pi-triple"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "pi-triple", "package.json"), JSON.stringify({ version: "0.7.7" }));
    const shell = vi.fn(() => ({ status: 0, stdout: tmp + "\n" }));
    expect(resolveInstalledPitVersion(shell as never)).toBe("0.7.7");
    expect(shell).toHaveBeenCalledWith("npm", ["root", "-g"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it("npm root 失败 → undefined", () => {
    expect(resolveInstalledPitVersion((() => ({ status: 1, stdout: "" })) as never)).toBeUndefined();
  });
  it("未安装 pi-triple → undefined", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pit-ver2-"));
    const shell = vi.fn(() => ({ status: 0, stdout: tmp + "\n" }));
    expect(resolveInstalledPitVersion(shell as never)).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("checkForUpdates", () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pit-vce-"));
    process.env.DATA_DIR = tmpRoot;
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("聚合 GitHub + npm view + 当前版本", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pit-vce2-"));
    fs.mkdirSync(path.join(tmp, "pi-triple"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "pi-triple", "package.json"), JSON.stringify({ version: "0.1.0" }));
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ tag_name: "v0.2.0" }) })) as unknown as typeof fetch;
    const shell = ((cmd: string, args: string[]) =>
      cmd === "npm" && args[0] === "root" ? { status: 0, stdout: tmp + "\n" }
      : cmd === "npm" ? { status: 0, stdout: "0.84.0\n" }
      : { status: 0, stdout: "0.83.0\n" }) as never;
    const r = await checkForUpdates({ fetchImpl, shell });
    expect(r.pit).toBe("0.2.0");
    expect(r.piSdk).toBe("0.84.0");
    expect(r.currentPit).toBe("0.1.0");
    expect(r.currentPiSdk).toBe("0.83.0");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("PI_OFFLINE 跳过", async () => {
    process.env.PI_OFFLINE = "1";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await checkForUpdates({ fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    delete process.env.PI_OFFLINE;
  });

  it("异常静默（fetch 抛错 → 空结果）", async () => {
    const fetchImpl = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    const r = await checkForUpdates({ fetchImpl });
    expect(r.pit).toBeUndefined();
    expect(r.piSdk).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/ext-version-check.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `extensions/_shared/version-check.ts`**

```ts
/**
 * _shared/version-check — pit 本体 + pi SDK 更新检查（扩展侧，会话内提示用）
 *
 * 与 src/ptl/version-check.ts 独立实现（扩展不能 import src/），但共享：
 * - 缓存文件格式 dataDir/version-check.json：{ checkedAt, pit?, piSdk? }
 * - 常量 PIT_REPO、env 语义（PI_OFFLINE / PI_SKIP_VERSION_CHECK）
 * 扩展侧额外返回当前版本（currentPit/currentPiSdk）供 notify 文案使用。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PIT_REPO = "Phenol1145/pi-triple";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GITHUB_API = `https://api.github.com/repos/${PIT_REPO}/releases/latest`;
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

export type Shell = (cmd: string, args: string[]) => { status: number | null; stdout: string };

export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string): number[] | undefined => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m) return undefined;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(latest: string, current: string): boolean {
  const c = compareVersions(latest, current);
  return c === undefined ? latest.trim() !== current.trim() : c > 0;
}

function cachePath(): string {
  // 扩展运行于 pi 进程内，pi 的 DATA_DIR 语义与 pit 一致（~/.pi-triple/data）
  const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), ".pi-triple", "data");
  return path.join(dataDir, "version-check.json");
}

export function resolveInstalledPitVersion(shell: Shell = (cmd, args) => spawnSync(cmd, args, { encoding: "utf-8" })): string | undefined {
  try {
    const root = shell("npm", ["root", "-g"]);
    if (root.status !== 0) return undefined;
    const pkgPath = path.join(root.stdout.trim(), "pi-triple", "package.json");
    if (!fs.existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(deps: { fetchImpl?: typeof fetch; shell?: Shell } = {}): Promise<{
  pit?: string; piSdk?: string; currentPit?: string; currentPiSdk?: string;
}> {
  if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return {};
  const shell = deps.shell ?? ((cmd, args) => spawnSync(cmd, args, { encoding: "utf-8" }));
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 缓存新鲜 → 只返回最新版本（当前版本仍实时取）
  try {
    const raw = fs.readFileSync(cachePath(), "utf-8");
    const cache = JSON.parse(raw) as { checkedAt: string; pit?: string; piSdk?: string };
    if (cache && typeof cache.checkedAt === "string" && Date.now() - Date.parse(cache.checkedAt) < CACHE_TTL_MS) {
      return {
        pit: cache.pit,
        piSdk: cache.piSdk,
        currentPit: resolveInstalledPitVersion(shell),
        currentPiSdk: sdkVersion(shell),
      };
    }
  } catch { /* 无/损坏缓存 → 查询 */ }

  const [pit, piSdk] = await Promise.all([
    fetchImpl(GITHUB_API, {
      headers: { "User-Agent": "pi-triple", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    }).then(async (res) => {
      if (!res.ok) return undefined;
      const data = (await res.json()) as { tag_name?: string };
      return typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : undefined;
    }).catch(() => undefined),
    Promise.resolve().then(() => {
      const r = shell("npm", ["view", PI_SDK_PACKAGE, "version"]);
      if (r.status !== 0) return undefined;
      const v = r.stdout.trim();
      return v || undefined;
    }).catch(() => undefined),
  ]);

  const report: { pit?: string; piSdk?: string } = {};
  if (pit) report.pit = pit;
  if (piSdk) report.piSdk = piSdk;
  try {
    const p = cachePath();
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ checkedAt: new Date().toISOString(), ...report }));
    fs.renameSync(tmp, p);
  } catch { /* 缓存写失败静默 */ }

  return { ...report, currentPit: resolveInstalledPitVersion(shell), currentPiSdk: sdkVersion(shell) };
}

function sdkVersion(shell: Shell): string | undefined {
  try {
    const r = shell("pi", ["--version"]);
    if (r.status !== 0) return undefined;
    const v = r.stdout.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: 运行测试 + 扩展 tsc**

Run: `npx vitest run test/unit/ext-version-check.test.ts`
Expected: PASS
Run: `npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --allowImportingTsExtensions extensions/_shared/version-check.ts`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add extensions/_shared/version-check.ts test/unit/ext-version-check.test.ts
git commit -m "feat(extensions): _shared/version-check — 扩展侧更新检查（GitHub/npm view/当前版本/缓存复用）"
```

---

### Task 4: pit-communicate 会话内提示接入

**Files:**
- Create: `extensions/pit-communicate/update-hint.ts`
- Modify: `extensions/pit-communicate/index.ts`（factory 内调用 update-hint）
- Test: `test/unit/update-hint.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `checkForUpdates` / `isUpdateAvailable`
- Produces:
  - `export async function maybeShowUpdateHint(ctx: { ui: { notify: (text: string, level?: string) => void } }, deps?: { checker?: () => ReturnType<typeof import("../_shared/version-check.js").checkForUpdates> }): Promise<void>`
  - `export function formatUpdateHint(report: { pit?: string; piSdk?: string; currentPit?: string; currentPiSdk?: string }): string[]`（返回提示行数组，无更新返回空数组）

- [ ] **Step 1: 写失败测试** `test/unit/update-hint.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { formatUpdateHint } from "../../extensions/pit-communicate/update-hint.js";

describe("formatUpdateHint", () => {
  it("pit 有更新 → 提示行", () => {
    const lines = formatUpdateHint({ pit: "0.2.0", currentPit: "0.1.0" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("pit 更新可用: v0.2.0（当前 v0.1.0）");
    expect(lines[0]).toContain("pit update");
  });
  it("pi SDK 有更新 → 提示行", () => {
    const lines = formatUpdateHint({ piSdk: "0.84.0", currentPiSdk: "0.83.0" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("pi SDK 更新可用: v0.84.0");
  });
  it("无更新 → 空数组", () => {
    expect(formatUpdateHint({ pit: "0.1.0", currentPit: "0.1.0" })).toEqual([]);
    expect(formatUpdateHint({})).toEqual([]);
    expect(formatUpdateHint({ pit: "0.2.0" })).toEqual([]); // 无当前版本无法判断
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/update-hint.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `extensions/pit-communicate/update-hint.ts`**

```ts
/**
 * pit-communicate/update-hint — 会话内更新提示（扩展 notify）
 *
 * factory 在 session_start 时 fire-and-forget 调用；任何异常静默。
 */

import { checkForUpdates, isUpdateAvailable } from "../_shared/version-check.js";

export type UpdateReport = {
  pit?: string;
  piSdk?: string;
  currentPit?: string;
  currentPiSdk?: string;
};

export function formatUpdateHint(report: UpdateReport): string[] {
  const lines: string[] = [];
  if (report.pit && report.currentPit && isUpdateAvailable(report.pit, report.currentPit)) {
    lines.push(`⚠ pit 更新可用: v${report.pit}（当前 v${report.currentPit}）→ 运行 pit update 一次更新全部`);
  }
  if (report.piSdk && report.currentPiSdk && isUpdateAvailable(report.piSdk, report.currentPiSdk)) {
    lines.push(`⚠ pi SDK 更新可用: v${report.piSdk}（当前 v${report.currentPiSdk}）→ 运行 pit update 一并升级`);
  }
  return lines;
}

export async function maybeShowUpdateHint(
  ctx: { ui: { notify: (text: string, level?: string) => void } },
  deps: { checker?: () => Promise<UpdateReport> } = {},
): Promise<void> {
  try {
    const checker = deps.checker ?? checkForUpdates;
    const report = await checker();
    const lines = formatUpdateHint(report);
    for (const line of lines) {
      ctx.ui.notify(line, "warning");
    }
  } catch {
    /* 更新提示失败静默 */
  }
}
```

- [ ] **Step 4: 接入 factory** `extensions/pit-communicate/index.ts`

在 `api.on("session_start", ...)` 回调体内末尾（`cachedCtx = ctx;` 之后即可，不阻塞）追加：

```ts
    // 会话内更新提示（fire-and-forget，缓存兜底，异常静默）
    void import("./update-hint.js").then(({ maybeShowUpdateHint }) => maybeShowUpdateHint(ctx));
```

- [ ] **Step 5: 运行测试 + 扩展 tsc**

Run: `npx vitest run test/unit/update-hint.test.ts test/unit/ext-version-check.test.ts`
Expected: PASS
Run: `npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --allowImportingTsExtensions extensions/pit-communicate/index.ts`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add extensions/pit-communicate/update-hint.ts extensions/pit-communicate/index.ts test/unit/update-hint.test.ts
git commit -m "feat(extensions): pit-communicate 会话内更新提示（session_start fire-and-forget notify）"
```

---

### Task 5: `pit update` 阶段② 本体更新（GitHub Release 拉包）

**Files:**
- Modify: `src/ptl/pit/admin.ts`（`handleUpdate` 扩展）
- Test: `test/unit/update-release.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `compareVersions` / `PIT_REPO`（`import { compareVersions, PIT_REPO } from "../version-check.js"`）
- Produces（admin.ts 内导出，供单测）:
  - `export function buildAssetUrl(tag: string, version: string): string` → `https://github.com/${PIT_REPO}/releases/download/${tag}/pi-triple-${version}.tgz`
  - `export function parseLatestRelease(json: unknown): { tag: string; version: string; assetName: string; digest?: string } | undefined`
  - `export function verifySha256(actualHex: string, expectedHex: string): boolean`

- [ ] **Step 1: 写失败测试** `test/unit/update-release.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildAssetUrl, parseLatestRelease, verifySha256 } from "../../src/ptl/pit/admin.js";

describe("buildAssetUrl", () => {
  it("构造下载 URL", () => {
    expect(buildAssetUrl("v0.2.0", "0.2.0"))
      .toBe("https://github.com/Phenol1145/pi-triple/releases/download/v0.2.0/pi-triple-0.2.0.tgz");
  });
});

describe("parseLatestRelease", () => {
  it("解析 tag/assets（含 digest）", () => {
    const parsed = parseLatestRelease({
      tag_name: "v0.2.0",
      assets: [
        { name: "pi-triple-0.1.0.tgz", digest: "sha256:abc" },
        { name: "pi-triple-0.2.0.tgz", digest: "sha256:def" },
      ],
    });
    expect(parsed).toEqual({ tag: "v0.2.0", version: "0.2.0", assetName: "pi-triple-0.2.0.tgz", digest: "def" });
  });
  it("无匹配 asset → undefined", () => {
    expect(parseLatestRelease({ tag_name: "v0.2.0", assets: [] })).toBeUndefined();
    expect(parseLatestRelease({})).toBeUndefined();
  });
});

describe("verifySha256", () => {
  it("相等 true，不等 false", () => {
    expect(verifySha256("abc", "abc")).toBe(true);
    expect(verifySha256("abc", "abd")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/update-release.test.ts`
Expected: FAIL（admin.js 无这些导出）

- [ ] **Step 3: 实现阶段② 纯函数 + 流程**

在 `src/ptl/pit/admin.ts` 顶部 import 区追加：

```ts
import crypto from "node:crypto";
import { compareVersions, PIT_REPO } from "../version-check.js";
```

在 `handleUpdate` 之前新增（含导出纯函数）：

```ts
// ─── 阶段② Pi-Triple 本体更新（GitHub Release 拉包）────────

export function buildAssetUrl(tag: string, version: string): string {
  return `https://github.com/${PIT_REPO}/releases/download/${tag}/pi-triple-${version}.tgz`;
}

export function parseLatestRelease(json: unknown): { tag: string; version: string; assetName: string; digest?: string } | undefined {
  const data = json as { tag_name?: string; assets?: Array<{ name?: string; digest?: string }> };
  if (typeof data.tag_name !== "string") return undefined;
  const tag = data.tag_name;
  const version = tag.replace(/^v/, "");
  const asset = (data.assets ?? []).find((a) => a.name === `pi-triple-${version}.tgz`);
  if (!asset?.name) return undefined;
  return {
    tag,
    version,
    assetName: asset.name,
    digest: typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7) : undefined,
  };
}

export function verifySha256(actualHex: string, expectedHex: string): boolean {
  return actualHex.toLowerCase() === expectedHex.toLowerCase();
}

async function updatePitSelf(): Promise<boolean> {
  try {
    console.log("  检查 Pi-Triple 本体更新…");
    const res = await fetch(`https://api.github.com/repos/${PIT_REPO}/releases/latest`, {
      headers: { "User-Agent": "pi-triple", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.log(`  \x1b[31m❌ 无法检查本体更新（GitHub API ${res.status}）\x1b[0m`);
      return false;
    }
    const release = parseLatestRelease(await res.json());
    if (!release) {
      console.log("  \x1b[31m❌ 无法解析 GitHub Release（未找到 pi-triple tarball asset）\x1b[0m");
      return false;
    }
    const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf-8")) as { version: string };
    const cmp = compareVersions(release.version, pkg.version);
    if (cmp !== undefined && cmp <= 0) {
      console.log(`  \x1b[32m✅ Pi-Triple 已是最新版 (v${pkg.version})\x1b[0m`);
      return true;
    }
    console.log(`  当前 v${pkg.version} → 最新 v${release.version}，下载中…`);

    const url = buildAssetUrl(release.tag, release.version);
    const dl = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!dl.ok) {
      console.log(`  \x1b[31m❌ 下载失败（HTTP ${dl.status}）: ${url}\x1b[0m`);
      return false;
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    if (release.digest) {
      const actual = crypto.createHash("sha256").update(buf).digest("hex");
      if (!verifySha256(actual, release.digest)) {
        console.log("  \x1b[31m❌ sha256 校验失败，已中止（不安装）\x1b[0m");
        return false;
      }
    }
    const tmpFile = path.join(os.tmpdir(), `pi-triple-${release.version}.tgz`);
    fs.writeFileSync(tmpFile, buf);
    console.log(`  \x1b[36m安装 pi-triple@${release.version}（npm install -g，约需 10-30s）…\x1b[0m`);
    const r = spawnSync("npm", ["install", "-g", tmpFile], { stdio: "inherit" });
    fs.rmSync(tmpFile, { force: true });
    if (r.status === 0) {
      console.log(`  \x1b[32m✅ Pi-Triple 已升级到 v${release.version}，重启 pit 会话生效\x1b[0m`);
      return true;
    }
    console.log("  \x1b[31m❌ npm install -g 失败（可尝试 sudo 或检查 npm 权限）\x1b[0m");
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m❌ 本体更新失败: ${msg}\x1b[0m`);
    return false;
  }
}
```

> `new URL("../../../package.json", import.meta.url)` 相对 `src/ptl/pit/admin.ts` 上溯三级 = 包根（dist/ptl/pit/admin.js 同样三级）。

- [ ] **Step 4: 改造 `handleUpdate`（阶段语义 + 接入阶段②）**

`src/ptl/pit/admin.ts` 的 `handleUpdate` 开头改为：

```ts
export async function handleUpdate(flags: Record<string, string>): Promise<void> {
  const dryRun = flags["dry-run"] === "true";
  // 语义：默认/--all = 全量（含②）；--extensions = ①+③；--pi-only = 仅①
  const updateAll = flags.all === "true" || (flags.extensions !== "true" && flags["pi-only"] !== "true");
  const updateExt = flags.extensions === "true" || updateAll;
  const updateSelf = updateAll; // 仅默认/--all 时含阶段②（--extensions 不含）

```

（阶段②块：`if (updateSelf && !dryRun) { await updatePitSelf(); } else if (updateAll && dryRun) { console.log("  [dry-run] 将检查 Pi-Triple 本体（GitHub Release）"); }`）

在原 `if (updateExt) {` 块之前插入阶段②：

```ts
  // 阶段② Pi-Triple 本体（GitHub Release）
  if (updateSelf && !dryRun) {
    await updatePitSelf();
  } else if (updateAll && dryRun) {
    console.log("  [dry-run] 将检查 Pi-Triple 本体（GitHub Release）");
  }
```

pi SDK 段改造（dry-run 只报告）：

```ts
  const curVer = cur.stdout?.trim() ?? "unknown";
  const latestVer = latest.stdout?.trim() ?? "unknown";
  console.log(`  当前: v${curVer}  最新: v${latestVer}`);
  if (curVer === latestVer) {
    console.log("  \x1b[32m✅ pi 已是最新版\x1b[0m");
  } else if (dryRun) {
    console.log(`  \x1b[33m⚠ pi 有更新（v${latestVer}）→ 运行 pit update 升级\x1b[0m`);
  } else {
    console.log("  升级中…");
    const r = spawnSync("npm", ["install", "-g", `@earendil-works/pi-coding-agent@${latestVer}`], { stdio: "inherit" });
    if (r.status === 0) { console.log(`  \x1b[32m✅ pi 已升级到 v${latestVer}\x1b[0m`); }
    else { console.log("  \x1b[31m❌ pi 升级失败\x1b[0m"); process.exit(1); }
  }
```

> `updateAll`/`updateSelf` 语义：默认（无 flag）→ 全量（含②）；`--all` → 全量（含②）；`--extensions` → ①+③（不含②）；`--pi-only` → 仅①。

- [ ] **Step 5: 运行测试 + build**

Run: `npx vitest run test/unit/update-release.test.ts test/unit/version-check.test.ts`
Expected: PASS
Run: `npm run build`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/ptl/pit/admin.ts test/unit/update-release.test.ts
git commit -m "feat(ptl): pit update 阶段② — 本体 GitHub Release 拉包（sha256 校验 + npm install -g）+ --dry-run"
```

---

### Task 6: 端到端验证 + 共享层同步

**Files:**
- 无代码改动（验证 + 同步操作）

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
Expected: 全绿（新增 4 个测试文件全过，既有 629 不回归）

- [ ] **Step 2: 共享层同步**

```bash
node dist/ptl/pit.js update --all
```

Expected: `✅ 内置扩展已同步: _shared, pit-communicate, ...`（`_shared/version-check.ts`、`pit-communicate/update-hint.ts`、`pit-communicate/index.ts` 同步）

- [ ] **Step 3: 仓库 = 共享层零差异**

```bash
for e in _shared pit-communicate; do diff -rq extensions/$e ~/.pi-triple/data/shared/extensions/$e; done
```

Expected: 无输出（零差异）

- [ ] **Step 4: tsx 加载验证**

```bash
npx tsx -e "import('./extensions/_shared/version-check.ts').then(m => console.log('version-check ok:', typeof m.checkForUpdates === 'function'))"
```

Expected: `version-check ok: true`

- [ ] **Step 5: 真实 `--dry-run` 验证**

Run: `node dist/ptl/pit.js update --dry-run`
Expected: 显示 pi SDK 当前/最新、`[dry-run] 将检查 Pi-Triple 本体`、扩展包更新提示（若有）

- [ ] **Step 6: 手动验证清单（用户）**

| # | 操作 | 预期 |
|---|---|---|
| 1 | 新开 pi 会话（`pit start`） | 无更新提示（当前 0.1.0 == 最新）；`stderr` 无输出 |
| 2 | 发布 v0.1.1（git tag + npm pack + gh release）后新开会话 | 会话内 notify：`⚠ pit 更新可用: v0.1.1（当前 v0.1.0）→ 运行 pit update 一次更新全部`；`pit start` stderr 同行提示 |
| 3 | `pit update --dry-run` | 报告本体 v0.1.1 可用 |
| 4 | `pit update` | 4 阶段全跑：pi SDK / 本体（下载+sha256+npm install -g）/ 扩展 / 共享层 |
| 5 | 更新后 `pit --version` | 显示 v0.1.1 |
| 6 | 新开会话 | 无更新提示（已最新） |
| 7 | `PI_SKIP_VERSION_CHECK=1 pit start` | 无任何提示 |

- [ ] **Step 7: 收尾**

```bash
git status --short   # 确认干净
```

---

## Self-Review

**Spec 覆盖：**
- 组件 1（4 阶段 update）→ Task 5（阶段②+flags+--dry-run；①③④ 现有逻辑保留）；Task 2（VERSION 单源）
- 组件 2（会话内提示）→ Task 3（_shared/version-check）+ Task 4（notify 接入）
- CLI 辅通道 → Task 2（maybePrintUpdateHint 只读缓存）
- 缓存格式/原子写/env/超时/异常静默 → Task 1/3 实现约束
- 错误处理（sha256 不匹配不安装、阶段失败不中断）→ Task 5 Step 3
- 测试计划 → Task 1/2/3/4/5 测试文件 + Task 6 验证清单
- 风险表（tarball 缺失报错、限流缓存、EACCES 提示、notify 稳定）→ Task 5 Step 3 / Task 1 缓存 / Task 3 静默

**占位符扫描：** 无 TBD/TODO；所有代码步骤含完整实现。

**类型一致性：** `compareVersions`/`isUpdateAvailable` 在 Task 1/3 各自定义（独立文件，签名一致）；Task 4 `formatUpdateHint` 消费 Task 3 的 `UpdateReport` 形状（{pit?, piSdk?, currentPit?, currentPiSdk?}）一致；Task 5 import Task 1 的 `compareVersions`/`PIT_REPO`（`../version-check.js` 相对 `src/ptl/pit/admin.ts` 正确）。

**已知注意点（已内联处理）：**
- Task 2 Step 3 的 `require` 在 ESM 不可用 → 步骤内已给替代方案（顶层 import spawnSync）
- Task 5 `updateAll`/`updateSelf` 判定在 Step 4 中两次修正，最终语义：无 flag/`--all` → 含②；`--extensions`/`--pi-only` → 不含②；`--dry-run` 不安装
