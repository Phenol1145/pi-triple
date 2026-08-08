# PTH 任务发布工具（skill + extension + gateway 路由）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开发一套 skill + extension 作为 PTH 任务发布工具，把 PTL 当作交互层。PTH 暴露运行状态（为监控面板铺垫）。架构：PTL（交互层）→ skill（薄：教 agent 写任务）→ extension（命令）→ gateway 新路由（生产形态）→ kernel（pg tasks 表 + BatchManager）。

**Architecture:**

```
用户 (ptl 会话 / shell)
  │  skill: 薄规则（怎么写任务/何时发布）— 不重复实现
  │  extension: /pthtask 命令族（publish/status/ls + batch add/remove/status + pth status）
  │      ↓ PthClient (HTTP + Bearer)
  ▼
PTH gateway (:3000)
  │  /api/v1/kernel/tasks   (POST publish / GET list / GET :id status)
  │  /api/v1/kernel/batch   (POST add / POST remove / GET status)
  │  /api/v1/kernel/status  (GET 运行状态——batch 运行态/任务统计/watchdog crashLog——监控面板铺垫)
  ▼
PTH main.ts（接线 kernel）
  │  createKernelRuntime(pg) → dataWorld + BatchManager + watchdog 挂生命周期
  ▼
pg tasks 表 ← BatchManager/batch-process 消费
```

**Tech Stack:** fastify（既有）、pg（既有）、node:child_process fork（既有）、pi extension API（registerCommand）、zero 新依赖。

## Global Constraints

- 不破坏既有 hub 命令族（submit/run/programs/request/observe/debug 保留）
- auth 仍走 Redis token（createAuthHook 不变）；新路由挂在同一 auth 下
- kernel 接线失败（pg 不可达）→ PTH 仍可启动（fail-open），/kernel/* 路由返回 503 带原因
- 测试：新路由单元测试（mock kernel）+ 集成测试（真实 pg testcontainers）+ extension 命令解析纯函数测试
- 提交风格：`feat(pth): 中文摘要` / `feat(ptl): 中文摘要`

---

### Task 1: PTH main.ts 接线 kernel（createKernelRuntime + 生命周期）

**Files:**
- Modify: `src/pth/main.ts`（kernel 装配 + shutdown 顺序）
- Test: 不新增（装配层已覆盖；main.ts 手工试运行验证）

**Interfaces:**
- Consumes: `createKernelRuntime`（装配层 Task 2 已建）
- Produces: main.ts 内 `kernelRuntime`（pg + dataWorld + batchManager + watchdog）

- [ ] **Step 1: main.ts 装配 kernel（fail-open）**

```ts
// DATABASE_URL env（compose 已注入 postgresql://pth:...@postgres:5432/pth）
// 失败 → logger.warn + kernelRuntime = null（PTH 其余功能照常）
const databaseUrl = process.env.DATABASE_URL;
let kernelRuntime: KernelRuntime | null = null;
if (databaseUrl) {
  try {
    kernelRuntime = await createKernelRuntime({
      databaseUrl, basePath: `${dataDir}/workspaces`, artifactPath: `${dataDir}/artifacts`,
      batchProcessPath: "src/pth/kernel/execution/batch-process.ts",
      execArgv: ["--experimental-transform-types", "--import", <loader>],
      env: { PTH_BATCH_PROCESS: "1", PTH_TEST_DATABASE_URL: databaseUrl, ... },
    });
  } catch (err) { logger.warn({ err, event: "kernel_assembly_failed", note: "kernel 装配失败——/kernel/* 路由 503，其余照常" }); }
}
```

- [ ] **Step 2: shutdown 顺序**（先 kernel.shutdown() → 再 engine.drain/server.close/redis.quit）
- [ ] **Step 3: 提交**

---

### Task 2: gateway /kernel/* 路由（tasks + batch + status）

**Files:**
- Create: `src/pth/gateway/routes-kernel.ts`（registerKernelRoutes）
- Modify: `src/pth/gateway/server.ts`（注入 kernelRuntime 可选依赖 + 注册）
- Test: `test/pth-gateway/kernel-routes.test.ts`（fastify inject + mock kernel）

**Interfaces:**
- Consumes: `KernelRuntime`（装配层）、TaskStore（publish/candidates/countPending）、BatchManager、KernelWatchdog
- Produces:
  - `POST /api/v1/kernel/tasks` `{title, text, createdBy, tags?}` → 201 `{id, status}`
  - `GET /api/v1/kernel/tasks` `?status=&limit=` → 任务列表
  - `GET /api/v1/kernel/tasks/:id` → `{id, status, ...}`
  - `POST /api/v1/kernel/batch/add` `{count?}` → 启动 n 个 batch
  - `POST /api/v1/kernel/batch/remove` `{count?}` → 停止 n 个
  - `GET /api/v1/kernel/batch` → batch 列表（含 alive 判定）
  - `GET /api/v1/kernel/status` → **运行状态全景**（监控面板铺垫）:
    ```
    { kernel: { connected, schemaVersion },
      batches: [{id, pid, alive, workers, currentTasks, idleRatio}],
      tasks: { pending, completed, rejected, total },
      watchdog: { crashLog: [...] } }
    ```

- [ ] **Step 1: 写失败测试**（mock kernel：fake batchManager/dataWorld/watchdog——inject 断言）
- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 写实现**（routes-kernel.ts；kernel 为 null → 503）
- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

---

### Task 3: PTL PthClient 扩展 + ptl hub kernel 命令族

**Files:**
- Modify: `packages/framework/src/bridge/client.ts`（+kernelTasks/kernelBatch/kernelStatus 方法）
- Modify: `packages/framework/src/bridge/kernel.ts`（新文件：hub kernel 命令实现）
- Modify: `packages/framework/src/cli/route.ts`（hub kernel 子命令分发）
- Modify: `packages/framework/src/cli/main.ts`（帮助文本）
- Test: `packages/framework/test/kernel-bridge.test.ts`（mock fetch）

**Interfaces:**
- Consumes: PthClient（既有）
- Produces: `ptl hub kernel tasks add "<desc>" --tags=x` / `ptl hub kernel tasks ls` / `ptl hub kernel batch add|remove` / `ptl hub kernel status`

- [ ] **Step 1: 写失败测试**（PthClient 方法 + 命令参数解析）
- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 写实现**
- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

---

### Task 4: extension（/pthtask 命令族）+ 注册

**Files:**
- Create: `extensions/pth-tasks/index.ts`（registerCommand("pthtask", ...) + registerCommand("pth", ...)）
- Create: `extensions/pth-tasks/package.json`
- Modify: `extensions/.gitignore`（排除规则确认——不排除 pth-tasks）
- Test: `extensions/pth-tasks/test/commands.test.ts`（命令解析纯函数）

**Interfaces:**
- Consumes: ExtensionAPI（registerCommand）、PthClient 逻辑（复用或薄封装）
- Produces:
  - `/pthtask publish <描述>` → 调 gateway POST /kernel/tasks
  - `/pthtask status [id]` → 任务状态
  - `/pthtask ls [--status]` → 任务列表
  - `/pthtask batch add|remove|status`
  - `/pthtask status`（kernel 运行状态全景——监控面板铺垫）

- [ ] **Step 1: 写失败测试**（解析 + 渲染纯函数）
- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 写实现**
- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

---

### Task 5: skill（薄：教 agent 写任务 + 用命令）

**Files:**
- Create: `skills/pth-tasks/SKILL.md`（或 extensions/pth-tasks/SKILL.md）

**内容:**
- PTH 任务是什么：tasks 表一条记录（title/text/tags/createdBy），batch 自动消费
- 怎么写好任务描述：具体、可验收、单任务单目标（title 简洁、text 含验收标准）
- 何时发布 vs 何时自己直接做：任务适合异步/多 worker/需要记忆上下文时
- 如何使用 /pthtask 命令：发布 → 轮询 status → 报告结果
- 例：发布"调查 X"的完整命令序列

- [ ] **Step 1: 写 SKILL.md**
- [ ] **Step 2: 校验 frontmatter**
- [ ] **Step 3: 提交**

---

### Task 6: 全链路试运行 + 验证

**Files:**
- 试运行脚本（真实 pg + PTH main.ts + ptl hub kernel 命令）

**验证点:**
- [ ] PTH main.ts 启动（pg 就绪）→ kernel 装配成功
- [ ] `ptl hub kernel status` → 运行状态全景输出
- [ ] `ptl hub kernel tasks add "1+1"` → 201 + batch 消费 → completed
- [ ] `ptl hub kernel batch add 2` → 2 batch 运行
- [ ] extension /pthtask 在会话内可用（或验证注册逻辑）

- [ ] **Step 1: 跑全链路**
- [ ] **Step 2: 提交最终状态**

---

## 自审（Self-Review）

**1. Spec coverage：**
- 用户指示"skill + extension 作为 PTH 任务发布工具，PTL 当交互层" ✅ Task 3/4/5
- 用户指示"pth 暴露运行状态，监控面板铺垫" ✅ Task 2 status 全景 + Task 4 /pthtask status
- 用户选择"gateway 生产形态" ✅ Task 1/2
- 用户选择"薄 skill" ✅ Task 5

**2. Placeholder scan：** 无 TBD；loader 路径（Task 1 Step 1）实施时按实际 resolve。

**3. Type consistency：** KernelRuntime（装配层）由 Task 1 消费、Task 2 路由注入——签名一致；PthClient 既有方法不动（Task 3 新增）。

## Execution Handoff

Plan complete and saved. Execution options:
1. **Subagent-Driven (recommended)** - fresh subagent per task + review
2. **Inline Execution** - executing-plans with checkpoints

**Which approach?**
