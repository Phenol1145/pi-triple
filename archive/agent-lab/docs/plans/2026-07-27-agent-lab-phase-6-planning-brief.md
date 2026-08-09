# Agent Lab Phase 6 规划简报 — WorkLoop 与上下文策略实验

**日期**：2026-07-27　**状态**：待对抗复核
**前置**：main `1223819`（P5b 已合并，857/857）；路线图 §8；P2 WorkLoop 运行时、P5 轮次闭环均可用。

## 1. 背景与目标

路线图 §8：用 WorkLoop SDK 实现并比较多个上下文管理策略。交付物：≥2 个额外 WorkLoop（budgeted-history、selective-summary）、context transform 标准事件、fresh/fork 变体装配、Scheduler 群体参数暴露、上下文策略对比投影、基于 OptimizationRound 的实验与推广。

验收门槛：WorkLoop 行为由不可变 AgentDefinition 决定；不同策略可作为不同 AgentInstance 并行；fork 仅用已提交 checkpoint；指标足够 Optimizer 评价策略；实验不污染稳定 Agent 的 context/state。

## 2. 现状关键事实（已初步勘察）

- `WorkLoopImplementation` 契约完整（contracts.ts）：initialContext/initialState/forkState/run + SDK（context ops、ModelPort、ToolPort、checkpoint、telemetry、storage、artifacts）。
- 生产唯一 WorkLoop 是 `pi-default-loop@1.0.0`（src/workloops/），它把执行委托给 pi-subagents Delegation V2——**子代理自己管理内部上下文**，WorkLoop 层看不到也控制不了子代理的消息历史。
- `WorkLoopSDK.model/tools` 是可注入端口，但生产接线是 `createSchedulerRuntime(store.raw, {})`（index.ts:122）——无 eventBus 时 **ModelPort/ToolPort 根本不存在于生产**。pi-default-loop 只用 delegation adapter。
- Agent 创建走 `modelToAgentCreateSpec`（bootstrap.ts），全部钉 `pi-default-loop` + `contextMode: "fresh"`；AgentDefinition 含 `workLoop: {id, version, config}`（core/contracts.ts:81），不可变、版本化。
- P5 已提供 OptimizationRound 实验/推广闭环；ws 参数 tunablePaths 目前是 7 个 dot-path（权重等），不含 agent/workloop 相关键。

## 3. 核心架构疑问（需对抗复核裁决）

**Q1（最关键）**：上下文策略在哪里执行？
- (a) 委托路径内不可能——子代理自治。
- (b) WorkLoop 直接用 ModelPort+ToolPort 实现完整 agent loop（model→tools→append→循环），上下文策略在 WorkContext 上操作（truncate/summarize/select）。这需要生产提供真实 ModelPort（模型调用从哪来？复用 interceptor 的模型路由？）。
- (c) 上下文策略=装配层：WorkLoop 在**委托前**对任务包/历史注入做预算控制（例如 fork 模式下挑选注入哪些历史片段），子代理内部仍自治。
- 倾向 (b) 或 (c)，但需要复核裁决哪个符合"上下文策略实验"的语义且工程量可控。

**Q2**：Scheduler 群体参数如何暴露？ws 的 agent 群体是 per-model 候选（modelToAgentCreateSpec）。变体装配（同一模型 × 不同 WorkLoop/上下文策略 = 不同 AgentDefinition → 不同 AgentInstance）意味着群体从"每模型一个 agent"变为"每模型×每策略一个 agent"。dispatcher 选择语义如何变化？还是实验只发生在**独立实验 SchedulerInstance**（不动 ws 群体）？

**Q3**：对比投影的数据从哪来？上下文策略指标（token 数、压缩率、检索命中、质量、成本、延迟）需要 WorkLoop 遥测（sdk.telemetry.emit）落到事件日志，再做 projector。现有事件/遥测管道是否够用？metrics 字段的落库与查询支持吗？

**Q4**：OptimizationRound 实验的调参对象是什么？若策略选择是 AgentDefinition 级（不可变），则轮次参数需要能引用"策略集"——ws tunablePaths 要不要扩展？还是 P6 用独立实验实例+手工对比，不碰 ws 门禁？

## 4. 范围提案（待复核后锁定）

1. **两个新 WorkLoop 实现**（src/workloops/）：`budgeted-history@1.0.0`（token 预算截断策略）与 `selective-summary@1.0.0`（选择性摘要策略），共享一个"托管 agent loop"骨架（ModelPort 驱动）。
2. **context transform 标准事件**：每次上下文变换（truncate/summarize/select/inject）发出结构化事件（类型、前后 token 估算、丢弃段数、策略 id、roundId）。
3. **变体装配**：`modelToAgentCreateSpec` 扩展支持策略维度；实验实例可并行运行 default/budgeted/summary 变体（不同 AgentInstance）。
4. **对比投影**：新 projector（context 策略维度），输出 per-strategy 的 token/成本/延迟/质量聚合。
5. **实验命令**：`/lab experiment ...` 或扩展 `/lab optimizer`——创建实验实例、跑对比、查看投影。
6. **可选接入 P5 闭环**：若 Q4 裁决支持，策略参数进入轮次调参空间。

## 5. 明确不做

- 不改 pi-default-loop 行为（稳定路径）。
- 不做生产 ModelPort 的真实模型路由重构（除非 Q1 裁决要求——那会是最大工程量项）。
- 不动 ws 现有群体语义（除非 Q2 裁决要求）。
- 不做 GUI；不做统计显著性检验。

## 6. 验收门槛草案

1. 两个新 WorkLoop 行为完全由各自 AgentDefinition（workLoop config）决定；default 路径零行为变化（857 基线）。
2. 三策略可作为不同 AgentInstance 并行；fork 仅用已提交 checkpoint（沿用 P2 不变式）。
3. 每次 context transform 有标准事件；投影能输出 per-strategy 对比指标。
4. 实验 AgentInstance 的 context/state 与稳定 Agent 完全隔离（独立 contextId 谱系 + 独立 storage 命名空间）。
5. 路线图 §8 验收门槛逐条落实。
