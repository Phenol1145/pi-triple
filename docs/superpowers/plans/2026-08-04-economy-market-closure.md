---
type: plan
task: 经济层 D2：市场闭环（市场 workflow 节点 + 多评共识 + 校准 + 组织 + 观测 + 沉淀 + C 接线包 + 集成 bench）
branch: feat/economy-market-closure
worktree: ~/pi-platform（主仓库直接分支）
pr: "feat(economy): 市场闭环 D2（市场 workflow/多评共识/组织/观测/沉淀/接线包/bench）"
---

# 经济层 D2：市场闭环

## Context

spec `docs/superpowers/specs/2026-08-03-economy-layer-design.md`（5 轮评审收敛定稿）+ D1 基础设施已合并 main（VoucherPort/中央池/elo/任务类型/escrow/effect/fanout/subflow 全部就绪）。D2 把基础设施装配成**可运转的市场**：§5.1 市场 flow 图的所有节点 fns、§7/§7a 结算与多评共识、§6 组织垫付、§8 观测、§9 记忆沉淀、C 接线包 10 项、§12 集成 bench。

**关键架构决策**（spec §5.1/Q2-A）：市场 = flow 图。D1 已交付 effect/fanout/subflow 节点类型 + EffectRegistry/CodeRegistry；D2 在 agent-lab `src/economy/` 注册市场 fns，`market-runner.ts` 内嵌市场 FlowDef 并调用 ptl-flow 引擎执行。竞价/评审 fanout 的 body = agent 节点（bidding/review workloop——v1 走 spawnAgent；bench 用 mock 策略函数，真实 LLM 冒烟为手动 runbook 非 CI）。

**D2 rulings 8 项**（D1 ledger 移交——Task 1 落地）：effect 契约 / poolDebit 硬化 / credits 表耦合约定 / unfreeze 故障注入 / freeze 幂等语义 / 运行时解释接受 / Ledger 公共面 / spec 措辞修正。

## Global Constraints（全任务适用——每个 implementer prompt 重述）

- 零新增依赖；**agent-lab import 后缀 `.ts` / PTL（src/）后缀 `.js`**；node:test（agent-lab）/ vitest（PTL）；tmp+rename 原子写；测试文件落 `extensions/agent-lab/test/`（node:test）或 `test/unit/`（vitest）
- **TDD**：先写失败测试 → 最小实现 → 重构；每个 commit 前全绿
- 只修改/创建任务 Files 清单内文件（清单外需求 → stop-and-ask）
- 测试写入 `/tmp/economy-*` 隔离目录（不复用默认 `~/.pi-triple/data`）
- 数值钉死（spec 已定）：elo 1500/100/32/taskRating=1500+200(O−1)/N=5/N_min=3/O_r≥2/stake_cal=0/calibrationRate=10%/补偿=燃烧 capped voucherAllowance
- 每个任务产出报告写 `.superpowers/sdd/2026-08-04-economy-market-closure/task-N-report.md`
- 既有基线：2 pre-existing failures（weighted-scorer-bootstrap）——不背锅
- **D1 effect 契约（ruling 1——所有 effect fn 必须遵守）**：fn 内部按业务键幂等 + args 只含稳定业务键字段（fn 内部可自行重算幂等 key）

## Work Streams

### Stream 1：市场 fns 层（Tasks 2-5）
spec §5.1 图节点的 code/effect 注册 + §7/§7a 结算共识。

### Stream 2：经济主体扩展（Tasks 6-7）
校准任务（§7a.7）+ 组织垫付（§6）。

### Stream 3：观测与沉淀（Tasks 8-9）
事件流投影（§8）+ 四类经验沉淀（§9）。

### Stream 4：接线与集成（Tasks 10-11）
C 接线包 10 项 + 市场 runner + 端到端 bench。

## Integration Strategy

- 分支 `feat/economy-market-closure`（从 main 切出）
- 11 个任务**严格顺序执行**（T2-T5 同模块渐进——市场 fns 逐层构建；T6-T9 依赖 fns 完成）
- 每个任务完成后审查（sdd.sdd-reviewer），全部完成后 whole-branch 最终审查（sdd.design-adversary）→ 合并
- spec 歧义 → 协调者裁决（落进度 ledger）→ 继续

## Tasks

### Task 1: D2 rulings 落地（清障——8 项移交项）

spec §7 errorMode 段/D1 ledger。8 项 rulings 的代码落地与文档化。

**Files:**
- Modify: `extensions/agent-lab/src/arena/ledger.ts`
- Modify: `extensions/agent-lab/src/economy/voucher-port.ts`
- Modify: `extensions/agent-lab/src/economy/central-pool.ts`
- Modify: `extensions/agent-lab/src/arena/types.ts`
- Modify: `docs/superpowers/specs/2026-08-03-economy-layer-design.md`（§5.2.1 措辞修正）
- Test: `extensions/agent-lab/test/arena-ledger.test.ts`

**Step 1: 写失败测试**

`test/arena-ledger.test.ts`（追加）：
1. `debitUnclamped`：poolDebit 内部改用显式 `debitUnclamped(agentId, amount, note)`（允许负余额——Ledger 接口新方法）；credit(负数) 路径废弃
2. `adjustFreeze` 提升进 `Ledger` 接口（types.ts——具体类型依赖消除）
3. unfreeze 故障注入：mock db 在 BEGIN IMMEDIATE 后抛错 → ROLLBACK → 冻结行原样（余额/frozen 不变）
4. `debitUnclamped` 正余额扣减正常；非池 agent 调用也可用（通用 API——不限制调用者）

**Step 2: 最小实现**

1. `Ledger` 接口（types.ts）：新增 `debitUnclamped(agentId, amount, note)` + `adjustFreeze(taskId, agentId, amount)` 声明
2. `SqliteLedger`：实现 `debitUnclamped`（无余额下限校验——单事务）；`poolDebit` 内部从 `credit(负数)` 改调 `debitUnclamped`（行为等价，语义显式）
3. unfreeze 故障注入测试配套：`SqliteLedger` 构造器已支持 db 注入——测试用代理 db 模拟失败
4. `voucher-port.ts` 注释：直读 credits 表耦合约定文档化（"注入的 ledger 必须是共享 db 的 SqliteLedger"——D1 已有，补 JSDoc 引用 ruling）
5. **spec §5.2.1 措辞修正**："编译期展开 maxFanout 占位分支（静态图假设不变）"→"运行时逐项激活（图保持静态 + 首轮候选快照 resume）——D1 实证裁决"；§5.1 图标注 `execute`/`review` body = agent 节点（spawnAgent v1）
6. effect 契约 JSDoc：`src/ptl/flow/effect-registry.ts` 顶部注释钉死契约（fn 按业务键幂等 + args 稳定业务键——D2 市场 effect fns 的编写规范）

**Step 3: 运行验证**

```bash
cd extensions/agent-lab && node --experimental-strip-types --test test/arena-ledger.test.ts test/economy-central-pool.test.ts test/economy-voucher.test.ts
```

**Step 4: Commit**

```bash
git add extensions/agent-lab/src/arena/ledger.ts extensions/agent-lab/src/arena/types.ts extensions/agent-lab/src/economy/voucher-port.ts extensions/agent-lab/src/economy/central-pool.ts extensions/agent-lab/test/arena-ledger.test.ts docs/superpowers/specs/2026-08-03-economy-layer-design.md src/ptl/flow/effect-registry.ts && git commit -m "feat(economy): D2 rulings 落地（debitUnclamped/adjustFreeze 接口化/unfreeze 故障注入/spec 措辞修正）"
```

---

### Task 2: 市场 code fns 前半（announce/shortlist/select——spec §5.1 前三节点）

**Files:**
- Create: `extensions/agent-lab/src/economy/market-fns.ts`
- Create: `extensions/agent-lab/src/economy/market-store.ts`
- Test: `extensions/agent-lab/test/market-fns.test.ts`

**Interfaces（钉死——后续任务按此对接）：**

```ts
// market-store.ts —— 市场任务持久化（D1 market_tasks 表扩展复用）
export interface MarketTask {
  taskId: string; typeId: string; publisherId: string;
  maxStake: number; odds: number; reviewerCount: number; stakeR: number; oddsR: number;
  voucherAllowance: number; brief: string; status: "open" | "awarded" | "executing" | "reviewing" | "settled" | "failed";
  winnerId?: string; winnerStake?: number; createdAt: number; settledAt?: number;
  groundTruth?: string; isCalibration?: boolean;
}
export class MarketStore {
  constructor(db: DatabaseSync);
  createTask(t: MarketTask): void;          // INSERT（幂等：同 taskId 已存在 → 跳过返回 false）
  updateTask(taskId: string, patch: Partial<MarketTask>): void;
  getTask(taskId: string): MarketTask | undefined;
  recordBid(taskId: string, bidderId: string, stake: number): void;  // market_bids 表
  getBids(taskId: string): Array<{ bidderId: string; stake: number }>;
}
```

```ts
// market-fns.ts —— 注册到 CodeRegistry 的市场 code fns（纯函数，输入 state 输出值）
export interface MarketFnsDeps {
  store: MarketStore; ledger: Ledger; voucher: VoucherPort;
  elo: EloFormulaRegistry; selection: SelectionFormulaRegistry;
  taskTypes: TaskTypeRegistry; calibrationRate: number; rng?: () => number;  // rng 注入可测
}
export function registerMarketCodeFns(registry: CodeRegistry, deps: MarketFnsDeps): void;
// 注册键：market.announce / market.shortlist / market.select
// announce: state{taskSpec} → {taskId, isCalibration}（calibrationRate 概率替换为校准任务——rng 注入）
// shortlist: state{candidates: agentId[]} → {shortlist: agentId[]}（承接过滤 accepts + elo_domain 降序取前 maxFanout）
// select: state{shortlist, bids: {agentId,stake}[]} → {winnerId, winnerStake}（SelectionFormula 默认 stake-elo-power；同分字典序）
```

**Step 1: 写失败测试**

1. announce：常规任务（rng=0.99 不触发校准）→ 新 taskId + status open + isCalibration false
2. announce：校准触发（rng=0.05 < 0.10）→ 从校准任务池取（groundTruth 带）+ isCalibration true
3. shortlist：5 候选 3 承接（accepts 类型过滤）→ elo 降序取前 N（maxFanout=2 截断）
4. shortlist：elo_byDomain 有域分用域分，无回退 global
5. select：stake-elo-power 公式（stake 高者胜；同 stake elo 高者胜；全同分 agentId 字典序）
6. 未注册类型 announce → 抛错（I5 市场拒收）

**Step 2: 最小实现** → Step 3 运行 → **Step 4: Commit**（`feat(economy): 市场 code fns 前半（announce/shortlist/select + MarketStore）`）

---

### Task 3: 市场 code fns 后半（consensus/settle——§7/§7a 纯计算核心）

**Files:**
- Modify: `extensions/agent-lab/src/economy/market-fns.ts`
- Create: `extensions/agent-lab/src/economy/settlement.ts`
- Test: `extensions/agent-lab/test/market-settlement.test.ts`

**Interfaces：**

```ts
// settlement.ts —— 纯计算（无副作用——D1 effect/code 拆分原则的 code 侧）
export interface ReviewInput { reviewerId: string; score: number }  // r_i ∈ [0,1]
export interface SettlementPlan {
  R: number; accuracies: Map<string, number>;        // R=median, a_i=1−|r_i−R|
  executorSettle: number; executorEloDelta: { global: number; domain: number };
  reviewerSettles: Map<string, number>;              // settle_i = stake_r×(O_r−1)×(2a_i−1)
  reviewerEloDeltas: Map<string, { global: number; domain: number }>;
  taxTotal: number;                                   // max(0,settle)×rate + Σmax(0,settle_i)×rate
  negativeFlow: { from: string; to: "publisher" | "central-pool"; amount: number } | null;
  majorError: boolean;
}
export function computeConsensus(reviews: ReviewInput[]): { R: number; accuracies: Map<string, number> };
export function planSettlement(args: {
  task: MarketTask; winnerId: string; winnerStake: number; reviews: ReviewInput[];
  majorError?: boolean; groundTruthScore?: number;   // 校准任务：c 与 a_i 按 ground truth
  eloFn: EloFormula; taxRate: number; executorElo: { global: number; byDomain: number };
  reviewerElos: Map<string, { global: number; byDomain: number }>; taskRating: number;
}): SettlementPlan;
// 注册键：market.consensus / market.settle（code fns 薄壳调 settlement.ts 纯函数）
```

**Step 1: 写失败测试**（数值钉死）

1. consensus：r=[0.2,0.5,0.7,0.8,0.9] → R=0.7（median）；a=[0.5,0.8,1.0,0.9,0.8]
2. consensus：偶数 → 上中位数（[0.2,0.5,0.7,0.8] → R=0.7）
3. settle 正常：stake=15,O=3,c=0.7 → 15×2×0.4=12；elo 新值（taskRating=1900，得分=0.7）
4. majorError → settle=−stake（−15，显式分支不代入公式）+ negativeFlow 直付 publisher
5. 评审者结算：stake_r=10,O_r=2,a=0.8 → 10×1×0.6=6；a<0.5 → 负 settle → negativeFlow 入 central-pool（评审者负流不对称——C-R4-1）
6. 对称课税：settle=12 + settle_i=6,−2 → tax=(12+6)×0.05=0.9（负的不课）
7. 校准任务：groundTruthScore=0.9 → c=0.9（非 R）；a_i=1−|r_i−0.9|（非共识偏差）
8. odds=1 退化：settle=0

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 结算纯计算（consensus median/settle/评审者结算/课税/校准评定）`）

---

### Task 4: 市场 effect fns（persist_task/adjust_escrow/apply_settlement——副作用原子层 + 事件发射）

**Files:**
- Create: `extensions/agent-lab/src/economy/market-effects.ts`
- Create: `extensions/agent-lab/src/economy/economy-events.ts`
- Modify: `extensions/agent-lab/src/economy/market-fns.ts`（注册点合并）
- Test: `extensions/agent-lab/test/market-effects.test.ts`

**Interfaces：**

```ts
// economy-events.ts —— 经济事件流（§8 全量事件的发射点）
export type EconomyEventKind =
  | "currency.mint" | "currency.burn" | "currency.buy_voucher" | "currency.transfer" | "currency.tax"
  | "economy.org_default" | "economy.elo_update" | "economy.review_consensus"
  | "economy.escrow_freeze" | "economy.escrow_adjust" | "economy.escrow_release"
  | "economy.bid_freeze" | "economy.bid_release" | "economy.settle";
export interface EconomyEvent { kind: EconomyEventKind; ts: number; data: Record<string, unknown>; isCalibration?: boolean }
export class EconomyEventBus {  // 内存队列 + 可选持久化（economy_events 表——投影重建基源）
  constructor(db?: DatabaseSync);
  emit(e: Omit<EconomyEvent, "ts">): void;
  drain(): EconomyEvent[];  // 测试/投影消费
}
```

```ts
// market-effects.ts —— 注册到 EffectRegistry（fn 遵守 D2 effect 契约：args 只含稳定业务键）
// 注册键：market.persist_task / market.adjust_escrow / market.apply_settlement
// persist_task(taskSpec, publisherId): 任务落库 + freezeEscrowMax + emit escrow_freeze——幂等 taskId（重试 skip）
// adjust_escrow(taskId, winnerStake, bids[]): adjustEscrow + 未中标 releaseBid×n + emit——幂等 taskId
// apply_settlement(taskId, plan: SettlementPlan): escrow 划付/负 settle 直付/税入池/elo 双写/燃烧/事件——
//   内部整体单事务（共享 DatabaseSync）；幂等 taskId；apply 后 task status=settled
```

**Step 1: 写失败测试**

1. persist_task：正常 → 任务落库 + escrow_max 冻结 + 事件；重试（同 taskId）→ skip（不重复冻结）
2. persist_task：余额不足 → 抛错（发布拒绝——任务不落库，事务回滚）
3. adjust_escrow：96→86 解冻 10 + 2 未中标者 bid 解冻 + 3 事件；重试 skip
4. apply_settlement：数值钉死 plan（Task 3 场景3）→ winner credit +12−税 / publisher escrow 划付 / 税入池 / elo 双写（global+domain）/ 事件全量
5. apply_settlement：负 settle → 执行者冻结直付 publisher（不经 escrow）
6. apply_settlement：评审者负 settle → 入池
7. apply_settlement：单事务原子——mock 中途失败 → 全部回滚（余额/elo/任务状态原样）
8. 事件 isCalibration 标记透传

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 市场 effect fns（发布/调减/结算划付——单事务原子 + 事件流）`）

---

### Task 5: 多评评审轮（review fanout 集成 + 互斥 + 流标阶梯——§7a.1/2/8）

**Files:**
- Modify: `extensions/agent-lab/src/economy/market-fns.ts`
- Create: `extensions/agent-lab/src/economy/review-round.ts`
- Test: `extensions/agent-lab/test/review-round.test.ts`

**Interfaces：**

```ts
// review-round.ts —— 评审轮编排（市场图的 review 段逻辑）
export interface ReviewRoundDeps {
  store: MarketStore; ledger: Ledger; orgMembers: OrgMembership;  // Task 6 前 = 空实现接口
  reviewerCount: number; minReviewers: number;  // N=5, N_min=3
}
export function selectReviewers(deps: ReviewRoundDeps, task: MarketTask, executorId: string, pool: string[]): string[];
// 互斥过滤（执行者本人 + 同组织成员——Task 6 前 orgMembers 返回空集）→ 评审 elo 降序取前 N（纯 elo 序——stake_r 常数）
export interface ReviewRoundResult {
  activated: ReviewInput[];       // 实际收到 r_i 的评审
  shortfall: boolean;             // activated.length < N_min
  refundedReviewers: string[];    // 流标时已接单少数评审者（stake_r 退还 + 凭证成本补偿 capped voucherAllowance）
}
// 流标阶梯：activated < N_min → 重试 2 次（escrow 保持）→ 仍流标 → operator 兜底（单评审 R=operator 评价）
// 注册键：market.review_shortlist（code）/ market.review_refund（effect——流标少数评审者保护，幂等 taskId+round）
```

**Step 1: 写失败测试**

1. 评审者选择：10 候选 → 互斥过滤（执行者+同组织 2 人排除）→ elo 降序前 5
2. 评审者 bid 冻结：stake_r×(O_r−1)=10×1=10/人（对称托管）
3. 流标：激活 2 < 3 → shortfall + 重试计数 + 已接单 2 人退还 stake_r + 凭证成本补偿
4. 重试 2 次仍流标 → operator 兜底标记（R=operator 评价，单评审）
5. review_refund 幂等（同 taskId+round 重试 skip）
6. 评审者负 settle 流向（与 Task 3 plan 对接）：入池非 publisher

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 多评评审轮（互斥/纯 elo 选择/流标阶梯/少数评审者保护）`）

---

### Task 6: 校准任务（§7a.7——合成执行者 + ground truth 锚定）

**Files:**
- Create: `extensions/agent-lab/src/economy/calibration.ts`
- Modify: `extensions/agent-lab/src/economy/market-fns.ts`（announce 注入点对接）
- Test: `extensions/agent-lab/test/calibration.test.ts`

**Interfaces：**

```ts
// calibration.ts —— 校准任务池与合成执行者
export interface CalibrationTask { taskId: string; brief: string; groundTruthArtifact: string; groundTruthScore: number }
export class CalibrationPool {  // operator 注入的预制校准任务集
  add(t: CalibrationTask): void;
  draw(rng: () => number): CalibrationTask | undefined;  // announce 校准分支取任务
}
export function calibrationExecutorRun(task: CalibrationTask): { output: string };  // 短路产出预制交付物（无 LLM/不耗凭证）
// 钉死（spec M-R5）：stake_cal=0（escrow 项池内自抵省略）；settle 直接入池；O_r=2；
//   execute 节点对 calibration-executor 短路（不 spawnAgent）；校准事件带 isCalibration:true
// ground truth 评定：执行者 c = groundTruthScore；评审者 a_i = 1−|r_i − groundTruthScore|
```

**Step 1: 写失败测试**

1. announce 校准分支：rng 触发 → CalibrationPool.draw → 任务带 groundTruth + isCalibration
2. 合成执行者：短路产出预制交付物（凭证燃烧=0——burnHistory 空）
3. ground truth 评定对接 Task 3 planSettlement（groundTruthScore 路径——c/a_i 均按 ground truth）
4. stake_cal=0：escrow 公式校准任务实际冻结 = 评审项 + voucherAllowance（无执行者 stake 项）
5. 校准 settle 入池（operator 无利可图——池流水审计可见）
6. 事件 isCalibration:true 全链路透传（announce→settle 事件）

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 校准任务（合成执行者/ground truth 评定/池内自抵）`）

---

### Task 7: 组织（§6——org_members/垫付制/违约链）

**Files:**
- Create: `extensions/agent-lab/src/economy/org.ts`
- Test: `extensions/agent-lab/test/org.test.ts`

**Interfaces：**

```ts
// org.ts —— 组织 = AgentInstance + 成员表 + 垫付传导
export interface OrgMembership {
  membersOf(orgId: string): string[];      // org_members 表查询
  orgOf(agentId: string): string | undefined;
  addMember(orgId: string, agentId: string): void;
  removeMember(orgId: string, agentId: string): void;
}
export class SqliteOrgMembership implements OrgMembership { constructor(db: DatabaseSync); }
export interface PayoutPlan {  // 垫付计算（纯函数）
  memberSettles: Map<string, number>; voucherCosts: Map<string, number>;  // burnHistory(member, kind, {traceId}) FIFO 折算
  payouts: Map<string, number>;        // 凭证成本优先，再付收益
  partial: boolean;                    // 余额只够部分 → 先本后息
}
export function planPayouts(args: {
  orgBalance: number; memberSettles: Map<string, number>; voucherCosts: Map<string, number>;
}): PayoutPlan;
// 垫付执行（effect——幂等 taskId）：payouts 划付 → 余额不足全垫付 → 违约事件 economy.org_default
//   （成员 stake 退还 + 组织 elo 按 majorError + 审计）
// 组织利润 = settle_org − Σpayouts − 税（允许为负——观测项）
// 双重冻结文档化（spec §5.3 M-1）：组织对外 bid 冻结 + 内部 escrow_max——注释+装配指引
```

**Step 1: 写失败测试**

1. 垫付成功：3 成员 settle+cost → payouts=成本+收益 → 余额扣减正确
2. 凭证成本优先：余额只够成本 → 成本全付 + 收益部分付（partial=true，先本后息）
3. 垫付失败：余额为零 → org_default 事件 + 成员 stake 退还 + 组织 elo majorError（−stake 结算语义）
4. burnHistory traceId 精确取本次燃烧（多任务燃烧不混淆）
5. 评审互斥对接：selectReviewers（Task 5 空实现 → SqliteOrgMembership 真实过滤）
6. 嵌套市场：组织对外中标 → 内部市场 subflow（成员候选）→ 子结算回传（对接 D1 subflow）

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 组织垫付制（org_members/payouts 先本后息/违约链）`）

---

### Task 8: 观测投影（§8——只读报表）

**Files:**
- Create: `extensions/agent-lab/src/economy/projections.ts`
- Test: `extensions/agent-lab/test/projections.test.ts`

**Interfaces：**

```ts
// projections.ts —— 事件流只读投影（context-projector 模式——不修改任何状态）
export interface EconomyReport {
  minted: number; burned: number; poolBalance: number;           // 发行量/池
  voucherStock: Record<VoucherKind, number>; burnRate: Record<VoucherKind, number>;  // 凭证存量/燃烧速率
  creditVelocity: number;                                        // 流速（窗口内转账量/时间）
  physicalCreditReconciliation: { kind: VoucherKind; physicalUnits: number; creditValue: number }[];  // 双层对账=价格信号
  eloDistribution: { buckets: { range: string; count: number }[] };
  reviewerAccuracy: { reviewerId: string; avgAccuracy: number; n: number }[];  // 评审准确性分布
  calibrationBias: { reviewerId: string; bias: number }[];       // 校准偏差榜（isCalibration 事件）
}
export function projectEconomy(events: EconomyEvent[], windowMs?: number): EconomyReport;
```

**Step 1: 写失败测试**

1. 投影重建一致性：重放事件流 → 报表字段与账本实际状态一致（发行量=Σmint−Σburn）
2. 双层对账：buy/burn 事件 → 物理量与 credit 价值对账（价格信号=两者比率）
3. elo 分布分桶（[100,500),[500,1000),... 计数）
4. 评审准确性：review_consensus 事件 → avgAccuracy per reviewer
5. 校准偏差榜：isCalibration 事件 → 评审者 ground truth 偏差排序
6. 只读性：投影不触碰 ledger/voucher（只消费事件数组——纯函数）

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 货币循环观测投影（发行量/对账/elo 分布/评审准确性/校准偏差榜）`）

---

### Task 9: 记忆沉淀（§9——四类经验 → 沉淀管道）

**Files:**
- Create: `extensions/agent-lab/src/economy/experience.ts`
- Test: `extensions/agent-lab/test/experience.test.ts`

**Interfaces：**

```ts
// experience.ts —— 结算事件驱动记忆沉淀（对接记忆系统沉淀管道）
export type SettlementExperience =
  | { kind: "execution"; agentId: string; scene: string; action: "execute"; outcome: number; reward: number }        // c=R, 税后 settle
  | { kind: "bidding"; agentId: string; scene: string; action: `bid:${number}`; outcome: "won" | "lost"; meta: { winnerId: string; winnerStake: number } }
  | { kind: "review"; agentId: string; scene: string; action: `review:${number}`; outcome: number; accuracy: number; reward: number; evaluationMode: "consensus" | "ground-truth" }  // 校准写 ground truth + mode 标记（M-R5-6）
  | { kind: "org_default"; agentId: string; scene: string; orgId: string };                                        // 成员视角组织违约
export function experiencesFromSettlement(plan: SettlementPlan, task: MarketTask, bids: { bidderId: string; stake: number }[]): SettlementExperience[];
// 纯函数：settle plan → 四类经验（含未中标竞价经验——全体 bidder）
// 沉淀对接：experience → 记忆域 MemoryHost 沉淀管道入口（L3 语义记忆规则化 → 发轫 → 审核链 → write-back——
//   v1 接线 = 写 memory_host.experiences 表/调沉淀 API，规则化闭环由记忆系统既有管道消费）
```

**Step 1: 写失败测试**

1. 执行经验：c=0.7/settle 税后 → execution 经验字段正确
2. 竞价经验：3 bidder 1 winner → 3 条（won×1 + lost×2，meta 含 winnerId/winnerStake）
3. 评审经验：5 评审 → 5 条（accuracy/reward；校准任务 → evaluationMode="ground-truth" + outcome=groundTruthScore）
4. 组织违约经验：org_default 事件 → 成员视角经验（orgId 关联）
5. 沉淀入口：经验写入记忆域（mock MemoryHost——验证调用形状）

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 结算经验沉淀（四类经验/校准 mode 标记/沉淀管道入口）`）

---

### Task 10: C 接线包 10 项（装配层遗留钩子）

**Files:**
- Modify: `extensions/agent-lab/src/assembly/assembler.ts`
- Modify: `extensions/agent-lab/src/assembly/agent-runtime.ts`
- Modify: `extensions/agent-lab/src/assembly/ledger-port.ts`
- Modify: `extensions/agent-lab/src/assembly/memory-host.ts`（或 dsp 相关文件——按装配层实际文件）
- Test: `extensions/agent-lab/test/assembly-wiring.test.ts`

**Step 1: 逐项写失败测试**（10 项各一）：
1. attachSdk：runner sdkExtensions 真实钩子注册（mock sdk——验证调用）
2. seqProvider 注入：装配时传入 → 消息 seq 连续
3. onCheckpoint→dsp.snapshot 注册：checkpoint 事件触发 snapshot
4. inbox drainInto 拼接 task 前缀：drain 消息带 "task:" 前缀
5. delivery=auto 覆写：装配配置 → delivery 语义生效
6. IdentityMap 装配注册+刷新回调：新 agent 装配 → IdentityMap 更新
7. DSP 两段拼接：domain primer + context 两段顺序正确
8. AssembleOptions 可选 agentId：指定 agentId 装配（非派生）
9. removeAccount 提进 LedgerPort：接口方法存在且删账（credits 行移除）
10. startSweeper unref：sweeper 定时器不阻进程退出（process._getActiveHandles 断言或 mock unref）

**Step 2: 最小实现**（逐项——装配层既有代码的钩子接线，每项预期 <30 行）→ **Step 4: Commit**（`feat(assembly): C 接线包 10 项落地（钩子/seq/snapshot/inbox/delivery/IdentityMap/DSP/agentId/removeAccount/unref）`）

---

### Task 11: 市场 runner + 集成 bench（§5.1 全图 + §12 端到端）

**Files:**
- Create: `extensions/agent-lab/src/economy/market-runner.ts`
- Test: `extensions/agent-lab/test/market-integration.test.ts`

**Interfaces：**

```ts
// market-runner.ts —— 市场闭环运行器（注册全部 fns + 内嵌市场 FlowDef + 调 ptl-flow 引擎）
export interface MarketRunnerDeps extends MarketFnsDeps {
  effects: EffectRegistry; codes: CodeRegistry; events: EconomyEventBus;
  orgMembers: OrgMembership; calibration: CalibrationPool;
  spawnBidder?: (agentId: string, brief: string) => Promise<{ stake: number }>;   // v1 mock 策略/生产 spawnAgent
  spawnReviewer?: (reviewerId: string, deliverable: string) => Promise<{ score: number }>;
}
export class MarketRunner {
  constructor(deps: MarketRunnerDeps);
  async runMarket(taskSpec: { typeId: string; publisherId: string; maxStake: number; odds: number; brief: string }): Promise<{ taskId: string; status: string }>;
  // 内部：注册 fns → 构建市场 FlowDef（§5.1 图——announce/persist_task/shortlist/collect_bids(fanout)/select/
  //   adjust_escrow/execute/review(fanout)/consensus/settle/apply_settlement）→ makeRunFlowV2 执行
}
```

**Step 1: 写失败测试**（端到端——§12 集成要求）

1. **完整市场闭环**：发布方 endowment 100 → 发布任务（escrow 96）→ 5 候选竞价（mock 策略 stake）→ 选择 → 调减 → 执行（mock 交付）→ 5 评审（mock 评分）→ 共识 → 结算 → 验证：winner credit 增加（settle 税后）/publisher 减少/pool 收税/elo 更新/事件全量/经验沉淀 4 类
2. **生存性冒烟**：100 credit 起步 agent → 完成首次全流程（bid 30 冻结 → 中标 → 结算正收益 → 余额 > 100——生存闭环成立）
3. **多轮市场**：同 runner 跑 3 任务 → elo 分化（高完成度 agent elo 上升→后续优先入围——市场学习信号）
4. **负 settle 轮**：mock 执行者 majorError → −stake 直付 publisher + elo 下降
5. **流标轮**：mock 评审者激活 2/5 → 重试 → operator 兜底
6. **校准轮**：calibrationRate=1.0 强制校准 → ground truth 评定 + isCalibration 事件
7. resume：市场流程中途重启 → checkpoint 恢复（fanout 快照/effect 幂等——D1 机制端到端验证）

**Step 2: 最小实现** → **Step 4: Commit**（`feat(economy): 市场 runner + 端到端集成 bench（货币循环/生存性冒烟/elo 学习/负 settle/流标/校准/resume）`）

---

## Self-Review

- Spec coverage：§5.1 ✓(T2-T5+T11) §5.3 ✓(T7.6) §6 ✓(T7) §7 ✓(T3-T4) §7a ✓(T3/T5/T6) §8 ✓(T4 事件+T8 投影) §9 ✓(T9) §10 ✓(T10) §12 ✓(T11)
- Type consistency：MarketTask/SettlementPlan/EconomyEvent 贯穿 T2-T9-T11 一致
- 测试真实性：全部场景化断言（数值钉死/余额/elo/事件序列）——无存在性测试
- Placeholder 扫描：无
- D1 rulings 8 项：T1 全覆盖 ✓
- 遗留风险：竞价/评审 workloop v1 = mock 策略（真实 LLM 冒烟手动 runbook——记入 T11 报告）；elo 域爆炸/合谋残余（spec §13 文档化接受）
