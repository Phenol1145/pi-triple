# PTH 修改流程优化实施计划（开发循环提速）

> 目的：把"改代码→验证"从分钟级（rebuild ~50s → 优化后 ~25s）降到**秒级**（tsx watch 热重启）——解决开发煎熬。
> 依据：[Kernel 更新策略评估](../explorations/2026-08-10-pth-kernel-update-strategy.md)（GPT 方案——更新模式比较 + P0 构建优化已落地 f11e39a）。
> 验证前提（已实测）：①tsx 能跑 main.ts（.js 扩展 import 解析成功）②tsx 能跑 batch-process.ts（代码执行——缺 env 是预期）③batch-manager fork 已有 execArgv 参数（可传 tsx loader）。

---

## Phase 1：开发模式（tsx watch——秒级反馈——本计划核心）

**目标**：改 src → 容器内 tsx watch 自动重启（主进程 + batch）→ 立即验证——**秒级循环**。

### Step 1.1：batch 进程 tsx 化（Kernel 代码热更新关键）

**现状**：`resolveBatchProcessPath` 硬编码 `dist/batch-process.js`（注释已留 dev 模式意图——实现未做）。主进程 tsx watch 热重启——但 batch 是 fork 的 node dist——**改 Kernel 代码（batch 逻辑）→ batch 还是旧 dist**——dev 不完整。

**改动**：
```
assembly.ts resolveBatchProcessPath：
  if (explicit) return explicit;
  // dev 模式（PTH_BATCH_TS=1——或 dist 不存在）→ src TS
  if (process.env.PTH_BATCH_TS === "1" || !existsSync("dist/pth/kernel/execution/batch-process.js"))
    return "src/pth/kernel/execution/batch-process.ts";
  return "dist/pth/kernel/execution/batch-process.js";

assembly.ts createKernelRuntime（execArgv 配套）：
  execArgv: opts.execArgv ?? (PTH_BATCH_TS ? ["--import", "tsx"] : undefined)
  —— fork 子进程用 tsx loader 跑 .ts（execArgv 已有——补默认值）
```

**验证**：
- 单测：PTH_BATCH_TS=1 → resolveBatchProcessPath 返回 .ts + execArgv 含 tsx
- 集成：batch-process.ts 被 tsx fork（DATABASE_URL 传——batch 启动——status IPC 正常）

### Step 1.2：dev 镜像（Dockerfile.dev——devDeps + 挂载）

**改动**（新建 Dockerfile.dev）：
```dockerfile
FROM pi-platform-pi-platform:latest   # 基于生产镜像（继承全部）
USER root
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/*/package.json packages/*/
RUN npm ci                           # 全量（devDeps——tsx/typescript——生产 omit=dev 没有）
USER node
# 启动命令在 compose 覆盖（tsx watch）
```

**验证**：dev 镜像 build（devDeps 装——tsx 可用）——镜像大小可接受（devDeps ~几十 MB——可接受）。

### Step 1.3：docker-compose.dev.yaml（叠加变体）

**改动**（新建）：
```yaml
services:
  pi-platform:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - ./src:/app/src:ro                # host src 挂载（改即同步——tsx watch 触发）
      - ./config:/app/config:ro
      - /data                             # named volumes 保留（匿名覆盖空挂载）
    command: ["node_modules/.bin/tsx", "watch", "src/pth/main.ts"]
    environment:
      PTH_BATCH_TS: "1"                   # batch 进程也 tsx（Kernel 代码热）
      PTH_AGENT_MODE: lazy
    # 其他 env/depends_on 继承 compose 主文件
```

**启动**：`docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d pi-platform`

### Step 1.4：开发循环验证（秒级）

**流程**：
```
1. 改 src/pth/kernel/...（host）
2. tsx watch 检测文件变化 → 自动重启主进程（~1s）
3. batch 也 tsx（PTH_BATCH_TS）→ 主进程重启时 batch 重新 spawn（新代码）
4. 立即验证（health / 提交任务）
→ 循环：改 → 等 ~1-2s → 验证
```

**验证**：
- 改一个日志字符串 → tsx watch 重启日志出现（~1s）
- 改 Kernel 逻辑（task-loop 一行）→ 重启后新行为生效（提交任务验证）
- 注意副作用：执行中的 agent 任务在重启时中断（dev 可接受——不开发时跑生产模式）

### Step 1.5：开发循环文档

**docs/pth/development.md**：
```
- 启动：compose -f dev up（dev 模式——秒级循环）
- 改代码→自动重启→验证（不用 rebuild）
- 切回生产：compose up（普通 compose——rebuild 后跑）
- 已知：①执行中任务重启中断 ②sandbox 容器改动仍需 rebuild sandbox ③pg/redis 数据保留
```

---

## Phase 2：在线预构建（生产更新——中断缩短——可选——Phase 1 后按需要）

**目标**：生产核心更新——构建期间 A 继续服务——构建完成才替换——**中断 = 切换时间（秒）而非构建时间（分钟）**。

```
Step 2.1 构建脚本（scripts/release-build.sh——或 ptl hub release-build）：
  后台 docker build → 候选镜像 tag（pi-platform:candidate-<sha>）→ 不动运行中的 A
Step 2.2 替换脚本（排空→替换→恢复）：
  A 停止接收新请求（drain——但完成执行中工作）
  → docker stop A + start candidate（或 up --force-recreate 单服务）
  → readiness 验证（深健康：pg/redis/sandbox/batch/版本）
  → 失败回滚（旧 tag 保留——digest 明确）
```

**验证**：更新一次——中断时间测量（A 停 → B ready——目标 < 30s）——期间执行中任务行为（完成/超时/checkpoint）。

## Phase 3：batch 代际滚动（长期——Kernel 代码更新最终形态——可选）

**目标**：主进程/Gateway/会话不动——只滚动 Kernel batch——**任务边界近零中断**。

```
前提（Phase 1/2 后）：
  - batch 版本化执行构件（batch A 旧代际 / batch B 新代际——主进程管理）
  - 停止认领语义（旧 batch 不再领新任务——只完成存量）
  - 任务代际绑定（新任务→新代际 batch）
  - fencing（任一时刻一个 active 执行者）
改动：BatchManager 支持多 batch 代际 + 代际路由 + 排空生命周期
```

**验证**：改 Kernel 代码 → 新 batch spawn（新代际）→ 旧 batch 完成存量退出 → 期间任务不中断。

---

## 实施顺序与验收

| Phase | 目标 | 验收 | 工作量 |
|-------|------|------|--------|
| **Phase 1** | 开发秒级循环 | 改 src → ~1-2s 自动重启 → 立即验证 | 小（半天内）|
| Phase 2 | 生产更新中断 < 30s | 更新中断实测 + 回滚验证 | 中 |
| Phase 3 | Kernel 更新近零中断 | 任务边界滚动 + 不中断实测 | 大 |

**建议**：先做 Phase 1（解决开发煎熬——立即可感）——Phase 2/3 按需（生产更新频率低时可缓）。

---

## 已知边界（开发模式的代价——接受）

1. **执行中任务中断**：tsx watch 重启 → 运行中的 agent 任务中断（dev 可接受——调试完切生产跑长任务）
2. **sandbox 容器**：改 sandbox 源码（src/sandbox/）仍需 rebuild sandbox 容器（dev 挂载只挂 pi-platform——可扩展 dev.yaml 挂 sandbox）
3. **数据面**：pg/redis/卷保留（dev 重启不影响）
4. **生产隔离**：dev 模式仅开发（生产用普通 compose——rebuild 后跑——不改生产语义）
