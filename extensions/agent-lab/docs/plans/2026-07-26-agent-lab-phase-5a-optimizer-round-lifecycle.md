# Agent Lab Phase 5a 实施计划 — Optimizer 提案与 OptimizationRound 发布闭环

**日期**：2026-07-26　**状态**：已纳入对抗性复核全部 20 项发现（GO-WITH-FIXES）
**前置**：main `9ca0ee8`，479/479　**基线**：既有 479 测试零修改通过
**简报**：`docs/plans/2026-07-26-agent-lab-phase-5-planning-brief.md`（复核发现见下文 §0）

## 0. 对抗复核裁决与锁定决策

| # | 发现 | 锁定决策 |
|---|------|---------|
| C1 | AggregationEngine 不存在；ws 无窗口/轮次归因数据；ws 无 settle 钩子→无 outcome 事件 | **Option A**：ws 投影 = legacy `runs` 表窗口化 SQL（`WHERE role=? AND ts BETWEEN ? AND ? GROUP BY model`）；如实文档化"时间重叠近似归因"；P7 迁移注记。**不动 runner** |
| C2 | 真实参数模型是 `weights.{completion,costEffectiveness,performance,benchmark}`；指标只有 runs/avgCompletion/avgCost/successRate | 规则重写（T5）；latency 规则砍掉；performance/benchmark 不可由运行时数据调（静态 catalog 数据），规则只触 completion/costEffectiveness |
| I3 | `updateInstance`/`updateRoundStatus`/`listRounds` 不存在；`transaction()` 嵌套抛错 | T2 显式新增三方法；每个 ControlPlane 操作独占事务，禁止组合嵌套 |
| I4 | 并发提案无 supersede 纪律；旧候选仍可 promote | promote/rollback 时：同实例其他 pending 提案→superseded（+事件），其候选 round→superseded；且 promote 内对**当前** round 重跑 tunablePaths diff + validateTransition |
| I5 | `validateTransition` 实现了但无人调用 | submitProposal 门禁强制调用 `definition.validateTransition?.(base, proposed)` |
| I6 | rollback 绕过全部校验、目标不受限 | 目标约束：status ∈ {active, superseded, rolled-back}；复制参数后重跑 validateParameters + validateTransition；文档化"依赖实例钉住 definition 版本"不变式 |
| I7 | EventLog.query 不支持 schedulerInstanceId/since | T2 扩展 query：json_extract(identity_json) + ts 谓词（不加索引，P5 量级扫描可接受） |
| I8 | promote 不复制 optimizer/proposalId 会断追溯链 | promote 新轮次复制 candidate 的 parameters + optimizer + proposalId |
| I9 | 无 semver-range 匹配器 | T1 新建 `src/core/version-range.ts`：支持 exact、`*`、`^x.y.z`、`~x.y.z` 子集，其余形式拒绝（显式报错不静默） |
| I10 | 单活跃轮次无 DB 约束且 smoke 已违规（raw SQL） | promote/rollback 只迁移 `instance.currentRoundId` 指向的那一个 round；若检测到 >1 active 行→失败并报错（不自动修复）；sequence=MAX+1 在事务内计算；smoke raw SQL 旁路**祖父条款**留 P7，计划不声称"唯一写入者" |
| M11 | ws tunablePaths=7 条精确路径无 glob；globMatch 大小写不敏感 | diff 语义：叶子路径枚举；数组变化视为整体叶子；**大小写敏感**精确匹配为主，支持 `*` 段（自写 matcher，不复用 globMatch） |
| M12 | 字段名是 `configurationSchema` | 代码用真实名 |
| M13 | 接线 gating 与 lazy factory 模式不一致 | optimizer 注册进同一个无条件 lazy factory；所有 `/lab optimizer` 命令带 bootstrap-pending 分支 |
| M14 | proposals 表需 candidate_round_id + promoted_round_id 双列 | T2 schema 照此 |
| M15 | 窗口/minSamples 未定 | 窗口默认 = `[currentRound.createdAt, now]`；minSamples=20（runs 行数）；零流量安装永久 skip 是正确保守行为，文档化 |
| M16 | requiredMetrics 无强制语义 | P5a 仅声明性；但实例化时若目标 scheduler 无注册 projector → 拒绝创建实例 |
| M17 | validated/canary/initial 为死状态 | 文档化为 P5b 保留，不假装有活跃状态机 |
| M18 | pendingSettlements 进程内 | 仅注记，不动 |

## 1. 范围

**做**：Optimizer 契约+Registry、OptimizationDataAPI（只读+授权）、Proposal 持久化、ControlPlane 轮次生命周期（submit/promote/rollback 全门禁）、参考 Optimizer `weighted-tuner@1.0.0`、`/lab optimizer` 命令族、事件追溯、集成测试、README/路线图。
**不做（P5b）**：shadow/canary 自动流转、自动触发器、auto-promote、arena 参考 optimizer、optimizer 持久 state。
**保护路径**：`src/scorer/**`、`src/catalog/**`、`src/store/**`（除 T2 纯新增方法外零改动——runs 窗口 SQL 放 DataAPI 投影侧，不动 SqliteStore）、`src/scheduler/runner.ts`、`src/interceptor/**`、`src/telemetry/**`、`src/arena/**`、`package.json`。

## 2. 任务分解

### Task 1 — 版本范围匹配器 `src/core/version-range.ts`

**文件**：`src/core/version-range.ts`（新）、`test/core-version-range.test.ts`（新）
```ts
export function matchesVersionRange(version: string, range: string): boolean // 抛 RangeSyntaxError 于不支持形式
```
- 支持：`*`、exact（`1.0.0`）、`^x.y.z`（同 major，>=指定）、`~x.y.z`（同 major.minor，>=指定）
- 其他形式（`>=`、`||`、连字符范围…）抛 `RangeSyntaxError`（显式拒绝，不静默失配）
- version 非法 semver 同样抛错
- 测试矩阵：每形式命中/未命中/边界（^1.0.0 vs 2.0.0 ✗、~1.2.0 vs 1.3.0 ✗、pre-release 拒绝）

### Task 2 — 存储扩展：新表 + Repository 方法 + EventLog 查询

**文件**：`src/core/storage/schema.ts`、`src/core/storage/repository.ts`、`src/core/events/event-log.ts`、`test/core-optimizer-storage.test.ts`（新）
- **schema（纯追加）**：
  - `lab_optimizer_instances(id TEXT PK, definition_id, definition_version, config_json, target_schedulers_json, status TEXT /* active|disabled */, created_at INTEGER)`
  - `lab_proposals(id TEXT PK, optimizer_instance_id, scheduler_instance_id, base_round_id, parameters_json, evaluation_json NULL, status TEXT /* pending|accepted|rejected|superseded */, candidate_round_id NULL, promoted_round_id NULL, created_at INTEGER)`
  - 建表幂等（`CREATE TABLE IF NOT EXISTS`），追加进既有 ensure 函数
- **Repository 新方法**：`insertOptimizerInstance/getOptimizerInstance/listOptimizerInstances`、`insertProposal/getProposal/listProposals(schedulerInstanceId?)/updateProposalStatus(id, status, promotedRoundId?)`、`updateInstanceCurrentRound(instanceId, roundId)`、`updateRoundStatus(roundId, status, activatedAt?)`、`listRounds(schedulerInstanceId, limit?)`
- 旧方法零改动；`transaction()` 嵌套抛错行为不变（测试断言）
- **EventLog.query 扩展**：filter 增加 `{ schedulerInstanceId?: string; since?: number; until?: number }`——`json_extract(identity_json,'$.schedulerInstanceId')` + `ts` 谓词；旧调用签名兼容（可选字段）；不加索引
- 测试：两表 CRUD、listProposals 过滤、round 状态更新、query 三新过滤维度单独与组合、旧 query 测试不变绿

### Task 3 — Optimizer 契约 + Registry + OptimizationDataAPI

**文件**：`src/optimizer/contracts.ts`、`src/optimizer/registry.ts`、`src/optimizer/data-api.ts`（新）、`test/optimizer-registry.test.ts`、`test/optimizer-data-api.test.ts`（新）
- **契约**（用 core 既有 `OptimizerDefinition`，字段名 `configurationSchema`）：
```ts
export interface ParameterProposal {
  baseRoundId: string;
  parameters: unknown;                 // 完整参数集，非 patch
  evaluation?: { summary: string; metrics: Record<string, number>; dataWindow: { since: number; until: number } };
  metadata?: Record<string, string>;
}
export type OptimizeResult = { kind: "proposal"; proposal: ParameterProposal } | { kind: "skip"; reason: string };
export interface OptimizeContext { data: OptimizationDataAPI; now(): number; signal?: AbortSignal }
export interface OptimizerInstance {
  definition: OptimizerDefinition; instanceId: string; config: unknown;
  optimize(ctx: OptimizeContext): Promise<OptimizeResult>; // 异常=fail，由调用方捕获记事件
}
```
- **DataAPI**（只读；按实例授权 `targetSchedulers`；越权抛 `DataAccessDeniedError` + `optimizer.access.denied` 事件）：
```ts
export interface OptimizationDataAPI {
  getCurrentRound(id): OptimizationRoundRecord | undefined;
  listRounds(id, limit?): OptimizationRoundRecord[];
  listEvents(filter: { schedulerInstanceId: string; types?: string[]; since?: number; until?: number; limit? }): LabEvent[];
  getCandidateAggregates(id, window: { since: number; until: number }): unknown; // 经 scheduler projector
}
```
  - projector 注册表：`registerMetricsProjector(schedulerDefinitionId, projector)`（module 级，ws projector 在 T5 注册）；无 projector → getCandidateAggregates 抛 `ProjectorNotRegisteredError`
  - 每个方法先查授权集合
- **Registry**：`registerOptimizer(definition)`（校验 kind/configurationSchema/compatibleSchedulers 非空）；`createOptimizerInstance(definitionRef, { instanceId, config, targetSchedulers })`：config 过 `configurationSchema`（复用 core 的 schema 校验器——查 `src/core/definitions/` 既有实现复用，无则最简 required/type 校验）；每个 target 校验：scheduler 实例存在 + `compatibleSchedulers` id 匹配 + versionRange 匹配（T1）+ `parameterModelVersionRange` 匹配实例 `parameterModelVersion` + 该 scheduler definition 有已注册 projector（M16）
- 事件：`optimizer.instance.created`；失败路径 `optimizer.run.failed` 由 T4/T6 调用方记
- 测试：registry 注册/校验/兼容矩阵（versionRange 各形式）、DataAPI 授权边界（越权每方法抛错+事件）、projector 未注册

### Task 4 — ControlPlane 轮次生命周期 + 参数 diff 工具

**文件**：`src/core/parameter-diff.ts`（新）、`src/core/control-plane/service.ts`、`test/core-parameter-diff.test.ts`（新）、`test/core-round-lifecycle.test.ts`（新）
- **parameter-diff.ts**：
```ts
export function diffLeafPaths(base: unknown, next: unknown): string[]   // 叶子级路径枚举；数组变化=整体叶子路径；非对象防御
export function assertPathsTunable(paths: string[], tunablePaths: string[]): void // 大小写敏感；exact 或 * 段匹配；任一不可调→TunablePathViolationError 列出违规路径
```
- **ControlPlane.submitProposal(optimizerInstanceId, schedulerInstanceId, proposal) → { proposalId, candidateRoundId }**，门禁按序（失败 → proposals 落库 status=rejected + `optimizer.proposal.rejected` 事件 + 抛 `ProposalRejectedError(reason)`）：
  1. 实例存在且 active；optimizer 实例存在且 targetSchedulers 含该实例
  2. **版本兼容**：compatibleSchedulers id+versionRange（T1）+ parameterModelVersionRange
  3. **基线新鲜**：`proposal.baseRoundId === instance.currentRoundId`（否则 stale-baseline）
  4. **Schema**：`validateParameters` 于 proposal.parameters
  5. **Transition**：`definition.validateTransition?.(baseRound.parameters, proposal.parameters)`
  6. **tunablePaths**：diffLeafPaths(base, proposed) 全部可调
  通过 → 事务内：proposal 落 pending + 创建候选 round（sequence=MAX+1 事务内算，parentRoundId=baseRoundId，status=proposed，optimizer+proposalId 追溯）+ proposal.candidate_round_id 回填 + 事件 `optimizer.proposal.submitted`、`round.proposed`
- **ControlPlane.promoteRound(candidateRoundId) → { newRoundId }**：
  - 候选 status ∈ {proposed, validated}；所属实例 active；**防御**：该实例 active round 行数 ≠1 → 失败（不自动修复）
  - 对**当前** round 重跑：validateParameters + validateTransition(current.params, candidate.params) + tunablePaths diff（防 I4 陈旧全量参数静默回滚）
  - 事务内：新 round（复制 candidate 的 parameters+optimizer+proposalId，sequence=MAX+1，parentRoundId=旧 currentRoundId，status=active，activatedAt=now）；旧 current round→superseded；candidate→superseded；instance.currentRoundId=新；proposal→accepted(promoted_round_id 回填)；同实例其他 pending proposals→superseded + 其 candidate rounds→superseded；事件 `round.promoted`（from/to/proposalId）、`optimizer.proposal.superseded`（每个）
- **ControlPlane.rollbackRound(schedulerInstanceId, targetRoundId) → { newRoundId }**：
  - target 属于该实例、≠currentRoundId、status ∈ {active, superseded, rolled-back}
  - 重跑 validateParameters + validateTransition(current.params, target.params)（I6）
  - 事务内：新 round（复制 target.parameters；optimizer/proposalId **留空**；parentRoundId=旧 current；status=active）；旧 current→rolled-back；currentRoundId 切换；同实例 pending proposals→superseded；事件 `round.rolled-back`（actor 字段=命令调用者标识字符串 "manual"）
- 全程事件 identity 带 schedulerInstanceId/optimizationRoundId/optimizerInstanceId/proposalId（可得时）
- 测试：六门禁各自拒绝路径、promote 全链路（新轮次/旧轮次状态/追溯字段/supersede 纪律/事件）、promote 对陈旧候选的重校验拒绝、rollback 对称路径+目标约束+no-op 防护、多 active 防御、事务原子性（中途注入失败→无部分状态）

### Task 5 — 参考 Optimizer `weighted-tuner@1.0.0` + ws 投影

**文件**：`src/optimizers/weighted-tuner.ts`（新）、`src/optimizers/ws-projector.ts`（新）、`test/weighted-tuner.test.ts`（新）
- **ws-projector**：`registerMetricsProjector("weighted-scorer", (ctx) => …)`——对 legacy `runs` 表窗口化 SQL：`SELECT model, COUNT(*) runs, AVG(completion) avgCompletion, AVG(cost) avgCost, AVG(tool_success) successRate FROM runs WHERE role=? AND ts>=? AND ts<? GROUP BY model`（role 从哪来：projector 签名 `(db: DatabaseSync, window, opts: { role?: string })`；DataAPI.getCandidateAggregates 透传 role 可选参数；文档化：时间重叠近似归因，P7 迁移注记）。**不改 SqliteStore**，直接用同库 `db` 句柄
- **weighted-tuner 定义**：`compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "^1.0.0" }]`；`parameterModelVersionRange: "1.0.0"`；`requiredMetrics: ["runs","avgCompletion","avgCost","successRate"]`（声明性）；configurationSchema：`{ minSamples?: number(默认20), step?: number(默认0.05), margin?: number(默认0.1) }`
- **decide(aggregates, currentWeights, cfg) → adjustments | null（纯函数）**：
  - 窗口总 runs < minSamples → null（skip insufficient-data）
  - **质量规则**：被选中最多（runs 最大）的候选 successRate < 池均值×(1−margin) → `weights.completion += step`（clamp schema min/max；文档化 schema 边界来源）
  - **成本规则**：窗口 avgCost（选中最多候选）> 池均值×(1+margin) → `weights.costEffectiveness += step`
  - 两条可同时触发；无触发 → null（skip no-actionable-signal）；**不触** performance/benchmark（静态 catalog 数据）
  - 产出 evaluation：{summary 人读, metrics: 观察值全集, dataWindow}
- optimize()：窗口= `[currentRound.createdAt, ctx.now()]`（M15）；组装完整新参数集（current.parameters 深拷贝+权重调整）
- 测试：decide 矩阵（数据不足/质量触发/成本触发/双触发/无信号/clamp 边界）、projector SQL 窗口过滤、optimize 端到端（fake DataAPI）

### Task 6 — `/lab optimizer` 命令族

**文件**：`src/commands/register.ts`、`test/commands-optimizer.test.ts`（新）
- deps（可选注入，与 P4b 同模式）：`optimizerFacade?: { list(); run(instanceId); proposals(schedulerInstanceId?); diff(proposalId); promote(roundId); rollback(schedulerInstanceId, targetRoundId) }`
- 子命令：`list`（实例+兼容目标+状态）、`run <id>`（输出 proposal/skip/fail + 事件 id）、`proposals [sid]`（含 evaluation 摘要）、`diff <proposalId>`（base vs 提案叶子路径 diff，标注 tunable ✓/✗——复用 parameter-diff）、`promote <roundId>`、`rollback <sid> <targetRoundId>`（输出新旧 roundId）
- 每个子命令：deps 缺失 → "optimizer unavailable (bootstrap pending)" notify（M13）；错误 → fail-open notify
- 测试：fake facade 覆盖全部子命令与错误分支

### Task 7 — 接线 + 集成测试 + 文档

**文件**：`index.ts`、`test/optimizer-integration.test.ts`（新）、`README.md`、`docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md`
- **index.ts**（lazy factory 内，ws bootstrap 之后）：注册 ws projector；注册 weighted-tuner 定义；幂等确保 `default-weighted-tuner` 实例（targetSchedulers=["default-weighted-scorer"]；ws 实例不存在则跳过不报错）；构造 optimizerFacade 注入 registerCommands；facade.run 包装 optimize()：触发前 `optimizer.run.triggered`、skip→`optimizer.run.skipped`、异常→`optimizer.run.failed`（异常绝不传播到 dispatch 路径——命令路径独立）
- **集成测试**（真实 Core+store 临时库）：
  1. e2e 闭环：造 runs 数据 → run → proposal(pending) → diff → promote → 断言新 active round 钉住新参数+追溯链完整（round→proposalId→evaluation.dataWindow）→ runner dispatch 使用新 round → rollback → 参数复原（新轮次）
  2. supersede 纪律：两 pending 提案 promote 其一，另一自动 superseded 且其候选不可 promote
  3. 失败隔离：optimize 抛异常 → 事件记录、无任何 round/proposal 变化、dispatch 不受影响
  4. 越权：tuner 实例 targetSchedulers 不含 arena → DataAPI 访问 default-arena 抛错+事件
  5. stale baseline：提交后 promote 改变 currentRound，再以旧 base 提交 → stale-baseline 拒绝
- **README**：P5a 章节（架构图文字版、门禁清单、命令用法、数据窗口近似归因的诚实说明、P5b 保留项）
- **路线图**：P5 验收门槛逐条核对标注（P5a 达成部分 + shadow/canary 自动流转显式留 P5b）

## 3. 依赖与执行波次

- Wave 1：T1 ∥ T2（无交集）
- Wave 2：T3 ∥ T4（T3 需 T1+T2 契约面；T4 需 T2；文件无交集）
- Wave 3：T5 ∥ T6（T5 需 T3；T6 需 T3/T4 类型面，测试全 fake；文件无交集）
- Wave 4：T7（需全部）
- 每波：worker（deepseek-v4-pro:high）+ 任务审查（同模型）；修复波 flash；整分支终审 kimi-coding/k3:high

## 4. 验证

- `npm test` 全绿（479 基线 + 新增）
- 聚焦：core/optimizer/commands/集成
- runtime smoke：optimizer 模块可 import
- `git diff --check`；保护路径零 diff；package.json 不变

## 5. 风险与缓解

1. **runs 窗口归因近似** → 如实文档化；evaluation.dataWindow 标注 time-overlap 语义；P7 迁移注记
2. **validateTransition 签名核实** → T4 第一步读 `src/schedulers/weighted-scorer.ts:161` 与 `arena-definition.ts:326` 真实签名再写调用
3. **schema 校验器复用** → T3 先查 `src/core/definitions/` 既有校验实现，无则最简实现并测试
4. **promote 重校验 vs 基线校验的语义差异** → 测试显式覆盖"提交时合法、promote 时因中间轮次变化不再合法"场景
