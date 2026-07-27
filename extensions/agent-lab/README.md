# Agent Lab

 telemetry 驱动的 pi 模型选择扩展（Core + M1 遥测 + M2 选择优化器 MVP）。

## 数据位置
- DB / 配置：`~/.pi/agent/agent-lab/`（`agent-lab.db`、`config.json`）

## 命令
- `/lab recommend <role> [--top N]` — 该角色 Top-N 模型推荐
- `/lab stats [role]` — (model, role) 遥测聚合
- `/lab models [--refresh]` — 候选目录（免费 + 直连）
- `/lab log <role> <model> [--rating N] [--task CAT]` — 手动补录
- `/lab pin <role> <model>` / `/lab unpin <role>`
- `/lab config [key value]` — 查看/修改权重与开关
- `/lab doctor` — 健康检查
- `/lab scheduler status` — 调度器实例状态（实例 ID、定义版本、轮次、agent 数量、开关）
- `/lab scheduler select <role>` — select-mode 调度 vs 旧推荐并排对比
- `/lab scheduler sync` — 同步 agent 种群到当前目录
- `/lab scheduler events [--limit N]` — 最近调度/路由/回退事件
- `/lab arena smoke <role>` — 真实竞价冒烟验证（真实 LLM 出价 + 真实冻结 + 合成结算，输出逐阶段证据）

## Arena Smoke 冒烟命令

`/lab arena smoke <role>` 执行一次受控的真实竞价验证：

**前置条件**（任一不满足 → 精确 notify）：
- `scheduler.enabled` = true
- Arena 实例 active（`/lab scheduler status` 确认）
- 目录候选模型 >= 2（`/lab models --refresh` 刷新）
- ModelCaller 可用（至少发生过一次 subagent 调用初始化 modelRegistry）

**语义**：
- Guard rails: `maxBidders=2`、`maxCallsPerDispatch=2`（dispatch 级临时覆盖，不修改实例 Round 参数）
- 真实 LLM 竞价（ModelCaller 发真实 API 调用）
- 真实冻结（winner stake 写入 arena_freezes）
- 合成结算（构造成功 Outcome，调 `runner.settle` 完成 unfreeze + credit/debit）
- 逐阶段输出证据：bidders、pre-dispatch balances、dispatch result、bid calls/stakes、freeze 前后余额、settle 后余额、event trace
- traceId 以 `smoke-` 为前缀
- 输出明确声明：真实执行与遥测结算不在本命令范围内
- fail-open：任何阶段错误输出已收集的部分证据

**输出样例**：
```
Arena Smoke: coder
traceId: smoke-1751500000000
注: 真实执行与遥测结算不在本命令范围内

── Guard Rails ──
  maxBidders: 2 (overridden from 10)
  maxCallsPerDispatch: 2 (overridden from 4)

── Bidders ──
  Catalog candidates: 5, eligible: 5
  deepseek/deepseek-chat [direct]
  openai/gpt-4o [openrouter]

── Pre-Dispatch Balances ──
  deepseek/deepseek-chat: 100
  openai/gpt-4o: 100

── Dispatch Result ──
  status: completed
  model: deepseek/deepseek-chat
  reason: stake 42 round 5
  settlementRef: smoke-1751500000000-settlement
  roundId: smoke-round-smoke-1751500000000
  attempts: 1

── Bid Calls ──
  agent=deepseek/deepseek-chat estimated_tokens=300 cost=0.00003
  agent=openai/gpt-4o estimated_tokens=300 cost=0.00075

── Parsed Stakes ──
  agent=deepseek/deepseek-chat stake=42
  agent=openai/gpt-4o stake=15

── Balances Before Freeze ──
  agent=deepseek/deepseek-chat balance=100

── Balances After Freeze ──
  agent=deepseek/deepseek-chat balance=58

── Post-Dispatch Balances ──
  deepseek/deepseek-chat: 58 (delta=-42)
  openai/gpt-4o: 85 (delta=-15)

── Synthetic Settle ──
  status: settled
  outcome: completion=1 majorError=false (synthetic)

── Balances After Settle ──
  deepseek/deepseek-chat: 121 (delta=+21)
  openai/gpt-4o: 85 (delta=-15)

── Event Trace (42 events) ──
  2026-07-26T... scheduling.requested {...}
  2026-07-26T... routing.resolved {...}
  ...
```

## 行为
- 自动记录每次 subagent 运行的完成度/成本/性能信号。
- `autoApply`（默认开）：派发 subagent 前按角色推荐模型；已 pin 静默应用，未 pin 弹确认（可记住）。任何异常都 fail-open，不阻断派发。

## 测试
`node --experimental-strip-types --test test/*.test.ts`

## 运维与升级

### 运维

**启动**

Agent Lab 作为 Pi 扩展自动加载，无需手动启动。启动时执行以下引导序列：

1. 加载配置（`config.json`）并初始化 SQLite 存储（`agent-lab.db`）。
2. 注册遥测监听器（自动记录每次 subagent 运行）。
3. 注册桥接拦截器（scheduler.enabled 时启用调度器选路）。
4. 引导调度器实例（weighted-scorer + arena），恢复过期任务，冻结残值对账。
5. 初始化 optimizer 子系统（lazy factory）。
6. 注册所有 `/lab` 命令。

任何引导阶段异常均 fail-open：错误记入 console.error，不影响 Pi 主流程。

**备份**

- 数据目录：`~/.pi/agent/agent-lab/`（`agent-lab.db` + `config.json`）。
- DB 备份：`/lab migrate` 自动在迁移前复制 `agent-lab.db` → `agent-lab.db.backup-<timestamp>`。
- 手动备份：`cp ~/.pi/agent/agent-lab/agent-lab.db ~/.pi/agent/agent-lab/agent-lab.db.backup-$(date +%s)`。
- 备份频率建议：重大迁移前、参数调优前、升级前。

**监控（通过事件）**

Agent Lab 通过结构化事件日志（`lab_events` 表）输出运行时信号：

| 事件类别 | 示例 | 含义 |
|---------|------|------|
| `scheduling.*` | `scheduling.requested`, `scheduling.completed` | 调度请求与结果 |
| `routing.*` | `routing.resolved`, `routing.binding.created` | 路由决策与绑定变更 |
| `optimizer.*` | `optimizer.proposal.submitted`, `optimizer.auto.promoted` | 优化提案与自动发布 |
| `round.*` | `round.promoted`, `round.rolled-back` | 参数轮次生命周期 |
| `migration.*` | `migration.reconciled`, `migration.ledger-baseline` | 迁移与对账 |

查询命令：
- `/lab scheduler events [--limit N]` — 最近调度/路由/回退事件
- `/lab optimizer proposals [sid]` — 优化提案历史
- 直接 SQL：`sqlite3 ~/.pi/agent/agent-lab/agent-lab.db "SELECT * FROM lab_events ORDER BY ts DESC LIMIT 20;"`

### 诊断

**doctor 健康检查**

`/lab doctor` 输出：
- 配置完整性（必需项 + 死 key 警告）
- 数据库状态（runs 记录数、store 表行数）
- 调度器实例状态（定义版本、当前轮次、agent 数量、开关）
- Arena 实例状态（活跃余额、冻结残值）
- Optimizer 实例状态（注册定义、活跃提案数）

**事件查询**

| 命令 | 用途 |
|------|------|
| `/lab scheduler events --limit 50` | 最近 50 条调度事件 |
| `/lab scheduler status` | 调度器实例详情 |
| `/lab arena smoke <role>` | 真实竞价冒烟（验证竞价→冻结→结算链路） |
| `/lab optimizer proposals` | 当前优化提案 |
| `/lab optimizer auto` | 自动优化配置与节流状态 |

**投影（projection）**

- 上下文策略对比：`/lab experiment compare context-experiment` — 按 strategy 聚合成本/性能指标。
- 支持 `--round` / `--rounds` 按轮次过滤。
- 底层实现：`projectContextStrategies(db, opts)` 从 `lab_events` 事件溯源聚合。

**手动 SQL 诊断**

```sql
-- 冻结残值检查
SELECT agent, balance, frozen FROM credits WHERE frozen > 0;
SELECT task_id, agent, amount, created_ts FROM arena_freezes;

-- 事件时间线
SELECT ts, type, json_extract(payload_json, '$.message') FROM lab_events ORDER BY ts DESC LIMIT 20;

-- 优化轮次历史
SELECT round_id, status, json_extract(params_json, '$.weights') FROM optimization_rounds WHERE scheduler_instance_id = 'default-weighted-scorer' ORDER BY created_ts DESC;
```

### 回滚

**回滚到 P7 前状态**

1. 切换到预迁移 tag：
   ```bash
   git checkout pre-p7-legacy
   ```

2. 恢复备份数据库：
   ```bash
   # 找到 /lab migrate 自动生成的备份（或手动备份）
   ls -la ~/.pi/agent/agent-lab/agent-lab.db.backup-*

   # 停止 Pi 后恢复
   cp ~/.pi/agent/agent-lab/agent-lab.db.backup-<ts> ~/.pi/agent/agent-lab/agent-lab.db
   ```

3. 重启 Pi，验证：
   - `/lab mode` 可用（显示 classic/market 切换）
   - `/lab recommend <role>` 输出 legacy 推荐
   - arena 调度器仍可用（如果 mode=market 且有 arena 实例）

**注意：**
- `pre-p7-legacy` tag 在 P7 合并前打上，包含 P1-P6 全部功能 + legacy classic/market 分支。
- DB 备份由 `/lab migrate` 在迁移时自动创建，位置为 `agent-lab.db.backup-<timestamp>`。
- 若回滚后重新启用 P7，重新运行 `/lab migrate` 即可（幂等）。

### 升级（P7 迁移指南）

**谁需要运行 `/lab migrate`？**

满足以下 **任一** 条件的用户：
- `config.json` 中存在 `mode` 字段（classic 或 market）
- `config.json` 中存在 `autoApply` 字段
- `config.json` 中存在 `arena.*` 子树

即几乎所有从 P6 及之前版本升级的用户都需要运行。

**迁移步骤**

```bash
# 1. 预览迁移（无副作用）
/lab migrate --dry-run

# 2. 执行迁移
/lab migrate

# 3. 验证
/lab scheduler status              # arena 实例 active
/lab scheduler events --limit 5    # 迁移期间事件
```

**迁移做了什么？**

1. 检测 legacy 配置字段（mode / autoApply / arena.*）
2. 确保 arena catch-all binding（通过 ControlPlane.setCatchAllBinding）
3. 备份数据库文件（agent-lab.db → agent-lab.db.backup-<ts>）
4. 写入迁移标记（store config 表 `migration.p7.completed`）

迁移是幂等的：第二次执行输出 `already migrated`。

**行为差异（来自 plan §0.2）**

| 场景 | P7 前 | P7 后 |
|------|-------|-------|
| bridge completed → apply | 改写 model | 同（不变） |
| bridge abstain / throw / 不可用 | 落 market → classic 兜底 | **不改写**（host 原模型） |
| settle（遥测结算） | bridge → market fallback | bridge 单路，未命中静默跳过 |
| `/lab mode` | 切换 classic/market | 弃用提示 → 指向 `/lab migrate` |
| `/lab recommend` | 经典推荐 | 弃用提示 → 指向 `/lab scheduler status` |
| `/lab arena post` | 旧 arena 发布 | 弃用提示 |
| config 死 key（mode/autoApply/arena.*） | 接受 | `/lab config` 拒绝并提示 |

**升级后验证**

- `npm test` 全绿（1136+ tests）。
- `/lab scheduler status` 确认 weighted-scorer + arena 实例 active。
- `/lab arena smoke coder` 冒烟通过（真实竞价→冻结→结算）。
- `/lab migrate` 二次执行输出 `already migrated`。
- 正常派发 subagent：interceptor 走 bridge-only 路径，遥测 settle 走 `createSettleDispatch`。

---

### CHANGELOG 迁移说明

**P7 (2026-07-27): 兼容入口收敛与旧路径退役**

- **移除**：legacy `classic/market` 模式分支。Interceptor 改为 bridge-only（`decideSchedulerSelection`），不再包含 market.allocate fallback、classic recommend/pin/select-UI 分支。
- **移除**：`market?: Market` 参数与 market fallback 从 `registerTelemetry`。`createSettleDispatch` 为唯一 settle 路径，未命中静默跳过。
- **移除**：`dualRun` 与 `legacyRecommend`。
- **删除文件**：`src/arena/market.ts`、`src/arena/bidding.ts`、`test/arena-market.test.ts`、`test/arena-bidding.test.ts`。
- **部分删除**：`src/interceptor/logic.ts` 的 `decideIntercept`；`src/arena/register.ts` 的 `applyArenaConfig`。
- **新增**：`/lab migrate` 命令（检测 legacy 配置 → 确保 arena binding → 备份 DB → 写标记）。
- **弃用**：`/lab mode`、`/lab recommend`、`/lab arena post` → 输出迁移指引。
- **拒绝**：`/lab config` 对 mode / autoApply / arena.* / scheduler.dualRun 死 key 报错。
- **行为变更**：bridge abstain/throw/不可用 → 不改写 host 原模型（不再落 market 兜底）。参见上方行为差异表。
- **测试**：1136 通过（基线 1131 - 1 删除 + 6 新增），零修改。
- **回滚**：`git checkout pre-p7-legacy` + 恢复 DB 备份。详见上方回滚节。

## Global architecture migration

The target architecture is documented in `docs/specs/2026-07-26-agent-lab-global-architecture-design.md`.

Phase 1 adds a sidecar Core for versioned definitions, instances, optimization rounds, events, and control-plane validation.

Phase 2 adds a sidecar WorkLoop SDK (contracts, registry, runner, state/checkpoint stores, context operations) and a pi-subagents Delegation V2 adapter with `pi-default-loop@1` implementation plus runtime composition (`createWorkLoopRuntime`).

Phase 3 encapsulates the Classic model-selection logic as the first `SchedulerDefinition` (`weighted-scorer@1.0.0`), executable through a Scheduler SDK (contracts, registry, dispatch runner with routing/round-pinning/fallback-chains) as an opt-in production switch. Fixed-input selection behavior is identical to the legacy path.

### Phase 3 architecture state

Phase 3 is delivered as a **select-mode sidecar**: the scheduler performs routing, candidate assembly, scoring, pin handling, and records standard events, but the interceptor mutates `input.model` exactly as the legacy path does. Full dispatch+execute mode (`SchedulerSDK.agents.run` → `WorkLoopRunner` → Delegation V2) is delivered and tested as the programmable sidecar path but is not wired for production.

- **select vs execute semantics**: In select mode, the scheduler only chooses a model; pi-subagents executes natively. In execute mode (tested, not production-wired), the scheduler's `agents.run` delegates through `WorkLoopRunner`. Execute mode becomes the production path in a later phase (P6/P7).
- **Data sources**: Scoring aggregates, pins, and model candidates are read from the legacy store/catalog via injected ports — no data migration needed. New-path executions write standard events to the P1 EventLog.
- **Fail-open**: Any error in the scheduler path falls back to legacy classic behavior silently (plus `console.error`). Default config keeps the new path **disabled**.

### Opt-in instructions

Enable the weighted-scorer scheduler selection path:

```
/lab config scheduler.enabled true
```

Optional tuning:

```
/lab config scheduler.instanceId <id>     # override default instance
```

### Migration

Use `/lab migrate` to migrate legacy config (mode, autoApply, arena.*) to the scheduler-based architecture. The command ensures arena catch-all binding, backs up the DB, and writes a completion marker. Use `--dry-run` to preview without side effects. Second run is idempotent.

### Deferred items from P2

The following known items were deferred from Phase 2 and remain unaddressed:

- **LabEvent.sequence numeric ordering**: Events currently use an optional `sequence` field that is not populated by the event log. A future phase should add monotonically increasing sequence numbers for deterministic event ordering.
- **throwIfCancelled active-run test**: The `throwIfCancelled` cancellation behavior in `WorkLoopRunner` is tested for queued runs but lacks a dedicated test for active (in-flight) runs. This should be covered when the Delegation V2 bus supports cancellation end-to-end.
- **Unused imports**: Several files carry unused type imports from the interop/contracts layer that were reserved for P3/P4 integration. Housekeeping is deferred until after the interceptor wiring stabilizes.
- **Context tool-dedup duplication**: The `pi-default-loop` context tools (`fresh.ts`, `fork.ts`) have overlapping dedup logic with the workloop context module. Consolidation is deferred until the context module's API is finalized.

Both P1 and P2 are intentionally not wired into `index.ts`; the existing Classic/Arena runtime remains the production path until later migration phases pass their acceptance gates.

### Unsupported protocol features (Delegation V2)

The Delegation V2 adapter provides start/update/terminal/cancel lifecycle events but does **not** support:
- **Pause/resume**: Agents cannot be suspended mid-execution and resumed later.
- **Steering**: Runtime operator cannot inject mid-run corrections or priority changes.
- **Per-tool events**: Individual tool-call start/end/error events are not surfaced; only aggregate update events are available.
- **Checkpoint restore in transport**: The adapter does not emit or consume checkpoint-restore protocol events (checkpoints are handled by the WorkLoop SDK separately).

### Runtime boundaries
- Runtime remains sidecar and is not wired into `index.ts`.
- Delegation V2 provides start/update/terminal/cancel, but not pause/resume/checkpoint/steering/per-tool events.
- Agent Lab checkpoint/fresh/fork state is separate from pi-subagents session context fresh/fork.
- Definitions and executable WorkLoop registry remain process-local.
- Full Artifact persistence, model/tool native SDK implementations, Scheduler integration, Agent lineage persistence, and production routing are later phases.

## Phase 4a: Arena Scheduler (kernel)

P4 was split into **P4a** (kernel — this branch) and **P4b** (data migration + audit, mode retirement, real smoke). P4 acceptance is gated on P4b completion.

### Architecture

Arena is encapsulated as a second production `SchedulerDefinition` (`arena@1.0.0`) in **select mode**. The arena scheduler performs model bidding, per-task stake freezing, and settlement through the shared `SqliteLedger`. The scheduler is wired through the P3 `SchedulerRunner` and the existing telemetry settlement path (`registerTelemetry` → `runner.settle` → arena settle hook).

**Key components:**
- `src/schedulers/arena-definition.ts` — parameter model (endowment, odds, settlement, bidding, market, risk)
- `src/schedulers/arena-scheduler.ts` — implementation: schedule (bid → freeze → createTask) + settle (unfreeze → credit/debit → metrics)
- `src/schedulers/bootstrap.ts` — `ensureArenaInstance` registers definition, creates draft, validates, activates; `syncArenaAgents` syncs model candidates to agent instances
- `src/arena/ledger.ts` — `SqliteLedger` with per-task freeze isolation via `arena_freezes` table
- Settlement path: `registerTelemetry` → `createSettleDispatch` → `runner.settle` (hit) or legacy `market.settle` (miss)

### Three correctness fixes

P4a fixes three known bugs in the legacy arena ledger:

1. **Per-task freeze isolation**: Legacy `freeze()` used a single aggregate `frozen` column. P4a adds `arena_freezes(task_id, agent, amount)` and atomically guards `UPDATE credits SET balance = balance - ? WHERE agent = ? AND balance >= ?`. Each task's stake is independently tracked and unfrozen.

2. **Eligibility filtering**: Legacy `market.eligibility` was never applied. P4a filters candidates by glob pattern (comma-separated, `"all"` for everything) before bidding, using the existing `globMatch` from `src/interceptor/logic.ts`.

3. **Max stake ratio**: New `risk.maxStakeRatio ∈ (0, 1]` parameter clamps each bidder's stake to `floor(balance × maxStakeRatio)`, preventing any single candidate from betting their entire balance on one task.

### Fallback chain

When arena is active in market mode, its routing binding has priority 10 (catch-all). The fallback chain is:

```
arena (priority 10) → weighted-scorer → original-request
```

- Arena fails (`no-eligible-bids`, `freeze-rejected`, etc.) → runner walks fallback chain.
- Arena uses `failed(retryable=false)`, not `abstained`, to trigger fallback.
- All three legs are recorded as `DispatchAttempt` records in the result.

### Static mode routing + restart semantics

- Routing bindings are **startup-time static**. Changing `mode` at runtime (`/lab mode`) does **not** rebuild routing bindings — a restart is required.
- On restart, `runner.pendingSettlements` (in-memory map) is lost. Settlement falls through to legacy `market.settle`, which is semantically correct because both arena and legacy tasks share the same `market_tasks` table.
- Bootstrap order: weighted-scorer must be activated first, then arena (ControlPlane validates `fallback-not-active`).

### P4a scope vs P4b

**P4a delivers:**
- Arena scheduler kernel (definition, implementation, bootstrap)
- Per-task freeze isolation in `SqliteLedger`
- Eligibility filtering and max stake ratio
- Settlement lifecycle hook wired through scheduler runner
- Static mode routing with fallback chain
- Integration tests covering all 6 scenarios

**P4a does NOT deliver (these are P4b):**
- Credits/task data migration to private namespace
- Migration audit and verification
- Real bidding smoke tests (P4a uses fake `ModelCaller` in tests)
- `classic/market` mode branch retirement
- Budget hard integration (estimated cost metrics only)

**P4 acceptance is gated on P4b completion.** See `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md` §6.

### Legacy aggregate-frozen residue

P4a adds `arena_freezes` for per-task tracking but does **not** auto-migrate old aggregate `credits.frozen` values. If a legacy process had active freezes before upgrading:

- `credits.frozen` shows the aggregate (may be stale residue).
- `arena_freezes` shows the per-task breakdown (P4a tasks only).
- `recoverStaleTask` on old pending tasks calls `unfreeze`, which returns 0 for tasks without an `arena_freezes` row (idempotent).

**Manual inspection queries:**
```sql
-- Check for aggregate frozen residue (should be 0 after all P4a tasks settle)
SELECT agent, balance, frozen FROM credits WHERE frozen > 0;

-- List per-task freezes (P4a tasks)
SELECT task_id, agent, amount, created_ts FROM arena_freezes;

-- List pending tasks that may have residue
SELECT task_id, winner, stake, status, created_ts FROM market_tasks WHERE status = 'pending';
```

**Manual cleanup** (only if residue is confirmed):
```sql
-- Reset stale aggregate frozen to 0 (after verifying no active per-task freezes)
UPDATE credits SET frozen = 0 WHERE frozen > 0 AND agent NOT IN (SELECT agent FROM arena_freezes);
```

## Phase 4b: Migration acceptance & runtime hardening

P4b (this branch, `feature/agent-lab-p4b`) completes the P4 acceptance gates deferred from P4a: live routing binding rewrite, frozen-residue reconciliation, runtime parameter threading, dead-code cleanup, real bidding smoke, and roadmap acceptance reconciliation.

### Live routing semantics

`/lab mode market|classic` now rewrites DB routing bindings live — no restart required:

- `cfg.mode` is still updated and persisted as the legacy-branch switch (the interceptor reads it). It also serves as the first-boot seed: `ensureArenaInstance` evaluates `cfg.mode` only when no arena instance exists yet, creating the initial routing binding accordingly.
- **DB binding is the authoritative routing source.** The `SchedulerRunner` resolves bindings from `listRoutingBindings()` on every dispatch. The `CatchAllBinding` (`id: "arena-default"`, `priority: 10`, `match: {}`) is upserted/deleted by `ControlPlane.setCatchAllBinding()` with audited `routing.binding.*` events.
- **Explicit `scheduler.instanceId` bypass:** When `cfg.scheduler.instanceId` is set explicitly, the scheduler bridge calls `dispatch()` with that instance ID directly, bypassing the routing binding table. In this mode, `/lab mode` binding rewrites have no effect on dispatch routing. The command notifies a warning.

### Frozen-residue reconcile

`SqliteLedger.reconcileFrozenResidue()` runs at startup (after stale-task recovery) and detects agents where `credits.frozen > 0` but no corresponding `arena_freezes` row exists — the P4a-前 legacy residue:

- **Per-agent semantics:** For each affected agent, the reconcile operation **returns** the frozen balance (`balance += frozen`), **zeroes** `credits.frozen`, and writes a compensating `credit_tx` with `reason = migration-reconcile frozenBefore=<N>` (delta=0, preserving the audit record without double-counting).
- **Audit events:** Each reconciled agent emits a `migration.reconciled` event (via `schedulerCore.events` when available, otherwise `console.error`-logged). A separate `migration.ledger-baseline` event captures a credits/tasks count snapshot (no state change).
- **Crash-atomic freeze:** The three-statement freeze path (`SELECT credits.frozen`, `INSERT arena_freezes`, `UPDATE credits`) is wrapped in `BEGIN IMMEDIATE`/`COMMIT` (bare `exec`, not `CoreRepository.transaction()`), making it crash-safe.
- **Idempotent:** Re-running reconcile with no residue returns an empty array.

### D2 overlap: arena + legacy market co-existence

When both `scheduler.enabled` and `cfg.mode === "market"` are active, the interceptor flow is:

1. Scheduler bridge dispatches through arena (routing → bid → freeze → createTask with `toolCallId` as `settlementRef`).
2. If arena dispatch **fails** (fallback chain exhausted), the bridge catches the error and falls through to the legacy code paths.
3. The interceptor then reaches the legacy `market.allocate` block, which attempts to create a `market_tasks` row for the **same `toolCallId`**.
4. Since arena already wrote a `market_tasks` row for that `toolCallId` during step 1, the legacy `INSERT` hits a primary-key conflict. The `.catch(() => undefined)` wrapper silently swallows it.
5. **Net result:** The arena-dispatched task stands; the telemetry settlement path (`runner.settle`) settles it. The PK conflict is harmless.

### Settle parameter semantics

The settlement path threads **schedule-time round parameters** into `SettleContext.parameters`:

- When `settlementRef` maps to a dispatched entry with a `roundId`, `runner.settle` calls `core.repository.getRound(entry.roundId)` and passes `round.parameters` as `ctx.parameters`.
- When `roundId` is absent (e.g., restart-degraded settlements that fall through to legacy `market.settle`), `ctx.parameters` is `undefined` and the implementation falls back to its own defaults.
- **Pre-P5 coherence:** Before P5 introduces OptimizationRound parameter divergence, `round.parameters` equals the arena definition's default parameters, which in turn match `cfg` (the arena definition initializes from config). Therefore, restart-degraded legacy settle (which constructs parameters from `cfg`) agrees with the schedule-time snapshot.
- **P5 divergence constraint:** Once P5 introduces parameter proposals, restart-degraded legacy settle may use stale post-proposal parameters while the snapshot carries the schedule-time values. This divergence is documented as a constraint that P5 must address.

### Smoke guide

The `/lab arena smoke <role>` command provides real-bidding verification. See [Arena Smoke 冒烟命令](#arena-smoke-冒烟命令) above for full usage, preconditions, guard rails, synthetic-settle scope note, and sample output.

## Phase 5a: Optimizer proposal & round lifecycle

P5 was split into **P5a** (wiring + integration + docs — this branch) and **P5b** (shadow/canary automation, automatic triggers, auto-promote). P5 acceptance is gated on P5b completion.

### Architecture

P5a wires the optimizer subsystem into the lazy scheduler runtime factory and provides a command-driven closed loop:

```text
runs data → /lab optimizer run → proposal (pending)
           → /lab optimizer diff <proposalId> → leaf-path changes + tunable markers
           → /lab optimizer promote <roundId> → new active round with traceability
           → /lab optimizer rollback <sid> <targetRoundId> → params restored
```

**Key components:**
- `src/optimizer/registry.ts` — `OptimizerRegistry` with compatibility gates (version range, parameter model version, projector registration)
- `src/optimizer/data-api.ts` — `DataAPIImpl`: read-only facade authorized per optimizer instance's `targetSchedulers`
- `src/optimizers/weighted-tuner.ts` — Reference optimizer `weighted-tuner@1.0.0`: pure `decide()` function adjusting `weights.completion` and `weights.costEffectiveness` based on windowed runtime data
- `src/optimizers/ws-projector.ts` — Windowed-SQL projector for `weighted-scorer`: reads legacy `runs` table
- `src/core/control-plane/service.ts` — `submitProposal` (six-gate validation), `promoteRound` (re-validation + supersede discipline), `rollbackRound`
- `src/core/parameter-diff.ts` — `diffLeafPaths` + `assertPathsTunable` for leaf-level parameter comparison
- `index.ts` — Lazy-factory wiring: register ws-projector, register weighted-tuner definition, idempotent instance creation, `OptimizerFacade` injected into commands

### Gate list (submitProposal)

1. **Instance & optimizer existence**: Both active, optimizer targets this scheduler instance
2. **Version compatibility**: Scheduler versionRange + parameterModelVersionRange match (via `matchesVersionRange`)
3. **Baseline freshness**: `proposal.baseRoundId === instance.currentRoundId` (stale baseline → rejected)
4. **Schema validation**: `validateParameters(proposal.parameters)`
5. **Transition validation**: `validateTransition(base.params, proposed.params)`
6. **Tunable paths**: `diffLeafPaths` ⊆ `tunablePaths` (case-sensitive, `*`-segment wildcard)

All six gates must pass; failure persists the proposal as `rejected` + `optimizer.proposal.rejected` event.

### Command usage

```
/lab optimizer list                      # list all optimizer instances
/lab optimizer run <instanceId>          # evaluate runtime data, submit proposal or skip
/lab optimizer proposals [sid]           # list proposals, optionally filtered by scheduler instance
/lab optimizer diff <proposalId>         # show leaf-path changes with ✓/✗ tunable markers
/lab optimizer promote <roundId>         # promote candidate round to active (re-validates all gates)
/lab optimizer rollback <sid> <target>   # roll back to a prior round (new round, params restored)
```

All commands fail-open: "optimizer unavailable (bootstrap pending)" before lazy factory initialization; exceptions are caught and notified.

### Data-window time-overlap caveat

The ws-projector reads the legacy `runs` table filtered by timestamp window. Runs are attributed to whichever round was active at run-record time — not necessarily the round that dispatched them. When two rounds' active periods overlap (e.g., a promote happened mid-window), runs may be counted toward both windows, inflating sample counts. This is an acceptable approximation for the reference tuner. A proper `round_id` column on `runs` is deferred to P7. See `src/optimizers/ws-projector.ts` for details.

### Events

| Event | When |
|-------|------|
| `optimizer.run.triggered` | Before evaluate |
| `optimizer.run.skipped` | No actionable signal or insufficient data |
| `optimizer.run.failed` | Exception during optimize |
| `optimizer.proposal.submitted` | Passed all six gates |
| `optimizer.proposal.rejected` | Failed any gate |
| `optimizer.proposal.superseded` | Auto-superseded when another proposal is promoted |
| `round.proposed` | Candidate round created |
| `round.promoted` | Candidate round promoted to active |
| `round.rolled-back` | Rollback to prior round |
| `optimizer.access.denied` | DataAPI called with unauthorized scheduler instance |
| `optimizer.instance.created` | Instance persisted |

### P5b reserved items

The following are deferred to P5b:
- Shadow/canary round automation (`validated`, `canary`, `initial` states)
- Automatic optimizer execution triggers (periodic or event-driven)
- Auto-promote from canary to active
- Arena reference optimizer
- Optimizer persistent state across restarts

### P5a scope vs P5b

**P5a delivers:**
- Optimizer registry with compatibility gates
- Authorized read-only DataAPI with per-scheduler-instance access control
- Six-gate proposal submission with stale-baseline detection
- Promote/rollback round lifecycle with supersede discipline
- Reference optimizer `weighted-tuner@1.0.0` with windowed runs projector
- `/lab optimizer` command family with diff, promote, rollback
- Integration tests covering e2e closed loop, supersede, failure isolation, authorization, and stale baseline
- Runtime wiring in the lazy factory with fail-open bootstrap

**P5a does NOT deliver (these are P5b):**
- Shadow/canary automatic state transitions
- Automatic optimizer triggers
- Auto-promote
- Arena optimizer
- Optimizer persistent state

**P5 acceptance is gated on P5b completion.** See `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md` §7.

## Phase 5b: Shadow/Canary Automation

P5b delivers automatic shadow validation, canary rollouts, auto-trigger, auto-promote, and auto-rollback — completing the P5 optimizer closed loop.

### Architecture

```text
runs data → auto-trigger (throttled, fire-and-forget)
          → optimizer.run → proposal (pending)
          → autoFlow.tick → shadow eval (validated)
          → autoFlow.tick → canary start (% traffic)
          → canary eval → auto-promote / auto-rollback
          → events + traceability chain
```

**Key components:**
- `src/optimizer/shadow.ts` — `evaluateShadow`: fixed-catalog snapshot scoring comparison between current vs candidate weights (top-1 ranking delta + expected completion/cost deltas from projector avgCost)
- `src/optimizer/canary-eval.ts` — `evaluateCanary`: trace_id → EventLog → optimizationRoundId attribution; `decideCanaryAction`: pure ε-gated rollback decision
- `src/optimizer/auto-trigger.ts` — `createAutoTrigger`: in-memory throttle (everyNRuns / everyTMs, OR logic), fire-and-forget, restart-clears-throttle
- `src/optimizer/auto-flow.ts` — `createAutoFlow`: full orchestration tick: shadow → validated → canary start → evaluate → promote/rollback
- `src/commands/register.ts` — New `/lab optimizer` subcommands: `validate`, `canary start|stop|status`, `auto`
- `src/optimizer/facade.ts` — Extended `OptimizerFacade` with validate, canaryStart, canaryStop, canaryStatus, autoStatus
- `index.ts` — Wiring: auto-trigger via `onRunRecorded` telemetry hook; auto-flow tick after trigger fire + after manual `/lab optimizer run` success

### Commands

```
/lab optimizer validate <proposalId>          # manual shadow run
/lab optimizer canary start <roundId> [pct]   # start canary on validated round
/lab optimizer canary stop <schedulerId>      # abort active canary
/lab optimizer canary status                  # show canary pointer + latest eval
/lab optimizer auto                           # show merged optimizer config + trigger throttle
```

All commands fail-open: try/catch + notify; "bootstrap pending" before lazy factory init.

### Config reference

```json
{
  "optimizer": {
    "shadow": { "enabled": false },
    "canaryPercent": 0,
    "autoTrigger": { "enabled": false, "everyNRuns": 10, "everyTMs": 300000 },
    "autoPromote": { "enabled": false, "minSamples": 30, "epsilonCompletion": 0.02, "epsilonCost": 0.02 },
    "autoRollback": { "enabled": false, "minSamples": 30, "epsilonCompletion": 0.02, "epsilonCost": 0.02 }
  }
}
```

All keys default-off. Config is deep-merged by `mergeConfig` (`src/config.ts`).

### Default-off & safety

- **All auto features default to off.** With default config, no shadow, no canary, no auto-trigger, no auto-promote — zero behavioral change.
- **Auto-trigger is fire-and-forget:** never blocks, never throws into the telemetry handler (L7/I7).
- **Auto-flow tick is fail-open:** rejection/error → benign `optimizer.auto.*` events only, no retry loops (L6).
- **Race safety:** concurrent manual promote between eval and auto-promote → caught by gate re-validation → benign `optimizer.auto.promote-failed` event.

### Known limitations

- **I5 false-positive limitation (honest note):** Auto-rollback uses ε-gated thresholds with absolute minimum floor (`max(ε, 0.02)`), but lacks statistical significance testing. With small canary samples, rollback decisions may be noise-driven. Configuring higher `minSamples` reduces false positives at the cost of longer canary periods.
- **Restart-clears-throttle:** Auto-trigger throttle state is purely in-memory — restart resets the counter. Acceptable per L5.
- **Single-target assumption:** `autoFlow.tick` operates on one scheduler instance at a time. Multi-target orchestration is the caller's responsibility (M4).
- **NULL trace_id exclusion:** Pre-P5b runs have `trace_id=NULL` and are excluded from precise canary attribution. They are counted as `excludedNullTrace` in canary eval results.

### Events

| Event | When |
|-------|------|
| `optimizer.shadow.completed` | Shadow evaluation finishes |
| `round.validated` | Round transitions proposed → validated |
| `optimizer.auto.canary-started` | Auto: canary % is set on a validated round |
| `optimizer.auto.promoted` | Canary round auto-promoted to active |
| `optimizer.auto.rollback` | Degraded canary auto-rolled back |
| `optimizer.auto.promote-failed` | Race: concurrent manual promote |
| `optimizer.auto.rollback-failed` | Race: concurrent manual abort |
| `optimizer.auto.failed` | Unexpected tick error (safety net) |
| `optimizer.auto.mark-validated-failed` | Race: concurrent manual validate during shadow |
| `optimizer.canary-started` | Manual: canary started via /lab optimizer canary start |
| `round.canary-aborted` | Canary aborted (manual or auto) |

### P5b scope vs later phases

**P5b delivers:**
- Shadow/canary automatic state transitions (proposed → validated → canary → promoted / rolled-back)
- Automatic optimizer triggers (throttled, fire-and-forget)
- Auto-promote from canary to active
- Auto-rollback on degradation
- `/lab optimizer validate|canary|auto` commands
- Integration tests: full pipeline event chain + traceability

**P5b does NOT deliver (these are later phases):**
- Arena canary / Arena optimizer
- Multi-target Pareto optimization
- Statistical significance testing
- `setInterval`-style periodic triggering (v1 is per-run throttle only)
- UI visualization / dashboard

**P5 acceptance is now complete.** See `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md` §7.

## Phase 6a: Experiment Runtime + Managed WorkLoops

P6a delivers an experiment-side WorkLoop runtime for comparing context-management strategies without touching the production select path.

### Architecture

```text
createExperimentRuntime(db, { model, tools, artifacts })
  └─ LabCore (definitions, repository, events)
  └─ WorkLoopRegistry  (cloneModes validation)
  └─ WorkLoopRunner     (buildSDK → instrumented ModelPort)
  └─ AgentRuntimeStateStore + CheckpointStore

managed-loop skeleton
  ├─ runManagedLoop: model-complete → append loop
  ├─ hard caps: maxModelCalls (default 8), tokenCeiling (default 32000)
  ├─ pluggable StrategyHook for context management
  └─ usage aggregation with observed/derived/mixed markers

budgeted-history@1.0.0
  ├─ strategy: keep system prompt + most recent ≤ budgetTokens (default 8192)
  ├─ emits context.transformed (kind: truncate) on over-budget
  └─ cloneModes: ["fresh"]
```

### Event vocabulary

| Event | Emitted by | Notes |
|-------|-----------|-------|
| `context.transformed` | `emitContextTransform()` (budgeted-history strategy) | kind: truncate/summarize/select/inject; beforeTokens/afterTokens/droppedSegments |
| `context.summary.created` | `emitSummaryCreated()` (P6b forward-compatible) | inputTokens/outputTokens/cost/durationMs; source: observed/derived |
| `model.requested` | `createInstrumentedModelPort` wrapper | emitted before every `complete()` call |
| `model.completed` | `createInstrumentedModelPort` wrapper | input/output/cacheRead/cacheWrite/cost/durationMs; source: observed/derived |
| `model.failed` | `createInstrumentedModelPort` wrapper | code + message; emitted on throw from inner port or provider error |

All events carry `schedulerInstanceId`/`dispatchId` identity (when set in `WorkLoopRunRequest`) and are queryable via `DataAPIImpl.listEvents` (I1 closed loop).

### Token estimation heuristic

No tokenizer available. All estimates use `ceil(chars / 4)` — a rough heuristic for English text.

**Limitations:**
- CJK characters may be >1 token each in subword tokenizers
- Special tokens (BOS, EOS, separators) are not counted
- Tool-call schema definitions injected by providers are not counted
- Image / multi-modal parts are not estimated

Every estimated value carries `source: "estimated"` in telemetry metrics to distinguish from provider-reported token counts.

### Usage source marking

| Source | Meaning |
|--------|--------|
| `observed` | Provider-reported usage from `pi-ai` `complete()` result (`usage != null`) |
| `derived` | Usage absent from result — cost derived from catalog pricing + token estimate |
| `mixed` | Aggregate across multiple calls where at least one was derived |

### Experiment-scope boundary

- **Production select path untouched**: `src/interceptor/`, `src/scheduler/`, `src/telemetry/` — zero diff.
- Experiment runtime is standalone: no eventBus, no PiSubagentsAdapter, no pi-default-loop auto-registration.
- ModelPort instrumentation lives in `src/workloops/model-port.ts` and is wired into `WorkLoopRunner.buildSDK`.
- Agent ids follow `agent-<model>-<strategy>` convention (D2). Storage and checkpoint namespaces are per-agent (M7 isolation).

### P6b / P6c remainder

| Item | Target |
|------|--------|
| selective-summary@1.0.0 workloop | P6b |
| Event projection (lab_events → comparison views) | P6b |
| `/lab experiment` command | P6b |
| Turn-level lifecycle integration | P6c |
| Judge quality scoring | P6c |

**P6 acceptance is gated on P6b completion.** See `docs/plans/2026-07-26-agent-lab-global-architecture-roadmap.md` §8.

## Phase 6b: Selective-Summary + Event Projection + /lab experiment

P6b adds the `selective-summary@1.0.0` managed loop, context event projection over `lab_events`, the `context-experiment@1.0.0` scheduler definition, and the `/lab experiment` command family.

### selective-summary@1.0.0

**Strategy:** when context exceeds `budgetTokens` (default 8192):

1. Select the oldest fraction (`summaryWindow`, default 0.5) of messages.
2. Call `sdk.model.complete` with a dedicated summarisation system prompt.
3. Replace the oldest segment with ONE summary message (role `"user"`, prefixed `[summary]`).
4. Keep system prompt + newest messages intact.
5. Emit `context.summary.created` (usage + source observed/derived) BEFORE `context.transformed` (kind: `"summarize"`).

**Hard caps:**
- `maxSummaryCalls` (default 1/run) — enforced via `sdk.storage` counter.
- Summary model calls count toward `maxModelCalls` to prevent unbounded spend.

**fail-open:** if the summarisation LLM call throws, fall back to budgeted truncation (kind: `"truncate"`, `fallback: true` in payload).

**Config fields:**
| Field | Default | Description |
|-------|---------|-------------|
| `budgetTokens` | 8192 | Token threshold for strategy invocation |
| `summaryWindow` | 0.5 | Fraction of oldest messages to summarise |
| `summaryModel` | — | Override model for summary calls (falls back to main model) |
| `maxSummaryCalls` | 1 | Maximum summary calls per run |

### context-experiment@1.0.0

**Execute-only** scheduler definition for side-by-side context-strategy comparison experiments.

```text
context-experiment@1.0.0
  └─ parameters: { assignments: Assignment[] }
  └─ tunablePaths: ["assignments"]
  └─ validateParameters/validateTransition
  └─ schedule (execute mode): parameterized direct pick
  └─ schedule (select mode): returns abstained
```

**Agent convention:** `agent-<sanitized-model>-<strategy>` (e.g. `agent-openai__gpt-4o-budgeted-history`).

**Strategy → workloop mappings:**
| Strategy | WorkLoop ID |
|----------|-------------|
| `default` | `pi-default-loop` |
| `budgeted-history` | `budgeted-history` |
| `selective-summary` | `selective-summary` |

### /lab experiment commands

All commands fail-open ("bootstrap pending" before lazy factory init, try/catch on exception). Real model calls only in command-foreground mode (I8).

```bash
# Create experiment: 1 model × 3 strategies
/lab experiment create openai/gpt-4o default budgeted-history selective-summary

# Run one variant
/lab experiment run context-experiment "explain monads in typescript" --strategy selective-summary
/lab experiment run context-experiment "explain monads" --index 1

# Show instance status and variant agents
/lab experiment status context-experiment

# Compare projection across strategies
/lab experiment compare context-experiment
```

### Event projection (context-projector)

`projectContextStrategies(db, opts)` — event-sourced aggregation over `lab_events`.

**Per-strategy buckets** include:
| Field | Source Event(s) |
|-------|----------------|
| `executions` | `agent.completed` (COUNT DISTINCT executionId) |
| `modelCalls` | `model.completed` (COUNT) |
| `totalInputTokens` / `totalOutputTokens` | `model.completed` metrics |
| `totalCostObserved` | `model.completed` where `source = "observed"` |
| `totalCostDerived` | `model.completed` where `source = "derived"` |
| `avgDurationMs` | `model.completed` metrics AVG |
| `transforms` | `context.transformed` (count by kind) |
| `summaryCalls` | `context.summary.created` (COUNT) |
| `summaryCost` | `context.summary.created` metrics SUM |

**Observed/derived split:** `totalCostObserved` = provider-reported cost (`.source = "observed"`), `totalCostDerived` = catalog-pricing-derived cost. Summary cost is tracked independently in `summaryCost` (P6b cost attribution).

**Strategy derivation:** primary source is `workLoopId` in event identity (always present on runner-emitted events). `pi-default-loop` maps to `"default"`. Fallback: suffix after last `-` in `agentInstanceId` (convention `agent-<model>-<strategy>`). Ultimate fallback: `"unknown"`.

**Unattributed events:** events with NULL/missing/empty `$.agentInstanceId` are excluded from buckets and counted in `unattributed`.

### Limitations

- **Single-turn only (v1):** managed loops make one model call per run. Multi-turn is a later phase.
- **Command-foreground only:** real model calls only through `/lab experiment run`. No background/periodic execution.
- **Manual quality assessment:** no judge or automated quality scoring. Compare outputs manually.
- **Token estimation heuristic:** `ceil(chars/4)` — no real tokenizer.

## Phase 6c: Round Promotion for Experiments

P6c integrates the `context-experiment` scheduler with the generic `ControlPlane` optimization-round lifecycle. Experiment round promotion uses the same six-gate proposal → promote → rollback machinery as `weighted-scorer`, applied to the experiment's `assignments` tunable path.

### Round promotion for experiments

Experiment instances use the generic `ControlPlane` round lifecycle (`submitProposal` → `promoteRound` → `rollbackRound`), verified end-to-end in `test/context-experiment-rounds.test.ts`. The `assignments` parameter is the sole tunable path (whole-leaf array replacement).

**Entry points (be honest about UI vs API-only):**

| Path | Available? | Notes |
|------|-----------|-------|
| `/lab optimizer run <instanceId>` | ws-only | Targets `weighted-scorer` scheduler instances only; does **not** apply to `context-experiment`. |
| `core.controlPlane.submitProposal(...)` | API | Generic programmatic entry point; works for any scheduler instance including `context-experiment`. Tested in `test/context-experiment-rounds.test.ts`. |
| `/lab optimizer promote <roundId>` | CLI | Works for any candidate round regardless of scheduler type. |
| `/lab optimizer rollback <sid> <targetRoundId>` | CLI | Works for any scheduler instance. |

**Typical API-level workflow (no dedicated `/lab experiment promote` command):**

```typescript
// Submit a proposal changing assignments (API-level only — no CLI shortcut)
const result = core.controlPlane.submitProposal(
  optimizerInstanceId,
  "context-experiment",
  {
    parameters: { assignments: [/* new assignments */] },
    evaluation: { dataWindow: { from: 0, to: Date.now() } },
    baseRoundId: "context-experiment:round:0",
  }
);

// Promote the candidate round (CLI or API)
// CLI: /lab optimizer promote context-experiment:round:1
core.controlPlane.promoteRound("context-experiment", result.candidateRoundId);

// Rollback (CLI or API)
// CLI: /lab optimizer rollback context-experiment context-experiment:round:0
core.controlPlane.rollbackRound("context-experiment", "context-experiment:round:0");
```

### Round-scoped compare

`/lab experiment compare` supports optional round filtering for targeted comparison:

```bash
# Compare all strategies within a specific round
/lab experiment compare context-experiment --round context-experiment:round:1

# Compare per-round buckets (grouped projection)
/lab experiment compare context-experiment --rounds
```

- `--round <roundId>`: filters events to a single `optimizationRoundId` via `json_extract(identity_json, '$.optimizationRoundId')`. Returns a single `ContextProjection` scoped to that round.
- `--rounds`: queries all distinct `optimizationRoundId` values from `lab_events` and returns per-round `RoundBuckets` (roundId → ContextProjection map). Rounds with NULL/empty roundId are skipped.
- Implementation: `projectContextStrategies(db, { roundId })` and `projectContextStrategiesByRound(db, ...)` in `src/optimizer/context-projector.ts`.

### Evidence

- **End-to-end round lifecycle test**: `test/context-experiment-rounds.test.ts` — covers submitProposal (six-gate validation for assignments), promoteRound (supersede discipline, new dispatch uses promoted assignments), rollbackRound (assignments revert), full event traceability.
- **Round-scoped projection**: `src/optimizer/context-projector.ts` — `roundId` filter + `projectContextStrategiesByRound`.
- **Baseline**: 1149 tests pass, zero modifications to existing 1104 production-select-path tests.

### What P6c does NOT deliver

- **No dedicated `/lab experiment promote` CLI**: promotion uses generic `/lab optimizer promote`.
- **No experiment-scoped optimizer instance**: proposal submission is API-level only (`core.controlPlane.submitProposal`).
- **No automatic round lifecycle triggers for experiments**: manual promote/rollback only.
- **No judge quality scoring**: deferred to later phase.
- **No multi-turn experiments**: single-turn only.
