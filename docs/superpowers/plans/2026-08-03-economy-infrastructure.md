# 经济层 D1：基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建经济层全部底层机制——VoucherPort/中央池/elo 系统/任务类型注册表/pit-flow 三扩展（effect/fanout/subflow）/双向托管——为 D2 市场闭环提供可测基础设施。

**Architecture:** 货币机制在 `extensions/agent-lab/src/economy/`（新目录，SqliteVoucher 与 SqliteLedger 共享 DatabaseSync）；flow 引擎扩展在 `src/ptl/flow/`（code 节点保持纯函数，effect 节点承担确定性副作用）；elo/任务类型走项目 RegistryPattern。

**Tech Stack:** node:sqlite (DatabaseSync) / node:test / TypeScript strip-types

## Global Constraints

- 零新增依赖（node 内建 + 既有相对模块）；R0 不碰 pi 源码
- agent-lab（`extensions/agent-lab/`）内 import 后缀 `.ts`；PTL 侧（`src/`）import 后缀 `.js`
- 测试 node:test（`node --experimental-strip-types --test test/*.test.ts`）；文件写入 tmp+rename 原子
- **code 节点纯函数**（不碰 DB/网络/随机数）；**effect 节点幂等 + 内部单事务原子**（部分失败不存在）；**fanout 编译期展开静态图 + 候选快照 checkpoint**
- `RESERVED_IDS = new Set(["central-pool", "calibration-executor"])`
- 默认值钉死：`DEFAULT_EXCHANGE_RATES = { llm: 10, time: 5, compute: 2 }`；`DEFAULT_ENDOWMENT = 100`；elo `initial=1500 / FLOOR=100 / K=32`；`taskRating = 1500 + 200×(O−1)`；`maxFanout` 默认 32
- 凭证锚定：`llm 1 unit = 1M tokens`；`time 1 unit = 3600s`；`compute 1 unit = 1 GB·天`

---

### Task 1: arena 遗留清障（errorMode stakeOnly + unfreeze 事务包裹）

**Files:**
- Modify: `extensions/agent-lab/src/config.ts`（settlement 默认值）
- Modify: `extensions/agent-lab/src/arena/ledger.ts`（unfreeze 事务）
- Test: `extensions/agent-lab/test/arena-ledger.test.ts`

**Interfaces:**
- Consumes: 既有 `SqliteLedger.unfreeze(taskId)` / `MarketConfig.settlement`
- Produces: `unfreeze` 事务安全；`errorMode` 行为恒 stakeOnly（字段保留读取兼容，值被忽略）

- [ ] **Step 1: 写失败测试**——`unfreeze` 并发安全（同 taskId 双重 unfreeze 只生效一次）；`SettlementPolicyV1.settle` 在 `errorMode: "stakeTimesOdds"` 配置下 majorError 仍返回 `-stake`（字段被忽略）

```ts
// test/arena-ledger.test.ts 追加
test("unfreeze 并发同 taskId 只生效一次", () => {
  const l = freshLedger();
  l.credit("a", 100, "seed"); l.freeze("a", "t1", 30);
  l.unfreeze("a", "t1"); l.unfreeze("a", "t1"); // 第二次 no-op
  assert.equal(l.balance("a"), 100); // 不双重解冻
});
test("errorMode 字段被忽略：stakeTimesOdds 配置下 majorError 仍 -stake", () => {
  const p = new SettlementPolicyV1({ ...DEFAULT_MARKET_CONFIG, settlement: { tax: 5, errorMode: "stakeTimesOdds" } });
  assert.equal(p.settle({ odds: 4 } as any, 10, { majorError: true } as any), -10);
});
```

- [ ] **Step 2: 运行确认 FAIL**——`node --experimental-strip-types --test test/arena-ledger.test.ts`（unfreeze 双重生效 / errorMode 仍走 stakeTimesOdds）
- [ ] **Step 3: 实现**——`ledger.ts` unfreeze 加 `BEGIN IMMEDIATE…COMMIT`（SELECT→UPDATE→DELETE 包裹，同事务）；`config.ts` 默认 `errorMode: "stakeOnly"`；`policies.ts` settle 的 majorError 分支改为恒 `-stake`（忽略 errorMode 值，字段标记 `@deprecated` 保留类型兼容）
- [ ] **Step 4: 全绿 + arena 全套回归**（`test/arena-*.test.ts`——依赖 stakeTimesOdds 的既有断言同步更新为 stakeOnly 语义）
- [ ] **Step 5: Commit**——`fix(arena): errorMode stakeOnly 钉死 + unfreeze 事务包裹（spec §7/M-R4-3）`

---

### Task 2: VoucherPort 类型与 SqliteVoucher

**Files:**
- Create: `extensions/agent-lab/src/economy/voucher-port.ts`
- Test: `extensions/agent-lab/test/economy-voucher.test.ts`

**Interfaces:**
- Consumes: `node:sqlite DatabaseSync`（与 SqliteLedger 共享实例——Task 3 接线）
- Produces（spec §1.4 逐字）:
```ts
export type VoucherKind = "llm" | "time" | "compute";
export type BurnCause = { traceId: string; transitionSeq: number } | { periodic: "memory-storage" };
export type BurnRecord = { kind: VoucherKind; units: number; creditCost: number; cause: BurnCause; ts: number };
export interface VoucherPort {
  buy(agentId: string, kind: VoucherKind, units: number): void;
  balance(agentId: string, kind: VoucherKind): number;
  burn(agentId: string, kind: VoucherKind, units: number, cause: BurnCause): void;
  burnHistory(agentId: string, kind: VoucherKind, filter?: { traceId?: string; sinceTs?: number }): BurnRecord[];
}
export const VOUCHER_PHYSICAL_ANCHOR = { llm: 1_000_000, time: 3600, compute: 1 } as const; // 文档常量
export class SqliteVoucher implements VoucherPort {
  constructor(deps: { db: DatabaseSync; ledger: { debit(id: string, amt: number, reason: string): void; credit(id: string, amt: number, reason: string): void }; rates: { creditPerUnit: Record<VoucherKind, number> }; poolId?: string });
}
```

- [ ] **Step 1: 写失败测试**（6 场景）：①buy 入账+credit 扣款+入池（池 id 默认 "central-pool"）；②buy 单事务原子（ledger.debit 抛错 → 凭证余额不变）；③buy credit 不足 → 抛错且无凭证入账；④burn 扣余额+BurnRecord 落库（FIFO 折算 creditCost）；⑤burn 余额不足 → 抛错；⑥burnHistory filter（traceId 精确过滤 / sinceTs）
- [ ] **Step 2: 确认 FAIL**（模块不存在）
- [ ] **Step 3: 实现**——表 `voucher_balances(agent_id, kind, units)` / `voucher_batches(agent_id, kind, units, credit_per_unit, ts)` / `voucher_burns(agent_id, kind, units, credit_cost, cause_json, ts)`；buy = 单事务（debit → credit 池 → 余额+batch 入账）；burn = 单事务（余额预检 → FIFO 出批次折算 → burn 落库）
- [ ] **Step 4: 全绿 + 回归**
- [ ] **Step 5: Commit**——`feat(economy): VoucherPort + SqliteVoucher（共享 DB/单事务/FIFO 批次/filter）`

---

### Task 3: 中央池（初始化 + poolDebit + RESERVED_IDS）

**Files:**
- Create: `extensions/agent-lab/src/economy/central-pool.ts`
- Modify: `extensions/agent-lab/src/assembly/ledger-port.ts`（open 拒绝 RESERVED_IDS）
- Modify: `extensions/agent-lab/src/assembly/assembler.ts`（步骤 2b 后校验）
- Test: `extensions/agent-lab/test/economy-central-pool.test.ts`

**Interfaces:**
- Consumes: Task 2 `SqliteVoucher`；`SqliteLedger`
- Produces:
```ts
export const RESERVED_IDS: ReadonlySet<string>; // {"central-pool", "calibration-executor"}
export const CENTRAL_POOL_ID = "central-pool";
export function ensureCentralPool(ledger: SqliteLedger): void; // 启动初始化（绕过 LedgerPort.open——直接 ensureRow）
export function poolDebit(ledger: SqliteLedger, amount: number, reason: string): void; // 允许负余额（绕过 debit 夹紧）——仅系统内部
export function poolCredit(ledger: SqliteLedger, amount: number, reason: string): void;
```

- [ ] **Step 1: 写失败测试**（5 场景）：①ensureCentralPool 幂等（重复调用余额不变）；②poolDebit 允许负余额（100 → -50 不抛错）；③普通 debit 仍夹紧（对比）；④LedgerPort.open("central-pool") → 抛错；⑤assembler 装配 agentId="central-pool" → 步骤 2b 后抛错（早于开户）
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现**——central-pool.ts（直接 SQL UPDATE 绕过夹紧）；ledger-port.ts open 前置 RESERVED_IDS 检查；assembler.ts 步骤 2b 后插入校验
- [ ] **Step 4: 全绿 + 装配层回归**（`test/assembly-*.test.ts`）
- [ ] **Step 5: Commit**——`feat(economy): 中央池（初始化/poolDebit 负余额/RESERVED_IDS 双校验）`

---

### Task 4: elo 系统（公式注册表 + repository 列）

**Files:**
- Create: `extensions/agent-lab/src/economy/elo.ts`
- Modify: `extensions/agent-lab/src/core/storage/repository.ts`（eloGlobal/eloByDomain 列迁移——N-I9 模式）
- Modify: `extensions/agent-lab/src/core/contracts.ts`（AgentInstanceRecord 扩展）
- Test: `extensions/agent-lab/test/economy-elo.test.ts`

**Interfaces:**
- Consumes: repository N-I9 迁移模式
- Produces（spec §3 逐字）:
```ts
export type EloUpdateContext = { taskRating: number; outcome: number; weight?: number };
export interface EloFormula { readonly id: string; initial(context: { isOrg: boolean }): number; update(rating: number, ctx: EloUpdateContext): number; }
export interface SelectionFormula { readonly id: string; score(candidate: { stake: number; elo: number }, ctx: { taskRating: number }): number; }
export function taskRatingFromOdds(odds: number): number; // 1500 + 200×(O−1)
export class EloFormulaRegistry { register(f: EloFormula): void; get(id: string): EloFormula; } // 未注册抛错
export class SelectionFormulaRegistry { register(f: SelectionFormula): void; get(id: string): SelectionFormula; }
export const simpleElo: EloFormula;   // id "simple-elo"：initial 1500；update max(100, R + 32×(outcome − 1/(1+10^((taskRating−R)/400))))
export const stakeEloPower: SelectionFormula; // id "stake-elo-power"：stake^1.0 × max(elo/1500, 0.01)^0.5（α/β 构造参数可覆盖）
```

- [ ] **Step 1: 写失败测试**（7 场景）：①taskRatingFromOdds 钉死（O=1→1500 / O=2→1700 / O=4→2100）；②simpleElo.initial=1500；③update 数值钉死（R=1500, taskRating=1500, outcome=1 → 1500+32×(1−0.5)=1516；outcome=0 → 1484）；④FLOOR（R=100, outcome=0, taskRating=2000 → 100 不更低）；⑤stakeEloPower 数值（stake=10, elo=1500 → 10×1^0.5=10；elo=0 → clamp 0.01）；⑥注册表注册/未注册抛错/替换；⑦repository elo 列 round-trip（eloGlobal + eloByDomain JSON map 存取一致；旧库 ALTER 迁移）
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** + repository 迁移（`_applyCoreMigrations` 照 memory_spec/endowment 先例加 `elo_global REAL` / `elo_by_domain TEXT`）
- [ ] **Step 4: 全绿 + repository 回归**
- [ ] **Step 5: Commit**——`feat(economy): elo 系统（公式注册表/simple-elo/selection/repository 列）`

---

### Task 5: 任务类型注册表

**Files:**
- Create: `extensions/agent-lab/src/economy/task-types.ts`
- Modify: `extensions/agent-lab/src/core/storage/repository.ts`（accepts 列）
- Test: `extensions/agent-lab/test/economy-task-types.test.ts`

**Interfaces:**
- Consumes: repository
- Produces（spec §4.1 逐字）:
```ts
export type TaskType = { id: string; description: string; baseDifficulty?: "easy" | "medium" | "hard"; registeredBy: string; createdAt: number };
export interface TaskTypeRegistry { register(t: TaskType): void; get(id: string): TaskType | undefined; list(): TaskType[]; }
export class SqliteTaskTypeRegistry implements TaskTypeRegistry { constructor(db: DatabaseSync); }
```

- [ ] **Step 1: 写失败测试**（4 场景）：①register + get round-trip；②重复 id 幂等 no-op（返回既有，createdAt 不变）；③list 全量；④AgentInstance.accepts 列 round-trip（JSON array）
- [ ] **Step 2-5**: FAIL → 实现（`task_types` 表 + repository accepts 列迁移）→ 全绿 → Commit `feat(economy): 任务类型注册表（开放注册幂等/accepts 列）`

---

### Task 6: flow effect 节点（EffectRegistry + flow_effects 幂等表）

**Files:**
- Create: `src/ptl/flow/effect-registry.ts`
- Modify: `src/ptl/flow/schema.ts`（NodeDef.type 加 "effect"）
- Modify: `src/ptl/flow/engine.ts`（effect 执行 + 幂等检测）
- Modify: `src/ptl/flow/store.ts`（flow_effects 表）
- Test: `src/ptl/flow/effect-node.test.ts`（或既有测试文件追加——以既有结构为准）

**Interfaces:**
- Consumes: 既有 `CodeRegistry` 模式（`src/ptl/flow/code-registry.ts`）/ engine wave 执行
- Produces:
```ts
// effect-registry.ts（import 后缀 .js——PTL 侧约束）
export type EffectFnContext = { state: Record<string, unknown>; runId: string; nodeId: string; idempotencyKey: string; log(msg: string): void };
export type EffectFn = (ctx: EffectFnContext) => Promise<unknown> | unknown;
export class EffectRegistry {
  register(name: string, fn: EffectFn): void;       // 重复注册抛错
  get(name: string): EffectFn;                       // 未注册抛错
  has(name: string): boolean;
}
```
引擎行为：effect 节点执行前查 `flow_effects(flow_run_id, node_id, idempotency_key)`——有记录 → skip（返回 result_summary）；无记录 → 执行 fn → 成功则同事务写幂等记录；fn 抛错 → 节点 failed（可重试，幂等表无记录 → 重试重新执行）。

- [ ] **Step 1: 写失败测试**（6 场景）：①EffectRegistry 注册/get/重复抛错/未注册抛错；②effect 节点正常执行（fn 调用 + state 写入结果）；③**幂等：引擎重跑同节点 → fn 只调用一次**（计数器断言）；④fn 抛错 → 节点 failed + 幂等表无记录 → 重试重新执行；⑤schema 校验：type:"effect" 缺 `effect` 字段（注册名）→ validateFlow 报错；⑥未知 effect 名 → 执行期清晰报错
- [ ] **Step 2-5**: FAIL → 实现 → 全绿 + flow 全套回归（`src/ptl/flow/` 既有测试）→ Commit `feat(flow): effect 节点（EffectRegistry/flow_effects 幂等表/at-least-once 安全）`

---

### Task 7: flow fanout 占位节点（maxFanout 展开 + 候选快照）

**Files:**
- Modify: `src/ptl/flow/schema.ts`（NodeDef.type 加 "fanout" + 专属字段）
- Modify: `src/ptl/flow/engine.ts`（占位展开 + 激活/no-op + 快照 + 失败隔离）
- Test: `src/ptl/flow/fanout-node.test.ts`

**Interfaces:**
- Consumes: engine wave 执行 / checkpoint
- Produces:
```ts
// schema.ts NodeDef 扩展
{ type: "fanout"; id: string; maxFanout?: number /* 默认 32 */; itemsFrom: string /* state 键——候选数组来源 */; body: NodeDef[] /* 子流程模板——单项 item 注入 state 键 `${id}.item` */; out: string /* 结果数组写入的 state 键 */ }
```
引擎行为：**加载时**将 fanout 展开为 maxFanout 个占位分支（静态图）；**首轮执行**从 state[itemsFrom] 取候选数组（≤ maxFanout——超长抛错提示调大 maxFanout 或上游截断）**快照进 checkpoint**；激活前 N 分支（item 注入），其余 no-op（**不产元素**）；分支失败隔离（该分支无产出，流程继续）；resume 用快照候选（不重算 itemsFrom）。

- [ ] **Step 1: 写失败测试**（7 场景）：①3 候选激活 3 分支 + 结果数组长度 3（顺序保持）；②0 候选 → 空数组；③候选 > maxFanout → 清晰抛错；④分支失败隔离（1/3 失败 → 结果 2 元素）；⑤no-op 分支不产元素（结果无 null/占位）；⑥**快照：首轮后篡改 state[itemsFrom] → resume 仍用首轮候选**；⑦maxFanout 默认 32
- [ ] **Step 2-5**: FAIL → 实现 → 全绿 + flow 回归 → Commit `feat(flow): fanout 占位节点（maxFanout 展开/候选快照/失败隔离/no-op 不产元素）`

---

### Task 8: flow subflow 子图节点

**Files:**
- Modify: `src/ptl/flow/schema.ts`（NodeDef.type 加 "subflow"）
- Modify: `src/ptl/flow/engine.ts`（嵌套执行）
- Test: `src/ptl/flow/subflow-node.test.ts`

**Interfaces:**
- Consumes: 引擎 FlowRun 执行
- Produces:
```ts
{ type: "subflow"; id: string; flow: string /* 子 flow 名（registry 解析）或内联 FlowDef */; in?: Record<string, string> /* 父 state 键 → 子 state 键映射 */; out?: Record<string, string> /* 子 state 键 → 父 state 键映射 */ }
```
引擎行为：执行子 flow（新 runId，父 runId 关联）；子 flow 完成 → out 映射写父 state；子 flow 失败 → 节点 failed（父流程按既有失败语义）；子 flow checkpoint 独立（嵌套 resume = 各层独立恢复）。

- [ ] **Step 1: 写失败测试**（5 场景）：①子 flow 执行 + out 映射回父 state；②in 映射注入；③子 flow 失败 → 父节点 failed；④嵌套两层；⑤未知子 flow 名 → validateFlow 报错
- [ ] **Step 2-5**: FAIL → 实现 → 全绿 + 回归 → Commit `feat(flow): subflow 子图节点（嵌套执行/in-out 映射）`

---

### Task 9: 双向托管（escrow 两阶段 + bid 对称冻结）

**Files:**
- Create: `extensions/agent-lab/src/economy/escrow.ts`
- Modify: `extensions/agent-lab/src/arena/ledger.ts`（freeze/unfreeze 已支持——确认按 (agentId, taskId) 复合键）
- Test: `extensions/agent-lab/test/economy-escrow.test.ts`

**Interfaces:**
- Consumes: `SqliteLedger.freeze/unfreeze`（Task 1 事务安全版）；`SqliteVoucher`
- Produces:
```ts
export type EscrowParams = { maxStake: number; odds: number; reviewerCount: number; stakeR: number; oddsR: number; voucherAllowance: number };
export function escrowMax(p: EscrowParams): number;   // maxStake×(O−1) + N×stake_r×(O_r−1) + voucherAllowance
export function escrowActual(p: EscrowParams, stake: number): number; // stake×(O−1) + 其余同上
export function freezeEscrowMax(ledger: SqliteLedger, publisherId: string, taskId: string, p: EscrowParams): void; // 余额不足抛错（发布拒绝）
export function adjustEscrow(ledger: SqliteLedger, publisherId: string, taskId: string, p: EscrowParams, actualStake: number): void; // 解冻差额
export function freezeBid(ledger: SqliteLedger, bidderId: string, taskId: string, stake: number, odds: number): void; // 冻结 stake×(O−1)——余额不足抛错（bid 拒绝）
export function releaseBid(ledger: SqliteLedger, bidderId: string, taskId: string): void; // 未中标解冻
```

- [ ] **Step 1: 写失败测试**（7 场景）：①escrowMax/escrowActual 数值钉死（maxStake=20,O=3,N=5,stakeR=10,O_r=2,voucherAllowance=6 → 40+50+6=96；actual stake=15 → 30+50+6=86）；②freezeEscrowMax 余额不足抛错；③adjustEscrow 解冻差额（96→86 解冻 10）；④freezeBid 冻结 stake×(O−1)（15×2=30）；⑤freezeBid 余额不足抛错；⑥releaseBid 解冻；⑦escrow_max ≥ escrow_actual 恒成立（stake ≤ maxStake 前提；stake > maxStake 抛错——clamp 语义由 D2 市场层执行，此处抛错）
- [ ] **Step 2-5**: FAIL → 实现 → 全绿 + arena/assembly 回归 → Commit `feat(economy): 双向托管（escrow 两阶段/bid 对称冻结/数值钉死）`

---

## Self-Review 记录

- **Spec 覆盖**：§1.4 VoucherPort → T2；§2 中央池/RESERVED_IDS → T3；§3 elo → T4；§4.1 任务类型 → T5；§5.2 effect → T6；§5.2 fanout → T7；§5.2 subflow → T8；§4.3/§4.4 托管 → T9；§7 errorMode/unfreeze 迁移 → T1。D2 覆盖：§5.1 市场图/§5.3 嵌套/§6 组织/§7 结算节点/§7a 多评/§8 观测/§9 沉淀/§10 接线包。
- **Placeholder 扫描**：全部任务含真实接口代码与测试场景枚举；T5/T6/T7/T8/T9 的 Step 2-5 压缩写法与 T1-T4 展开写法语义等价（步骤内容已在 Step 1 场景枚举+接口块中完整给出）。
- **类型一致性**：VoucherKind/BurnCause/BurnRecord（T2）→ T9 引用一致；RESERVED_IDS（T3）→ D2 校准任务引用；EloFormula/SelectionFormula id 语义名（T4）→ D2 select/consensus 节点消费；EscrowParams（T9）→ D2 persist_task/adjust_escrow effect 消费；EffectRegistry/fanout/subflow schema（T6-T8）→ D2 市场 flow.json 定义消费。
