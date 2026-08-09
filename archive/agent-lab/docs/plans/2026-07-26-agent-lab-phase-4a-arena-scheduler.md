# Agent Lab Phase 4a: Arena Scheduler 迁移（内核） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Arena 经济循环封装为第二个生产 SchedulerDefinition（select 模式），就地修复冻结隔离/资格过滤/押注上限三个正确性问题，建立 Arena → WeightedScorer → original-request 实例级回退链。

**Architecture:** 在 P3 的 SchedulerRunner/Registry/桥接之上扩展：契约增加可选 `settle?` 生命周期钩子与 `settlementRef` 线程化；账本就地修复（共享 `SqliteLedger` + 新增 `arena_freezes` 表）；Arena 通过构造注入 ports（ledger/catalog/modelCaller）访问领域状态，与 weighted-scorer 的 ports 模式一致。生产接线仍走 `scheduler.enabled` opt-in + fail-open。

**Tech Stack:** TypeScript（`--experimental-strip-types`）、node:sqlite、node:test。

**前置事实（已验证）**

- `SchedulerImplementation` 仅有 `schedule()`（`src/scheduler/contracts.ts:81-88`）；`SchedulingResult`/`DispatchResult` 无 task-ref。
- runner 里 abstain 是终态（`src/scheduler/runner.ts` 注释 "Abstain does NOT trigger fallback"）；**Arena 无合格竞价时返回 `failed(retryable=false)` 以走入回退链，不改 runner 语义**。
- `resolveRoute` 只匹配 role（exact/catch-all + priority）；labels 是死字段。P4a 采用**启动期静态绑定**（见 Task 6）。
- 结算数据流：`tool_call` → bridge（`traceId = toolCallId`）→ dispatch → pi 执行 → `tool_execution_end` → `src/telemetry/register.ts:39` 调 `market.settle(taskId, outcome)`，taskId = toolCallId。
- `registerTelemetry(pi, store, cfg, market?)` 目前不认识 runner；`registerTelemetry` 签名做 additive 扩展。
- 账本 bug：`src/arena/ledger.ts` `freeze(a, amt, _taskId)` 忽略 taskId（聚合 `frozen` 列），`unfreeze` 释放全部冻结；`market.eligibility` 从未生效；stake 仅钳制到余额。
- 共享账本简化：legacy `market.settle(taskId, outcome)` 对 Arena 创建的任务**语义同样正确**（同表同语义），因此 runner 内存映射丢失（重启）时降级到 legacy settle 是可接受且正确的兜底。
- 指标名遵循设计 §11.5：`scheduler.arena.stake/odds/balance_before/balance_after`（非 §12.4）。
- select 模式下 `sdk.agents.run` 不可用 → 竞价 LLM 调用必须走注入的 `ModelCaller` port（`src/arena/model-caller.ts`）。
- bootstrap 顺序：Arena 的 fallbackChain 指向 weighted-scorer 实例，ControlPlane 校验 `fallback-not-active` 要求目标**已激活** → 必须顺序 await（现状 `index.ts` fire-and-forget 会竞态）。

**范围边界（P4a 不做什么）**

- 不做 credits/task 数据迁移到私有命名空间（P4b）；不退役 `classic/market` 模式分支（P4b）；不做真实竞价冒烟（P4b）；不做预算硬集成（§13.3 部分实现：仅发估算成本指标）。
- **P4a 不满足路线图 P4 验收门槛**；验收在 P4b 完成（迁移审计 + 真实冒烟 + 模式分支退役）。README 必须明示。
- 现有 284 项测试为行为基线；不得修改 legacy `src/arena/market.ts` 的选择/结算语义（账本内部实现修复除外）。

---

## Task 1: 契约扩展 — settle 钩子、settlementRef 线程化、runner.settle

**Files:**
- Modify: `src/scheduler/contracts.ts`
- Modify: `src/scheduler/runner.ts`
- Modify: `src/interceptor/scheduler-bridge.ts`（结构复制的 DispatchResult 同步 + 传 settlementRef）
- Test: `test/scheduler-settle.test.ts`（新）

设计定案：

- `SchedulingInput` 增加 `settlementRef?: string`；`DispatchRequest` 增加 `settlementRef?: string`；bridge 仅在 `toolCallId` 存在时传 `settlementRef = toolCallId`（**显式线程化**，不再依赖 traceId 巧合）。
- `SchedulingResult.completed` 增加 `settlementRef?: string`；`DispatchResult.completed` 同样增加（runner 从 SchedulingResult 透传）。bridge 的结构复制 `DispatchResult` 同步更新；bridge 决策 `{action:"apply"}` 无需携带 settlementRef（遥测用 toolCallId 关联，runner 内存映射在 runner 侧维护）。
- `SchedulerImplementation` 增加可选钩子：
  ```ts
  settle?(ctx: SettleContext, taskRef: string, outcome: SettleOutcome): Promise<void> | void;
  ```
  `SettleOutcome = { completion: number; majorError: boolean; tokensIn: number; tokensOut: number; cost: number; toolCalls: { name: string; durationMs: number }[]; inferenceLatencyMs: number }`（与 arena `Outcome` 同构，定义在 scheduler 契约层，arena types 做 alias 兼容）。
  `SettleContext = { schedulerInstanceId: string; roundId?: string; traceId: string; telemetry: { emit(...) }; now: number }`。
- `SchedulerRunner` 增加：
  - dispatch 完成且 `SchedulingResult.completed.settlementRef` 存在时，记录内存映射 `pendingSettlements: Map<taskRef, { schedulerInstanceId, roundId, traceId }>`（上限 1000，FIFO 淘汰；settle 后删除）。
  - `settle(taskRef: string, outcome: SettleOutcome): Promise<boolean>` — 查映射；命中则解析 instance（repository）+ impl（registry），impl 无 `settle` 钩子 → 返回 false；调用钩子并发射审计事件 `scheduler.settled`（携带 instanceId/roundId/traceId，满足 §18.10）；未命中（重启后）→ 返回 false，调用方降级 legacy `market.settle`（共享账本下语义正确）。
  - 钩子抛错 → fail-open：console.error + 返回 false（调用方随后 legacy settle 兜底，幂等性由账本 status 检查保证）。

- [ ] **Step 1: 写失败测试** — completed 携带 settlementRef 透传；runner.settle 命中/未命中/无钩子/钩子抛错四路径；审计事件字段；映射 FIFO 上限
- [ ] **Step 2: 实现 contracts + runner + bridge 修改**
- [ ] **Step 3: 测试通过 + 全量回归（284 + 新增）**
- [ ] **Step 4: 验证 bridge 结构复制与 runner 类型一致（编译期结构赋值断言测试）**
- [ ] **Step 5:** `git add src/scheduler/contracts.ts src/scheduler/runner.ts src/interceptor/scheduler-bridge.ts test/scheduler-settle.test.ts && git commit -m "feat(scheduler): add settle lifecycle hook and settlementRef threading"`

---

## Task 2: 账本就地修复 — 按 task 冻结、原子守卫、幂等解冻

**Files:**
- Modify: `src/arena/ledger.ts`
- Test: `test/arena-ledger.test.ts`（扩充现有）

设计定案：

- 新增 additive 表：`arena_freezes(task_id TEXT PRIMARY KEY, agent TEXT NOT NULL, amount REAL NOT NULL, created_ts INTEGER NOT NULL)`（在 `ARENA_SCHEMA` 中 `CREATE TABLE IF NOT EXISTS`）。
- `freeze(a, amt, taskId)`：`INSERT INTO arena_freezes` + **原子守卫** `UPDATE credits SET balance = balance - ?, frozen = frozen + ?, updated_ts = ? WHERE agent = ? AND balance >= ?`；`changes === 0` → 回滚 freeze 行并抛 `InsufficientBalanceError`（或返回 false，二选一并在 market/arena 两侧处理为"无分配"）。同一 taskId 重复 freeze → `INSERT OR IGNORE` 语义 + 视为成功（幂等）。
- `unfreeze(a, taskId)`：查 `arena_freezes` 该行；存在则 `UPDATE credits SET balance = balance + amount, frozen = frozen - amount`（frozen 下限钳 0）+ 删除 freeze 行，返回 amount；不存在返回 0（幂等）。
- `recoverStaleTask`/`market.settle` 已传 taskId，语义自动变正确，**不改这两个文件**。
- 兼容迁移：进程启动时若存在旧式聚合冻结（`credits.frozen > 0` 且 `arena_freezes` 无对应行）——P4a 不做自动迁移，仅 `staleTasks` 恢复路径覆盖（旧 pending 任务超时后 unfreeze 返回 0，冻结残留仅影响旧进程遗留，README 记录手工清理 SQL）。**前提：现网无长期挂起的真实冻结**（已在 live 验证中确认可接受；若有残留，提供 `/lab arena recover` 现成命令语义）。

- [ ] **Step 1: 写失败测试** — 两任务并发冻结互不干扰；unfreeze 只解冻目标任务；余额不足原子拒绝（balance 不变）；重复 freeze/unfreeze 幂等；现有 13 项 ledger 测试不改仍绿
- [ ] **Step 2: 实现 ledger 修改**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/arena/ledger.ts test/arena-ledger.test.ts && git commit -m "fix(arena): per-task freeze isolation with atomic balance guard"`

---

## Task 3: Arena 参数模型 + SchedulerDefinition

**Files:**
- Create: `src/schedulers/arena-definition.ts`
- Modify: `src/types.ts`（`ArenaConfig` 增加 `risk.maxStakeRatio`、`bidding.maxCallsPerDispatch`）
- Modify: `src/config.ts` + `src/arena/register.ts`（applyArenaConfig 新键：`risk.maxStakeRatio`、`bidding.maxCallsPerDispatch`）
- Test: `test/arena-definition.test.ts`（新）

设计定案：

- 定义 `ARENA_DEFINITION: SchedulerDefinition`，`id: "arena"`, `version: "1.0.0"`, `kind: "scheduler"`。
- `defaultParameters` = 由 `ArenaConfig` 全量映射（endowment/odds/settlement/cost/bidding/market）+ `risk: { maxStakeRatio: 0.5 }` + `bidding.maxCallsPerDispatch` 默认 = `market.maxBidders`。
- `tunablePaths`：`["endowment.K","endowment.floor","odds.easy","odds.medium","odds.hard","settlement.tax","settlement.errorMode","market.maxBidders","market.staleTaskTimeoutMs","market.eligibility","bidding.timeoutMs","bidding.maxCallsPerDispatch","risk.maxStakeRatio"]`。
- 参数校验函数 `validateArenaParameters(params)`：数值范围（maxStakeRatio ∈ (0,1]，K/floor/odds/tax > 0，maxBidders ≥ 1）、errorMode 枚举、eligibility 非空字符串。供 ControlPlane validateDraft 链路使用（经 definition 上的可选 validate 钩子——参照 weighted-scorer 的做法）。
- eligibility 语义：逗号分隔 glob 列表，对 model id 匹配；**复用** `src/interceptor/model-scope.ts` 的 glob 匹配函数（导出之，勿复制）。

- [ ] **Step 1: 写失败测试** — 默认参数映射完整；校验拒绝非法值；tunablePaths 全覆盖；config merge/applyConfig 新键往返
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/schedulers/arena-definition.ts src/types.ts src/config.ts src/arena/register.ts test/arena-definition.test.ts && git commit -m "feat(schedulers): add arena scheduler definition and parameter model"`

---

## Task 4: ArenaScheduler 实现

**Files:**
- Create: `src/schedulers/arena-scheduler.ts`
- Test: `test/arena-scheduler.test.ts`（新）

依赖 Task 1/2/3。设计定案：

```ts
export interface ArenaSchedulerPorts {
  ledger: Ledger;
  candidates(): ModelInfo[];
  modelCaller: ModelCaller;
}
export function createArenaSchedulerImplementation(ports: ArenaSchedulerPorts): SchedulerImplementation
```

`schedule(input, parameters, sdk)` 流程（select 模式；`mode === "execute"` → `failed{code:"execute-unsupported",retryable:false}`）：

1. `input.settlementRef` 缺失 → `failed{code:"no-stable-task-ref",retryable:false}`（防冻结泄漏；bridge 只在有 toolCallId 时传）。
2. candidates = ports.candidates()；空 → failed。no-eligible-bids 之前：eligibility glob 过滤 + `ensureEndowed` 每个候选 + 构造 AgentState（balance）。
3. selector（按 `market.bidderSelector` 参数 top-balance/random，policy 类复用 `src/arena/policies.ts`）取 `market.maxBidders` 个。
4. 竞价：`Promise.all` 并发调 `ports.modelCaller.complete(model, prompt, timeoutMs)`，上限 `bidding.maxCallsPerDispatch`；`input.signal` 中止时中断剩余调用；单调用失败 → 该候选 stake 0（fail-open，同 legacy）。每次竞价调用发指标 `scheduler.arena.bid_call`（含估算成本 = 按 prompt 长度估算 token × 候选定价）；竞价结果发 `scheduler.arena.stake/odds/balance_before`（§11.5 命名）。
5. stake 钳制：`min(bid, balance, floor(balance * risk.maxStakeRatio))`；opt-out tax 按参数执行。
6. 无合格竞价 → `failed{code:"no-eligible-bids",retryable:false}`（→ 回退链，**不用 abstain**）。
7. 赢家：`ledger.freeze(agent, stake, settlementRef)`——原子守卫失败（并发余额不足）→ failed{code:"freeze-rejected",retryable:false}；`ledger.createTask(...)`（task.id = settlementRef）。
8. 发 `scheduler.arena.balance_after` 指标；返回 `completed{ model: winner, settlementRef, reason: "stake N round M" }`。
9. `settle(ctx, taskRef, outcome)` 钩子：`getTask(taskRef)` 非 pending → 直接返回（幂等）；计算 D/U（复用 `SettlementPolicyV1`/`CostModelV1`，参数来自冻结时快照？——**用 settle 当时的实例参数**，与 legacy 一致：legacy 用调用时 cfg）；unfreeze → credit/debit 净额 → setTaskStatus；发 `scheduler.arena.settled` 事件 + `balance_after` 指标；破产（balance=0）发 `scheduler.arena.bankrupt` 指标。
10. Arena 也需要 AgentInstance 归因：`syncArenaAgents(core, instanceId, candidates)` 仿 weighted-scorer 的 sync（放 Task 6 bootstrap 文件）。

- [ ] **Step 1: 写失败测试** — 全流程 select 成功（含事件/指标断言）；settlementRef 缺失拒绝；execute 拒绝；eligibility 过滤生效；maxStakeRatio 钳制（免费模型全押回归测试：余额 10000、ratio 0.5 → stake ≤ 5000）；无竞价 → failed 非 abstained；freeze 竞争失败 → failed；settle 幂等 + 破产指标；signal 中止竞价
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/schedulers/arena-scheduler.ts test/arena-scheduler.test.ts && git commit -m "feat(schedulers): add arena scheduler implementation with bidding and risk controls"`

---

## Task 5: 结算路径接线 — 遥测 → runner.settle → arena，含降级

**Files:**
- Modify: `src/telemetry/register.ts`（additive 第 5 参 `settleDispatch?: (taskId: string, outcome: Outcome) => void`）
- Modify: `index.ts`（组合 settleDispatch：先 runner.settle，未命中降级 market.settle）
- Modify: `src/interceptor/scheduler-bridge.ts`（`SchedulerRuntimeLike` 增加可选 `settle`，供 index.ts 类型用）
- Test: `test/telemetry-settle.test.ts`（新）

设计定案：

- `registerTelemetry(pi, store, cfg, market?, settleDispatch?)`：`tool_execution_end` 里若 `settleDispatch` 存在则调它（它内部决定 arena/legacy），否则维持现状 `market.settle`。
- index.ts：`const settleDispatch = (taskId, outcome) => { const rt = schedulerRuntime; if (rt?.settle) { void rt.settle(taskId, outcome).then((hit) => { if (!hit) market.settle(taskId, outcome); }).catch(() => market.settle(taskId, outcome)); return; } market.settle(taskId, outcome); }`。幂等性由账本 `status === "pending"` 检查保证（arena settle 与 legacy settle 都查同一行）。
- **arena/market 消歧**：同一 taskId 只会被一条路径创建（market.allocate 或 arena.schedule 之一），共享账本 `market_tasks` 行唯一 → 双路径 settle 是幂等安全的。

- [ ] **Step 1: 写失败测试** — settleDispatch 优先；runner 命中时 legacy 不重复结算（余额只变一次）；未命中降级 legacy；异常降级 legacy；无 settleDispatch 时行为同现状
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/telemetry/register.ts index.ts src/interceptor/scheduler-bridge.ts test/telemetry-settle.test.ts && git commit -m "feat(telemetry): route settlement through scheduler runner with legacy fallback"`

---

## Task 6: Bootstrap + 路由绑定 + 拦截器接线

**Files:**
- Modify: `src/schedulers/bootstrap.ts`（`ensureArenaInstance` + `syncArenaAgents`）
- Modify: `src/runtime/create-scheduler-runtime.ts`（arena ports 注入组装）
- Modify: `index.ts`（顺序 await bootstrap；mode=market 时 arena 绑定）
- Modify: `src/commands/register.ts`（`/lab mode` 在 scheduler.enabled 时提示"切换需重启生效"）
- Test: `test/arena-bootstrap.test.ts`（新）

设计定案：

- `ensureArenaInstance(core, schedulers, ports, opts?: { instanceId?; enabled: boolean })`：注册 arena impl（Registry）；upsert definition draft（参数 = Task 3 默认参数从 cfg.arena 映射）→ validate → activate；`syncArenaAgents` 按 catalog 建 AgentInstance（workloop=pi-default-loop，仿 weighted-scorer）；幂等。
- **顺序**：`await ensureWeightedScorerInstance(...)` 成功后才 `await ensureArenaInstance(...)`（fallback-not-active 校验）。index.ts 把 fire-and-forget 改为顺序异步链（整体仍不阻塞扩展加载；失败各自 fail-open 记录）。
- **静态模式路由**（`cfg.mode === "market"` 且 scheduler.enabled）：注册绑定 `{ id: "arena-default", priority: 10, match: {} }`（catch-all 高于 weighted-scorer 的 priority 0），`fallbackChain: [{ type: "scheduler-instance", schedulerInstanceId: <ws实例id> }, { type: "original-request" }]`。mode !== "market"：不建 arena 绑定（arena 休眠但已注册/激活，可被显式 `schedulerInstanceId` 路由）。
- `/lab mode` 命令：当 `cfg.scheduler?.enabled` 时 notify 提示"scheduler 路由为启动期静态绑定，切换 mode 需重启 pi 生效"。
- `create-scheduler-runtime.ts` 增加可选 `arenaPorts`（ledger/candidates/modelCaller）组装入口。

- [ ] **Step 1: 写失败测试** — ensureArenaInstance 幂等/校验/激活；market 模式绑定优先级与回退链；classic 模式无 arena 绑定；顺序 bootstrap（ws 未激活时 arena 草稿校验失败被捕获并 fail-open）
- [ ] **Step 2: 实现**
- [ ] **Step 3: 测试通过 + 全量回归**
- [ ] **Step 4:** `git add src/schedulers/bootstrap.ts src/runtime/create-scheduler-runtime.ts index.ts src/commands/register.ts test/arena-bootstrap.test.ts && git commit -m "feat(schedulers): bootstrap arena instance with static mode routing and fallback chain"`

---

## Task 7: 集成测试收尾 + 文档

**Files:**
- Create: `test/arena-integration.test.ts`
- Modify: `README.md`
- Modify: `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md`（P4 节加注 P4a/P4b 切分说明）

集成场景（内存 DB + fake ports + fake ctx）：

1. **端到端 select 流**：bridge dispatch（market 模式绑定）→ arena 竞价冻结 → completed+settlementRef → 模拟 tool_execution_end → runner.settle → 余额/流水/任务状态正确，审计事件齐全（scheduling.requested…scheduler.arena.*…scheduler.settled）。
2. **回退链**：无合格竞价 → failed → weighted-scorer 实例接管 → 其失败 → original-request；attempts 记录三段。
3. **并发隔离**：两个并发 dispatch 同一赢家候选、余额仅够一份 stake → 一个成功一个 freeze-rejected → 回退；无超押。
4. **废弃拍卖**：schedule 冻结后无 tool_execution_end → `staleTasks` + `recoverStaleTask` 解冻且余额恢复。
5. **破产**：settle 后余额 0 → 破产指标 + 该候选后续竞价 stake 0。
6. **legacy 共存**：scheduler.enabled=false 时 legacy market 全流程不受新账本影响（现有 arena 测试即覆盖，此处加一项混合：arena 任务与 legacy 任务交替结算互不干扰）。

README：P4a 节（Arena Scheduler 架构、三个正确性修复、回退链、静态模式路由与重启语义、**明示 P4a 不满足路线图 P4 验收、P4b 范围**）；旧式聚合冻结残留的手工清理 SQL 说明。

- [ ] **Step 1: 写失败测试（6 场景）**
- [ ] **Step 2: 修复至全绿**
- [ ] **Step 3: README + roadmap 注记**
- [ ] **Step 4: 全量回归 + `git diff --check` + 保护路径审计（src/scorer、src/telemetry/parse、src/catalog、src/store 零 diff）**
- [ ] **Step 5:** `git add test/arena-integration.test.ts README.md docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md && git commit -m "test+docs: arena scheduler integration tests and P4a documentation"`

---

## 最终整体验证

- `npm test` 全绿（284 基线 + 新增）
- 聚焦：`node --experimental-strip-types --test test/arena-*.test.ts test/scheduler-*.test.ts test/telemetry-*.test.ts`
- `node --experimental-strip-types -e "import('./src/runtime/create-scheduler-runtime.ts').then(()=>console.log('loads'))"`
- `git diff --check`；`package.json` 无变化；import 来源审计（StandardAgentError/Output 来自 workloop/contracts，AgentSnapshot 来自 scheduler/contracts）
