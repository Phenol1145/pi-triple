# 经济层（Economy Layer）设计 Spec

**日期**：2026-08-03
**状态**：设计修订（Round 2 对抗性评审裁决已落地：C5-C7 修复 + I6-I14 + M4-M6 + OQ5-OQ8；多评共识改中位数 + 发布托管制）
**父文档**：`docs/superpowers/2026-08-03-market-economy-overview.md`
**依赖**：子项目 A（pit-flow 运行时扩展，已合并）、B（记忆系统，已合并）、C（装配层，已合并）、arena 遗留
**范围**：完整经济语义（Q1-B）

---

## 0 设计语义（一句话）

**市场经济闭环跑通**：任务类型开放注册（行业自我生长）→ **发布托管**（escrow 冻结 = 需求侧资金承诺）→ 市场即 workflow → f(stake, elo_domain) 选择 → **多评共识评审（中位数 + 校准任务锚定）** → 组织垫付制传导 → credit 流通 + 凭证配给 + 中央池货币循环 → 结算事件驱动记忆沉淀与 elo 演化。

---

## 1 货币体系

### 1.1 两层结构

```
物理资源（token / 墙钟秒 / GB·天存储）
    ↑ 固定兑换比（凭证定义，不可调）
凭证（llm / time / compute）
    ↑ 浮动汇率（静态基准 × optimizer 修正系数）
credit（唯一流通货币）
```

- **credit**：唯一流通货币。LedgerPort（SqliteLedger）承载。
- **凭证**：`llm 1 unit = 1M tokens`（in+out blended——**已知简化**（I5）：混合精度模型存在结构性套利空间，v1 接受文档化）；`time 1 unit = 3600s`；`compute 1 unit = 1 GB·天`（记忆存储并入）。只能以 credit 向中央购买（单向；不可卖回/互兑/转让）。
- **凭证耗尽 = 单节点失败**（OQ4——非全 flow 熔断）。
- 汇率调整：已消耗不变 / 持仓物理量不变（计价浮动）/ 新购按新价。

### 1.2 汇率与初始配置（C4/OQ1/OQ2 裁决）

- **默认零配置可启动**：`DEFAULT_EXCHANGE_RATES = { llm: 10, time: 5, compute: 2 }`；`DEFAULT_ENDOWMENT = 100`（flat——**废弃 K/price**（新体系无模型定价概念；旧公式保留为可选注册实现））。
- **分工**：基准 = operator 显式调整（货币政策，`currency.rate_adjust` 审计）；修正系数 = optimizer tunable（初值 1.0）；**最终汇率 = 基准 × 系数**。
- 心智模型：endowment 100 credit ≈ 10M tokens ≈ 百轮常规任务。

### 1.3 双层记账

消耗事件记两笔：物理量 + credit 折算（FIFO 批次历史成本）。**已知偏差**（M5）：汇率上调时旧批次先出 → 燃尽折算偏低 → 报表略低估实际成本——文档化接受。物理账 ↔ credit 账比率 = 资源价格信号。

### 1.4 VoucherPort

```ts
interface VoucherPort {
  buy(agentId: string, kind: VoucherKind, units: number): void;
  balance(agentId: string, kind: VoucherKind): number;
  burn(agentId: string, kind: VoucherKind, units: number, cause: BurnCause): void;
  burnHistory(agentId: string, kind: VoucherKind): BurnRecord[];
}
type VoucherKind = "llm" | "time" | "compute";
type BurnCause = { traceId: string; transitionSeq: number } | { periodic: "memory-storage" };
```

**事务边界（C1）**：`SqliteVoucher` 与 `SqliteLedger` **共享同一 `DatabaseSync`**（装配注入）；`buy` 全程单事务（`BEGIN IMMEDIATE…COMMIT`，失败 ROLLBACK）。credit 不足 → debit 抛错。

### 1.5 消耗计量

- **llm/time**：每转移按遥测折算燃烧。
- **compute（记忆存储）**：**wall-clock 差值结算**（I3）——`AgentInstance.lastComputeSettleTs` 持久化；**装配/run 开始先补结算**（上次至今全量）；余额不足 → fail-fast（先购凭证）。**不运行不免费**。

## 2 中央池（Central Pool）

- `agentId = "central-pool"`——**RESERVED_IDS 黑名单**（I1/M6）：装配器**步骤 2b 后（agentId 生成后、开户前）**校验拒绝 + LedgerPort.open 拒绝。
- 入池：税 + 凭证销售收入；出池：endowment（flat 100）。**允许赤字**（观测可见）。全流水进事件流。

## 3 elo 系统

### 3.1 抽象接口与默认实现

```ts
interface EloFormula {
  readonly id: string;
  initial(context: { isOrg: boolean }): number;
  update(rating: number, ctx: EloUpdateContext): number;
}
type EloUpdateContext = { taskRating: number; outcome: number; weight?: number };
```

默认 `simple-elo`：`R' = max(FLOOR, R + K × (outcome − 1/(1+10^((taskRating−R)/400))))`；**initial = 1500**（I2）；**FLOOR = 100**（M1）；K tunable（默认 32）。**odds → taskRating 线性映射（I13 钉死）：`taskRating = 1500 + 200 × (O − 1)`**（O=1 → 1500 同分对局；O=2 → 1700）。RegistryPattern 注册表。

### 3.2 全局 + 分域

`eloGlobal`（初始 1500）+ `eloByDomain`（repository 扩展列）；回退 `byDomain[t] ?? global`；**结算同时双写**（各自起点，同 outcome/taskRating）。组织与个人各自持分。

### 3.3 选择函数

默认 `stake-elo-power`：`score = stake^α × norm(elo)^β`；`norm(elo) = max(elo/1500, 0.01)`；α=1.0/β=0.5 tunable。**同分 → stake 高 → agentId 字典序**（I4）。RegistryPattern 注册表。

## 4 任务类型注册与发布托管

### 4.1 任务类型开放注册

`TaskType = { id, description, baseDifficulty?, registeredBy, createdAt }`；开放注册（重复 id 幂等 no-op）；**发布强制带已注册类型**；类型注册 = elo 赛道自动创建；agent 承接声明（`AgentInstance.accepts`）。**评审也是任务类型**。

### 4.2 信息传递 vs 任务发布：制度性分离

通讯只传信息；市场只发任务。**制度而非封锁**：灰色经济不可禁不必禁——体制仅保障市场内交易权利义务。

### 4.3 发布托管制（Escrow——OQ5/OQ6/I8/I9/I11 裁决：需求侧资金来源）

- **发布 = 资金托管**：`publish(task)` 时发布方账户**冻结** `escrow = stake×(O−1) + N×stake_r×(O_r−1)`（最大可能支付：执行收益上限 + N 个评审者收益上限）；**escrow 冻结失败（余额不足）→ 发布拒绝**（fail-fast）。
- **结算**：全部划付从 escrow 出（执行 settle + 评审 settle_i + 税）；**剩余解冻**返回发布方。
- **评审任务 odds `O_r`**：发布方设定（同任务 odds 机制——风险报价），**默认 2**；评审报酬从 escrow 出（评审是商品，非公共物品——市场自主定价：无人接单 → 发布方提高 O_r/stake_r）。
- **发布方 = 任何有 credit 的主体**（operator/agent/组织）；外部人类需求经 operator 入口（发布代理）。escrow 即真实成本承诺——**无免费期权，DDoS 攻击面消除**。

## 5 市场即 workflow（Q2-A）

### 5.1 竞价流程 = flow.json 图

```
announce（code）→ persist_task（effect：任务落库+escrow 冻结——幂等 taskId）
  → shortlist（code：候选预筛选——承接声明过滤 + elo_domain 降序取前 maxFanout）
  → collect_bids（fanout：并行 bidding workloop → stake 数组）
  → select（code：SelectionFormula → winner）
  → execute（workloop：中标者 AgentRuntime.run）
  → review（fanout：N 个评审者并行评审 workloop → 密封 r_i 数组）
  → consensus（code：中位数共识 → R, {a_i}）
  → settle（code：全部结算数值纯计算）
  → apply_settlement（effect：escrow 划付+税+elo 双写+凭证燃烧+事件发射——幂等 taskId）
```

### 5.2 pit-flow 引擎扩展

1. **占位扇出节点**（`type: "fanout"`——C2/C5/OQ7/M4 裁决）：
   - 声明 `maxFanout`（默认 32）；**编译期展开为 maxFanout 占位分支**（静态图不变）；
   - **候选列表 = 上游 shortlist 输出（≤ maxFanout——超限已截断：elo_domain 降序取前 maxFanout）**；
   - **首轮执行时候选列表快照进 checkpoint**（resume 用快照——与 checkpoint 恢复语义一致：恢复 = 回到 checkpoint 时刻的世界，不重算候选）；
   - 运行时激活前 N 分支，其余 **no-op 分支不产生元素**（结果数组长度 = 激活分支产出数）；
   - **失败隔离**：分支失败 → 该分支无产出，不中断。
2. **effect 节点**（`type: "effect"`——C3/C6 裁决）：
   - 确定性副作用执行器（EffectRegistry，CodeRegistry 同构）；
   - **幂等存储 = `flow_effects` 表**（`(flowRunId, nodeId, idempotencyKey) → {status, resultSummary, ts}`——独立于 checkpoint）；
   - **effect 内部整体单事务原子**（共享 DatabaseSync——全部子步骤成功或整体回滚；**幂等记录与同事务写入**）；重试：幂等表有记录 → skip 返回结果摘要；无记录 → 重新执行（**部分失败不存在**——回滚即未发生）；
   - effect 失败 → 节点 failed 可重试。
3. **子图节点**（`type: "subflow"`）：flow.json 引用 flow.json；输入/输出映射。

### 5.3 嵌套市场 = 子图节点

组织对外中标 → 内部市场（子图实例，scope = 成员候选集）→ 子图结算回传父图。

## 6 组织（Organization = AgentInstance）

- 组织 = 持久 AgentInstance（账本/记忆域/workloop/elo）；`org_members` 成员表。
- **垫付制结算传导**（Q7-B + I14 裁决）：
  1. 成员交付 → 内部多评共识评审（§7a）；
  2. 组织**立即垫付**结算成员：**垫付金额 = settle_member + 凭证成本补偿**（成员燃烧凭证的 FIFO credit 折算——成员不因组织财务问题沉没生产成本）；余额只够部分 → **先补凭证成本，再付收益**；
  3. **垫付失败 → 组织违约事件**（`economy.org_default` 审计 + 组织 elo 按 majorError 更新 + 成员 stake 退还 + 成员私域写组织经验）；
  4. 组织汇总对外交付 → 外部评审与结算 → **组织利润 = settle_org − Σpayouts − 税**；
  5. 余额耗尽 = 无法押注 = 市场自然出局。
- 成员执行**烧自己的凭证**。

## 7 结算（code 纯算 + effect 划付）

- **code 纯计算**：`settle = stake × (O−1) × (2c−1)`；**majorError → `−stake`（显式特殊分支——C7 裁决：不代入公式，stakeOnly 语义钉死）**；`tax = max(0, settle) × taxRate`；elo 新值；凭证燃烧量；评审者 `settle_i`。
- **effect 划付**：幂等 taskId（§5.2.2——escrow 划转/税入池/elo 双写/燃烧/事件/记忆沉淀触发，单事务）。
- **odds=1 退化**：settle=0——故意设计（义务性任务，M3）。

## 7a 多评共识评审机制（用户机制 + Round 2 修正）

**核心假设**：**群体评价在平均尺度上总是正确的**（含人类用户）——**中位数**为真实评价（Round 2 I7/OQ8 修正：均值在 N 小时被合谋/极端值拖拽；中位数同为"平均尺度"位置度量且天然鲁棒）。

1. **评审 = 市场任务**：评审者押 stake_r 竞价（评审域 elo 赛道）；**N = 5 个评审者**中标（默认，tunable）。
2. **密封并行评价**：`r_i ∈ [0,1]` 互不可见；**互斥：执行者本人 + 同组织成员不得评审**（I10——候选集按 `org_members` 关系过滤）。
3. **共识计算**（code 纯计算）：**真实评价 `R = median(r_i)`**；评审者准确性 **`a_i = 1 − |r_i − R|`**。
4. **评审者结算**：`settle_reviewer_i = stake_i × (O_r − 1) × (2a_i − 1)`——贴中位数者赚、偏离者罚（向共识收敛 = 诚实报告压力）。
5. **被评对象完成度 `c = R`** → 驱动执行者结算与 elo。
6. **评审者 elo**：评审域 update（outcome = a_i）。
7. **校准任务锚定**（I6 裁决——懒惰均衡防线）：operator 可注入**校准任务**（预设 ground truth 答案的任务——评审者不可辨识）；校准任务的 `a_i` 不按共识而**按与 ground truth 的偏差**计算 → 直接驱动评审者 elo——系统性高估/低估在校准任务上暴露（共识无法合谋操纵已知答案）。
8. **流标处理**（I12 裁决）：**N_min = 3**——评审 fanout 激活 < N_min → 评审轮失败 → **重试 2 次**（escrow 保持冻结）→ 仍流标 → **operator 兜底评审**（单评审者，R = operator 评价，无共识奖惩——政府终审权）；**不惩罚已接单的少数评审者**（其 stake 退还 + 凭证成本从 escrow 补偿）。
9. **递归终止**：评审质量由共识偏差 + 校准任务双重评定——一层收敛。
10. **审计**：`economy.review_consensus` 事件含 R 与全部 r_i（评审透明）；观测层监控评审者系统性偏差。

## 8 货币循环观测

- **事件流**：`currency.mint/burn/buy_voucher/transfer/tax/rate_adjust` / `economy.org_default/elo_update/review_consensus/escrow_freeze/escrow_release`——全量含双层记账字段。
- **投影报表**：发行量/流速/池余额/凭证存量与燃烧速率/物理↔credit 对账/elo 分布/评审准确性分布/校准任务偏差榜。只读投影。

## 9 记忆沉淀（结算事件驱动）

- **执行经验**：`场景=任务 动作=执行 结果=c=R 收益=settle(税后)`。
- **竞价经验**（含未中标）：`场景=竞价 动作=出价s 结果=中标/未中标(winner,stake)`。
- **评审经验**：`场景=评审 动作=评价r_i 结果=中位R 准确性a_i 收益=settle_i`。
- **组织违约经验**（成员视角）。
- 经验 → 沉淀管道 → 规则化 → 发轫 → 审核链 → **onDecision → submitWriteBack**（公域规则演化闭环）。

## 10 C 接线包落地清单

1. attachSdk 真实钩子（runner `sdkExtensions`）；2. seqProvider 注入；3. onCheckpoint→dsp.snapshot 注册；4. inbox drainInto 拼接 task 前缀；5. delivery=auto 覆写；6. IdentityMap 装配注册+刷新回调；7. **DSP 两段拼接**；8. AssembleOptions 可选 agentId；9. removeAccount 提进 LedgerPort；10. startSweeper unref。

## 11 不变量与失败语义

- **I1 钱 fail-fast**；**I2 凭证耗尽 = 单节点失败**（partialFailures 语义，按 majorError 结算——自负）；compute 补结算失败 = 装配/run 拒绝。
- **I3 凭证单向**；**I4 保留 ID**；**I5 未注册类型无任务**；**I6 elo 单调可审计**；**I7 观测只读**。
- **I8 effect 幂等+原子**（flow_effects 表 + 单事务——部分失败不存在）。
- **I9 评审独立**：执行者+同组织成员互斥；密封；校准任务不可辨识。
- **I10 发布托管**：escrow 冻结失败 = 发布拒绝。
- **失败语义**：fanout 分支隔离；effect 可重试；子图失败 → 组织交付失败处理（已发生垫付不逆转）；评审流标 → §7a.8 阶梯。

## 12 测试策略

- 零新增依赖；node:test；tmp+rename；import `.ts`。
- 货币：buy 事务原子性（中途失败回滚）/burn/耗尽单节点失败/FIFO/池流水；汇率三态；默认值钉死（10/5/2/100）。
- elo：数值钉死（1500/100/32/线性映射 1500+200(O−1)）；分域回退；双写；公式注册替换。
- 选择：同分字典序；clamp 0.01。
- 托管：escrow 冻结/划付/剩余解冻/余额不足拒绝。
- flow 扩展：fanout 快照/激活/no-op 不产元素/失败隔离/resume 拓扑静态；**effect 幂等重试/单事务原子**；subflow。
- 多评共识：median/a_i 数值钉死；互斥（本人+同组织）；校准任务偏差计算；流标阶梯（重试→operator 兜底→少数评审者保护）。
- 组织：垫付成功/**凭证成本优先补偿**/违约链/利润为负。
- 观测：事件全量 + 投影重建一致性。
- 记忆沉淀：四类经验。
- 集成：多 agent 多轮竞价 bench demo——端到端货币循环。

## 13 隐藏依赖与风险

- **pit-flow 三扩展（fanout 占位/effect/subflow）是最大工程块**——任务排序最先行。
- **凭证燃烧与遥测口径**：遥测 → 燃烧折算点（effect 依赖遥测事件完整传递）。
- **elo 域爆炸**：稀疏存储；刷域 v1 不防（审计可见）。
- **合谋面残余**：N=5+中位数+同组织互斥+校准任务四重防线；跨组织合谋（多组织联合操纵评审）仅靠公开竞价稀释+审计——文档化接受。
- **arena 遗留兼容**：OddsPolicy/SettlementPolicy/CostModel 默认族保留；**EndowmentPolicyV1 K/price 废弃**（flat 100 新默认；旧公式可选注册）；errorMode 配置废弃（stakeOnly 钉死）。
- **组织心智**：任意已注册 workloop；v1 不做治理模型。

## 14 非目标（v1）

- 凭证卖回/互兑/转让；破产清算；汇率自动调整；elo 加权共识（中位数先行）；灰色经济技术封锁；防刷机制（审计先行）；组织治理模型；PTH 侧部署；评审争议仲裁（事件只记录）；跨组织合谋的技术防范。
