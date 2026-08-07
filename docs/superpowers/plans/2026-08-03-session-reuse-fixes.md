# Session 复用 Bug 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 pi-platform session 复用机制（fork/clone/transfer/branch/resume/restore）的 5 个已确认 bug：resume 双写者、restore 错纸带、transfer 运行中会话损坏纸带、resolveSession 前缀歧义、readEntries 单行损坏整体失败。

**Architecture:** 纸带会话 = `<dataDir>/sessions/<templateId>/<ts>_<uuidv7>.jsonl`，谱系用 `parentSession`（源文件绝对路径）链接。修复分三层：pi-scan/pi-fork 纯逻辑层（容错 + 防护 + 重链）、session-store 解析层（歧义检测）、pit/commands 编排层（运行态防护 + 注册表 sessionId 追踪）。

**Tech Stack:** Node ≥22 / TypeScript / vitest / spawnSync-tmux 编排

## Global Constraints

- 每个 bug 修复必须先写失败测试（TDD），验证 RED 后再实现（GREEN）
- 每次修改后运行 `npx vitest run test/unit/pi-fork.test.ts test/unit/pi-scan.test.ts test/unit/session-store.test.ts test/unit/pi-tree.test.ts test/unit/pi-provider.test.ts` 保证既有 23 个测试不回归
- 完成后运行 `npm run lint`（tsc --noEmit）确保类型干净
- 错误码风格沿用现有 `UPPER_SNAKE`（如 `ALREADY_RUNNING`、`AMBIGUOUS`）
- `transferSession` 保持"写入成功才删源"的回滚安全原则
- 所有新增纯函数放 `src/ptl/session/pi-scan.ts`（读侧，无重依赖）；编排层改动最小化
- 提交信息用现有风格：`fix(session): <描述>`

---
### Task 1: readEntries 容错——纸带单行损坏不再整体失败

**Files:**
- Modify: `src/ptl/session/pi-fork.ts`（`readEntries` + 4 个调用点）
- Test: `test/unit/pi-fork.test.ts`

**Interfaces:**
- Consumes: 现有 `readEntries(file): { header; entries } | null`
- Produces: `readEntries(file): { header; entries; skipped } | null`（`skipped: number` 为跳过坏行数；header 损坏仍返回 null）

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/pi-fork.test.ts`）

```ts
it("fork 容忍纸带损坏行：跳过坏行、其余事件照常复制", () => {
  writeSession("a.jsonl", [H1, E1, "this-is-not-json{{{", E2]);
  const src = scanSessionFiles(root)[0]!;
  const r = forkSession(src, {});
  expect(r.ok).toBe(true);
  const content = fs.readFileSync((r.data as { file: string }).file, "utf-8").trim().split("\n");
  const ids = content.slice(1).map((l) => JSON.parse(l) as any).map((e) => e.id);
  expect(ids).toEqual(["e1", "e2"]);
});
```

- [ ] **Step 2: 运行验证 RED**

Run: `npx vitest run test/unit/pi-fork.test.ts`
Expected: FAIL（当前 `readEntries` 整行 JSON.parse 抛错 → 返回 null → SESSION_NOT_FOUND）

- [ ] **Step 3: 实现**（`src/ptl/session/pi-fork.ts`）

```ts
function readEntries(file: string): { header: SessionHeader; entries: any[]; skipped: number } | null {
  try {
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]!) as SessionHeader;
    if (header.type !== "session" || typeof header.id !== "string") return null;
    const entries: any[] = [];
    let skipped = 0;
    for (const l of lines.slice(1)) {
      try { entries.push(JSON.parse(l)); } catch { skipped++; } // 单行损坏跳过（双写者/截断容忍）
    }
    return { header, entries, skipped };
  } catch {
    return null;
  }
}
```

4 个调用点（forkSession/cloneSession/transferSession/forkSessionAtNode）取 `parsed.entries` 处不变（字段名不变）；在返回 message 里追加警告（`parsed.skipped > 0` 时）：

```ts
const warned = parsed.skipped > 0 ? `（跳过 ${parsed.skipped} 行损坏数据）` : "";
// fork: message: `✅ 已 fork 会话 ${source.id.slice(0, 8)}… → ${path.basename(written.file)}${warned}`
```

- [ ] **Step 4: 运行验证 GREEN**

Run: `npx vitest run test/unit/pi-fork.test.ts`
Expected: PASS（新增 1 + 既有 8）

- [ ] **Step 5: 提交**

```bash
git add src/ptl/session/pi-fork.ts test/unit/pi-fork.test.ts
git commit -m "fix(session): readEntries 单行损坏容错（跳过坏行，fork/clone/transfer/branch 不再整体失败）"
```

---
### Task 2: transfer 运行中会话防护 + 子会话谱系重链

**Files:**
- Modify: `src/ptl/session/pi-fork.ts`（`transferSession` 签名 + 防护 + `rewriteChildrenParent`）
- Modify: `src/ptl/session/pi-provider.ts`（`transfer` 传入 running 状态）
- Test: `test/unit/pi-fork.test.ts`

**Interfaces:**
- Consumes: `transferSession(source: PiSessionFile, opts: TransferOpts)`
- Produces: `transferSession(source: PiSessionFile, opts: TransferOpts, running?: boolean)`——`running=true` 时返回 `ALREADY_RUNNING` 且不碰源文件；转移成功后把 `parentSession === 旧路径` 的所有子会话重写为 `新路径`（返回 message 附 `（已重链 N 个子会话）`）

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/pi-fork.test.ts`）

```ts
it("transfer 运行中的会话：拒绝且源文件不动", () => {
  writeSession("a.jsonl", [H1, E1]);
  const src = scanSessionFiles(root)[0]!;
  const r = transferSession(src, { templateId: "t2" }, true);
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe("ALREADY_RUNNING");
  expect(fs.existsSync(src.file)).toBe(true);
  expect(fs.readdirSync(path.join(root, "sessions", "t2"))).toHaveLength(0);
});

it("transfer 成功后子会话 parentSession 重链到新路径", () => {
  const srcFile = writeSession("a.jsonl", [H1, E1]);
  // 子会话：同模板，parentSession 指向源文件
  const childHeader = H1.replace(
    '"id":"aaaaaaaa-1111-4111-8111-111111111111"',
    `"id":"bbbbbbbb-2222-4222-8222-222222222222","parentSession":"${srcFile}"`,
  );
  writeSession("child.jsonl", [childHeader, E1]);
  const src = scanSessionFiles(root).find((f) => f.id === "aaaaaaaa-1111-4111-8111-111111111111")!;
  const r = transferSession(src, { templateId: "t2" }, false);
  expect(r.ok).toBe(true);
  const dest = (r.data as { file: string }).file;
  const child = scanSessionFiles(root).find((f) => f.id === "bbbbbbbb-2222-4222-8222-222222222222")!;
  expect(child.parentSession).toBe(dest);
});
```

- [ ] **Step 2: 运行验证 RED**

Run: `npx vitest run test/unit/pi-fork.test.ts`
Expected: FAIL（transferSession 无第三参数、无防护、无重链——`ALREADY_RUNNING` 未定义 / 子会话 parentSession 仍指向旧路径）

- [ ] **Step 3: 实现**（`src/ptl/session/pi-fork.ts`）

`transferSession` 开头（resolveTarget 之前）加防护：

```ts
if (running) {
  return { ok: false, message: "", error: { code: "ALREADY_RUNNING", message: `会话 ${source.id.slice(0, 8)}… 正在运行，请先停止再转移（ptl session stop <id>）` } };
}
```

成功移动后、返回前加重链（新私有函数 + 调用）：

```ts
/** 重写所有 parentSession 指向旧路径的子会话为新路径（谱系保持） */
function rewriteChildrenParent(oldPath: string, newPath: string, dataDir: string): number {
  let n = 0;
  for (const f of scanSessionFiles(dataDir)) {
    if (f.file === oldPath || f.file === newPath) continue;
    if (f.parentSession !== oldPath) continue;
    try {
      const lines = fs.readFileSync(f.file, "utf-8").split("\n");
      const header = JSON.parse(lines[0]!) as SessionHeader;
      header.parentSession = newPath;
      lines[0] = JSON.stringify(header);
      fs.writeFileSync(f.file, lines.join("\n"));
      n++;
    } catch { /* 单个子会话重写失败不影响转移本身 */ }
  }
  return n;
}
```

调用点（transferSession 内，`fs.rmSync(source.file)` 之后）：

```ts
const relinked = rewriteChildrenParent(source.file, destFile, dataDirOf(source));
return {
  ok: true,
  message: `✅ 已转移会话 ${source.id.slice(0, 8)}… → 模板 ${target.templateId}${relinked > 0 ? `（已重链 ${relinked} 个子会话）` : ""}`,
  data: { file: destFile },
};
```

`pi-provider.ts` 的 `transfer` 传入运行态：

```ts
function transfer(r: SessionRecord, opts: TransferOpts): CommandResult {
  const hit = requireSessionFile(r.id);
  return hit.ok ? transferSession(hit.file, opts, r.status === "running") : hit.error;
}
```

- [ ] **Step 4: 运行验证 GREEN**

Run: `npx vitest run test/unit/pi-fork.test.ts test/unit/pi-provider.test.ts`
Expected: PASS（新增 2 + 既有 10）

- [ ] **Step 5: 提交**

```bash
git add src/ptl/session/pi-fork.ts src/ptl/session/pi-provider.ts test/unit/pi-fork.test.ts
git commit -m "fix(session): transfer 运行中会话拒绝 + 子会话 parentSession 重链（谱系保持）"
```

---
### Task 3: resolveSession/resolveTrace 前缀歧义检测

**Files:**
- Modify: `src/ptl/session/session-store.ts`（`resolveSession`/`resolveTrace` 返回结果对象 + `operateSession` 适配）
- Modify: `src/ptl/commands/session.ts`（`execSessionShow`/`execSessionResume`/`execSessionBranch` 适配）
- Modify: `src/ptl/commands/trace.ts`（`resolveTrace` 适配）
- Test: `test/unit/session-store.test.ts`、`test/unit/pi-provider.test.ts`

**Interfaces:**
- Consumes: `resolveSession(input): SessionRecord | null`
- Produces: `SessionResolveResult = { ok: true; record: SessionRecord } | { ok: false; reason: "not_found" | "ambiguous"; candidates?: string[] }`；`resolveSession`/`resolveTrace` 同构
- 语义：完整 id 精确命中优先；前缀唯一命中 → ok；前缀多命中 → `ambiguous` + candidates；无命中 → `not_found`

- [ ] **Step 1: 写失败测试**（`test/unit/session-store.test.ts`）

改 `makeProvider` 支持指定 id（默认不变）：

```ts
function makeProvider(workloop: string, caps: string[], id: string = "aaaaaaaa-1111-4111-8111-111111111111"): SessionProvider {
  return {
    workloop,
    capabilities: caps,
    list: () => [{ id, kind: "session" as const, workloop, templateId: "t1", templateAlias: "tpl-a", status: "stopped", timestamp: "2026-07-01T00:00:00.000Z", summary: `sess-${workloop}`, detail: {} }],
    show: (r) => `show:${r.id}`,
    fork: (r) => ({ ok: true, message: `forked:${r.id}` }),
  };
}
```

更新既有断言 + 新增歧义用例：

```ts
it("resolveSession 支持完整 UUID 与唯一前缀", () => {
  registerSessionProvider(makeProvider("pi", []));
  const full = resolveSession("aaaaaaaa-1111-4111-8111-111111111111");
  expect(full.ok).toBe(true);
  if (full.ok) expect(full.record.id).toBe("aaaaaaaa-1111-4111-8111-111111111111");
  const prefix = resolveSession("aaaaaaaa-1111");
  expect(prefix.ok).toBe(true);
  const none = resolveSession("zzzz");
  expect(none.ok).toBe(false);
  if (!none.ok) expect(none.reason).toBe("not_found");
});

it("resolveSession 前缀多命中返回 ambiguous + 候选", () => {
  registerSessionProvider(makeProvider("pi", [], "aaaaaaaa-1111-4111-8111-111111111111"));
  registerSessionProvider(makeProvider("pi", [], "aaaaaaaa-2222-4222-8222-222222222222"));
  const r = resolveSession("aaaaaaaa");
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
  }
});
```

`pi-provider.test.ts` 既有断言适配（`resolveSession("__none__")` 从 `toBeNull()` 改为结果对象）：

```ts
const none = resolveSession("__none__");
expect(none.ok).toBe(false);
if (!none.ok) expect(none.reason).toBe("not_found");
```

- [ ] **Step 2: 运行验证 RED**

Run: `npx vitest run test/unit/session-store.test.ts test/unit/pi-provider.test.ts`
Expected: FAIL（resolveSession 返回 record/null，`ok`/`reason` 不存在；歧义用例取到第一个而非报错）

- [ ] **Step 3: 实现**（`src/ptl/session/session-store.ts`）

```ts
export type SessionResolveResult =
  | { ok: true; record: SessionRecord }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates?: string[] };

function resolveByPrefix<T extends { id: string }>(items: T[], input: string): SessionResolveResult {
  const exact = items.find((x) => x.id === input);
  if (exact) return { ok: true, record: exact as unknown as SessionRecord };
  const matches = items.filter((x) => x.id.startsWith(input));
  if (matches.length === 1) return { ok: true, record: matches[0] as unknown as SessionRecord };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches.map((x) => x.id) };
  return { ok: false, reason: "not_found" };
}

export function resolveSession(input: string): SessionResolveResult {
  return resolveByPrefix(sessionProviders.flatMap((p) => p.list()), input);
}

export function resolveTrace(input: string): SessionResolveResult {
  return resolveByPrefix(traceProviders.flatMap((p) => p.list()), input);
}
```

（如类型擦不干净，直接写两个独立实现，不要用 `as unknown` 强转破坏类型——`SessionRecord` 与 `TraceRecord` 结构不同，泛型仅用于前缀匹配，返回时按各自类型构造。）

`operateSession` 适配：

```ts
const result = resolveSession(id);
if (!result.ok) {
  if (result.reason === "ambiguous") {
    return { ok: false, message: "", error: { code: "AMBIGUOUS", message: `会话 "${id}" 匹配 ${result.candidates?.length ?? 0} 个，请使用完整 UUID：${result.candidates?.map((c) => c.slice(0, 8)).join(", ")}` } };
  }
  return { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话 "${id}" 不存在（ptl session ls 查看）` } };
}
const record = result.record;
```

`commands/session.ts` 三处适配（`execSessionShow`/`execSessionResume`/`execSessionBranch`）：

```ts
// execSessionShow
const r = resolveSession(id);
if (!r.ok) {
  return { ok: false, message: "", error: { code: r.reason === "ambiguous" ? "AMBIGUOUS" : "SESSION_NOT_FOUND", message: r.reason === "ambiguous" ? `会话 "${id}" 有多个匹配，请使用完整 UUID` : `会话 "${id}" 不存在（ptl session ls 查看）` } };
}
const rec = r.record;
// 后续用 rec 替换 r（execSessionShow 用 rec.detail；execSessionResume 用 rec.workloop/rec.templateId/rec.id/rec.status；execSessionBranch 用 rec.id）
```

`commands/trace.ts` 适配（`trace.ts:26` 附近）：

```ts
const r = resolveTrace(id);
if (!r.ok) return { ok: false, message: "", error: { code: "TRACE_NOT_FOUND", message: `轨迹 "${id}" 不存在` } };
```

- [ ] **Step 4: 运行验证 GREEN**

Run: `npx vitest run test/unit/session-store.test.ts test/unit/pi-provider.test.ts && npm run lint`
Expected: PASS（session-store 5→7、pi-provider 2 更新后通过）+ 类型干净

- [ ] **Step 5: 提交**

```bash
git add src/ptl/session/session-store.ts src/ptl/commands/session.ts src/ptl/commands/trace.ts test/unit/session-store.test.ts test/unit/pi-provider.test.ts
git commit -m "fix(session): resolveSession/resolveTrace 前缀歧义检测（对齐 resolveTemplateId 语义）"
```

---
### Task 4: resume 双写者防护 + 恢复会话注册

**Files:**
- Modify: `src/ptl/session-registry.ts`（`RegistryEntry.sessionId?`）
- Modify: `src/ptl/commands/session.ts`（`assertResumable` + `execSessionResume` 防护 + `markStarted`）
- Test: `test/unit/session-cmd.test.ts`（新建）

**Interfaces:**
- Consumes: `SessionRecord`（`workloop`/`status`/`id`）
- Produces: `assertResumable(r: SessionRecord): CommandResult | null`——非 pi → `NOT_SUPPORTED`；`status === "running"` → `ALREADY_RUNNING`；否则 null
- `RegistryEntry` 新增可选字段 `sessionId?: string`（向后兼容：旧注册表缺字段 → undefined → restore 走回退）

- [ ] **Step 1: 写失败测试**（新建 `test/unit/session-cmd.test.ts`）

```ts
import { describe, it, expect } from "vitest";
import { assertResumable } from "../../src/ptl/commands/session.js";
import type { SessionRecord } from "../../src/ptl/session/session-provider.js";

const rec = (status: "running" | "stopped", workloop = "pi"): SessionRecord => ({
  id: "aaaaaaaa-1111-4111-8111-111111111111", kind: "session", workloop,
  templateId: "t1", templateAlias: "tpl-a", status, timestamp: "2026-07-01T00:00:00.000Z", summary: "", detail: {},
});

describe("assertResumable", () => {
  it("运行中的 pi 会话拒绝 resume（防双写者）", () => {
    const r = assertResumable(rec("running"));
    expect(r?.ok).toBe(false);
    expect(r?.error?.code).toBe("ALREADY_RUNNING");
  });

  it("停止的 pi 会话可 resume", () => {
    expect(assertResumable(rec("stopped"))).toBeNull();
  });

  it("非 pi 会话不支持 resume", () => {
    const r = assertResumable(rec("stopped", "machine"));
    expect(r?.ok).toBe(false);
    expect(r?.error?.code).toBe("NOT_SUPPORTED");
  });
});
```

- [ ] **Step 2: 运行验证 RED**

Run: `npx vitest run test/unit/session-cmd.test.ts`
Expected: FAIL（`assertResumable` 未导出）

- [ ] **Step 3: 实现**（`src/ptl/commands/session.ts`）

```ts
/** resume 前置校验（纯函数，可测）：非 pi → NOT_SUPPORTED；运行中 → ALREADY_RUNNING（防双写者） */
export function assertResumable(r: SessionRecord): CommandResult | null {
  if (r.workloop !== "pi") {
    return { ok: false, message: "", error: { code: "NOT_SUPPORTED", message: `会话类型（${r.workloop}）不支持 resume——只有纸带（pi 会话）可恢复` } };
  }
  if (r.status === "running") {
    return { ok: false, message: "", error: { code: "ALREADY_RUNNING", message: `会话 ${r.id.slice(0, 8)}… 正在运行，请直接接入：ptl attach <name>` } };
  }
  return null;
}
```

`execSessionResume` 改造（resolve 后立即校验；成功后注册）：

```ts
const r = resolveSession(id);
if (!r.ok) { /* Task 3 的错误分支 */ }
const rec = r.record;
const guard = assertResumable(rec);
if (guard) return guard;
// ... 原 buildPiLaunch 逻辑，templateId 用 rec.templateId，resumeSession 用 rec.id ...
const name = flags.name || `${getTemplateAlias(rec.templateId, cfg)}-${Date.now().toString(36)}`;
const { startPitSession, getPanePid } = await import("../tmux.js");
const { markStarted } = await import("../session-registry.js");
const { resolveDataDir } = await import("../config.js");
const result = startPitSession(launch, name, true);
if (result.status === 0) {
  markStarted({
    name,
    templateId: rec.templateId,
    model: tpl.model, provider: tpl.provider, thinking: tpl.thinking,
    extraArgs: [],
    startedAt: Date.now(),
    pid: getPanePid(result.session),
    sessionId: rec.id, // 记录纸带 → restore 可精确恢复
  }, resolveDataDir(cfg));
  return { ok: true, message: `✅ 已后台恢复会话 ${rec.id.slice(0, 8)}…\n接入: ptl attach ${name}`, data: { name } };
}
```

`session-registry.ts`：

```ts
export interface RegistryEntry {
  name: string;
  templateId: string;
  model?: string;
  provider?: string;
  thinking?: string;
  extraArgs?: string[];
  startedAt: number;
  pid?: number | null;
  /** 本会话正在使用的纸带 id（resume 直记；fresh 启动后探测）——restore 精确恢复依据 */
  sessionId?: string;
}
```

- [ ] **Step 4: 运行验证 GREEN**

Run: `npx vitest run test/unit/session-cmd.test.ts && npm run lint`
Expected: PASS（3 用例）+ 类型干净

- [ ] **Step 5: 提交**

```bash
git add src/ptl/session-registry.ts src/ptl/commands/session.ts test/unit/session-cmd.test.ts
git commit -m "fix(session): resume 运行中会话拒绝（防双写者）+ 恢复会话写入注册表（sessionId）"
```

---
### Task 5: restore 精确纸带恢复 + fresh 启动记录 sessionId

**Files:**
- Modify: `src/ptl/session/pi-scan.ts`（`isTapeLive` / `newestTapeId` / `pickRestoreTape`）
- Modify: `src/ptl/cli/sessions.ts`（`cmdRestore` 用 `pickRestoreTape`；`cmdStart`/`cmdStartBg` 探测 sessionId）
- Modify: `src/ptl/commands.ts`（`execStartBg` 探测 sessionId）
- Test: `test/unit/pi-scan.test.ts`

**Interfaces:**
- Consumes: `scanSessionFiles`、`listPitPanesDetailed`、`hasTmux`、`loadConfig`
- Produces:
  - `isTapeLive(id: string, panes?: Map<string, PitPaneInfo>): boolean`——有 pane 的 name === `ptl-${id8}` 或 currentCommand 含 id
  - `newestTapeId(templateId: string, sinceMs: number, files?: PiSessionFile[]): string | undefined`——模板内 mtime ≥ sinceMs 的最新纸带
  - `pickRestoreTape(files: PiSessionFile[], entry: { templateId: string; sessionId?: string }, isLive: (id: string) => boolean): { resumeSession?: string; warning?: string }`——注册表 sessionId 优先（存在且未被占用）；否则模板内最新（live 则警告 + 不 resume）；均无 → `{}`

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/pi-scan.test.ts`）

```ts
import { isTapeLive, newestTapeId, pickRestoreTape } from "../../src/ptl/session/pi-scan.js";

it("newestTapeId：since 窗口内最新 mtime 纸带", () => {
  const now = Date.now();
  const w2 = path.join(root, "sessions", "t1", "old.jsonl");
  const w3 = path.join(root, "sessions", "t1", "new.jsonl");
  fs.writeFileSync(w2, `{"type":"session","version":3,"id":"old","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
  fs.writeFileSync(w3, `{"type":"session","version":3,"id":"new","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
  const old = fs.statSync(w2); fs.utimesSync(w2, old.atime, new Date(now - 60_000));
  const files = scanSessionFiles(root);
  expect(newestTapeId("t1", now - 10_000, files)).toBe("new");
  expect(newestTapeId("t1", now + 10_000, files)).toBeUndefined();
});

it("pickRestoreTape：sessionId 优先；文件已消失回退模板最新", () => {
  const now = Date.now();
  fs.writeFileSync(path.join(root, "sessions", "t1", "x.jsonl"), `{"type":"session","version":3,"id":"aaaa","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
  const files = scanSessionFiles(root);
  expect(pickRestoreTape(files, { templateId: "t1", sessionId: "aaaa" }, () => false).resumeSession).toBe("aaaa");
  // sessionId 文件不存在 → 回退最新
  expect(pickRestoreTape(files, { templateId: "t1", sessionId: "gone" }, () => false).resumeSession).toBe("aaaa");
});

it("pickRestoreTape：纸带正被其他会话使用 → 警告且不 resume", () => {
  fs.writeFileSync(path.join(root, "sessions", "t1", "x.jsonl"), `{"type":"session","version":3,"id":"aaaa","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
  const files = scanSessionFiles(root);
  const r = pickRestoreTape(files, { templateId: "t1", sessionId: "aaaa" }, () => true);
  expect(r.resumeSession).toBeUndefined();
  expect(r.warning).toBeTruthy();
});

it("isTapeLive：pane 名 ptl-<id8> 或 currentCommand 含完整 id", () => {
  const panes = new Map<string, any>([
    ["ptl-aaaaaaaa", { pid: 123, currentCommand: "pi --session aaaaaaaa-1111-4111-8111-111111111111" }],
  ]);
  expect(isTapeLive("aaaaaaaa-1111-4111-8111-111111111111", panes)).toBe(true);
  expect(isTapeLive("bbbbbbbb-2222-4222-8222-222222222222", panes)).toBe(false);
});
```

- [ ] **Step 2: 运行验证 RED**

Run: `npx vitest run test/unit/pi-scan.test.ts`
Expected: FAIL（`isTapeLive`/`newestTapeId`/`pickRestoreTape` 未导出）

- [ ] **Step 3: 实现**（`src/ptl/session/pi-scan.ts`）

```ts
/** 纸带 id 是否正被运行中的 pi 写入（pane 名 ptl-<id8> 或当前命令含完整 id） */
export function isTapeLive(id: string, panes: Map<string, PitPaneInfo> = hasTmux() ? listPitPanesDetailed() : new Map()): boolean {
  return [...panes.keys()].some((n) => n === `ptl-${id.slice(0, 8)}` || panes.get(n)?.currentCommand?.includes(id));
}

/** 模板内 sinceMs 之后修改过的最新纸带 id（fresh 启动后探测本会话的 tape） */
export function newestTapeId(templateId: string, sinceMs: number, files: PiSessionFile[] = scanSessionFiles(loadConfig())): string | undefined {
  return files
    .filter((f) => f.templateId === templateId && f.modified >= sinceMs)
    .sort((a, b) => b.modified - a.modified)[0]?.id;
}

/** restore 纸带选择：注册表 sessionId 优先（存在且未被占用）→ 模板最新 → 无 */
export function pickRestoreTape(
  files: PiSessionFile[],
  entry: { templateId: string; sessionId?: string },
  isLive: (id: string) => boolean,
): { resumeSession?: string; warning?: string } {
  const tplFiles = files.filter((f) => f.templateId === entry.templateId);
  if (entry.sessionId) {
    if (tplFiles.some((f) => f.id === entry.sessionId)) {
      if (isLive(entry.sessionId)) {
        return { warning: `纸带 ${entry.sessionId.slice(0, 8)}… 正在其他会话运行，本次全新启动` };
      }
      return { resumeSession: entry.sessionId };
    }
  }
  const latest = [...tplFiles].sort((a, b) => b.modified - a.modified)[0];
  if (!latest) return {};
  if (isLive(latest.id)) return { warning: `模板最新纸带 ${latest.id.slice(0, 8)}… 正在运行，本次全新启动` };
  return { resumeSession: latest.id };
}
```

`ptl/sessions.ts` `cmdRestore` 改造（替换原 `latest` 选择逻辑）：

```ts
const files = scanSessionFiles(config);
const { resumeSession, warning } = pickRestoreTape(files, entry, (id) => isTapeLive(id));
if (warning) console.log(`  ⚠️  ${name}: ${warning}`);
```

并在文件头 import 增加 `pickRestoreTape, isTapeLive`。

`cmdStart`/`cmdStartBg` 的 `markStarted` 增加 sessionId 探测（`Date.now()` 起 5s 窗口；`cmdStart` 无 sleep 可能探测不到，可接受回退）：

```ts
// markStarted 调用处，startedAt 取 Date.now() 同一时刻：
const now = Date.now();
markStarted({
  name, templateId,
  model: templateConfig.model, provider: templateConfig.provider, thinking: templateConfig.thinking,
  extraArgs: piPassthrough, startedAt: now, pid,
  sessionId: newestTapeId(templateId, now - 5000, scanSessionFiles(config)),
}, resolveDataDir(config));
```

`commands.ts` `execStartBg` 同样在 markStarted 加 `sessionId: newestTapeId(templateId, Date.now() - 5000, scanSessionFiles(config))`（import `scanSessionFiles`、`newestTapeId`）。

- [ ] **Step 4: 运行验证 GREEN**

Run: `npx vitest run test/unit/pi-scan.test.ts test/unit/pi-fork.test.ts test/unit/session-store.test.ts test/unit/pi-tree.test.ts test/unit/pi-provider.test.ts test/unit/session-cmd.test.ts && npm run lint`
Expected: PASS（全部）+ 类型干净

- [ ] **Step 5: 提交**

```bash
git add src/ptl/session/pi-scan.ts src/ptl/cli/sessions.ts src/ptl/commands.ts test/unit/pi-scan.test.ts
git commit -m "fix(session): restore 按注册表 sessionId 精确恢复 + fresh 启动记录纸带（防恢复错会话）"
```

---
## 自检

1. **Spec 覆盖**：bug 1（Task 4）、bug 2（Task 4 注册 + Task 5 精确恢复）、bug 3（Task 2）、bug 4（Task 3）、bug 5（Task 1）全部有任务。同步问题已与用户确认是设计行为（两个独立会话），不改代码，仅最终报告说明。
2. **占位符扫描**：所有步骤含真实代码。
3. **类型一致性**：`resolveSession` 返回 `SessionResolveResult`（Task 3 定义）→ Task 4 的 `execSessionResume` 用 `r.record`；`RegistryEntry.sessionId`（Task 4 定义）→ Task 5 的 `pickRestoreTape(entry.sessionId)`；`transferSession` 第三参 `running`（Task 2）→ `pi-provider.transfer` 传 `r.status === "running"`。链上一致。

**验证命令（收尾）**：`npm run lint && npx vitest run && npm run build`
