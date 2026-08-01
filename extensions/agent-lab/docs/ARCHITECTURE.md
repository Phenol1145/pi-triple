# Agent Lab 架构（现状视图）

> 本文档是 **agent-lab 扩展的当前实现架构**（single source of truth for structure）。
> 认知模型术语（WorkLoop=δ / Context=纸带 / State=记忆·数据域 / SSP / DSP / Trace…）见 [`CONTEXT.md`](../CONTEXT.md)。
> 设计演进史见 `docs/specs/`（时点性文档，被取代章节已标 SUPERSEDED）与 `docs/plans/`。

## 1. 定位

agent-lab 是 Pi-Triple 的 **agent 经济引擎**：在共享 SQLite 之上提供

- **WorkLoop 状态机引擎**（图灵机模型：有限控制 + 记忆域 + 纸带）
- **市场/竞拍**（arena 竞价 → 任务分派 → WorkLoop 执行）
- **调度器**（定义/实例/fallback 路由 + 参数模型）
- **优化器**（参数提案 → 验证 → canary → 发布闭环）
- **实验运行时**（模板实验 + 选择性摘要投影 + 预算历史）
- **模型目录/遥测/命令面**（`/lab` 全套子命令 + `pit` 侧 TUI/CLI 消费）

单一入口：`extensions/agent-lab/index.ts`（`pi.registerCommand("lab", …)` + 装配 + 启动自检）。

## 2. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│ 命令面 / 装配                                                │
│  index.ts（装配+自检+execute） · commands/register.ts（/lab） │
│  commands/render-*.ts（纯渲染） · arena-display.ts           │
├─────────────────────────────────────────────────────────────┤
│ 上层域逻辑                                                   │
│  scheduler/（调度器 runner：分派/结算/fallback/事件）          │
│  optimizer/（参数提案闭环：提案/canary/影子/自动流）            │
│  experiment/（实验运行时 facade + 运行时装配）                 │
├─────────────────────────────────────────────────────────────┤
│ WorkLoop 引擎                                                │
│  workloop/（machine 契约 · MachineRuntime · runner ·         │
│             checkpoints · context(SSP/DSP) · state-store）    │
│  workloops/（5 个状态机实现 + executors/ + model-port +       │
│             context-events/metrics）                          │
│  runtime/（create-runtime ×3 · delegation-v2 协议 ·          │
│            pi-subagents-adapter）                             │
├─────────────────────────────────────────────────────────────┤
│ 领域底座                                                     │
│  core/（contracts · storage · event-log · control-plane ·    │
│        definitions/registry）                                 │
│  arena/（共享库：ledger/bid-board/policies/model-caller）     │
│  catalog/ · scorer/ · telemetry/ · interceptor/ · store/     │
└─────────────────────────────────────────────────────────────┘
```

依赖方向：上层 → 下层；`core/` 与 `arena/` 不依赖任何上层；`workloop/` 不依赖 `scheduler/`/`optimizer/`/`experiment/`。无环。

## 3. 核心引擎：状态机 WorkLoop

WorkLoop 是 **图灵机模型的工程化**（2026-08-01 状态机化专项落地）：

| 图灵机概念 | 工程实现 |
|-----------|---------|
| 转移表（有限控制） | `MachineDefinition.states/initial/transitions`（`workloop/machine.ts`） |
| 状态转移函数 δ | `MachineDefinition.step(input, state, sdk)` → `StepResult`（**无状态**，纯函数式） |
| 纸带（Context） | `WorkContext`（`workloop/context.ts`）：systemPrompt=SSP 不变量、DSP 派生、事件流 |
| 记忆（数据域） | `MachineState.data` + `state-store.ts`（版本化 KV） |
| 读写头 | LLM 经 `sdk.model` / 委托式经 `PiDelegateExecutor` |
| 状态追踪 | `machine.transition` 事件（转移级 Trace，`transitionSeq` 单调递增） |

### 3.1 执行循环（MachineRuntime）

```
MachineRuntime.step():
  转移表查边（控制状态 × 事件）→ 硬约束校验
  → δ.step() 计算 (next, dataDelta, dsp)
  → 投影（本地式→DSP 进 system；委托式→任务文本前缀）
  → 转移级自动 checkpoint（write-once + parent 链 + latest 指针）
  → 发 machine.transition（identity: transitionSeq/checkpointId；payload: from/to/event）
  → Trace 索引 (traceId, transitionSeq, checkpointId) 互索引
```

- **双约束**：硬约束在转移表/δ（模型不知道也被约束）；软约束=状态投影（SSP/DSP 分界：SSP 不随转移变化，DSP 每轮派生、不落盘）
- **终止**：δ 返回 terminal 优先于 nextStateDef.terminal 兜底（usage 汇总不丢）
- **预算**：maxTurns（可配置，默认 100）+ 转移级守卫
- **resume**：`resumeFromCheckpointId` → `resumeStateOf`（controlState + data + seq 重建）

### 3.2 执行器双轨（executorKind）

| 轨 | 实现 | 适用 |
|----|------|------|
| `pi-delegate` | `PiDelegateExecutor`：把 WorkLoop 事件映射为 pi 子代理委托协议（pi_update/pi_terminal） | pi-default-loop（真实 pi 进程执行） |
| `local-model` | δ 内直接调 DSP 包装后的 `sdk.model`（自驱动，无 executor 类） | managed 家族（budgeted-history/selective-summary）、market-bid-loop |

executor 由 workloop 工厂创建挂 `implementation.executor?`，runner 只读。

### 3.3 五个状态机实现

| WorkLoop | 状态 | 说明 |
|----------|------|------|
| `pi-default-loop` | idle/delegating/terminal | 委托式：pi 事件流驱动转移；progress 镜像（pi.progress） |
| `managed-loop` | check/manage/call/append/done（initial=check） | **共享核心**（managedMachine），无独立实现注册 |
| `budgeted-history` | 继承 managed | 预算 + 历史截断投影 |
| `selective-summary` | 继承 managed | 选择性摘要投影（context-projector） |
| `market-bid-loop` | bidding(单转移) | 市场竞拍：stake/reasoning 入记忆域（不可变出价轨迹） |

## 4. 模块映射

| 目录 | 职责 | 关键文件 |
|------|------|---------|
| `workloop/` | 引擎：契约/状态机/运行时/恢复 | contracts.ts · machine.ts · machine-runtime.ts · runner.ts · checkpoints.ts · context.ts · state-store.ts · registry.ts |
| `workloops/` | 状态机实现 + 执行器 | pi-default-loop.ts · market-bid-loop.ts · managed-loop.ts · budgeted-history.ts · selective-summary.ts · executors/pi-delegate-executor.ts · model-port.ts |
| `runtime/` | 装配 + 委托协议 | create-runtime.ts · create-scheduler-runtime.ts · create-experiment-runtime.ts · pi-subagents-adapter.ts · delegation-v2.ts |
| `scheduler/` | 调度器 runner | runner.ts · runner-sdk.ts · runner-types.ts · contracts.ts · registry.ts |
| `schedulers/` | 调度策略与定义（arena 定义/加权评分/上下文实验） | arena-definition.ts · arena-scheduler.ts · bootstrap.ts · weighted-scorer.ts · context-experiment.ts · names.ts |
| `optimizer/` | 参数提案闭环 | facade.ts · registry.ts · contracts.ts · data-api.ts · auto-flow.ts · auto-trigger.ts · canary-eval.ts · shadow.ts · context-projector.ts |
| `optimizers/` | 优化器实现（权重调优/工作区投影） | weighted-tuner.ts · ws-projector.ts |
| `experiment/` | 实验运行时 | facade.ts（+ runtime 装配） |
| `core/` | 契约/存储/事件/控制面 | contracts.ts · storage/{schema,repository,namespaced-store}.ts · events/event-log.ts · control-plane/service.ts · definitions/registry.ts |
| `arena/` | 共享库（保留前缀，概念称 Market） | ledger.ts · bid-board.ts · policies.ts · model-caller.ts · agent-id.ts · types.ts |
| `catalog/` · `scorer/` | 模型目录 + 加权评分 | catalog.ts · scorer.ts |
| `telemetry/` | 模型调用遥测落库 | register.ts（runs 表） |
| `interceptor/` | pi 内部请求拦截（bridge-only） | register.ts |
| `commands/` | /lab 命令面 + 渲染 | register.ts · render-{scheduler,optimizer,experiment}.ts · arena-display.ts |
| `bench/` | 基准 | run.ts |
| `store/` · `migrate.ts` | 存储 + 迁移 | store.ts |

## 5. 运行时装配

`index.ts`（扩展激活时）按序：

1. `registerTelemetry`（runs 遥测 + settle dispatch）
2. `registerInterceptor`（bridge-only：`agent_lab` 工具桥 → scheduler runtime）
3. `registerCommands`（/lab + agent_lab 工具）
4. 启动自检（SQLite 就绪 / catalog / scheduler.enabled → runtime 装配）

三个运行时工厂（按场景）：

| 工厂 | 注册 | 场景 |
|------|------|------|
| `createRuntime` | pi-default-loop definition+impl | 通用 |
| `createSchedulerRuntime` | + market-bid-loop + arena 装配 | 市场/调度 |
| `createExperimentRuntime` | + budgeted/selective | 实验 |

## 6. 数据布局（共享 SQLite，WAL）

| 表 | 内容 |
|----|------|
| `lab_events` | LabEvent 全量（event_id/type/ts/trace_id/identity/payload/metrics + content_hash 防重） |
| `runs` | 模型调用遥测（token/cost/latency，跨模板） |
| `credit_tx` · `market_tasks` | 市场账本（竞价/结算） |
| `lab_scheduler_drafts/instances` · `lab_optimization_rounds` · `lab_agent_instances` · `lab_routing_bindings` · `lab_proposals` | 控制面持久化 |
| `lab_namespace_kv` | **checkpoint 存储**（write-once + parent 链 + latest 指针 + CAS 版本） |
| `lab_optimizer_instances` | 优化器实例 |

pit 侧消费（`src/ptl/lab-data/` + `session/`）：Provider 注册制——`registerBiddingTraceProvider` / `registerMachineTraceProvider` 读上表 → `listAllTraces()` 聚合 → TUI Dashboard / `pit trace ls`。

## 7. 事件与协议

### 7.1 LabEvent（`core/contracts.ts`）

`{ eventId, eventType, schemaVersion, ts, identity{traceId, executionId, agentInstanceId, optimizationRoundId, workLoopId, workLoopVersion, schedulerInstanceId, dispatchId, transitionSeq?, checkpointId?}, payload, metrics, artifactRefs? }`

事件族：`machine.transition` / `machine.transition_warning`（转移级 Trace）、`pi_update` / `pi_terminal`（委托流）、`pi.progress`（进度镜像）、`credit_tx` / `market_tasks` 账本事件、`workloop_*` 生命周期。

### 7.2 委托协议（delegation-v2）

`SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION` 版本化：request（task + provider 期望）→ `onUpdate` 流式 update（currentTool/currentToolArgs/recentOutput/recentOutputLines/recentTools/model/toolCount/durationMs/tokens）→ terminal（status/code/output/traceId + usage 汇总）。

## 8. 命令面

`/lab` 子命令：`stats · models · log · pin · unpin · config · doctor · migrate · mode · scheduler · market · execute · optimizer · experiment · bench · recommend(废弃)`；工具：`agent_lab`（interceptor 桥）。

## 9. 测试与质量基线

- agent-lab 子套件：`cd extensions/agent-lab && npm test`（node:test，**1288 tests**）
- 全仓：`npx vitest run`（root **614 tests**）+ 根 `tsc --noEmit` 0 错
- 专项工作流：SDD（spec → plan → worker+reviewer → ledger）

## 10. 文档体系关系

| 文档 | 角色 |
|------|------|
| `CONTEXT.md` | 认知模型术语（统一语言，持续演进） |
| 本文档 | 现状实现架构（结构真相源） |
| `docs/specs/2026-08-01-…-design.md` | 状态机化设计（已实现，头部标记） |
| `docs/specs/2026-07-26-…-design.md` | 全局概要设计（§5/§11 已标 SUPERSEDED，历史） |
| `docs/adr/` | 架构决策（0001 bidding modelport · 0002 identity-name） |
| `docs/plans/` | 时点性实施计划（状态机化已完成） |
