# 项目架构梳理（9 scout 综合全景）

- 日期：2026-08-07
- 状态：架构梳理完成（作为 vm 内核设计的决策基础）
- 前置：结构审计 `structure-audit.md`（6 scout 版）+ 本报告（9 scout 完整版）
- 目标：彻底梳理 pi-platform 当前架构，回答"vm 内核统一执行面落哪、统一存储后端是什么"

---

## 0. 仓库全景

| 面 | 规模 | 状态 |
|---|---|---|
| `src/`（PTL + PTH + shared） | 18,375 行 TS | 双产品 |
| `extensions/agent-lab/` | 28,530 行 TS | 独立子系统（扩展形态） |
| 其他扩展 ×5 + _shared | — | 扩展生态 |
| 根文档 | `ARCHITECTURE.md`（272 行，单一真相源） | 部分过时（D1-D5） |

---

## 1. 双产品全景（PTL / PTH / shared）

```
┌─ PTL（Pi-Triple-Lite）────────────────────────────┐
│ 定位：pi 的"多模板会话管理器 + 本地工作流引擎 + PTH 客户端" │
│ 入口：pit CLI（src/ptl/pit.ts）· TUI（Ink）· tmux   │
│ 核心：launcher（构建 pi 启动参数）→ spawn 真实 pi     │
│       tmux 会话管理 · 纸带 session 操作 · ptl-flow    │
│       hub 桥（PTH 客户端）· lab-data（raw SQL 读库）  │
│ 不运行 agent 本体（真实 pi 进程 × tmux 承载）          │
└──────────────────────────────────────────────────┘
                      │ hub submit/run/request/respond/observe/debug
                      ▼
┌─ PTH（Pi-Triple-Heavy）────────────────────────────┐
│ 定位：agent 联邦平台服务器（agent 实际运行处）          │
│ 入口：pth server（src/pth/main.ts）                  │
│ 核心：AgentEngine（会话池/常驻系统会话/恢复/watchdog）  │
│       gateway（Fastify HTTP/SSE/WS）· ComponentStore │
│       ToolPlatform（工具治理）· sandbox bash 转发      │
│       WorkflowOrchestrator · HotReloader（L1 热更）   │
│       Redis（会话痕迹/设置/组件/回退/工作流）+ FS 卷     │
└──────────────────────────────────────────────────┘
                      │
┌─ shared（src/shared/）─────────────────────────────┐
│ sdk-adapter（唯一 pi SDK import 边界，137 行）        │
│ model-router · workspace/manager · platform · logger │
└──────────────────────────────────────────────────┘
```

## 2. 扩展生态全景（6 bundled + _shared）

| 扩展 | 职责 | 加载方 | 状态 |
|---|---|---|---|
| **agent-lab** | agent 经济引擎（WorkLoop/市场/调度/优化器/任务池/记忆） | PTL-symlink + **PTH-dynimport**（main.ts:96-110 注入常驻会话） | 活跃（持续增长） |
| agent-lab-bidder | `place_bid` 工具（globalThis BidBoard 单例） | PTL-symlink 仅 | 兼容垫片（deprecated-for-bidding）；**相对 import `../agent-lab/src/` 强耦合** |
| ptl-communicate | 跨会话通信（文件邮箱 + 审核 + 审计） | PTL-symlink 仅 | 冻结；**spec 依赖 agent-lab comms 未接线** |
| ptl-control | 会话内 tmux 控制（/control） | PTL-symlink 仅 | 冻结 |
| ptl-providers | provider 后端（providers.json + failover） | PTL-symlink 仅 | 活跃单点 |
| workflow | 会话内 ptl-flow 接口（/flow + 工具） | PTL-symlink 仅 | 活跃（全 shell 外调 CLI） |
| _shared/ | 5 个共享模块（paths/presence/registry/…） | 随 symlink 进入但不被加载 | 供 communicate/control 共用 |

**加载机制**：`src/ptl/shared-layer.ts` —— bundled 扩展 cp 到共享层 → 逐模板 symlink 注入 → `ensureTemplateLinks` 每次启动强制补链（删 symlink 会复活）。PTH 侧另以 extensionFactories 注入 agent-lab。

## 3. agent-lab 内部全景

### 3.1 两条构造路径

| | runtime 路径（活跃） | assembly 路径（休眠） |
|---|---|---|
| 入口 | `index.ts:245 createSchedulerRuntime` | `assembler.ts assembleAgent` |
| 记忆域/账本/身份/SDK | 无 | 完整（MemoryHost/LedgerPort/IdentityMap/attachSdkOnce） |
| 工具口 | stub（index.ts:263 throw） | 无此问题（未接线） |

### 3.2 休眠代码（src 内零 import）

`assembly/*`、`taskpool/cycle.ts`、`ingest/cycle.ts`、`economy/market-runner.ts`、`memory/sdk.ts mountMemorySdk`、`taskpool/sdk.ts mountSorterSdk`、`runtime/create-runtime.ts`（README 自述 sidecar）

### 3.3 活跃面

`/lab` 命令族（task/agent/scheduler/experiment/arenaSmoke/bench/execute）· interceptor（subagent 模型选择）· arena 竞价（market-bid-loop）· 事件线（wireSystemEvents）· 遥测

## 4. 存储全景（统一存储后端的事实基础）

### 4.1 Redis keys（PTH 侧，全部）

| 域 | Keys | 文件 |
|---|---|---|
| 会话痕迹 | `session:<tenant>:<sid>:{meta,entry:<seq>,snapshot:<seq>,vsnapshot:<seq>}` + `session-index:<tenant>`（zset） | redis-session-store.ts |
| 设置 | `settings:<tenant>` / `:<project>` | redis-settings-store.ts |
| 组件 | `components:<tenant>:<type>`（set）/`component:...:{latest,updatedAt,<N>,<N>:bytes,next}` + legacy programs 全套 | components/store.ts |
| 回退 | `fallback_requests`（hash） | fallback/requests.ts |
| 工作流 | `workflow:<id>:{lock,token,state}` | workflow/orchestrator.ts |
| 审计 | `audit:log`（Stream，只写不读） | observability/audit.ts |
| 认证 | `auth:token:<token>`（无建单方，外部写） | gateway/auth.ts |
| BullMQ | `bull:intents:*`（无生产方） | bullmq-worker.ts |

### 4.2 SQLite

- **agent-lab.db**（agent-lab 扩展持有，PTH 零直读）：任务池 tasks/templates、事件账本 lab_events、经济账本 credit_tx、调度状态
- PTH 侧经 env 契约（agent-engine.ts:674-681）+ 常驻会话 RPC 代理查询（observe/events）
- PTL 侧经 raw SQL 直查（lab-data/，schema 拷贝双源漂移风险）

### 4.3 FS 目录（DATA_DIR）

`workspaces/<tenant>/<project>/` · `platform/{skills,prompts,config}`（HotReloader 监听）· `tenants/<tenant>/{skills,tools}` · `components/<tenant>/<type>/<name>/<version>/` · `programs/programs/...`（legacy 只读）· `sessions/<tenant>/<sid>/` · `agent-lab/`（db+config）

### 4.4 进程内存态

ToolRegistry（allowlist/custom tools，**无持久化**）· SessionPool 会话本体 · AgentEngine 会话注册表

### 4.5 记忆系统现状

L3 语义记忆 = agent-lab 文件系统模式（entries/anchors/counters，原子写 tmp+rename）；WM/转录 = 设计中（vm-kernel-draft 未落）。**分散在 4 个介质**。

## 5. 执行链全景（agent 实际怎么跑）

| 路径 | 触发 | 执行体 | 工具 |
|---|---|---|---|
| 1. PTH 主路径 | gateway → session.prompt | **pi SDK AgentSession 回合循环** | 真实（sandbox bash 转发） |
| 2. subagent 委托 | interceptor（model select） | pi SDK 自己执行 | pi SDK 原生 |
| 3. agent-lab execute | /lab execute、定时、taskpool | WorkLoopRunner → pi-default-loop → Delegation V2 | **stub**（且系统会话无委托监听 → 半瘫） |
| 4. PTL 本地 | ptl start / agent run / flow | 真实 pi 进程（tmux 承载） | 真实（本地） |

**真相**：agent 真实执行 = pi SDK 会话层（PTH 主路径）+ 本地 pi 进程（PTL）。agent-lab 只贡献模型选择/竞价。

## 6. 结构性发现汇总

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| 1 | 大量休眠代码（能力建设与接线脱节） | assembly/taskpool-cycle/ingest-cycle/economy | 高 |
| 2 | 两条 agent 构造路径 | runtime（活跃）vs assembly（休眠） | 高 |
| 3 | execute-mode workloop 半瘫 | 工具 stub + 系统会话无委托监听 | 高 |
| 4 | 存储 4 介质分散 | Redis/SQLite/FS/内存 | 中（vm 内核直接相关） |
| 5 | BullMQ 超量实现 | intent worker 无生产方 | 中 |
| 6 | observe/events 501 占位 | EventLog 查询未交付 | 中 |
| 7 | 扩展机制与"退场"迁移未开始 | shared-layer symlink | 中（vm 内核直接相关） |
| 8 | schema 拷贝双源漂移 | lab-data/schema.ts 抄录 | 低 |
| 9 | agent-lab-bidder 相对 import 强耦合 | 退场时最先断裂 | 低 |
| 10 | 根文档过时（D1-D5） | ARCHITECTURE.md | 低 |

## 7. 对 vm 内核设计的启示

1. **挂载点**：vm 内核 = PTH 会话执行基座（覆盖路径 1 真实执行）。审计确认挂 sdkCreateSession（agent-engine.ts:613-621）或 sdk-adapter。
2. **extension 退场**：6 扩展 + _shared 是"代码库"的内容来源；agent-lab-bidder 的相对 import 是改造起点。
3. **统一存储**：4 介质（Redis/SQLite/FS/内存）中，SQLite 是唯一有事务/索引/结构化的——候选统一后端。PTH 零直读 agent-lab.db 的现状（RPC 代理）与"统一"方向冲突，需裁决。
4. **执行路径收敛**：vm 内核若接管回合循环，路径 2/3/4 是否都收敛到 vm？还是保留 pi SDK 原生执行？
5. **agent-lab 地位**：vm 内核统一 extension 后，agent-lab 的模块（taskpool/memory/scheduler）变代码库——agent-lab.db 并入统一存储？

## 8. 侦察引用索引（9 份）

| # | 文件 |
|---|---|
| scout-1 | `scout-1-duplicate-pairs.md`（单复数对=分层） |
| scout-2 | `scout-2-agentlab-module-map.md`（模块地图） |
| scout-3 | `scout-3-src-and-docs-intent.md`（设计意图） |
| scout-4 | `scout-4-assembly-path.md`（assembly 完整路径） |
| scout-5 | `scout-5-runtime-path.md`（runtime 活跃路径） |
| scout-6 | `scout-6-pth-execution.md`（PTH 执行链） |
| scout-7 | `scout-7-ptl-side.md`（PTL 全景） |
| scout-8 | `scout-8-pth-rest.md`（PTH 全景+存储面） |
| scout-9 | `scout-9-extensions-and-arch.md`（扩展生态+根文档） |
