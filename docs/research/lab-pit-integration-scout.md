# Lab ↔ Pit 集成面侦察报告

> 日期：2026-07-29
> 目的：为 "lab 调度器 + subagent 派发使用 pit 租户/会话管理" 提供事实依据
> 范围：只调研、不写代码

## 核心发现摘要

1. **pi-subagents 用 `child_process.spawn` 起独立 pi 进程**，非进程内——已具备"独立进程载体"，但**不由 pit 管理**（无 tmux、无租户切换）。
2. **subagent 继承父进程 env（含 PI_CODING_AGENT_DIR）**→ **运行在父会话的同一租户内**——没有 agent 级租户隔离。
3. **lab 拦截器只改写 `input.model` 字符串**——Arena/weighted-scorer 做的"agent 选择"本质是字符串替换，不涉及 pit 租户/会话/工作区管理。
4. **pi-subagents 的 AgentConfig 结构与 pit 租户配置高度同构**（model/tools/extensions/skills/systemPrompt/work-dir），是天然接合面。
5. **pit launcher 的 `buildPiLaunch(tenantId)` 提供完整的租户隔离 pi 进程热备**（PI_CODING_AGENT_DIR + per-tenant workspace + session-dir + tmux 会话管理），恰是 lab 调度器"agent 实例"可以映射的载体。

---

## 1. pi-subagents 的 subagent 派发机制

### 1.1 独立进程 spawn

- **入口**：`src/runs/foreground/execution.ts:365-368`
```ts
const spawnSpec = getPiSpawnCommand(args);
const proc = spawn(spawnSpec.command, spawnSpec.args, {
  env: spawnEnv,   // { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(...) }
});
```
- `getPiSpawnCommand`（`src/runs/shared/pi-spawn.ts:134-151`）：优先读 `PI_SUBAGENT_PI_BINARY` env → 用 `@earendil-works/pi-coding-agent` 的 cli 脚本 + `process.execPath`（node）→ 回退到 `pi` 命令。
- **结论**：subagent 是**真实独立进程**（Node.js child_process），已有独立 pi 运行的工程基础。

### 1.2 继承父进程 env → 同租户

- `spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(...) }`（execution.ts:360）
- **PI_CODING_AGENT_DIR 来自 process.env**（由 pit 的 `buildPiLaunch` 设置），subagent 不覆盖它。
- `buildPiArgs`（`src/runs/shared/pi-args.ts`）设置大量子代理专属 env（`PI_SUBAGENT_CHILD`、`PI_SUBAGENT_RUN_ID` 等），但**不含** `PI_CODING_AGENT_DIR`、`PI_TENANT`。
- **结论**：subagent 进程跑在**父会话的同一租户配置目录**下——所有 subagent 共享一个 PI_CODING_AGENT_DIR。

### 1.3 模型如何传入

- pi-subagents 的 `AgentConfig.model`（`src/agents/agents.ts:121`）定义 subagent 默认模型。
- 父会话 `tool_call(subagent, {model: "xxx"})` 的 `input.model` 优先于 AgentConfig.model。
- `buildPiArgs` 收 `model: modelArg` → 转成 `--model` flag 传给 pi（pi-args.ts 后续）。
- **结论**：lab 拦截器改 `input.model` 的效果→最终落地为 `pi --model <selected>` 命令行参数。

### 1.4 进程管理：不由 pit

- pi-subagents 有自己的**进程管理基础设施**：
  - `background/subagent-runner.ts`：后台跑 + watchdog
  - `background/async-execution.ts`：异步执行
  - `watchdog/` 目录：子进程状态/诊断/渲染/评审
  - `foreground/foreground-control.ts`：前台控制通道
  - 会话文件：`options.sessionDir`（per-subagent-run 的 session file）
- **但不用 pit**：无 tmux 会话、无 `pit start`、无 `pit attach/switch/stop/ls`。
- **结论**：具备自己的一套进程管理，但不可见/不可切换/不可经 pit 控制。

---

## 2. lab 调度器如何介入 subagent 派发

### 2.1 拦截点

- `src/interceptor/register.ts:19-55`：`pi.on("tool_call", async (event, ctx) => {})`
- 仅当 `event.toolName === "subagent"` 且 `cfg.scheduler?.enabled` 时介入。
- 调用 `decideSchedulerSelection({role, task, toolCallId, cfg}, {runtime, modelAllowed})`。

### 2.2 dispatch 调用

- `src/interceptor/scheduler-bridge.ts:67-130`：
  - 构建 `DispatchRequest { schedulerInstanceId: cfg.scheduler?.instanceId ?? "default-weighted-scorer", mode: "select", ... }`
  - 调用 `runtime.dispatch(request)` → `DispatchResult`。
  - 若 `completed` + model 在 scope → `{action:"apply", model, source:"scheduler"}`。
- **当前影响**：只改写 `input.model = decision.model` → subagent 用 arena 选的模型运行。

### 2.3 "AgentInstance" 的角色

- `lab_agent_instances` 表：agent-arena-{model} / agent-{model} — 登记在册的"agent"。
- `ensureArenaInstance` / `syncArenaAgents`：从模型目录候选映射出来、插入 `lab_agent_instances`。
- **实际派发时**：`arena-scheduler.schedule()` 用 `ports.candidates()`（模型目录）+ `ledger`（经济账本）做出价/冻结/选主——**没有走 `SchedulerSDK.agents.run()` 经 AgentInstance 的 WorkLoop 执行**（spec §9.2 的完整路径尚未实现）。
- **结论**：lab 的 AgentInstance 目前只是"登记在册"的数据记录，真实执行由 pi-subagents 代劳。调度选择的输出是一个 model id 字符串，不是 AgentInstance 引用。

---

## 3. pit 租户管理 + 会话管理提供什么

### 3.1 `buildPiLaunch(tenantId)`（`src/ptl/launcher.ts:65-140`）

产出完整隔离的 pi 启动热备：
```ts
{
  cmd: "pi",
  args: [..., "--session-dir", tenantSessionsDir, ...],
  env: {
    PI_CODING_AGENT_DIR: /data/pi-config/<uuid>,   // ★ 租户特定配置（extensions/skills/settings/models/auth）
    PI_TENANT: <uuid>,
    PI_TENANT_ALIAS: <alias>,
    PI_SESSION_ID: <new uuid>,
    AGENT_LAB_DB_PATH: /data/shared/agent-lab/agent-lab.db,
    AGENT_LAB_CONFIG_DIR: /data/pi-config/<uuid>/agent-lab,
  },
  cwd: /data/workspaces/<uuid>/<project>,           // ★ 隔离工作区
}
```

**对比 pi-subagents 的 `buildPiArgs`**：
| 维度 | pit `buildPiLaunch` | pi-subagents `buildPiArgs` |
|------|---------------------|---------------------------|
| 租户配置 | ✅ PI_CODING_AGENT_DIR | ❌ 继承父进程（同租户） |
| 工作区隔离 | ✅ per-tenant workspace | ❌ 继承 cwd 或指定的 cwd |
| 会话管理 | ✅ session-dir（per-tenant）+ PI_SESSION_ID | ✅ 自己的 session-dir（per-run） |
| lab 配置 | ✅ AGENT_LAB_DB_PATH + CONFIG_DIR | ❌ 不设置 |
| tmux | ✅ pit start 托管 | ❌ 无 |

### 3.2 pit 会话管理（`src/ptl/pit/sessions.ts` + `src/ptl/tmux.ts`）

- `cmdStart`：tmux 会话创建 + 接入（`tmux new-session -s pit-<name>`）
- `cmdAttach`/`cmdSwitch`/`cmdDetach`：tmux switch-client / detach
- `cmdLs`/`cmdStop`：会话列表/停止
- pit-control 扩展：`/control start/stop/ls/switch/detach/ui` — pi 会话内管理 tmux

### 3.3 共享扩展层（`src/ptl/shared-layer.ts`）

- 逐项 symlink 注入租户配置（extensions/skills）
- `ensureTenantLinks`：启动前确保共享层链接到位

### 3.4 租户配置（`src/ptl/config.ts`）

- v2 UUID + alias 模型
- 全局 `~/.pi-triple/pi-triple.json` + 项目级 `pi-triple.json`
- 每租户：extensions/skills/settings/models/auth/agent-lab

---

## 4. 现有连接点（lab ↔ pit）

| 连接 | 存在？ | 证据 |
|------|--------|------|
| lab-data 用 pi-triple 路径 | ⚠️ 部分 | `lab-data/open-db.ts` 读 `$DATA_DIR` 默认 `./.pi-platform-data`（PTH 默认），不默认 `~/.pi-triple/data`——这是已知 bug（TUI "DB offline"） |
| agent-lab 作为共享扩展 | ✅ | 扩展 symlink 进租户（`pi-config/<uuid>/extensions/agent-lab → shared/extensions/agent-lab`） |
| `buildPiLaunch` 设 `AGENT_LAB_DB_PATH` | ✅ | launcher.ts:129-130：`AGENT_LAB_DB_PATH: path.join(sharedDir, "agent-lab", "agent-lab.db")` |
| lab interceptor 感知 PI_CODING_AGENT_DIR | ⚠️ 间接 | model-scope.ts:8 读 `process.env.PI_CODING_AGENT_DIR ?? "~/.pi/agent"` 的 settings.json（subagents.modelScope.allow） |
| subagent 派发经 pit | ❌ | pi-subagents spawn 自己管理，不与 pit 通信 |
| lab AgentInstance ↔ pit tenant | ❌ | AgentInstance 是 lab 内部概念，不映射到 pit 租户 |

---

## 5. 集成路径分析

### 路径 A：lab 调度器经 pit launcher 起 agent（深度集成）

**思路**：lab dispatch 选定模型后，不改写 `input.model`，而是调用 `buildPiLaunch(agentTenantId, {model: selectedModel})` 起一个**租户隔离的 pit tmux 会话**作为"agent 实例"。pi-subagents 的 subagent runner 退位为 pit 的 runtime adapter。

**改动点**：
1. `lab scheduler-bridge.ts`：`decideSchedulerSelection` 返回的不是 `{action:"apply", model}` 而是 `{action:"spawn", tenantId, model, sessionOpts}`
2. `lab interceptor/register.ts`：`action==="spawn"` 时调 `buildPiLaunch` + `pit start --bg` 起会话，而非改写 input.model
3. pi-subagents 侧的 `tool_call(subagent)` → 检测到 `action==="spawn"` 时走 pit adapter（新的 execution path），而非 `buildPiArgs` + `spawn`
4. agent 的 session-dir / workspace 由 pit 按租户管理
5. arena settle 时结算与 agent 余额绑在 ledger 不变，但"agent 身份"从 `agent-arena-<modelId>` 映射到 `tenantId`

**难点**：
- 大改动（lab + pi-subagents 两侧），当前 `tool_call` 事件模型不支持"不 spawn 子进程"语义（subagent 工具期望 spawn 进程并返回结果）。需要新增一套"pit-subagent"工具或事件。
- pi-subagents 的 `AgentConfig` 渲染目前是同步 JSON 拼接 + 命令构建；替换为 pit launch 需要打破其内部的 execution/runner 封装。
- tmux 会话管理语义不同（pi-subagents 期望 await 进程退出并捕获 stdout；tmux 后台会话不直接返回 stdout）。

**与 spec 关系**：接近全局架构 spec §9.2 的完整路径——Scheduler 经 SDK `agents.run()` 执行 AgentInstance 的 WorkLoop。但当前 WorkLoop/Agent Runtime 尚未实现。


### 路径 B：subagent 获取租户隔离（中等集成）

**思路**：不改 lab 的 model-rewrite 模式，而是让 pi-subagents 的 `buildPiArgs`/spawn 支持**指定 PI_CODING_AGENT_DIR**——让每个 subagent 可以跑在不同租户的配置下。lab 调度器在改写 `input.model` 的同时，也改 `input.tenant`（或加一个 tenant 字段），pi-subagents 据此设置 PI_CODING_AGENT_DIR 而非继承父进程。

**改动点**：
1. pi-subagents `spawnEnv` 加逻辑：如果 input 含 `tenantId`，设置 `PI_CODING_AGENT_DIR = resolveTenantConfig(tenantId)`
2. lab interceptor：`decideSchedulerSelection` 返回时附加 `tenantId`（arena agent → tenant 映射）
3. pit 侧：`buildPiLaunch` 导出 `resolveTenantConfig(tenantId)` 供 pi-subagents 调用（或通过 env 约定）
4. arena agent 的 `lab_agent_instances` → tenant 映射存于 agent 的 `definition.custom` 或独立映射表

**难点**：
- pi-subagents 是独立 npm 包（pi-subagents@0.37.0），修改需升级包版本。
- tenant 映射谁维护？arena agent 创建时自动建 tenant？还是预先手工建好 tenant 再关联？
- 工作区隔离：subagent 的 cwd 需改为 per-tenant workspace（pi-subagents 已支持 `cwd` 参数，pass-through 即可）。

**与 spec 关系**：最小化侵入——不改 lab 调度器的核心选择逻辑，不改 interceptor 的 model-rewrite 模式，只在 subagent spawn 层加租户隔离。spec 的 AgentInstance 概念仍然只是"登记"，不改调度→执行的主干。


### 路径 C：pit 作为 lab 的 runtime backend（pit 驱动 lab）

**思路**：反过来——让 pit 成为 lab 的"SchedulerSDK.agents.run()"实现。pit 提供 `pit lab-agent start <role> --tenant <id>` 命令（lab 在 console 里调 pit），pit 负责起 tmux 会话、配 PI_CODING_AGENT_DIR、管理生命周期。lab 调度器通过 `pit` CLI 或内部 API 驱使其"agent 实例"。

**改动点**：
1. pit 新增 `pit agent start/stop/status` 子命令：等同于 `pit start --bg --name agent-<role>-<id>` + 自动配 PI_CODING_AGENT_DIR
2. lab scheduler-bridge 的 `dispatch` 返回后，调 `pit agent start --model <selected> --role <role> --tenant <agentTenant>` 等待结果
3. pit 侧 `buildPiLaunch` 暴露为编程 API（导出 + 可用 import 而非 CLI）

**难点**：
- lab 调度器目前是同步 rewrite → subagent 工具自己 spawn。改成"pit agent start + await"需要 pi-subagents 侧支持"外置 agent 执行器"模式。
- pit CLI 需要编程 API（已有 `launchPi` + `buildPiLaunch`，但缺少"后台启动 + 等待结果 + 返回退出码/输出"的编程接口）。

**与 spec 关系**：让 pit 成为 spec §9.2 的 Runtime 后端——"Scheduler SDK 加载 AgentInstance 和 WorkLoop……Scheduler SDK 检查 single-flight……Runtime 执行"。pit 提供了隔离、会话、工作区，lab 提供调度+经济账本。


### 路径 D：多租户 lab（最小改动）

**思路**：不改 subagent 派发机制，而是让 lab 本身"多租户化"——每个 pit 租户运行自己的 lab 配置（独立的 scheduler instance、agent 群体、账本）。lab 数据的路径断裂（已知 bug）先行修好，让每个租户的 `AGENT_LAB_CONFIG_DIR` 指向独立 DB。

**改动点**：
1. 修 `pit lab` TUI "DB offline"——lab-data/open-db.ts 默认 DATA_DIR 改为 `pitHome()/data`
2. lab ledger/tasks 数据从 `lab_agent_instances` 等表按 `tenantId` 隔离（租户 A 的 arena 与租户 B 隔离）
3. `AGENT_LAB_DB_PATH` 已有（`buildPiLaunch` 设了），但 lab 侧 `localConfigDir()` + ledger 的 DB 路径与之不一致——需统一。

**难点**：
- 这是 lab 内部的数据隔离，不改派发机制。不是用户 "lab 调度器装配使用 pit 管理" 的本意（更像"pit 租户多路复用 lab"而非"lab 用 pit 起 agent"）。

**与 spec 关系**：与 spec 的 AgentInstance 属于 SchedulerInstance 一致——不同租户有不同 SchedulerInstance。


## 6. 推荐切入顺序

从改动量最小、解耦最好的路径开始，渐进：

1. **先修数据路径断裂**（lab-data TUI 的 "DB offline" + ledger 路径统一）。基础——不修则任何多租户 talk 都落不了地。
2. **路径 B**（subagent 租户隔离）：最小侵入——不改 lab 选择逻辑、不改 pi-subagents 核心流程，只在 spawn env 层加 PI_CODING_AGENT_DIR 指向。
3. **路径 C**（pit 驱动 lab agent）：pit 加 `pit agent start` 子命令，lab 调度器可选"pit 托管"模式。路径 B 的 subagent 在 pit 托管下就是 tmux 会话——B 到 C 是自然升级。
4. **路径 A**（深度集成）作远期目标——等 WorkLoop SDK + Agent Runtime 实现后（spec §9.2），Arena agent 的执行自然落入 `pit agent start` 的管道。
