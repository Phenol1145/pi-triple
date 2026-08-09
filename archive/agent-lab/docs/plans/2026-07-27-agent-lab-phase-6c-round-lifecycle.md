# Agent Lab Phase 6c 实施计划 — 实验接入 OptimizationRound 轮次推广（薄闭环）

**日期**：2026-07-27　**状态**：用户确认范围=薄闭环；依据 P6 复核 D4（P5 复用仅限轮次生命周期）
**前置**：main `fb6468f`，1104/1104　**基线**：既有 1104 测试零修改通过；生产 select 路径零变化

## 0. 范围与决策

- 实验实例（context-experiment）接入**通用** ControlPlane 轮次生命周期：assignments 变更 → 六门禁提案 → promote（新轮次）→ 后续 dispatch 钉新轮次；rollback 同理。
- **不做**：新 optimizer 定义、shadow/canary 评估器接入（D4 明确排除）、ws 变更。
- 预期大部分机制已通用存在（tunablePaths ["assignments"]、validateParameters/validateTransition、promote/rollback 通用实现）——P6c = 集成证明 + 缺口修复 + 轮次维度对比 + 文档。

## 1. 任务

### T1 — 轮次生命周期集成证明 + 缺口修复
- `test/context-experiment-rounds.test.ts`：创建实验实例 → submitProposal（改 assignments：加策略/改 strategyConfig）→ 六门禁全部生效（坏参数拒绝、非 tunable 路径拒绝——注意 assignments 是 whole-leaf 数组，diff 语义确认）→ promoteRound → 新轮次 active、旧 superseded、追溯链（optimizer/proposalId）→ 新 dispatch 使用新 assignments → rollbackRound 回退。
- 发现的通用性缺口（如 whole-leaf 数组 diff、assignment 形状在 promote 重校验下的边界）就地修复。
- 既有 core-round-lifecycle 测试零修改。

### T2 — 轮次维度对比
- `src/optimizer/context-projector.ts` 扩展：`projectContextStrategies` 增 `roundId?` 过滤（identity.optimizationRoundId json_extract）+ 按 roundId 分桶模式（compare rounds）。
- facade `/lab experiment compare` 增可选 `--round <roundId>` 与 `--rounds`（两轮对比渲染）。
- 测试：轮次过滤正确、两轮分桶对比。

### T3 — 文档与路线图收尾
- README P6c 节（薄：轮次推广用法示例）；路线图 §8 最后一门 ✅；P6 阶段完整关闭注记。

## 2. 验收

1. ✅ 既有 1104 零修改通过。→ 全量 `npm test` 1146 pass（含 P6c 新增 test/context-experiment-rounds.test.ts），既有无修改。
2. ✅ assignments 提案六门禁端到端生效；promote/rollback 新轮次 + 追溯链完整。→ `test/context-experiment-rounds.test.ts` 覆盖：六门禁拒绝路径（坏参数/non-tunable/instance-mismatch/stale-baseline等）、promoteRound（新 active + old superseded + optimizer/proposalId 追溯）、rollbackRound（assignments revert via new round）。
3. ✅ 投影可按轮次过滤/对比。→ `projectContextStrategies(db, { roundId })` + `projectContextStrategiesByRound(db, ...)` in `src/optimizer/context-projector.ts`；`/lab experiment compare <id> --round/--rounds`。
4. ✅ 路线图 §8 全部 ✅。→ 基于 OptimizationRound 的实验和推广 ✅；轮次生命周期集成 ✅；轮次范围比较 ✅。P6 阶段完整关闭。

## 3. 波次

W1：T1 ∥ T2　W2：T3　然后终审（deepseek-v4-pro）→ 修复 → 合并。
