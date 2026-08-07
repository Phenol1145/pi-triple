# PTL 认知注入 + agent-lab 调度模式打磨 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两个 bug——① PTL 会话内 agent 认知不全（按裸 pi 模式修改自身）；② agent-lab 调度阻塞（竞价是唯一路径、winner 执行无超时）。

**Architecture:** A 部分：利用 pi 原生 AGENTS.md 机制（`PI_CODING_AGENT_DIR` 已指向模板目录，`loadProjectContextFiles` 自动加载 agentDir 的 AGENTS.md），新增仓库内模板 `docs/ptl/templates/AGENTS.md.tpl`，在 `template new` 与 launcher 启动时渲染 `<templateId>/<alias>` 占位符写入模板目录。B 部分：agent-lab 内新增 `SchedulingStrategy` 三模式（direct/weighted/market），DispatchRequest 显式指定 + resolver 自动路由，winner 执行墙钟超时封装在 `SchedulerSDK.agents.run` 层（runner-sdk.ts）。

**Tech Stack:** Node.js + TypeScript（tsx 直接跑 .ts）、node:test 测试框架、node:sqlite 内存库、pi SDK 适配层、agent-lab 扩展（DefinitionRegistry/SchedulerRegistry 架构）。

**Spec:** `docs/superpowers/specs/2026-08-06-ptl-agent-lab-polish-design.md`

## Global Constraints

- 测试运行：`npx vitest run`（PTL 侧，950+ 用例全绿）；agent-lab 侧 `node --test extensions/agent-lab/test/` 或仓库约定命令（见各任务）
- 类型检查：`npm run lint`（tsc --noEmit）通过
- 不触碰：`.pi-platform-data/`、宿主 redis（PID 3152）、dev 容器（pi-platform-dev-1）
- 不改动 pi 本体（/usr/local/lib/node_modules/@earendil-works/pi-coding-agent）——只读引用其机制
- 提交风格：`<type>(<scope>): 中文摘要——细节`，直接工作于 main
- A 部分不改用 PROMPT.md 机制（保留 launcher 现有实现，不启用）
- B 部分默认策略 market 时现有行为不变（兼容性）
- 命名：新增类型统一 `SchedulingStrategy`；resolver 文件放 `src/scheduler/strategy.ts`
- 模板 AGENTS.md 占位符：`<templateId>`、`<alias>` 两个，渲染后不得残留占位符文本

---

### Task 1: (A部分) AGENTS.md 模板源文件 + 渲染写入逻辑

**Files:**
- Create: `docs/ptl/templates/AGENTS.md.tpl`
- Create: `src/ptl/template-agents.ts`
- Test: `test/unit/template-agents.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）；使用 `resolveDataDir(config)`、`getTemplateAlias(id, config)`（均已在 `src/ptl/config.ts` 导出）
- Produces: `renderTemplateAgents(tplContent: string, templateId: string, alias: string): string` — 替换占位符返回最终内容；`ensureTemplateAgents(templateDir: string, templateId: string, alias: string, tplPath?: string): boolean` — 若目标 AGENTS.md 缺失或内容过期则写入，返回是否写入；`AGENTS_TPL_PATH` 常量（仓库内相对路径）

- [ ] **Step 1: 写失败测试**

```ts
// test/unit/template-agents.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplateAgents, ensureTemplateAgents, AGENTS_TPL_PATH } from "../../src/ptl/template-agents.js";

const TPL = `# 你是 PTL 模板环境中的 pi agent
- 当前模板：<templateId>（别名 <alias>）`;

test("renderTemplateAgents 替换两个占位符", () => {
  const out = renderTemplateAgents(TPL, "abc-123", "local");
  assert.equal(out.includes("abc-123"), true);
  assert.equal(out.includes("local"), true);
  assert.equal(out.includes("<templateId>"), false);
  assert.equal(out.includes("<alias>"), false);
});

test("ensureTemplateAgents 写入并返回 true", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptl-agents-"));
  try {
    const written = ensureTemplateAgents(dir, "abc-123", "local", TPL);
    assert.equal(written, true);
    const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    assert.equal(content.includes("abc-123"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTemplateAgents 内容未变时返回 false（幂等）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptl-agents-"));
  try {
    ensureTemplateAgents(dir, "abc-123", "local", TPL);
    const second = ensureTemplateAgents(dir, "abc-123", "local", TPL);
    assert.equal(second, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AGENTS_TPL_PATH 指向仓库内模板文件", () => {
  assert.equal(existsSync(AGENTS_TPL_PATH), true);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/unit/template-agents.test.ts`
Expected: FAIL — `Cannot find module '../../src/ptl/template-agents.js'`

- [ ] **Step 3: 写最小实现**

```ts
// src/ptl/template-agents.ts
import fs from "node:fs";
import path from "node:path";

/** 仓库内 AGENTS.md 模板源（相对 repo root；运行时用 __dirname 回退） */
export const AGENTS_TPL_PATH = path.resolve(import.meta.dirname, "../../docs/ptl/templates/AGENTS.md.tpl");

export function renderTemplateAgents(tplContent: string, templateId: string, alias: string): string {
  return tplContent
    .replaceAll("<templateId>", templateId)
    .replaceAll("<alias>", alias);
}

/**
 * 确保模板目录存在 AGENTS.md。目标缺失或与模板源不一致时写入。
 * @returns 是否执行了写入
 */
export function ensureTemplateAgents(
  templateDir: string,
  templateId: string,
  alias: string,
  tplPath: string = AGENTS_TPL_PATH,
): boolean {
  const target = path.join(templateDir, "AGENTS.md");
  const tpl = fs.readFileSync(tplPath, "utf-8");
  const rendered = renderTemplateAgents(tpl, templateId, alias);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf-8");
    if (existing === rendered) return false;
  }
  fs.writeFileSync(target, rendered);
  return true;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/unit/template-agents.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 写 AGENTS.md.tpl 内容**

```markdown
# 你是 PTL（Pi-Triple-Lite）模板环境中的 pi agent

- 当前模板：`<templateId>`（别名 `<alias>`），配置根：`PI_CODING_AGENT_DIR`
- 你运行在 PTL 多模板环境中——**修改本环境（扩展/技能/工具/配置）前必须遵守 PTL 治理规则**

## 修改自身前必读（按顺序）

1. PTL 放置决策树 + 陷阱清单（唯一真相源）：`<repo>/docs/ptl/authoring.md`
2. pi 官方技能规范：npm 包内 `docs/skills.md`（技能位置/SKILL.md 格式/frontmatter/校验）
3. pi 官方扩展规范：npm 包内 `docs/extensions.md`（Extension Locations/Writing an Extension）
4. 创建技能前加载 `writing-skills` 技能（superpowers 包：`git:github.com/obra/superpowers`）

## 铁律（速查）

- **写扩展/技能 → PTL 共享层（`~/.pi-triple/data/shared/`）或模板本地**，绝不写 `~/.agents/skills/`（那是裸 pi 的体制外目录，不受模板治理）
- **删模板内共享层 symlink ≠ 卸载**——`ensureTemplateLinks` 每次启动会补链，手动删的会复活；要排除必须把条目移出共享层
- **不要与 bundled 扩展同名**——`ptl update --all` 会覆盖自定义扩展
- **非开源/不可信二进制不进 dev 容器**（Mach-O 在 Linux 容器不可执行）
- **改 dev 容器工具**：先 `docker compose exec dev which <tool>` 确认现状，再按放置决策树选路径

## 环境信息

- 本模板会话的 workspace 与共享层路径由 PTL 注入，勿假设裸 pi 目录布局
- 排查自身问题用：`ptl doctor`、`ptl template ls`、`ptl shared status`
```

- [ ] **Step 6: 全量回归 + 提交**

Run: `npx vitest run && npm run lint`
Expected: 全绿 + lint 通过

```bash
git add docs/ptl/templates/AGENTS.md.tpl src/ptl/template-agents.ts test/unit/template-agents.test.ts
git commit -m "feat(ptl): AGENTS.md 模板源+渲染写入——pi 原生认知注入（A1）——tpl 含铁律速查/必读引用，渲染替换 templateId/alias 占位符，幂等写入模板目录"
```

---

### Task 2: (A部分) 接入 template new + launcher 启动补写

**Files:**
- Modify: `src/ptl/commands.ts:91-124`（execTemplateNew）
- Modify: `src/ptl/launcher.ts:130-140`（buildPiProcess 内 ensureTemplateLinks 附近）
- Test: `test/integration/` 下新增 `template-agents-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ensureTemplateAgents`、`getTemplateAlias`（`src/ptl/config.ts` 已导出）、`linkTemplateToShared`（shared-layer.ts）
- Produces: 无新导出——行为变更：`ptl template new <alias>` 创建模板后立即生成 AGENTS.md；launcher 每次启动对既有模板补写（幂等，内容一致时跳过）

- [ ] **Step 1: 写失败测试（集成）**

```ts
// test/integration/template-agents-integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("launcher 启动补写 AGENTS.md（幂等）", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ptl-launch-"));
  try {
    // 构造一个最小模板目录 + 配置
    const templateId = "tpl-0001";
    const tplDir = join(dataDir, "pi-config", templateId);
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(dataDir, "pi-triple.json"), JSON.stringify({
      templates: { [templateId]: { alias: "local" } },
    }));

    const { ensureTemplateAgents } = await import("../../src/ptl/template-agents.js");
    const alias = "local";
    ensureTemplateAgents(tplDir, templateId, alias);
    const first = readFileSync(join(tplDir, "AGENTS.md"), "utf-8");
    assert.equal(first.includes(templateId), true);
    // 幂等：再次调用不变化
    ensureTemplateAgents(tplDir, templateId, alias);
    const second = readFileSync(join(tplDir, "AGENTS.md"), "utf-8");
    assert.equal(second, first);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/integration/template-agents-integration.test.ts`
Expected: FAIL — `ensureTemplateAgents is not a function`（尚未接入，或模块不存在）

- [ ] **Step 3: 接入 commands.ts（template new）**

在 `execTemplateNew` 的 shared-layer 链接之后、migrate 检查之前插入：

```ts
// 写入 AGENTS.md 认知注入（pi 原生机制）
const { ensureTemplateAgents } = await import("./template-agents.js");
const agentsWritten = ensureTemplateAgents(templateDir, id, displayAlias);
if (agentsWritten) sharedMsg += "\n  ✅ 已写入 AGENTS.md（PTL 认知注入）";
```

- [ ] **Step 4: 接入 launcher.ts（启动补写）**

在 `buildPiProcess` 的 `ensureTemplateLinks(piConfigDir, sharedDir)` 之后插入：

```ts
// ensure template AGENTS.md (PTL identity injection, idempotent)
const { ensureTemplateAgents } = await import("./template-agents.js");
const alias = getTemplateAlias(templateId);
ensureTemplateAgents(piConfigDir, templateId, alias);
```

`getTemplateAlias` 需在 launcher.ts 顶部 import（检查现有 import——若已有则跳过）。

- [ ] **Step 5: 运行集成测试验证通过**

Run: `npx vitest run test/integration/template-agents-integration.test.ts`
Expected: PASS

- [ ] **Step 6: 手动验证真实模板**

Run:
```bash
cd /Users/anzhize/pi-platform && node -e "
const { ensureTemplateAgents } = require('./dist/ptl/template-agents.js');
" 2>/dev/null || node --import tsx -e "
import { ensureTemplateAgents } from './src/ptl/template-agents.ts';
import { readFileSync } from 'node:fs';
const tid = 'ee7cae31-2dee-46bf-90b3-0adeaf62116b';
const dir = process.env.HOME + '/.pi-triple/data/pi-config/' + tid;
const written = ensureTemplateAgents(dir, tid, 'local');
console.log('written:', written);
"
```
Expected: `written: true`（首次）或 `written: false`（已一致），且 `~/.pi-triple/data/pi-config/<tid>/AGENTS.md` 存在且无 `<templateId>` 残留。检查 knowledge/dev 两个模板目录同样生成。

- [ ] **Step 7: 全量回归 + 提交**

Run: `npx vitest run && npm run lint`
Expected: 全绿 + lint 通过

```bash
git add src/ptl/commands.ts src/ptl/launcher.ts test/integration/template-agents-integration.test.ts
git commit -m "feat(ptl): AGENTS.md 接入 template new + launcher 启动补写——新模板即生成，既有模板启动补写（幂等）——A2"
```

---

### Task 3: (A部分) 验证 AGENTS.md 被 pi 加载 + doctor 检查项

**Files:**
- Modify: `src/ptl/doctor.ts`（doctor 检查项）
- Modify: `src/ptl/shared-layer.ts`（如需统一补写入口，可选）
- Test: `test/unit/doctor-agents.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ensureTemplateAgents`、`AGENTS_TPL_PATH`；`runDoctorStructured`（`src/ptl/doctor.ts` 已导出）
- Produces: doctor 新增检查项 `agentsMd`（结构：`{ ok: boolean; detail?: string }`），报告模板目录 AGENTS.md 是否存在且无占位符残留

- [ ] **Step 1: 写失败测试**

```ts
// test/unit/doctor-agents.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTemplateAgentsMd } from "../../src/ptl/doctor-agents.js";

test("AGENTS.md 缺失时报告 ok=false", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptl-doctor-"));
  try {
    const r = checkTemplateAgentsMd(dir);
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AGENTS.md 残留占位符时报告 ok=false", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptl-doctor-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# 残留 <templateId>");
    const r = checkTemplateAgentsMd(dir);
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AGENTS.md 正常时报告 ok=true", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptl-doctor-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# 正常内容，无占位符");
    const r = checkTemplateAgentsMd(dir);
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/unit/doctor-agents.test.ts`
Expected: FAIL — `Cannot find module '../../src/ptl/doctor-agents.js'`

- [ ] **Step 3: 写最小实现**

```ts
// src/ptl/doctor-agents.ts
import fs from "node:fs";
import path from "node:path";

export interface AgentsMdCheck {
  ok: boolean;
  detail?: string;
}

/** 检查模板目录 AGENTS.md 存在且无占位符残留 */
export function checkTemplateAgentsMd(templateDir: string): AgentsMdCheck {
  const target = path.join(templateDir, "AGENTS.md");
  if (!fs.existsSync(target)) {
    return { ok: false, detail: "AGENTS.md 缺失（运行 ptl template new 或启动会话补写）" };
  }
  const content = fs.readFileSync(target, "utf-8");
  if (content.includes("<templateId>") || content.includes("<alias>")) {
    return { ok: false, detail: "AGENTS.md 含未渲染占位符（需重新 ensureTemplateAgents）" };
  }
  return { ok: true };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/unit/doctor-agents.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 接入 doctor.ts**

在 `runDoctorStructured` 的检查项构建处（找到现有检查项对象数组，如 extensions/skills/shared 检查），新增：

```ts
// 每个模板的 AGENTS.md 认知注入检查
import { checkTemplateAgentsMd } from "./doctor-agents.js";
// ...在模板检查循环内：
const agentsCheck = checkTemplateAgentsMd(path.join(dataDir, "pi-config", templateId));
checks.push({
  name: `AGENTS.md (${templateId.slice(0, 8)}…)`,
  ok: agentsCheck.ok,
  detail: agentsCheck.detail,
});
```

先读 `src/ptl/doctor.ts` 现有检查项结构，按相同模式插入（不要破坏现有返回结构）。

- [ ] **Step 6: 运行测试 + 手动 doctor**

Run: `npx vitest run test/unit/doctor-agents.test.ts && npx vitest run`（全量）
Expected: PASS；再运行 `npm run dev-doctor` 或 `node --import tsx src/ptl/pit.ts doctor`（以实际 doctor 命令为准）确认新检查项出现且三个模板均 ok=true。

- [ ] **Step 7: 提交**

```bash
git add src/ptl/doctor-agents.ts src/ptl/doctor.ts test/unit/doctor-agents.test.ts
git commit -m "feat(ptl): doctor 新增 AGENTS.md 认知注入检查项——缺失/占位符残留即告警——A3"
```

---

### Task 4: (B部分) SchedulingStrategy 类型 + resolver + DispatchRequest 扩展

**Files:**
- Create: `extensions/agent-lab/src/scheduler/strategy.ts`
- Modify: `extensions/agent-lab/src/scheduler/runner-types.ts:48-62`（DispatchRequest 加 strategy）
- Modify: `extensions/agent-lab/src/scheduler/contracts.ts:12`（SchedulingMode 旁加类型导出）
- Test: `extensions/agent-lab/test/strategy.test.ts`

**Interfaces:**
- Consumes: 无（纯类型 + 纯函数）
- Produces:
  - `export type SchedulingStrategy = "direct" | "weighted" | "market";`（strategy.ts）
  - `export function resolveStrategy(req: { strategy?: SchedulingStrategy; caller?: string; role: string; labels?: Record<string, string> }, cfg: { defaultStrategy?: SchedulingStrategy; weightedRoles?: string[] }): SchedulingStrategy`
  - DispatchRequest 新增可选字段 `strategy?: SchedulingStrategy;`（runner-types.ts）
  - 返回优先级：显式 strategy > labels.strategy（等价映射）> caller === "timed-trigger" → weighted > role ∈ weightedRoles → weighted > defaultStrategy（默认 "market"）

- [ ] **Step 1: 写失败测试**

```ts
// extensions/agent-lab/test/strategy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStrategy } from "../src/scheduler/strategy.ts";

const baseCfg = { defaultStrategy: "market" as const, weightedRoles: [] as string[] };

test("显式 strategy 最高优先", () => {
  assert.equal(resolveStrategy({ strategy: "direct", role: "r", caller: "timed-trigger" }, baseCfg), "direct");
  assert.equal(resolveStrategy({ strategy: "weighted", role: "r" }, baseCfg), "weighted");
  assert.equal(resolveStrategy({ strategy: "market", role: "r" }, baseCfg), "market");
});

test("labels.strategy 次优先", () => {
  const r = resolveStrategy({ role: "r", labels: { strategy: "direct" } }, baseCfg);
  assert.equal(r, "direct");
});

test("timed-trigger caller 默认 weighted", () => {
  assert.equal(resolveStrategy({ role: "r", caller: "timed-trigger" }, baseCfg), "weighted");
});

test("weightedRoles 白名单命中 → weighted", () => {
  const cfg = { defaultStrategy: "market" as const, weightedRoles: ["research", "review"] };
  assert.equal(resolveStrategy({ role: "research" }, cfg), "weighted");
  assert.equal(resolveStrategy({ role: "coding" }, cfg), "market");
});

test("兜底 defaultStrategy（默认 market）", () => {
  assert.equal(resolveStrategy({ role: "r" }, baseCfg), "market");
  const weightedDefault = { defaultStrategy: "weighted" as const, weightedRoles: [] as string[] };
  assert.equal(resolveStrategy({ role: "r" }, weightedDefault), "weighted");
});

test("无效 strategy 值回退 defaultStrategy", () => {
  // @ts-expect-error 非法值类型测试
  const r = resolveStrategy({ strategy: "bogus", role: "r" }, baseCfg);
  assert.equal(r, "market");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd extensions/agent-lab && node --test test/strategy.test.ts`
Expected: FAIL — `Cannot find module '../src/scheduler/strategy.ts'`

- [ ] **Step 3: 写最小实现**

```ts
// extensions/agent-lab/src/scheduler/strategy.ts
export type SchedulingStrategy = "direct" | "weighted" | "market";

const VALID: ReadonlySet<string> = new Set(["direct", "weighted", "market"]);

export interface StrategyRequest {
  strategy?: SchedulingStrategy;
  caller?: string;
  role: string;
  labels?: Record<string, string>;
}

export interface StrategyConfig {
  defaultStrategy?: SchedulingStrategy;
  weightedRoles?: string[];
}

/** 调度策略解析：显式 > labels > caller=timed-trigger > 白名单 > 默认 */
export function resolveStrategy(req: StrategyRequest, cfg: StrategyConfig): SchedulingStrategy {
  const explicit = req.strategy;
  if (explicit !== undefined && VALID.has(explicit)) return explicit;
  const fromLabels = req.labels?.strategy as SchedulingStrategy | undefined;
  if (fromLabels !== undefined && VALID.has(fromLabels)) return fromLabels;
  if (req.caller === "timed-trigger") return "weighted";
  if (cfg.weightedRoles?.includes(req.role)) return "weighted";
  return cfg.defaultStrategy ?? "market";
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd extensions/agent-lab && node --test test/strategy.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: DispatchRequest 扩展 + contracts 导出**

`runner-types.ts` DispatchRequest 接口加：

```ts
/** 显式调度策略（缺省走 resolveStrategy 自动路由） */
strategy?: SchedulingStrategy;
```

并在文件顶部（或从 strategy.ts）引入类型。`contracts.ts` 在 `SchedulingMode` 定义旁加：

```ts
export type { SchedulingStrategy } from "./strategy.ts";
```

检查 runner-types.ts 是否可直接 import 自 strategy.ts（同目录，`import type { SchedulingStrategy } from "./strategy.js"`，注意 .ts 源码用 .js 扩展）。

- [ ] **Step 6: 运行既有测试确认无回归**

Run: `cd extensions/agent-lab && node --test test/scheduler-runner.test.ts test/strategy.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add extensions/agent-lab/src/scheduler/strategy.ts extensions/agent-lab/src/scheduler/runner-types.ts extensions/agent-lab/src/scheduler/contracts.ts extensions/agent-lab/test/strategy.test.ts
git commit -m "feat(agent-lab): SchedulingStrategy 三模式+解析器——显式/labels/timed-trigger/白名单/默认五级路由——B1"
```

---

### Task 5: (B部分) runner 集成 strategy + 事件透传

**Files:**
- Modify: `extensions/agent-lab/src/scheduler/runner.ts:151-180`（dispatch 开头解构 + 解析 strategy）
- Modify: `extensions/agent-lab/src/scheduler/runner.ts`（scheduling.requested 事件加 strategy 字段；dispatchToInstance 签名透传 strategy 到 SchedulingInput）
- Modify: `extensions/agent-lab/src/scheduler/contracts.ts`（SchedulingInput 加 strategy?）
- Test: `extensions/agent-lab/test/scheduler-runner.test.ts`（追加用例）或新增 `strategy-dispatch.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `resolveStrategy`、`SchedulingStrategy`；runner 现有 `this.core.repository` 获取调度器配置
- Produces: `dispatch()` 在 resolveRoute 前解析 strategy 并注入事件与 SchedulingInput；调度器实现可在 `input.strategy` 读到

- [ ] **Step 1: 写失败测试（dispatch 透传 strategy）**

在 `extensions/agent-lab/test/scheduler-runner.test.ts` 追加（或新文件 strategy-dispatch.test.ts，复用该文件已有 helper 创建 runner）：

```ts
test("dispatch 解析 strategy 并写入 scheduling.requested 事件", async () => {
  // 构造 runner（复用 scheduler-runner.test.ts 的 testContext/helper 模式）
  // dispatch({ role: "r", task: "t", strategy: "direct", caller: "cli" })
  // → 断言事件流含 scheduling.requested 且 payload.strategy === "direct"
});
```

先读 `scheduler-runner.test.ts` 现有 helper（memoryDB/testContext/schedulerDef + 创建 runner 的方式），按同模式写。若现有 runner 构造复杂，改在 `strategy-dispatch.test.ts` 里用最小 stub 验证：monkey-patch `resolveStrategy` 返回固定值 + spy 事件收集。

- [ ] **Step 2: 运行测试验证失败**

Run: `cd extensions/agent-lab && node --test test/strategy-dispatch.test.ts`
Expected: FAIL — 事件 payload 无 strategy 字段或测试断言失败

- [ ] **Step 3: 实现 runner 集成**

`dispatch()` 开头解构后、`scheduling.requested` 事件前：

```ts
import { resolveStrategy, type SchedulingStrategy } from "./strategy.js";
// ...在解构处：
const strategy = resolveStrategy({ strategy: request.strategy, caller, role, labels }, {
  defaultStrategy: this.defaultStrategy,           // 构造时传入或从 config 读
  weightedRoles: this.weightedRoles,
});
```

`scheduling.requested` 事件 payload 加 `strategy`。`dispatchToInstance` 调用 `impl.schedule` 的 SchedulingInput 加 `strategy`（contracts.ts SchedulingInput 接口加 `strategy?: SchedulingStrategy`）。

runner 构造/配置来源：读 runner 现有构造参数（`SchedulerRunner` 类），优先从 `this.core` 的 scheduler 配置（LabConfig.scheduler）读取 defaultStrategy/weightedRoles，缺省 fallback 默认值。若现有架构不易取配置，用构造参数注入（保持向后兼容默认值）。

- [ ] **Step 4: 运行测试验证通过**

Run: `cd extensions/agent-lab && node --test test/strategy-dispatch.test.ts test/scheduler-runner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extensions/agent-lab/src/scheduler/runner.ts extensions/agent-lab/src/scheduler/contracts.ts extensions/agent-lab/test/strategy-dispatch.test.ts
git commit -m "feat(agent-lab): dispatch 集成 strategy 解析——scheduling.requested 事件携带策略，SchedulingInput 透传——B2"
```

---

### Task 6: (B部分) direct/weighted/market 三策略执行路径

**Files:**
- Modify: `extensions/agent-lab/src/scheduler/runner.ts`（strategy === "direct" 时构造 direct SchedulingResult；strategy 影响 instance 选择）
- Modify: `extensions/agent-lab/src/schedulers/arena-definition.ts`（参数模型加 execution.timeoutMs，可选）
- Test: `extensions/agent-lab/test/strategy-execution.test.ts`

**Interfaces:**
- Consumes: Task 4/5；`DispatchRequest.agentId?: string`（direct 模式指定 agent，B 部分 spec B2 的 `--agent`）
- Produces: direct 模式：`strategy === "direct"` 时 runner 用 `request.agentId` 直接构造 `SchedulingResult { status: "completed", selectedAgentId }` 并走现有 completed 处理（事件/结算透传），**不调用 impl.schedule**（绕过 bidding）；weighted/market 保持现状（由 resolver 选到的 scheduler instance 决定）

- [ ] **Step 1: 写失败测试**

```ts
// extensions/agent-lab/test/strategy-execution.test.ts
// direct 模式：dispatch({ strategy: "direct", agentId: "agent-x" }) → 返回 completed 且 selectedAgentId === "agent-x"，且无 bidding 相关事件（无 scheduling.requested 之外的 market 事件）
// 使用 scheduler-runner.test.ts 的 runner 构造 helper
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd extensions/agent-lab && node --test test/strategy-execution.test.ts`
Expected: FAIL — direct 策略未处理（走到正常 dispatch → 无 routing binding → failed）

- [ ] **Step 3: 实现 direct 短路**

在 `dispatch()` 的 resolveRoute 之前插入：

```ts
if (strategy === "direct") {
  const agentId = request.agentId;
  if (!agentId) {
    return { status: "failed", error: { standard: { code: "scheduler-error", message: "strategy=direct 需要 agentId", retryable: false } }, attempts: [] };
  }
  // 发 scheduling.requested（含 strategy）+ scheduler.agent.selected + scheduler.completed
  // selectedAgentId = agentId，reason = "direct assignment"
  // 不调用任何 scheduler impl（无 bidding）
  return { status: "completed", schedulerInstanceId: "<direct>", selectedAgentId: agentId, attempts: [...] };
}
```

注意与 dispatchToInstance 的 completed 处理对齐（事件顺序 + pendingSettlement 处理）。为保持事件一致性，可将 direct 结果走 `dispatchToInstance` 的"处理 completed"逻辑——实现时优先复用，避免事件流分叉。先读 dispatchToInstance 完整结构，把 direct 作为其前置分支。

- [ ] **Step 4: 运行测试验证通过**

Run: `cd extensions/agent-lab && node --test test/strategy-execution.test.ts test/scheduler-runner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extensions/agent-lab/src/scheduler/runner.ts extensions/agent-lab/test/strategy-execution.test.ts
git commit -m "feat(agent-lab): direct 策略短路——指定 agentId 直通执行，绕过竞价——B3"
```

---

### Task 7: (B部分) winner 执行墙钟超时 + 命令入口 + 配置

**Files:**
- Modify: `extensions/agent-lab/src/scheduler/runner-sdk.ts:119-160`（agents.run 包 Promise.race 超时）
- Modify: `extensions/agent-lab/src/config.ts`（DEFAULT_MARKET_CONFIG 加 execution.timeoutMs）
- Modify: `extensions/agent-lab/src/types.ts`（MarketConfig 加 execution）
- Modify: `extensions/agent-lab/src/schedulers/arena-definition.ts`（参数模型 + 校验 + TUNABLE_PATHS 加 execution.timeoutMs）
- Modify: `extensions/agent-lab/src/commands/register.ts`（`/lab scheduler dispatch` 子命令）
- Modify: `extensions/agent-lab/src/interceptor/scheduler-bridge.ts`（SchedulerRuntimeLike 若需暴露 dispatch 入口）
- Test: `extensions/agent-lab/test/execution-timeout.test.ts` + `test/scheduler-command.test.ts`（若存在命令测试范式）

**Interfaces:**
- Consumes: Task 4-6；`AgentRunRequest.timeoutMs`（contracts 已有字段，runner-sdk 的 runReq 已透传）
- Produces: `agents.run` 带墙钟超时（默认 `DEFAULT_MARKET_CONFIG.execution.timeoutMs = 300_000`，5 分钟）；超时 → `{ status: "failed", error: { code: "execution-timeout", retryable: true } }`；`/lab scheduler dispatch <role> <task> --strategy <s> [--agent <id>]` 命令

- [ ] **Step 1: 写失败测试（超时）**

```ts
// extensions/agent-lab/test/execution-timeout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../src/scheduler/with-timeout.ts";

test("正常完成不触发超时", async () => {
  const r = await withTimeout(Promise.resolve("ok"), 1000);
  assert.equal(r, "ok");
});

test("超时返回 failed", async () => {
  const r = await withTimeout(new Promise(() => {}), 50);
  assert.equal(r.status, "failed");
  assert.equal(r.error.code, "execution-timeout");
  assert.equal(r.error.retryable, true);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd extensions/agent-lab && node --test test/execution-timeout.test.ts`
Expected: FAIL — `Cannot find module '../src/scheduler/with-timeout.ts'`

- [ ] **Step 3: 写 withTimeout 实现**

```ts
// extensions/agent-lab/src/scheduler/with-timeout.ts
export interface TimeoutFailure {
  status: "failed";
  error: { code: "execution-timeout"; message: string; retryable: true };
}

/** 墙钟超时封装：超时返回 TimeoutFailure，不抛异常 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | TimeoutFailure> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TimeoutFailure>((resolve) => {
        timer = setTimeout(() => {
          resolve({ status: "failed", error: { code: "execution-timeout", message: `execution timed out after ${timeoutMs}ms`, retryable: true } });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: runner-sdk agents.run 接入超时**

在 `run: async (agentId, runReq)` 里，`const result = await wlRunner.run(wlRequest)` 改为：

```ts
const timeoutMs = runReq.timeoutMs ?? 300_000;   // 默认 5 分钟（DEFAULT_MARKET_CONFIG.execution.timeoutMs）
const resultOrTimeout = await withTimeout(wlRunner.run(wlRequest), timeoutMs);
if (resultOrTimeout && "status" in resultOrTimeout && resultOrTimeout.status === "failed" && "error" in resultOrTimeout && resultOrTimeout.error.code === "execution-timeout") {
  signal?.abort?.();  // 尽力取消底层 workloop
  return resultOrTimeout as unknown as AgentRunResult;
}
const result = resultOrTimeout as Awaited<ReturnType<typeof wlRunner.run>>;
```

- [ ] **Step 5: 配置贯通（config.ts + types.ts + arena-definition.ts）**

`types.ts` MarketConfig 加 `execution: { timeoutMs: number }`；`config.ts` DEFAULT_MARKET_CONFIG 加 `execution: { timeoutMs: 300_000 }`；`arena-definition.ts` ArenaSchedulerParameters 加 `execution: { timeoutMs: number }`（默认 300_000），校验器加类型检查，TUNABLE_PATHS 加 `"execution.timeoutMs"`。runner-sdk 超时默认值从配置读取（若 sdk 构造时可拿配置，否则保留常量 + 注释指向配置）。

- [ ] **Step 6: `/lab scheduler dispatch` 命令**

`register.ts` scheduler 命令组加 `sub === "dispatch"`：

```ts
} else if (sub === "dispatch") {
  const role = argv[2];
  const task = argv.slice(3).find((a) => !a.startsWith("--")) ?? "";
  const strategyIdx = argv.indexOf("--strategy");
  const strategy = strategyIdx >= 0 ? argv[strategyIdx + 1] : undefined;
  const agentIdx = argv.indexOf("--agent");
  const agentId = agentIdx >= 0 ? argv[agentIdx + 1] : undefined;
  if (!role || !task) { ctx.ui.notify("用法: /lab scheduler dispatch <role> <task> --strategy direct|weighted|market [--agent <id>]", "error"); return; }
  if (strategy === "direct" && !agentId) { ctx.ui.notify("strategy=direct 需要 --agent <id>", "error"); return; }
  const rt = schedulerRuntime?.();
  if (!rt) { ctx.ui.notify("Scheduler runtime unavailable — enable with /lab config scheduler.enabled true", "error"); return; }
  const result = await rt.dispatch({
    traceId: `cmd-dispatch-${Date.now()}`,
    role, task,
    strategy: strategy as never,   // cast to SchedulingStrategy
    agentId,
    mode: "execute",
  });
  ctx.ui.notify(renderSchedulerDispatch(result), "info");
}
```

同时 `SchedulerRuntimeLike.dispatch` 签名加 `strategy?`/`agentId?`（scheduler-bridge.ts）。`renderSchedulerDispatch` 加到 render-scheduler.ts（简单文本：状态 + selectedAgentId + reason/error）。

- [ ] **Step 7: 测试 + 回归 + 提交**

Run: `cd extensions/agent-lab && node --test test/execution-timeout.test.ts && node --test test/`（全量 agent-lab 测试）
Expected: PASS；然后仓库根 `npx vitest run && npm run lint` 全绿

```bash
git add extensions/agent-lab/src/scheduler/with-timeout.ts extensions/agent-lab/src/scheduler/runner-sdk.ts extensions/agent-lab/src/config.ts extensions/agent-lab/src/types.ts extensions/agent-lab/src/schedulers/arena-definition.ts extensions/agent-lab/src/commands/register.ts extensions/agent-lab/src/interceptor/scheduler-bridge.ts extensions/agent-lab/test/execution-timeout.test.ts
git commit -m "feat(agent-lab): winner 墙钟超时+dispatch 命令+execution 配置——agents.run 默认 5 分钟超时（可配），/lab scheduler dispatch --strategy 显式指定模式——B4"
```

---

## 任务依赖图

```text
A1 → A2 → A3        （PTL 认知注入，互不依赖 B 部分）
B1 → B2 → B3        （策略类型→runner 集成→direct 短路）
B3 → B4             （命令入口依赖策略执行路径就绪）
A 与 B 完全正交，可并行
```

## Self-Review 记录

- **Spec 覆盖**：A 部分 spec §A1（AGENTS.md.tpl）→ Task 1；§A2（渲染接入）→ Task 2；§A3（验证加载/doctor）→ Task 3。B 部分 spec §B1（枚举）→ Task 4；§B2（显式指定）→ Task 4+7 命令；§B3（resolver）→ Task 4；§B4（超时）→ Task 7；§B5（阻塞预期）→ Task 6+7；§B6（测试）→ 各任务内嵌。
- **Placeholder 扫描**：无 TBD/TODO；测试代码全部给出（strategy-dispatch 与 strategy-execution 的测试需要读既有 helper 按模式写，已明确指示——这是既有代码复用，非占位）。
- **类型一致性**：`SchedulingStrategy` 在 B1 定义、B2/B4 引用，命名统一；`withTimeout` 在 B4 定义与使用同任务；`ensureTemplateAgents` A1 定义、A2/A3 引用；`DispatchRequest.strategy/agentId` B1 加字段、B4 命令使用。
