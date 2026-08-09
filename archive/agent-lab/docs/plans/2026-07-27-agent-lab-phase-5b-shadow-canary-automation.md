# Agent Lab Phase 5b 实施计划 — Shadow/Canary 自动化与自动发布

**日期**：2026-07-27　**状态**：已纳入对抗性复核全部发现（GO-WITH-FIXES）
**前置**：main `cee9353`，710/710　**基线**：既有 710 测试零修改通过（无 canary 轮次时逐位一致）
**简报**：`docs/plans/2026-07-27-agent-lab-phase-5b-planning-brief.md`（复核裁决见下文 §0）

## 0. 对抗复核裁决与锁定决策

| # | 发现 | 锁定决策 |
|---|------|---------|
| C1 | `promoteRound` 只接受 `proposed`/`validated`（service.ts:537），canary 状态无法 promote | promote 门禁扩展为 `{proposed, validated, canary}`（additive，重校验不变） |
| C2 | 实例表只有 `current_round_id`；钉选在 `SchedulerRunner.dispatchToInstance`（runner.ts:404），`resolveSchedulerInstance` 不存在 | 新增 additive 可空 `canary_round_id` + 实例级 `canaryPercent`；钉选分支落在 runner dispatch 路径 |
| C3 | runs 无关联键，canary 归因不可能；选项 (a) round_id 在写入点不可知、(c) 钉选表冗余（事件日志已是钉选记录） | 新增 additive 可空 `runs.trace_id`，遥测写入时从 `toolCallId` 填充；归因 = `runs.trace_id → events.trace_id → identity.optimizationRoundId`；NULL 旧行排除在精确归因外 |
| C4 | P5a "不动 runner" 与 canary 矛盾 | **显式解除**：P5b 允许对 runner/telemetry/store/config 做 additive、default-off 修改；无 canary 轮次时代码路径逐位一致（作为显式门禁） |
| I1 | shadow "每行重排名" 是范畴错误——scorer 按模型聚合+静态 catalog 排名（scorer.ts:28-58） | shadow = 窗口聚合 + **固定 catalog 快照**下，当前 vs 候选权重的 top-1/top-N 排序对比；产出 selectionChange、预期 completion/cost 差 |
| I2 | scorer 成本维用静态 blendedPrice，非运行时 avgCost | shadow 成本差从 projector avgCost 单独计算，不与 scorer 成本维混淆 |
| I3 | "config 显式开启" 无目标形态；mergeConfig 不合并 optimizer 段 | 新增 `optimizer` 配置段（canaryPercent、autoTrigger{everyNRuns,everyTMs}、autoPromote{enabled,minSamples,epsilonCompletion,epsilonCost}、autoRollback{enabled,minSamples,epsilonCompletion,epsilonCost}、shadow{enabled}），mergeConfig 合并，全部默认关 |
| I4 | 轮次/提案 status 是无约束 TEXT，无需迁移；runs.trace_id 是真 additive 迁移 | 状态字符串直接启用；trace_id 迁移：旧行 NULL；计划如实区分两者 |
| I5 | 小样本 + 无显著性检验下 auto-rollback 是噪声驱动 | auto-rollback 要求 canary 样本 ≥ minSamples **且** 恶化超过 ε（带最小绝对下限）；README/evaluation 如实记录假阳性局限 |
| I6 | 钉选粒度是 SchedulerInstance 级（agent 是按模型的临时候选） | canary = SchedulerInstance 级轮次钉选，计划明文写出 |
| I7 | 自动触发不得阻塞/失败 run 路径 | tool_execution_end 钩子：async fire-and-forget + 节流 + fail-open，绝不抛进 handler、不延迟 settlement |
| M1-M6 | 命名/状态机/单目标返回/门禁措辞/事件幂等 | 全部纳入对应任务；轮次状态机与提案状态机分别绘制（M3）；`validated` 轮次态与 draft `validated` 不混淆（M2） |

**状态机（轮次）**：`active → proposed →（shadow 通过）validated →（canary 启用）canary →（promote，新轮次 active）superseded`；失败路径 `canary → rolled-back`（auto 或手动，均创建新 active 轮次——复用 P5a rollbackRound）。提案状态机不变（pending/accepted/rejected/superseded）。

**范围外**（防蔓延）：Arena canary、多目标 Pareto、显著性检验、setInterval v1、多目标 facade.run（单目标假设如实文档化，M4）、UI 美化。

## 1. 任务分解与波次

- **W1**：T1（optimizer 配置段 + mergeConfig）∥ T2（runs.trace_id + 遥测填充）
- **W2**：T3（canary_round_id + canaryPercent + promote 门禁扩展 + repo 方法）
- **W3**：T4（shadow 引擎 + validated 流转）∥ T5（runner canary 钉选分支）
- **W4**：T6（canary 归因评估 + auto-rollback 策略）∥ T7（自动触发器）
- **W5**：T8（auto-promote + 自动流转编排）
- **W6**：T9（命令扩展 + 接线 + 集成测试 + 文档/路线图）

依赖：T3→T5/T6/T8；T2→T6；T4→T8；T6+T7→T8；T8→T9。同 worktree 并行任务各自显式 stage 自己的文件。

## 2. 任务规格

### T1 — Optimizer 配置段（I3）
- `src/types.ts`：`AgentLabConfig` 增 `optimizer?: { shadow?: {enabled?:boolean}; canaryPercent?: number; autoTrigger?: {enabled?:boolean; everyNRuns?:number; everyTMs?:number}; autoPromote?: {enabled?:boolean; minSamples?:number; epsilonCompletion?:number; epsilonCost?:number}; autoRollback?: {enabled?:boolean; minSamples?:number; epsilonCompletion?:number; epsilonCost?:number} }`。
- `src/config.ts`（或 mergeConfig 所在文件）：深合并 optimizer 段，全部默认关/默认缺省。
- 测试：合并默认值、部分覆盖、未知键忽略、不破坏既有配置测试。

### T2 — runs.trace_id 归因键（C3/L4）
- `src/store/schema.ts`：`runs` 增 `trace_id TEXT`（可空，additive ALTER 或建表含列 + 既有库 ALTER 迁移逻辑——复核现有 schema 迁移机制并沿用）。
- `src/telemetry/`：`tool_execution_end` 写 run 时填充 `toolCallId`；`src/types.ts` RunRecord 加 `traceId?: string`。
- 测试：新行带 trace_id；旧行 NULL 可读；既有遥测测试零修改通过。

### T3 — Canary 指针与 promote 门禁（C1/C2/L3）
- `src/core/storage/schema.ts`：`lab_scheduler_instances` 增 `canary_round_id TEXT`、`canary_percent REAL`（可空）。
- repository：`setCanaryRound(instanceId, roundId, percent)` / `clearCanaryRound(instanceId)`；实例读取带回新字段。
- ControlPlane：`promoteRound` 候选状态集扩展 `{proposed, validated, canary}`；其余门禁不变。
- 测试：canary 指针 set/clear/读取；promote from canary 通过且 supersede 纪律不变；既有轮次生命周期测试零修改通过。

### T4 — Shadow 引擎（I1/I2/Q2）
- `src/optimizer/shadow.ts`：输入 proposalId → 读候选 round 参数 + 当前 round 参数 → projector 窗口聚合（复用 ws-projector）→ **固定 catalog 快照**下两边跑 scoreCandidates → 输出 {selectionChanged, currentTop, candidateTop, expectedCompletionDelta, expectedCostDelta（avgCost 单独算）, samples}。
- 结果写 proposal.evaluation.shadow + `optimizer.shadow.completed` 事件；样本 ≥ minSamples 且评估成功 → 候选 round `proposed → validated`（新 ControlPlane 方法 `markRoundValidated`，带事件）；不足 → 停留 proposed + evaluation.shadow.status="insufficient-data"，**不阻塞 promote**。
- 失败 → 事件 + 标注，绝不抛进提案路径。
- 测试：排序变化/不变、固定快照、catalog 缺失 fail-open、insufficient-data 不阻塞 promote（既有 promote 测试零修改）。

### T5 — Runner canary 钉选（L2/C4）
- `src/scheduler/runner.ts` `dispatchToInstance`：读实例后，若 `canary_round_id` 非空且 `canary_percent>0`，以 `Math.random() < percent/100` 钉 canary 轮次，否则钉 currentRoundId；**每 traceId 一次决定**（现有单次读取语义自然满足）。
- 无 canary 轮次时代码路径逐位一致（不新增读库/分支求值——短路）。
- 测试：无 canary 时既有 runner 测试零修改通过；钉选分布（大样本统计容差）；canary 轮次参数被实际用于打分；事件 identity 已带 optimizationRoundId（断言）。

### T6 — Canary 归因评估 + auto-rollback（L4/L6/L7/I5）
- `src/optimizer/canary-eval.ts`：归集 `runs.trace_id → EventLog.query(traceId) → optimizationRoundId`，分桶 canary vs control，窗口 = canary 激活以来；NULL trace_id 行排除并计数标注。
- auto-rollback 策略纯函数：canary 样本 ≥ minSamples 且 completion 恶化 > ε（含绝对下限）或成本恶化 > ε → 建议 rollback（走 rollbackRound，目标 = canary 前的 active……注意：rollback 目标约束 status∈{active,superseded,rolled-back}——canary 轮次的"回滚"语义是 clearCanary + 候选 round → rolled-back，不是 rollbackRound；新 ControlPlane 方法 `abortCanary`，supersede 纪律 + 事件）。
- 测试：归因分桶正确、NULL 排除、阈值边界、不足样本不动、事件。

### T7 — 自动触发器（L5/I7）
- `tool_execution_end` 钩子内（telemetry register 附近）或其后挂检查：计数/时间节流（内存态即可，重启清零可接受，如实文档化）→ 满足条件则 async fire-and-forget 调 `optimizerFacade.run`；try/catch 全包，不抛不延迟。
- 命令侧惰性检查：`/lab optimizer run` 手动命令不受影响；触发器结果只产生事件/提案，不自动 promote。
- 测试：节流正确、fail-open（facade 抛错不影响 telemetry handler）、默认关闭时零行为。

### T8 — 自动流转编排（L6/C1）
- `src/optimizer/auto-flow.ts`：在给定 tick（T7 触发器回调 + canary 评估后）执行：提案存在 → shadow（T4）→ validated 且 autoCanary 开 → setCanaryRound；canary 样本够 → T6 评估 → auto-promote（调 promoteRound，门禁复用）或 auto-rollback（abortCanary）。
- 每一步同步门禁调用 + 异步决策；拒绝 = 良性事件，无重试循环；并发手动 promote 由门禁自然失败（service.ts 重校验）。
- 全部 auto 步骤默认关；事件链 `optimizer.auto.*`。
- 测试：全链路状态机（pending→validated→canary→promoted / →aborted）、并发手动 promote 竞态安全、默认关闭零行为。

### T9 — 命令/接线/集成/文档
- `/lab optimizer validate <proposalId>`（手动 shadow）、`/lab optimizer canary start|stop|status`（手动 canary）、`/lab optimizer auto`（显示自动配置与节流状态）。
- index.ts 接线（T7 钩子、T8 编排注入）；集成测试端到端：种子 runs（带 trace_id）→ 提案 → shadow validated → canary → 归因累积 → auto-promote。
- README P5b 节 + 路线图 §7 两条 ⬜ → ✅（含 I5 局限如实记录）；plan 自检表。

## 3. 验收门槛

1. 既有 710 测试零修改通过；默认配置（全关）下无 canary 路径逐位一致。
2. shadow 产物可追溯（evaluation.shadow + 事件）；不足不阻塞 promote。
3. canary 钉选可观测（事件已带 roundId）；同 traceId 单轮次不变式保持。
4. auto-promote/auto-rollback 复用全部 ControlPlane 门禁；失败只产生事件。
5. 归因精确（trace_id 链），NULL 旧行排除并标注。
6. 路线图 §7 两条门槛转 ✅。

## 4. 验证命令

`npm test`；聚焦 `node --experimental-strip-types --test test/core-*.test.ts test/optimizer-*.test.ts test/weighted-tuner.test.ts test/scheduler-*.test.ts test/commands-*.test.ts`；runtime smoke import 新模块；`git diff --check`。
