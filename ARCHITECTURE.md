# Pi-Triple 架构总览

> 本文档是项目架构的**单一真相源**（single source of truth）。模块细节见 [`docs/ptl/`](./docs/ptl/architecture.md) 与 [`docs/pth/`](./docs/pth/architecture.md)。

Pi-Triple 是基于 [pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的**多租户 Agent 平台**，采用**单仓双产品**（monorepo, two products）形态：

| | **PTL**（Pi-Triple-Lite） | **PTH**（Pi-Triple-Heavy） |
|---|--------------------------|----------------------------|
| 定位 | 轻量开发/调试工具链 | agent 联邦平台（服务器） |
| 入口 | `pit` CLI（`dist/ptl/pit.js`） | `pth` server（`dist/pth/main.js`） |
| 运行时 | 真实 pi 进程 × tmux | AgentEngine + Redis + BullMQ |
| 交互 | 本地终端 · TUI · 手动 | HTTP / SSE / WebSocket · 程序化 |
| 适用 | 个人/小组 · 交互式调试 | 团队/联邦 · 集中治理 · 弹性伸缩 |
| 源码 | `src/ptl/` | `src/pth/` |

两者共享 `src/shared/`（SDK 适配、模型路由、工作目录、跨 OS 适配、日志），并通过 **PTL→PTH 桥**（`pit submit/run`）打通：PTL 本地开发的 agent 程序可打包提交到 PTH 以联邦模式运行。

```
                         ┌─────────────────────────────┐
                         │        src/shared/          │
                         │  sdk-adapter · model-router │
                         │  workspace · platform · log │
                         └──────────────┬──────────────┘
                ┌───────────────────────┴───────────────────────┐
                │                                               │
        ┌───────▼────────┐                              ┌───────▼────────┐
        │   src/ptl/     │   pit submit / pit run       │   src/pth/     │
        │  pit CLI + TUI │ ──────────── 桥 ───────────→ │  Fastify 网关   │
        │  pi × tmux     │        (bridge/)             │  AgentEngine   │
        │  pit-flow 引擎  │                              │  Redis + BullMQ │
        └────────────────┘                              └────────────────┘
```

---

## 仓库布局

```
pi-platform/
├── src/
│   ├── shared/                    # 双产品共享（SDK 隔离层）
│   │   ├── sdk-adapter/           #   pi SDK 唯一导入点（硬约束）
│   │   ├── model-router/          #   模型自动检测 + failover 链
│   │   ├── workspace/             #   工作目录隔离（服务端推导路径）
│   │   ├── platform/              #   跨 OS 适配器（posix / win32）
│   │   ├── observability/         #   pino 日志
│   │   └── credential-provider.ts #   API key 提供
│   │
│   ├── ptl/                       # Pi-Triple-Lite
│   │   ├── pit.ts                 #   CLI 入口（bin: pit）
│   │   ├── pit/                   #   命令模块（args/main/mode/sessions/onboard/config-cmd/admin）
│   │   ├── flow/                  #   ★ pit-flow 波次工作流引擎（见下）
│   │   ├── bridge/                #   ★ PTL→PTH 桥（submit/run/dev/programs + ustar 打包）
│   │   ├── lab-data/              #   ★ lab 遥测数据层（SQLite：runs/arena/events）
│   │   ├── config.ts              #   配置系统（v2 UUID+alias，模板）
│   │   ├── tmux.ts                #   tmux 会话管理（命名/构建/存活/csi-u）
│   │   ├── launcher.ts            #   pi 进程启动参数构建
│   │   ├── shared-layer.ts        #   共享扩展层（symlink + manifest + prune）
│   │   ├── doctor.ts / migrate.ts #   环境诊断 / ~/.pi/agent 迁移
│   │   ├── tui-pit/               #   pit ui（Dashboard/Templates/Sessions/Extensions/Config）
│   │   ├── tui-lab/               #   lab ui（Telemetry/Arena/Events/Compare/Config）
│   │   └── tui-shared/            #   TUI 组件库 + Screen 布局模板 + 层级命令栏
│   │
│   └── pth/                       # Pi-Triple-Heavy
│       ├── main.ts                #   服务器入口（bin: pth）
│       ├── core/                  #   AgentEngine · SessionPool · AsyncIterableBridge
│       ├── gateway/               #   Fastify 路由（sessions/programs/self）+ auth + SSE
│       ├── programs/              #   ★ ProgramStore（桥的服务端：上传/版本/运行）
│       ├── workflow/              #   BullMQ 工作流编排（orchestrator + worker）
│       ├── tools/                 #   工具治理（allowlist + 审计 + 指标 + SPI）
│       ├── storage/               #   Redis 存储（session/settings store）
│       ├── self-modify/           #   热加载（L1）+ A/B 重建（L3）
│       └── observability/         #   Prometheus 指标 + 审计日志
│
├── extensions/                    # bundled 扩展（5 个，共享层 symlink 注入）
│   ├── pit-providers/             #   统一 provider 后端（声明式 JSON + 多 Key failover）
│   ├── pit-communicate/           #   跨会话通信（文件邮箱 + 审核模式）
│   ├── pit-control/               #   会话内控制（/control start/stop/switch...）
│   ├── workflow/                  #   ★ pi 内流程编排（/flow 命令 + flow_run 工具）
│   └── agent-lab/                 #   模型遥测（token/cost/latency → SQLite）
│
├── examples/                      # 示例
│   ├── echo-agent/                #   桥测试用最小 agent 程序
│   ├── pr-review/                 #   pit-flow 串行 + human gate 示例
│   ├── arena-review/              #   pit-flow 并行 fan-out + reducer 示例
│   └── custom-{route,tool,store}/ #   PTH 扩展点示例
│
├── test/                          # 447 个测试（vitest）
├── docs/{ptl,pth}/                # 分产品详细架构文档
├── Dockerfile · docker-compose.yaml
└── tsconfig.json · vitest.config.ts
```

> ★ = 近期主要新增子系统。

---

## PTL 核心子系统

### 1. pi 进程编排（tmux 多会话）

PTL **不实现自己的 agent runtime**——它启动真正的 pi 进程，每个模板一套隔离的 pi 配置目录（extensions/skills/settings/models/sessions/workspaces）。tmux 作为运行时载体：后台保活、`switch-client` 瞬移切换、`-e KEY=VAL` 传环境（无 shell 注入）。

- `pit start`（默认 tmux 管理）/ `pit pi`（原生前台逃生舱）
- 关键模块：`tmux.ts` · `launcher.ts` · `pit/sessions.ts`

### 2. pit-flow 波次工作流引擎（`src/ptl/flow/`）

LangGraph 风格的本地工作流引擎，声明式 JSON 图（节点 + 条件边 + 环），**波次并行（BSP）执行** + **运行中热修改**是两大特性。

| 概念 | 说明 |
|------|------|
| **波次执行** | 同一波内无依赖节点并行 spawn；波末统一合并 state、写波 checkpoint |
| **触发计数** | 每节点 `firedEpoch`、每边 `consumed[pred→target]`；`f>c` 即有未消费完成 → 激活 |
| **汇合语义** | 默认 any-join（任一入边激活即触发）；显式 `needs:[...]` 为 AND-join |
| **Reducer** | 并发写同 key 按 `last-wins` / `append` / `concat` 合并（按 nodeId 序确定性） |
| **Human gate** | `type:"human"` 节点暂停于 `waiting_human`；`pit flow approve/reject` 即恢复 |
| **热修改护栏** | running 中 `set/edit` 排队进 `meta.pendingEdits` 并自动 propose → 引擎在**波边界**停（`editing`）→ `resume` 重校验后应用再继续 |
| **双锁** | exec lock（执行）+ mutation lock（改图）分离，允许执行中改图 |
| **失败语义** | drain-on-failure（同波兄弟跑完）；失败节点回滚入边消费，仅外部 resume 重跑；needs-hunger 检测 |

模块：`engine.ts`（波次循环）· `schema.ts`（校验）· `store.ts`（runs/checkpoints/waves/locks）· `expr.ts`（手写表达式）· `template.ts`（`{{state.x}}` 插值）· `reducers.ts` · `edit.ts`（set/edit/approve/reject/propose）· `commands.ts`（CLI）· `pm.ts`（spawn pi）。

命令：`pit flow run/status/show/ls/validate/graph/rm` + `approve/reject/resume` + `set/edit/propose/discard`。

### 3. PTL→PTH 桥（`src/ptl/bridge/`）

把 PTL 本地开发的 agent 程序（`agent.json` manifest + skills + systemPrompt）打包提交到 PTH 运行。

- `pit submit`（打包上传，`pack.ts` + 手写 `ustar.ts`，零外部依赖）
- `pit run <program> [k=v]`（提交并以 SSE 流式回显）· `pit dev`（本地直跑）· `pit programs`（列表）
- `pipe.ts` 将程序的 systemPrompt + skills 注入 pi 启动参数
- 服务端：`src/pth/programs/store.ts`（INCR 版本 + tar 安全解包 + GC）+ `gateway/routes-programs.ts`

### 4. lab 遥测数据层（`src/ptl/lab-data/`）

`pit lab` TUI 的数据底座。SQLite（WAL + busy_timeout）：共享 `runs` DB（跨模板调用遥测）+ per-template arena/events/config。模块：`telemetry.ts` · `arena.ts` · `events.ts` · `open-db.ts` · `schema.ts`。

### 5. 双 TUI + 共享组件（`tui-pit/` · `tui-lab/` · `tui-shared/`）

两个 Ink TUI 共用统一 `Screen` 布局模板（Head/Content/Tips）与组件库（DataTable/SelectList/ConfirmDialog/SparkLine/BarChart/层级 CommandBar）。退出统一走 `/quit`。规范见 `src/ptl/tui-shared/README.md`。

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
- **WorkflowOrchestrator**（`workflow/`）：服务端 BullMQ 工作流（`agent`/`human-approval` 步骤可用，`parallel`/`condition` 为 stub）。⚠️ 与 PTL 的 **pit-flow** 是两个独立概念：前者是服务器集中编排，后者是本地波次引擎
- **ToolPlatform**（`tools/`）：pi 内置工具的治理外壳（allowlist + 审计 + 指标），不重写工具
- **存储**：Redis append-only entry + snapshot 模型；`SessionStore`/`SettingsStore`/`CredentialProvider` 接口可替换后端

详见 [`docs/pth/architecture.md`](./docs/pth/architecture.md) · [`docs/pth/api.md`](./docs/pth/api.md) · [`docs/pth/deployment.md`](./docs/pth/deployment.md)。

---

## 扩展生态（5 个 bundled）

| 扩展 | 能力 |
|------|------|
| **pit-providers** | 声明式 provider 注册（`~/.pi-triple/providers.json`）；多 Key 池 + 401/403 failover；`/keys` 统一管理；零代码加 provider |
| **pit-communicate** | 跨 pi 会话消息（文件邮箱）；`/pit send/ask/inbox/share`；manual/auto/hybrid 审核；不可变审计日志 |
| **pit-control** | pi 内管理 tmux 会话；`/control start/stop/ls/switch/detach/ui/name/status` |
| **workflow** | pi 内编排 pit-flow；`/flow` 命令 + `flow_run/flow_status/flow_ls` 工具 + gate 通知（shell 调 `pit flow` CLI） |
| **agent-lab** | 记录每次 LLM 调用 token/cost/latency；共享 SQLite DB；`/lab stats` |

共享层机制：bundled 扩展安装到 `~/.pi-triple/data/shared/extensions/`，逐项 symlink 注入各模板目录（一处更新全局可见）；`.bundled-manifest` 标记平台托管，`pit update --all` 覆盖式同步。

---

## 数据布局

### PTL（`~/.pi-triple/`，`PI_TRIPLE_HOME` 可覆盖）

```
~/.pi-triple/
├── pi-triple.json            # v2 配置（UUID+alias），全局唯一；cwd 的 pi-triple.json 为项目级覆盖
├── providers.json            # provider 声明（pit-providers 消费）
└── data/
    ├── pi-config/<uuid>/     # 模板 pi 配置（extensions/skills/settings/models/auth/agent-lab）
    ├── sessions/<uuid>/      # pi session 文件
    ├── workspaces/<uuid>/    # agent 工作目录
    ├── shared/               # 共享扩展/技能 + agent-lab.db
    ├── mailbox/<uuid>/       # pit-communicate 邮箱
    └── flows/<runId>/        # ★ pit-flow 运行态
        ├── graph.json · meta.json · state.json
        ├── checkpoints/ · waves/ · graph.history/
        └── pending.json · exec.lock · mutation.lock
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
pit submit ./my-agent
  → pack.ts 读 agent.json（manifest.ts 校验）+ skills → ustar.ts 打 tar
  → POST /api/v1/programs（ProgramStore：INCR 版本 + 安全解包）
pit run my-agent key=val
  → POST /api/v1/programs/my-agent/run → AgentEngine 起一次性 session
  → SSE 双信封 {seq,type,data} 直推 → pit 解包渲染 → 流结束自动销毁 session
```

### B. pit-flow 波次执行

```
pit flow run flow.json k=v
  → createRun（校验图 + 初始化 state/epoch）→ acquireExecLock
  → 波循环：findReadyNodes（firedEpoch/consumed）→ 同波并行 spawn pi
     → 波末 reducer 合并 state + 写波 checkpoint + 推进 firedEpoch
     → 检查 editRequested 屏障（停于 editing）/ human gate（停于 waiting_human）
  → 无就绪节点 → done / needs-hunger → failed
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
| **PTL 零依赖** | 扩展与 pit-flow 不引外部包（手写 ustar / expr / fs.watch 替代 chokidar） |
| **原子写** | 所有 JSON 写用 tmp+rename |
| **tmux 传参** | `-e KEY=VAL` flag，禁 shell 字符串拼接 |

PTH 完整硬约束 C1–C10 见 [`docs/pth/architecture.md`](./docs/pth/architecture.md#硬约束详解)。

---

## 技术栈

Node.js ≥22 · TypeScript 5.7 · pi SDK 0.82 · React+Ink（PTL TUI）· tmux（PTL）· Fastify 5 + ioredis 5 + bullmq 5 + pino 9 + prom-client 15（PTH）· SQLite WAL（lab-data）· vitest 3（447 tests）。

## 开发

```bash
npm run build          # tsc → dist/（pit/pth bin 跑编译产物，改 src 后必须重建）
npm run pit:dev        # tsx 直跑 PTL（开发）
npm run pth:dev        # tsx watch 直跑 PTH（开发）
npm test               # vitest run（447）
npm run lint           # tsc --noEmit
```

> ⚠️ `lint`（`tsc --noEmit`）**不产出** dist；`pit`/`pth` bin 跑 `dist/`，故端到端验证前必须 `npm run build`。vitest 直跑 TS 会掩盖未重建问题。
