# framework 拆分 Plan B：环境能力（env 命令族 + extension copy + reload）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 framework 的环境核心能力——env 命令族（create/fork/list/show/set/rm）+ extension/skill copy 双模式 + reload 接入，使 AI 能自主操作环境（spec §4/§5/§6）。

**Architecture:** 在 `packages/framework/src/` 新增 env 命令模块（基于现有 commands.ts 的 template 命令族）+ extension copy 命令（基于 shared-layer.ts 的 symlink/遮蔽机制）+ 文档化 reload 流程。命令注册到 CLI（run.ts）。

**Tech Stack:** node:fs/promises、node:path。零新依赖。

## Global Constraints

- 概念层（spec §2）：template=配方 / session=实例 / agent=单发——命令语义严格对齐
- env 六命令：create（fresh 无预设）/fork（复制配方引用）/list/show/set/rm——全部支持 --json
- fork 复制**配方引用**（轻），扩展/skill 实体不复制（spec §6.1）
- extension copy 双模式：引用（默认，symlink）vs 源码（--mode source，复制实体遮蔽共享）（spec §6.2）
- **遮蔽机制**（已验证）：shared-layer.ts:63 symlink 创建跳过已存在的——环境目录放实体即遮蔽共享
- reload：会话内 /reload（pi 原生）——文档化流程，不实现外部触发（spec §5 裁决 17）
- provider 全局（不做 per-template 覆盖）；skill 跟扩展机制
- **UX 穿插**（能力先行）：审计的 18 个 UX 问题作为穿插任务（本 plan 至少修 stop --all 坏命令——它被 template rm 推荐）
- 不碰：src/pth、packages/infra、用户 WIP
- 提交风格：`feat(framework): 中文摘要` / `fix(framework): 中文摘要`

---

### Task 1: env 命令族（create/list/show/set/rm）

**Files:**
- Create: `packages/framework/src/env.ts`
- Modify: `packages/framework/src/cli/run.ts`（命令注册）
- Create: `test/env.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`createTemplate`/`getTemplateAlias`（@pi-triple/shared config）
- Produces: `execEnvCreate`/`execEnvList`/`execEnvShow`/`execEnvSet`/`execEnvRm`——CommandResult 形态（对齐现有 execTemplate 系列）

- [ ] **Step 1: 写失败测试**

```ts
// test/env.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execEnvCreate, execEnvList, execEnvShow, execEnvSet, execEnvRm } from "../packages/framework/src/env.js";

describe("env commands", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-env-"));
    // 测试用独立 dataDir（env 命令读 config 的 dataDir）
    process.env.PI_TRIPLE_HOME = dir;
  });

  afterAll(async () => {
    delete process.env.PI_TRIPLE_HOME;
    await rm(dir, { recursive: true, force: true });
  });

  it("create makes a fresh env (no preset)", async () => {
    const r = await execEnvCreate("knowledge", {});
    expect(r.ok).toBe(true);
    const list = await execEnvList();
    expect(list.data?.envs?.some((e: any) => e.alias === "knowledge")).toBe(true);
  });

  it("show displays recipe", async () => {
    const r = await execEnvShow("knowledge");
    expect(r.ok).toBe(true);
    expect(r.data?.recipe).toBeDefined();
  });

  it("set modifies recipe field", async () => {
    const r = await execEnvSet("knowledge", { model: "qwen3.8-max" });
    expect(r.ok).toBe(true);
    const show = await execEnvShow("knowledge");
    expect(show.data?.recipe?.model).toBe("qwen3.8-max");
  });

  it("rm removes env", async () => {
    const r = await execEnvRm("knowledge");
    expect(r.ok).toBe(true);
    const list = await execEnvList();
    expect(list.data?.envs?.some((e: any) => e.alias === "knowledge")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/env.test.ts`
Expected: FAIL——`execEnvCreate` 不存在

- [ ] **Step 3: 写实现（基于现有 template 命令，对齐 TemplateConfig 配方字段）**

```ts
// packages/framework/src/env.ts
// execEnvCreate(alias, opts) → createTemplate(alias, {}) + 目录/共享层/AGENTS.md（复用 execTemplateNew 逻辑）
// execEnvList() → templates 映射为 [{id, alias, recipe 摘要}]
// execEnvShow(alias) → 完整配方（TemplateConfig 字段：model/provider/thinking/tools/skills/extensions/workLoop/instantiation）
// execEnvSet(alias, patch) → 合并配方字段
// execEnvRm(alias) → deleteTemplate（复用 execTemplateRm 逻辑）
// 全部返回 CommandResult（ok/message/data），data 机器可读（--json 输出）
```

- [ ] **Step 4: 验证通过 + 注册到 run.ts**

```ts
// run.ts case "env": dispatch 到 env 命令（create/fork/list/show/set/rm）
```

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(framework): env 命令族——create/list/show/set/rm（fresh 无预设/配方读写/--json 可编程），注册到 CLI"
```

---

### Task 2: env fork（配方引用复制）

**Files:**
- Modify: `packages/framework/src/env.ts`（加 execEnvFork）
- Create: `test/env-fork.test.ts`

**Interfaces:**
- Consumes: Task 1 env 命令 + `createTemplate`（shared config）
- Produces: `execEnvFork(newAlias, srcAlias)`——复制配方引用（model/skills/extensions 等字段），不复制实体

- [ ] **Step 1: 写失败测试**

```ts
// test/env-fork.test.ts
it("fork copies recipe references (not entities)", async () => {
  await execEnvSet("src", { model: "qwen", skills: ["s1"], extensions: ["e1"] });
  const r = await execEnvFork("forked", "src");
  expect(r.ok).toBe(true);
  const show = await execEnvShow("forked");
  expect(show.data?.recipe?.model).toBe("qwen");
  expect(show.data?.recipe?.skills).toEqual(["s1"]);
  expect(show.data?.recipe?.extensions).toEqual(["e1"]);
});

it("forked env is independent (set on fork doesn't affect src)", async () => {
  await execEnvSet("forked", { model: "other" });
  const src = await execEnvShow("src");
  expect(src.data?.recipe?.model).toBe("qwen");
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/env-fork.test.ts`
Expected: FAIL——`execEnvFork` 不存在

- [ ] **Step 3: 写实现**

```ts
// execEnvFork(newAlias, srcAlias):
// 1. 读源 template 配方（getTemplateById）
// 2. createTemplate(newAlias, { ...源配方字段 })——复制引用（model/skills/extensions 等）
// 3. 建目录 + 共享层链接 + AGENTS.md（复用 execTemplateNew 的建模板逻辑）
// 返回 {id, alias, recipe}（--json 可编程）
```

- [ ] **Step 4: 验证通过**

Run: `npx vitest run test/env-fork.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(framework): env fork——配方引用复制（model/skills/extensions 继承，实体不复制，独立可改）"
```

---

### Task 3: extension/skill copy 双模式

**Files:**
- Create: `packages/framework/src/extension-copy.ts`
- Create: `test/extension-copy.test.ts`

**Interfaces:**
- Consumes: `linkTemplateToShared`/`unlinkTemplateFromShared`（shared-layer.ts）、`loadConfig`（shared）
- Produces: `execExtensionCopy(name, opts)` / `execSkillCopy(name, opts)`——`--from <env>` + `--mode 引用|源码`

- [ ] **Step 1: 写失败测试**

```ts
// test/extension-copy.test.ts
// 引用模式（默认）：环境 extensions/ 下建 symlink → shared/extensions/<name>
// 源码模式（--mode source）：复制实体到环境 extensions/<name>（遮蔽共享 symlink）
it("reference mode creates symlink", async () => {
  // 准备：shared/extensions/e1/ 有实体；环境 extensions/ 无 e1
  const r = await execExtensionCopy("e1", { from: "env1", mode: "reference" });
  expect(r.ok).toBe(true);
  const link = join(envDir, "extensions", "e1");
  expect(await lstat(link).then((s) => s.isSymbolicLink())).toBe(true);
});

it("source mode copies entity (shadows symlink)", async () => {
  const r = await execExtensionCopy("e2", { from: "env1", mode: "source" });
  expect(r.ok).toBe(true);
  const dir = join(envDir, "extensions", "e2");
  expect(await lstat(dir).then((s) => s.isDirectory())).toBe(true);
  expect(await lstat(dir).then((s) => s.isSymbolicLink())).toBe(false);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/extension-copy.test.ts`
Expected: FAIL——`execExtensionCopy` 不存在

- [ ] **Step 3: 写实现**

```ts
// execExtensionCopy(name, { from, mode }):
// 引用模式：ensureTemplateLinks（已有——跳过已存在的 symlink）+ 确认 symlink 存在
// 源码模式：cp -r shared/extensions/<name> → 环境 extensions/<name>（实体，遮蔽 symlink）
// skill 同机制（shared/skills → 环境 skills/）
// 完成后提示：会话内 /reload 生效（spec §5）
```

- [ ] **Step 4: 验证通过**

Run: `npx vitest run test/extension-copy.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(framework): extension/skill copy 双模式——引用（symlink 共享）vs 源码（实体遮蔽），完成后 /reload 提示"
```

---

### Task 4: UX 穿插修复（stop --all 坏命令——被 template rm 推荐）

**Files:**
- Modify: `packages/framework/src/commands.ts`（execStop 的 --all 分支修复）
- Modify: `packages/framework/src/cli/args.ts`（--all 参数解析）
- Create: `test/stop-all.test.ts`

**Interfaces:**
- Consumes: 无（独立修复）
- Produces: `ptl stop --all` 正常工作（UX 审计 #1）

- [ ] **Step 1: 写失败测试**

```ts
// test/stop-all.test.ts
// 当前：ptl stop --all 报"用法: ptl stop <name> | --stale | --orphans"（--all 分支不可达）
// 期望：ptl stop --all 停止所有会话
it("stop --all stops all sessions", async () => {
  // mock 会话列表（2 个会话）→ execStop("--all") → 两个都停
});
```

- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 修实现（execStop 入口处理 flags.all / args.ts 收 --all 进参数语义）**
- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

```bash
git commit -m "fix(framework): stop --all 坏命令修复——execStop 处理 --all 分支（UX 审计 #1），template rm 的推荐命令现在可用"
```

---

## 自审（Self-Review）

**1. Spec coverage：**
- Spec §4 env 命令族 → Task 1/2 ✅
- Spec §5 跨环境扩展加载 → Task 3（copy）+ reload 文档化 ✅
- Spec §6 隔离工具链（fork 引用 + copy 双模式 + 遮蔽）→ Task 2/3 ✅
- UX 穿插（能力先行）→ Task 4（至少修 stop --all）✅

**2. Placeholder scan：** 无 TBD；代码为骨架（实施时逐字展开）。

**3. Type consistency：** `execEnvCreate` 等签名（Task 1）被 Task 2 fork 复用；`execExtensionCopy`（Task 3）与 shared-layer 函数对齐；CommandResult 形态与现有命令一致。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-framework-split-b.md`. Two execution options:

1. **Subagent-Driven (recommended)** - fresh subagent per task + review
2. **Inline Execution** - executing-plans with checkpoints

**Which approach?**
