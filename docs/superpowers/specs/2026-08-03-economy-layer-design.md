# 经济层（Economy Layer）设计 Spec

**日期**：2026-08-03
**状态**：设计定稿（5 轮对抗性评审 CONVERGED——合计 11C/25I/12M 全部裁决落地）
**父文档**：`docs/superpowers/2026-08-03-market-economy-overview.md`
**依赖**：子项目 A（ptl-flow 运行时扩展，已合并）、B（记忆系统，已合并）、C（装配层，已合并）、arena 遗留
**范围**：完整经济语义（Q1-B）

---

## 0 设计语义（一句话）

**市场经济闭环跑通**：任务类型开放注册 → **发布托管上界冻结（maxStake 风险预算）→ 竞价真实出价 → 调减托管** → 市场即 workflow → f(stake, elo_domain) 选择 → **多评共识（中位数 + 校准任务锚定）** → **对称托管结算**（双方 max-loss 冻结）→ 组织垫付传导 → credit 流通 + 凭证配给 + 中央池货币循环 → 结算驱动记忆沉淀与 elo 演化。

---

## 1 货币体系

### 1.1 两层结构

```
物理资源（token / 墙钟秒 / GB·天存储）→ 凭证（llm/time/compute）→ credit（唯一流通货币）
```

- **凭证**：`llm 1 unit = 1M tokens`（in+out blended——已知简化 I5：混合精度模型结构性套利空间，v1 接受文档化）；`time 1 unit = 3600s`；`compute 1 unit = 1 GB·天`（记忆存储并入）。只能以 credit 向中央购买（单向；不可卖回/互兑/转让）。**凭证耗尽 = 单节点失败**（非全 flow 熔断）。
- 汇率调整：已消耗不变 / 持仓物理量不变（计价浮动）/ 新购按新价。

### 1.2 汇率与初始配置

- **默认零配置可启动**：`DEFAULT_EXCHANGE_RATES = { llm: 10, time: 5, compute: 2 }`；`DEFAULT_ENDOWMENT = 100`（flat——废弃 K/price；旧公式保留可选注册）。
- **分工**：基准 = operator 显式（`currency.rate_adjust` 审计）；修正系数 = optimizer tunable（初值 1.0）；**最终汇率 = 基准 × 系数**。
- **生存性参考模型**（I5 量化）：bid 成本 ≈ 0.002 credit/次；常规执行任务凭证 ≈ 0.5–5 credit；满额押注冻结（minStake 10 × (O=3)−1 = 20）——100 credit ≈ 4–5 次满额押注 + 凭证预算。**初期 agent 应低 stake 参与**（文档化引导）；存储成本的隐性时间压力（M3：1GB 记忆 = 2 credit/天，50 天耗尽 endowment——记忆压缩有真实经济动机）。

### 1.3 双层记账

消耗事件记两笔：物理量 + credit 折算（FIFO 批次历史成本）。**已知偏差**（M5）：汇率上调时旧批次先出 → 燃尽折算偏低——文档化接受。**燃烧记录全透明**（制度：物理资源消耗对市场可见——监管与对账基础；非私密数据）。

### 1.4 VoucherPort

```ts
interface VoucherPort {
  buy(agentId: string, kind: VoucherKind, units: number): void;
  balance(agentId: string, kind: VoucherKind): number;
  burn(agentId: string, kind: VoucherKind, units: number, cause: BurnCause): void;
  burnHistory(agentId: string, kind: VoucherKind, filter?: { traceId?: string; sinceTs?: number }): BurnRecord[];
}
type VoucherKind = "llm" | "time" | "compute";
type BurnCause = { traceId: string; transitionSeq: number } | { periodic: "memory-storage" };
```

**事务边界（C1）**：`SqliteVoucher` 与 `SqliteLedger` **共享同一 `DatabaseSync`**；`buy` 全程单事务。credit 不足 → debit 抛错。**burnHistory 过滤**（I2——垫付补偿按 traceId 精确取本次执行燃烧量，无 TOCTOU）。

### 1.5 消耗计量

- **llm/time**：每转移按遥测折算燃烧（BurnCause 含 traceId 定位）。
- **compute（记忆存储）**：**wall-clock 差值结算**（I3）——`lastComputeSettleTs` 持久化；装配/run 开始先补结算；余额不足 → fail-fast。**不运行不免费**。

## 2 中央池（Central Pool）

- `agentId = "central-pool"`——**RESERVED_IDS 黑名单**：阻止**外部**装配/开户/竞价（装配器步骤 2b 后校验拒绝 + LedgerPort.open 拒绝）；**系统启动时直接初始化池账户**（绕过 LedgerPort.open 走 SqliteLedger 底层——I-R5-2 裁决：池是真实账本账户但不经装配路径）。**池资金操作 = 专用内部路径**（I-R5-1 裁决：`SqliteLedger` 新增池专用 `poolDebit`（允许负余额——绕过 debit 夹紧）——仅系统内部（endowment 出池/校准 escrow）可用，不进 LedgerPort 公开接口）。
- 入池：税 + 凭证销售收入；出池：endowment（flat 100）。**允许赤字**（观测可见）。

## 3 elo 系统

### 3.1 抽象接口与默认实现

```ts
interface EloFormula { readonly id: string; initial(context: { isOrg: boolean }): number; update(rating: number, ctx: EloUpdateContext): number; }
type EloUpdateContext = { taskRating: number; outcome: number; weight?: number };
```

默认 `simple-elo`：`R' = max(FLOOR, R + K × (outcome − 1/(1+10^((taskRating−R)/400))))`；**initial = 1500**；**FLOOR = 100**；K=32 tunable。**odds → taskRating 线性映射：`taskRating = 1500 + 200 × (O − 1)`**（I13 钉死）。RegistryPattern 注册表。

### 3.2 全局 + 分域

`eloGlobal`（初始 1500）+ `eloByDomain`；回退 `byDomain[t] ?? global`；**结算同时双写**。组织与个人各自持分。

### 3.3 选择函数

默认 `stake-elo-power`：`score = stake^α × norm(elo)^β`；`norm(elo) = max(elo/1500, 0.01)`；α=1.0/β=0.5 tunable。**同分 → stake 高 → agentId 字典序**。RegistryPattern 注册表。

## 4 任务类型注册与发布托管

### 4.1 任务类型开放注册

`TaskType = { id, description, baseDifficulty?, registeredBy, createdAt }`；开放注册（重复 id 幂等）；**发布强制带已注册类型**；类型注册 = elo 赛道自动创建；承接声明 `AgentInstance.accepts`。**评审也是任务类型**。

### 4.2 信息传递 vs 任务发布：制度性分离

通讯只传信息；市场只发任务。**制度而非封锁**——体制仅保障市场内交易权利义务。

### 4.3 发布托管：两阶段 escrow（C-1/I-1/I-4 裁决）

**stake 语义钉死**：执行者 stake = 竞价结果（出价）；**`maxStake` = 发布方声明的风险预算**（任务参数——接受的最大执行者 stake，bid 超限 clamp 到 maxStake）；**`stake_r` = 发布方统一声明的评审押金**（任务参数——评审者不竞价金额，§7a.1）；**`voucherAllowance` = 凭证成本补偿余量**（任务参数，默认 `(N+1)×1` credit——N 评审者 + 1 执行者）。**补偿语义**（I-R4-3/4/5 裁决）：补偿 = **实际燃烧**（`burnHistory({traceId})` FIFO 折算）**capped by voucherAllowance**；计算与划付在 apply_settlement（effect，可读 DB）同事务内完成；**O=1（义务性任务）无凭证补偿**（义务性 = 自担成本——消除零冻结套利）。

- **阶段一（publish）**：冻结**上界** `escrow_max = maxStake×(O−1) + N×stake_r×(O_r−1) + voucherAllowance`；余额不足 → **发布拒绝**（fail-fast——无免费期权，DDoS 消除）。
- **阶段二（select 后）**：按实际中标 stake **调减**——解冻 `escrow_max − escrow_actual`；`escrow_actual = stake×(O−1) + N×stake_r×(O_r−1) + voucherAllowance`。
- **结算**：全部正向划付从 escrow 出（执行 settle>0 + 评审 settle_i>0 + 凭证成本补偿）；剩余解冻。
- **发布方 = 任何有 credit 的主体**；外部人类需求经 operator 入口。

### 4.4 对称托管：bid 冻结（C-2/M-2 裁决）

- **bid 提交即冻结 `stake×(O−1)`**（执行者最大可能赔付——c=0 时 |settle| = stake×(O−1)；与发布方 escrow 对称，双方均以 max-loss 托管）；bid 时余额不足 → bid 拒绝。
- 未中标 → 立即解冻。
- 中标：**settle > 0** → 从 escrow 收 settle，自身冻结全额解冻；**settle < 0** → 从自身冻结划 `|settle|` **直付发布方**（不入 escrow——escrow 只托管发布方资金），剩余解冻；**majorError → 划 stake**（stakeOnly）。
- **杠杆押注的最大赔付永远有冻结背书**——margin call 不存在。

## 5 市场即 workflow（Q2-A）

### 5.1 竞价流程 = flow.json 图

```
announce（code）→ persist_task（effect：任务落库 + escrow_max 冻结——幂等 taskId）
  → shortlist（code：承接过滤 + elo_domain 降序取前 maxFanout）
  → collect_bids（fanout：并行 bidding workloop → stake 数组（各自已冻结 stake×(O−1)））
  → select（code：SelectionFormula → winner）
  → adjust_escrow（effect：调减解冻 + 未中标者 bid 解冻——幂等 taskId）
  → execute（workloop body = agent 节点，v1 走 spawnAgent 调用中标者 AgentRuntime.run）
  → review（fanout body = agent 节点，v1 走 spawnAgent 调用 N 个评审者并行评审 workloop → 密封 r_i）
  → consensus（code：中位数共识 → R, {a_i}）
  → settle（code：全部结算数值纯计算）
  → apply_settlement（effect：escrow 划付/负 settle 直付/税/elo 双写/燃烧/事件——幂等 taskId）
```

### 5.2 ptl-flow 引擎扩展

1. **占位扇出节点**（`type: "fanout"`）：`maxFanout`（默认 32）运行时逐项激活（图保持静态 + 首轮候选快照 resume）——D1 实证裁决；候选 = 上游 shortlist 输出（≤ maxFanout 已截断）；**首轮执行候选快照进 checkpoint**（resume 用快照不重算）；激活前 N 分支，**no-op 分支不产元素**；失败隔离。
2. **effect 节点**（`type: "effect"`）：确定性副作用执行器（EffectRegistry，CodeRegistry 同构）；**幂等存储 = `flow_effects` 表**（`(flowRunId, nodeId, idempotencyKey) → {status, resultSummary, ts}`）；**内部整体单事务原子**（共享 DatabaseSync；幂等记录同事务——部分失败不存在）；重试 skip 返回结果摘要。
3. **子图节点**（`type: "subflow"`）：嵌套市场表达；输入/输出映射。

### 5.3 嵌套市场 = 子图节点

组织对外中标 → 内部市场（子图实例，成员候选集）→ 子图结算回传父图。**双重冻结文档化**（M-1）：组织同时承担外部 bid 冻结（stake_org×(O−1)）+ 内部 escrow_max 冻结——组织启动资本需覆盖两者之和（装配配置指引）。

## 6 组织（Organization = AgentInstance）

- 组织 = 持久 AgentInstance（账本/记忆域/workloop/elo）；`org_members` 成员表。
- **垫付制结算传导**（Q7-B + I14/I-2）：
  1. 成员交付 → 内部多评共识评审；
  2. 组织**立即垫付**：**垫付金额 = settle_member + 凭证成本补偿**（按 `burnHistory(member, kind, {traceId})` 精确取本次执行燃烧的 FIFO 折算——燃烧记录全透明，无数据边界问题）；余额只够部分 → **先补凭证成本，再付收益**；
  3. **垫付失败 → 组织违约事件**（`economy.org_default` + 组织 elo 按 majorError + 成员 stake 退还 + 成员私域写组织经验）；
  4. 组织汇总对外交付 → 外部评审与结算 → **组织利润 = settle_org − Σpayouts − 税**；
  5. 余额耗尽 = 无法押注 = 自然出局。
- 成员执行**烧自己的凭证**。

## 7 结算（code 纯算 + effect 划付）

- **code 纯计算**：`settle = stake × (O−1) × (2c−1)`；**majorError → `−stake`（显式特殊分支——不代入公式）**；**majorError 判定**（M-R4-1 钉死）：执行者 crash / 超时 / 输出不可解析 / 凭证耗尽熔断（§11 I2）；**对称课税**（I-R4-1 裁决）：`tax_total = max(0, settle)×taxRate + Σ_i max(0, settle_i)×taxRate`（评审者正收益同税；税从 gross settle 内扣减——escrow 公式不变）；elo 新值；燃烧量；评审 `settle_i`。
- **effect 划付**：幂等 taskId（escrow 正向划付 / 负 settle 从执行者冻结直付发布方 / 税入池 / elo 双写 / 燃烧 / 事件 / 记忆沉淀触发——单事务）。
- **负 settle 流向**（C-2 钉死）：执行者 → **直付发布方**（escrow 只托管发布方资金，不经手负流）。
- **odds=1 退化**：settle=0 且 escrow=0——故意设计（义务性任务）。
- **errorMode 迁移**（C-3/M-4）：实施时 `config.settlement` 默认改 stakeOnly；`errorMode` 字段**标记废弃保留读取兼容**（忽略其值，行为恒 stakeOnly）；依赖 stakeTimesOdds 的既有 arena 测试同步更新；变更记入迁移说明。**unfreeze 事务包裹**（M-R4-3——实施任务清单项：`SqliteLedger.unfreeze` 加 `BEGIN IMMEDIATE`——现 SELECT→UPDATE→DELETE 三步裸奔，并发同 taskId 可双重解冻；flow effect 幂等已缓解，裸 API 需加固）。

## 7a 多评共识评审机制

**核心假设**：群体评价在平均尺度上总是正确的（含人类用户）——**中位数**为真实评价。

1. **评审 = 市场任务**：**stake_r 发布方统一声明**（评审押金——I-4：评审质量不由押注驱动，**选择 = 评审 elo 降序取前 N**（stake 常数 → SelectionFormula 纯 elo 序））；**N = 5**（默认，tunable）；评审者 bid 冻结 = `stake_r×(O_r−1)`（对称托管）。
2. **密封并行评价**：`r_i ∈ [0,1]` 互不可见；**互斥：执行者本人 + 同组织成员**（`org_members` 过滤）。
3. **共识计算**（code）：**`R = median(r_i)`**；**`a_i = 1 − |r_i − R|`**。
4. **评审者结算**：`settle_reviewer_i = stake_r × (O_r − 1) × (2a_i − 1)`（O_r 发布方声明，默认 2——**约束 `O_r ≥ 2`**（M-R4-2：O_r=1 零报酬零冻结退化禁止）；评审报酬从 escrow 出）。**评审者负 settle → 入中央池**（C-R4-1 裁决：评审偏差伤害市场信誉机制本身——公共性损害罚没社会化；与执行者负 settle 直付发布方不对称，因受害主体不同）。
5. **被评对象完成度 `c = R`** → 执行者结算与 elo。
6. **评审者 elo**：评审域 update（outcome = a_i）。
7. **校准任务锚定**（I6/I-6/I-3 裁决）：operator 注入**校准任务**（预设 ground truth——评审者不可辨识：任务结构与常规任务相同，标记仅在系统侧）；校准任务上：**评审者 `a_i` 按与 ground truth 的偏差计算**（非共识偏差）；**执行者 `c` 也由 ground truth 评估器直接评定**（评审者偏差不连坐执行者）；**校准比例 = operator 策略参数 `calibrationRate`（默认 10%）**——评审者不知哪些任务校准 → 任何偏差都有 p 概率被捕获（期望惩罚 ∝ p × elo 损失，威慑可量化）。**合成执行者 `calibration-executor`**（I-R4-2/M-R5-1/2/3/4 裁决：RESERVED_IDS 扩展——execute 节点**短路产出静态预制交付物**（无 LLM 调用、**不消耗凭证**）；**`stake_cal = 0`**（c=1 由 ground truth 保证，settle 与 escrow 项池内自抵——省略）；其 settle **直接入池**（operator 无利可图）；校准任务 escrow 来源 = 池（货币政策操作，审计可见）；**校准 O_r = 2**（与常规一致）；**注入点 = announce 步骤按 `calibrationRate` 概率替换常规任务**；校准事件带 `isCalibration: true` 标记（§8 审计可区分））。
8. **流标阶梯**（I12）：**N_min = 3**；评审激活 < N_min → 评审轮失败 → **重试 2 次**（escrow 保持）→ 仍流标 → **operator 兜底评审**（单评审，R = operator 评价）；**已接单少数评审者：stake_r 退还 + 凭证成本从 escrow 补偿**（voucherAllowance 覆盖）。
9. **递归终止**：共识偏差 + 校准任务双重评定——一层收敛。
10. **审计**：`economy.review_consensus` 含 R 与全部 r_i；观测层监控系统性偏差。

## 8 货币循环观测

- **事件流**：`currency.mint/burn/buy_voucher/transfer/tax/rate_adjust` / `economy.org_default/elo_update/review_consensus/escrow_freeze/escrow_adjust/escrow_release/bid_freeze/bid_release`——全量含双层记账字段。
- **投影报表**：发行量/流速/池余额/凭证存量与燃烧速率/物理↔credit 对账/elo 分布/评审准确性分布/校准偏差榜。只读投影。

## 9 记忆沉淀（结算事件驱动）

- **执行经验**：`场景=任务 动作=执行 结果=c=R 收益=settle(税后)`。
- **竞价经验**（含未中标）：`场景=竞价 动作=出价s 结果=中标/未中标(winner,stake)`。
- **评审经验**：`场景=评审 动作=评价r_i 结果=中位R 准确性a_i 收益=settle_i`（**校准任务上 `结果` 字段写 ground truth 并加 `evaluationMode: "consensus"|"ground-truth"`**——M-R5-6：防误导性经验）。
- **组织违约经验**（成员视角）。
- 经验 → 沉淀管道 → 规则化 → 发轫 → 审核链 → **onDecision → submitWriteBack**（公域规则演化闭环）。

## 10 C 接线包落地清单

1. attachSdk 真实钩子（runner `sdkExtensions`）；2. seqProvider 注入；3. onCheckpoint→dsp.snapshot 注册；4. inbox drainInto 拼接 task 前缀；5. delivery=auto 覆写；6. IdentityMap 装配注册+刷新回调；7. **DSP 两段拼接**；8. AssembleOptions 可选 agentId；9. removeAccount 提进 LedgerPort；10. startSweeper unref。

## 11 不变量与失败语义

- **I1 钱 fail-fast**；**I2 凭证耗尽 = 单节点失败**（partialFailures，按 majorError 结算）；compute 补结算失败 = 装配/run 拒绝。
- **I3 凭证单向**；**I4 保留 ID**；**I5 未注册类型无任务**；**I6 elo 单调可审计**；**I7 观测只读**。
- **I8 effect 幂等+原子**（flow_effects + 单事务）。
- **I9 评审独立**：执行者+同组织互斥；密封；校准不可辨识。
- **I10 双向托管**：escrow（发布方 max-loss）+ bid 冻结（执行者 max-loss）——一切赔付有冻结背书；escrow 冻结失败 = 发布拒绝；bid 冻结失败 = bid 拒绝。
- **失败语义**：fanout 分支隔离；effect 可重试；子图失败 → 组织交付失败处理（已发生垫付不逆转）；评审流标 → §7a.8 阶梯。

## 12 测试策略

- 零新增依赖；node:test；tmp+rename；import `.ts`。
- 货币：buy 事务原子/burn/耗尽单节点失败/FIFO/池流水；汇率三态；默认值钉死；burnHistory filter（traceId）。
- elo：数值钉死（1500/100/32/线性映射）；分域回退双写；公式注册替换。
- 选择：同分字典序；clamp 0.01；评审纯 elo 序。
- 托管：escrow 两阶段（上界冻结/调减解冻/拒绝）；bid 对称冻结（提交冻结/未中标解冻/负 settle 直付/majorError 划 stake）；双向余额不足拒绝。
- flow 扩展：fanout 快照/激活/no-op 不产元素/失败隔离/resume 静态；effect 幂等重试/单事务原子；subflow。
- 多评共识：median/a_i 数值钉死；互斥；**校准任务（评审者 a_i 按 ground truth + 执行者 c 按 ground truth）**；流标阶梯（含少数评审者保护）。
- 组织：垫付成功/凭证成本优先/违约链/利润为负/双重冻结资本需求。
- 观测：事件全量 + 投影重建一致性。
- 记忆沉淀：四类经验。
- 集成：多 agent 多轮竞价 bench demo——端到端货币循环 + **生存性冒烟**（100 credit 起步 agent 完成首次全流程）。

## 13 隐藏依赖与风险

- **ptl-flow 三扩展是最大工程块**——任务排序最先行。
- **凭证燃烧与遥测口径**：遥测 → 燃烧折算点。
- **elo 域爆炸**：稀疏存储；刷域 v1 不防。
- **合谋残余**：N=5+中位数+同组织互斥+校准任务四重防线；跨组织合谋靠公开竞价稀释+审计+校准捕获——文档化接受。
- **arena 遗留兼容**：OddsPolicy/SettlementPolicy/CostModel 默认族保留；EndowmentPolicyV1 K/price 废弃（flat 100；旧公式可选注册）；errorMode 迁移（§7）。
- **组织心智**：任意已注册 workloop；v1 不做治理模型。

## 14 非目标（v1）

- 凭证卖回/互兑/转让；破产清算；汇率自动调整；elo 加权共识（中位数先行）；灰色经济技术封锁；防刷机制（审计先行）；组织治理模型；PTH 侧部署；评审争议仲裁；跨组织合谋技术防范；校准任务比例的自动调节（operator 手动策略）。
