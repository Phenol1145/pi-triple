# Agent Lab Phase 7 实施计划 — 兼容入口收敛与旧路径退役

**日期**：2026-07-27　**状态**：已纳入对抗性复核全部发现（GO-WITH-FIXES）
**前置**：main `9c5a288`，1149/1149　**基线**：见 §3 测试基线规则（本阶段含删除，测试数预期下降）
**简报**：`docs/plans/2026-07-27-agent-lab-phase-7-planning-brief.md`（复核裁决见 §0）

## 0. 对抗复核裁决与锁定决策

### 0.1 删除/保留清单（锁定）

**整体删除**：`src/arena/market.ts`、`src/arena/bidding.ts`；`test/arena-market.test.ts`、`test/arena-bidding.test.ts`。
**重写**：`src/interceptor/register.ts`（仅保留 bridge 路径；abstain/fail/不可用 → 不改写 model）。
**部分删除**：
- `src/interceptor/logic.ts` → 删 `decideIntercept`；`modelAllowed`/`globMatch` **保留**（arena-definition、scheduler-bridge 在用），移到 `src/interceptor/model-scope.ts` 或新 shared 位置。
- `src/arena/register.ts` → 删 `applyArenaConfig`；`renderLeaderboard`/`renderHistory` **保留**（/lab arena 命令在用），移到 `src/commands/` 显示助手。
- `src/telemetry/register.ts` → `createSettleDispatch` 删 market fallback，简化为 runtime-only settle（settle 失败=静默跳过，economy 非 dispatch 关键）。
**保留（共享，复核纠正）**：`src/arena/{types,policies,ledger,model-caller}.ts`（model-caller 被 arena smoke 使用，C1）；`src/scorer/{scorer,completion}.ts`（scoreCandidates→ws+shadow；deriveCompletion→telemetry parse）；`src/interceptor/{scheduler-bridge,model-scope}.ts`；`src/store/*` 含 **role_pin 与 pin 机制**（Q4 纠正：ws pinLookup 端口在用，非 classic 专属）；`src/catalog`；`src/telemetry/parse.ts`。
**测试调整**：`test/interceptor-logic.test.ts` 删 decideIntercept 测试保留 modelAllowed/globMatch；`test/telemetry-settle.test.ts` 删 market fallback 测试、改写为 runtime-only；`test/commands-mode-binding.test.ts` 改写为弃用提示测试；`test/store.test.ts` pin 测试**保留**。

### 0.2 行为差异（锁定，如实文档化）

| 场景 | P7 前 | P7 后 |
|---|---|---|
| bridge completed→apply | 改写 model | 同 |
| bridge abstain/throw/不可用 | 落 market→classic | **不改写**（host 原模型） |
| settle | bridge→market fallback | bridge 单路，未命中静默跳过 |

风险：三个 Medium（abstain/throw/不可用不再兜底）——**前置门禁**：合并前必须以证据确认 bridge 路径在用户生产配置（mode:market→arena binding）下工作（集成测试 + `/lab arena smoke` 真实执行记录）。

### 0.3 迁移机制（锁定）

- `/lab migrate` 显式命令（非启动自动）：检测 legacy 配置字段（mode/autoApply/arena.*）→ 确保 arena catch-all binding（复用 P4b setCatchAllBinding）→ DB 文件复制备份 `agent-lab.db.backup-<ts>` → 迁移标记写入 store `config` 表（`migration.p7.completed` + ts + 版本）。
- `dualRun` 与 `legacyRecommend` 同 PR 移除（bridge/types/commands 三处）。
- config 死字段（mode/autoApply/arena.*）迁移后在 config-io 层忽略并文档化；`weights/topN/interruptedPenalty/toolFailPenalty/acceptanceScoreMap` 保留（ws 参数/telemetry 在用）。
- `/lab mode` → 弃用提示（指向 migrate）；`/lab recommend` → 弃用提示（指向 scheduler status/optimizer）；`/lab arena post` → 弃用提示；`/lab config` 死 key 拒绝并提示。

### 0.4 回滚策略（锁定）

- 合并前 main 打 tag `pre-p7-legacy`。
- DB 备份由 `/lab migrate` 生成。
- 回滚 = `git checkout pre-p7-legacy` + 恢复备份 DB；写入 README 运维节。

### 0.5 范围外

host 侧改动；runs/事件/lab_* 表删除；新架构行为变更；model-scope settings.json 格式变更。

## 1. 任务与波次

- **W1**：T1（共享代码 extraction：modelAllowed/globMatch 移 model-scope、renderLeaderboard/History 移 commands、删 decideIntercept + 测试调整）∥ T2（迁移命令 `/lab migrate` + 备份 + 标记 + dualRun/legacyRecommend 移除）
- **W2**：T3（interceptor 重写 bridge-only + telemetry settle 简化 + 相关测试改写）
- **W3**：T4（删除 market.ts/bidding.ts/arena register legacy 部分 + legacy 测试 + 命令收敛：mode/recommend/arena post 弃用、config 死 key）
- **W4**：T5（运维/诊断/回滚/升级文档 + 迁移验证测试 + 路线图 §9 验收）→ 终审 → tag → 合并

## 2. 任务规格

### T1 — 共享 extraction
- `globMatch`/`modelAllowed` 从 logic.ts 移入 model-scope.ts（或 src/shared/glob.ts——选 model-scope.ts，已在该域）；更新全部 import（arena-definition.ts、scheduler-bridge.ts、commands、测试）。
- `renderLeaderboard`/`renderHistory` 移入 `src/commands/arena-display.ts`；`decideIntercept` 及其测试删除。
- 测试：既有 modelAllowed/globMatch 测试随迁（改 import 不改断言）；全量绿。

### T2 — `/lab migrate` + dualRun 移除
- `src/migrate.ts`（新）：detectLegacyConfig(cfg) → ensureArenaBinding（幂等）→ backupDb（文件复制）→ writeMarker（store config 表 migration.p7.completed）→ 返回报告；`/lab migrate` 命令（dry-run 默认？——选 dry-run=false 直接执行但输出完整报告；`--dry-run` 可选）。
- dualRun/legacyRecommend 移除：scheduler-bridge.ts 删 legacyRecommend dep + dualRun 比对分支；types.ts 删 scheduler.dualRun；commands 删对应 config key。
- 测试：迁移幂等（二次执行 no-op 报告）；备份文件生成；标记写入/读取；dry-run 不写；bridge 无 legacyRecommend 后行为不变（既有 bridge 测试调整）。

### T3 — interceptor 重写 + settle 简化
- `src/interceptor/register.ts` 重写：仅 bridge（scheduler.enabled + runtime factory → decideSchedulerSelection → apply/skip）；skip/异常 → 不改写；status 文案保留 scheduler 来源标注。
- `src/telemetry/register.ts`：createSettleDispatch 简化（去掉 market 参数与 fallback）。
- 测试改写：interceptor 测试（现有哪些？核查 test/ 下 interceptor 相关）→ bridge-only 行为；telemetry-settle 删 market fallback 测试、保 runtime 路径测试 + 新增"runtime 未命中=静默"。

### T4 — 删除 + 命令收敛
- 删 market.ts、bidding.ts、arena-market/arena-bidding 测试、arena/register.ts 的 applyArenaConfig。
- `/lab mode`、`/lab recommend`、`/lab arena post` → 弃用提示命令（不删入口，输出迁移指引）；`/lab config` 对 mode/autoApply/arena.*/scheduler.dualRun 报错并提示。
- index.ts 启动路径：删除 legacy market 构造（MarketV1/BiddingPolicyV1/applyArenaConfig），保留 ledger/catalog/store/bridge 所需构造。
- 测试：弃用提示输出；config 死 key 拒绝；index 启动无 legacy 构造（runtime smoke）。

### T5 — 文档 + 迁移验证 + 验收
- README：运维（启动/备份/监控事件）、诊断（doctor/事件查询）、回滚（tag + DB 恢复步骤）、升级（P7 迁移指南）四节；CHANGELOG 迁移说明。
- `test/migration-p7.test.ts`：端到端迁移验证（旧 config → migrate → binding + 备份 + 标记；幂等）。
- 路线图 §9 验收门槛逐条 ✅ + 全路线图关闭注记。
- 终审判据：删除清单逐项落实；保留清单零 diff；行为差异文档化；bridge 前置证据。

## 3. 测试基线规则（本阶段特殊）

- legacy 删除附带删除的测试：**明确列出清单**（arena-market、arena-bidding、decideIntercept 相关、market-fallback settle 相关）。
- 其余全部测试零修改通过；迁移/弃用/收敛新增测试。
- 预期净下降，报告中给出删除数/保留数/新增数三账。

## 4. 验证命令

`npm test`；聚焦 interceptor/telemetry/commands/migration 套件；runtime smoke（index.ts import + 启动路径）；`git diff --check`；`grep -rn "market\.allocate\|decideIntercept\|MarketV1\|BiddingPolicyV1" src/` 必须为空。
