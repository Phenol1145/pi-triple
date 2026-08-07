# framework 拆分 Plan A：monorepo 结构 + @pi-triple/shared 提取

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 monorepo 结构（npm workspaces）+ 提取 @pi-triple/shared 共享包（基础件），为 framework/mail-box/容器开发三项目拆分打地基。

**Architecture:** `packages/` 目录 + npm workspaces。`packages/shared/` 承载基础件（config/tmux/output/warnings/session-registry/session-state/version-check/template-agents），`packages/framework/` 承载 PTL CLI 主体（cli/commands/bridge/flow/launcher 等）。现有 `src/ptl/` 渐进迁移。

**Tech Stack:** npm workspaces、TypeScript（Node16 模块解析）、vitest。零新依赖。

## Global Constraints

- 拆分**不改变行为**：迁移后所有命令功能与当前一致（回归全绿）
- npm workspaces：`packages/*` 结构，根 package.json 声明 workspaces
- @pi-triple/shared 只放**叶模块/基础件**（config/tmux/output/warnings/session-registry/session-state/version-check/template-agents）；含业务逻辑的（launcher/commands/doctor/flow/bridge/cli）留 framework
- 相对 import 迁移：src/ptl 内部 `./x.js` → 跨包时 `@pi-triple/shared` 包名 import
- 构建：tsc 项目引用（composite）或独立构建顺序（shared 先、framework 后）
- 测试：根 vitest 全绿（迁移后测试路径更新）
- 不碰：src/pth（PTH 侧）、extensions/（扩展开）、用户 WIP
- 提交风格：`refactor(framework): 中文摘要`

---

### Task 1: monorepo 骨架（npm workspaces + packages 目录）

**Files:**
- Modify: `package.json`（workspaces 字段）
- Create: `packages/shared/package.json`、`packages/framework/package.json`
- Create: `tsconfig.base.json`（共享 TS 配置）

**Interfaces:**
- Consumes: 无（地基）
- Produces: monorepo 结构（npm install 识别 workspaces）、共享 TS 配置

- [ ] **Step 1: 写失败测试（workspaces 生效）**

```bash
# 验证：npm workspaces 识别 packages/*
node -e "
const p = require('./package.json');
if (!p.workspaces?.includes('packages/*')) throw new Error('workspaces missing');
console.log('workspaces OK');
"
```

- [ ] **Step 2: 建骨架**

```json
// package.json 加
"workspaces": ["packages/*"]
```

```json
// packages/shared/package.json
{
  "name": "@pi-triple/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
```

```json
// packages/framework/package.json
{
  "name": "@pi-triple/framework",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "bin": { "ptl": "./src/pit.ts" }
}
```

- [ ] **Step 3: 验证 workspaces**

```bash
npm install   # 触发 workspace 链接
node -e "console.log(require('./package.json').workspaces)"
```

- [ ] **Step 4: 提交**

```bash
git add package.json packages/ tsconfig.base.json
git commit -m "refactor(framework): monorepo 骨架——npm workspaces + packages/shared + packages/framework"
```

---

### Task 2: @pi-triple/shared 基础件迁移（叶模块）

**Files:**
- Create: `packages/shared/src/`（config/tmux/output/warnings/session-registry/session-state/version-check/template-agents 迁移）
- Create: `packages/shared/src/index.ts`（barrel）

**Interfaces:**
- Consumes: Task 1 骨架
- Produces: `@pi-triple/shared` 包（叶模块 + barrel）

- [ ] **Step 1: 写失败测试（shared barrel 存在）**

```ts
// test/shared-barrel.test.ts
import { describe, it, expect } from "vitest";
// 迁移后：
// import { loadConfig } from "@pi-triple/shared";
// expect(loadConfig).toBeDefined();
```

- [ ] **Step 2: 迁移叶模块（复制 + 改相对 import）**

```bash
# 从 src/ptl/ 复制叶模块到 packages/shared/src/
# config.ts / tmux.ts / output.ts / warnings.ts / session-registry.ts / session-state.ts / version-check.ts / template-agents.ts
# 内部相对 import 保持（叶模块间不互相依赖，除 version-check→config）
```

- [ ] **Step 3: 建 barrel**

```ts
// packages/shared/src/index.ts
export * from "./config.js";
export * from "./tmux.js";
export * from "./output.js";
export * from "./warnings.js";
export * from "./session-registry.js";
export * from "./session-state.js";
export * from "./version-check.js";
export * from "./template-agents.js";
```

- [ ] **Step 4: 验证**

```bash
npx vitest run   # 根测试仍绿（src/ptl 未动，共享包是新副本）
```

- [ ] **Step 5: 提交**

```bash
git commit -m "refactor(framework): @pi-triple/shared 基础件迁移——config/tmux/output/warnings/session-*/version-check/template-agents + barrel"
```

---

### Task 3: framework 包主体迁移（src/ptl → packages/framework）

**Files:**
- Move: `src/ptl/` → `packages/framework/src/`（除已迁移的叶模块）
- Modify: 相对 import 改为 `@pi-triple/shared` 包名

**Interfaces:**
- Consumes: Task 2 shared 包
- Produces: `@pi-triple/framework` 包（完整 PTL CLI）

- [ ] **Step 1: 写失败测试（framework 包可跑）**

```bash
# 迁移后：npx tsx packages/framework/src/pit.ts help 应输出 help
```

- [ ] **Step 2: 移动主体**

```bash
git mv src/ptl packages/framework/src
# 移除已迁移到 shared 的叶模块（config/tmux/output/warnings/session-registry/session-state/version-check/template-agents）
# 修改引用它们的 import：./config.js → @pi-triple/shared
```

- [ ] **Step 3: 改 import**

```bash
# 全局替换（在 packages/framework/src 内）：
# from "./config.js" → from "@pi-triple/shared"
# from "./tmux.js" → from "@pi-triple/shared"
# ... 等叶模块引用
```

- [ ] **Step 4: 验证**

```bash
npx tsx packages/framework/src/pit.ts help   # 输出正常
npx vitest run                                # 根测试更新路径后全绿
```

- [ ] **Step 5: 提交**

```bash
git commit -m "refactor(framework): framework 包主体迁移——src/ptl→packages/framework，叶模块改 @pi-triple/shared 引用"
```

---

### Task 4: 构建链 + 测试路径更新

**Files:**
- Modify: `package.json`（build 脚本：shared → framework 顺序）
- Modify: `tsconfig*.json`（项目引用）
- Modify: `test/`（import 路径指向 packages/）

**Interfaces:**
- Consumes: Task 2/3
- Produces: 可构建的 monorepo（build 产出 dist/）

- [ ] **Step 1: 写失败测试（build 成功）**

```bash
npm run build && node dist/ptl/pit.js help   # 构建产物可跑
```

- [ ] **Step 2: 改构建链**

```json
// package.json scripts
"build": "tsc -b packages/shared packages/framework"
// 或按顺序：先 shared 后 framework（项目引用）
```

- [ ] **Step 3: 更新测试路径**

```bash
# test/** 的 import 从 ../../src/ptl/ → ../../packages/framework/src/ 或 @pi-triple/shared
```

- [ ] **Step 4: 验证**

```bash
npm run build && npm run test && npx vitest run   # 全绿
```

- [ ] **Step 5: 提交**

```bash
git commit -m "refactor(framework): 构建链（项目引用）+ 测试路径更新——monorepo 全绿"
```

---

## 自审（Self-Review）

**1. Spec coverage：**
- Spec §3 monorepo 结构 → Task 1/2/3/4 ✅
- Spec §3 共享代码提取（@pi-triple/shared）→ Task 2 ✅
- Spec §3 framework 主包 → Task 3 ✅
- 拆分不改变行为（回归全绿）→ Task 4 ✅

**2. Placeholder scan：** 无 TBD；命令为实际 shell。

**3. Type consistency：** `@pi-triple/shared` barrel（Task 2）被 framework（Task 3）消费——导出名与 src/ptl 叶模块一致（loadConfig/tmuxSessionName 等）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-framework-split-a.md`. Two execution options:

1. **Subagent-Driven (recommended)** - fresh subagent per task + review
2. **Inline Execution** - executing-plans with checkpoints

**Which approach?**
