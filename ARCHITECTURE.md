# Pi-Triple 架构总览

> 本文档是项目架构的**单一真相源**（single source of truth）。模块细节见 [`docs/ptl/`](./docs/ptl/architecture.md) 与 [`docs/pth/`](./docs/pth/architecture.md)。

Pi-Triple 是基于 [pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的**多租户 Agent 平台**，采用**单仓双产品**（monorepo, two products）形态：

| | **PTL**（Pi-Triple-Lite） | **PTH**（Pi-Triple-Heavy） |
|---|--------------------------|----------------------------|
| 定位 | 轻量开发/调试工具链 | agent 联邦平台（服务器） |
| 入口 | `ptl` CLI（`dist/ptl/pit.js`） | `pth` server（`dist/pth/main.js`） |
| 运行时 | 真实 pi 进程 × tmux | AgentEngine + Redis + BullMQ |
| 交互 | 本地终端 · TUI · 手动 | HTTP / SSE / WebSocket · 程序化 |
| 适用 | 个人/小组 · 交互式调试 | 团队/联邦 · 集中治理 · 弹性伸缩 |
| 源码 | `packages/framework/` | `src/pth/` |

两者共享 `src/shared/`（SDK 适配、模型路由、工作目录、跨 OS 适配、日志），并通过 **PTL→PTH 桥**（`ptl hub submit/run`）打通：PTL 本地开发的 agent 程序可打包提交到 PTH 以联邦模式运行。

```
                         ┌─────────────────────────────┐
                         │        src/shared/          │
                         │  sdk-adapter · model-router │
                         │  workspace · platform · log │
                         └──────────────┬──────────────┘
                ┌───────────────────────┴───────────────────────┐
                │                                               │
        ┌───────▼────────┐                              ┌───────▼────────┐
        │ packages/framework │ ptl hub submit / ptl hub run │     src/pth/     │
        │  ptl CLI + TUI │ ──────────── 桥 ───────────→ │  Fastify 网关   │
        │  pi × tmux     │        (bridge/)             │  AgentEngine   │
        │  交互层定位     │                              │  Redis + BullMQ │
        └────────────────┘                              └────────────────┘
```

---

## 仓库布局

```
pi-platform/
├── src/
│   ├── pth/                       # Pi-Triple-Heavy（服务器端 + 任务内核）
│   │   ├── main.ts                #   服务器入口（kernel 装配 + 路由 + 指标）
│   │   ├── core/                  #   AgentEngine · SessionPool · AsyncIterableBridge
│   │   ├── gateway/               #   Fastify 路由（sessions/programs/kernel/self）+ auth + SSE
│   │   ├── programs/              #   ★ ProgramStore（桥的服务端：上传/版本/运行）
│   │   ├── workflow/              #   BullMQ 工作流编排（orchestrator + worker）
│   │   ├── tools/ · storage/      #   工具治理（allowlist+审计+指标）· Redis 存储
│   │   ├── self-modify/           #   热加载（L1）+ A/B 重建（L3）
│   │   ├── kernel/                #   ★★ 任务内核（任务池/REPL/记忆/链/日志——见 docs/pth/kernel.md）
│   │   │   ├── assembly.ts        #   装配层（createKernelRuntime + watchdog + resolver 轮询）
│   │   │   ├── execution/         #   TaskLoop · BatchManager/Process · TaskResolver · Refiner
│   │   │   ├── interpreter/       #   KernelManager · PyKernel · BashKernel · TS VM · toolstore
│   │   │   ├── storage/           #   PostgreSQL（tasks/memory_entries/transcripts/audit）
│   │   │   ├── logger.ts · templates.ts
│   │   └── observability/         #   kernel-metrics（四层）· resource-provider（跨 OS）
│   └── sandbox/ · types/          #   沙箱入口 · 类型声明
│
├── packages/                      # npm 拆分（pnpm workspace 式目录）
│   ├── framework/                 #   ★ PTL CLI + TUI（bin: ptl）
│   │   └── src/{cli,commands,bridge,lab-data,session,tui-ptl,tui-lab,tui-shared}
│   ├── shared/                    #   双产品共享（config/tmux/presence/registry/session-registry）
│   ├── infra/                     #   基础设施（sdk-adapter/model-router/platform/workspace）
│   │   └── src/sdk-paths.ts       #   ★ 凭据路径唯一出口（resolveSdkConfigPaths）
│   ├── mailbox/ · extensions-in-container/
│
├── extensions/                    # bundled 扩展（5 个，共享层 symlink 注入）
│   ├── pit-providers/             #   统一 provider 后端（声明式 JSON + 多 Key failover）
│   ├── pit-control/ · mailbox/    #   会话内控制 · 跨会话通信
│   ├── pth-tasks/                 #   ★ PTH 任务交互（/pthtask 命令族）
│   └── extensions-in-container/   #   dev 容器内扩展集合
├── archive/                       # 已归档（保留代码不再编译）：framework-flow（workflow 引擎）· agent-lab(+bidder) · workflow-ext
│
├── examples/                      # 示例（echo-agent / pr-review / arena-review / custom-*）
├── test/                          # 1645 个测试（vitest，195 文件）
├── docs/                          # 文档中心（docs/README.md 索引）
│   ├── pth/                       #   architecture.md / kernel.md / api.md / deployment.md
│   └── ptl/                       #   architecture.md / authoring.md
├── deploy/                        # 容器构建（Dockerfile×3 · docker-compose×2 · pth.deployment.json · docker-monitor）
├── ARCHITECTURE.md                # ★ 架构总览（单一真相源）
└── tsconfig.json · vitest.config.ts
```

> ★ = 近期主要新增子系统。

---

## PTL 核心子系统

### 1. pi 进程编排（tmux 多会话）

PTL **不实现自己的 agent runtime**——它启动真正的 pi 进程，每个模板一套隔离的 pi 配置目录（extensions/skills/settings/models/sessions/workspaces）。tmux 作为运行时载体：后台保活、`switch-client` 瞬移切换、`-e KEY=VAL` 传环境（无 shell 注入）。

- `ptl start`（默认 tmux 管理）/ `ptl pi`（原生前台逃生舱）
- 关键模块：`tmux.ts` · `launcher.ts` · `cli/sessions.ts`

### 2. PTL 交互层定位（2026-08-09 收敛）

PTL 回归轻量交互层：CLI + 双 TUI（dashboard/lab）+ tmux 会话 + 共享扩展层 + PTL→PTH 桥。
workflow 引擎（ptl-flow）与 agent 经济引擎（agent-lab）已归档至 `archive/`（保留代码不再编译，历史见 git/v0.5.0 release）。

### 3. PTL→PTH 桥（`packages/framework/src/bridge/`）

把 PTL 本地开发的 agent 程序（`agent.json` manifest + skills + systemPrompt）打包提交到 PTH 运行。

- `ptl hub submit`（打包上传，`pack.ts` + 手写 `ustar.ts`，零外部依赖）
- `ptl hub run <program> [k=v]`（提交并以 SSE 流式回显）· `ptl hub dev`（本地直跑）· `ptl hub programs`（列表）
- `pipe.ts` 将程序的 systemPrompt + skills 注入 pi 启动参数
- 服务端：`src/pth/programs/store.ts`（INCR 版本 + tar 安全解包 + GC）+ `gateway/routes-programs.ts`

### 4. lab 遥测数据层（`packages/framework/src/lab-data/`）

`ptl tui lab` TUI 的数据底座。SQLite（WAL + busy_timeout）：共享 `runs` DB（跨模板调用遥测）+ per-template arena/events/config。模块：`telemetry.ts` · `arena.ts` · `events.ts` · `open-db.ts` · `schema.ts`。

### 5. 双 TUI + 共享组件（`tui-ptl/` · `tui-lab/` · `tui-shared/`）

两个 Ink TUI 共用统一 `Screen` 布局模板（Head/Content/Tips）与组件库（DataTable/SelectList/ConfirmDialog/SparkLine/BarChart/层级 CommandBar）。退出统一走 `/quit`。规范见 `packages/framework/src/tui-shared/README.md`。

---

## PTH 核心子系统

模块化单体（单进程，接口隔离），分层：

```
Gateway（Fastify + auth + SSE）
  → Core（AgentEngine · SessionPool busy/idle 状态机 · AsyncIterableBridge）
  → Platform（ModelRouter · ToolPlatform 治理 · WorkflowOrchestrator · WorkspaceManager · HotReloader）
  → Infrastructure（Redis · BullMQ · pino · prom-client · PlatformAdapter）
```

- **AgentEngine**：平台主协调器（session 生命周期 + prompt + abort + 驱逐），持 SessionPool/ModelRouter/WorkspaceManager/SessionStore/ToolPlatform
- **ProgramStore**（`programs/`）：桥的服务端。`POST /api/v1/programs`（上传）· `GET/DELETE /api/v1/programs/:name` · `POST /api/v1/programs/:name/run`（运行，SSE 直推）
- **WorkflowOrchestrator**（`workflow/`）：服务端 BullMQ 工作流（`agent`/`human-approval` 步骤可用，`parallel`/`condition` 为 stub）。（PTL 侧 flow 引擎已归档——本模块为服务器集中编排）
- **ToolPlatform**（`tools/`）：pi 内置工具的治理外壳（allowlist + 审计 + 指标），不重写工具
- **存储**：Redis append-only entry + snapshot 模型；`SessionStore`/`SettingsStore`/`CredentialProvider` 接口可替换后端
- **Kernel 任务体系**（`kernel/` + `gateway/routes-kernel.ts`）：★ agent 任务运行时——任务池（发布/认领/执行/submit-reject 闭环）· 多语言持久 REPL（PyKernel 管道 JSON-RPC **230x** / BashKernel 持久会话 / TS VM 沙箱白名单）· 记忆闭环（快照→LLM 提炼→tool-function 源码+spec 双通道持久化→state 召回）· TaskResolver 任务链（payload.flow 自带路由：transform/decompose/branch/loop/wait/terminal）· 四层监控（`/metrics`：L0 基建/L1 kernel/L2 任务/L3 产出 35+ 指标）+ KernelLogger 结构化日志（链路 ctx）。详见 [`docs/pth/kernel.md`](./docs/pth/kernel.md)

详见 [`docs/pth/architecture.md`](./docs/pth/architecture.md) · [`docs/pth/kernel.md`](./docs/pth/kernel.md) · [`docs/pth/api.md`](./docs/pth/api.md) · [`docs/pth/deployment.md`](./docs/pth/deployment.md)。

---

## 扩展生态（8 个 bundled）

| 扩展 | 能力 |
|------|------|
| **pit-providers** | 声明式 provider 注册（`~/.pi-triple/providers.json`）；多 Key 池 + 401/403 failover；`/keys` 统一管理；零代码加 provider |
| **mailbox**（@pi-triple/mailbox） | 跨 pi 会话消息（文件邮箱，原 pit-communicate）；`/ptl send/ask/inbox/share`；manual/auto/hybrid 审核；不可变审计日志 |
| **pit-control** | pi 内管理 tmux 会话；`/control start/stop/ls/switch/detach/ui/name/status` |
| ~~workflow~~ | ⚠️ 已归档 `archive/workflow-ext/`（pi 内编排 ptl-flow；`/flow` 命令 + 工具） |
| ~~agent-lab~~ | ⚠️ 已归档 `archive/agent-lab/`（agent 经济引擎：WorkLoop/arena/调度/优化；代码保留供 0.7/0.8 恢复） |
| ~~agent-lab-bidder~~ | ⚠️ 已归档 `archive/agent-lab-bidder/`（place_bid 工具；用户保留意向 0.7/0.8 复用） |
| **pth-tasks** | PTH 任务交互层：会话内 `/pthtask publish|ls|status|batch`（发布/列表/状态/控制 batch）+ 薄 skill（任务描述写法/状态语义/排障） |
| **mailbox** | 跨会话通信（`packages/mailbox` 的分发实现） |
| **extensions-in-container** | dev 容器内扩展集合 |

共享层机制：bundled 扩展安装到 `~/.pi-triple/data/shared/extensions/`，逐项 symlink 注入各模板目录（一处更新全局可见）；`.bundled-manifest` 标记平台托管，`ptl update --all` 覆盖式同步。

---

## 数据布局

### PTL（`~/.pi-triple/`，`PI_TRIPLE_HOME` 可覆盖）

```
~/.pi-triple/
├── pi-triple.json            # v2 配置（UUID+alias），全局唯一；cwd 的 pi-triple.json 为项目级覆盖
├── providers.json            # provider 声明（pit-providers 消费）
└── data/
    ├── pi-config/<uuid>/     # 模板 pi 配置（extensions/skills/settings/models/auth）
    ├── sessions/<uuid>/      # pi session 文件
    ├── workspaces/<uuid>/    # agent 工作目录
    ├── shared/               # 共享扩展/技能
    ├── mailbox/<uuid>/       # mailbox 邮箱
```

### PTH（`{DATA_DIR}`，默认 `.pi-platform-data/`）

```
{DATA_DIR}/
├── workspaces/{tenant}/{project}/   # agent 工作目录（服务端推导，C5）
├── platform/                        # skills/prompts/tools/config（热加载监听）
├── programs/                        # ★ 上传的 agent 程序（版本化）
└── tenants/{tenant}/                # 租户级配置
```
Redis：`session:{tenant}:{sid}:*` · `auth:token:{token}` · `session-index:{tenant}`。

---

## 跨产品数据流

### A. PTL→PTH 程序提交

```
ptl hub submit ./my-agent
  → pack.ts 读 agent.json（manifest.ts 校验）+ skills → ustar.ts 打 tar
  → POST /api/v1/programs（ProgramStore：INCR 版本 + 安全解包）
ptl hub run my-agent key=val
  → POST /api/v1/programs/my-agent/run → AgentEngine 起一次性 session
  → SSE 双信封 {seq,type,data} 直推 → ptl 解包渲染 → 流结束自动销毁 session
```


---

## 硬约束（精选）

| # | 约束 |
|---|------|
| **SDK 隔离** | 所有 pi SDK 导入只在 `src/shared/sdk-adapter/`；升级 SDK 只改适配层 |
| **C1** | 跨模块仅 JSON DTO + `AsyncIterable` 流，不共享对象引用 |
| **C5** | Token→tenantId；工作目录路径服务端推导，不信任客户端 |
| **C7** | Engine 层 prompt/abort/destroy 均校验 tenantId |
| **C8** | ToolPlatform 是治理外壳，不重写 pi 内置工具 |
| **PTL 零依赖** | 扩展与框架不引外部包（手写 ustar / expr / fs.watch 替代 chokidar） |
| **原子写** | 所有 JSON 写用 tmp+rename |
| **tmux 传参** | `-e KEY=VAL` flag，禁 shell 字符串拼接 |

PTH 完整硬约束 C1–C10 见 [`docs/pth/architecture.md`](./docs/pth/architecture.md#硬约束详解)。

---

## 技术栈

Node.js ≥22 · TypeScript 5.7 · pi SDK 0.82 · React+Ink（PTL TUI）· tmux（PTL）· Fastify 5 + ioredis 5 + bullmq 5 + pino 9 + prom-client 15（PTH）· SQLite WAL（lab-data）· vitest 3（614 root tests）· node:test（agent-lab 子套件 1288 tests）。

## 开发

```bash
npm run build          # tsc → dist/（ptl/pth bin 跑编译产物，改 src 后必须重建）
npm run ptl:dev        # tsx 直跑 PTL（开发）
npm run pth:dev        # tsx watch 直跑 PTH（开发）
npm test               # vitest run（614 + agent-lab 子套件 1288）
npm run lint           # tsc --noEmit
```

> ⚠️ `lint`（`tsc --noEmit`）**不产出** dist；`ptl`/`pth` bin 跑 `dist/`，故端到端验证前必须 `npm run build`。vitest 直跑 TS 会掩盖未重建问题。
