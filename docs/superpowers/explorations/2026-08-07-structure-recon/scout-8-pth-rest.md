# Scout-8：PTH 非 core/ 模块深度侦察（components / fallback / gateway / observability / programs / self-modify / storage / tools / workflow）

侦察对象：`src/pth/` 除 `core/`（scout-6 已深挖）与 `main.ts`（scout-6 已深挖）之外的全部模块。
全部行号为当前工作区快照的实际行号。

---

## 1. 模块职责表（每目录一行 + 关键导出）

| 目录/文件 | 职责 | 关键导出（类型/类/函数） |
|---|---|---|
| `components/store.ts` | **ComponentStore**——构件存储泛化（F/WP4 Task 17）。types: `agent-program, scheduler, optimizer, memory-pack, skeleton-update`。落盘 `DATA_DIR/components/<tenantId>/<type>/<name>/<version>/`；手写 ustar 解析（安全限制：拒绝对路径/symlink/..，单文件 1MB、总量 20MB、100 文件、深度 8、保留 10 版）。agent-program 读侧双查 legacy programs 卷（v1 直接切换、不迁移）。空位绑定 + legalAuth 登记均在此 save() 内联动（审计事件 `slot_binding` / `component_upload`）。 | `COMPONENT_TYPES`, `ComponentType`, `ComponentManifest`（含 `targetSlot?`/`legalAuth?`）, `ComponentInfo`, `ComponentVersion`, `class ComponentStore`（save/delete/list/get/getByType/materialize/prune） |
| `components/slot-binding.ts` | **targetSlot 空位绑定登记**（§5.2，Task 18）：部署=登记，O(1) 良构校验（非空/≤128 字符/无控制字符），不做深度语义校验（信任链暂缓）。key `slot:<slotId>:binding`（JSON，latest-wins 覆盖）。 | `validateSlotId()`, `SlotBinding` 接口, `class SlotBindingStore`（bind/get） |
| `fallback/requests.ts` | **fallback_requests 回退请求队列**（Task 20）：Redis hash `fallback_requests`（field=requestId）。手动建单先行，自动触发留 E。闭合：respond 自动（routes-programs 层）+ 手动 close（幂等）。 | `URGENCIES`, `Urgency`, `FallbackRequest`, `FallbackCreateInput`, `class FallbackRequestStore`（create/get/list/close） |
| `gateway/server.ts` | **Fastify 装配点**：`createServer(deps)` 注册 `@fastify/websocket` + `createAuthHook`（全局 onRequest，/health /metrics 豁免），挂 `/metrics`、全部 routes-*、`/ws`（JSON 行协议 prompt/abort→engine）、SSE 复用。所有 store 类依赖均为**可选注入**（不传则不注册对应路由）。 | `createServer(deps: {redis, engine, toolPlatform, metrics, logger, port?, programs?, fallback?, sandboxMonitor?, sessionStore?, debugGateway?, audit?})` |
| `gateway/auth.ts` | Bearer 鉴权 hook：`auth:token:<token>` → JSON `{tenantId, role}`；role 缺省 `tenant-agent`。`req.auth` 类型注入 Fastify 声明合并。 | `AuthContext {tenantId, role: "platform-admin"\|"tenant-agent"}`, `createAuthHook(redis)` |
| `gateway/routes-sessions.ts` | sessions CRUD + prompt SSE + abort（403/404 映射）。`GET /api/v1/sessions` 直接返回内存池快照（非 Redis trace）。 | `registerSessionRoutes(app, engine)` |
| `gateway/routes-programs.ts` | **components/programs 上传 + run**：`POST /api/v1/components`（类型分派校验）、`POST /api/v1/programs`（agent-program 兼容别名）、list/detail/delete、`POST /api/v1/programs/:name/run`（SSE，输入 schema 校验 + program 会话 one-shot 后销毁）。上传携带 `requestId` → 保存成功后**自动闭合 fallback 请求**（§5.4 通道复用）+ `slotHint` 补位 targetSlot。scheduler/optimizer 空位绑定经 `engine.emitComponentBound`（COMPONENT_BOUND_CHANNEL）通知常驻会话。 | `registerProgramRoutes(app, engine, store, fallback?)`, `validateManifest()`, `validateComponentManifest()`, `handleComponentUpload()` |
| `gateway/routes-fallback.ts` | fallback 请求 HTTP 面：创建/列表（open 优先）/手动闭合。respond 自动闭合不在本文件（在 routes-programs）。 | `registerFallbackRoutes(app, store)` |
| `gateway/routes-observe.ts` | **只读观测**（Task 21）：`/observe/sessions`（Redis 痕迹列表）、`/observe/sessions/:id`（meta）、`/observe/trace/:id`（entries 时间线）、`/observe/events`（EventLog 代理——engine 未传则 **501**，WP5 Task 28 交付）。跨租户防御：meta.tenantId 显式校验。 | `registerObserveRoutes(app, store, engine?)` |
| `gateway/routes-events.ts` | **外部事件 webhook**（Task 27）：`POST /api/v1/events` → 审计（actor="webhook"）→ `engine.emitExternalEvent`（system-event-bus EXTERNAL_EVENT_CHANNEL）→ 常驻会话 agent-lab 订阅派发；常驻会话不可用 → 503（审计先落，事件不丢）。 | `registerEventsRoutes(app, engine, audit?)` |
| `gateway/routes-debug.ts` | **hub debug WS 交互调试**（Task 22）：`/ws/debug`，默认网关=SandboxExecClient 行式转发 sandbox `/exec`（cwd 白名单 `/data/workspaces`，timeout 60s）。角色要求 **platform-admin**（tenant-agent 拒绝）。消息协议 input/output/error/closed。审计 `debug_session_open/closed`。 | `DebugGateway`, `DebugGatewayFactory`, `createSandboxDebugGatewayFactory(client, cwd?)`, `registerDebugRoutes(app, opts)` |
| `gateway/routes-self.ts` | self 面：`/api/v1/self/tools`（tenant 允许工具表）、`/api/v1/self/version`、`/health`（sandbox degraded → **503** + 子状态字段）。 | `registerSelfRoutes(app, toolPlatform, platformVersion, sandboxMonitor?)` |
| `gateway/sse.ts` | SSE 线格式单点（session prompt 与 program run 共用）：`data: <json>\n\n` + `data: [DONE]`，错误 `event: error`。 | `writeSSE(reply, events)` |
| `observability/audit.ts` | **审计**：Redis Stream `audit:log`（XADD + XTRIM MAXLEN ~10000）。`write()` 通用 + `queryToolCall`/`querySelfModify` 便捷方法。 | `AuditEvent`, `class AuditWriter` |
| `observability/metrics.ts` | prom-client registry + gauges/histograms/counters（sessions_active, prompt_duration, tokens_total, tool_calls_total, workflow_steps_total, self_modify_total, redis_used/max_memory）。`startRedisMetrics` 每 15s INFO memory 收集。 | `createMetrics()`, `Metrics` 类型, `startRedisMetrics(redis, metrics, intervalMs?)` |
| `programs/store.ts` | **ProgramStore 兼容门面**：`class ProgramStore extends ComponentStore`，无覆写，纯 agent-program 视图。老调用方/测试零改动。 | `class ProgramStore` |
| `programs/types.ts` | PTH agent-program manifest schema + `Result<T,E>` 判别联合。 | `ProgramManifest`, `ProgramInfo`, `ProgramVersion`, `Result` |
| `self-modify/hot-reloader.ts` | **L1 热更注入**（Task 8）：chokidar 监听 platform 卷 `skills/prompts/config`，变更校验（SKILL.md 需 `# ` 标题、settings.json 需合法 JSON）通过 → 进 `ResourceOverlay` 覆盖层（后续会话 ResourceLoader 注入）；失败剔除。`ignoreInitial: true`——部署后须触发变更事件才生效。 | `ReloadResult`, `ResourceOverlaySnapshot`, `ResourceCategory`, `class ResourceOverlay`, `class HotReloader`（start/stop/reloadFile/getOverlayPaths） |
| `storage/interfaces.ts` | 存储抽象接口：`SessionStore`（appendEntry/getEntries/getMeta/saveMeta/saveSnapshot/getLatestSnapshot/listSessions/deleteSession/saveVersionSnapshot/getLatestVersionSnapshot）、`SettingsStore`、`CredentialProvider`。 | 3 个接口 |
| `storage/redis-session-store.ts` | **Redis 会话痕迹**实现：meta/entry/snapshot/vsnapshot 均为 string JSON，`session-index:<tenant>` 为 zset。appendEntry 用 get-modify-set 避免 WRONGTYPE。getLatestSnapshot/vsnapshot 从 lastEntrySeq 向下线性扫描。 | `class RedisSessionStore` |
| `storage/redis-settings-store.ts` | Redis settings：`settings:<tenant>` / `settings:<tenant>:<project>`，get/set（set=读-合并-写）。 | `class RedisSettingsStore` |
| `storage/types.ts` | 数据形状：`SessionMeta`（version/sessionId/tenantId/project/model/thinkingLevel/status/entryCount/lastEntrySeq/createdAt/updatedAt）、`SessionEntry`、`Snapshot`、`VersionSnapshotRecord`、`Settings=Record<string,unknown>`。 | 类型定义 |
| `tools/platform.ts` | **工具治理层**：`ToolPlatform`——getAllowedTools/getEffectiveTools（program.tools ∩ tenant allowlist）/getSdkToolDefinitions/governExecution（denied/error/exception 审计 + metrics）+ recordToolStart/End。 | `class ToolPlatform` |
| `tools/registry.ts` | `ToolRegistry`：tenant allowlist（缺省 read/bash/edit/write）、custom tools（保留 7 个内建名：read/bash/edit/write/grep/find/ls）、SDK ToolDefinition 表。进程内存 Map（**非持久化**）。 | `class ToolRegistry` |
| `tools/sandbox-bash.ts` | **sandbox bash 转发**（Task 11/13）：同名 `bash` customTool，HTTP 转发 sandbox `/exec`（Bearer `SANDBOX_SHARED_SECRET`）；不转发 pth 进程 env（密钥隔离）。类型化错误 `sandbox-unavailable` / `sandbox-timeout`。`SandboxHealthMonitor`：连续失败≥3 → degraded（自动探活 /health 恢复，onStateChange 审计）。 | `SandboxForwardError`, `SandboxClientOptions`, `SandboxExecRequest/Result`, `SandboxHealthMonitor`, `SandboxExecClient`, `createSandboxBashDefinition()`, `SandboxBashDefinition` |
| `tools/spi.ts` | 工具执行 SPI 接口（`ToolExecutor`）。**孤岛文件**：全仓库无任何 import（见 §3 依赖图注）。 | `ToolExecutor` |
| `tools/types.ts` | 工具契约：`ToolDefinition`（executor: local/container/remote/mcp）、`ToolCallRequest`、`ToolResult`、`ToolEvent`。 | 类型定义 |
| `workflow/orchestrator.ts` | **WorkflowOrchestrator**：顺序/parallel/condition/human-approval 步骤执行，agent 步骤走 engine 会话。Redis 分布式锁 `workflow:<id>:lock`（fencing token + Lua 安全解锁）+ 状态 `workflow:<id>:state`。human-approval → `awaiting_approval`，approve() 继续。 | `class WorkflowOrchestrator`（execute/approve/getState） |
| `workflow/bullmq-worker.ts` | **BullMQ intent worker**：queue `"intents"`，concurrency 1、lockDuration 30s。⚠️ 与 spec §6.4「v0.1 不引入 BullMQ」裁决偏离（见 §5）。 | `createIntentWorker(redisUrl, onIntent)` |
| `workflow/types.ts` | `WorkflowDefinition`、`WorkflowStep`（agent/parallel/condition/human-approval）、`WorkflowState`、`WorkflowIntent`。 | 类型定义 |

---

## 2. Gateway 完整路由表（HTTP/SSE/WS 入口）

| 方法/路径 | 文件:行 | 说明 |
|---|---|---|
| GET `/metrics` | server.ts:47 | prom-client 文本（auth 豁免） |
| GET `/health` | routes-self.ts:20 | degraded→503 |
| POST `/api/v1/sessions` | routes-sessions.ts:6 | 建会话（429 超限） |
| POST `/api/v1/sessions/:id/prompt` | routes-sessions.ts:19 | **SSE** 流 |
| POST `/api/v1/sessions/:id/abort` | routes-sessions.ts:26 | 403/404 映射 |
| GET `/api/v1/sessions/:id` | routes-sessions.ts:37 | 池内快照 |
| DELETE `/api/v1/sessions/:id` | routes-sessions.ts:44 | |
| GET `/api/v1/sessions` | routes-sessions.ts:49 | |
| POST `/api/v1/components` | routes-programs.ts:297 | 构件上传（tar.gz base64，2MB 上限，413） |
| POST `/api/v1/programs` | routes-programs.ts:309 | agent-program 兼容别名 |
| GET `/api/v1/programs` | routes-programs.ts:316 | list（含 legacy 并入） |
| GET `/api/v1/programs/:name` | routes-programs.ts:322 | detail |
| DELETE `/api/v1/programs/:name` | routes-programs.ts:334 | |
| POST `/api/v1/programs/:name/run` | routes-programs.ts:342 | **SSE** + schema 校验 + one-shot 会话销毁 |
| POST `/api/v1/fallback-requests` | routes-fallback.ts:16 | 手动建单 |
| GET `/api/v1/fallback-requests` | routes-fallback.ts:30 | open 优先 |
| POST `/api/v1/fallback-requests/:id/close` | routes-fallback.ts:34 | 幂等闭合 |
| GET `/api/v1/observe/sessions` | routes-observe.ts:67 | Redis 痕迹 |
| GET `/api/v1/observe/sessions/:id` | routes-observe.ts:73 | meta |
| GET `/api/v1/observe/trace/:id` | routes-observe.ts:83 | entries 时间线 |
| GET `/api/v1/observe/events` | routes-observe.ts:98 | **501** 占位（WP5 Task 28） |
| POST `/api/v1/events` | routes-events.ts:23 | webhook→常驻会话（202/503） |
| GET `/api/v1/self/tools` | routes-self.ts:12 | tenant allowlist |
| GET `/api/v1/self/version` | routes-self.ts:16 | |
| WS `/ws` | server.ts:69 | JSON：`{type:"prompt"}` / `{type:"abort"}`，回 `event`/`done`/`error` |
| WS `/ws/debug` | routes-debug.ts:79 | platform-admin only，sandbox 行式往返 |

注：`sessionStore`、`programs`、`fallback`、`debugGateway` 未注入时对应路由整体不注册（server.ts:52-66 可选接线）。`/events` 始终注册（依赖 engine+audit）。

---

## 3. 依赖图（谁 import 谁，仅 src/pth 内部边 + 关键外部）

```
main.ts ──装配──▶ 全部模块（构造注入，非 import 依赖）

gateway/server.ts → auth, sse, routes-{sessions,self,programs,fallback,observe,events,debug}
                 → core/agent-engine, tools/platform, tools/sandbox-bash, programs/store,
                   storage/interfaces, observability/{metrics,audit}, fallback/requests, shared/logger
routes-programs.ts → core/agent-engine, programs/{store,types}, components/store(COMPONENT_TYPES),
                     fallback/requests, sse, node:zlib(dynamic)
routes-observe.ts → storage/interfaces, core/agent-engine
routes-events.ts → core/agent-engine, observability/audit
routes-debug.ts → tools/sandbox-bash(SandboxExecClient), observability/audit, gateway/auth(类型)
routes-self.ts → tools/platform, tools/sandbox-bash(类型)

programs/store.ts → components/store (extends), observability/audit, programs/types
components/store.ts → programs/types(Result/ProgramManifest), observability/audit, components/slot-binding
components/slot-binding.ts → components/store(ComponentType 类型), programs/types(Result)
fallback/requests.ts → observability/audit, programs/types(Result)

workflow/orchestrator.ts → core/agent-engine, storage/interfaces, observability/metrics, shared/logger, workflow/types
workflow/bullmq-worker.ts → bullmq, workflow/types
self-modify/hot-reloader.ts → chokidar, shared/logger, observability/metrics
tools/platform.ts → tools/{registry,types}, observability/{audit,metrics}, shared/logger
tools/registry.ts → tools/types
tools/sandbox-bash.ts → @sinclair/typebox（无内部依赖）
storage/* → storage/types + storage/interfaces（叶子）
observability/audit.ts → ioredis（叶子）
observability/metrics.ts → prom-client, ioredis（叶子）

共享层依赖（src/shared/）：main.ts → platform, logger, model-router, credential-provider,
  workspace/manager, sdk-adapter；core/* → sdk-adapter, model-router, workspace, logger, metrics,
  storage/interfaces（scout-6 已述）。
```

**孤岛文件**：`tools/spi.ts`（`ToolExecutor`）——全 `src/pth` 无任何引用，疑似预留/遗留接口。

**依赖方向要点**：
- 所有存储消费者依赖**抽象** `storage/interfaces.ts`（engine、session-pool、orchestrator、routes-observe、server）；Redis 具体实现只在 main.ts 装配。
- `components/store.ts` 是**类型汇聚点**（被 programs、gateway、slot-binding 引用）；`programs/types.ts` 的 `Result` 是全局错误判别联合（components/fallback/programs 共用）。
- 事件/观察面通过 `core/system-event-bus.ts` 通道常量与 agent-lab 侧做**线协议对接**（零代码引用）：`platform:external-event`、`platform:observe-events:request/response`、`platform:component-bound`（agent-engine.ts:11 引用）。

---

## 4. 存储面全清单（统一存储后端设计的事实基础）

### 4.1 Redis keys（全部：src/pth 内直接读写）

| Key 模式 | 类型 | 写入方 | 读取方 | 来源 |
|---|---|---|---|---|
| `auth:token:<token>` | string JSON `{tenantId, role}` | （外部/未在 pth 内建单） | gateway/auth.ts:37 | auth.ts:37 |
| `audit:log` | Stream（XADD+TRIM ~10000） | observability/audit.ts:24 | 无读侧（可 XRANGE） | audit.ts:14 |
| `session:<tenant>:<sid>:meta` | string JSON SessionMeta | redis-session-store.ts:49,60 | getMeta/getEntries/getLatestSnapshot/listSessions/deleteSession | rs-store.ts:11,19,27,32,57,63 |
| `session:<tenant>:<sid>:entry:<seq>` | string JSON SessionEntry | appendEntry:39 | getEntries(mget 线性):45 | rs-store.ts:14 |
| `session:<tenant>:<sid>:snapshot:<seq>` | string JSON Snapshot | saveSnapshot:66 | getLatestSnapshot（向下扫描）:70 | rs-store.ts:17 |
| `session:<tenant>:<sid>:vsnapshot:<seq>` | string JSON VersionSnapshotRecord | saveVersionSnapshot:88 | getLatestVersionSnapshot:92 | rs-store.ts:20 |
| `session-index:<tenant>` | zset（score=Date.now, member=`{sessionId,project}`） | saveMeta:61 | listSessions zrange:76 | rs-store.ts:23 |
| `settings:<tenant>` / `settings:<tenant>:<project>` | string JSON | RedisSettingsStore.set:15 | get:11 | rs-settings.ts:8 |
| `components:<tenantId>:<type>` | Set（name 列表） | store.ts:231 | list:262, getVersion 检查 | store.ts:12 |
| `component:<tenantId>:<type>:<name>:latest` | string int | save:232 | list/getVersion | store.ts:13 |
| `component:<tenantId>:<type>:<name>:updatedAt` | string int ms | save:234 | list | store.ts:14 |
| `component:<tenantId>:<type>:<name>:<N>` | string JSON manifest | save:233 | getVersion:343 | store.ts:15 |
| `component:<tenantId>:<type>:<name>:<N>:bytes` | string int（GC/尺寸） | save | delete/prune | store.ts:16 |
| `component:<tenantId>:<type>:<name>:next` | INCR 计数器（版本分配） | save:204 | — | store.ts:17 |
| `programs:<tenantId>`（legacy set） | Set | legacy 兼容 | list 并入 | store.ts:96 |
| `program:<tenantId>:<name>:{latest,updatedAt,<N>,<N>:bytes,next}`（legacy 全套） | 同上 | 兼容写 | getVersion 双查 | store.ts:99-119 |
| `slot:<slotId>:binding` | string JSON SlotBinding | slot-binding.ts:42 | get:50 | slot-binding.ts:22,31 |
| `fallback_requests` | **hash**（field=requestId, value=JSON） | requests.ts:43,76 | get:54 / list HGETALL:62 / close:73 | requests.ts:29,42 |
| `workflow:<id>:lock` | string fencing token（SET NX PX 600000） | orchestrator.ts:24 | execute 抢锁 + Lua 释放:37 | orchestrator.ts:22 |
| `workflow:<id>:token` | INCR | orchestrator.ts:23 | — | orchestrator.ts:23 |
| `workflow:<id>:state` | string JSON WorkflowState | saveState:101 | loadState:95 | orchestrator.ts:95,101 |
| BullMQ `intents` 队列 | BullMQ 自有 key 族（`bull:intents:*` 等） | （无生产方——worker 只有 log 空实现） | bullmq-worker.ts:6 | bullmq-worker.ts:4-14 |

### 4.2 sqlite（PTH 本身零直读，常驻会话扩展持有）

- **agent-lab.db**：`node:sqlite DatabaseSync`，由 agent-lab 扩展（PTH main.ts:86-100 动态 import `../../extensions/agent-lab/index.ts`）打开。
  - PTH 侧 env 契约：agent-engine.ts:674-681 `prepareSystemEnv()` —— 未设 `AGENT_LAB_DB_PATH` 时置 `path.join(DATA_DIR, "agent-lab", "agent-lab.db")`，另有 `AGENT_LAB_CONFIG_DIR` = `<DATA_DIR>/agent-lab/config`、`PI_AGENT_INSTANCE_ID`。
  - PTL/pit 侧另有全局路径：`~/.pi-triple/data/shared/agent-lab/agent-lab.db`（src/ptl/pit/route.ts:95,98；ptl/lab-data/open-db.ts:49,55）。
  - PTH **不直读**该 DB——observe/events 经 system-event-bus RPC（`platform:observe-events:request/response`）由常驻会话代理查询（routes-observe.ts:98-122 传 engine.querySystemEvents；engine 未接则 501）。

### 4.3 FS 目录（DATA_DIR，缺省 `./.pi-platform-data`，容器内 `/data`）

| 目录 | 用途 | 来源 |
|---|---|---|
| `DATA_DIR/workspaces/<tenantId>/<projectId>/` | 租户工作区（路径推导单点 WorkspaceManager） | shared/workspace/manager.ts:28-45 |
| `DATA_DIR/workspaces/<tenantId>/program-run-<sessionId>/` | program run 工作区（随会话销毁清理） | manager.ts:47-56; agent-engine.ts:714-718 |
| `DATA_DIR/platform/{skills,prompts,config}` | platform 卷——HotReloader 监听注入（L1 热更） | main.ts:131-136; hot-reloader.ts:70-74 |
| `DATA_DIR/tenants/<tenantId>/{skills,tools}` | tenant overlay 卷 | manager.ts:76-84 |
| `DATA_DIR/components/<tenantId>/<type>/<name>/<version>/` | **components 卷**（入口文件 agent.json / definition.json） | components/store.ts:78-88,141 |
| `DATA_DIR/programs/programs/<tenantId>/<name>/<version>/` | **legacy programs 卷**（只读兼容，不迁移） | components/store.ts:61-66 |
| `DATA_DIR/sessions/<tenantId>/<sessionId>/` | 会话目录（S1 租户组织） | agent-engine.ts:114-115 |
| `DATA_DIR/agent-lab/agent-lab.db` + `config/` | 常驻会话 sqlite + 配置（env 契约） | agent-engine.ts:674-681 |

### 4.4 进程内存态（统一存储设计注意）

- `ToolRegistry` 的 tenant allowlist / custom tools / SDK definitions —— `Map`，**无持久化**（tools/registry.ts:6-10）。
- SessionPool 会话本体、AgentEngine.agentSessions / programRunDirs —— 内存态（Redis 只有痕迹）。

---

## 5. 关键事实与风险

1. **BullMQ 实际启用 ≠ spec §6.4 裁决**：spec §6.4「v0.1 不引入 BullMQ」；但 `workflow/bullmq-worker.ts` + `workflow/orchestrator.ts` 被 main.ts:110,121 **主动创建**（`new WorkflowOrchestrator` + `createIntentWorker`，queue `"intents"` concurrency 1）。且 worker 的 onIntent 目前**只打日志**（main.ts:121-123），没有任何入队生产方——属于「实现超量、无消费闭环」的中等偏离（scout-3 已记录）。
2. **observe/events 是 501 占位**：EventLog 查询依赖 WP5 Task 23/24 常驻会话代理（routes-observe.ts:106-111 显式 501 说明）。
3. **Auth token 无建单方**：`auth:token:<token>` 只在 auth.ts 读取，pth 内无 mint 逻辑——令牌由外部（PTL/运维）写入 Redis。
4. **components 双卷并存**：新写 components 卷 + legacy programs 卷读侧双查，GC（prune）只清新卷；delete() 会同时清两者（store.ts:241-256）。
5. **slot-binding 为登记式**：仅 O(1) 良构校验 + 审计，无语义求值；scheduler/optimizer 的框架层 registry 接线依赖 WP5 Task 28c（routes-programs.ts:232-246 notifyBound 若 engine 未实现则静默跳过）。
6. **sandbox 密钥隔离**：pth 进程 env 不转发 sandbox（sandbox-bash.ts:15-16 头注），compose env `SANDBOX_SHARED_SECRET` 注入。
7. **tools/spi.ts 孤岛**：无引用，可能是废弃/预留接口——统一存储/工具设计时可清理或确认。
8. **审计无读侧**：`audit:log` 只写不读（观测面走 Redis session trace 与 EventLog RPC）。

## 6. 给后续「统一存储后端」设计的建议入口

- 先看 `storage/interfaces.ts`（抽象契约，engine 等全部消费者依赖它）——统一后端应替换 main.ts:37-38 的具体实现类即可。
- Redis key 族集中在 4 个文件：redis-session-store.ts、redis-settings-store.ts、components/store.ts（含 legacy）、fallback/requests.ts；workflow/orchestrator.ts 另有 3 个 key。
- FS 卷路径推导集中在 `shared/workspace/manager.ts`（workspaces/platform/tenants）与 components/store.ts（components/programs 卷）。
