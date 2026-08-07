# Scout-7：PTL 侧深度侦察报告（src/ptl/）

> 日期：2026-08-07 · 侦察范围：`src/ptl/` 全部 25 个顶层模块 + 子目录（bridge/commands/flow/lab-data/pit/session）
> 上游上下文：scout-3（src 结构意图）+ 根 `ARCHITECTURE.md`（PTL 定位：**不实现 agent runtime，用 tmux 启动真实 pi 进程**）
> 本报告核心结论先行：**PTL 是 pi 的"多模板会话管理器 + 本地工作流引擎 + PTH 客户端"**，零 agent-lab 代码引用，与 agent-lab 的关系仅为"间接消费（env 注入 + raw SQL 读库 + symlink 注入）"。

---

## 1. PTL 模块职责表（25 个顶层模块）

| 模块 | 一行职责 | 入口/关键导出 | 行号证据 |
|---|---|---|---|
| `pit.ts` | CLI 入口（bin: pit）：先装 node:sqlite ExperimentalWarning 过滤，再延迟加载主流程 | `main()` from `pit/run.js`；re-export `parseArgs`/`resolveOrFail` | pit.ts:1-25 |
| `commands.ts` | 核心命令纯函数层（不 console.log，返回 `CommandResult` 由调用方渲染）：template ls/new/rm、status、ls、stop、start-bg、shared status | `CommandResult` 接口、`execTemplate*`/`execStatus`/`execLs`/`execStop`/`execStartBg`/`execSharedStatus` | commands.ts:29-407 |
| `config.ts` | 中心配置 `pi-triple.json`（v2/v3，模板 UUID+alias，`pth.url/token` 配置，`PI_TRIPLE_HOME` 覆盖） | `PiTripleConfig`、`loadConfig`/`saveConfig`/`resolveTemplateId`/`getTemplateAlias`/`pitHome` | config.ts:1-80+ |
| `doctor-agents.ts` | 检查模板 AGENTS.md 存在且无未渲染占位符 | `checkTemplateAgentsMd` | doctor-agents.ts:1-20 |
| `doctor.ts` | 启动导引 + 健康检查（首次全量交互修复，后续 quick） | `runDoctor`/`runDoctorStructured` | doctor.ts:1-466 |
| `launcher.ts` | **pi 启动参数构建（不执行）**：workspace 隔离 + `--session-dir` + system prompt + 共享层链接 + `PI_*/AGENT_LAB_*` env | `buildPiLaunch`→`PiBuildResult{cmd,args,env,cwd}`、`launchPi`（spawn 前台） | launcher.ts:60-166 (buildPiLaunch)、167-232 (launchPi) |
| `migrate.ts` | 把既有 `~/.pi/agent` pi 配置/扩展/技能迁移到模板（dry-run 支持） | `migrate` | migrate.ts:1-242 |
| `output.ts` | 输出辅助：错误码 `ERR` 常量 + JSON 发射 | `ERR`、`emitJson`/`emitJsonError` | output.ts:1-40 |
| `picker.tsx` | 交互式模板选择器（Ink/React，`pit start` 无参数时用） | `interactiveStart` | picker.tsx:1-162 |
| `pit/` | CLI 子命令实现（10 文件，见 §2） | `args`/`main`/`mode`/`sessions`/`onboard`/`config-cmd`/`admin`/`route`/`agent` | — |
| `session/` | 纸带（pi session JSONL 文件）读侧 + 写侧（fork/clone/transfer/branch）+ trace providers | `pi-scan`/`pi-tree`/`pi-fork`/`pi-provider`/`pi-session`/`session-store`/`trace-provider`/`uuidv7` | session-provider.ts:1-71 |
| `session-registry.ts` | 持久化会话注册表（`data/state/sessions.json`，原子写）——restore 恢复依据 | `loadRegistry`/`markStarted`/`markStopped` | session-registry.ts:1-71 |
| `session-state.ts` | 会话状态机（纯函数）：tmux 存活 + 注册表 → running/empty/orphan | `classifySession`/`isPidAlive` | session-state.ts:1-40 |
| `shared-layer.ts` | **共享扩展层**：bundled `extensions/` 逐项 symlink 注入各模板 + `.bundled-manifest` 剪枝 + `pit update --all` 覆盖式同步 | `linkTemplateToShared`/`ensureTemplateLinks`/`installBundledExtensions`/`syncBundledExtensions`/`promoteToShared` | shared-layer.ts:1-274 |
| `template-agents.ts` | AGENTS.md 模板渲染（`docs/ptl/templates/AGENTS.md.tpl` + `<templateId>/<alias>` 替换），幂等写入模板目录 | `AGENTS_TPL_PATH`/`ensureTemplateAgents` | template-agents.ts:1-32 |
| `tmux.ts` | **tmux 会话管理**：单一命名规则（`pit-` 前缀）、env 注入（仅 `PI_*`/`AGENT_LAB_*`，`-e K=V` 禁 shell 拼接）、csi-u 配置 | `startPitSession`/`buildTmuxSessionArgs`/`listPitSessions`/`listPitPanesDetailed`/`sessionsForTenant`/`killPitSession` | tmux.ts:1-201 |
| `version-check.ts` | 版本比较 + PIT_REPO 更新源 | `compareVersions` | version-check.ts:1-109 |
| `version.ts` | 版本号 + 更新提示（只读缓存零网络） | `getPitVersion`/`maybePrintUpdateHint` | version.ts:1-49 |
| `warnings.ts` | ExperimentalWarning 过滤（node:sqlite） | `installWarningFilter` | warnings.ts:1-24 |
| `bridge/` | **PTL→PTH 桥**（13 文件，见 §4） | `PthClient` + 各 cmd* | — |
| `commands/` | 共享命令分发层（CLI+TUI 共用）+ session/trace 命令族 | `dispatch.ts`/`session.ts`/`trace.ts` | commands/dispatch.ts:1-40+ |
| `flow/` | **pit-flow 波次引擎**（12 文件，见 §3） | `engine`/`schema`/`store`/`pm`/`commands` | — |
| `lab-data/` | **raw-SQL 数据访问层**：node:sqlite 直查 agent-lab.db（零 import extensions/） | `open-db`/`schema`/`telemetry`/`arena`/`events` | open-db.ts:1-55 |
| `tui-pit/` | pit TUI（Ink）：Dashboard/Templates/Sessions/Extensions/Config 面板 | `app.tsx` | — |
| `tui-lab/` | lab TUI：Telemetry/Arena/Events/Compare/Config | `app.tsx` | — |
| `tui-shared/` | 双 TUI 共享组件库（Screen 布局 + DataTable/SelectList/CommandBar…） | `README.md`/`layout.tsx` | — |

---

## 2. pit CLI 命令树概览

**解析**：`pit/args.ts`（`SUBCOMMAND_COMMANDS = {template, shared, config, flow, agent, tui, hub, session, trace}`，args.ts:5）；**分发**：`pit/run.ts` 的 `main()` switch（run.ts:127-249）。

```
pit
├── 会话生命周期
│   ├── start [--template x] [--bg --name n]   tmux 启动+接入（交互无参时走 picker.tsx）
│   ├── pi                                   原生前台（无 tmux 逃生舱，sessions.ts:30 cmdPi）
│   ├── attach|switch|detach|stop|restore     tmux 会话管理；restore 按注册表重建+resume 纸带
│   └── ls | status                          会话列表 / 健康检查
├── tui [dashboard|lab]                       双 Ink TUI（route.ts cmdTui）
├── template ls|new|rm|rename                模板管理（commands.ts execTemplate*）
├── config get|set|unset|init                配置管理（config-cmd.ts）
├── session ls|show|fork|clone|transfer|branch|tree|resume|attach|stop   纸带操作
├── trace ls|show|timeline <agent>            credit/机器转移状态追踪（读 agent-lab DB 的 trace provider）
├── hub submit|run|programs|dev|request|requests|respond|observe|debug   ← PTL↔PTH 桥（§4）
├── flow run|ls|show|status|approve|reject|resume|propose|discard|edit|set|graph|rm|validate   波次引擎
├── agent run <template> <task>|clean <id>   单发 agent 实例（buildPiLaunch + tmux 后台）
├── onboard | doctor | update                首次导引 / 健康检查 / 更新本体
├── install|remove|uninstall                 扩展安装/卸载（admin.ts）
├── migrate                                  迁移旧 pi 配置到模板
├── shared status|init                       共享层
├── help [cmd] | version                    帮助/版本
└── 已废弃（仅提示迁移）: ui→tui dashboard, lab→tui lab, submit/run/programs/dev→hub *
```

**JSON 模式**：`--json` 时走 `pit/mode.ts` 表驱动 `JSON_ROUTERS`（template/status/doctor/ls/stop/shared/flow/agent/hub/session/trace 支持；hub 仅 programs，mode.ts:27-83）。
**废弃命令**：`DEPRECATED_COMMANDS` 表在 route.ts:33-40，旧命令仅打印迁移提示（run.ts:219-225）。

---

## 3. launcher 如何启动真实 pi 进程

**核心：PTL 不实现 agent runtime**——`buildPiLaunch`（launcher.ts:60-166）构建参数，`launchPi`（launcher.ts:167-232）spawn 真实 `pi` 二进制。

`buildPiLaunch(templateId, options)` 构建 `PiBuildResult {cmd, args, env, cwd}`：

1. **cwd/workspace 隔离**（launcher.ts:79-86）：`WorkspaceManager.ensureWorkspace(templateId, "default")` → `{dataDir}/workspaces/<uuid>/<project>/`
2. **pi 参数**（launcher.ts:88-114）：`--provider --model --thinking --tools --exclude-tools`（模板配置可覆盖 ModelRouter 解析结果）；`--session-dir {dataDir}/sessions/<uuid>`（显式落盘会话文件）；`--continue/--session <id>`（恢复）；`--append-system-prompt`（模板级 `templates/<uuid>/PROMPT.md` 或 `systemPrompt` 参数→os.tmpdir 临时文件）
3. **共享层链接**（launcher.ts:119-121）：每次启动前 `ensureTemplateLinks(piConfigDir, sharedDir)`——**symlink 注入机制在启动路径上强制保证**（这就是 AGENTS.md 铁律"手动删 symlink 会复活"的机制来源）
4. **AGENTS.md 认知注入**（launcher.ts:124-130）：`ensureTemplateAgents` 幂等写模板目录 AGENTS.md（PTL 身份注入）
5. **env 注入**（launcher.ts:137-165）：
   - `PI_CODING_AGENT_DIR={dataDir}/pi-config/<uuid>`（pi 配置根：extensions/skills/settings/models）
   - `PI_TEMPLATE`/`PI_TEMPLATE_ALIAS`/`PI_SESSION_ID`（随机 UUID）
   - **`AGENT_LAB_DB_PATH={dataDir}/shared/agent-lab/agent-lab.db`、`AGENT_LAB_CONFIG_DIR={piConfigDir}/agent-lab`** ← agent 进程内 agent-lab 扩展的数据落点
   - 可选 `PI_AGENT_INSTANCE_ID`（agent 实例标识）
6. **cmd**：`process.env.PI_BIN ?? "pi"`（launcher.ts:135）

`launchPi`（launcher.ts:167-232）在 provider/model 缺失时走 `ModelRouter`（shared/model-router）解析，然后 `spawn(cmd, args, {cwd, stdio:"inherit", env})` 前台运行。

**tmux 载体**（tmux.ts:136-201）：`buildTmuxSessionArgs` 用 `tmux new-session [-d] -s pit-<name> -c <cwd> -x 200 -y 50 -e K=V -- pi <args>`——**只透传 `PI_`/`AGENT_LAB_` 前缀 env**（tmux.ts:153-157），`--` 分隔禁 shell 注入。`configureTmuxServer` 设 extended-keys csi-u（pi 官方推荐，tmux.ts:27-38）。启动后 `getPanePid` 拿 pid 写进 session-registry。

**pit-flow 的独立 spawn 路径**（flow/pm.ts:1-59）：`makeSpawnAgent` → `spawn(pi, ["--print","--mode","json","--no-session"], {detached:true})`，prompt 经 stdin 写入，stdout 逐行解析 JSON 事件聚合 `text_delta`，超时（默认 120s）杀整个进程组。**不经过 launcher**——flow 节点的 env 由 `FlowStore` 提供（`{...process.env, ...env}`，pm.ts:30）。

---

## 4. PTL↔PTH 桥（bridge/ + hub 命令）

**入口**：`pit/route.ts` cmdHub（route.ts:64-121）分发 9 个子命令到 bridge 模块；`HUB_COMMANDS` 常量 route.ts:27。**配置**：`pit config set pth.url/pth.token`（或 `PTH_URL/PTH_TOKEN` env，client.ts:100-105）。

**客户端**：`bridge/client.ts` `PthClient`（HTTP + SSE + WS，Bearer token）：

| 端点 | 方法 | 用途 | client.ts 行 |
|---|---|---|---|
| `/api/v1/programs` | POST | 提交程序（manifest+base64 tar） | submit:48-59 |
| `/api/v1/programs` | GET/DELETE | 列表/删除 | list:180-200 |
| `/api/v1/programs/:name/run` | POST | 运行，SSE 流 `{seq,type,data,terminal}` 双信封 | run:202-232 |
| `/api/v1/components` | POST | 构件上传（scheduler/optimizer/memory-pack/skeleton-update + requestId 关联） | submitComponent:62-82 |
| `/api/v1/fallback-requests` | POST/GET | 回退请求建单/列表（open 优先） | createFallbackRequest/listFallbackRequests:84-171 |
| `/api/v1/observe/sessions` | GET | 远程观测会话列表（Redis 会话痕迹） | 134-150 |
| `/api/v1/observe/sessions/:id` | GET | 会话 meta | 153-160 |
| `/api/v1/observe/trace/:id` | GET | trace 时间线 | 163-171 |
| `/api/v1/observe/events` | GET | EventLog 代理查询（WP5 Task 28b） | 174-189 |
| `/ws/debug` | WS | 交互式调试接入 sandbox/会话（`?sessionId=` 透传） | debugUrl:117-124 |

**hub 命令↔模块映射**（route.ts:46-62 + bridge 各文件）：

- `hub submit <dir> [--dry-run]` → `bridge/submit.ts`：`packProgram`（pack.ts：读目录→校验 agent.json→ustar→gzip，上限 20MB）→ `PthClient.submit`
- `hub run <name> [k=v...] [--version N]` → `bridge/run.ts`：k=v→object、孤立词→text；SSE 流解包渲染 text_delta/thinking_delta/tool 事件
- `hub programs` → `bridge/programs.ts`（列表）；`hub dev <dir>` → `bridge/dev.ts` + `pipe.ts`（**本地直跑**：manifest 的 systemPrompt/skills 转 `--append-system-prompt`/`--skill` 注入 launcher，pipe.ts:18-59）
- `hub request/requests` → `bridge/request.ts`（手动建单，`--slot`/`--urgency`）；`hub respond <requestId> <dir>` → `bridge/respond.ts`（打包→`submitComponent("agent-program")`+requestId→PTH 保存后自动闭合请求，respond.ts:1-63）
- `hub observe sessions|session|trace|events [--json]` → `bridge/observe.ts`（只读观测）
- `hub debug [sandbox|<sessionId>]` → `bridge/debug.ts`（WS 协议 input/output/error/closed，Node≥22 内置 WebSocket，零新增依赖）

**打包格式**：手写 `ustar.ts`（IEEE 1003.1-1988，确定性排序、uid/gid=0、路径>100 抛错，零外部依赖）；`manifest.ts` 泛化 `ProgramManifest→ComponentManifest`（5 类构件：agent-program/scheduler/optimizer/memory-pack/skeleton-update，manifest.ts:1-25）。

**服务端对应**：`src/pth/programs/store.ts`（INCR 版本+tar 安全解包+GC）、`src/pth/gateway/routes-programs.ts`、`routes-observe.ts`、`routes-debug.ts`、`routes-components.ts`、`routes-fallback-requests.ts`（scout-3 已确认 PTH 侧）。

---

## 5. PTL 与 agent-lab 的关系（重点回答）

**结论：PTL 零直接代码引用 agent-lab**——`grep 'from ".*extensions' src/ptl` 零命中；唯一接触点是三个"间接通道"：

1. **symlink 注入（运行时）**：`shared-layer.ts` 把仓库 `extensions/`（6 个 bundled，含 agent-lab）cp 到 `~/.pi-triple/data/shared/extensions/`，再逐项 symlink 进各模板 `pi-config/<uuid>/extensions/`。`ensureTemplateLinks` 在每次 `buildPiLaunch` 时强制补链（launcher.ts:119-121）。→ **pi 进程启动时按 `PI_CODING_AGENT_DIR` 从模板目录加载 agent-lab 扩展**。这正是"扩展退场"（08-06 cli-template-migration spec）要替换的机制——根 AGENTS.md 铁律"删除 symlink ≠ 卸载（ensureTemplateLinks 会复活）"即此代码。
2. **env 注入（进程边界）**：`AGENT_LAB_DB_PATH` + `AGENT_LAB_CONFIG_DIR`（launcher.ts:157-158；tui-lab 面板同样注入 route.ts:95-98）→ 子进程内 agent-lab 扩展读/写这些路径。
3. **raw SQL 读库（数据边界）**：`lab-data/`（open-db.ts 头注释明言"不 import extensions/ 下任何模块"，open-db.ts:3-4）用 `node:sqlite` 直查 `agent-lab.db` 的 runs/arena/credit_tx/lab_events 表。`lab-data/schema.ts:5` 注明"从 agent-lab/src/store/schema.ts 和 src/core/storage/schema.ts 抄录"——**schema 以拷贝而非 import 方式同步，双源漂移风险点**。
4. **trace provider 只读消费**：`session/trace-provider.ts` 的 bidding/machine providers 读 agent-lab DB（credit_tx、lab_events machine.transition），供 `pit trace` 命令族（trace-provider.ts:1-99）。

**PTL 侧无 agent-lab 的"宿主"角色**（与 PTH 不同：PTH 以常驻系统会话 extensionFactories 托管 agent-lab，见 scout-3 §(A)）。PTL 是"外挂管理方"：管理 agent-lab 的数据文件位置与 pi 进程的加载环境，从不 import 其代码。

**agent-lab 能力在 PTL 侧的面板**：`pit tui lab`（tui-lab/）+ `pit trace` + `pit agent run`——全部通过上述通道消费。

---

## 6. 其他值得注意的架构点

- **命令双通道**：`commands.ts`（纯函数）+ `commands/dispatch.ts`（CLI/TUI 共用分发，进程内不安全命令 handoff 到 `pit <子命令>` 子进程，dispatch.ts 头注释）。
- **会话恢复链**：session-registry（持久化）→ tmux 存活探测（session-state.ts 状态机）→ `pit restore` 按注册表重建 + `--session <id>` resume 原纸带（commands.ts execStartBg、pit/sessions.ts cmdRestore:309）。
- **pit-flow 热修改**：运行中 `set/edit` 排队 pending → 波边界停（`editing`）→ resume 校验应用（engine.ts，v2 波次；双锁 exec/mutation 在 store.ts 头注释）。
- **配置跨层依赖**：config.ts 的 `redis`/`gateway` 字段（config.ts:46-49）是 PTH 遗留配置项，PTL 实际只用 pth.url/token——低风险冗余。

---

## 给后续 agent 的入口建议

- 想改"扩展注入"→ 打开 `shared-layer.ts`（symlink 机制）+ `launcher.ts:119-121`（启动补链点）+ `pit/admin.ts`（install/update 走 installBundledExtensions/syncBundledExtensions）
- 想改"PTL↔PTH 桥"→ 打开 `bridge/client.ts`（端点全集）+ `pit/route.ts:64-121`（分发）
- 想改"pit-flow"→ 打开 `flow/engine.ts`（executeLoop 波次循环）+ `flow/pm.ts`（spawn pi）
- 想改"会话管理"→ 打开 `tmux.ts` + `pit/sessions.ts`
