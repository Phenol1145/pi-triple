# Agent Lab Phase 4b: 迁移收尾与验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成路线图 P4 验收缺口：路由绑定实时化（`/lab mode` 运行时改写）、冻结残留迁移 reconcile + 审计、真实竞价冒烟命令、P4a 归档改进项（settle 参数线程化、freeze 事务、类型安全、结构断言、死字段清理）。

**Architecture:** 在 P4a 内核之上做 additive 扩展：repository 增加绑定 upsert/delete；控制面新增带审计事件的绑定改写操作；`SettleContext` 增加可选 `parameters`（schedule 时 Round 快照）；账本 reconcile 按 agent 粒度 + 补偿流水；冒烟为显式命令（真实竞价 + 真实冻结 + 合成结算）。

**Tech Stack:** TypeScript（`--experimental-strip-types`）、node:sqlite、node:test。

**前置事实（Qwen3.8 对抗性复核已验证）**

- 绑定仅在 `ControlPlane.activateDraft` 内写入（`service.ts:234`）；repository 只有 `insertRoutingBinding`（`repository.ts:255`，裸 INSERT）+ `listRoutingBindings`。**无 upsert/delete，无运行时改写 API**。
- `ensureArenaInstance` 幂等早退不触碰绑定（`bootstrap.ts:195-199`）→ 现存 bug：首次 classic 启动后再切 market 永远无绑定（first-boot-wins）。本阶段修复。
- runner 每次 dispatch 实时 `listRoutingBindings()`；但 `scheduler.instanceId` 被显式设置时走显式分支（`runner.ts:287`），绑定改写对其无效——文档化。
- `registerCommands` 现有 deps 无法触达 repository（`commands/register.ts:12-22`），需注入新依赖。
- `pendingSettlements` 存 `{schedulerInstanceId, roundId, traceId}`（无参数）；`SettleContext` 无 `parameters`。settle 参数来源钉死：**schedule 时 Round**（`getRound(entry.roundId).parameters`），roundId 缺失回退定义默认参数。
- `credits.frozen` 只能由 `ledger.freeze` 增加且必先写 `arena_freezes` 行 → "frozen>0 且该 agent 无 freeze 行" 基本只可能是 P4a 前残留。reconcile 安全。
- freeze 三语句无事务（`ledger.ts:62-71`）：崩溃窗口导致"重复 freeze 返回 true 但从未扣款"的静默少押。用**裸 `BEGIN IMMEDIATE`/`COMMIT`**（共享连接，禁止 `CoreRepository.transaction()` 嵌套；价值 = 崩溃原子性）。
- `create-scheduler-runtime.ts` 的 `ports` 与 `arenaPorts` 两个字段均为死字段（工厂体不消费）。
- `SettleContext.parameters` 为可选字段、不需要 arena 定义版本升级（§10 治理兼容）。
- legacy market 拦截分支保留至 P7；scheduler 启用 + market 模式下 arena 失败回退后 legacy `market.allocate` 可能对同一 toolCallId 触发（PK 冲突被吞 → classic），无害，文档化。
- `/lab arena credits/history/status/doctor` 读共享账本，无表迁移 → 本阶段**无需改动**。

**范围边界（P4b 不做什么）**

- 不删除 legacy market 拦截分支与 MarketV1（P7）；不做 OptimizationRound 推进/Optimizer（P5）；不做 execute 模式 Arena（P6/P7）。
- 现有 402 项测试为行为基线。

---

## Task 1: 绑定运行时 API（repository + 控制面审计操作）

**Files:**
- Modify: `src/core/storage/repository.ts`（`upsertRoutingBinding`、`deleteRoutingBinding`）
- Modify: `src/core/control-plane/service.ts`（`setCatchAllBinding(instanceId, mode)` 或等价操作）
- Modify: `src/core/contracts.ts`（事件类型 `routing.binding.added`/`routing.binding.removed`，若事件类型为自由字符串则跳过）
- Test: `test/core-routing-bindings.test.ts`（新）

设计定案：

- repository：`upsertRoutingBinding(instanceId, binding)`（`INSERT ... ON CONFLICT(id) DO UPDATE`，在既有 `transaction()` helper 内执行）；`deleteRoutingBinding(id)` 返回删除行数。
- 控制面：`setCatchAllBinding(schedulerInstanceId, enabled: boolean)`——校验实例存在且 active（否则抛 typed error）；enabled=true 时 upsert `{ id: "arena-default", priority: 10, match: {} }`（id 可参数化，默认 `arena-default`）；enabled=false 时 delete；发审计事件 `routing.binding.added`/`routing.binding.removed`（payload 含 instanceId、binding、traceId 可选）。事件经既有 `core.events`。
- 不触碰 OptimizationRound；不做 draft 流程（绑定非 Round 参数，§10 不适用；route-id-conflict 校验此处不必要——实例自有绑定）。

- [ ] **Step 1: 写失败测试** — upsert 新建/更新幂等；delete 返回计数；setCatchAllBinding active 校验/审计事件字段/往返
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归（402 + 新增）**
- [ ] **Step 4:** `git add src/core/storage/repository.ts src/core/control-plane/service.ts src/core/contracts.ts test/core-routing-bindings.test.ts && git commit -m "feat(core): runtime routing-binding upsert/delete with audited control-plane operation"`

---

## Task 2: `/lab mode` 实时绑定改写

**Files:**
- Modify: `src/commands/register.ts`（mode handler 改写；新 dep；移除重启提示；status 显示修正）
- Modify: `index.ts`（注入 `setModeBinding` 闭包 deps）
- Test: `test/commands-mode-binding.test.ts`（新）

设计定案：

- 新 dep `setModeBinding?: (mode: "classic" | "market") => { ok: boolean; reason?: string }`（additive）。
- `/lab mode market|classic`：照旧更新 `cfg.mode` + saveConfig（legacy 分支开关）；若 `cfg.scheduler?.enabled` 且 `setModeBinding` 存在：调用之——内部先确保 arena 实例已 bootstrap（竞态：bootstrap 未完成则返回 `{ok:false, reason:"bootstrap-pending"}`，命令层 notify 重试提示），成功后 notify "路由绑定已更新，即时生效"。移除 P4a 的"需重启"提示。
- index.ts：`setModeBinding` 闭包捕获 `schedulerCore`——检查 `schedulerCore` 与 arena 实例就绪（`getInstance("default-arena")?.status === "active"`），调 `controlPlane.setCatchAllBinding("default-arena", mode === "market")`。
- 首次 classic 启动后再切 market 的 first-boot-wins bug：由本任务实时改写天然修复；bootstrap 不再承担绑定 reconcile（DB 绑定为唯一权威）。
- `cfg.scheduler.instanceId` 显式设置时：命令 notify 警告"显式 instanceId 路由下绑定改写不影响拦截路径"。
- `/lab scheduler status` 显示修正：不再把缺省显示为 `default-weighted-scorer`，改为显示当前生效路由（绑定列表或 explicit id）。

- [ ] **Step 1: 写失败测试** — market/classic 往返（绑定出现/消失 + 审计事件）；bootstrap 未就绪降级提示；scheduler 未启用时仅改配置；显式 instanceId 警告
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/commands/register.ts index.ts test/commands-mode-binding.test.ts && git commit -m "feat(commands): live routing-binding rewrite on /lab mode"`

---

## Task 3: 冻结残留 reconcile + 审计 + freeze 事务

**Files:**
- Modify: `src/arena/ledger.ts`（`reconcileFrozenResidue()` + freeze 裸事务）
- Modify: `index.ts`（启动序列：stale 恢复 → reconcile，带事件）
- Test: `test/arena-ledger-reconcile.test.ts`（新）

设计定案：

- `reconcileFrozenResidue(): { agent: string; frozenBefore: number }[]`：逐 agent 查 `credits.frozen > 0 AND agent NOT IN (SELECT agent FROM arena_freezes)`；对每个：写补偿 `credit_tx`（delta=0，reason=`migration-reconcile`，附 frozen 值于 round 列不适用——用 reason 串携带 frozenBefore），将 `frozen` 归零（**不动 balance**——残留冻结从未对应真实扣款方向一致性：P4a 前 freeze 已扣 balance，故 reconcile 应 `balance += frozen` 返还并清零 frozen；在实现前用测试钉死该语义：返还余额 + 清零冻结 + 补偿流水）。
- freeze 三语句包 `BEGIN IMMEDIATE`/`COMMIT`（catch 时 `ROLLBACK` 重抛）；裸 exec，禁止 CoreRepository.transaction()。
- index.ts 启动：现有 stale 恢复（`index.ts:41`）**之后**执行 reconcile；每个 reconcile 的 agent 发 `migration.reconciled` 事件（经 schedulerCore.events 若已就绪，否则 console.error 记录——事件不可达时降级，账本补偿流水是主审计）；另发一条审计-only 的 `migration.ledger-baseline` 事件（credits/tasks 计数快照，无状态变更）。
- reconcile 幂等（二次执行返回空数组）。

- [ ] **Step 1: 写失败测试** — 残留 reconcile（返还+清零+流水+幂等）；有活跃冻结的 agent 不受影响；freeze 事务崩溃原子性（模拟中间失败 → 无半提交状态）
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/arena/ledger.ts index.ts test/arena-ledger-reconcile.test.ts && git commit -m "feat(arena): audited frozen-residue reconcile and crash-atomic freeze"`

---

## Task 4: SettleContext.parameters 线程化 + 类型安全桥接

**Files:**
- Modify: `src/scheduler/contracts.ts`（`SettleContext.parameters?: Readonly<unknown>`）
- Modify: `src/scheduler/runner.ts`（settle 时 `getRound(entry.roundId).parameters` 注入；缺失回退）
- Modify: `src/schedulers/arena-definition.ts`（`arenaParamsToArenaConfig(params)` 显式字段映射函数）
- Modify: `src/schedulers/arena-scheduler.ts`（移除两处 `as unknown as ArenaConfig`；settle 用 `ctx.parameters` 经映射函数）
- Test: `test/scheduler-settle-params.test.ts`（新）+ 更新受影响的 arena-scheduler 测试

设计定案：

- runner.settle：`entry.roundId` 存在 → `core.repository.getRound(roundId)`（确认 API 名）取 `.parameters` 传入 `ctx.parameters`；round 不存在/roundId 缺失 → 传 `undefined`（impl 自行回退默认）。
- arena settle：`const params = ctx.parameters ? arenaParamsToArenaConfig(ctx.parameters) : arenaParamsToArenaConfig(ARENA_DEFAULT_PARAMETERS)`；schedule 路径同样改用映射函数（替换 `:132` cast）。
- `arenaParamsToArenaConfig`：显式逐字段映射（endowment/odds/settlement/cost），不含 risk/bidding 扩展字段——策略类只需要这四个子集。
- README 记录：settle 参数 = schedule 时 Round 快照；P5 前与 cfg 一致，重启降级 legacy settle（构造期 cfg）在参数分叉时可能不一致（P5 前无实际分叉）。

- [ ] **Step 1: 写失败测试** — round 参数注入（改 round 参数后 settle 用新值）；roundId 缺失回退默认；映射函数字段完整性与类型收窄；无 cast 残留（grep 断言）
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/scheduler/contracts.ts src/scheduler/runner.ts src/schedulers/arena-definition.ts src/schedulers/arena-scheduler.ts test/scheduler-settle-params.test.ts && git commit -m "feat(scheduler): thread schedule-time round parameters into settle context"`

---

## Task 5: 杂项清理（死字段 + 结构断言）

**Files:**
- Modify: `src/runtime/create-scheduler-runtime.ts`（移除 `ports`/`arenaPorts` 死字段；同步更新签名文档）
- Modify: `index.ts`（移除对 dead 字段的传参——若有）
- Test: `test/scheduler-bridge-contract.test.ts`（新：bridge/runner DispatchResult 结构断言）

设计定案：

- 结构断言：编译期 `satisfies`/赋值断言（bridge 的宽松结构 ← runner 的严格结构可赋值），放进一个 *.test.ts 里以 import 副作用形式存在 + 运行时字段存在性 spot-check。
- 确认 index.ts 对 `createSchedulerRuntime(store.raw, { ports })` 的调用同步清理（P3 传了 ports——工厂体若不消费则一并从调用处移除）。

- [ ] **Step 1: 写失败测试（结构断言）**
- [ ] **Step 2: 清理实现**
- [ ] **Step 3: 测试通过 + 全量回归 + 两个 runtime smoke**
- [ ] **Step 4:** `git add src/runtime/create-scheduler-runtime.ts index.ts test/scheduler-bridge-contract.test.ts && git commit -m "chore: remove dead runtime option fields and add bridge/runner contract assertion"`

---

## Task 6: `/lab arena smoke <role>` 真实竞价冒烟

**Files:**
- Modify: `src/commands/register.ts`（smoke 子命令）
- Modify: `index.ts`（deps：smoke 所需 runtime/caller 闭包）
- Modify: `README.md`（冒烟使用说明 + 前置条件 + 输出样例）
- Test: `test/arena-smoke-command.test.ts`（新，fake caller 覆盖命令逻辑）

设计定案：

- 语义：一次真实 dispatch——guard rails：`maxBidders=2`、`maxCallsPerDispatch=2`（临时覆盖 dispatch 参数而非改实例 Round）；真实 LLM 竞价（ModelCaller）；真实冻结；**合成结算**（直接 `runner.settle` 以合成的成功 Outcome）；逐阶段输出证据（bidders、bid 原文/解析 stake、冻结前后余额、settle 后余额、事件 trace）。
- **明确不做**：真实执行（select 内核 + 命令无法发 tool_call）、遥测结算。输出中明示。
- ModelCaller 获取：优先 `createModelCaller(commandCtx)`（需验证 pi 命令 ctx 暴露 modelRegistry——实现时先写探测代码路径）；不可得则复用 index.ts 惰性 caller（前置条件：本会话已发生过一次 subagent 调用；否则 notify 明确提示）。
- 前置检查：scheduler.enabled + arena 实例 active + 目录候选 ≥ 2；任一不满足 → notify 具体缺失。
- 安全：smoke 用独立 traceId 前缀 `smoke-`；失败任意阶段 fail-open 输出已收集证据。

- [ ] **Step 1: 验证 pi 命令 ctx 的 modelRegistry 可用性（读 pi docs + 探测），定 ModelCaller 获取策略**
- [ ] **Step 2: 写失败测试（fake caller 全链路 + 前置检查 + 失败降级）**
- [ ] **Step 3: 实现 + README**
- [ ] **Step 4: 测试通过 + 全量回归**
- [ ] **Step 5:** `git add src/commands/register.ts index.ts README.md test/arena-smoke-command.test.ts && git commit -m "feat(commands): /lab arena smoke for real-bidding verification"`

---

## Task 7: 文档收尾 + 整体验证

**Files:**
- Modify: `README.md`（P4b 节：实时路由语义、reconcile 说明、冒烟指南、D2 重叠行为记录、settle 参数快照语义与重启降级约束）
- Modify: `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md`（P4 验收门槛逐项核对注记）

- [ ] **Step 1: README + roadmap 验收核对（并发冻结/资格/押注/回退/幂等结算 → P4a 集成测试；迁移审计 → Task 3；真实冒烟 → Task 6 命令可用性 + 手工执行记录；模式分支 → legacy 保留至 P7 的说明）**
- [ ] **Step 2: 全量回归 + `git diff --check` + 保护路径审计 + package.json 检查**
- [ ] **Step 3:** `git add README.md docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md && git commit -m "docs: P4b documentation and roadmap acceptance reconciliation"`

---

## 最终整体验证

- `npm test` 全绿（402 基线 + 新增）
- 聚焦：`node --experimental-strip-types --test test/core-*.test.ts test/arena-*.test.ts test/scheduler-*.test.ts test/commands-*.test.ts test/telemetry-*.test.ts`
- 双 runtime smoke；`git diff --check`；package.json 无变化；import 来源审计
