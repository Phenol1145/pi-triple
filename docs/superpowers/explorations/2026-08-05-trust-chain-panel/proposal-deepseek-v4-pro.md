# 信任链形式化提案 —— deepseek-v4-pro

**多模型会谈 Round 1 · 独立提案**
**输入**：联邦骨架概念模型 v1.0 §7 + 既存代码基线（memory/assembly/economy）
**日期**：2026-08-05

---

## 1. 形式化定义

### 1.1 核心定义

**信任链（Trust Chain）** 不是单一数据结构，而是 **收敛证成结构（Convergent Attestation Structure）** 的统一抽象——由三类实体组成的**有向无环超图（directed acyclic hypergraph, DAH）**：

```
信任链 := (N, E, M, V)
其中：
  N = 数据节点集（被担保的数据项——条目、结果、规则、构件）
  E ⊆ N × N × 证据类型（担保边：n₁ → n₂ 表示 n₁ 为 n₂ 的可靠性提供某类证据）
  M ⊆ N（元信任对象子集——自证/无需外部担保的节点，|M| 极小）
  V = 验证函数集（每条边有对应的验证规则，返回 {valid, invalid, unknown}）
```

**收敛条件**：∀ n ∈ N \ M，存在至少一条路径 n → … → m ∈ M，且路径上每条边 e 的 V(e) = valid。

**关键性质**：
- **声明式**（已决属性）：信任链是**可审计记录**，不在构件生效前强制拦截至 M——即"链无效"≠"操作被拒绝"；无效链仅意味着审计时发现担保缺口（与 spec §7.2 一致）
- **多根收敛**：不同语境/命题类型收敛到不同的元信任对象（非单一全局根）
- **语境多态**：边类型 E 和验证函数 V 取决于被担保的命题类别
- **非传递**：A → B 且 B → C 不蕴含 A → C（除非显式声明传递边）——信任不具备自动传递性

### 1.2 为什么是超图而非简单链/树/DAG

| 结构 | 够用吗？ | 理由 |
|---|---|---|
| 链（linear chain） | ❌ | 多源证据无法合并（如审核链 quorum 表决） |
| 树（tree） | ❌ | 一个节点可被多方同时担保（agent 审查 + operator 否决 + 市场结算 = 三源独立证据） |
| DAG | 部分够用 | 但"一条边连接多个源到一个目标"的 n-ary 担保关系（如 quorum 过半数方有效）无法用二元边表达 |
| **超图（DAH）** | ✅ | 超边 E ⊆ P(N) × N（多个担保者联合担保单个目标），quorum 语义天然建模 |

### 1.3 操作化：什么是"链成立"

给定命题 P（例如"条目 e 可解析"、"条目 e 描述的信息可信"、"结果 r 正确"），其信任链 **成立** iff：

1. **可达性**：从承载 P 的数据节点出发，沿担保边可达到至少一个元信任对象 m ∈ M
2. **边有效性**：路径上每条边通过其类型对应的验证函数 V
3. **时间一致性**：路径上所有担保的时间戳单调非减（担保不得晚于被担保者——防止事后补链）
4. **无环**：路径不自交（DAH 的无环性约束）
5. **完整性**（语境相关）：某些语境要求**所有**可达路径均有效（如全票决 quorum），另一些要求**至少一条**路径有效（如引用链任一有效锚点即通过）

**不成立时**：产生 **信任缺口（trust gap）** 审计记录——缺口本身是声明式的（不阻断操作），但可作为回退触发信号（如回退节点 §1.8 的触发条件③"图异常静默"可扩展为"信任缺口累计超阈值"）。

---

## 2. 结构

### 2.1 链的组成元素

| 元素 | 定义 | 实例 |
|---|---|---|
| **被担保者（Guaranteed）** | 承载待证命题的数据节点 | 一条 memory entry、一个 WorkLoopResult、一个构件（update-package） |
| **担保者（Guarantor）** | 为被担保者提供证据的数据节点 | 一条 rule entry、一个 sourceTraces 条目、一张审核表决票 |
| **证据（Evidence）** | 担保边携带的证明载荷 | 校验通过的语法树（rule→entry）、traceId+transitionSeq（source→entry）、审核票数组（quorum→delta）、结算计划（settlement→result） |
| **元信任对象（Meta-trust Object）** | 不需外部担保的根节点——自证 | axiom（kind=axiom, id="axiom"）、系统宪法（system graph law）、物理锚定凭证（voucher burn record） |
| **验证函数（Verifier）** | 判断边是否有有效的规则 | EBNF 解析+语法校验、watermark 时序校验、quorum 阈值校验、elo 阈值校验 |

### 2.2 担保边的证据类型（三类基本边）

```
边类型              符号           含义                            验证函数
─────────────────────────────────────────────────────────────────────────
结构担保边          →_struct       "n₁ 的语法规则约束 n₂ 的形式"    EBNF 编译成功 + 语法匹配
溯源担保边          →_provenance   "n₁ 是 n₂ 的产生来源"           n₁.status=official + watermark(n₁) ≤ watermark(n₂)
共识担保边          →_consensus    "n₁ 所在的群体表决担保 n₂"       quorum 达标 + operator 未否决
经济担保边          →_economic     "n₁ 的经济结算结果担保 n₂"       settlement.success + elo ≥ 阈值 + 无 majorError
宪法担保边          →_constitutional "n₁ 是宪法授权的治理行为"       n₁ 的治理权限链可达宪法节点
```

### 2.3 元信任对象的三层分类

```
L0 · 逻辑自证（结构层）：axiom（kind=axiom，无 ruleRef，自我指涉豁免）
     — 担保命题：一切 memory entry 的结构可解析性
     — 锚定代码：entry.ts isAxiom(), rules.ts validateContent() 对 axiom 返回 []

L1 · 物理自证（现实层）：voucher burn record（凭证销毁记录——token/时间/存储已实际消耗）
     — 担保命题：计算行为真实发生（非凭空伪造）
     — 锚定代码：voucher-port.ts burn() → voucher_burns 表；BurnCause = {traceId, transitionSeq}

L2 · 宪法自证（治理层）：系统计算图法律（constitution，设计者预置，不可修改——§1.7/A4）
     — 担保命题：治理行为的合法性（谁有权立法/接管/冻结）
     — 锚定概念：spec §1.7 法律不可修改性 + A4 顶层自治理公理
```

三层形成自举闭环：**L0 担保"说得通"→ L1 担保"真做了"→ L2 担保"有权做"→ L0 定义 L2 的表述形式**。

### 2.4 验证语义细化

验证函数 V: E → {valid, invalid, unknown} 的判定依据：

- **valid**：所有必要证据存在且通过规则检查
- **invalid**：证据存在但检查失败（如 EBNF 编译错误、watermark 倒置、quorum 不达标）
- **unknown**：证据不完整但尚未失败（如审核窗口未关闭、结算未完成、引用链中间断裂但旁路未穷尽）——unknown 是合法中间态，允许异步补全

**unknown → valid/invalid 的决议时机**：由回退节点的超时参数 T_block/T_silence 约束（spec §1.8）——unknown 持续超时 → 触发回退。

---

## 3. 与联邦骨架的关系

信任链不是联邦骨架的**独立实体**（spec §1.9 已明确"横切关切，非独立实体"），而是渗透到几乎所有骨架概念中的**横切担保语义层**。

### 3.1 与治理/法律的关系

```
法律（Law）规定了"谁有资格担保什么"的规则
  │
  ├── 结构担保边 → 法律 ≅ 规则链的顶层约束（rule 的 ruleRef 链最终引用宪法授权）
  ├── 共识担保边 → 法律定义了 quorum 阈值/代表数/窗口时间（audit-chain 的 AuditConfig）
  └── 经济担保边 → 法律定义了市场参数（stake, odds, tax rate）——settlement 结果的法律基础
```

**关键交互**：法律是信任链的**资格框架**——没有法律规定"谁可以担任担保者"，担保边即使技术上可构造也缺乏治理合法性。这与 spec §1.7"法律是治理节点在创立运行图时施加的约束"一致：法律定义了受治理图内节点的**最大担保权利**（谁可以担保谁）。

### 3.2 与构件/部署的关系

spec §4.2："构件 → 信任链验证 → 填槽生效"。这里存在一个微妙的设计张力：

- **已决**：信任链是声明式（非强制拦截）
- **但**：部署生效是强制动作（构件填槽后系统行为改变）
- **矛盾**：如果信任链验证不通过但部署仍生效，信任链的审计价值何在？

**提案的解决**：信任链验证结果分两级：
- **审计级**（声明式，记录但不拦截）——总是产出审计记录
- **部署级**（强制，但仅检查结构担保边 →_struct 的有效性——即"构件是否可解析/格式合规"）——这是最小必要检查，对应 memory pipeline 的 validateEntryStructure + rules.validateContent，已在代码中强制

即：**结构担保是部署门槛（已实施），其余担保边是审计追认（声明式）**。这样既保持了 spec 的声明式裁决，又不让部署变成"盲目信任"。

### 3.3 与回退节点的关系

信任链缺口（unknown 持续超时或 invalid 积累）→ 回退触发条件③"图异常静默"的可检测子类：

- 回退节点可监控所在图的信任链健康度（累计 invalid 边数、unknown 持续时长）
- 信任链恶化到阈值 → 回退节点将此作为"图无法自处理的问题"向上透传
- 这是回退触发条件③的自然扩展（不需新增宪法级触发，在图法律追加条款中定义即可）

### 3.4 与责任⇄权利的关系（A2 公理）

信任链是 A2 平衡的**审计工具**：

- **责任⇄额度**（经济机制执行）：信任链记录了"谁消耗了多少额度完成了什么任务"——sourceTraces + settlement plan 形成完整的额度假定链
- **责任⇄权限**（法律机制约束）：信任链记录了"谁的权限授权了谁的操作"——治理权限的宪法担保边 →_constitutional 记录了权限下传链

信任链不执行平衡（那是 economy 和 law 的职责），但提供平衡的**可审计证据**。一个不平衡的节点（责任大权利小或反之）会在信任链上暴露证据缺口。

### 3.5 与公理系统的关系

| 公理 | 信任链的角色 |
|---|---|
| A1（资源限制） | L1 物理自证（voucher burn）是"资源确实消耗了"的唯一不可伪造证据 |
| A2（责任⇄权利平衡） | 信任链是平衡的审计载体（见 §3.4） |
| A3（治理是计算任务） | 治理行为的信任链记录了"立法消耗了谁的额度"——防止治理免费化 |
| A4（顶层自治理） | L2 宪法自证——系统图法律是治理权限链的终极元信任对象 |
| A5（图生图） | 实例计算图的信任链引用所属系统计算图的法律节点——纵向担保 |

---

## 4. 实例化模式

### 4.1 语境①：记忆条目可解析（"每条目必须可解析"）

**命题**：条目 e 的 content 符合其声明的语法规则——"e 是可解析的"。

**信任链构造**：

```
e (fact/experience/preference)
  │  →_struct (ruleRef = rule_id)
  ▼
rule (kind=rule, content=EBNF)
  │  →_struct (ruleRef = parent_rule_id)
  ▼
parent_rule
  │  →_struct (逐级上溯)
  ▼
...
  │  →_struct
  ▼
axiom (kind=axiom, id="axiom", 无 ruleRef)  ← L0 元信任对象
```

**验证语义**：
1. 对每条边 rule →_struct child：取 rule.content 编译为 EBNF 语法 → 用语法校验 child.content → 匹配成功 = valid
2. 递归到 axiom：axiom 的 validateContent 固定返回 []（isAxiom 豁免——代码锚定 `rules.ts:207`）
3. 链成立 = 路径上每条边 valid + 终点是 axiom

**既存代码锚定**：
- `entry.ts:75`：`kind !== "axiom" → ruleRef 必须存在`
- `rules.ts:203-233`：`validateContent()` 走 ruleRef → resolveRule → parseEbnf → validateAgainstGrammar
- `rules.ts:207`：`isAxiom(entry) → return []`（元信任终止）

**与 spec §7 的一致性**：spec 表记"元信任对象 = rule 链 + base"——base 即 axiom。

### 4.2 语境②：记忆信息可信（"每条目描述的信息可信"）

**命题**：条目 e 描述的事实/经验/偏好与其来源一致——"e 的信息是可信的"。

**信任链构造**：

```
e (目标条目: status=official)
  │  →_provenance (sourceTraces: [{traceId, transitionSeq}, ...])
  ▼
e_source₁ (被引用的源条目: status=official, watermark ≤ e.watermark)
  │  →_provenance (sourceTraces: [...])
  ▼
e_source₂
  │  ...
  ▼
pipeline 原始观察 (buffer.jsonl 中的 observe 记录)
  │  ← 物理锚定：观测行为发生的确凿证据
  ▼
L1 元信任对象：voucher burn record（观测/写入消耗的 token/time 凭证已实际销毁）
  或 L2 元信任对象：pipeline 自身由宪法授权的 agent 运行
```

**验证语义**：
1. sourceTraces 中的每个 `{traceId, transitionSeq}` 可解析到实际存在的源条目
2. 源条目 watermark ≤ 目标条目 watermark（时间因果——`pipeline.ts:166` 中 sourceTraces 是追加语义）
3. 源条目 status = official（草稿/归档不得作为可信来源——除非显式标记 promotedFrom）
4. 最终锚定到 L1（物理消耗证据）或 L2（宪法授权的观测者）——**二选一即可**，非两者都要

**既存代码锚定**：
- `pipeline.ts:165-169`：write 成功时 sourceTraces 追加当前 `{traceId, transitionSeq}`
- `pipeline.ts:207`：promote 时草稿 sourceTraces 并入正式条目
- `entry.ts:21`：`sourceTraces: SourceTrace[]` 类型定义
- `store.ts`：watermark 经 checkpoint seq 全局单调

**与 spec §7 的一致性**：spec 表记"引用链 + append-only"——sourceTraces 即引用链，append-only 由 pipeline 的 `buffer.jsonl`/`idem.jsonl` 追加语义保证。

### 4.3 语境③：计算结果可信（"每个节点的计算结果可信"）

这是三个语境中最复杂者，因为"正确性"在分布式系统中无绝对定义。

**命题**：节点 n 的计算结果 r（WorkLoopResult）是可信的——即"r 是在给定约束下联邦可接受的最优/合规输出"。

**核心困难**：计算结果不同于记忆条目——它没有"语法可解析性"那样的客观真值。计算正确性在联邦中通过**多层收敛**定义：
- 单次计算可能出错（模型幻觉、工具调用失败）
- 但联邦通过 market-runner 的 execute→review→consensus→settle 相位流，将"正确性"转化为"市场接受的结果"
- **正确性 ≅ 被市场通过经济结算接受的结果**（而非绝对正确性）

**信任链构造**（多维度并行，非单链）：

```
r (WorkLoopResult: status=completed)
  │
  ├── →_provenance (execution trace):
  │     模型调用序列 {model, prompt, response, usage} + 工具调用序列 {tool, args, result}
  │     → L1 元信任：每次模型/工具调用的 voucher burn record
  │
  ├── →_consensus (review quorum):
  │     审核链 vote 数组 → auditor₁, auditor₂, ..., auditorₙ
  │     表决结果（approve/reject/veto）+ quorum 达标性
  │     → L2 元信任：审核配置 (AuditConfig) 由所在图法律授权
  │
  ├── →_economic (settlement outcome):
  │     settlement plan: {R, accuracies, executorSettle, reviewerSettles, tax}
  │     escrow 划付/负流 + elo 双写增量
  │     → L1 元信任：stake 冻结/解冻/罚没的 ledger 记录（经济资源真实流动）
  │     → L2 元信任：市场参数 (stake, odds, tax) 由所在图法律设定
  │
  └── →_constitutional (governance authorization):
        治理权限链：执行 agent 的身份 → 所在图治理节点 → … → 系统图治理节点 → 宪法
        → L2 元信任：宪法（系统图法律——设计者预置，不可修改）
```

**元信任对象确定（待定→本提案明确回答）**：

计算结果的元信任对象是**双层锚定**：

| 层 | 元信任对象 | 担保什么 | 为何不可再追问 |
|---|---|---|---|
| **L1 物理层** | voucher burn record（凭证销毁记录的 append-only 日志） | "计算确实发生了，消耗了真实资源" | 物理锚定（token/时间/存储已消费 = 不可逆事实） |
| **L2 治理层** | 宪法（系统计算图法律）中的任务类型 clauses | "这个计算是合法授权的" | 宪法不可修改（spec §1.7/A4）——无更高权威可再授权 |
| **L2 经济层** | 宪法预设的市场参数（stake/odds/tax） | "经济结算结果是最终裁决" | 市场参数由宪法设定——"市场说了算"本身就是宪法的选择 |

**验证语义**：
1. **执行踪迹**：voucher burn 记录匹配模型/工具调用的声称消耗量（± 容忍偏差）
2. **共识**：审核链 approve() 返回 true（agent 侧 quorum 达标 + operator 未否决）
3. **结算**：settlement 无 majorError（否则 stake 全损）→ 结算成功意味着市场认可结果
4. **授权**：执行 agent 的治理权限链可达宪法

**全链成立条件**：任一维度成立即可判定为"可信"（OR 语义，非 AND）——不同使用场景选择不同维度：
- 高风险任务 → 要求全部四维度成立（经济+共识+踪迹+授权）
- 低风险任务 → 仅经济维度成立即可（市场结算通过 = 可信）
- 实时审计 → 仅授权维度成立即可（"有权做即可信"——等同于当前行为，审计链为事后追认）

**既存代码锚定**：
- `market-runner.ts`：execute→review→consensus→settle→apply_settlement 相位流
- `audit-chain.ts`：submit→vote→approve 审核链
- `settlement.ts`：planSettlement 产出 SettlementPlan
- `elo.ts`：双写 eloGlobal + eloByDomain
- `voucher-port.ts`：buy/burn → voucher_burns 表
- `assembler.ts`：agent 装配时 ledger.open + identityMap.set → 身份/授权初始锚定

---

## 5. 关键分歧点自陈

以下是在写本提案过程中识别的最可能有争议的问题——为 Round 2 交叉对抗准备。

### D1. 信任链是"一个东西"还是"三个东西"

**本提案立场**：是三个语境相关的变体，由统一抽象（收敛证成结构）定义，但不共享单一实现类型。

**对立可能立场**：部分模型可能主张"信任链应当是单一可序列化类型"——如 `type TrustChain = { root: MetaTrustObject; edges: TrustEdge[] }` 对所有语境统一。

**争议焦点**：统一类型的工程收益（可序列化/可传输/可标准化） vs. 语境差异的语义保真度（三种链的边类型、验证规则、元信任对象完全不同）。

### D2. 计算结果元信任对象的"经济中心主义"

**本提案立场**：计算结果可信 ≅ 被市场通过经济结算接受——即"正确性 = 市场共识"。

**对立可能立场**：
- **宪法中心主义**：元信任对象是宪法本身（"宪法说谁对谁就对"）
- **加密中心主义**：需要密码学签名/零知识证明（但 spec 约束"零新增依赖/node 内建约束"排除了复杂密码学）
- **不可知论**：计算结果本身不可信，只能信审计结果的事后可验证性

**争议焦点**：经济结算（market settlement）是**事后验证**（任务完成后才已知"对错"），不是**事前担保**。如果结算本身依赖信任（谁结算？结算者对吗？），则存在循环——本提案用"宪法预设市场参数"打断此循环，但这等价于说"我们信任宪法设定的市场机制"——这又回到了宪法中心主义。

### D3. 声明式与部署强制的边界

**本提案立场**：结构担保边（→_struct）作为部署门槛（强制），其余担保边声明式。

**对立可能立场**：
- 所有担保边全声明式（部署零门槛——真正的"声明式"）
- 经济担保边也强制（未通过结算的结果不得作为下游输入——但这已有 economy 机制执行，不需信任链重复）
- 需要一个新概念"信任等级"来决定哪些是强制、哪些是声明式

**争议焦点**：如果"结构担保是部署门槛"，那它和 spec §7.2"声明式（非强制拦截）"是否矛盾？本提案认为不矛盾——因为结构担保在 memory pipeline 中已经强制（validateEntryStructure + validateContent），只是此前未命名为"信任链的一部分"。问题的实质是：**哪些既存的强制校验应当被纳入"信任链"概念**。

### D4. 信任链的"不可伪造性"从何而来

**本提案立场**：不可伪造性来自三层锚定，非来自信任链自身：
- 结构不可伪造：EBNF 编译是确定性函数——恶意规则无法通过编译
- 溯源不可伪造：append-only 文件 + watermark 单调——事后插入会被时序检测
- 经济不可伪造：ledger 的 debit/credit 是资源真实流动——凭空造余额会被余额校验拒绝
- 授权不可伪造：宪法不可修改 + 治理权限链可达性——绕过权限链的授权会断链

**对立可能立场**：信任链自身应含防伪机制（数字签名/Merkle 树），而非依赖外部系统。

**争议焦点**：spec 约束"零新增依赖/node 内建约束"。Node.js 内建 crypto 模块支持 SHA256/HMAC（已在 `store.ts` 用于 contentHash），但完整的签名体系（密钥管理/PKI）超出内建约束。争议的核心是：**"足够不可伪造"的度在哪里**。

### D5. 信任的"衰减"与"时效"

**本提案未涉及**（有意留白）：信任不是永久的——规则可能被更新（rule update）、agent 的 elo 可能下降、宪法可能被 PTL 重新部署。本提案的链是**时间点快照**（"在时刻 t，此链成立"），但未定义"链的过期"。

**可能的对立立场**：必须建模信任衰减（TTL、elo 阈值窗口、规则版本绑定）。

**争议焦点**：如果链在 t₁ 成立但在 t₂ 不成立（因为上游规则被修改），之前基于 t₁ 链的决策是否应当被撤销？这与 spec §4.3 必要性分级和 §4.6 退出机制有深层交互。

### D6. 信任链的"宽度"——多少证据足够

**本提案立场**：语境③采用 OR 语义（任一维度成立即可信），由使用场景选择子集。

**对立可能立场**：
- AND 语义（全部维度成立才可信——最大安全）
- 加权评分（每个维度有权重，综合分超阈值）
- 阶梯式（每个维度独立判定，不同信任等级 = 不同维度组合）

**争议焦点**：本提案的 OR 语义偏向"信任最大化"（容易通过），但增大了 false positive 风险。在联邦的安全关键路径（如回退触发、破产接管）上，false positive 的代价极高。

---

## 附：与既存代码基线的对应总表

| 提案概念 | 代码锚定 | 状态 |
|---|---|---|
| L0 元信任对象（axiom） | `entry.ts:86` isAxiom, `rules.ts:207` 豁免校验 | ✅ 已实施 |
| →_struct 担保边 | `rules.ts:203-233` validateContent | ✅ 已实施 |
| →_provenance 担保边 | `pipeline.ts:165-169` sourceTraces 追加 | ✅ 已实施 |
| →_consensus 担保边 | `audit-chain.ts:164-196` approve() | ✅ 已实施 |
| →_economic 担保边 | `settlement.ts` planSettlement, `market-runner.ts` apply_settlement | ✅ 已实施 |
| →_constitutional 担保边 | 无直接代码——治理权限链尚未实例化（spec §8 遗留：嵌套治理子图） | ❌ 待实施 |
| L1 元信任（voucher burn） | `voucher-port.ts` burn → voucher_burns | ✅ 已实施 |
| L2 元信任（宪法） | 无代码——宪法加载机制待实现（spec §8 遗留） | ❌ 待实施 |
| 信任缺口审计 | `audit-chain.ts:250-254` recordEvent → audit-events.jsonl | ⚠️ 部分实施（仅审核事件，非通用信任事件） |
| 不可回写标记（信任链副作用） | `audit-chain.ts:257-264` markNotWriteBack | ✅ 已实施 |

---

*本提案为 Round 1 独立输出，未与其他模型提案交叉阅读。*
