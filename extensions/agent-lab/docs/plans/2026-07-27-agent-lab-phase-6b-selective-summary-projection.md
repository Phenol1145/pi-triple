# Agent Lab Phase 6b 实施计划 — Selective-Summary + 对比投影 + 实验命令

**日期**：2026-07-27　**状态**：T5 完成（端到端集成 + 文档验收），P6b 所有任务交付。<br>
**前置**：main `361d23e`，1095/1095　**最终**：1103/1103 测试通过；生产 select 路径零 diff
**上下文**：`docs/plans/2026-07-27-agent-lab-phase-6-planning-brief.md` §0 复核裁决（D1-D6/I1-I8 全部适用于本阶段）；P6a 已交付实验运行时、托管骨架、budgeted-history、事件词汇。

## 0. 沿用锁定决策（P6 复核）

- D1：ModelPort 驱动、实验域限定；命令 ctx 取 modelRegistry（I8：仅命令驱动前台）。
- D2：`context-experiment@1.0.0` execute-only scheduler definition；agent id = `agent-<model>-<strategy>`；ws/arena 不动。
- D3：投影走 `lab_events`（json_extract），不碰 runs 表；`context.summary.created` 带 usage + source 标记。
- D4：实验 definition 自带 `tunablePaths`；ws 参数不动。
- D6：硬上限（maxModelCalls/maxSummaryCalls/tokenCeiling）；摘要成本逐次归因（I5）。
- 其余：估算标记 estimated；quality 手工评分（P6 内不做 judge）。

**范围外**：生产接线（select 路径）、后台实验、judge、ws/arena 变更、轮次生命周期集成（P6c 候选）。

## 1. 任务分解与波次

- **W1**：T1（selective-summary WorkLoop）∥ T2（context-experiment scheduler definition + 变体装配）
- **W2**：T3（事件投影）∥ T4（/lab experiment 命令 + index.ts 接线）
- **W3**：T5（端到端集成 + 文档/路线图验收）

## 2. 任务规格

### T1 — selective-summary@1.0.0（I5/D6）
- `src/workloops/selective-summary.ts`：策略 = 当上下文超 `budgetTokens`（budgetThreshold 契约同 budgeted-history）：取最老的一段消息（config.summaryWindow 或默认 50% 最老），调用 `sdk.model.complete` 生成摘要（专用 system prompt，config.summaryModel 可独立于主 model），把该段替换为一条 summary 消息（role "system" 或 "user" 前缀标记 `[summary]`）。
- 每次摘要发 `context.summary.created`（T2 helper，带 usage + source observed/derived）+ `context.transformed`（kind "summarize"）。
- 硬上限：config.maxSummaryCalls（默认 1/run）；骨架 maxModelCalls 计入摘要调用（防失控）。
- WorkLoopDefinition 元数据 `SELECTIVE_SUMMARY_DEFINITION`（cloneModes ["fresh"]，与 budgeted-history 同构）；definition+impl 一致性测试。
- 测试：欠预算无操作无事件；超预算摘要替换正确（老段→summary 消息、system 保留）；事件链（summary.created 先于 transformed）；maxSummaryCalls 强制；摘要失败 fail-open（回退 truncate 或原样继续——选回退 truncate 并标注，文档化）。

### T2 — context-experiment scheduler definition + 变体装配（D2/D4）
- `src/schedulers/context-experiment.ts`：definition `context-experiment@1.0.0`——execute-only（select 返回 abstain/不支持并文档化）；parameters: `{ assignments: Array<{ model: string; strategy: "default"|"budgeted-history"|"selective-summary"; strategyConfig?: unknown }> }`；validateParameters/validateTransition 校验 assignments 形状与策略枚举；`tunablePaths`: ["assignments"]（D4 自带）。
- 装配助手：`createExperimentInstance(core, {instanceId?, assignments})` — 注册 definition（幂等）→ 创建 draft → 按 assignments 创建变体 agents（id `agent-<model>-<strategy>`，definition.workLoop 指向对应 loop + strategyConfig）→ validate → activate。
- dispatch 选择：dispatcher 按 task 指定或轮转选择 assignment（v1 简单：dispatch 输入带 assignment 索引/策略名，参数化直选，不打分）。
- 测试：参数校验（坏形状/未知策略拒绝）；装配幂等；变体 id 不冲突（同模型三策略共存）；ws/arena bootstrap 测试零修改。

### T3 — 事件投影（D3/I3）
- `src/optimizer/context-projector.ts`（或 src/workloops/——选 optimizer 旁：`src/optimizer/projectors-context.ts`）：原生 SQL over lab_events，按 identity.agentInstanceId（或 workLoopId）分桶，窗口 [since, until)：per-strategy 聚合 {executions, totalInputTokens, totalOutputTokens, totalCost(observed/derived 分开计), avgDurationMs, transforms(count by kind), summaryCalls, summaryCost}；事件类型集：model.completed/context.transformed/context.summary.created + 执行完成事件。
- 输出结构适合命令渲染与未来 Optimizer 消费；NULL/缺失字段防御。
- 测试：种子事件 → 分桶聚合正确；observed/derived 分计；空窗口；未知 agentInstanceId 归入 other 或忽略（选定并文档化）。

### T4 — `/lab experiment` 命令族 + 接线（C2/I8）
- `src/commands/register.ts` 扩展（新可选 dep `experimentFacade`，bootstrap-pending 分支同 optimizer）：`/lab experiment create <model> <strategy...>`（简形：一组 assignments 快捷创建）、`/lab experiment run <instanceId> <task>`（前台执行一次 dispatch→WorkLoopRunner.run，渲染结果+usage）、`/lab experiment status <instanceId>`（实例+轮次+变体列表）、`/lab experiment compare <instanceId>`（T3 投影渲染 per-strategy 对比表）。
- index.ts 接线：命令 ctx → createPiModelPort（真实模型，I8 前台）→ createExperimentRuntime（复用主 store DB 句柄）→ facade；全部 fail-open，不进 dispatch 路径。
- 测试：fake facade 命令层（用法错误/渲染/bootstrap-pending）；facade 逻辑用 fake ModelPort。

### T5 — 端到端集成 + 文档验收
- `test/context-experiment-integration.test.ts`：fake ModelPort 端到端——创建实验实例（1 模型 × 3 策略）→ 每策略 run 一次 → 事件链 → 投影对比输出正确；summary 成本出现在投影；隔离断言。
- README P6b 节；路线图 §8 验收门槛逐条核对标注（P6c 剩余：轮次生命周期集成可选）。
- plan 自检。

## 3. 验收门槛

1. ✅ 既有 1095 测试零修改通过；生产 select 路径零 diff — 证据：`npm test` 全量 1103 通过 (1095 基线 + 8 新增)。
2. ✅ selective-summary 行为完全由其 AgentDefinition.workLoop config 决定；摘要成本逐次归因（事件+投影可见） — 证据：`test/workloops-selective-summary.test.ts` 12 场景；`test/context-experiment-integration.test.ts` test (b) 验证 summaryCost 出现于投影 selective-summary bucket。
3. ✅ 三策略变体同实例并行；storage/checkpoint 命名空间隔离 — 证据：`test/context-experiment-integration.test.ts` test (c) 跨 3 agent 独立 snapshots/checkpoints；test (d) agent createdAtRoundId 统一。
4. ✅ 投影输出 per-strategy token/成本/延迟/变换对比；observed/derived 分计 — 证据：`test/optimizer-context-projector.test.ts` 25 场景；`test/context-experiment-integration.test.ts` test (b) 3-bucket projection。
5. ✅ 命令全部 fail-open；真实模型路径仅命令前台 — 证据：`test/commands-experiment.test.ts` 22 场景 (bootstrap-pending + facade throws + usage errors)。
6. ✅ 路线图 §8 门槛除"基于轮次的实验推广"（P6c）外全部 ✅ — 证据：见 `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md` §8 P6b 交付证据。
7. ⬜ **基于轮次的实验推广** — **显式推迟到 P6c。** P6b 实验轮次独立于 Optimizer 轮次生命周期。

## 4. 验证命令

`npm test`；聚焦 `node --experimental-strip-types --test test/workloops-*.test.ts test/context-experiment*.test.ts test/commands-*.test.ts test/experiment-integration.test.ts`；runtime smoke；`git diff --check`。
