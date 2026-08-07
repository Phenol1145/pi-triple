# PTH 装配层 + PTL CLI 更名（pit → ptl）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① PTL CLI 由 `ptl` 更名 `ptl`（bin/目录/引用/tmux 前缀/docs）；② PTH 装配层：main.ts 启动 BatchManager + pg + watchdog；③ `/pth` 命令注册（batch 命令族）；④ BatchManager↔batch-process 生产组合验证；⑤ GitHub 发布准备。

**Architecture:** 改名是机械重构（bin 名 + src/ptl/cli/ 目录 → src/ptl/cli/ + 引用 + tmux 前缀）；装配层在 src/pth/main.ts 与 src/pth/kernel/ 之间接线（BatchManager 生命周期 + /pth 命令 + pg 连接池共享）。

**Tech Stack:** node:child_process（fork）、pg（既有）、node:fs。零新依赖。

## Global Constraints

- 更名范围：`ptl` → `ptl`（bin 名/命令名/目录名/注释/tmux 前缀 `ptl-` → `ptl-`/docs）；**不破坏**正在运行的 tmux 会话（旧 `ptl-` 前缀会话保留，新会话用 `ptl-`）
- 命令前缀：PTH 侧 `/pth`（弃用 `/lab`——agent-lab 旧命令保留不删）
- 依赖限制：零新增运行时依赖
- 测试：改名后全套回归（根 vitest + agent-lab node:test）
- 发布：GitHub 源码 + 制品（npm pack 或构建产物）
- 提交风格：`refactor(ptl): 中文摘要` / `feat(pth): 中文摘要`

---

### Task 1: PTL CLI 更名 pit → ptl

**Files:**
- Modify: `package.json`（bin: "pit" → "ptl"）
- Rename: `src/ptl/cli/` → `src/ptl/cli/`（10 文件）
- Modify: `src/ptl/pit.ts`（入口引用）
- Modify: `src/ptl/tmux.ts`（会话前缀 `ptl-` → `ptl-`）
- Modify: src/ptl/ 下所有引用 `ptl` 的文件（约 34 个）
- Modify: docs/ 下引用 `ptl` 的文档（约 28 个）
- Test: 根 vitest 全套 + agent-lab 套件

**Interfaces:**
- Consumes: 无（机械改名）
- Produces: `ptl` bin 名、`src/ptl/cli/` 目录、`ptl-` tmux 前缀

- [ ] **Step 1: 写失败测试（bin 名存在性）**

```bash
# 测试：package.json bin 有 ptl
node -e "const p = require('./package.json'); if (!p.bin?.ptl) throw new Error('bin.ptl missing'); if (p.bin.pit) throw new Error('bin.ptl should be removed'); console.log('OK')"
```

- [ ] **Step 2: 改名目录 + bin**

```bash
git mv src/ptl/ptl src/ptl/cli
# package.json: "pit": "./dist/ptl/pit.js" → "ptl": "./dist/ptl/pit.js"（保留输出路径，bin 键名改）
# 注：dist 输出路径不变（tsc outDir 结构），只改 bin 键名
```

- [ ] **Step 3: 更新引用**

```bash
# src/ptl/ 内引用 "pit" 的（命令名/注释/字符串）改为 "ptl"
# 注意区分：命令名 pit → ptl；tmux 前缀 ptl- → ptl-；ptl-flow 概念名保留（flow 子命令）
grep -rn '"pit"\|`ptl \|ptl-' src/ptl/ --include="*.ts" | grep -v node_modules
```

- [ ] **Step 4: 更新 docs**

```bash
# docs/ 下 pit 命令引用 → ptl（保留历史描述/架构文档中的产品名 Pi-Triple-Lite 说明）
```

- [ ] **Step 5: 回归验证 + 提交**

```bash
npm run build && npx vitest run && cd extensions/agent-lab && node --experimental-strip-types --test test/*.test.ts
git commit -m "refactor(ptl): PTL CLI 更名 pit→ptl——bin/ptl 目录 src/ptl/cli/tmux 前缀 ptl-/docs 引用，旧名兼容提示"
```

**注意**：tmux 旧会话（`ptl-` 前缀）不迁移（正在运行）；新会话用 `ptl-`。`ptl-flow` 概念名（flow 子命令）保留。

---

### Task 2: PTH 装配（main.ts 启动 BatchManager + pg + watchdog）

**Files:**
- Modify: `src/pth/main.ts`（装配点：pg 连接池 + BatchManager + watchdog）
- Create: `src/pth/kernel/assembly.ts`（装配辅助：createKernelRuntime）
- Test: `test/pth-kernel-assembly/assembly.test.ts`（真实 pg 装配冒烟）

**Interfaces:**
- Consumes: `createPgPool`/`applySchema`/`createDataWorld`（Spec C）、`BatchManager`（Spec B）、`createWorkerKernel`（Spec A）
- Produces: `createKernelRuntime(deps)`——统一装配（pg 池 + dataWorld + batchManager）；`BatchManager` 实例挂到 PTH 生命周期

- [ ] **Step 1: 写失败测试**

```ts
// test/pth-kernel-assembly/assembly.test.ts
// 真实 pg（testcontainers）+ 装配冒烟：createKernelRuntime → dataWorld 可用 → BatchManager 存在
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-assembly/assembly.test.ts`

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/assembly.ts
// createKernelRuntime({ databaseUrl, basePath, artifactPath }):
//   pool = createPgPool → applySchema → dataWorld = createDataWorld(pool)
//   batchMgr = new BatchManager({ batchProcessPath, workers: DEFAULT_ROLES.map(r=>r.id) })
//   返回 { pool, dataWorld, batchMgr }
```

- [ ] **Step 4: 验证通过 + main.ts 接线**

```ts
// main.ts: 装配 createKernelRuntime + watchdog（batch 崩溃记录，不自动重启 v1）
```

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(pth): PTH 装配层——createKernelRuntime（pg+dataWorld+BatchManager）+ main.ts 接线 + watchdog"
```

---

### Task 3: /pth 命令注册（batch 命令族）

**Files:**
- Create: `src/pth/kernel/commands.ts`（/pth 命令处理）
- Test: `test/pth-kernel-assembly/commands.test.ts`

**Interfaces:**
- Consumes: `BatchManager`（Task 2）、`stats.collectStats`/`suggest`（Spec B）
- Produces: `/pth batch add|remove|status|suggest|stats` 命令处理函数

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 写实现**

```ts
// /pth batch add [n] → batchMgr.spawnBatch() ×n
// /pth batch remove [n] → batchMgr.killBatch() ×n
// /pth batch status → batchMgr.listBatches() 格式化
// /pth batch suggest → collectStats + suggest（真实接线，替换占位）
// /pth batch stats → collectStats 原始数据
```

- [ ] **Step 4: 验证通过 + 注册到 PTH 会话**
- [ ] **Step 5: 提交**

```bash
git commit -m "feat(pth): /pth batch 命令族——add/remove/status/suggest/stats，collectStats 真实接线"
```

---

### Task 4: BatchManager ↔ batch-process 生产组合验证

**Files:**
- Modify: `test/pth-kernel-execution/batch-process.integration.test.ts`（或新增组合测试）
- Modify: `package.json`（engines.node 固化 ≥22.6——transform-types 依赖）

**Interfaces:**
- Consumes: `BatchManager`（Spec B）、`runBatchProcess`（Spec B）
- Produces: 生产 fork 路径验证（BatchManager 直接 fork batch-process.ts 端到端）

- [ ] **Step 1: 写失败测试（BatchManager 组合）**

```ts
// 真实 pg：BatchManager.spawnBatch() 直接 fork batch-process.ts
// → publish 任务 → 轮询 → completed
// 验证：BatchManager 的 spawnBatch（含 execArgv transform-types + PTH_BATCH_PROCESS=1 env）能跑真实 TS 入口
```

- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 修 BatchManager（execArgv/env 透传）+ engines 固化**

```ts
// batch-manager.ts: spawnBatch 支持传入 execArgv（--experimental-transform-types）与 env（PTH_BATCH_PROCESS=1、DATABASE_URL）
// package.json: "engines": { "node": ">=22.6" }
```

- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

```bash
git commit -m "fix(pth): BatchManager 生产 fork 路径——execArgv transform-types + env 透传 + engines 固化 >=22.6"
```

---

### Task 5: GitHub 发布准备

**Files:**
- Create: `RELEASING.md`（发布流程：build → pack → GitHub Release）
- Create: `.github/workflows/release.yml`（可选：CI 发布）
- Modify: `package.json`（version/files/prepublishOnly）

**Interfaces:**
- Consumes: 全部交付
- Produces: GitHub 源码 + 制品（npm pack tarball + 构建产物）

- [ ] **Step 1: 写 RELEASING.md**
- [ ] **Step 2: 检查 package.json（files 白名单/prepublishOnly build/version）**
- [ ] **Step 3: 构建 + 打包验证**

```bash
npm run build && npm pack --dry-run   # 确认制品内容（dist/ + docs/ + package.json）
```

- [ ] **Step 4: 提交**

```bash
git commit -m "chore(release): 发布准备——RELEASING.md + files 白名单 + 打包验证"
```

---

## 自审（Self-Review）

**1. Spec coverage：**
- 用户指示"处理改名"→ Task 1（pit→ptl）✅
- 用户指示"整理 ptl"→ Task 1 的目录整理 + 引用清理 ✅
- 用户指示"发布 github"→ Task 5 ✅
- 装配层（kernel 三件套接线）→ Task 2/3/4 ✅

**2. Placeholder scan：** 无 TBD；测试代码为骨架（实施时逐字展开）。

**3. Type consistency：** BatchManager（Spec B）在 Task 2/3/4 消费——签名一致；createKernelRuntime（Task 2）是装配层新接口。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-pth-assembly-and-rename.md`. Two execution options:

1. **Subagent-Driven (recommended)** - fresh subagent per task + review
2. **Inline Execution** - executing-plans with checkpoints

**Which approach?**
