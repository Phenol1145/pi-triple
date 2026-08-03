# 经济层（Economy Layer）设计 Spec

**日期**：2026-08-03
**状态**：设计修订（Round 1 对抗性评审裁决已落地：C1-C4 修复 + I1-I5 + M1-M3 + OQ1/OQ2/OQ3/OQ4）
**父文档**：`docs/superpowers/2026-08-03-market-economy-overview.md`（决策记录 Q1-Q8 + 任务类型注册约束 + 多评共识机制）
**依赖**：子项目 A（pit-flow 运行时扩展——code 节点/metrics，已合并）、B（记忆系统，已合并）、C（装配层，已合并）、arena 遗留（OddsPolicy/SettlementPolicy/CostModel）
**范围**：完整经济语义（Q1-B）——多货币 + 汇率 + elo + 任务类型注册 + 市场即 workflow + 组织 + 中央池 + 多评共识评审 + 观测 + 记忆沉淀；保留优化器；elo 抽象化接口

---

## 0 设计语义（一句话）

**市场经济闭环跑通**：任务类型开放注册（行业自我生长）→ 市场即 workflow（竞价→执行→**多评共识评审**→结算 = flow.json 图）→ f(stake, elo_domain) 选择 → 组织垫付制传导 → credit 流通 + 凭证配给 + 中央池货币循环 → 结算事件驱动记忆沉淀与 elo 演化——**分工、价格、信誉、组织、评审全部从市场参与者的行为中长出**。

---

## 1 货币体系

### 1.1 两层结构

```
物理资源（token / 墙钟秒 / GB·天存储）
    ↑ 固定兑换比（凭证定义的一部分，不可调）
凭证（llm / time / compute）
    ↑ 浮动汇率（静态基准 × optimizer 修正系数）
credit（唯一流通货币）
```

- **credit**：唯一流通货币——竞价 stake、结算、税、统一计价单位。LedgerPort 既有语义（SqliteLedger）承载。
- **凭证（voucher）**：资源配给手段。三种：`llm`（token 配额）、`time`（墙钟秒）、`compute`（存储 GB·天——**记忆存储并入 compute**）。
  - **锚定物理量**（定义常量，固定）：`llm 1 unit = 1M tokens`（in+out blended——**已知简化**：混合精度模型（in/out 价差大）存在结构性套利空间，v1 接受并文档化（I5 裁决）；精准加权折算留后续）；`time 1 unit = 3600s`；`compute 1 unit = 1 GB·天`。
  - **只能以 credit 向中央购买**（单向——不可卖回、凭证间不互兑、v1 不可转让）。
  - **凭证耗尽 = 单节点失败**（§11——非全 flow 熔断，OQ4 裁决）。
  - 汇率调整语义：**已消耗不变；持仓物理量不变（credit 计价浮动）；新购按新价**。

### 1.2 汇率与初始配置（C4/OQ1/OQ2 裁决）

`ExchangeRateTable = { creditPerUnit: { llm, time, compute } }`。
- **默认零配置可启动**：`DEFAULT_EXCHANGE_RATES = { llm: 10, time: 5, compute: 2 }`（1 unit 分别 10/5/2 credit）；`DEFAULT_ENDOWMENT = 100`（flat——**废弃 K/price 公式**：新体系无模型定价概念，endowment 不再按模型定价折算）。
- **分工**：基准 = **operator 显式调整**（货币政策，事件审计 `currency.rate_adjust`）；修正系数 = **optimizer tunable**（技术微调，初值 1.0）；**最终汇率 = 基准 × 系数**。
- 参考心智模型：endowment 100 credit ≈ 10M tokens（10 llm units）——新 agent 可跑约百轮常规任务。

### 1.3 双层记账

每次资源消耗事件记两笔：**物理量**（不可改写）+ **credit 折算值**（购买时汇率加权平均的历史成本）。物理账与 credit 账的**比率变化 = 真实资源相对价格信号**（观测层对账）。

### 1.4 VoucherPort（新抽象，独立于 LedgerPort）

```ts
interface VoucherPort {
  buy(agentId: string, kind: VoucherKind, units: number): void;    // 单事务：debit credit（入池）+ 凭证入账
  balance(agentId: string, kind: VoucherKind): number;
  burn(agentId: string, kind: VoucherKind, units: number, cause: BurnCause): void;
  burnHistory(agentId: string, kind: VoucherKind): BurnRecord[];   // 双层记账源
}
type VoucherKind = "llm" | "time" | "compute";
type BurnCause = { traceId: string; transitionSeq: number } | { periodic: "memory-storage" };
```

**事务边界（C1 裁决）**：默认实现 `SqliteVoucher` 与 `SqliteLedger` **共享同一 `DatabaseSync` 实例**（装配层注入）；`buy` 全程单事务（`BEGIN IMMEDIATE … COMMIT`，失败 `ROLLBACK`——debit/credit 池/凭证入账三步原子）。credit 不足 → debit 抛错（fail-fast）。表：`voucher_balances` / `voucher_burns`（含批次 `(units, creditPerUnit)`——FIFO 历史成本折算源）。

### 1.5 消耗计量

- **llm**：每转移按遥测 `tokensIn + tokensOut` 折算 units 燃烧（BurnCause = 转移定位）。
- **time**：每转移按墙钟耗时折算。
- **compute（记忆存储）**：**wall-clock 差值结算**（I3 裁决）——AgentInstance 持久化 `lastComputeSettleTs`；**装配/run 开始时先补结算**（上次结算至今全量：私域记忆总字节 × 间隔天数折算 GB·天，BurnCause = periodic）；余额不足 → fail-fast（补结算失败 = 停机，须先购凭证）。**不运行不免费**——记忆持有成本与时间同在。
- 历史成本：燃烧按 FIFO 批次折算 credit 成本（报表层）。

## 2 中央池（Central Pool）

- operator 持有的特殊账本账户（`agentId = "central-pool"`，**保留 ID**——`RESERVED_IDS` 黑名单（I1 裁决）：装配器步骤 1 前校验拒绝、LedgerPort.open 拒绝、不可装配为 AgentRuntime/参与竞价）。
- **入池**：税（结算正收益 × taxRate）、凭证销售收入。
- **出池**：endowment（新 agent 装配开户，flat 100）。
- **允许赤字**：余额可为负（赤字货币化——观测层可见，不隐藏超发）。
- 全部流水进事件流（§8）。

## 3 elo 系统

### 3.1 抽象接口（用户要求：elo 计算抽象化）

```ts
interface EloFormula {
  readonly id: string;
  initial(context: { isOrg: boolean }): number;
  update(rating: number, ctx: EloUpdateContext): number;
}
type EloUpdateContext = {
  taskRating: number;       // 任务难度分（odds → 分映射，OddsPolicy 扩展职责）
  outcome: number;          // 对局得分 = 完成度 c ∈ [0,1]（majorError → 0；评审任务 → a_i）
  weight?: number;
};
```

默认 `simple-elo`：`R' = max(FLOOR, R + K × (outcome − 1/(1+10^((taskRating−R)/400))))`；**`initial() = 1500`**（钉死，I2 裁决）；**`FLOOR = 100`**（最低分，M1 裁决）；K tunable（默认 32）。注册表 = RegistryPattern 同构（可注册 Glicko-2 等——optimizer canary 对比）。

### 3.2 作用域：全局 + 分域（Q6-B）

- 存储：`AgentInstance.eloGlobal`（初始 1500）+ `AgentInstance.eloByDomain: Record<taskTypeId, number>`（repository 扩展列，N-I9 迁移模式）。
- **回退链**：`eloByDomain[taskType] ?? eloGlobal`。
- 更新：**结算同时更新域分与全局分**（各自以当前分（域回退值/全局值）为起点，同 outcome/taskRating 两次 update）。
- 组织与个人各自持分。

### 3.3 选择函数（SelectionFormula 注册表）

```ts
interface SelectionFormula {
  readonly id: string;
  score(candidate: { stake: number; elo: number }, ctx: { taskRating: number }): number;
}
```

默认 `stake-elo-power`：`score = stake^α × norm(elo)^β`；`norm(elo) = max(elo/1500, 0.01)`（M1 裁决）；α/β tunable（默认 1.0/0.5）。**选择 = score 最高者；同分 → stake 高者；再同 → agentId 字典序**（I4 裁决——wave 模型无提交时序概念，字典序与引擎 bare-writes last-wins 同构确定性）。

## 4 任务类型注册表与信息/任务分离

### 4.1 任务类型开放注册（行业自我生长）

```ts
type TaskType = {
  id: string;
  description: string;
  baseDifficulty?: "easy" | "medium" | "hard";
  registeredBy: string;       // agentId | "operator"
  createdAt: number;
};
interface TaskTypeRegistry { register(t: TaskType): void; get(id: string): TaskType | undefined; list(): TaskType[]; }
```

- **开放注册**；重复 id = 幂等 no-op。
- **任务发布强制带已注册类型**——未注册类型市场**拒收**。
- **类型注册 = elo 赛道自动创建**；agent 承接声明（`AgentInstance.accepts: string[]`）= 进入赛道。
- **评审也是任务类型**（§7a——"评审行业"同样自我生长）。

### 4.2 信息传递 vs 任务发布：制度性分离

通讯只承担信息传递；市场只承担任务发布。**制度而非封锁**：私下约定（灰色经济）不可禁不必禁——体制仅保障市场内交易的 elo/结算/税收/违约罚没。市场通道不传递自由文本协商。

## 5 市场即 workflow（Q2-A）

### 5.1 竞价流程 = flow.json 图

```
announce（code：任务记录持久化计算）
  → persist_task（effect：任务落库——幂等键 taskId）
  → collect_bids（fanout：候选 agent 并行 bidding workloop → stake 数组）
  → select（code：SelectionFormula 纯计算 → winner）
  → execute（workloop：中标者 AgentRuntime.run）
  → review（fanout：N 个评审者并行评审 workloop → 密封评价 r_i 数组）
  → consensus（code：多评共识纯计算 → R, {a_i}）
  → settle（code：结算纯计算 → 全部数值）
  → apply_settlement（effect：划付+税+elo 更新+凭证燃烧+事件发射——幂等键 taskId）
```

### 5.2 pit-flow 引擎扩展（本子项目基础设施任务）

1. **占位扇出节点**（`type: "fanout"`，**maxFanout 占位语义**——C2 裁决）：声明 `maxFanout: number`（如 32）+ 候选列表来源 + 子流程模板；**编译期展开为 maxFanout 个占位分支**（静态图假设不变）；运行时实际候选数 N ≤ maxFanout → 激活前 N 个分支，其余标记 no-op（立即完成，产出 null）。**失败隔离**：单分支失败 → 该分支产出 null，不中断。resume/checkpoint 拓扑静态不变（占位分支全在图里）。
2. **effect 节点**（`type: "effect"`——C3 裁决）：**确定性副作用执行器**（划付/落库/事件发射——code 节点保持纯函数）。`EffectRegistry`（CodeRegistry 同构模式）；声明**幂等键**（如 taskId）——引擎 at-least-once 重试时按幂等键去重（已执行 → skip 返回缓存结果）。effect 失败 → 节点 failed（可重试）。
3. **子图节点**（`type: "subflow"`）：flow.json 引用另一 flow.json（嵌套市场表达）；输入/输出映射声明。

### 5.3 嵌套市场 = 子图节点

组织对外中标后，其 workloop 决策发起**内部市场**（子图实例——同一市场 flow 定义，scope = 组织成员候选集）。子图结算完成 → 结果回传父图。

## 6 组织（Organization = AgentInstance）

- 组织 = 持久 AgentInstance（自己账本/记忆域/workloop/elo）——装配路径与个人相同，差异仅在配置（`isOrg: true` + `org_members` 成员表）。
- **对外**：单一出价节点。
- **垫付制结算传导**（Q7-B）：
  1. 成员交付 → 内部多评共识评审（§7a——**评审者不得为执行者本人**；组织可评审成员交付吗？**可以但只是 1/N 票**——组织自评被其他独立评审者稀释（多评机制天然解决 OQ3 的利益冲突））；
  2. 组织**立即垫付**结算成员（debit org / credit member）；
  3. **垫付失败 → 组织违约事件**（`economy.org_default` 审计 + 组织 elo 按 majorError 更新 + 成员 stake 退还无收益 + 成员私域写组织经验）；
  4. 组织汇总对外交付 → 外部评审与结算 → **组织利润 = settle_org − Σpayouts − 税**（可为负 → 消耗留存）；
  5. 余额耗尽 = 无法押注 = 市场自然出局。
- 成员执行**烧自己的凭证**（凭证不可转让）。

## 7 结算（Settle = code 纯算 + effect 划付）

- **code 节点纯计算**（全部数值）：`settle = stake × (O−1) × (2c−1)`（majorError → `−stake`）；`tax = max(0, settle) × taxRate`（taxRate tunable）；elo 新值；凭证燃烧量；评审者各自 `settle_reviewer_i`。
- **effect 节点划付**：按幂等键 taskId 执行（冻结划转/税入池/elo 双写/凭证燃烧/事件发射/记忆沉淀触发）。
- **odds=1 退化文档化**（M3 裁决）：零杠杆任务 settle=0——无货币激励属故意设计（义务性/非货币动机任务）。

## 7a 多评共识评审机制（OQ3 裁决——用户机制）

**核心假设**：**群体评价在平均尺度上总是正确的**（含人类用户）——评价均值 = 真实评价。

1. **评审 = 市场任务**：评审者押 stake 竞价（评审域 elo 赛道）；N 个评审者中标（N 默认 3，tunable）。
2. **密封并行评价**：评审者独立提交 `r_i ∈ [0,1]`（互不可见——review fanout 分支并行执行，结果仅在 consensus 节点聚合）；**执行者互斥**（不得评审自己的交付——候选集过滤）。
3. **共识计算**（code 节点纯计算）：**真实评价 `R = mean(r_i)`**（v1 简单平均；elo 加权留后续）；评审者准确性 **`a_i = 1 − |r_i − R|`**。
4. **评审者结算**（复用线性公式，a_i 当完成度）：`settle_reviewer_i = stake_i × (O_r − 1) × (2a_i − 1)`——**贴均值者赚、偏离者罚**（向均值收敛压力 = 诚实报告压力）。
5. **被评对象完成度** `c = R`——驱动执行者结算与 elo。
6. **评审者 elo**：评审域 update（outcome = a_i）。
7. **退化**：N<2（流标/单评审接单）→ `a_i = 0.5`（中性：stake 退还，无奖惩）+ 低置信事件标记。
8. **递归终止**：评审质量不由更高层评审判定——由共识偏差评定，**一层共识即收敛**。
9. **审计**：观测层监控评审者系统性偏差（长期偏离均值的评审者——审计可见，市场自然淘汰）。

## 8 货币循环观测

- **事件流**（lab_events）：`currency.mint` / `currency.burn` / `currency.buy_voucher` / `currency.transfer` / `currency.tax` / `currency.rate_adjust` / `economy.org_default` / `economy.elo_update` / `economy.review_consensus`（含 R 与全部 r_i——评审透明可审计）——全量含双层记账字段。
- **投影报表**：发行量/流速/池余额/凭证存量与燃烧速率/**物理账 ↔ credit 账对账**/elo 分布/评审准确性分布。只读投影（可重放重建）。

## 9 记忆沉淀（结算事件驱动）

- **执行经验**：`场景=任务<id/类型> 动作=执行 结果=c=R 收益=settle(税后)` → 私域。
- **竞价经验**（含未中标）：`场景=竞价<任务> 动作=出价s 结果=中标/未中标(winner, 其stake)`。
- **评审经验**：`场景=评审<任务> 动作=评价r_i 结果=共识R 准确性a_i 收益=settle_i`。
- **组织违约经验**（成员视角）：§6。
- 经验 → 沉淀管道 → 规则化 → 发轫 → 审核链 → **onDecision → submitWriteBack 组合链接线**（公域规则演化闭环）。

## 10 C 接线包落地清单（本子项目完成）

1. attachSdk 真实钩子（runner `buildSDK` 可选扩展点 `sdkExtensions`）；2. seqProvider 注入；3. `runner.onCheckpoint(({seq}) => host.dsp.snapshot(seq))` 注册；4. inbox drainInto 片段拼接进 `run({task})` 前缀；5. `delivery=auto` 装配绑定时覆写；6. IdentityMap 装配注册 + session 刷新回调；7. **DSP 两段拼接**（私域段 + 公域段）；8. AssembleOptions 增可选 `agentId`；9. removeAccount 提进 LedgerPort 接口；10. `startSweeper` `timer.unref()`。

## 11 不变量与失败语义

- **I1 钱 fail-fast**：credit/凭证不足 → 抛错，不静默垫付。
- **I2 凭证耗尽 = 单节点失败**（OQ4 裁决）：run 中 llm 凭证耗尽 → 该 workloop 节点 failed（flow partialFailures 语义——**非全 flow 熔断**），按 majorError 结算（自负）；compute 耗尽 → 私域写入拒绝 → 记忆沉淀失败事件；compute 补结算失败 = 装配/run 拒绝（须先购凭证）。
- **I3 凭证单向**：无卖回/互兑/转让 API。
- **I4 保留 ID**：`central-pool` 不可装配/竞价（RESERVED_IDS 黑名单）。
- **I5 未注册类型无任务**：publish 校验。
- **I6 elo 单调可审计**：更新只经结算事件（全量可重放）。
- **I7 观测只读**。
- **I8 effect 幂等**：副作用节点按幂等键去重（at-least-once 安全）。
- **I9 评审独立**：执行者不得自评（候选集过滤）；评审密封（consensus 前互不可见）。
- **失败语义**：fanout 分支失败隔离（产出 null）；effect 失败可重试（幂等键）；子图失败 → 父图按组织交付失败处理（垫付义务已发生部分不逆转）。

## 12 测试策略（沿用既定模式）

- 零新增依赖；node:test；tmp+rename；import `.ts`。
- 货币：VoucherPort 全路径（**buy 事务原子性**（中途失败回滚）/burn/耗尽单节点失败/FIFO/池流水）；汇率三态；默认值钉死（10/5/2/100）。
- elo：数值钉死（initial=1500/FLOOR=100/K=32 已知输入期望分）；分域回退；组织/个人分立；公式注册替换。
- 选择：同分字典序；clamp 0.01。
- 任务类型：注册幂等/发布校验/赛道创建。
- flow 扩展：**fanout 占位激活/no-op/失败隔离/resume 拓扑静态**；**effect 幂等去重重试**；subflow 嵌套。
- 多评共识：R/a_i 数值钉死；密封互斥（执行者过滤）；N<2 退化；评审者结算公式。
- 组织：垫付成功/违约链/利润为负/成员凭证自负。
- 观测：事件全量 + 投影重建一致性。
- 记忆沉淀：四类经验条目存在性。
- 集成：多 agent 多轮竞价 demo（bench）——端到端货币循环可观测。

## 13 隐藏依赖与风险

- **pit-flow 三扩展（fanout 占位/effect/subflow）是最大工程块**——任务排序最先行。
- **凭证燃烧与遥测口径**：遥测必须可靠到达 settle（MachineRuntime 遥测链已有；缺口 = 遥测 → 凭证燃烧折算点——effect 节点依赖遥测事件的完整传递）。
- **elo 域爆炸**：类型开放注册 → 域无界；byDomain 稀疏存储；刷域 v1 不防（观测审计可见）。
- **多评共识的合谋面**：N 个评审者中多数合谋可操纵均值——诚实多数假设下的机制，观测层监控系统性偏差（§7a.9）；评审者候选开放性（公开竞价）是主要稀释手段。
- **arena 遗留兼容**：OddsPolicy/SettlementPolicy/CostModel 保留为默认实现族（V1 语义扩展税/凭证——不破坏既有 arena 测试基线）；**EndowmentPolicyV1 的 K/price 公式废弃**（C4 裁决——新默认 flat 100，旧公式保留为可选注册实现）。
- **组织心智**：组织 workloop = 任意已注册定义（pi-default-loop 即可）；v1 不做组织治理模型。

## 14 非目标（v1）

- 凭证卖回/互兑/转让；破产清算；汇率自动调整（operator 显式 + optimizer 系数微调）；elo 加权共识（简单平均先行）；灰色经济技术封锁；elo/评审防刷机制（观测审计先行）；组织治理模型；PTH 侧市场部署；评审争议的仲裁流程（争议事件只记录）。
