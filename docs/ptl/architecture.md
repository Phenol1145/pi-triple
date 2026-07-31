# PTL（Pi-Triple-Lite）架构

> PTL（Pi-Triple-Lite）文档 — 轻量开发/调试工具链
> 双产品全景见顶层 [`ARCHITECTURE.md`](../../ARCHITECTURE.md)。

## 设计哲学

PTL 是**以 pi 原生 TUI 为核心的本地开发工作台**。不维护自己的 agent runtime，不跑服务进程，不做请求路由——只做一件事：**让多个 pi 进程以模板隔离的方式，在 tmux 里高效并行**。

**核心原则**：
- **pi 是引擎，PTL 是壳**：不多包装一层 API 把 pi 变成 SDK，而是启动真正的 pi 进程，享受原生 TUI 体验
- **模板 = agent 配置蓝图**：每个模板有独立的配置目录（extensions/skills/settings/models）、session 目录、workspace
- **tmux 是运行时载体**：多会话复用同一个终端，后台保活，`switch-client` 瞬移切换
- **共享层 = 不复制代码**：共享扩展/技能通过逐项 symlink 注入模板目录，一处更新全局可见

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                      pit CLI（入口）                         │
│  pit onboard/start/pi/ui/lab/template/config/doctor/install… │
├──────────────────────────────────────────────────────────────┤
│  pit TUI (Ink)               │  pi 进程 × N (tmux)          │
│  ┌──────────┐ ┌────────────┐ │  ┌────────┐ ┌────────┐      │
│  │ pit tui  │ │ lab ui     │ │  │ process│ │ process│ ...  │
│  │ 控制面板  │ │ 模型调试   │ │  │ tmpl   │ │ tmpl   │      │
│  └──────────┘ └────────────┘ │  │ A      │ │ B      │      │
├──────────────────────────────┤  └────────┘ └────────┘      │
│  共享层 (shared/)             │                              │
│  extensions/ skills/ git/    │  pi 配置（per-template）      │
│  npm/ agent-lab/             │  extensions/ skills/          │
├──────────────────────────────┤  settings.json models.json    │
│  ~/.pi-triple/               │  sessions/ workspaces/        │
│  ├── pi-triple.json          └──────────────────────────────┤
│  ├── providers.json                                          │
│  └── data/                                                   │
│       ├── pi-config/<uuid>/                                  │
│       ├── sessions/<uuid>/                                   │
│       ├── workspaces/<uuid>/                                 │
│       ├── shared/                                            │
│       ├── mailbox/<uuid>/                                    │
└──────────────────────────────────────────────────────────────┘
```

## pit CLI 命令体系

### 命令分组

| 分组 | 命令 | 说明 |
|------|------|------|
| **启动** | `pit start` / `pit pi` | tmux 管理模式 / 原生前台 |
| | `pit start --bg --name <n>` | 纯后台 tmux |
| **会话** | `pit ls` / `pit attach` / `pit stop` | 列出/接入/停止会话 |
| | `pit switch` / `pit detach` | 瞬移/脱离（tmux 内） |
| **TUI** | `pit tui dashboard` | 系统总控 TUI |
| | `pit tui lab` | agent-lab 模型调试 TUI |
| **模板** | `pit template ls/new/rm/rename` | UUID + alias 管理（agent 配置蓝图） |
| **配置** | `pit config/get/set/unset` | 读写 pi-triple.json |
| **扩展** | `pit install/remove/update` | pi 扩展管理 |
| | `pit shared status/init` | 共享层操作 |
| **运维** | `pit onboard/doctor/status` | 导引/诊断/状态 |
| | `pit migrate` | 从 ~/.pi/agent 迁移 |
| **流程** | `pit flow run/status/show/ls` | pit-flow 波次工作流引擎 |
| | `pit flow approve/reject/resume` | human gate 审批 / 恢复 |
| | `pit flow set/edit/propose/discard` | 运行中热修改（停波护栏） |
| **桥** | `pit hub submit/run/dev` | PTL→PTH agent 程序提交/运行 |
| | `pit hub programs` | 列出 PTH 上的程序 |

### 模式分辨

```
pit start                      → print 模式（直接启动 pi/tmux）
pit config get redis            → print 模式（输出纯文本值）
pit config get redis --json     → JSON 模式（`{"ok":true,"data":"redis://..."}`）
pit tui dashboard               → 交互 TTY → 系统总控 TUI
                                 → 非 TTY   → "TUI 需要交互式终端"
pit                             → 打印上手指引
```

所有参数解析在 `src/ptl/pit/args.ts`，模式路由在 `src/ptl/pit/mode.ts`。

## tmux 会话生命周期

```
pit start --template local
  │
  ├─ configureTmuxServer()           ← set-option -g extended-keys on | csi-u
  ├─ resolveTemplateAndMigrate()     ← 模板别名→UUID + 首次自动迁移 ~/.pi/agent
  ├─ runDoctor("quick")             ← Node.js/pi/Redis/API key 快速检查
  ├─ buildPiLaunch(templateId, opts)  ← 构建 pi 命令+env（PI_CODING_AGENT_DIR 等）
  │
  ├─ tmux new-session -s pit-<name> -c <cwd>
  │    -e PI_CODING_AGENT_DIR=... -e PI_TEMPLATE=...
  │    -- pi [args]
  │
  └─ 前端 attach 模式：tmux attach（终端接管）
     后端 --bg 模式：tmux new-session -d（后台运行）
     tmux 嵌套：new-session -d + switch-client（瞬移）
```

关键模块：`src/ptl/tmux.ts`（会话命名/构建/列表/存活检查）、`src/ptl/launcher.ts`（pi 启动参数构建）、`src/ptl/pit/sessions.ts`（start/pi/attach/switch/detach 命令）。

## 共享扩展层

### symlink 机制

```
~/.pi-triple/data/
├── shared/
│   └── extensions/
│       ├── pit-providers/       ← 统一 provider 后端
│       ├── pit-communicate/     ← 跨会话通信
│       ├── pit-control/         ← 会话内控制
│       ├── workflow/            ← pi 内流程编排（/flow）
│       └── agent-lab/           ← 模型遥测
└── pi-config/<uuid>/
    └── extensions/
        ├── pit-providers → ../../../shared/extensions/pit-providers
        ├── pit-communicate → ../../../shared/extensions/pit-communicate
        ├── pit-control → ../../../shared/extensions/pit-control
        ├── agent-lab → ../../../shared/extensions/agent-lab
        └── my-custom.ts   ← 模板自有扩展（不是 symlink）
```

### 关键函数

- `linkTemplateToShared(templateDir, sharedDir)` — 为每个共享扩展创建逐项 symlink（不覆盖模板自有文件），同时清理旧的 `_shared` 目录级 symlink（v1→v2 迁移）
- `ensureTenantLinks(templateDir, sharedDir)` — launcher 启动 pi 前调用
- `installBundledExtensions(sharedDir)` — 首次安装 bundled 扩展到共享层（不覆盖已有）
- `syncBundledExtensions(sharedDir)` — `pit update --all` 覆盖式同步（平台托管）
- `.bundled-manifest` 文件 — 记录平台托管扩展名列表，`syncBundledExtensions` 据此剪枝

详见 `src/ptl/shared-layer.ts`。

## ~/.pi-triple 数据布局

```
~/.pi-triple/
├── pi-triple.json           ← v2 配置（UUID+alias），全局唯一
├── providers.json           ← provider 声明（pit-providers 扩展消费）
└── data/
    ├── pi-config/<uuid>/    ← 模板 pi 配置
    │   ├── extensions/      ← （含 _shared symlink）
    │   ├── skills/
    │   ├── git/ npm/
    │   ├── settings.json
    │   ├── models.json
    │   ├── presets.json
    │   ├── auth.json
    │   └── agent-lab/       ← 模板本地 config/pin/arena/workloop
    ├── shared/
    │   ├── extensions/      ← 共享扩展
    │   ├── skills/
    │   ├── git/ npm/
    │   └── agent-lab/       ← 共享 telemetry DB（agent-lab.db）
    ├── sessions/<uuid>/     ← pi session 文件（--session-dir）
    ├── workspaces/<uuid>/   ← Agent 工作目录
    ├── mailbox/<uuid>/      ← pit-communicate 邮箱
    └── flows/<runId>/       ← pit-flow 运行态（graph/meta/state/checkpoints/waves/locks）
```

配置驱动：`src/ptl/config.ts`，全局查找路径由 `PI_TRIPLE_HOME` 或 `pitHome()` 决定（默认 `~/.pi-triple`）。

## 扩展生态

### pit-providers — 统一 Provider 后端

声明式 provider 注册。`~/.pi-triple/providers.json` 定义所有 provider（kimi/ustc-llm/suntomb），扩展用 `registerProvider` 自动注册。支持：

- **单 Key 模式**：`apiKeyEnv` 环境变量
- **多 Key 模式**（`multiKey: true`）：Key 池 + `after_provider_response` 401/403 自动 failover
- **`/keys` 命令**：跨所有 multiKey provider 的统一 Key 管理（`/keys <p> switch/check/list`）
- **动态模型刷新**：`refreshModels` 从 `{baseUrl}/models` 拉取

新增 provider = 往 `providers.json` 加一段 JSON，零代码。

### pit-communicate — 跨会话通信

同一机器上不同 pi 会话间的消息传递（文件邮箱模式）。

- **收发**：`/pit send <name> <msg>` / `/pit ask <name> <q>` / `/pit inbox`
- **审核模式**：`manual`（默认，人工 `/pit accept`）/ `auto`（自动注入下轮）/ `hybrid`
- **会话注册**：每个 pi 进程启动时自动注册到 `registry.json`
- **文件分享**：`/pit share <name> <file>`（store-and-forward）
- **审计**：所有消息写入 `audit/{templateId}/{sessionId}/` 不可变日志

mailbox 路径：`~/.pi-triple/data/mailbox/<uuid>/`（模板隔离）。

### pit-control — 会话内控制

pi 内直接管理 tmux 会话。替代 `Ctrl+B d/s`。

```
/control start <name>   ← 起后台 session
/control stop <name>    ← 杀
/control ls             ← 列出 pit-* 会话
/control switch <name>  ← 瞬移（switch-client）
/control detach         ← 脱离当前会话
/control ui             ← 开 pit 控制面板
```

### agent-lab — 模型遥测

记录每次 LLM 调用的 token/cost/latency，提供选型数据。

- **共享 DB**：`~/.pi-triple/data/shared/agent-lab/agent-lab.db`（SQLite WAL）
- **本地 DB**：per-template arena/workloop/config/pin
- **`/lab stats`**：支持 `--template <alias>` / `--global` 聚合

### workflow — pi 内流程编排

在 pi 会话里直接驱动 pit-flow 引擎（shell 调 `pit flow` CLI，不 import src/）。

- **`/flow` 命令**：`/flow run <flow.json>` / `/flow status` / `/flow ls` / `/flow set` / `/flow edit`（会话内热修改）
- **LLM 工具**：`flow_run` / `flow_status` / `flow_ls`（让 agent 自主起流程）
- **gate 通知**：human gate 暂停时在会话内提示 approve/reject
- 设计原则：human gate 由人决策，**不提供** `flow_approve` LLM 工具（避免双源）

## pit-flow 波次工作流引擎

`src/ptl/flow/` —— LangGraph 风格的本地工作流引擎，声明式 JSON 图（节点 + 条件边 + 环）。两大特性：**波次并行（BSP）执行** + **运行中热修改**。

### 执行模型

```
波循环（executeWaveLoop）：
  1. findReadyNodes：遍历 firedEpoch/consumed，fired[pred] > consumed[pred→target] 即有未消费完成 → 激活
     · 默认 any-join（任一边激活即触发）；显式 needs:[...] 为 AND-join（所有前驱满足）
  2. 同波就绪节点并行 spawn pi（受 maxParallel 限）
  3. 波末：reducer 合并 state（last-wins/append/concat，按 nodeId 序确定性）
     + 写波 checkpoint + 推进 firedEpoch + 检查屏障
  4. editRequested → 停于 editing；human gate → 停于 waiting_human；无就绪 → done / needs-hunger → failed
```

### 关键机制

| 机制 | 说明 |
|------|------|
| **触发计数** | 每节点 `firedEpoch`、每边 `consumed[pred→target]`；环多轮迭代靠 epoch 递增区分 |
| **Reducer** | 并发写同 key：`append`（收 {node,value} 对）/ `concat`（拼接）/ `last-wins` |
| **Human gate** | `type:"human"` 节点写 pending.json 暂停；`pit flow approve/reject` 应用 writes + 推进 firedEpoch + 恢复 |
| **热修改护栏** | running 中 `set/edit` 排队进 `meta.pendingEdits` 并自动 propose → 引擎在**波边界**停（`status=editing`，`editBaseWave`）→ `resume` 重校验后逐条应用再继续 |
| **双锁** | exec lock（执行）+ mutation lock（改图）分离，允许执行中改图 |
| **失败语义** | drain-on-failure（同波兄弟跑完）；失败节点回滚入边消费，**仅外部 resume 重跑**（failedThisRun 防同进程无限重试）；needs-hunger 检测不可满足的 AND-join |

### 模块与命令

模块：`engine.ts`（波循环）· `schema.ts`（校验）· `store.ts`（runs/checkpoints/waves/locks）· `expr.ts`（手写表达式）· `template.ts`（`{{state.x}}` 插值，对象/数组 JSON 序列化）· `reducers.ts` · `edit.ts`（set/edit/approve/reject/propose/discard/resume）· `commands.ts` · `pm.ts`（spawn pi）。

命令：`pit flow run/status/show/ls/validate/graph/rm` + `approve/reject/resume` + `set/edit/propose/discard`。

示例：`examples/pr-review/`（串行 + human gate）· `examples/arena-review/`（并行 fan-out + append reducer）。

## PTL→PTH 桥

`src/ptl/bridge/` —— 把 PTL 本地开发的 agent 程序（`agent.json` manifest + skills + systemPrompt）打包提交到 PTH 运行。

```
pit hub submit ./my-agent
  → pack.ts 读 agent.json（manifest.ts 校验）+ skills → ustar.ts 打 tar（零外部依赖）
  → POST /api/v1/programs（PTH ProgramStore：INCR 版本 + tar 安全解包 + GC）
pit hub run my-agent key=val
  → POST /api/v1/programs/my-agent/run → AgentEngine 起一次性 session
  → SSE 双信封 {seq,type,data} 直推 → pit 解包渲染 → 流结束自动销毁 session
pit hub dev ./my-agent      ← 本地直跑（pipe.ts 注入 systemPrompt+skills 到 pi 启动参数）
pit hub programs            ← 列出 PTH 上的程序
```

模块：`client.ts`（PTH HTTP 客户端）· `pack.ts` + `ustar.ts`（打包）· `manifest.ts`（校验）· `submit.ts` / `run.ts` / `dev.ts` / `programs.ts`（命令）· `pipe.ts`（本地注入）。服务端见 PTH `programs/store.ts` + `gateway/routes-programs.ts`。

## lab 遥测数据层

`src/ptl/lab-data/` —— `pit tui lab` TUI 的数据底座。SQLite（WAL + busy_timeout）：共享 `runs` DB（跨模板 LLM 调用遥测）+ per-template arena/events/config。模块：`telemetry.ts` · `arena.ts` · `events.ts` · `open-db.ts` · `schema.ts`。

## TUI 模板规范

PTL 包含两个 Ink TUI：

| TUI | 命令 | Tab 主题 |
|-----|------|---------|
| pit tui | `pit tui dashboard` | Dashboard / Templates / Sessions / Extensions / Config |
| lab ui | `pit tui lab` | Telemetry / Arena / Events / Compare / Config |

两者共用统一的 `Screen` 布局模板和 `tui-shared/` 组件库。规范详见 `src/ptl/tui-shared/README.md`。核心契约：

1. **Head** 只放标题/版本/状态/Tab — 不放交互组件
2. **Content** 只放当前激活页面 — 页面组件接收 `{ width, height, enabled }` 契约
3. **Tips** 只放一行快捷键提示 — 格式 `[key] action · [key] action`
4. 弹层打开时传 `enabled={false}` 门控页面输入
5. 终端切换走 `unmountInk()` → `stdin.pause()` → `spawnSync(stdio: "inherit")` → `process.exit(status)`

共享组件：`Screen`（布局）、`DataTable`（表格）、`SelectList`（列表选择）、`ConfirmDialog`（确认框）、`SparkLine`/`BarChart`（图表）、`useTabs`/`useRefresh`/`useTerminalSize`（hooks）、`CommandBar`（层级渐进式命令补全——pit tui 和 lab ui 共享）。

## 与 PTH 的关系

```
PTL (Lite)                   PTH (Heavy)
────────────                 ────────────
本地终端 · 手动交互          服务器 · 程序化 API
pi 进程 × tmux               AgentEngine × Redis
个人/小组                    团队/联邦
pit CLI                      HTTP/SSE/WebSocket

        ───── 桥（已实现）─────
   pit hub submit/run → PTH ProgramStore 运行
```

PTL 生产的 agent 程序（`agent.json` + skills）可通过 `pit hub submit` 打包提交到 PTH，`pit hub run` 以联邦模式运行（SSE 流式回显）。PTH 提供集中治理、审计、弹性伸缩，PTL 提供本地开发/调试体验。桥的实现见上文「PTL→PTH 桥」节。
