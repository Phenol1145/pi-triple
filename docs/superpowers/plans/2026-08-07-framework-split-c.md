# framework 拆分 Plan C：mail-box 独立化 + 容器开发扩展

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① pit-communicate 独立化为 @pi-triple/mailbox（改名 /pit → /mail，迁入 monorepo）；② 容器开发扩展（skill 文档 + extensions-in-container 扩展）。

**Architecture:** `packages/mailbox/`（pit-communicate 迁移 + 改名）+ `packages/extensions-in-container/`（dev 容器扩展）+ `docs/` 容器开发 skill。

**Tech Stack:** node:fs/promises（mailbox 文件邮箱）、pi 扩展机制（registerCommand）、Docker（dev 容器）。零新依赖。

## Global Constraints

- mail-box：pit-communicate 完整迁移（mailbox/protocol/delivery/audit/watcher/update-hint + /pit 命令改 /mail），**逻辑零改动**（只改名/迁移）
- mail-box 依赖 `_shared/`（presence/registry）——迁入 monorepo 后 _shared 如何处理需裁决（迁 packages/shared？或随包复制？）
- 容器开发：skill 文档（docs/container-dev-skill.md——如何在容器里做扩展开发）+ extensions-in-container 扩展（dev 容器配置/启动/挂载工具）
- 容器扩展不碰：Dockerfile.dev 本身（用户 WIP 相关？确认）、sandbox
- 两项都在 monorepo 内（packages/*），注册到 workspaces
- 零新依赖；提交风格 feat(mailbox): / feat(container): 中文摘要

---

### Task 1: mail-box 迁移（extensions/pit-communicate → packages/mailbox）

**Files:**
- Rename: `extensions/pit-communicate/` → `packages/mailbox/`
- Modify: `packages/mailbox/package.json`（name: @pi-triple/mailbox）
- Modify: 内部注释/字符串（pit-communicate → mailbox，/pit → /mail）
- Modify: `_shared/` 依赖处理（presence/registry——迁 packages/shared 或随包复制）

**Interfaces:**
- Consumes: `_shared/presence.js`、`_shared/registry.js`（现状依赖）
- Produces: `@pi-triple/mailbox` 包（/mail 命令，mailbox/protocol/delivery/audit 模块）

- [ ] **Step 1: 写失败测试（mailbox 包可导入）**

```ts
// test/mailbox.test.ts
import { describe, it, expect } from "vitest";
// 迁移后：import { Mailbox } from "@pi-triple/mailbox";
// expect(Mailbox).toBeDefined();
```

- [ ] **Step 2: 迁移 + 改名**

```bash
git mv extensions/pit-communicate packages/mailbox
# package.json: name pit-communicate → @pi-triple/mailbox
# index.ts: /pit → /mail（registerCommand("mail", ...)）
# 注释/字符串: pit-communicate → mailbox
```

- [ ] **Step 3: _shared 依赖处理**

```bash
# 现状：../_shared/presence.js + registry.js（extensions/_shared/）
# 方案：presence/registry 迁 packages/shared/src/（@pi-triple/shared）→ mailbox import @pi-triple/shared
# 或：随包复制到 packages/mailbox/_shared/（简单但重复）
# 裁决：优先迁 @pi-triple/shared（与 Plan A 的 shared 包一致）
```

- [ ] **Step 4: 验证**

```bash
npx vitest run test/mailbox.test.ts   # mailbox 包可导入
# 全量回归（pit-communicate 的既有测试——test/unit/intercom.test.ts 等更新路径）
```

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(mailbox): pit-communicate 独立化——迁 packages/mailbox + 改名 @pi-triple/mailbox + /pit 改 /mail + _shared 迁 shared 包"
```

---

### Task 2: mail-box 测试迁移 + 命令验证

**Files:**
- Modify: `test/unit/intercom.test.ts` 等（pit-communicate 测试 → @pi-triple/mailbox 路径 + /mail 命令断言）
- Create: `test/mailbox-command.test.ts`（/mail 命令注册验证）

**Interfaces:**
- Consumes: Task 1
- Produces: mailbox 全套测试绿（改名后）

- [ ] **Step 1: 写失败测试（intercom.test.ts 更新路径后）**

```bash
# 更新 import：extensions/pit-communicate/ → @pi-triple/mailbox（或 packages/mailbox/src/）
# 更新断言：/pit → /mail
```

- [ ] **Step 2: 跑测试验证失败**（旧路径失效）
- [ ] **Step 3: 更新测试**
- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

```bash
git commit -m "feat(mailbox): 测试迁移——intercom 等测试改 @pi-triple/mailbox + /mail 命令断言"
```

---

### Task 3: 容器开发 skill 文档

**Files:**
- Create: `docs/container-dev-skill.md`（通用 skill——如何在容器里做扩展开发）

**Interfaces:**
- Consumes: 现状 dev 容器（Dockerfile.dev + tools/dev/）
- Produces: 容器开发方法论文档（环境/工具链/流程/最佳实践）

- [ ] **Step 1: 写文档（内容要点）**

```markdown
# 容器开发 skill——在容器中开发扩展后端
## 1. 容器环境（Dockerfile.dev 现状 + tools/dev/）
## 2. 工具链（node/conda/bfc 等已装工具）
## 3. 开发流程（挂载仓库 → 改代码 → 容器内验证 → 导出）
## 4. 扩展开发模式（extensions-in-container：扩展跑容器里）
## 5. 最佳实践（卷挂载/密钥不注入/构建产物导出）
```

- [ ] **Step 2: 提交**

```bash
git commit -m "docs(container): 容器开发通用 skill——在容器中开发扩展后端的方法论文档"
```

---

### Task 4: extensions-in-container 扩展

**Files:**
- Create: `packages/extensions-in-container/`（package.json + index.ts + dev 容器工具）
- Modify: 根 workspaces（packages/extensions-in-container 注册）

**Interfaces:**
- Consumes: Docker（dev 容器）
- Produces: pi 扩展（容器开发命令：启动/挂载/验证）

- [ ] **Step 1: 写失败测试（扩展导出存在）**

```ts
// test/container-ext.test.ts
// 扩展 default export 存在；命令注册面正确
```

- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 写实现**

```ts
// packages/extensions-in-container/index.ts
// pi 扩展：注册 /container 命令族
//   /container start [--name]    启动 dev 容器（docker compose up dev）
//   /container mount <dir>       挂载仓库目录
//   /container verify <cmd>      容器内运行验证命令
//   /container status            容器状态
// 封装 Dockerfile.dev + tools/dev/ 的常用操作
```

- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

```bash
git commit -m "feat(container): extensions-in-container 扩展——/container 命令族（start/mount/verify/status）封装 dev 容器"
```

---

### Task 5: 统一端到端测试

**Files:**
- Create: `test/e2e-framework.test.ts`（framework 全链路端到端）

**Interfaces:**
- Consumes: Plan A/B/C 全部交付
- Produces: 端到端验证（env 工作流 → mail-box 通讯 → 容器开发）

- [ ] **Step 1: 写端到端测试**

```ts
// test/e2e-framework.test.ts
// 1. env 工作流：create → set → fork → list --json（AI 可编程闭环）
// 2. extension copy：引用模式 + 源码模式（遮蔽）
// 3. mailbox：发送/接收（文件邮箱 tmpdir）
// 4. stop --all（mock 安全）
// 全链路真实执行（tmpdir 隔离）
```

- [ ] **Step 2: 跑测试（应通过——Plan A/B/C 已各自验证）**
- [ ] **Step 3: 补漏（若端到端暴露集成问题）**
- [ ] **Step 4: 提交**

```bash
git commit -m "test(framework): 统一端到端测试——env 工作流/extension copy/mailbox/stop --all 全链路"
```

---

## 自审（Self-Review）

**1. Spec coverage：**
- Spec §3 monorepo 三项目 → Plan C Task 1/4（mailbox + extensions-in-container 落位 packages/）✅
- mail-box 独立化 → Task 1/2 ✅
- 容器开发（通用 skill + extensions-in-container）→ Task 3/4 ✅
- 端到端验证 → Task 5 ✅

**2. Placeholder scan：** 无 TBD；代码为骨架（实施时逐字展开）。

**3. Type consistency：** Mailbox/PitMessage 等（Task 1 迁移）被 Task 2 测试消费；/container 命令（Task 4）与 pi 扩展机制一致。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-framework-split-c.md`. Two execution options:

1. **Subagent-Driven (recommended)** - fresh subagent per task + review
2. **Inline Execution** - executing-plans with checkpoints

**Which approach?**
