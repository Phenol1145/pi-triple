# Agent Lab Phase 6a 实施计划 — 实验运行时 + 首个托管 WorkLoop

**日期**：2026-07-27　**状态**：已纳入对抗性复核全部发现（GO-WITH-FIXES）
**前置**：main `1223819`，857/857　**基线**：既有 857 测试零修改通过；生产 select 路径零行为变化
**简报**：`docs/plans/2026-07-27-agent-lab-phase-6-planning-brief.md`（复核裁决见下文 §0）
**切分**：P6a = 实验运行时组合 + ModelPort + budgeted-history + context 事件；P6b = selective-summary + 事件投影 + `/lab experiment` 命令；P6c = 可选轮次生命周期集成。

## 0. 对抗复核裁决与锁定决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 上下文策略执行位置 | **Option (b)**：ModelPort 驱动的托管 loop，实验域限定。ModelPort = 命令 ctx 的 `modelRegistry` + pi-ai `complete()` 包装（arena model-caller 先例），usage 捕获需**尽早验证**，fallback = catalog 定价估算并标记 `derived`。Option (c)（委托包装层）**明确否决**——生产无委托包装层可挂（interceptor 只改 input.model），且子代理内部上下文不可测量 |
| D2 | 变体装配 | 新 execute-only scheduler definition `context-experiment@1.0.0`（P6b），独立 SchedulerInstance；agent id = `agent-<model>-<strategy>`；ws/arena 群体与 `modelToAgentCreateSpec` **不动** |
| D3 | 投影数据源 | 基于 `lab_events`（json_extract agentInstanceId/workLoopId），**不是** runs 表；标准事件 `context.transformed`/`context.summary.created` + 插桩 ModelPort 发 `model.requested/completed`；metrics 标记 observed/estimated/derived；质量 P6 手工评分；WorkLoopRunRequest 增 additive `schedulerInstanceId`/`dispatchId` |
| D4 | 调参空间 | 策略选择停留在实验实例域；实验 definition 自带 `tunablePaths`；ws tunablePaths 不动；P5 复用仅限轮次生命周期 |
| D5 | 运行时组合 | 新组合路径：WorkLoopRunner + ports，**无** eventBus/adapter 依赖；两个新 WorkLoopDefinition 元数据须先于 draft validation 注册到 `core.definitions`（service.ts:146-158 校验要求），实现注册到 WorkLoopRegistry（registry.ts:28-49 校验 cloneModes） |
| D6 | 安全 | 托管 loop 骨架内置硬上限（maxModelCalls、maxSummaryCalls、token 天花板）——SDK 无 budget API；实验仅命令驱动前台运行（I8：模型能力只在 hook/command ctx 可得） |
| I1 | 事件身份 | `WorkLoopRunRequest` 增 `schedulerInstanceId?`/`dispatchId?`，由 SchedulerRunner.buildSDK 或实验入口压入事件 identity——否则 DataAPI.listEvents 对实验事件不可见 |
| I3 | 投影新范式 | 实验执行不产生 runs 行；P6b 投影走 lab_events 原生 SQL |
| I5 | 摘要成本 | selective-summary 的摘要 LLM 调用逐次归因（`context.summary.created` + usage metrics） |
| I6 | token 估算 | 无 tokenizer；启发式（chars/4 级）+ `estimated` 源标记（spec §11.4） |
| M2 | checkpoint 谱系 | WorkLoopRunner checkpoint.save 未设 parentCheckpointId——P6a 顺手补（additive） |
| M7 | 隔离 | 实验 agent id 天然隔离 storage/checkpoint 命名空间；托管 loop 必须一致使用 `sdk.context` ops 保证 contextId 谱系 |

**范围外**：生产 ModelPort 模型路由重构、interceptor 改动、ws 参数模型变更、后台实验、judge 质量评分、P5b shadow/canary 评估器复用。

## 1. 任务分解与波次

- **W1**：T1（WorkLoopRunRequest 身份扩展 + checkpoint 谱系）∥ T2（token 估算 + context 事件助手）
- **W2**：T3（实验运行时组合 + WorkLoopDefinition 注册）∥ T4（插桩 ModelPort + 最小 Tool/Artifact ports）
- **W3**：T5（托管 loop 骨架 + budgeted-history@1.0.0）
- **W4**：T6（接线验证 + 集成测试 + 文档）

## 2. 任务规格

### T1 — WorkLoopRunRequest 身份扩展（I1/M2）
- `src/workloop/runner.ts`：`WorkLoopRunRequest` 增 additive `schedulerInstanceId?: string`、`dispatchId?: string`；runner 发事件时 identity 带上两字段（存在才带）。
- 检查 `SchedulerRunner.buildSDK.agents.run`（src/scheduler/runner.ts:869+）是否在调用 WorkLoopRunner 处可压入 instanceId——若该路径生产不可达，则身份由 P6a 实验入口（T3）直接传。
- M2：`checkpoint.save` 记录 `parentCheckpointId`（取该 agent 最新 checkpoint，存在则填）。
- 测试：identity 透传；缺省时不带键（既有事件测试零修改）；parentCheckpointId 链。

### T2 — Token 估算 + context 事件助手（I6/D3）
- `src/workloops/context-metrics.ts`：`estimateTokens(content: unknown): number`（启发式：string → chars/4；结构化 → JSON 序列化后 chars/4，标注限制）；`contextTokenTotal(context)`。
- `src/workloops/context-events.ts`：`emitTransform(sdk.telemetry, {strategyId, kind: "truncate"|"summarize"|"select"|"inject", beforeTokens, afterTokens, droppedSegments, source: "estimated"})` → `context.transformed` 事件（payload + metrics，schemaVersion 约定 "1.0" 并文档化，M4）。
- 测试：估算单调性/边界；事件 payload/metrics 形状。

### T3 — 实验运行时组合（D5/C3）
- `src/runtime/create-experiment-runtime.ts`：组合 LabCore（复用 createCore）+ WorkLoopRegistry + WorkLoopRunner + ports——**不接受/不要求 eventBus**，不构造 PiSubagentsAdapter，不注册 pi-default-loop。
- 提供 WorkLoopDefinition 元数据注册助手（注册 `budgeted-history@1.0.0`；`selective-summary@1.0.0` 的占位 P6b 加）。
- 测试：组合成功；registry cloneModes 校验生效；与 createSchedulerRuntime 互不影响（既有运行时测试零修改）。

### T4 — 插桩 ModelPort + 最小 ports（D1/I2）
- `src/workloops/model-port.ts`：`createInstrumentedModelPort(inner: ModelPort, telemetry)` — 每次 complete 前后发 `model.requested`/`model.completed`（usage: input/output/cost/durationMs，observed 或 derived 标记）；失败发 `model.failed`。
- `createPiModelPort(ctxLike)`: 复用 arena model-caller 的 ctx.modelRegistry + pi-ai compat complete 路径；**usage 捕获优先**，不可得则 catalog 定价估算 + `derived` 标记（实现早期验证并在代码注释记录结论）。
- 最小 ToolPort（拒绝/空实现 + 明确错误——托管 loop v1 无工具）与 ArtifactPort（内存 map）。
- 测试：插桩事件顺序/usage 透传/失败路径；derived fallback 标记。

### T5 — 托管 loop 骨架 + budgeted-history（D6/D1）
- `src/workloops/managed-loop.ts`：共享骨架——config {model, systemPrompt?, maxModelCalls=8, tokenCeiling=32000, maxTurns?}；run：initialContext → 循环（token 超天花板 → 策略变换 → sdk.model.complete → append → 终止条件）→ 硬上限强制；全程 `sdk.context` ops（M7 谱系）；终态输出 StandardAgentOutput.usage 聚合（observed/derived 混合时标注）。
- `src/workloops/budgeted-history.ts`：`budgeted-history@1.0.0`——策略 = 保留 system + 最近 N 条使总量 ≤ budgetTokens（config.budgetTokens，默认 8192），丢弃中段；每次截断发 `context.transformed`（kind truncate，T2 助手）；cloneModes 至少 ["fresh"]（fork 视骨架支持度声明，不支持就不声明——registry 会校验）。
- 测试：预算内不变换；超预算截断正确（system 保留、新近优先）；事件发出；maxModelCalls 强制终止；cloneModes 声明与定义一致。

### T6 — 接线验证 + 集成 + 文档
- 端到端集成测试（内存 fake ModelPort）：createExperimentRuntime → 注册 definition+impl → 构造 AgentInstance（agent-<model>-budgeted）→ WorkLoopRunner.run（带 schedulerInstanceId/dispatchId 身份）→ 断言 context.transformed/model.* 事件链 + identity 完整 + DataAPI.listEvents 可见（I1 闭环验证）。
- README P6a 节（托管 loop、事件词汇、估算启发式与限制、实验域限定）；路线图 §8 部分注记（P6a 完成项，剩余标 P6b/P6c）。
- plan 自检表更新。

## 3. 验收门槛

1. 既有 857 测试零修改通过；生产 select 路径零 diff（interceptor/scheduler-bridge/telemetry 不动）。
2. WorkLoop 行为完全由 AgentDefinition.workLoop config 决定（定义校验通过才注册）。
3. 每次 context 变换有标准事件，identity 含 schedulerInstanceId，DataAPI 可查。
4. 硬上限存在且被测试强制验证；usage 成本 observed/derived 如实标记。
5. checkpoint parentCheckpointId 谱系完整。

## 4. 验证命令

`npm test`；聚焦 `node --experimental-strip-types --test test/workloop-*.test.ts test/workloops-*.test.ts test/runtime-*.test.ts`；runtime smoke import 新模块；`git diff --check`。

## 5. 自检表 (T6 更新)

| # | 项目 | 状态 | 证据 |
|---|------|------|------|
| T1 | WorkLoopRunRequest 身份扩展 + checkpoint 谱系 | ✅ | `src/workloop/runner.ts` schedulerInstanceId/dispatchId additive; checkpoint.save parentCheckpointId auto-set |
| T2 | Token 估算 + context 事件助手 | ✅ | `src/workloops/context-metrics.ts` estimateTokens/contextTokenTotal; `src/workloops/context-events.ts` emitContextTransform/emitSummaryCreated |
| T3 | 实验运行时组合 + WorkLoopDefinition 注册 | ✅ | `src/runtime/create-experiment-runtime.ts` createExperimentRuntime + registerWorkLoopDefinition + BUDGETED_HISTORY_DEFINITION |
| T4 | 插桩 ModelPort + 最小 ports | ✅ | `src/workloops/model-port.ts` createInstrumentedModelPort + createPiModelPort; 错误路径 throw (stopReason error); source 判定 usage != null; 无 _source 泄漏 |
| T5 | 托管 loop 骨架 + budgeted-history | ✅ | `src/workloops/managed-loop.ts` runManagedLoop; `src/workloops/budgeted-history.ts` budgetedHistory; 硬上限 + token 天花板 |
| T6 | 接线验证 + 集成 + 文档 | ✅ | `test/experiment-integration.test.ts` 6 场景全部通过 (共 954 tests 0 fail); README P6a + Roadmap §8 + 自检表 |
| I1 | DataAPI.listEvents 闭环 | ✅ | experiment-integration test (c): DataAPIImpl.listEvents can see experiment events |
| M2 | checkpoint parentCheckpointId 谱系 | ✅ | CheckpointStore.save auto-sets parentCheckpointId from latest pointer |
| M7 | 实验 agent 隔离 | ✅ | experiment-integration test (f): 独立 storage/checkpoint namespace, 跨读失败 |
| D6 | 硬上限 | ✅ | managed-loop maxModelCalls + tokenCeiling; workloops-managed-loop tests 强制验证 |
