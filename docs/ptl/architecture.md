# PTL（Pi-Triple-Lite）架构

> PTL（Pi-Triple-Lite）文档 — 轻量开发/调试工具链（v0.6+ 形态）
> 双产品全景见顶层 [`ARCHITECTURE.md`](../../ARCHITECTURE.md)。

## 定位

PTL 是**以 pi 原生 TUI 为核心的本地开发工作台**。不维护自己的 agent runtime，不跑服务进程——只做一件事：**让多个 pi 进程以模板隔离的方式，在 tmux 里高效并行**，并作为 **PTH（服务器端任务内核）的运维/交互前端**。

**核心原则**：
- **pi 是引擎，PTL 是壳**：启动真正的 pi 进程（原生 TUI），不多包一层 API 把 pi 变成 SDK
- **模板 = agent 配置蓝图**：每个模板独立配置目录（extensions/skills/settings/models）、session 目录、workspace
- **tmux 是运行时载体**：多会话复用同一终端，后台保活，`switch-client` 瞬移切换
- **共享层 = 不复制代码**：共享扩展/技能/skill 逐项 symlink 注入模板目录，一处更新全局可见
- **PTH 双桥 = 交互层延伸**：PTL 会话即交互层——任务发布/容器运维不离开 CLI

## 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                    ptl CLI（packages/framework）                  │
│  start/pi/session族/template/config/tui/hub族/agent/doctor/install │
├──────────────────────────────────────────────────────────────────┤
│  packages/framework/src/                                         │
│  ├── cli/      main(入口/help) route(路由) sessions(会话) args    │
│  ├── bridge/   hub 双桥：submit/kernel/containers/debug/observe… │
│  ├── containers/ 容器抽象（v0.7）：deployment/backend/docker      │
│  ├── session/  纸带：pi-scan/pi-provider/session-store/trace      │
│  ├── tui-ptl/  TUI 总控面板（Ink）  │  tui-lab/  模型调试面板     │
│  ├── lab-data/ arena/telemetry（模型竞技数据）                    │
│  └── shared-layer.ts 共享层 symlink 注入                          │
├──────────────────────────────────────────────────────────────────┤
│  packages/shared/  @pi-triple/shared 基础件                       │
│  config/tmux/registry/session-state/presence/output/             │
│  template-agents/version-check/warnings                          │
├──────────────────────────────────────────────────────────────────┤
│  ~/.pi-triple/  PTL 数据根                                        │
│  ├── pi-triple.json / providers.json（配置）                     │
│  ├── data/pi-config/<uuid>/   每模板独立配置（extensions/skills） │
│  ├── data/sessions/<uuid>/    纸带（会话记录）                    │
│  ├── data/workspaces/<uuid>/  工作区                             │
│  ├── data/shared/             共享层（skills/扩展——symlink 源）   │
│  └── data/mailbox/<uuid>/     邮箱（agent 间通信）                │
└──────────────────────────────────────────────────────────────────┘
          ↓ PTH 双桥（HTTP :3000）
┌──────────────────────────────────────────────────────────────────┐
│  PTH（Pi-Triple-Heavy）服务器端任务内核                           │
│  Fastify 网关 + kernel 任务池（7 角色正交路由）+ sandbox 隔离执行  │
│  容器化：pth.deployment.json 声明式部署（v0.7）                   │
└──────────────────────────────────────────────────────────────────┘
```

## 命令体系

### 分组（v0.6 瘦身后——flow 引擎 / agent-lab 已归档）

| 分组 | 命令 | 说明 |
|------|------|------|
| **启动** | `ptl start [--template x] [--bg --name n]` | tmux 管理模式 |
| | `ptl pi [--project x]` | 原生前台（无 tmux） |
| **会话** | `ptl ls` / `ptl attach` / `ptl stop` / `ptl restore` | tmux 后台会话管理 |
| **纸带** | `ptl session ls/show/fork/clone/transfer/branch/tree/resume/attach/stop` | 会话记录操作 |
| | `ptl trace ls/show/timeline <agent>` | 追踪 |
| **TUI** | `ptl tui dashboard` | 系统总控面板（Ink） |
| | `ptl tui lab [--template x] [--global]` | 模型调试/竞技面板 |
| **模板** | `ptl template ls/new/rm/rename` | UUID + alias 蓝图管理 |
| **配置** | `ptl config get/set/unset/init` | pi-triple.json 读写 |
| **agent** | `ptl agent run/clean` | 一次性 agent 实例 |
| **运维** | `ptl onboard/doctor/status/install/remove` | 导引/诊断/扩展 |
| | `ptl shared status/init` | 共享层操作 |
| **PTH 桥** | `ptl hub submit/run/dev/programs` | agent 程序提交/远端运行 |
| | `ptl hub kernel tasks/batch/status` | PTH 任务发布/batch 控制 |
| | `ptl hub observe/debug/request/respond` | 观测/调试/回退 |
| | `ptl hub deploy/status/logs/upgrade/exec` | 容器运维（v0.7 新增） |

### 模式分辨

```
ptl start                      → print 模式（直接启动 pi/tmux）
ptl config get redis            → print 模式（纯文本值）
ptl config get redis --json     → JSON 模式（`{"ok":true,...}`）
ptl tui dashboard               → 交互 TTY → TUI；非 TTY → "TUI 需要交互式终端"
ptl                             → 上手指引
```

参数解析 `src/cli/args.ts` · 模式路由 `src/cli/mode.ts` · 命令分发 `src/cli/route.ts` + `src/commands/dispatch.ts`。

## 模板与配置

- **模板 = agent 配置蓝图**：`pi-triple.json` 的 `templates` 表——alias/UUID/provider/model/tools 声明
- **per-template 隔离**：`~/.pi-triple/data/pi-config/<uuid>/` 独立配置目录（extensions/skills/settings/models）——PTL 注入式布局（非裸 pi 目录）
- **共享层注入**：`data/shared/` 的扩展/skills 逐项 symlink 进模板配置目录——一处更新全局可见（`pit shared status` 检查链接状态）

## 会话与纸带

- **tmux 运行时**：命名 `ptl-<name>`（v0.6 起——`pit-` 为改名前的历史前缀，`ptl ls` 不识别旧命名）
  - `ptl start` 创建并接入 · `--bg` 纯后台 · `switch-client` 瞬移
- **registry**：`data/pi-config/*/registry.json` 登记会话（templateId/model/状态机 ●运行/○空壳/×孤儿）
- **纸带（session 族）**：pi 会话记录（tapes）——fork/clone/transfer/branch/tree/resume 操作——`session/pi-scan.ts` 扫描恢复

## PTL→PTH 双桥

PTL 作为交互层，经 HTTP 访问 PTH gateway（`/api/v1/*`——Bearer 认证）：

| 通道 | 命令 | 形态 |
|------|------|------|
| 任务池 | `ptl hub kernel tasks add/ls` | 文本/代码/模板参数 → batch 池化 worker 认领 |
| batch 控制 | `ptl hub kernel batch add/remove` | 扩缩容 |
| 状态全景 | `ptl hub kernel status` | 批/任务/watchdog 状态 |
| 程序桥 | `ptl hub submit <dir>` | agent 程序目录（manifest+skills+systemPrompt）→ AgentEngine 一次性 session（SSE 流） |
| 观测 | `ptl hub observe/debug` | Redis 会话痕迹 / WebSocket 接入 sandbox 调试 |
| 容器运维 | `ptl hub deploy/status/logs/upgrade/exec` | 容器抽象（v0.7） |

任务路由正交化：flow 显式 → tags 语义 → hash 分片（确定性归属角色——零竞速）。

## 容器抽象（v0.7）

```
pth.deployment.json（声明式部署描述——事实源）
  ├─ 四服务拓扑（pi-platform/sandbox/postgres/redis）
  ├─ env（PTH_* 全保留）/卷/健康检查/限额/sandbox internal 零出口契约
  └─ 与 docker-compose 方言解耦
        ↓ ContainerBackend 接口（up/down/status/logs/restart/exec/available）
docker compose 渲染（已实现） | podman/k8s（扩展点）
```

代码：`packages/framework/src/containers/`（PTL 侧运维库——不依赖 PTH 服务器端代码）。渲染产物 `pth.deploy/`（gitignore）。

## 归档物（archive/）

PTL 瘦身（2026-08-09）归档的四目录——保留代码不编译，恢复指南见 `archive/README.md`：

| 目录 | 内容 | 状态 |
|------|------|------|
| `agent-lab/` | 80k 行（含 .pi-subagents） | 归档（lab 面板保留在 framework） |
| `agent-lab-bidder/` | 竞价工具 | 保留 0.7/0.8 复用意向 |
| `framework-flow/` | workflow 波次引擎 | 归档（放弃 workflow engine） |
| `workflow-ext/` | flow 扩展 | 归档 |

## 数据目录布局

```
~/.pi-triple/
├── pi-triple.json          PTL 配置（templates/providers/pth.url/token）
├── providers.json          模型 provider 凭据
└── data/
    ├── pi-config/<uuid>/   模板独立配置（PTL 注入布局）
    ├── sessions/<uuid>/    纸带会话记录
    ├── workspaces/<uuid>/  工作区
    ├── shared/             共享层（skills/扩展——symlink 源）
    └── mailbox/<uuid>/     邮箱
```

## 与 PTH 的关系（双产品）

- **PTL（Lite）= 交互层**：多 pi 并行工作台 + PTH 运维前端——本仓库 `packages/framework` + `packages/shared`
- **PTH（Heavy）= 执行层**：服务器端任务内核——`src/pth/`（网关/kernel/sandbox）+ `src/sandbox/`
- 边界：PTL 不跑服务进程；PTH 不占本地终端——HTTP/SSE/WebSocket 契约衔接

相关：`docs/ptl/authoring.md`（模板编写）· `docs/ptl/pth-task-submission.md`（任务提交）· `docs/pth/deployment.md`（容器部署）。
