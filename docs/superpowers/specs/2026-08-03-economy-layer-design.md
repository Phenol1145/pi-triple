# 经济层（Economy Layer）设计 Spec

**日期**：2026-08-03
**状态**：设计定稿（brainstorm 决策已确认，待对抗性评审）
**父文档**：`docs/superpowers/2026-08-03-market-economy-overview.md`（决策记录 Q1-Q8 + 任务类型注册约束）
**依赖**：子项目 A（pit-flow 运行时扩展——code 节点/metrics，已合并）、B（记忆系统，已合并）、C（装配层，已合并）、arena 遗留（OddsPolicy/SettlementPolicy/CostModel）
**范围**：完整经济语义（Q1-B）——多货币 + 汇率 + elo + 任务类型注册 + 市场即 workflow + 组织 + 中央池 + 观测 + 记忆沉淀；保留优化器；elo 抽象化接口

---

## 0 设计语义（一句话）

**市场经济闭环跑通**：任务类型开放注册（行业自我生长）→ 市场即 workflow（竞价→执行→结算 = flow.json 图）→ f(stake, elo_domain) 选择 → 组织垫付制传导 → credit 流通 + 凭证配给 + 中央池货币循环 → 结算事件驱动记忆沉淀与 elo 演化——**分工、价格、信誉、组织全部从市场参与者的行为中长出**。

---

## 1 货币体系

### 1.1 两层结构

```
物理资源（token / 墙钟秒 / GB·天存储）
    ↑ 固定兑换比（凭证定义的一部分，不可调）
凭证（llm / time / compute）
    ↑ 浮动汇率（静态基准 + optimizer 动态修正系数）
credit（唯一流通货币）
```

- **credit**：唯一流通货币——竞价 stake、结算、税、统一计价单位。LedgerPort 既有语义（SqliteLedger）承载。
- **凭证（voucher）**：资源配给手段。三种：`llm`（token 配额）、`time`（墙钟秒）、`compute`（存储 GB·天——**记忆存储并入 compute**）。
  - **锚定物理量**（定义常量，固定）：`llm 1 unit = 1M tokens`（in+out blended）；`time 1 unit = 3600s`；`compute 1 unit = 1 GB·天`。
  - **只能以 credit 向中央购买**（单向——不可卖回、凭证间不互兑、v1 不可转让）。
  - **凭证耗尽 = 物理停机**（§11 失败语义）。
  - 汇率调整语义：**已消耗不变；持仓物理量不变（credit 计价浮动）；新购按新价**。

### 1.2 汇率

`ExchangeRateTable`：`{ creditPerUnit: { llm, time, compute } }`——静态基准（配置）× 修正系数（optimizer tunable，初值 1.0）。汇率调整 = operator 显式操作（事件审计 `currency.rate_adjust`），观测信号 = §8 双账对账。

### 1.3 双层记账

每次资源消耗事件记两笔：**物理量**（不可改写）+ **credit 折算值**（购买时汇率加权平均的历史成本）。物理账与 credit 账的**比率变化 = 真实资源相对价格信号**（观测层对账）。

### 1.4 VoucherPort（新抽象，独立于 LedgerPort）

凭证与 credit 语义不同（单向购买 + 燃烧，不流通）→ 独立 port：

```ts
interface VoucherPort {
  buy(agentId: string, kind: VoucherKind, units: number): void;    // credit 扣款（经 LedgerPort debit，入中央池）+ 凭证入账
  balance(agentId: string, kind: VoucherKind): number;
  burn(agentId: string, kind: VoucherKind, units: number, cause: BurnCause): void; // 消耗（物理量 → units 折算）
  burnHistory(agentId: string, kind: VoucherKind): BurnRecord[];   // 双层记账源
}
type VoucherKind = "llm" | "time" | "compute";
type BurnCause = { traceId: string; transitionSeq: number } | { periodic: "memory-storage" };
```

`buy` 内部 = `ledger.debit(agentId, cost, "voucher-purchase")` + 池 credit（§2）+ 凭证余额入账——**credit 不足 → debit 抛错（fail-fast，钱的事）**。默认实现 `SqliteVoucher`（`voucher_balances` / `voucher_burns` 表）。

### 1.5 消耗计量

- **llm**：每转移按遥测 `tokensIn + tokensOut` 折算 units 燃烧（BurnCause = 转移定位）。
- **time**：每转移按墙钟耗时折算。
- **compute（记忆存储）**：**周期结算**（每日或每 N 转移，配置）——私域记忆条目总字节 × 持有天数折算 GB·天（BurnCause = periodic）。**这给出记忆的真实持有成本 → 遗忘/压缩的经济动机**（总原则 6）。
- 历史成本折算：凭证入账记录购买批次 `(units, creditPerUnit)`；燃烧按 FIFO 折算 credit 成本（报表层）。

## 2 中央池（Central Pool）

- 实现 = operator 持有的特殊账本账户（`agentId = "central-pool"`，**禁止参与市场竞价/被装配为 AgentRuntime**——制度约束，装配器校验拒绝）。
- **入池**：税（结算正收益 × taxRate）、凭证销售收入。
- **出池**：endowment（新 agent 装配开户——既有 `K/price` 公式保留为默认 EndowmentPolicy）。
- **允许赤字**：余额可为负（赤字货币化——观测层可见，不隐藏超发）。
- 全部流水进事件流（§8）。

## 3 elo 系统

### 3.1 抽象接口（用户要求：elo 计算抽象化）

```ts
interface EloFormula {
  readonly id: string;                       // 语义名（注册表 key）
  initial(context: { isOrg: boolean }): number;
  update(rating: number, ctx: EloUpdateContext): number;
}
type EloUpdateContext = {
  taskRating: number;       // 任务难度分（odds → 分映射，OddsPolicy 扩展职责）
  outcome: number;          // 对局得分 = 完成度 c ∈ [0,1]（majorError → 0）
  weight?: number;          // 预留（组织内部结算权重等）
};
```

默认实现 `simple-elo`：`R' = R + K × (outcome − 1/(1+10^((taskRating−R)/400)))`，K tunable（默认 32）。注册表 = 项目 RegistryPattern 同构（`EloFormulaRegistry`，可注册 Glicko-2 等替代实现——实验时经 optimizer canary 对比）。

### 3.2 作用域：全局 + 分域（Q6-B）

- 存储：`AgentInstance.eloGlobal: number` + `AgentInstance.eloByDomain: Record<taskTypeId, number>`（repository 扩展列，N-I9 迁移模式）。
- **回退链**：选择时取 `eloByDomain[taskType] ?? eloGlobal`。
- 更新语义：**结算同时更新域分与全局分**（域分以该域当前分（回退值）为起点更新；全局分同步以全局分为起点更新——一次结算两次 update）。
- 组织与个人各自持分（组织作为主体的结算 → 组织 elo；成员结算 → 成员 elo）。

### 3.3 选择函数（SelectionFormula 注册表）

```ts
interface SelectionFormula {
  readonly id: string;
  score(candidate: { stake: number; elo: number /* 已回退解析 */ }, ctx: { taskRating: number }): number;
}
```

默认 `stake-elo-power`：`score = stake^α × norm(elo)^β`（`norm(elo) = elo/1500` clamp 下限 0.1；α/β tunable 默认 1.0/0.5）。**选择 = score 最高者**（code 节点确定性内核——同分按 stake 高者，再按提交时序）。

## 4 任务类型注册表与信息/任务分离

### 4.1 任务类型开放注册（行业自我生长）

```ts
type TaskType = {
  id: string;                 // 语义名（"code-review" 等；注册后不可变）
  description: string;
  baseDifficulty?: "easy" | "medium" | "hard";  // OddsPolicy 查表缺省
  registeredBy: string;       // agentId | "operator"
  createdAt: number;
};
interface TaskTypeRegistry { register(t: TaskType): void; get(id: string): TaskType | undefined; list(): TaskType[]; }
```

- **开放注册**（任何 agent/operator——kind 哲学同构）；重复 id 注册 = 幂等 no-op（返回既有）。
- **任务发布强制带已注册类型**——未注册类型市场**拒收**（`Market.publish` 校验抛错：先注册后发布）。
- **类型注册 = elo 赛道自动创建**（§3.2 域 key 生效）；agent 承接声明（`AgentInstance.accepts: string[]`——装配/运行时注册）= 进入赛道（v1 语义：elo 域分激活 + 竞价自我定位；任务路由保持公开竞价）。

### 4.2 信息传递 vs 任务发布：制度性分离

- **通讯系统（comms）只承担信息传递**；**市场系统只承担任务发布**——通道各自纯净。
- **执行方式 = 制度而非封锁**：私下约定（消息夹带任务）技术上不可禁也不必禁（灰色经济）——体制承诺：**仅市场内交易享有 elo 计分 / 结算保障 / 税收保护 / 违约罚没**。市场通道不传递自由文本协商（任务描述 = 结构化契约）。

## 5 市场即 workflow（Q2-A）

### 5.1 竞价流程 = flow.json 图

```
announce（发布任务，code 节点：持久化任务记录）
  → collect_bids（动态扇出：对每个候选 agent 并行执行 bidding workloop → stake）
  → select（code 节点：SelectionFormula f(stake, elo_domain) → winner）
  → execute（workloop 节点：中标者 AgentRuntime.run）
  → evaluate（评分节点：scorer/对照评估 → completion/majorError）
  → settle（code 节点：结算 + 税 + elo 更新 + 凭证计量 + 货币事件 + 记忆沉淀触发）
```

### 5.2 pit-flow 引擎新需求（本子项目的基础设施任务）

1. **动态扇出节点**（`type: "fanout"`）：输入 = 候选列表（运行时才知道数量）；对每元素并行执行子流程（bidding workloop 调用）；聚合结果数组。失败隔离：单个 bidder 失败（凭证耗尽/超时/拒答）→ 该分支 stake=null（不参与选择），**不中断流程**。
2. **子图节点**（`type: "subflow"`）：flow.json 引用另一 flow.json（嵌套市场的表达——组织的内部市场 = 子图实例）。参数传递：子图输入/输出映射声明。
3. **workloop 节点**：绑定 AgentRuntime 执行（既有 workloop 节点语义扩展到 AgentRuntime.run——agent 引用 + task 注入 + 结果回收）。

### 5.3 嵌套市场 = 子图节点

组织对外中标后，其 workloop 决策发起**内部市场**（子图实例——同一市场 flow 定义，scope = 组织成员候选集）。子图结算完成后结果回传父图（组织的交付物 = 子市场产出的汇总）。

## 6 组织（Organization = AgentInstance）

- 组织 = 持久 AgentInstance（自己账本 / 记忆域 / workloop 决策循环 / elo）——装配路径与个人相同（Assembler），差异仅在配置（`isOrg: true` + `members: string[]` 成员关系表 `org_members`）。
- **对外**：单一出价节点（bidding workloop 跑在组织上下文——组织心智决策 stake）。
- **对内**：内部子市场（§5.3）；成员 = 独立经济主体（自己账本/凭证/elo）。
- **垫付制结算传导**（Q7-B）：
  1. 成员交付 → 评估（c_member）→ **组织立即垫付结算成员**：`ledger.debit(org, payout)` / `credit(member)`；
  2. **垫付失败（余额不足）→ debit 抛错 → 组织违约事件**（`economy.org_default` 审计 + 组织 elo 受损（按 majorError 更新）+ 成员 stake 退还、无收益——成员私域写入组织经验（"付不出钱"））；
  3. 组织汇总对外交付 → 外部结算 → **组织利润 = settle_org − Σpayouts − 税**（可为负 → 消耗留存）；
  4. 余额耗尽 = 无法押注 = 市场自然出局（破产机制 v1 不做）。
- 成员执行**烧自己的凭证**（凭证不可转让——组织不配给生产资料）。

## 7 结算（Settle 节点语义）

code 节点确定性内核（输入全在图中显式传递）：
1. **结算**：`settle = stake × (O−1) × (2c−1)`（既有线性式保留；majorError → `−stake`（stakeOnly 模式））；负收益直接扣（冻结 stake 划转），正收益 = 发布方 credit 划付。
2. **税**：`tax = max(0, settle) × taxRate`（亏损不课税）→ 中央池。taxRate tunable。
3. **elo 更新**：§3（域分 + 全局分；组织违约按 majorError 更新组织 elo）。
4. **凭证计量**：执行期遥测折算燃烧（§1.5）——run 开始时**预检**（余额 > 0），run 中**按转移燃烧**，耗尽 → §11。
5. **货币事件**：§8 全量发射。
6. **记忆沉淀触发**：§9。

## 8 货币循环观测

- **事件流**（lab_events 既有基础设施）：`currency.mint`（endowment/凭证发行）/ `currency.burn`（凭证燃烧）/ `currency.buy_voucher` / `currency.transfer`（结算划付/垫付）/ `currency.tax` / `currency.rate_adjust` / `economy.org_default` / `economy.elo_update`——全量含双层记账字段（物理量 + credit 折算）。
- **投影报表**（context-projector 模式复用）：发行量 / 流通速率 / 池余额 / 凭证存量与燃烧速率 / **物理账 ↔ credit 账对账**（资源相对价格信号）/ elo 分布。报表 = 只读投影（可重放重建）。

## 9 记忆沉淀（结算事件驱动）

- **执行经验**（中标者）：结算事件 → 经验条目（语义行：`场景=任务<id/类型> 动作=执行 结果=完成度c/majorError 收益=settle(税后)`）→ 经 MemoryHost.write 入私域（契约接线——attachSdk 真实钩子落地）。
- **竞价经验**（全部出价者含未中标）：`场景=竞价<任务> 动作=出价s 结果=中标/未中标(winner, 其stake)` → 入私域。
- **组织违约经验**（成员视角）：§6。
- 经验 → 沉淀管道（既有）→ 规则化 → 发轫 → 审核链 → **onDecision → submitWriteBack 组合链接线**（本任务落地 C 接线包最后一环——公域规则演化闭环）。

## 10 C 接线包落地清单（本子项目完成）

1. attachSdk 真实钩子：runner `buildSDK` 加可选扩展点（`sdkExtensions: (base) => Partial<WorkLoopSDK>`），AgentRuntime 注入 `memory/comms`；2. seqProvider 注入；3. `runner.onCheckpoint(({seq}) => host.dsp.snapshot(seq))` 注册；4. inbox drainInto 片段拼接进 `run({task})` 前缀；5. `delivery=auto` 装配绑定时覆写；6. IdentityMap 装配注册 + session 刷新回调；7. **DSP 两段拼接**（私域段 + 公域段——DspBuilder 接提示词路径前必完成）；8. AssembleOptions 增可选 `agentId`（崩溃续跑恢复生产可达）；9. removeAccount 提进 LedgerPort 接口；10. `startSweeper` `timer.unref()`。

## 11 不变量与失败语义

- **I1 钱 fail-fast**：一切 credit/凭证不足 → debit/burn 抛错，不静默垫付（组织垫付失败 = 违约事件，非静默）。
- **I2 凭证耗尽 = 停机**：run 中 llm 凭证耗尽 → 熔断（停止执行，按 majorError 结算——自己没买好凭证 = 自己的责任）；time/compute 耗尽同理（compute 耗尽 → 私域写入拒绝 → 记忆沉淀失败事件）。
- **I3 凭证单向**：无卖回/互兑/转让路径（代码层无 API）。
- **I4 中央池非市场主体**：装配器拒绝以 central-pool 装配 AgentRuntime。
- **I5 未注册类型无任务**：Market.publish 校验。
- **I6 elo 单调可审计**：elo 更新只经结算事件（`economy.elo_update` 全量可重放）。
- **I7 观测只读**：报表为投影，不回写。
- **失败语义**：bidder 扇出分支失败隔离（§5.2）；结算节点幂等（flow 引擎 at-least-once → 结算以 taskId 幂等键防重复划付）；子图失败 → 父图按组织交付失败处理（垫付义务已发生的部分不逆转——违约链条见 §6）。

## 12 测试策略（沿用既定模式）

- 零新增依赖；node:test；tmp+rename；import `.ts`。
- 货币：VoucherPort 全路径（buy/burn/耗尽停机/FIFO 历史成本/池流水）；汇率调整三态（已消耗/持仓/新购）。
- elo：默认公式数值钉死（已知输入 → 期望分）；分域回退；组织/个人分立；EloFormula/SelectionFormula 注册替换。
- 任务类型：注册幂等/发布校验/赛道自动创建。
- 市场 flow：动态扇出失败隔离/子图嵌套/settle 幂等（重复触发不重复划付）。
- 组织：垫付成功/垫付失败违约链/利润为负/成员凭证自负。
- 观测：事件全量 + 投影重建一致性。
- 记忆沉淀：结算后私域条目存在性（执行/竞价/违约三类）。
- 集成：多 agent 多轮竞价 demo（bench）——端到端货币循环可观测。

## 13 隐藏依赖与风险

- **动态扇出/子图是 pit-flow 引擎的结构性扩展**（子项目 A 未覆盖）——最大工程风险，任务排序上最先行。
- **凭证燃烧与遥测的口径**：tokensIn/tokensOut 遥测必须可靠到达 settle 节点（MachineRuntime 遥测链已有；缺口 = 遥测 → 凭证燃烧的折算点）。
- **compute 周期结算的时钟**：周期任务宿主（谁触发每日结算——v1：装配层的 TTL sweeper 同族周期钩子，或 run 开始时检查上次结算点）。
- **elo 分域的域爆炸**：任务类型开放注册 → 域无界增长；byDomain map 稀疏存储即可，观测层警惕刷域（注册大量类型刷赛道——v1 不防，观测审计可见）。
- **arena 遗留兼容**：OddsPolicy/SettlementPolicy/CostModel 保留为默认实现族（V1 语义扩展税/凭证——不破坏既有 arena 测试基线）。
- **组织 workloop 的"心智"从哪来**：组织装配绑定的 workloop = 任意已注册定义（pi-default-loop 即可——组织决策 = LLM 跑在组织记忆/账本上下文）；v1 不做专门的"组织治理模型"。

## 14 非目标（v1）

- 凭证卖回/互兑/转让；破产清算机制；汇率自动调整（optimizer 只调修正系数，调整动作 = operator 显式）；灰色经济的技术封锁；elo 防刷机制（观测审计先行）；组织治理模型（章程/投票）；PTH 侧市场部署。
