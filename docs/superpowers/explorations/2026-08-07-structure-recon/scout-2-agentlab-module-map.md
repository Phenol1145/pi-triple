# Scout 2 — agent-lab 模块地图侦察报告

侦察目标：`extensions/agent-lab/src/`（23 个顶层模块）。侦察时间：2026-08-07。
方法：读各模块 index.ts / 主文件头部注释 + 导出 + import 关系图（grep 全量交叉引用）。
所有路径相对 `extensions/agent-lab/src/`。

---

## 1. 模块职责表（每模块一行）

| 模块 | 职责（一句话） | 关键文件 |
|---|---|---|
| `core/` | 框架核心：LabCore 复合体（DefinitionRegistry + CoreRepository + EventLog + NamespacedStore + ControlPlane），定义全部 Definition 契约与实例生命周期 | `core/create-core.ts`, `core/control-plane/service.ts`, `core/contracts.ts` |
| `workloop/` | **agent 执行引擎框架**：WorkLoopRunner（唯一咽喉）+ MachineRuntime（状态机驱动循环）+ 契约/注册表/checkpoint/state-store | `workloop/runner.ts`, `workloop/machine-runtime.ts`, `workloop/machine.ts`, `workloop/contracts.ts` |
| `workloops/` | 具体 WorkLoop 实现（插件层）：pi-default-loop（真实 pi 委托）、market-bid-loop（竞价 δ）、managed-loop 机器核心、budgeted-history/selective-summary（上下文预算）、model-port、pi-delegate-executor | `workloops/pi-default-loop.ts`, `workloops/market-bid-loop.ts`, `workloops/executors/pi-delegate-executor.ts` |
| `scheduler/` | 调度框架层：SchedulerRegistry + SchedulerRunner（dispatch/settle 编排）+ strategy（direct/weighted/market）+ timed-trigger 定时任务 + runner-sdk（`sdk.agents.run` → WorkLoopRunner） | `scheduler/runner.ts`, `scheduler/runner-sdk.ts`, `scheduler/strategy.ts`, `scheduler/timed-trigger.ts` |
| `schedulers/` | 调度器实现：arena-scheduler（market 竞价调度器，活跃）、weighted-scorer、context-experiment（execute-only）、bootstrap（实例/agent 同步）、names（ID 常量） | `schedulers/arena-scheduler.ts`, `schedulers/bootstrap.ts`, `schedulers/weighted-scorer.ts` |
| `arena/` | 竞价市场原语层：SqliteLedger（market_tasks 账本）、bid-board、policies（Endowment/Odds/Settlement/CostModel）、model-caller、agent-id。被 schedulers 与 economy 复用，自身不依赖上层 | `arena/ledger.ts`, `arena/policies.ts`, `arena/types.ts` |
| `economy/` | 市场闭环层（spec §5.1）：MarketStore（economy_tasks/economy_bids，与 arena 表**有意隔离**）、central-pool、escrow、settlement、org 分账、voucher、calibration、Elo、review-round、MarketRunner（§5.1 全图编排）。**未接入命令面/运行路径**，仅测试消费 | `economy/market-runner.ts`, `economy/market-store.ts`, `economy/settlement.ts` |
| `assembly/` | 装配层（spec §2.2/§3.1）：AgentAssembler 六步装配（workloop 解析→校验→记忆域→ledger.open→insertAgent→AgentRuntime）；AgentRuntime = 绑定 AgentDefinition 的可运行主体（run/resume/dispose）；MemoryHost 记忆宿主。**当前无 src 内消费者**（仅测试） | `assembly/assembler.ts`, `assembly/agent-runtime.ts`, `assembly/memory-host.ts` |
| `runtime/` | 运行时组合工厂（当前运行路径）：create-runtime / create-scheduler-runtime / create-experiment-runtime + PiSubagentsAdapter（Delegation V2 传输）+ delegation-v2 协议类型 | `runtime/create-scheduler-runtime.ts`, `runtime/pi-subagents-adapter.ts` |
| `taskpool/`（新） | 任务池域：SqliteTaskStore（pending→claimed→…状态机）、TaskTemplate 注册表、semantic-split 模板、SorterEngine（selector 规则）、cycle（认领→经 scheduler dispatch→失败回流）、sdk（agent 内 reject/submit 端口） | `taskpool/tasks.ts`, `taskpool/engine.ts`, `taskpool/cycle.ts` |
| `memory/`（新） | L3 语义记忆域：MemoryStore（文件系统 entries+anchors+水位 watermark）、MemoryPipeline、RuleRegistry、DspBuilder、EBNF 校验、PublicDomainStore、CommsChannel/IdentityMap、mountMemorySdk | `memory/store.ts`, `memory/pipeline.ts`, `memory/sdk.ts`, `memory/comms.ts` |
| `ingest/`（新） | 文档摄入域：tags/source/docs-source/rule/pipeline/cycle；cycle 把变更文档发布为 taskpool "semantic-split" 任务。**叶子模块，无外部消费者** | `ingest/pipeline.ts`, `ingest/cycle.ts` |
| `optimizer/` | 优化器框架：registry/contracts/facade + auto-flow（验证→canary→promote）、auto-trigger、canary-eval、context-projector（lab_events 投影）、shadow（影子评估）、data-api | `optimizer/facade.ts`, `optimizer/auto-flow.ts`, `optimizer/context-projector.ts` |
| `optimizers/` | 具体优化器实现：weighted-tuner（调 weighted-scorer 权重）、ws-projector（runs 表投影） | `optimizers/weighted-tuner.ts`, `optimizers/ws-projector.ts` |
| `scorer/` | 模型评分：deriveCompletion（完成度合成）、minmax/推荐打分；被 telemetry/weighted-scorer/commands 消费 | `scorer/completion.ts`, `scorer/scorer.ts` |
| `store/` | **遗留遥测存储**：SqliteStore（runs 表：每次 subagent 调用的 role/model/completion/cost）+ pin/config；服务 M1/M2 遥测选模型 | `store/store.ts`, `store/schema.ts` |
| `catalog/` | 模型目录：从 OpenRouter API 拉取 ModelInfo（OR_MODELS_URL），parse/缓存/blendedPrice | `catalog/catalog.ts`, `catalog/parse.ts` |
| `bench/` | HumanEval 基准跑分：run/extract/judge/report/humaneval，经 BenchPorts（dispatch/settle/balance）驱动调度器 | `bench/run.ts` |
| `commands/` | `/lab` 命令族（stats/models/log/pin/config/market/bench/execute/scheduler/optimizer/experiment/schedule/task/doctor）+ agent_lab tool；全部 facade 的消费面 | `commands/register.ts` |
| `interceptor/` | pi 宿主桥接：tool_call 拦截（subagent→调度器 dispatch 桥）、scheduler-bridge（SchedulerRuntimeLike 契约）、model-scope 白名单 | `interceptor/register.ts`, `interceptor/scheduler-bridge.ts` |
| `telemetry/` | 遥测接线：tool_execution_start/end → parseSubagentRun → store.appendRun；settle dispatch 回 arena | `telemetry/register.ts`, `telemetry/parse.ts` |
| `federation/` | 常驻会话系统事件接线：消费 pth EventBus 线协议（external-event / observe RPC / component-bound）→ LabCore.events + SubscriptionDispatcher | `federation/system-events.ts` |
| `experiment/` | `/lab experiment` 命令 facade：context-strategy 对比实验，真实模型调用 + context-projector 投影 | `experiment/facade.ts` |

扩展入口：`index.ts`（扩展根）一次性接线：SqliteStore + telemetry + interceptor + commands + federation + timed-trigger + scheduler runtime + schedulers bootstrap + optimizer + bench + taskpool（templates/tasks/engine）。

---

## 2. 关键重叠/冗余诊断

### 2.1 taskpool vs scheduler/schedulers — 正交，无功能重叠（有 1 个命名混淆点）

- **任务生命周期属主 = taskpool**：`taskpool/tasks.ts` 定义 `TaskRecord` 状态机（pending/claimed/submitted/completed/rejected/escalated），有认领/提交/驳回/回流 API。
- **调度生命周期属主 = scheduler**：`scheduler/runner.ts` 负责"选哪个 agent + 派发执行 + settle 结算"，不含任务队列。
- **衔接点（谁调用谁）**：`taskpool/cycle.ts`（L5-7）直接 import `scheduler/runner-types.ts` 的 `DispatchRequest/DispatchResult` 与 `scheduler/with-timeout.ts`——池循环把认领的任务**经 SchedulerRunner dispatch 执行**，失败后 requeue/reject。方向单向：taskpool → scheduler（scheduler 不反向依赖 taskpool；仅 `workloop/contracts.ts:3` 通过 SDK 携带 `SorterSdkPort` 类型）。
- **轻微重叠**：cycle 的"失败收敛/回流"与 scheduler 的 fallback（`maxFallbackDepth`，runner.ts L53）都处理执行失败，但机制独立、互不干扰。
- **⚠ 发现**：`taskpool/cycle.ts` 与 `ingest/cycle.ts` **均无任何 src 内消费者**（grep 全空）——周期自动派发逻辑是休眠代码，当前只有 `/lab task publish/list/status/requeue` 手工路径（commands/register.ts L746-783）。

### 2.2 memory vs store — 无功能重叠，仅命名混淆

- `store/` = **遥测模型选择存储（旧世界）**：SQLite `runs` 表，每次 subagent 调用的 role/model/completion/cost/聚合。消费者：`telemetry/register.ts`、`commands/register.ts`、`migrate.ts`。与模型选择有关，与 agent 语义无关。
- `memory/` = **L3 语义记忆（新世界）**：文件系统 MemoryEntry（entries + anchors + 水位 watermark），含规则/公域/通讯/方言，服务于 agent 装配与记忆写入。消费者：`assembly/*`（MemoryHost、assembler、comms-bridge、rule-bootstrap、public-bootstrap）、`workloop/contracts.ts`（SDK 端口）、`economy/experience.ts`（settlement 经验写入记忆）、`ingest/pipeline.ts` + `ingest/rule.ts`。
- 结论：**两套完全不同介质/schema**（SQLite runs vs 文件系统 entries），零数据重叠。风险仅是"store"命名在 agent-lab 语境下产生歧义（读者容易以为 memory 的 store 与顶层 store 有关）。

### 2.3 economy vs arena — 层次清晰，但存在两条市场执行引擎（真冗余）

- **边界**：arena = 竞价原语（账本/策略/出价），economy = 市场闭环（§5.1 全图）。依赖方向单向：economy → arena（`economy/escrow.ts`、`market-fns.ts`、`market-effects.ts`、`org.ts`、`review-round.ts`、`central-pool.ts`、`market-runner.ts` 均 import arena），arena 不 import economy。
- **表隔离（有意）**：`economy/market-store.ts` 头部注释明确记录"协调者裁决：不与 arena ledger 的 market_tasks 复用（schema 冲突），新表 economy_tasks/economy_bids 做干净命名空间隔离"。即两套 market 概念并存是**有意的**，但造成了 arena `MarketTaskRow`（market_tasks）vs economy `MarketTask`（economy_tasks）的双轨。
- **⚠ 真冗余**：两条市场执行引擎并存：
  1. `schedulers/arena-scheduler.ts`（market 调度器）——活跃路径，被 SchedulerRunner + `/lab scheduler` + `/lab market` 消费；竞价经 workloop market-bid-loop 或 model-caller，settle 用 arena 的 SettlementPolicyV1。
  2. `economy/market-runner.ts`（MarketRunner，§5.1 全图 announce→persist→shortlist→collect_bids→select→escrow→execute→review→consensus→settle→apply）——**未接入命令面与运行路径**，仅 `economy/index.ts` 导出 + `test/market-integration.test.ts` 消费。
  - 功能上是"同一竞价市场"的两套编排实现，需要 ADR 明确分工或合并。

### 2.4 workloop vs workloops、runtime vs assembly

- **workloop/ vs workloops/**：框架引擎 vs 插件实现，单向依赖，**清晰无重叠**。
- **runtime/ vs assembly/**：**架构张力（真重叠）**——两条"把 workloop 变成可运行 agent"的构造路径并存：
  - `runtime/create-scheduler-runtime.ts` = 当前运行路径：WorkLoopRegistry 直接注册 PI_DEFAULT_LOOP + market-bid-loop，组装 ModelPort/ToolPort/ArtifactPort，**无记忆/账本/身份装配**。
  - `assembly/agent-runtime.ts` = 完整路径：AgentAssembler 六步装配（记忆域初始化 + ledger.open + 身份 + 生命周期），AgentRuntime.run 绑定 AgentDefinition + memory attachSdk + mountSorterSdk。**但 assembly 无任何 src 内消费者**（grep 空），仅 `test/assembly-*.test.ts` 覆盖。
  - 结论：assembly 是更完整的新构造层，但**尚未接线**到 index.ts 运行路径；当前运行路径只走 runtime 轻量组合。两条路径的收敛点是 `workloop/runner.ts`（都注入同一个 WorkLoopRunner）。

---

## 3. 新模块与旧模块的衔接点（import 关系图）

```
                     ┌────────────── extensions/index.ts（接线总纲）──────────────┐
                     │  commands ─ telemetry ─ interceptor ─ federation ─ store  │
                     │  scheduler-runtime ─ schedulers.bootstrap ─ optimizer     │
                     │  taskpool(templates/tasks/engine) ─ bench ─ catalog       │
                     └───────────────────────────────────────────────────────────┘

新模块 ──→ 旧模块（依赖方向）：
  taskpool ─→ scheduler/runner-types.ts（DispatchRequest/Result）
            ─→ scheduler/with-timeout.ts
            ─→ core/contracts.ts（LabEvent）
  taskpool.sdk ─→ workloop/contracts.ts（SorterSdkPort 入 SDK 类型）
  memory ─→ workloop/contracts.ts（MemorySdkPort/CommsSdkPort 入 SDK 类型）
         ─→ core（EventLog? 经 assembly 间接）
  ingest ─→ memory（pipeline/rule 用 MemoryPipeline/MemoryStore/MemoryEntry）
         ─→ taskpool（cycle 用 templates/tasks/semantic-split —— 摄入产出任务池投递）

旧模块 ──→ 新模块：
  assembly/agent-runtime.ts ─→ taskpool/tasks.ts + taskpool/sdk.ts（mountSorterSdk）
  assembly/* ─→ memory/*（MemoryHost、assembler、comms-bridge、rule-bootstrap、public-bootstrap）
  workloop/runner.ts:151 onSdkBuilt 钩子 ─→ assembly/agent-runtime.ts L158-159（memory.attachSdk + mountSorterSdk 注入点）
  economy/experience.ts ─→ memory/entry.ts + memory/pipeline.ts（settlement 经验落记忆）
  ingest/cycle.ts ─→ taskpool（发布 semantic-split 任务）

休眠代码（定义了但无消费者）：
  taskpool/cycle.ts   —— 无 import
  ingest/cycle.ts     —— 无 import
  economy/market-runner.ts —— 仅 index 导出 + 测试
  assembly/*          —— 仅测试
```

**关键机制**：workloop/runner.ts 的 `onSdkBuilt(cb)` 扩展钩子（L151）是 SDK 注入点——assembly AgentRuntime 借此把 memory SDK 与 taskpool sorter SDK 挂进每次 `buildSDK`。当前只有 assembly 用此钩子；runtime 路径不挂 memory/taskpool SDK。

---

## 4. "agent 执行"职责归属诊断

**执行引擎单一，执行入口 4 个。**

- 引擎（唯一咽喉）：`workloop/machine-runtime.ts`（MachineRuntime 状态机驱动循环）+ `workloop/runner.ts`（WorkLoopRunner：checkpoint/resume/遥测/SDK 构建）。所有 agent 执行最终都经过这里。
- 具体实现选择：`workloops/*`（pi-default-loop=真实 pi 委托；market-bid-loop=竞价；budgeted-history/selective-summary=上下文管理）。
- **4 个执行入口**：
  1. `scheduler/runner-sdk.ts`（`sdk.agents.run` → WorkLoopRunner）——dispatch 执行路径（活跃）
  2. `schedulers/arena-scheduler.ts` L336-368（execute mode 经 `sdk.agents.run(winner.agent)` 跑 winner workloop，失败映射 workloop-failed/workloop-error）（活跃）
  3. `taskpool/cycle.ts`（认领→SchedulerRunner dispatch→间接到 1）（休眠）
  4. `assembly/agent-runtime.ts`（AgentRuntime.run/resume，绑定 AgentDefinition + memory/sorter SDK 挂载）（休眠）
- 组装者 2 个：`runtime/*`（当前运行路径，轻量无记忆）、`assembly/*`（完整路径含记忆/账本/身份，未接线）。
- **风险**：`workloop/runner.ts` 的 onSdkBuilt 钩子是 SDK 注入单点，memory 与 taskpool 已都挂在这里；未来更多域（economy?）扩展 SDK 会加剧该钩子的"上帝注入点"压力。若要做"统一 agent 执行主体"，assembly AgentRuntime（run/resume/dispose + 生命周期）是最合适候选，但必须先接线（从 runtime 路径切换到 assembly 路径或让 runtime 复用 assembly）。

---

## 5. 给后续行动的要点（Start Here）

1. **先看** `extensions/agent-lab/index.ts`（扩展接线总纲，约 100+ 行 import）——它决定哪些模块在运行路径上、哪些是休眠的。
2. **执行引擎**：`src/workloop/runner.ts`（L151 onSdkBuilt）+ `src/workloop/machine-runtime.ts`。
3. **两处待决冗余**：(a) arena-scheduler vs economy/MarketRunner 双市场引擎；(b) runtime 轻量组合 vs assembly 完整装配，两条 agent 构造路径。
4. **休眠代码清单**：taskpool/cycle.ts、ingest/cycle.ts、economy/market-runner.ts、assembly/*——若计划"接线新模块"，这里是候选起点；若是"去冗余"，这里是裁剪候选。
