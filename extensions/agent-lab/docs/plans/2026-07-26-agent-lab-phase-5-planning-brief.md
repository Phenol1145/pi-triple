# Agent Lab Phase 5 规划简报 — Optimizer 提案与 OptimizationRound 发布闭环

**日期**：2026-07-26
**状态**：规划输入（供对抗性复核）
**前置**：P1–P4 已合并（main HEAD `9ca0ee8`，479/479 测试）；路线图 `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md` §7 为契约

## 1. 目标（路线图 §7 原样）

实现 OptimizerInstance、OptimizationDataAPI、ParameterProposal、候选轮次、人工推广和回滚。验收门槛：

- Optimizer 不能直接修改 Agent 或 Scheduler 私有状态；
- 提案不能绕过 Schema、安全或版本检查；
- 推广和回滚均创建新轮次；
- 每轮可追溯到 OptimizerInstance、数据窗口和评估；
- 稳定轮次不受 Optimizer 失败影响。

## 2. 范围切分提案：P5a / P5b（与 P4a/P4b 同构）

**P5a（本阶段）— 核心闭环**：
1. Optimizer 契约 + Registry（注册/实例化/配置校验）
2. OptimizationDataAPI（只读数据门面 + 数据授权）
3. ParameterProposal 持久化 + ControlPlane 轮次生命周期操作（propose/promote/rollback，全部经门禁）
4. 平台安全门禁（schema + tunablePaths + 过期基线 + 版本兼容）
5. 参考 Optimizer `weighted-tuner@1.0.0`（读 Weighted Scorer 聚合遥测，产出带评估的提案）
6. `/lab optimizer` 命令族（list/run/proposals/diff/promote/rollback）
7. 全程事件可追溯（trigger/skip/fail/proposal/round 生命周期）

**P5b（后续）— 灰度基础设施**：shadow 离线重打分预览、canary 状态流转、自动触发器（round-end/定时）、auto-promote 策略。P5a 把状态机与接口留好但不实现自动流转。

理由：P5a 单独即可满足全部 5 条验收门槛；shadow/canary 的"基础设施"在 P5a 以状态枚举 + 提案 diff 预览 + 手动流转落地，自动流转留 P5b。

## 3. 现状盘点（已核实）

- `OptimizerDefinition` 已存在于 `src/core/contracts.ts:58`（kind/configSchema/stateSchema/requiredMetrics/compatibleSchedulers/parameterModelVersionRange）
- `OptimizationRoundStatus` 已含全状态机：`initial|proposed|validated|canary|active|rejected|superseded|rolled-back`
- `OptimizationRoundRecord` 已含 `optimizer`/`proposalId`/`parentRoundId` 追溯字段
- Repository 有 `insertRound/getRound/listRounds?`（需确认 list）与 `updateInstance`；**无** proposals 表、**无** optimizer_instances 表
- ControlPlane 现有：createDraft/validateDraft/activateDraft/setCatchAllBinding；**无**轮次生命周期操作
- Runner 已在 dispatch 时钉住 round（`entry.roundId`），切换 currentRoundId 不影响在途 dispatch；settle 用 schedule 时参数快照（P4b）
- Weighted Scorer 聚合遥测：`AggregationEngine`（scorer/aggregates.ts）+ candidates 端口已存在，可按窗口聚合 success/cost/latency
- SchedulerDefinition 有 `parametersSchema` + `tunablePaths`（ws 12 条、arena 13 条，glob 格式）
- 事件系统：LabEvent 自由字符串 eventType，identity 已含 optimizerInstanceId/proposalId 字段

## 4. P5a 设计提案

### 4.1 契约（`src/optimizer/contracts.ts` + core 增补）

```ts
// 只读数据门面 —— Optimizer 的唯一数据通道
interface OptimizationDataAPI {
  getCurrentRound(schedulerInstanceId): OptimizationRoundRecord | undefined;
  listRounds(schedulerInstanceId, limit?): OptimizationRoundRecord[];
  listEvents(filter: { schedulerInstanceId; types?: string[]; since?: number; limit? }): LabEvent[];
  getAggregates(schedulerInstanceId, window: { since?: number; until?: number }): unknown; // scheduler 私有投影，由 Scheduler 注册的 projector 产出
}
```

**数据授权**：OptimizerInstance 配置声明 `targetSchedulers: string[]`；DataAPI 工厂按 instanceId 绑定授权集合，越权访问抛 `DataAccessDeniedError` 并记 `optimizer.access.denied` 事件。Optimizer 实现拿不到 CoreRepository/ControlPlane 句柄（结构性保证"不能改私有状态"）。

```ts
interface ParameterProposal {
  baseRoundId: string;            // 基线（必须为提交时 currentRoundId，否则 stale）
  parameters: unknown;            // 完整新参数集（非 patch —— 不可变、可独立校验）
  evaluation?: { summary: string; metrics: Record<string, number>; dataWindow: { since: number; until: number } };
  metadata?: Record<string, string>;
}

interface OptimizerInstance {
  definition: OptimizerDefinition;
  instanceId: string;
  config: unknown;                // 已过 configurationSchema 校验
  // 触发一次优化；返回提案或 skip/fail 原因
  optimize(ctx: OptimizeContext): Promise<OptimizeResult>;
}
type OptimizeResult =
  | { kind: "proposal"; proposal: ParameterProposal }
  | { kind: "skip"; reason: string }
  // fail 由异常路径统一捕获，记事件
interface OptimizeContext { data: OptimizationDataAPI; now(): number; signal?: AbortSignal }
```

`getAggregates` 的投影由 Scheduler 侧注册：SchedulerDefinition 可选挂 `metricsProjector(events, window) → unknown`（ws 复用 AggregationEngine；arena 挂余额/破产/成交投影）。Optimizer 通过 `compatibleSchedulers` 声明兼容范围，实例化时校验目标 Scheduler 的 id+versionRange 与 parameterModelVersionRange。

### 4.2 持久化（仅新增，零改动旧表）

- `lab_optimizer_instances(id PK, definition_id, definition_version, config_json, target_schedulers_json, status, created_at)`
- `lab_proposals(id PK, optimizer_instance_id, scheduler_instance_id, base_round_id, parameters_json, evaluation_json NULL, status pending|accepted|rejected|superseded, round_id NULL /* 采纳后生成的轮次 */, created_at)`
- 轮次状态迁移走既有 `lab_optimization_rounds`（updateRoundStatus 需新增方法：更新 status/activated_at）

### 4.3 ControlPlane 轮次生命周期（全部事务 + 事件）

1. `submitProposal(optimizerInstanceId, schedulerInstanceId, proposal) → proposalId`
   门禁（任一失败 → `optimizer.proposal.rejected` 事件 + 抛错，不落库或落 rejected 状态——倾向落库 status=rejected 以便审计）：
   - **基线新鲜**：`proposal.baseRoundId === instance.currentRoundId`，否则 `stale-baseline`
   - **版本兼容**：optimizer.compatibleSchedulers 匹配该实例 definition id+version；parameterModelVersionRange 匹配
   - **Schema**：proposal.parameters 过该 SchedulerDefinition.parametersSchema
   - **tunablePaths**：与 base 参数做结构化 diff，所有差异路径必须匹配 tunablePaths glob（复用 `globMatch`）
   - **安全边界**：数值健全性由 schema 表达（min/max）；额外平台规则：参数必须是非空对象
   通过 → proposals 落库(pending) + 创建 status=`proposed` 的候选 round（parentRoundId=baseRoundId, optimizer+proposalId 追溯）+ `optimizer.proposal.submitted` + `round.proposed` 事件。
2. `promoteRound(roundId) → newRoundId`（人工，命令触发）
   - 要求 round.status ∈ {proposed, validated} 且属于活跃实例
   - **创建新轮次**（验收门槛）：新 round 复制候选参数，sequence=MAX+1，parentRoundId=旧 currentRoundId，status=active；旧 active → `superseded`；instance.currentRoundId 原子切换；proposal → accepted
   - 事务内完成；`round.promoted` 事件（含 from/to/proposalId）
3. `rollbackRound(schedulerInstanceId, targetRoundId) → newRoundId`（人工）
   - target 必须是该实例的历史 round；**创建新轮次**复制 target 参数（status=active, parentRoundId=旧 current）；旧 active → `rolled-back`；`round.rolled-back` 事件
   - 禁止 rollback 到 currentRoundId 自身（no-op 防护）

在途 dispatch 不受影响：runner 钉住 roundId + settle 用快照参数（P4b 已保证）。切换只影响新 dispatch。**稳定轮次不受 Optimizer 失败影响**：optimize 异常被捕获 → `optimizer.run.failed` 事件，不触碰任何 round。

### 4.4 参考 Optimizer `weighted-tuner@1.0.0`

- 兼容 `weighted-scorer@^1.0.0`；requiredMetrics: [dispatch 完成事件流]
- 策略（保守、可解释、有界）：
  - 读窗口内 aggregates（每候选 successRate/avgCost/avgLatency）+ 当前 round 参数
  - 规则示例：若某候选成功率显著低于池均值且仍被选中 → 提高 `weights.success` 相对 `weights.cost` 的占比（步长有界，如 ±0.05，clamp 到 schema min/max）；若 p50Latency 超阈值 → 提高 `weights.latency`
  - 数据不足（窗口内 dispatch 数 < minSamples，默认 20）→ `{kind:"skip", reason:"insufficient-data"}`
  - 产出 evaluation：{summary, metrics: 观察值, dataWindow}
- 触发：仅人工 `/lab optimizer run <instanceId>`（P5a 无自动触发器）
- 每个规则独立可测（纯函数 decide(aggregates, params) → adjustments）

### 4.5 命令族 `/lab optimizer`

- `list` — 实例 + 兼容目标 + 状态
- `run <optimizerInstanceId>` — 触发一次；输出 skip/fail/proposal 结果与事件 id
- `proposals [schedulerInstanceId]` — 提案列表（含 evaluation 摘要、状态）
- `diff <proposalId>` — base vs 提案参数的结构化 diff（路径级，标注是否 tunable）
- `promote <roundId>` / `rollback <schedulerInstanceId> <targetRoundId>` — 人工流转，输出新旧 roundId
- `events <schedulerInstanceId>` — 复用 `/lab scheduler events` 即可，不重复造

### 4.6 事件清单（identity 带 optimizerInstanceId/proposalId）

`optimizer.run.triggered|skipped|failed`、`optimizer.access.denied`、`optimizer.proposal.submitted|rejected`、`round.proposed|promoted|rolled-back|superseded`

### 4.7 index.ts 接线

- 启动（lazy factory 内，与 ws/arena 同处）：若 `cfg.scheduler.enabled` → 创建 OptimizerRegistry，注册 weighted-tuner，确保 `default-weighted-tuner` 实例（targetSchedulers=[default-weighted-scorer]，幂等）
- 命令 deps 注入 controlPlane + optimizer facade
- 全部 fail-open：optimizer 任何异常不阻断 dispatch 路径（结构上就不在同一路径）

## 5. 测试策略

- 契约/纯函数：decide 规则矩阵、diff/tunablePaths 校验矩阵、stale 检测
- ControlPlane：propose 各门禁拒绝路径、promote 创建新轮次+旧轮次 superseded+原子性、rollback 对称路径、事件断言
- DataAPI：授权边界（越权抛错+事件）、窗口过滤
- weighted-tuner：固定 aggregates 输入 → 期望 adjustments/skip；步长 clamp
- 命令：全部分支（fake deps）
- 集成：e2e —— 造遥测 → run → proposal → diff → promote → 新 dispatch 钉新 round → settle 用新参数；rollback 回到旧参数；optimizer 抛异常时系统无变化
- 基线：既有 479 测试零修改通过

## 6. 明确不做（P5a）

- 自动触发器/auto-promote/canary 自动流转（P5b）
- Arena 的优化目标（weighted-tuner 只兼容 ws；arena projector 可选挂但无参考 optimizer）
- 多 Optimizer 竞争同一 Scheduler 的仲裁（配置层允许，不特殊处理）
- Optimizer 持久 state（stateSchema 字段保留，P5a 无状态读写）

## 7. 风险

1. **getAggregates 投影边界**：ws 聚合依赖 candidates 端口（内存+DB 混合？）——需确认 AggregationEngine 可否按时间窗口重放；若只能增量内存态，DataAPI 需改为读事件流重放聚合
2. **tunablePaths diff 语义**：数组/嵌套对象路径展开规则需与 scorer 的扁平化逻辑一致（复用 P3 的 flatten 辅助？）
3. **promote 与在途 dispatch 的交互**：已论证安全（钉住+快照），需集成测试证明
4. **提案参数完整集 vs base 的 diff**：parameters 为 unknown，结构化 diff 需防御非对象输入
