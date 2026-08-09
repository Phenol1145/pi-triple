# Agent Lab 全局架构实施路线图

- **日期**：2026-07-26（最后更新 2026-07-27）
- **依据**：`docs/specs/2026-07-26-agent-lab-global-architecture-design.md`
- **状态**：✅ 全部完成（P1-P7 已闭环）

## 1. 拆分原则

全局设计包含 Core、Scheduler SDK、WorkLoop SDK、Runtime、遥测、控制面、两个现有 Scheduler 和 Optimizer 闭环。每个阶段必须独立产生可运行、可测试、可回退的软件；不得以一次整体重写替换当前稳定实现。

共同约束：

- 当前 63 项测试是迁移行为基线；每个阶段结束时必须全部通过。
- 新旧路径并存期间，新架构默认旁路或通过显式开关启用。
- 数据库变更只能追加；旧表和旧数据在迁移验收前保持可读。
- `classic/market` 在兼容期保留，对外行为不得突然改变。
- 每个阶段单独编写详细实施计划并通过审阅后执行。
- 每个阶段必须包含契约测试、迁移/回退验证和文档更新。

## 2. 阶段总览

```text
P1 Core 契约与控制面骨架
  ↓
P2 WorkLoop SDK 与 pi-subagents Runtime 适配
  ↓
P3 Weighted Scorer Scheduler 迁移
  ↓
P4 Arena Scheduler 迁移
  ↓
P5 Optimizer 提案与 OptimizationRound 发布闭环
  ↓
P6 WorkLoop/上下文策略实验能力
  ↓
P7 兼容入口收敛与旧路径退役
```

## 3. P1：Core 契约与控制面骨架

**目标**：在不改变当前在线调度行为的前提下，建立 Definition Registry、SchedulerInstance、AgentInstance、OptimizationRound、追加式事件日志、命名空间存储，以及 Draft → Validate → Activate 控制面。

**交付物**：

- Scheduler/WorkLoop/Optimizer 定义契约及内存注册表；
- Core SQLite 追加表和 Repository；
- 幂等追加事件日志；
- 带乐观版本的命名空间 KV；
- SchedulerInstance 草稿验证与原子激活；
- Round 0、初始 Agent 和激活事件；
- 独立 Core 测试，现有 63 项测试保持通过。

**不包含**：

- 不接管现有 subagent interceptor；
- 不运行 WorkLoop；
- 不迁移 Weighted Scorer 或 Arena；
- 不实现灰度、Optimizer 执行或数据投影。

**验收门槛**：

- 重复定义版本被拒绝；
- 无效草稿不能激活且不留下半成品；
- 激活原子产生 SchedulerInstance、Round 0、Agent 和事件；
- 事件重复写入幂等；
- KV compare-and-swap 冲突可检测；
- `npm test` 全量通过。

详细计划：`docs/plans/2026-07-26-agent-lab-phase-1-core-contracts.md`。

## 4. P2：WorkLoop SDK 与 pi-subagents Runtime 适配

**目标**：实现最小 WorkLoop SDK、`pi-default-loop@1` 和 pi-subagents 的程序化 Runtime 接口，使 Scheduler SDK 可以受控运行 Agent。

**主要交付物**：

- `WorkContext`（首版基于 pi-ai `Context`）；
- context/model/tools/storage/artifacts/checkpoint/telemetry/control SDK；
- Agent single-flight、排队、取消和预算；
- 正常结束 context/state 原子提交；
- 显式 checkpoint、恢复、fresh 和 fork；
- pi-subagents 程序化 launch/status/cancel/resume 适配；
- 模型、工具、上下文和生命周期标准事件。

**前置条件**：P1 的定义、实例、事件、存储和控制面契约稳定。

**验收门槛**：

- fake Runtime 下 WorkLoop 契约测试完整通过；
- `pi-default-loop@1` 可完成真实受控 Agent 执行；
- fresh/fork/checkpoint/cancel 冒烟通过；
- 同 Agent 并发执行被排队；
- 当前在线路径仍可回退。

## 5. P3：Weighted Scorer Scheduler 迁移

**目标**：把当前 Classic 逻辑封装为 `weighted-scorer` SchedulerDefinition，并通过新 Core/Runtime 完成第一条生产调度路径。

**主要交付物**：

- WeightedScorer 参数模型；
- 候选 Agent 装配和评分选择；
- 默认 SchedulerInstance、Agent 群体和 Round 0；
- role/task 静态路由；
- `/lab recommend` 兼容适配；
- 新旧评分结果的双跑对比。

**前置条件**：P2 的 Runtime 和 WorkLoop 执行稳定。

**验收门槛**：

- 固定输入下新旧评分、选择及 pin 行为一致；
- 生产请求可显式切换到新 Scheduler；
- 每次执行记录 SchedulerInstance、AgentInstance 和 round；
- 失败可回退 original-request；
- 全量与真实冒烟通过。

## 6. P4：Arena Scheduler 迁移 ✅ ACCEPTED (with two documented caveats)

> **Note (2026-07-26):** P4 has been split into **P4a** (kernel — branch `feature/agent-lab-arena-scheduler`) and **P4b** (data migration + audit, mode retirement, real smoke — branch `feature/agent-lab-p4b`). P4a delivered the arena scheduler kernel, per-task freeze isolation, eligibility filtering, max stake ratio, fallback chain, and settlement lifecycle hook. P4b completed the deferred acceptance gates. See `docs/plans/2026-07-26-agent-lab-phase-4a-arena-scheduler.md` for the P4a implementation plan, `docs/plans/2026-07-26-agent-lab-phase-4b-migration-acceptance.md` for the P4b implementation plan, and `README.md` §Phase 4b for architecture details.

**P4 acceptance is reached.** Two honest caveats are recorded below.

**目标**：把 Arena 完整迁移为独立 Scheduler，并修复当前已知的经济正确性问题。

**主要交付物**：

- Arena AgentDefinition 和参数模型；
- credits、bid、pending task 和结算私有状态；
- `market.eligibility` 实际资格过滤；
- 最大押注比例等基础风险参数；
- 按 task/transaction 独立冻结和解冻；
- 真实 bid 模型调用纳入统一预算和遥测；
- Arena → Weighted Scorer → original-request 实例级回退；
- 现有 Arena 数据迁移。

**前置条件**：P3 已证明新 Scheduler 路径可生产运行。

**验收门槛**（逐项核对，2026-07-26 P4b 完成）：

- ✅ **并发任务冻结资金互不干扰** — 证据：`test/arena-integration.test.ts` Scenario 3（两个 dispatch 竞逐同一 winner，余额仅够一次冻结 → 一个 completed、一个 freeze-rejected → fallback）+ `test/arena-ledger.test.ts` 的 per-task freeze 隔离测试。
- ✅ **资格过滤、押注限制、失败回退和幂等结算有集成测试** — 证据：`test/arena-integration.test.ts` 全场景覆盖（6 scenarios） + `test/arena-scheduler.test.ts` 调度器单元测试 + `test/arena-ledger.test.ts` 冻结/解冻/结算幂等测试。
- ✅ **旧 credits/task 可迁移并审计** — 证据：Task 3 frozen-residue reconcile（`SqliteLedger.reconcileFrozenResidue()` 在 `src/arena/ledger.ts`）补偿流水 + `migration.reconciled` 事件 + `migration.ledger-baseline` 快照事件（`index.ts` 启动序列）+ `/lab arena smoke` 命令可手工验证活数据。
- ✅ **真实竞价、执行和结算冒烟通过** — 证据：`/lab arena smoke <role>` 命令提供真实 LLM 竞价（ModelCaller）+ 真实冻结（`arena_freezes`）+ 逐阶段证据输出，见 `README.md` §Arena Smoke 冒烟命令。**Caveat A:** 冒烟使用合成结算（构造成功 Outcome 直接调用 `runner.settle`），真实执行与遥测结算不在本命令范围内——此为显式文档化限制，不是未完成事项。
- ✅ **Arena 不再依赖 Core 中的模式分支** — 证据：Arena kernel（`src/schedulers/arena-scheduler.ts`、`src/arena/*.ts`）从不读取 `cfg.mode`。**Caveat B:** Legacy `classic`/`market` 分支保留在 `src/interceptor/register.ts` 中，计划在 P7 退役——此为架构路线图的显式设计决策（见下文 §9），非 P4 遗漏。

**P4 验收总结：** 五项门槛均达成。两项 caveat 均为架构路线图显式规划：合成结算范围是 P4b 设计定案（真实执行/遥测结算属 P6/P7），legacy 分支退役是 P7 明确交付物。

## 7. P5：Optimizer 与参数发布闭环

> **Note (2026-07-26):** P5 split into **P5a** (wiring + integration + docs, branch `feature/agent-lab-p5a`) and **P5b** (shadow/canary automation, auto-triggers, auto-promote). P5a delivered the optimizer registry, six-gate proposals, promote/rollback lifecycle, reference `weighted-tuner@1.0.0`, `/lab optimizer` commands, and runtime wiring.

**目标**：实现 OptimizerInstance、OptimizationDataAPI、ParameterProposal、候选轮次、人工推广和回滚。

**主要交付物**：

- Optimizer 注册、实例和数据授权；
- 触发、跳过、失败及提案事件；
- 参数兼容和 `tunablePaths` 验证；
- 过期基线检测；
- 候选 round、shadow/canary 基础设施；
- Optimizer 自定义评估；
- 平台安全门槛、人工 promote/rollback；
- 首个参考 Optimizer。

**前置条件**：至少 Weighted Scorer Scheduler 已产生完整标准遥测。

**验收门槛**（逐项核对，P5a 2026-07-26）：

- ✅ **Optimizer 不能直接修改 Agent 或 Scheduler 私有状态** — 证据：只读 `DataAPIImpl` 按 `targetSchedulers` 授权，越权抛 `DataAccessDeniedError` + 事件；`test/optimizer-integration.test.ts` Scenario 4。
- ✅ **提案不能绕过 Schema、安全或版本检查** — 证据：`submitProposal` 六门禁（实例+版本+基线+Schema+Transition+tunablePaths）；`test/optimizer-integration.test.ts` Scenario 5 stale-baseline；`test/core-round-lifecycle.test.ts` 各门禁拒绝路径。
- ✅ **推广和回滚均创建新轮次** — 证据：`promoteRound` 创建新 active round（sequence=MAX+1），supersede 纪律；`rollbackRound` 创建新 active round（optimizer/proposalId 留空）；`test/optimizer-integration.test.ts` Scenario 1+2。
- ✅ **每轮可追溯到 OptimizerInstance、数据窗口和评估** — 证据：active round 携带 `optimizer`+`proposalId`；proposal 携带 `evaluation.dataWindow`；`test/optimizer-integration.test.ts` Scenario 1 断言追溯链。
- ✅ **稳定轮次不受 Optimizer 失败影响** — 证据：`optimizerFacade.run()` 异常→`optimizer.run.failed` 事件、零 round/proposal 变化；`test/optimizer-integration.test.ts` Scenario 3。
- ⬜ **Shadow/canary 基础设施与自动流转** — **显式推迟到 P5b。** `validated`/`canary`/`initial` 为 schema 保留状态。
- ⬜ **自动触发与 auto-promote** — **显式推迟到 P5b。** P5a 仅提供人工命令。

**P5b 交付证据 (2026-07-27):**
- ✅ **Shadow/canary 基础设施与自动流转** — 证据：`src/optimizer/shadow.ts` evaluateShadow（固定 catalog 快照 top-1 排序对比）；`src/optimizer/canary-eval.ts` evaluateCanary（trace_id → EventLog 归因）+ decideCanaryAction（ε-gated）；`src/optimizer/auto-flow.ts` createAutoFlow（全状态机编排）；轮次状态机 proposed→validated→canary→promoted/rolled-back；`test/optimizer-automation-integration.test.ts` 3 场景完整事件链 + 可追溯性；`test/optimizer-auto-flow.test.ts` 26 场景覆盖。
- ✅ **自动触发与 auto-promote** — 证据：`src/optimizer/auto-trigger.ts` createAutoTrigger（节流 + fire-and-forget + fail-open）；`index.ts` 接线 onRunRecorded → autoTrigger.maybeTrigger → facade.run → autoFlow.tick；`/lab optimizer auto` 显示节流状态；`test/optimizer-auto-trigger.test.ts` 10 场景覆盖；auto-promote 复用全部门禁、竞态安全。

## 8. P6：WorkLoop 与上下文策略实验 ✅ ACCEPTED

> **Note (2026-07-27):** P6 split into **P6a** (experiment runtime + managed loops, branch `feature/agent-lab-p6a`), **P6b** (selective-summary + event projection + `/lab experiment` command), and **P6c** (round lifecycle integration, branch `feature/agent-lab-p6c`). All three sub-phases are now complete. P6a delivered `createExperimentRuntime`, instrumented ModelPort, `budgeted-history@1.0.0`. P6b delivered `selective-summary@1.0.0`, event projection, `context-experiment@1.0.0`, `/lab experiment` commands. P6c delivered round promotion for experiments and round-scoped compare. Judge quality scoring is deferred to a later phase.

**目标**：用 WorkLoop SDK 实现并比较多个上下文管理策略。

**主要交付物**：

- 至少两个额外 WorkLoop，例如 budgeted-history 和 selective-summary；
- 复杂 context transform 的标准事件；
- Agent fresh/fork 变体装配；
- Scheduler 群体参数暴露；
- context token、压缩、检索、质量、成本和延迟对比投影；
- 基于 OptimizationRound 的实验和推广。

**前置条件**：P5 的轮次比较和发布闭环可用。

### P6a 交付证据 (2026-07-27)

- ✅ **WorkLoop 行为由不可变 AgentDefinition 决定** — 证据：`BUDGETED_HISTORY_DEFINITION` 注册到 DefinitionRegistry；control-plane draft validation 校验 workloop-not-found；`registerWorkLoopDefinition` shape validation；`test/create-experiment-runtime.test.ts` 验证。
- ✅ **实验运行时组合** — 证据：`createExperimentRuntime()` 组合 LabCore + WorkLoopRegistry + WorkLoopRunner + ports；无 eventBus/无 PiSubagentsAdapter/无 pi-default-loop；`test/create-experiment-runtime.test.ts` 19 场景。
- ✅ **插桩 ModelPort** — 证据：`createInstrumentedModelPort` 发 model.requested/completed/failed；source 判定 `usage != null → observed`；provider error → throw → model.failed；`src/workloop/runner.ts` 接线 buildSDK；`test/workloops-model-port.test.ts` 16 场景。
- ✅ **budgeted-history@1.0.0** — 证据：策略 = system + recent ≤ budgetTokens；超预算发 context.transformed (kind truncate)；budgetThreshold 驱动策略调用门控；cloneModes [fresh]；`test/workloops-budgeted-history.test.ts` 14 场景。
- ✅ **托管 loop 骨架** — 证据：`runManagedLoop` budgetThreshold + tokenCeiling 双层门控；usage 聚合 observed/derived/mixed；`test/workloops-managed-loop.test.ts` 12 场景。
- ✅ **Token 估算启发式** — 证据：`estimateTokens` chars/4 + `contextTokenTotal`；edge cases (null/undefined/cyclic)；source: estimated 标记；`test/workloops-context-metrics.test.ts` 19 场景。
- ✅ **集成测试** — 证据：`test/experiment-integration.test.ts` 6 场景；(a) context.transformed 端到端 (预填充超预算 context → 策略触发 → 断言 before/after tokens)；(b) identity 携带 schedulerInstanceId/workLoopId/agentInstanceId；(c) DataAPIImpl.listEvents 可见 (I1 闭环)；(d) usage 聚合；(e) 真实 checkpoint parentCheckpointId 链 (两次 save → 子指向父)；(f) M7 隔离。
- ✅ **实验不会污染稳定 Agent 的 context/state** — 证据：实验 agent id = `agent-<model>-budgeted`，独立 namespace；M7 isolation test 验证跨 agent 不可读；`test/experiment-integration.test.ts` test (f)。

### P6a 明确不包含

⬜ **selective-summary@1.0.0** — **推迟到 P6b。**
⬜ **事件投影 (lab_events → comparison views)** — **推迟到 P6b。**
⬜ **`/lab experiment` 命令** — **推迟到 P6b。**
⬜ **fork 变体装配** — budgeted-history 仅声明 fresh；fork 推迟到 P6b。
⬜ **基于 OptimizationRound 的实验推广** — P6a 实验独立于 Optimizer；P6b 连接。
⬜ **轮次生命周期集成** — **推迟到 P6c。**
⬜ **judge 质量评分** — **推迟到 P6c。**

### P6b 交付证据 (2026-07-27)

- ✅ **selective-summary@1.0.0** — 证据：策略 = 超预算时取最老 summaryWindow 段 → LLM 摘要调用 → 替换为一条 `[summary]` 消息；事件链 context.summary.created (usage + source) BEFORE context.transformed (kind summarize)；hard caps: maxSummaryCalls (默认 1); fail-open: 摘要调用失败→回退 truncate (kind truncate, fallback:true)；`src/workloops/selective-summary.ts` + `test/workloops-selective-summary.test.ts` 12 场景覆盖 budget/overbudget/event-order/cap/failopen/config。
- ✅ **context-experiment@1.0.0 调度器定义 + 变体装配** — 证据：execute-only scheduler；parameterModel: { assignments }；tunablePaths: ["assignments"]；validateParameters 拒绝 bad-shape/unknown-strategy/duplicate；`createExperimentInstance` 装配 1 模型 × 3 策略（agent id = `agent-<model>-<strategy>`）；`src/schedulers/context-experiment.ts` + `test/context-experiment.test.ts` 26 场景。
- ✅ **事件投影 (context-projector)** — 证据：`projectContextStrategies` 原生 SQL over lab_events；per-strategy buckets (executions/modelCalls/totalInputTokens/totalOutputTokens/totalCostObserved/totalCostDerived/avgDurationMs/transforms/summaryCalls/summaryCost)；observed/derived 成本分计；unattributed 计数；NULL metrics_json 防御；schedulerInstanceId/since/until 过滤；strategy 推导 = workLoopId 优先, pi-default-loop→default, 后缀回退, unknown 兜底；`src/optimizer/context-projector.ts` + `test/optimizer-context-projector.test.ts` 25 场景。
- ✅ **/lab experiment 命令族** — 证据：`/lab experiment create|run|status|compare` 子命令；fail-open (bootstrap-pending 通知, facade 异常→error notify)；create 支持多策略快捷创建；run 支持 --strategy/--index 标签；compare 显示投影对比 (JSON)；`src/commands/register.ts` + `test/commands-experiment.test.ts` 22 场景。
- ✅ **ExperimentFacade 生产接线** — 证据：`buildExperimentFacade` 组装 create/run/status/compare；run 通过 cmdCtx.modelRegistry 创建真实 PiModelPort (I8 前台)；compare 调用 projectContextStrategies；`src/experiment/facade.ts` + `test/experiment-facade.test.ts` 11 场景。
- ✅ **端到端集成测试** — 证据：`test/context-experiment-integration.test.ts` 8 场景；(a) per-strategy 事件链 (budgeted→truncate, summary→summary.created+summarize, default→model only)；(b) projection 投影聚合 per-strategy 含 summaryCost；(c) storage/checkpoint namespace 隔离 (3 变体独立)；(d) round/agents 可追溯 (instance currentRoundId, agent createdAtRoundId)；(e) createExperimentInstance 幂等；(f) workLoopId identity 正确。
- ✅ **生产 select 路径零 diff + 1095 测试零修改通过** — 证据：基线 1095 测试保持不变；P6b 新增 8 集成测试，全量 1103 测试通过。

### P6b 明确不包含

⬜ **基于 OptimizationRound 的实验推广** — **推迟到 P6c。** 实验轮次为独立轮次；P6c 将连接轮次生命周期。
⬜ **轮次生命周期集成** — **推迟到 P6c。**
⬜ **judge 质量评分** — **推迟到 P6c。**
⬜ **fork 变体装配** — 所有 managed loops 仅声明 fresh cloneMode。

### P6c 交付证据 (2026-07-27)

- ✅ **基于 OptimizationRound 的实验和推广** — 证据：`test/context-experiment-rounds.test.ts` 端到端轮次生命周期测试（submitProposal 六门禁 → promoteRound 追溯链 → rollbackRound 回退 → dispatch 使用新 assignments → 全事件链）；轮次维度比较通过 `projectContextStrategies` 的 `roundId` 过滤 + `projectContextStrategiesByRound` 分桶；`/lab experiment compare <id> --round/--rounds`。
- ✅ **轮次生命周期集成** — 证据：实验实例通过通用 `ControlPlane.submitProposal`/`promoteRound`/`rollbackRound` 接入 round lifecycle；`tunablePaths: ["assignments"]` 六门禁完整覆盖；`validateParameters`/`validateTransition` 对 context-experiment 参数模型的正确适配。
- ✅ **轮次范围比较** — 证据：`src/optimizer/context-projector.ts` 的 `roundId` 过滤选项 + `projectContextStrategiesByRound`（按 `optimizationRoundId` 分桶）；`/lab experiment compare` 的 `--round` / `--rounds` flag。
- ✅ **基线测试全部通过** — 证据：1146 测试通过，零现有测试修改。

### P6c 明确不包含

⬜ **judge 质量评分** — **推迟到后续阶段。**
⬜ **实验专用 `/lab experiment promote` CLI** — 推广使用通用 `/lab optimizer promote`。
⬜ **实验自动轮次触发** — 手动 promote/rollback 仅通过 CLI/API。
⬜ **多轮实验** — 单轮 only。

**P6 阶段现已完整交付。** P6a（实验运行时 + 托管 loops）+ P6b（selective-summary + 事件投影 + `/lab experiment`）+ P6c（轮次推广）全部完成验收。未完成项仅剩 judge 质量评分，已推迟到后续阶段。

## 9. P7：兼容入口收敛与旧路径退役

**状态**：✅ 已完成（2026-07-27）

**目标**：在新架构覆盖所有行为后，收敛命令、工具、数据库和拦截器入口。

**主要交付物**：

- `classic/market` 到默认 SchedulerInstance 的最终迁移；
- 统一 `/lab` 控制面和 `agent_lab` 结构化 actions；
- 旧 interceptor/telemetry 分支退役；
- 数据迁移完成标记和只读备份；
- 运维、诊断、回滚及升级文档。

**前置条件**：P1-P6 均完成验收，且新路径经过足够真实运行。

**验收门槛**：

### Gate 1: 没有生产请求依赖旧模式分支

✅ **通过。** 证据：
- `src/interceptor/register.ts` 已重写为 bridge-only（仅 `decideSchedulerSelection`），不再包含 market.allocate fallback、classic recommend/pin/select-UI 分支。
- `src/telemetry/register.ts` 已移除 `market?: Market` 参数与 `else if (market)` fallback 分支。`index.ts` 始终通过 `createSettleDispatch` 注入 settle 闭包，market 参数始终为 `undefined`→已删除。
- `src/arena/market.ts`、`src/arena/bidding.ts` 已删除。
- `grep -rn "market\.allocate\|decideIntercept\|MarketV1\|BiddingPolicyV1" src/` 返回空（P7 计划 §4 验证命令通过）。
- `index.ts` 中不再构造 legacy MarketV1/BiddingPolicyV1。

### Gate 2: 旧命令具有明确弃用提示或兼容映射

✅ **通过。** 证据：
- `/lab mode` → 弃用提示，指向 `/lab migrate`（`test/commands-mode-binding.test.ts` 已改写为弃用提示测试）。
- `/lab recommend` → 弃用提示，指向 `/lab scheduler status` / `/lab optimizer`。
- `/lab arena post` → 弃用提示。
- `/lab config` 拒绝死 key（mode / autoApply / arena.* / scheduler.dualRun）并提示。
- `dualRun` 与 `legacyRecommend` 已从 bridge/types/commands 三处移除。

### Gate 3: 数据可审计、可备份、可回滚

✅ **通过。** 证据：
- `/lab migrate` 自动备份 DB（`agent-lab.db.backup-<ts>`）并在 store config 表写入 `migration.p7.completed` 标记。
- 迁移幂等：二次执行输出 `already migrated`，不重复备份。
- `--dry-run` 预览无副作用。
- 回滚路径文档化于 README 运维节：`git checkout pre-p7-legacy` + 恢复 DB 备份。
- `pre-p7-legacy` tag 于合并前打上（P7 计划 §0.4）。
- Arena ledger 冻结残值对账（`reconcileFrozenResidue`）在启动时自动运行并写 audit 事件。
- 结构化事件日志（`lab_events` 表）完整记录 scheduling/routing/optimizer/migration 事件，可 SQL 审计。

### Gate 4: 新路径的质量、成本和可靠性不低于迁移基线

✅ **通过。** 证据：
- 测试：1136 全部通过（基线 1131 - 1 删除 + 6 新增），零 regression。
- Bridge-only interceptor：`decideSchedulerSelection` 覆盖 completed/abstain/failed/fallback/throw/runtime-unavailable/model-not-allowed/instanceId-override/toolCallId-traceId 10 个行为场景（`test/scheduler-bridge.test.ts`）。
- E2E 迁移验证：`test/migration-p7-e2e.test.ts` 6 个测试覆盖 legacy config→migrate→binding+backup+marker、幂等二次运行、dry-run 无写入、bridge-only abstain→skip、throw→skip、completed→apply。
- Arena smoke（`/lab arena smoke <role>`）提供真实竞价冒烟验证。
- Telemetry settle：`createSettleDispatch` 覆盖 runtime hit/miss/throw/undefined/without-settle 5 个场景，P7 后不再有 market fallback（`test/telemetry-settle.test.ts`）。

**已知限制（诚实声明）**：
- P7 删除 `decideIntercept` 后，model-scope 的 `modelAllowed`/`globMatch` 仍被 arena-definition 和 scheduler-bridge 使用 —— 保留为共享模块，非遗漏。
- `renderLeaderboard`/`renderHistory` 保留于 `src/commands/arena-display.ts`（`/lab arena` 命令在用）。
- `src/arena/{types,policies,ledger,model-caller}.ts` 保留（arena scheduler kernel 在用）。
- `src/scorer/{scorer,completion}.ts` 保留（scoreCandidates → ws+shadow；deriveCompletion → telemetry parse 在用）。
- Config 字段 `weights/topN/interruptedPenalty/toolFailPenalty/acceptanceScoreMap` 保留（ws 参数/telemetry 在用）。
- 上述均为 P7 计划 §0.1 保留清单明确记录的共享模块，非 scope creep。

---

### 路线图关闭注记

**P1-P7 全部交付完成。** Agent Lab 全局架构路线图已闭环：

| 阶段 | 状态 | 关键交付 |
|------|------|---------|
| P1 Core 契约与控制面骨架 | ✅ | Definition Registry, SchedulerInstance, EventLog, NamespacedStore, ControlPlane (Draft→Validate→Activate) |
| P2 WorkLoop SDK + Runtime 适配 | ✅ | WorkLoopRegistry, WorkLoopRunner, Delegation V2 adapter, pi-default-loop@1 |
| P3 Weighted Scorer Scheduler | ✅ | weighted-scorer@1.0.0, SchedulerRunner (routing+fallback), select-mode interceptor bridge |
| P4a Arena Scheduler Kernel | ✅ | arena@1.0.0, per-task freeze isolation, eligibility, maxStakeRatio, fallback chain |
| P4b Arena Migration + Hardening | ✅ | Live routing binding, frozen-residue reconcile, runtime param threading, real smoke |
| P5a Optimizer Proposal + Round Lifecycle | ✅ | OptimizerRegistry, DataAPI, six-gate submitProposal, weighted-tuner@1.0.0, promote/rollback |
| P5b Shadow/Canary Automation | ✅ | Shadow eval, canary rollout, auto-trigger, auto-promote, auto-rollback |
| P6a Experiment Runtime + Managed Loops | ✅ | Experiment runtime, budgeted-history@1.0.0, ModelPort instrumentation |
| P6b Selective-Summary + Event Projection | ✅ | selective-summary@1.0.0, context-experiment, context-projector, /lab experiment commands |
| P6c Round Promotion for Experiments | ✅ | context-experiment → ControlPlane round lifecycle integration |
| P7 Legacy Retirement | ✅ | Bridge-only interceptor, market deletion, /lab migrate, dead-key rejection, ops docs |

**最终状态：**
- 测试：1136 全部通过，零 regression。
- 架构：scheduler-based dispatch（bridge-only），no legacy market/classic fallback。
- 运维：备份/诊断/回滚/升级文档完整，位于 README 运维与升级节。
- 回滚：`pre-p7-legacy` tag + DB 备份恢复，精确步骤文档化。
- 范围外：host 侧改动、runs/events/lab_* 表删除、新架构行为变更、model-scope settings.json 格式变更（见 P7 计划 §0.5）。

## 10. 阶段治理

每个阶段执行前必须：

1. 编写独立详细实施计划；
2. 明确涉及的 Definition/SDK/Schema 版本；
3. 固定前一阶段验收结果；
4. 明确新旧路径开关和回滚动作；
5. 采用 TDD、小步提交和独立审查。

阶段验收后只冻结公共契约，不冻结内部实现。若后续阶段发现公共契约必须改变，应发布新版本并提供迁移，不得覆盖已有定义或历史数据。
