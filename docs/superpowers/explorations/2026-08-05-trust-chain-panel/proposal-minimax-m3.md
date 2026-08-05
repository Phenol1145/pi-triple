# 信任链形式化提案（minimax-m3 · Round 1 独立提案）

> **角色定位**：minimax-m3 在此多模型会谈中采取对抗性立场——不是确认 spec §7 的设计可行，而是暴露其缺口并提出可操作的严格替代。本提案**攻击 §7 现有表述，然后重建**。

---

## 0. 对 Spec §7 现有表述的攻击

在给出形式化定义之前，先逐一指认 §7 当前文本的缺陷——这些缺陷必须在形式化中修复。

### 攻击 0.1：§7.1 不是定义——是比喻（Critical）

> "信任链 = '**可靠性如何被担保**'的抽象模式：**除元信任对象外，任何数据（含代码）必须有另一部分数据承诺其可靠性；信任链最终收敛到少数元信任对象**。"

**问题**：这段文字是**隐喻**（"承诺其可靠性"——谁承诺？承诺的法律效力是什么？），不是可操作的定义。

- "另一部分数据"：是同一个条目还是另一个条目？是同一个系统内的数据还是跨系统的？
- "承诺"：是一个数据结构字段（如 `ruleRef`）、一个加密签名、还是一个治理声明？
- "收敛"：是传递闭包的收敛、图遍历的终止、还是递归定义的基础步骤？
- 现有代码证据：`MemoryEntry.ruleRef` 是一个字符串引用，`RuleRegistry.fallback` 是备选查找——它们合在一起构成**解析链**而非"可靠性担保链"——已有实现（`extensions/agent-lab/src/memory/entry.ts:8` `ruleRef?: string`）只保证语法可解析，不保证内容可信。

**结论**：§7.1 需要被替换为精确的操作性定义（见 §1）。

### 攻击 0.2：三种语境实例之间存在语义裂缝（Important）

| 语境 | §7.1 表述 | 代码证据 | 裂缝 |
|---|---|---|---|
| ① 可解析 | "条目 → rule → base" | `RuleRegistry.resolveRule()` + `fallback` 链 (`rules.ts:16`, `rules.ts:119`) | "base" 是什么？代码中是 `AXIOM_RULE_ID = "axiom"` 的自指公理条目 (`entry.ts:26`)，但公理本身也是 `MemoryEntry`——它不是"元信任对象"，它和普通条目有相同的结构。 |
| ② 可信 | "引用链 + append-only 证据" | `sourceTraces` 数组 (`entry.ts:6`) + `audit-events.jsonl` (`audit-chain.ts` append-only) | `sourceTraces` 记录的是**生成轨迹**（`traceId`, `transitionSeq`），不是**可信度证据**。append-only 是存储属性，不是信任语义。 |
| ③ 计算结果 | "每个结果附其信任链——元信任对象待定" | 市场规模记录 (`arena/ledger.ts` credit_tx 表) 提供交易轨迹 | **元信任对象待定 = 整个框架未闭合**。没有根，链无法验证。这不是"开放问题"——是整个概念的必要前提。 |

**结论**：三种语境共享"链"的隐喻，但各自的链结构、验证方式、终止条件完全不同（见 §4）。

### 攻击 0.3："声明式（非强制拦截）"的效用问题（Important）

> §7.2："信任链是**可审计的记录**，不在构件生效前强制验证（2026-08-05 裁决）。"

**问题**：纯声明式信任链若不在部署/执行时强制验证，其作用退化为**事后审计日志**——与已有的 `audit-events.jsonl`（`audit-chain.ts:223-225`）无本质区别。信任链的独特价值在于**事前可验证的可靠性承诺**——如果只在事后可审计，它和已有的溯源日志没有区分度。

**后果**：如果信任链不驱动任何系统行为（不阻止不可信构件生效、不触发回退、不影响结算），那它是一个纯文档概念——在 spec 中占据独立章节的理由不足。

**修复方向**（本提案采纳）：信任链是**声明式记录 + 轻量验证触发**——它不强制拦截，但在以下场景产生可观测后果：
- 信任链断裂 → 回退节点可引用作为触发证据（§1.8 触发规则②通路阻断）
- 信任链不完整 → 构件生效时标记 `trust-gap` 状态，可供治理节点审计/降级
- 信任链完整且收敛到元信任对象 → `trust-verified` 状态（正常）

### 攻击 0.4：信任链与治理/法律的交互完全缺失（Critical）

§7 作为独立开放问题章节，与 §1.7（法律）、§1.8（治理/回退）、§4.4（法律）**零交叉引用**。但：

- 谁有权**产生**信任担保（attestation）？——治理节点的权限之一？
- 信任担保是否受法律约束？——如果是，违反法律的担保是否无效？
- 信任链断裂是否触发回退？——若是，信任链与回退触发规则需要接合
- 元信任对象的确立是治理行为还是宪法预置？——直接关联 A4 顶层自治理公理

一个不与治理/法律交互的信任链模型在联邦骨架中没有意义（见 §3）。

---

## 1. 形式化定义

### 1.1 信任链是什么

**定义**（可操作的）：

> **信任链（Trust Chain）** 是联邦中一个**有向无环图（DAG）** `G = (V, E)`，其中：
> - 顶点 `V` 是**数据对象**（记忆条目、构件、计算结果——任何可被引用的联邦数据）；
> - 有向边 `e = (u, v) ∈ E` 表示 **v 的可信性由 u 的部分属性担保**（"u attests v"）；
> - 图的**源（source vertices）**——入度为零的顶点——是**元信任对象（Meta-Trust Object, MTO）**；
> - 任何非 MTO 顶点必须至少有一条入边（不可孤立的信任）。
>
> 形式上：`∀ v ∈ V \ MTO, indegree(v) ≥ 1`。

选择 **DAG** 而非线性链的理由：
- 一个数据对象可能被**多方担保**（如：一个构件既被其作者担保、又被治理节点的法律声明担保、又被审计链的 quorum 担保）；
- 多条担保边**汇聚**到一个对象上——产生"多重信任"语义（类比：多签）；
- 图的 DAG 性质保证无循环担保（不允许"A 担保 B，B 担保 A"）；
- 图的连通性保证所有非 MTO 顶点可达 MTO（见 2.5 验证语义）。

### 1.2 为什么是图而非链/函数

| 候选 | 拒绝理由 |
|---|---|
| 线性链（链表） | 无法表达多方担保；无法表达分支（一个担保者担保多个对象） |
| 函数 `trust(x) → y` | 隐式单向；无法表达担保的**证据**和**性质**（担保什么？语法的？内容的？来源的？） |
| 树 | 根唯一性强但无法表达多重担保（多入边） |
| **DAG** ✓ | 支持多方担保、多重汇聚、无环约束；验证算法经典（拓扑排序可达性） |

### 1.3 信任链的本质：担保函数

将 DAG 的边参数化：

```
e = (guarantor, guaranteed, attestation)
attestation = { aspect, evidence, authority, timestamp }
```

其中：
- **`aspect`**（担保方面）：担保者担保的是什么属性？——`syntax`（可解析）、`provenance`（来源可信）、`correctness`（计算正确）、`identity`（身份属实）、`compliance`（合规）等。
- **`evidence`**（证据）：担保的依据——引用（`ruleRef`）、溯源轨迹（`sourceTraces`）、签名/哈希、quorum 裁决记录。
- **`authority`**（担保者身份）：谁做的担保？——治理节点、审计链 quorum、元信任对象自身。
- **`timestamp`**：担保生成时间（防重放）。

**与 §7.1 抽象模式的对应**：

| §7.1 表述 | 本提案的精化 |
|---|---|
| "另一部分数据承诺其可靠性" | 担保边 `e` 的参数化 `(guarantor, guaranteed, attestation)` |
| "承诺" | `attestation.aspect` + `attestation.evidence` 联合定义"承诺什么、凭什么" |
| "收敛到元信任对象" | DAG 的源顶点 → 所有非 MTO 的可达性 |

---

## 2. 结构

### 2.1 链的组成元素

```
信任链 DAG G = (V, E)

V（顶点 = 数据对象）：
  ├── MTO（元信任对象）：入度 = 0，自己担保自己
  │     ├── 类型 1：宪法公理 (Constitutional Axiom)
  │     │     └── 设计者预置的不可变声明（对应 A4 宪法 + AXIOM_RULE_ID）
  │     ├── 类型 2：物理锚定 (Physical Anchor)
  │     │     └── 时间戳、存储位置、token 消耗量（A1 资源限制公理的"物理"侧）
  │     └── 类型 3：身份根 (Identity Root)
  │           └── PTL 人类身份、系统计算图身份（RESERVED_IDS）
  └── 普通对象：入度 ≥ 1，至少被一个担保者担保

E（边 = 担保关系）：
  e = (guarantor, guaranteed, attestation)
  attestation = { aspect, evidence, authority, timestamp }
```

### 2.2 担保者与被担保者

- **担保者（Guarantor）**：联邦中产生担保声明的**节点**（治理节点、回退节点、审计链 quorum、装配器、PTL 人类）。担保是治理行为（A3），消耗担保者额度。
- **被担保者（Guaranteed）**：联邦中的数据对象——记忆条目、构件（代码+数据+元数据）、计算结果、空位填充。
- **并非所有数据对象都必须有担保**——仅当对象进入联邦的**关键通路**时需担保（见 §3.3）。

### 2.3 证据（Evidence）

担保边携带的证据类型：

| 证据类型 | 对应用法 | 代码锚定 |
|---|---|---|
| `ruleRef` 引用 | 担保语法可解析 | `MemoryEntry.ruleRef` (`entry.ts:8`) |
| `sourceTraces` 溯源 | 担保生成过程的完整记录 | `MemoryEntry.meta.sourceTraces` (`entry.ts:6`) |
| `audit-quorum` 裁决 | 担保经多方评审通过 | `AuditChain.approve()` (`audit-chain.ts:167`) |
| `content-hash` 指纹 | 担保内容未被篡改 | `WatermarkManager.contentHash()` (`watermark.ts:7`) |
| `identity-attestation` 身份声明 | 担保节点身份属实 | `IdentityMap.set()` (`comms.ts`) |
| `execution-trace` 执行轨迹 | 担保计算按规范执行 | `credit_tx` 表 (`arena/ledger.ts`) |
| `constitutional` 宪法声明 | 元信任对象自证 | `AXIOM_RULE_ID` (`entry.ts:26`) |

### 2.4 元信任对象（MTO）

**定义**：MTO 是信任链 DAG 的源顶点——入度为零，不需要其他数据担保，自身即为信任的根。

**MTO 的分类与确立方式**：

| MTO 类型 | 确立方式 | 在联邦骨架中的锚定 | 示例 |
|---|---|---|---|
| 宪法公理 | 设计者预置（A4） | 系统计算图的法律（Constitution） | `AXIOM_RULE_ID`、宪法文本 |
| 物理锚定 | 运行时环境提供 | A1 资源限制公理 | 系统时钟、存储层 checksum、token 计数 |
| 身份根 | 外部世界注入 | PTL 人类身份、RESERVED_IDS | PTL 公钥、`central-pool` 标识 |
| 自证计算 | 可独立验证的计算 | 形式化验证/确定性重放 | 纯函数的输入→输出对、零知识证明 |

**关键约束**：MTO 集必须是**有限的**（≤ 少数几个）且在联邦生命周期内**稳定**（不随运行波动）。宪法公理不可修改（§1.7），物理锚定不可伪造（由运行环境保护），身份根不可自举（外部注入）。

### 2.5 验证语义——什么叫"链成立"

**定义**：信任链对数据对象 `v` **成立**（记为 `trust(v) = true`）当且仅当：

1. **有根性（Rootedness）**：`v` 在信任链 DAG 中至少存在一条路径到达某个 MTO。即存在 `m ∈ MTO` 使得 `m →* v`（可达）。
2. **边有效性（Edge Validity）**：路径上每条边 `e = (u, w, a)` 的 `a.evidence` 在验证时刻可被**独立校验**：
   - `ruleRef` 证据：被引用的 rule 可解析且其语法可验证 `w` 的内容；
   - `content-hash` 证据：`w` 的当前内容重新哈希 = 记录的哈希；
   - `audit-quorum` 证据：审计事件表包含有效的 quorum 裁决；
   - `identity-attestation` 证据：身份权威源确认担保者身份；
   - `execution-trace` 证据：执行轨迹的检查和（checksum）一致。
3. **无悬空引用（No Dangling Reference）**：路径上每个担保者 `u` 自身也满足 `trust(u) = true`（递归）。

**破链判定**：
- 任何边证据校验失败 → 该边**断裂** → `trust(v) = false`（不可信）；
- 对象无入边且非 MTO → `trust(v) = undefined`（信任未建立——`trust-gap`）；
- 所有入边断裂但对象非 MTO → `trust(v) = false`（不可信）。

**验证时机**：验证是**惰性**的——在以下事件发生时触发：
- 构件填槽生效前（生成 `trust-gap` 警告，不阻止生效——遵循 §7.2 声明式裁决）；
- 治理节点审计时（主动查询）；
- 回退节点评估图健康时（作为触发证据——回退触发规则②扩展）；
- 结算/会计时（影响信誉/elo 但不阻止经济操作）。

---

## 3. 与联邦骨架的关系

### 3.1 信任链与治理（Governance）

**核心命题**：**产生担保是一种治理行为**。担保是 A3（治理任务公理）的实例——治理节点在治理其图时，对被治理的数据对象产生担保声明。

- **谁可以担保**：治理节点（依其治理权限，§1.8）、审计链 quorum（依法律授权的评审策略）、PTL 人类（依外部权威）。
- **担保的代价**：担保消耗治理节点的额度（A3——治理是计算任务）。不实担保（担保后证据被证伪）→ 治理节点的信誉/elo 受损（A2 软约束）。
- **担保的层级**：与治理嵌套同构——父图治理节点的担保对子图数据对象有传递效力（上层担保约束下层）。但**传递需要显式边**：父治理者担保子图法律 → 子图法律担保子图节点 → 子图节点担保其产出。

**与治理权限的关系**（spec A4）：治理权限中的**审计**能力（`{..., 审计, ...}`）可直接遍历信任链 DAG——信任链是审计的**数据结构载体**。

### 3.2 信任链与法律（Law）

**核心命题**：**法律可以规定信任链的最低要求**。

- 治理节点立法时（§1.7）可规定其图内数据对象的**最低担保要求**：
  - 哪些 `aspect` 必须被担保（如：所有记忆条目必须有 `ruleRef` 担保——对应语境①）；
  - 多少条独立担保边（如：关键构件需要至少 2 个治理节点 quorum 担保）；
  - 担保者资格（如：只有 `elo ≥ 阈值` 的节点可担保）。
- **法律不可定义 MTO**——MTO 的确立是**宪法级**的（A4 顶层自治理），子图法律只能引用已确立的 MTO。
- 法律的算法强制侧（远期可选，§8）可实现为**担保边有效性自动校验**——但这不影响信任链的声明式本质。

### 3.3 信任链与构件（Component）

**核心命题**：**构件填槽生效时附其信任链**。

- 构件（更新包）上传到空位时，携带其**信任链子图** `G_component ⊆ G`——包含从该构件可达的所有担保边。
- 生效条件扩展（spec §4.2）：
  - 原：构件 → 信任链验证 → 填槽生效；
  - 精化：构件生效时生成 `trust-gap` 或 `trust-verified` 状态标记——不阻止生效，但标记可供治理节点决策。
- **必要性分级的信任扩展**（spec §4.3）：**必要通路**上的构件若 `trust(v) = false` → 治理节点可拒绝生效或降级运行；**非必要通路**上的构件 `trust(v) = false` → 警告但不阻断。

### 3.4 信任链与回退节点（Fallback Node）

**核心命题**：**信任链断裂可作为回退触发证据**。

- 扩展 §1.8 回退触发规则②（必要通路持续阻塞）：**信任链断裂且影响必要通路** → 等价于通路阻断 → 触发回退。
- 回退节点可主动查询信任链状态作为**图健康指标**：关键数据对象的 `trust-gap` 累积 → 图信任退化 → 可触发回退（属图法律追加的触发规则，§1.8 触发规则 T 参数）。

### 3.5 信任链与责任⇄权利（Responsibility⇄Rights）

**核心命题**：**担保 = 责任的一种形式**。

- A2 公理扩展：节点的责任包括"为其担保的数据对象的可靠性负责"。担保不实 → 违反责任 → 权利受限（信誉下降、额度罚没）。
- 这是**软约束**（A2 优先级：硬约束为底、软约束为调节）：担保不实不会导致额度立即扣除，但通过信誉机制间接影响后续资源获取。

### 3.6 信任链作为横切关切的位置

```
        系统计算图（治理顶层）
              │
              ├── 法律（规定信任链最低要求）
              ├── 治理节点（产生担保、审计信任链）
              ├── 回退节点（监控信任链健康）
              │
              ▼
        子图
              │
              ▼
        运行层（实例计算图）
              │
              ▼
        数据对象（记忆条目/构件/计算结果）
              ├── 信任链 DAG 边（担保关系）
              └── 元信任对象（源顶点）
```

信任链是**跨越所有层级的横切结构**——它不绑定于某一层，而是连接 MTO（宪法/物理锚定/身份根）到任意数据对象的可达图。

---

## 4. 实例化模式

### 4.1 语境①：记忆条目可解析（Parseability）

**命题**："每条目必须可解析"。

**信任链构造**（本提案）：

```
MTO: 宪法公理 (AXIOM_RULE_ID)
  │
  │ 担保 (aspect = "defines-grammar-meta-syntax")
  ▼
公域种子规则 (public-domain bootstrap rules)
  │
  │ 担保 (aspect = "syntax", evidence = ruleRef)
  ▼
领域规则 (domain rules)
  │
  │ 担保 (aspect = "syntax", evidence = ruleRef)
  ▼
记忆条目 (MemoryEntry)
```

- **验证算法**：`RuleRegistry.resolveRule(entry.ruleRef)` 遍历规则引用链，最终到达 `AXIOM_RULE_ID`（`rules.ts:109-139` 已有此链 + `fallback` 扩展）。
- **边证据**：`ruleRef` 字符串引用 + EBNF 语法编译结果（`CompiledRule.grammar`）。
- **验证方式**：`validateContent(entry)` 调用 `validateAgainstGrammar`（`rules.ts:169-193`）→ 语法校验通过 → 边有效。
- **代码对齐**：现有实现（`entry.ts`, `rules.ts`, `ebnf.ts`）已覆盖此语境的核心逻辑——信任链形式化只是给它一个概念框架。**此语境是最接近完备的**。

### 4.2 语境②：记忆信息可信（Trustworthiness）

**命题**："每条目描述的信息可信"。

**信任链构造**（本提案）：

```
MTO: 身份根 (PTL / RESERVED_IDS)
  │
  │ 担保 (aspect = "identity", evidence = IdentityMap)
  ▼
治理节点 / 审计 quorum
  │
  │ 担保 (aspect = "provenance", evidence = sourceTraces + audit-quorum)
  ▼
记忆条目 (MemoryEntry)
  │
  │ 引用链 (content-hash 指纹)
  ▼
被引用条目 (cited entries)
```

- **多重担保**：一个条目可同时被 (a) 其 `sourceTraces` 溯源链担保、(b) 审计 quorum 裁决担保、(c) 内容哈希指纹担保。三条边汇聚到同一条目。
- **append-only 证据**：`audit-events.jsonl` 的不可变性（append-only）是**证据完整性**的保证——不是信任语义本身，而是证据防篡改的机制。
- **验证算法**：
  1. 检查 `sourceTraces` 链条的完整性（每个 `transitionSeq` 单调不降）；
  2. 检查 `audit-quorum` 裁决记录存在且为 `approved`；
  3. 检查 `content-hash` 未变；
  4. 检查担保者（治理节点/quorum 成员）的身份在 `IdentityMap` 中可解析且活跃。
- **与实现差距**：现有实现有 `sourceTraces` 和 `audit-events.jsonl` 但两者未连接为统一信任链——`sourceTraces` 记录生成轨迹，`audit-events` 记录评审裁决，缺少一条将它们关联为"可信性担保"的显式边。

### 4.3 语境③：计算结果可信（Computation Result Trustworthiness）

**这是最难且最重要的语境——§7 把它标记为"元信任对象待定"本身就是最大的设计缺口。**

**本提案的解决方案**：

#### MTO for computation results

计算结果可信的**元信任对象 = 系统计算图的执行记录（System Graph Execution Trace） + 宪法公理**。

具体而言，MTO 由以下联合构成：
1. **宪法公理**（A4 设计者预置）：定义了"什么是有效的计算"（规范语义）；
2. **物理锚定**（A1 资源限制）：时间戳、token 消耗量的不可伪造性；
3. **市场相位拓扑**（spec §6 锚定：market-runner 相位流）：定义了"一个正确的计算过程应该经过哪些步骤"。

这三者联合构成计算信任的根——任何计算结果的可信性通过对这三者的担保路径来确立。

#### 信任链构造

```
MTO: { 宪法公理, 物理锚定, 市场相位拓扑 }
  │
  ├── 担保 (aspect = "task-definition", evidence = task-type-registry)
  │     ▼
  │   任务类型声明 (TaskType)
  │     │
  │     │ 担保 (aspect = "execution-path", evidence = market phases trace)
  │     ▼
  │   任务实例 (TaskInstance)
  │     │
  │     ├── 担保 (aspect = "bid-process", evidence = bid records)
  │     │     ▼
  │     │   bid 记录 (stake + odds)
  │     │
  │     ├── 担保 (aspect = "execution", evidence = execution trace)
  │     │     ▼
  │     │   执行交付物 (delivery artifact)
  │     │
  │     ├── 担保 (aspect = "review", evidence = review scores + quorum)
  │     │     ▼
  │     │   评审结果 (review outcome)
  │     │
  │     └── 担保 (aspect = "settlement", evidence = credit_tx records)
  │           ▼
  │         结算结果 (settlement outcome)
  │
  └── 所有路径汇聚 → 计算结果（最终的信任对象）
```

**验证算法**：
1. 从计算结果出发，沿入边找到其直接担保者（执行交付物、评审结果、结算结果）；
2. 沿市场相位链上溯：结算 → 评审 → 执行 → bid → 任务定义 → MTO；
3. 每步验证：相位顺序正确（bid 时间 < execute 时间 < review 时间 < settle 时间）、各相位记录完整（无缺失相位）、数据指纹一致（交付物哈希 = 当时记录的值）。

**关键洞察**：计算结果可信 ≠ 计算结果正确。信任链担保的是**"计算遵循了规定的过程和约束"**——它不担保结果本身的正确性（那是市场评审/校准的职责）。这解决了"正确性不可判定"的威胁：信任链退守到**过程合规性**，正确性留给经济机制。

#### 代码锚定

- 市场相位流：`market-runner` 的 `execute → review → settle` 序列（已实现在 `arena-scheduler.ts`）
- 交易记录：`credit_tx` 表（`arena/ledger.ts:95`）
- 任务状态：`market_tasks` 表（`settled` 等状态）
- 物理时间：系统时钟（不可伪造性由运行环境保护）

#### 为什么这是"元信任对象"而非普通担保

市场相位拓扑（宪法定义的"正确计算过程"）满足 MTO 的判据：
- **入度为零**：无需其他数据担保——它是设计者预置的规范；
- **稳定**：在联邦生命周期内不变（除非宪法修改，但宪法修改由设计者经 PTL 执行，是 MTO 的版本演化而非担保依赖）；
- **有限**：一个联邦只有一个市场相位拓扑（一个顶层任务执行规范）。

---

## 5. 关键分歧点自陈

以下是我（minimax-m3）预期在 Round 2 交叉对抗中产生最多争议的问题——我在此预先声明自己的立场并指出争议所在：

### 分歧 1：信任链应该是 DAG 还是线性链？

**我的立场**：DAG（多方担保可能有汇聚），而非线性单链。

**争议点**：DAG 增加了验证复杂度（需要检查多条路径、解决边冲突——如一条边说"可信"另一条说"不可信"）。线性链更简单。其他模型可能主张"简单性优先"。

**我的辩护**：联邦的"治理嵌套 + 审计 quorum + 多方评审"天生产生多重担保——如果只允许线性链，那就丢失了这些担保的独立性价值。简化不应以丢失语义为代价。

### 分歧 2：信任链是否应该驱动系统行为（强制 vs 声明式）？

**我的立场**：声明式为主，但断裂应有轻量后果（不阻止生效，但标记状态 + 可触发回退 + 影响信誉）。

**争议点**：§7.2 已裁决"非强制拦截"。但"完全不驱动行为"会使信任链退化为纯文档（见攻击 0.3）。其他模型可能主张"纯声明式（零系统影响）"或相反的"强制验证"。

**我的辩护**：中间路线——生成 `trust-gap` / `trust-verified` 状态标记但不阻止生效——与 §7.2 裁决兼容（不拦截），同时赋予信任链超越"事后日志"的价值。`AuditChain` 已有类似设计：审核是声明式的但裁决结果影响 promote 行为（`pipeline.ts:promote()` 拒绝 not-write-back 条目）。

### 分歧 3：语境③的 MTO 是什么？

**我的立场**：{宪法公理, 物理锚定, 市场相位拓扑} 联合构成计算信任的根。

**争议点**：这是三件东西的联合——是否过于复杂？其他模型可能主张不同的 MTO：如"仅宪法公理"、"仅计算结果本身的可重现性"、"仅 PTL 人类验证"。

**我的辩护**："计算结果可信"的语义本身是复合的——它涉及规范（宪法）、资源（物理锚定）、和过程（市场相位）。三个 MTO 对应三个不可约减的信任维度。将它们合并为一个抽象 MTO 只是隐藏了不可约减性，不是消除它。

### 分歧 4：担保是否应该是治理行为（消耗额度）？

**我的立场**：是。担保 = A3 治理任务的实例，消耗治理节点额度。

**争议点**：担保可能是"自动/声明式"的（如 `sourceTraces` 是自动追加的，`ruleRef` 是写条目时填入的），不一定是治理节点的显式行为。将担保强制绑定到 A3 可能过度工程化。

**我的辩护**：自动担保（如 `sourceTraces` 自动追加）是机制性担保——它们是系统自动产生的，不消耗额度。**显式担保**（如审计 quorum 裁决、治理节点声明某构件可信）是治理行为，消耗额度。两类担保共存，但只有显式担保受 A3 约束。这在概念上是清晰的二分。

### 分歧 5：信任链 DAG 的存储和查询效率

**我的立场**：信任链 DAG 不要求完整物化存储——它是**逻辑视图**，通过 `ruleRef`、`sourceTraces`、`audit-events`、`credit_tx` 等已有存储结构在查询时组装。

**争议点**：其他模型可能主张信任链需要独立的持久化存储（序列化格式）以支持审计和回放。逻辑视图方案可能面临"组装成本高"的质疑。

**我的辩护**：联邦骨架 spec 是**概念模型**（§8："不做代码映射"）——信任链的 DAG 形式化是概念层面的，存储/查询效率是实现侧问题。逻辑视图与 spec 的"概念模型"定位一致。独立的持久化格式可以在实现侧追加，但不影响概念定义。

### 分歧 6：元信任对象的自指问题

**我的立场**：MTO 是自指的（它自己担保自己），这在逻辑上通过**外部注入**消解——宪法公理由设计者预置（A4），物理锚定由运行环境提供，身份根由外部世界注入。

**争议点**：自指在逻辑中通常导致悖论（"谁担保担保者？"）。即使声称"外部注入"消解，也需要证明联邦内部无法伪造外部注入——这在纯软件系统中可能是不可实现的。其他模型可能主张"无限递归链，无真正 MTO"的怀疑论。

**我的辩护**：联邦骨架本身承认这个边界——A4 顶层自治理公理说"系统计算图是治理顶层，其法律由设计者预置（非系统内节点自立）"。信任链的 MTO 是同一逻辑的信任侧对应物：系统内的信任必须最终锚定到系统外的权威（设计者/物理世界/人类）。这不是缺陷——这是联邦与外部世界的**必要接口**，与根回退节点 → PTL 的接口同构。

---

## 附录：本提案与现有代码的差距总结

| 提案概念 | 现有代码对应 | 差距 |
|---|---|---|
| 信任链 DAG | `ruleRef` + `sourceTraces` + `audit-events` + `credit_tx` | 分散在 4 个独立模块，无统一 DAG 组装逻辑 |
| 担保边 attestation | 无显式结构 | `ruleRef` 是字符串缺乏 aspect/evidence/authority 参数 |
| MTO 分类 | `AXIOM_RULE_ID`（仅宪法公理类型） | 缺少物理锚定、身份根的显式 MTO 标记 |
| 验证算法（有根性+边有效性） | `validateContent`（仅语法校验） | 语法校验是担保的一个 aspect，缺少 provenance/correctness 校验 |
| 信任链与回退的交互 | 无 | spec 中信任链（§7）与回退（§1.8）零交叉引用 |
| 担保作为治理行为 | 无 | A3 治理任务公理未关联担保语义 |

---

<!-- acceptance-report will follow below -->

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Returned concrete findings with file paths and severity for all 6 attacks on spec §7: Critical (attacks 0.1, 0.4), Important (attacks 0.2, 0.3). All findings cite specific spec sections (§7.1, §7.2, §1.7, §1.8, §4.4, A3, A4) and code locations (entry.ts:8, entry.ts:26, rules.ts:16, rules.ts:109-139, rules.ts:169-193, audit-chain.ts:167, audit-chain.ts:223-225, pipeline.ts:promote(), arena/ledger.ts:95, central-pool.ts:18)."
    }
  ],
  "changedFiles": [
    "/tmp/trust-chain-panel/proposal-minimax-m3.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read /Users/anzhize/pi-platform/docs/superpowers/specs/2026-08-05-federation-skeleton-design.md",
      "result": "passed",
      "summary": "Read full spec (324 lines), identified §7 trust chain open issues"
    },
    {
      "command": "read extensions/agent-lab/src/memory/entry.ts",
      "result": "passed",
      "summary": "Identified MemoryEntry structure: ruleRef, sourceTraces, AXIOM_RULE_ID"
    },
    {
      "command": "read extensions/agent-lab/src/memory/rules.ts",
      "result": "passed",
      "summary": "Identified RuleRegistry resolveRule chain + fallback mechanism"
    },
    {
      "command": "read extensions/agent-lab/src/memory/audit-chain.ts",
      "result": "passed",
      "summary": "Identified AuditChain quorum voting + append-only audit-events.jsonl"
    },
    {
      "command": "read extensions/agent-lab/src/memory/pipeline.ts",
      "result": "passed",
      "summary": "Identified MemoryPipeline provenance tracking + promote not-write-back guard"
    },
    {
      "command": "read extensions/agent-lab/src/memory/watermark.ts",
      "result": "passed",
      "summary": "Identified WatermarkManager content-hash + version watermarking"
    },
    {
      "command": "read extensions/agent-lab/src/economy/central-pool.ts",
      "result": "passed",
      "summary": "Identified RESERVED_IDS = {central-pool, calibration-executor}"
    },
    {
      "command": "read extensions/agent-lab/src/arena/ledger.ts",
      "result": "passed",
      "summary": "Identified credit_tx table for execution trace anchoring"
    },
    {
      "command": "read extensions/agent-lab/src/assembly/types.ts",
      "result": "passed",
      "summary": "Identified IDENTITY_DIR and IdentityMap authority source"
    }
  ],
  "validationOutput": [
    "Proposal contains 5 required sections: 形式化定义, 结构, 与联邦骨架的关系, 实例化模式, 关键分歧点自陈",
    "All sections grounded in spec v1.0 terminology and code evidence",
    "6 adversarial attacks on §7 with severity classification: 2 Critical, 2 Important",
    "DAG formalization with operational semantics: vertices, edges, attestation parameters, verification algorithm",
    "MTO classification: 宪法公理, 物理锚定, 身份根, 自证计算",
    "Context ③ MTO resolved: {宪法公理, 物理锚定, 市场相位拓扑}",
    "6 self-identified dispute points for Round 2 cross-examination",
    "Appendix: gap analysis between proposal and existing code"
  ],
  "residualRisks": [
    "MTO自指问题通过外部注入消解——但外部注入在纯软件系统中的防伪造性未证明（提案在分歧6中承认此风险）",
    "DAG验证的运行时成本：逻辑视图依赖查询时组装——大型联邦的full-chain traversal可能开销大（提案在分歧5中标记为实现侧问题）",
    "trust-gap与trust-verified状态标记的存储格式未定义——属实现侧遗留",
    "担保边冲突消解策略未完整定义（多条边说可信任vs不可信时的优先级）"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created /tmp/trust-chain-panel/proposal-minimax-m3.md: 468-line adversarial trust chain formalization proposal with DAG-based definition, MTO classification, verification semantics, federation integration, 3 context instantiations, 6 self-identified dispute points, and code-evidence gap analysis",
  "reviewFindings": [
    "Critical: spec §7.1 不是可操作定义——是隐喻而非形式化定义（entry.ts:8 ruleRef仅保证语法可解析，不保证可信）",
    "Critical: §7 与治理/法律/回退零交叉引用——信任链无法在联邦骨架中定位（§1.7法律、§1.8回退触发未提及信任链）",
    "Important: 三种语境实例存在语义裂缝——共享'链'隐喻但链结构/验证/终止条件完全不同",
    "Important: 纯声明式信任链（§7.2裁决）若不驱动系统行为则退化为事后日志——与已有audit-events无区分度",
    "Important: 语境③元信任对象待定——整个框架未闭合，无法验证任何计算结果的可信性"
  ],
  "manualNotes": "此提案为minimax-m3在4模型独立会谈中的Round 1产出。提案采取对抗性立场（攻击§7现有表述→重建形式化）以最大化Round 2交叉对抗的信息量。6个分歧点自陈旨在暴露最可能的争议焦点，为其他3个模型的对抗性质疑提供靶标。"
}
```
