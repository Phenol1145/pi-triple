# Pi-Triple

> 基于 [pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的多租户 Agent 平台 · 双产品线：轻量开发工具链（PTL）+ agent 联邦平台（PTH，含任务内核）

| | PTL（Pi-Triple-Lite） | PTH（Pi-Triple-Heavy） |
|---|----------------------|------------------------|
| **定位** | 轻量开发/调试工具链 | agent 联邦平台 + 任务内核 |
| **入口** | `ptl` CLI | `pth` server（HTTP/SSE/WebSocket） |
| **运行时** | pi 进程 × tmux | AgentEngine + Redis + BullMQ + PostgreSQL |
| **适用** | 本地工作站 · 交互式调试 · 个人/小组 | 服务器部署 · 程序化 API · 集中治理 · 任务流水线 |
| **来源** | `src/ptl/` | `src/pth/` |
| **文档** | [PTL 架构](./docs/ptl/architecture.md) · [创作指南](./docs/ptl/authoring.md) | [PTH 架构](./docs/pth/architecture.md) · [**Kernel 体系**](./docs/pth/kernel.md) · [API](./docs/pth/api.md) |

> 📐 **文档中心**：[`docs/README.md`](./docs/README.md)（全部文档索引）· 架构单一真相源：[`ARCHITECTURE.md`](./ARCHITECTURE.md)
> 🔧 **SDK 兼容性**：所有 pi SDK 调用通过 `src/shared/sdk-adapter/` 适配层隔离。当前适配 `@earendil-works/pi-coding-agent@^0.82.1`。

---

## ✨ PTH Kernel 任务体系（最新亮点）

PTH 的 agent 运行时内核——**任务池 + 多语言持久 REPL + 记忆闭环 + 全链路可观测**：

```
发布任务（代码形态）→ 持久 REPL 执行（TS/Python/Bash 三语言）
  → 自动提炼（快照 → LLM → tool-function 源码+spec / 洞察 双通道持久化）
  → 任务链路由（payload.flow：transform/decompose/branch/loop/wait/terminal）
  → 状态召回（state.recallFunctions / recallInsights → eval 重放）
  全程：结构化日志（taskId 链路）+ 四层 Prometheus 指标
```

| 能力 | 实测 |
|------|------|
| **多语言持久 REPL**：PyKernel 管道 JSON-RPC / BashKernel 持久 shell / TS VM 沙箱（能力白名单） | Python 执行 **230x**（0.12ms vs spawn 12ms） |
| **记忆闭环**：任务完成 → LLM 提炼 → 双通道持久化 → 召回重放 | fibonacci → refine → fib(20)=6765 跨任务复用 ✅ |
| **任务链**：任务池即工作流（自带路由 + 递归注销） | developer → 自动生成验收任务 → 双 completed ✅ |
| **监控**：四层 35+ 指标（L0 基建/L1 kernel/L2 任务/L3 产出），/metrics 端点 | cpu/rss/llm tokens/kernel exec/refine 全可查 ✅ |
| **日志**：KernelLogger（JSON 默认，taskId/role/batchPid 链路 ctx，batch IPC 转发） | 全链路下钻 ✅ |

**快速体验**（试运行环境）：

```bash
# 启动（需独立 postgres/redis，见 docs/pth/kernel.md）
DATABASE_URL=... REDIS_URL=... PORT=33100 DATA_DIR=/tmp/pth-trial/data node dist/pth/main.js

# 发布任务 + 启动 worker
curl -X POST localhost:33100/api/v1/kernel/tasks -d '{"title":"demo","text":"return {sum:[1,2,3].reduce((a,b)=>a+b)}","createdBy":"demo","tags":["demo"]}' -H "Authorization: Bearer <token>"
ptl hub kernel batch add 2      # 启动 2 个 worker

# 可观测
curl localhost:33100/metrics     # Prometheus 四层指标
```

详见 [PTH Kernel 体系](./docs/pth/kernel.md) · [性能计量 SPEC](./docs/superpowers/specs/2026-08-08-pth-perf-metrics-design.md)

---

## PTL 快速开始（推荐）

```bash
# 1. 全局安装
git clone <repo> && cd pi-platform
npm install && npm link

# 2. 导引（检查环境 + 安装提供商 + 创建租户 + 迁移扩展）
ptl onboard

# 3. 创建模板（首次）
ptl template new local

# 4. 启动
ptl start                     # tmux 会话，立即接入
ptl start --bg --name coding  # 后台启动
ptl pi                        # 原生前台（无 tmux）

# 5. 控制面板
ptl tui dashboard              # 系统总控 TUI
ptl tui lab                    # 模型调试 TUI
```

### ptl CLI 命令速查

| 命令 | 说明 |
|------|------|
| `ptl start` | 创建 tmux 会话并立即接入（默认；`--bg` 纯后台，`--name` 命名） |
| `ptl pi` | 原生前台启动 pi（无 tmux，pi 原生体验） |
| `ptl attach/switch/detach` | 接入 / 瞬移切换 / 脱离会话 |
| `ptl ls / ptl stop` | 列出 / 停止会话 |
| `ptl tui dashboard` / `ptl tui lab` | 系统控制 / 模型调试 TUI |
| `ptl flow run/approve/reject/set/edit...` | ptl-flow 波次工作流引擎 |
| `ptl hub submit/run/dev/programs` | PTL→PTH 桥（agent 程序提交/运行） |
| `ptl hub kernel tasks/batch/status` | PTH 任务池交互（发布/控制/状态全景） |
| `ptl template ls/new/rm/rename` | 模板管理 |
| `ptl config get/set/unset` | 配置读写 |
| `ptl update --all` | 更新 pi + 扩展 + 内置同步 |
| `ptl doctor` / `ptl onboard` | 环境诊断 / 首次导引 |
| `ptl install --shared <pkg>` | 安装共享扩展 |

详见 [PTL 架构](./docs/ptl/architecture.md)。新建技能/扩展的放置与挂载规范见 [创作指南](./docs/ptl/authoring.md)。

## PTH 服务器模式

```bash
# 安装依赖 + 启动 Redis
brew services start redis

# 启动平台
export ANTHROPIC_API_KEY=sk-ant-...
npm run pth:dev

# 测试
curl http://localhost:3000/health
```

```bash
# Docker 部署
docker-compose up -d
```

详见 [PTH 部署指南](./docs/pth/deployment.md) · [PTH API 参考](./docs/pth/api.md) · [PTH 架构文档](./docs/pth/architecture.md)。

## Roadmap

### ✅ 已完成

- [x] PTL：tmux 多会话管理 + ptl tui dashboard/lab TUI
- [x] PTL：共享扩展层（symlink 注入，逐项更新）
- [x] PTL：pit-providers 统一 provider 后端（声明式 JSON + 多 Key failover）
- [x] PTL：mailbox 跨会话通信 + pit-control 会话内控制
- [x] **PTL：ptl-flow 波次工作流引擎**（并行执行 + reducer + human gate + 运行中热修改）
- [x] **PTL→PTH 桥**：`ptl hub submit/run` — agent 程序打包提交到 PTH 运行
- [x] **PTH：多语言持久 REPL**（PyKernel 230x / BashKernel / TS VM 沙箱 + KernelManager 统一路由）
- [x] **PTH：任务池**（发布/认领/执行/submit-reject 闭环 + 模板库 + 批量 worker）
- [x] **PTH：记忆闭环**（Refine 管线：快照→LLM→tool-function 源码+spec/洞察双通道 + state 召回）
- [x] **PTH：任务链**（TaskResolver：payload.flow 自带路由 + 递归注销 + 自动验收闭环）
- [x] **PTH：工具文件通道**（toolstore：fs.readText/list，LLM 自主 import）
- [x] **PTH：日志体系**（KernelLogger + taskId 链路 + batch IPC 转发）
- [x] **PTH：监控设施**（四层 35+ 指标 + /metrics + ResourceProvider 跨 OS）
- [x] **凭据统一**：`resolveSdkConfigPaths` 唯一出口（PTL/PTH 同源）

### 🚧 规划

- [ ] PTH：任务池 v2（deps 就绪过滤、自然语言任务支持）
- [ ] PTH：REPL 进程池化（min(worker, CPU)）
- [ ] PTH：Windows 平台适配
- [ ] PTH：Dapr/K8s Phase 2 迁移

## 项目结构

> 完整模块说明见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) · 文档索引见 [`docs/README.md`](./docs/README.md)。

```
pi-platform/
├── src/
│   └── pth/                       # Pi-Triple-Heavy（bin: pth）
│       ├── main.ts                # 服务器入口（kernel 装配 + 路由 + 指标）
│       ├── gateway/               # Fastify（sessions/programs/kernel/self + SSE）
│       ├── core/ · programs/      # AgentEngine · ProgramStore（桥服务端）
│       ├── workflow/ · tools/ · storage/ · self-modify/
│       ├── kernel/                # ★★ 任务内核（见 docs/pth/kernel.md）
│       │   ├── assembly.ts        # 装配层（createKernelRuntime + watchdog + resolver 轮询）
│       │   ├── execution/         # TaskLoop · BatchManager/Process · TaskResolver · Refiner
│       │   ├── interpreter/       # KernelManager · PyKernel · BashKernel · TS VM · toolstore
│       │   ├── storage/           # PostgreSQL（tasks/memory/transcripts/audit）
│       │   ├── logger.ts          # KernelLogger（链路 ctx）
│       │   └── templates.ts       # 任务模板库（recon-doc/memory-maintain/dev-task/dev-task-ts）
│       └── observability/         # kernel-metrics（四层）· resource-provider（跨 OS）
├── packages/                      # npm 拆分
│   ├── framework/                 # ★ PTL CLI + TUI（bin: ptl，cli/flow/bridge/lab-data/tui-*）
│   ├── shared/                    # 双产品共享（config/tmux/presence/session-registry）
│   ├── infra/                     # sdk-adapter/model-router/platform/workspace
│   │   └── src/sdk-paths.ts       # ★ 凭据路径唯一出口（resolveSdkConfigPaths）
│   └── mailbox/ · extensions-in-container/
├── extensions/                    # bundled 扩展（8 个）
│   ├── pit-providers/             # 统一 provider 后端（多 Key failover）
│   ├── mailbox/                   # 跨会话通信（文件邮箱）
│   ├── pit-control/               # 会话内控制（/control）
│   ├── workflow/                  # pi 内流程编排（/flow）
│   ├── agent-lab/ + agent-lab-bidder/  # ★ agent 经济引擎 + 竞价工具
│   ├── pth-tasks/                 # ★ PTH 任务交互（/pthtask 命令族）
│   └── extensions-in-container/
├── examples/                      # echo-agent / pr-review / arena-review / custom-*
├── test/                          # 1247 个测试（vitest，149 文件）
├── docs/                          # ★ 文档中心（docs/README.md 索引）
└── ARCHITECTURE.md                # ★ 架构总览（单一真相源）
```

## 技术栈

| 组件 | 用于 | 用途 |
|------|------|------|
| Node.js >=22 | 全部 | 运行时 |
| TypeScript 5.7 | 全部 | 类型安全 |
| pi SDK 0.82 | 全部 | Agent 执行引擎 |
| React + Ink | PTL | TUI 渲染 |
| tmux | PTL | 会话管理 |
| Fastify 5.x | PTH | HTTP 网关 |
| ioredis 5.x + bullmq 5.x | PTH | Redis 客户端 + 工作流队列 |
| **PostgreSQL** | PTH | ★ 任务/记忆/转录存储（tasks/memory_entries） |
| pino 9.x | PTH | 结构化日志 |
| prom-client 15.x | PTH | Prometheus 指标（四层） |
| vitest 3.x | 全部 | 测试框架 |

## 开发者指南

### 快速循环

```bash
npx tsc --noEmit        # 类型检查（不产出 dist）
npx vitest run           # 1247 tests（直跑 TS）
npm run build && npm link # ★ ptl/pth bin 跑 dist/，端到端验证前必须 build
cd /tmp && ptl template ls  # 冒烟测试
```

> ⚠️ `tsc --noEmit` 与 vitest 都不产出/不依赖 dist，会掩盖“改了 src 未重建”的问题；CLI 冒烟前务必 `npm run build`。
> 发行门禁：`scripts/check-release-clean.sh`（发布包零用户痕迹校验）。

### 扩展开发

| 想做什么 | 参考 |
|----------|------|
| 新建 pi 扩展（bundled） | `extensions/pit-providers/` — provider 注册 |
| 扩展命令 + 参数补全 | `extensions/pit-control/index.ts` — registerCommand + getArgumentCompletions |
| 跨会话通信 | `extensions/mailbox/` — 文件邮箱 + Delivery 决策 |
| PTH 任务交互扩展 | `extensions/pth-tasks/` — /pthtask 命令族 + 薄 skill |
| PTH 自定义工具/路由/存储 | `src/pth/` — 接口替换见 [PTH 架构 #扩展方式](./docs/pth/architecture.md) |
| PTH 任务内核扩展 | `src/pth/kernel/` — 见 [Kernel 体系](./docs/pth/kernel.md) |
| PTL 加 CLI 命令 | `src/ptl/cli/admin.ts` + 注册到 `src/ptl/pit.ts` switch |
| TUI 新页面 | 遵循 [Screen 布局模板](./packages/framework/src/tui-shared/README.md) 5 条规则 |

### 设计原则

| 原则 | 说明 |
|------|------|
| pi 是引擎 | 不重写 pi 能力，做的是外层治理/编排/体验 |
| 模板隔离 | PTL：独立 pi 进程 + `PI_TEMPLATE`/`PI_CODING_AGENT_DIR`；PTH：Engine 层强制校验 |
| 错误用判别联合 | `Result<T> = {ok:true, data} \| {ok:false, error}` |
| 终端切换协议 | `unmountInk()` → `stdin.pause()` → `spawnSync(stdio: "inherit")` → `process.exit(status)` |
| 零外部依赖（扩展） | bundled 扩展只用 `node:` 内置 + 相对导入 |
| 凭据单一出口 | `resolveSdkConfigPaths()`（PTL/PTH 同源，异机/容器不分叉） |
| 任务即数据包 | 任务 text 代码形态 + payload 自带路由（flow） |
| 可观测优先 | 日志链路 ctx + 四层指标，从开发期就计量 |

## 已知限制

- **PTL 无 HTTP API**：适合本地工作站交互，不适合程序化/远程访问（→ PTH）
- **PTH 无 TUI**：适合服务器/API 场景（→ PTL 本地调试 + PTL→PTH 桥）
- **tmux**：Unix-only（Windows 支持规划中）
- **PTH 进程限制**：BullMQ worker 在主进程（Phase 1 技术债）
- **ptl-communicate**：单机通信，不支持跨机器
- **任务 text 需代码形态**：自然语言任务支持规划中（纯文本验收任务反复 reject 的教训）

## License

MIT
