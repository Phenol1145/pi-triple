# 信任链形式化提案 —— deepseek-v4-flash（Round 1 独立提案）

> 会谈角色：独立提案者（对抗性取向——提案内所有"已实现实证"均经只读代码核验，凡与 spec 或实现冲突处显式标注严重度）。
> 已核验代码事实（证据基座，供 Round 2 交叉质询）：
> - `extensions/agent-lab/src/memory/rules.ts`：`validateContent` 仅**单跳**验证（entry → 直接 ruleRef）；axiom（`AXIOM_RULE_ID`）豁免自证；`updateRule` 守卫 axiom 不可改；`registerRule` 对 rule 条目自身的 ruleRef **从不解析/校验**。
> - `extensions/agent-lab/src/memory/entry.ts`：`MemoryEntry` 无"引用其他条目"字段（无 references/citations）；`validateEntryStructure` 对 ruleRef 仅查非空字符串，**无环检测**。
> - `extensions/agent-lab/src/memory/audit-chain.ts`：审核链是**表决过程**（all-vote/veto/representative + operator 否决），结果仅落 `audit-events.jsonl`（append-only）与 `not-write-back.jsonl`（幂等否决标记）；**无正向"已审核"戳记**；投票存内存 Map 不持久化。
> - `extensions/agent-lab/src/memory/pipeline.ts`：write 成功追加 `sourceTraces: {traceId, transitionSeq}`；promote 走写校验链拒绝 not-write-back。
> - `extensions/agent-lab/src/memory/store.ts`：版本链 `meta.versions[]` 存 `{version, watermark, contentHash}`，contentHash = sha256 前 16 hex（64 bit），**哈希不互相链接**（无 prevHash），watermark 恒 0（占位）。
> - `extensions/agent-lab/src/economy/central-pool.ts`：`RESERVED_IDS = {central-pool, calibration-executor}`；`debitUnclamped`（池可负 = 允许赤字，顶层不破产）。
> - `src/` 与 `extensions/` 全库 grep "trust" 零实现——信任链概念完全未落地。

---

## 1. 形式化定义

**定义（担保 DAG）**：信任链不是"链"，而是**有向无环担保图** G = (V, E)：

- **V** = 数据对象（记忆条目、rule、构件、计算结果、审计事件、ledger 行、转移记录）。
- **E** = **担保边** e = (v → u)，语义："u 承诺 v 的可靠性"。u 是 v 的担保者。
- **命题类型化**：待证命题 P(v) 是三元组 **P = (对象 v, 维度 φ, 语境 c)**——同一对象在不同维度/语境下有不同链（§7.1 三种语境即三个维度）。维度 φ ∈ {**解析**（可判定：语法/结构），**信息可信**（经验：有事件证据），**计算可信**（复合：资格×法律×经济×时序）}。
- **元信任对象集 M**：自证节点（P(m) 成立无需外部担保）。

**"链成立"（验证语义）**：对维度 φ 的验证函数 V_φ(v)：

```
V_φ(v) = true                      若 v ∈ M（宪法级预置锚）
V_φ(v) = ∃ e=(v→u) ∈ E_φ 且         否则：
         担保者有效(u) ∧ V_φ(u)
担保者有效(u) = u 未失效（status≠draft/archived、未过期、未 not-write-back、
                rule 未被新版本取代——版本钉扎，见 §2）
```

**声明式（§7.2 已决）的形式化后果**：V_φ 是**审计重放函数**，不是构件生效的门禁。审计者（治理节点 / PTL）可随时对任意 v 求值，输出 {成立与否, **完整证据路径**（每条担保边的物证位置）}。

**关键立场——"自证"的真实含义**：元信任对象"无需担保"不是语义魔法，而是**宪法级封闭性**：M 的元素由**设计者预置**且**系统内不可修改**。这与 A4（宪法不可由系统内机制修改）同构。已实现实证：axiom 由 `bootstrapAxiom` 一次性写入、`updateRule` 拒绝更新；central-pool 是 RESERVED_IDS、允许赤字、顶层不破产（经济域的"顶层终止"）。**任何非预置节点声明"我自证" = 自指漏洞，必须禁止。**

**Critical 矛盾（spec 内部）**：§4.2 写"构件生效条件 = 信任链验证（§7 开放）→ 填槽生效"，§7.2 裁决信任链**声明式、非强制拦截**。二者不可同时为真。修复方向：裁决 §4.2 的"验证"= **登记担保记录**（构件随上传附注担保元数据并落审计事件），非"通过/拒绝"门禁；或显式给出"声明式（现）→ 强制式（远期 v1.x，随法律引擎）"时间线。此矛盾不解决，§4.2 的部署语义无法实现。

---

## 2. 结构

### 2.1 链元素（对齐 §1 本体）

| 元素 | 定义 | 物化形态（已实现/待定义） |
|---|---|---|
| **担保者** | 发出担保的**节点**（§1.1）——担保是 A3 计算任务 | rule（语法担保）、workloop 转移/checkpoint（证据担保）、治理节点（资格担保——立法/授权/审计）、结算对手方（经济担保） |
| **被担保者** | 数据对象 | 记忆条目 / rule / 构件 / 计算结果 |
| **证据（Evidence）** | 担保的**物化记录** | ruleRef（引用）、sourceTraces（溯源）、audit-events.jsonl 行、idem.jsonl 行、ledger 行、meta.versions[].contentHash |
| **元信任对象 M** | 宪法级预置锚 | **axiom**（记忆/规则域根）、**central-pool**（经济域根）、**宪法/设计者预置**（资格域根） |

### 2.2 三类担保边

- **语法边**：u 提供使 v 可解析的规则（v.ruleRef → u 的编译语法）。
- **证据边**：u 记录 v 发生的证据（sourceTrace、审计事件、ledger 行）。
- **资格边**：u 授权 v 存在/执行（装配记录、法律授权、权限下传记录——§1.1"被治理节点权限 ⊆ 治理节点权限"是资格边的**合法性判据**）。

三类边**不可互换**：语法边可算法判定（强），证据边只有"证据齐全性"（弱，见 2.4），资格边依赖法律层级（§1.7 法律分层）。

### 2.3 验证语义（审计重放）

- 输入：v、维度 φ、证据目录（记忆库 dir / 审计日志 / ledger）。
- 输出：{成立, 证据路径}。路径上每条边必须可定位到物证（文件行 / 记录 id / 哈希）。
- **无环约束**：担保图必须 DAG（M 的自指是唯一允许的环）。**Important——实现缺陷**：`validateEntryStructure`（entry.ts）允许 ruleRef 成环（A→B→A 均通过结构校验），`validateContent` 只走一跳不触发环——一旦形式化要求传递验证，环将导致死循环/假成立。正式章节必须规定环检测（拓扑排序或深度上限 + 访问集）。
- **失效传播**：担保不是永久有效。已实现失效机制：status（draft/archived）、TTL（草稿 7 天）、not-write-back 标记、rule 版本递增。**缺口**：担保边的**失效传播规则未定义**——rule R 更新到 v2 后，依赖 R v1 的条目验证结果漂移（见 2.4 版本钉扎）。

### 2.4 两个必须裁决的力学问题

- **版本钉扎**：条目只存 ruleRef 不存 rule 版本——`resolveRule` 解析**当前**版本，rule 语法变更后旧条目突然不可解析，**审计不可重现**（同一条目今天成立、明天不成立，且无法复现昨天的判定）。修复方向：担保边携带 `(ruleRef, ruleVersion, contentHash)`。
- **证据的诚实边界（声明式的直接后果）**：append-only（jsonl 追加）+ 原子写（tmp+rename）是**进程约定**，不是**密码学属性**——拥有文件系统权限者可改写 jsonl。在声明式裁决下这是**可接受的**（审计记录 = 证据的呈现，非防篡改证明），但正式章节必须诚实标注：**V_φ 成立 = 证据齐全且链闭合，不等于证据未被篡改**。若未来要求防篡改，需哈希指针定期锚定到只读域（v1.x 可选）。

---

## 3. 与联邦骨架的关系（用 spec v1.0 术语）

- **与治理**：担保 = A3 计算任务（消耗担保者额度）；治理权限中的**审计**（A4）正是"对 V_φ 的重放"的授权。信任链是治理的**观测面**。**Important**：声明式信任链**不得进入宪法级触发条件**（§1.8 触发①~③）——可被伪造的弱证据不能驱动机制性判定。图法律可将"关键数据担保记录缺失/断裂"追加为回退触发（§1.8 规则 (b)：宪法 5 项之外的追加触发，附各自 T）——这是声明式与机制性判定的**唯一合法接口**。
- **与法律**：法律（§1.7）约束的是**担保边的合法集合**——边 (v→u) 合法 ⟺ u 的权限 ⊇ 产生 v 所需权限（§1.1 权限下传）。法律分层 = 担保边按层级排序：上层法律担保下层边合法。**M 的封闭性**：图法律**不可**追加元信任对象（子图自封锚 = 自指漏洞）。宪法 = M 的唯一来源。
- **与责任⇄权利（A2）**：担保边是**可结算的责任记录**——担保者因"承诺被担保者可靠"获得权利（额度/权限），因担保失实承担后果（信誉/结算损失）。经济锚定：**结算记录（executor→publisher、评审者→central-pool 的 ledger 行）是"计算可信"的最强证据**——"有人为结果付钱"= 有经济实体的真金白银背书。破产 = 无力担保 = **链断裂的硬约束**（A2 硬约束为底）。
- **与构件/部署**：§4.2 修正为——构件上传 = **变更载荷 + 担保记录登记**（谁在何法律下、以何权限、产生该构件，附结算/审计引用）。增量 = 新担保登记；替换 = 旧担保失效 + 新担保登记；必要/非必要分级决定替换时担保迁移的严格度（必要通路构件的担保必须闭合到 M，非必要可降级为登记）。
- **与回退节点**：回退链（push+pull，T 参数，§1.8）是**故障处理机制**（强制、宪法级），信任链是**责任记录**（声明式）——**二者不同层**。回退节点不消费信任链判定；但回退链上溯时，PTL 可**审计性地**用 V_φ 评估被透传问题的数据状态（人类审计入口）。
- **与图生图（A5）/实例图**：**内部一致性论证（Verified sound）**——spec §1.2 规定实例计算图"不可序列化，只能观测/记录"，§7.2 裁决信任链声明式。二者天然一致：③ 的"相位边"证据只能是**观测记录**（machine.transition 事件、checkpointId），而非可序列化的实例图本身。信任链正式化**不要求**实例图可序列化——这消除了一个潜在矛盾。

---

## 4. 实例化模式

### ① 记忆条目可解析（已实现——验证通过，附三个缺口）

- 命题 P₁(v) = "v.content 可由其 ruleRef 的语法解析"。
- 构造：v.ruleRef → rule R → 编译语法（EBNF）→ `validateAgainstGrammar`。收敛到 **M₁ = {axiom}**。
- 实证：`rules.ts validateContent` 单跳验证 + axiom 豁免 + `updateRule` 守卫。
- **缺口 a（Important）**：实现是**单跳**（v→R），而 §7.1 说"rule 链"。rule 条目自身的 ruleRef 从不被解析校验（`registerRule` 只 parseEbnf）——传递链在实现里**不存在**。形式化必须裁决"链成立"的深度：全路径传递（需环检测 + 版本钉扎 + 性能）或单跳（需修改 §7.1 措辞）。
- **缺口 b（Important）**：ruleRef 环无检测（见 §2.3）。
- **缺口 c（Important）**：版本漂移（见 §2.4）。
- **Minor**：axiom 的编译语法为**空生产集**（`productions: []`）——条目直接引用 axiom 会验证失败（主规则未找到），axiom 实际只是 rule 的锚、不可被条目引用。这佐证"链 = 多类型节点路径"而非"所有节点直指根"，但正式章节需说明 axiom 的**不可引用性**（它是元信任锚，不是可用的语法规则）。

### ② 记忆信息可信（已实现部分——缺口在"引用链"）

- 命题 P₂(v) = "v 描述的信息有证据支撑"。
- 构造（当前实现）：**事件证据链** = v.meta.sourceTraces[]（(traceId, transitionSeq) → workloop 转移/checkpoint）+ audit-events.jsonl（append-only）+ idem.jsonl + meta.versions[].contentHash。
- **缺口 d（Critical——与 §7.1 表格直接冲突）**：§7.1 说"条目间引用链"，但 `MemoryEntry` **无引用字段**——不存在"条目 A 引用条目 B 作证"的物化。当前只有"被谁写入/经哪个转换"（sourceTraces），没有"事实交叉验证"。二选一：① 增加引用字段（references[]，随引用登记证据）——则"信息可信" = 事件证据 + 交叉引用双向；② 降级定义 P₂ = "事件证据链成立"（不覆盖事实真实性）——需修改 §7.1。**我主张 ②（降级定义）+ 远期扩展 ①**，理由：声明式 + 无密码学下，引用链也不能防伪，交叉引用只增加审计成本不增加实质保证。
- **缺口 e（Important）**：sourceTraces 指向 workloop 转移，但 memory 侧**无法反向验证**该转移真实存在（无证据目录索引）。诚实标注：P₂ 的成立 = 证据齐全性，非证据真实性。
- **缺口 f（Important）**：`meta.versions[].contentHash` 是独立内容指纹，哈希**不链接**（无 prevHash）——无法检测历史版本被整体替换（篡改者可同时改写条目文件与 versions[]）。修复：版本记录携带 prevHash（条目内哈希链），日志防篡改留 v1.x。
- **缺口 g（Important）**：审核结果只落审计事件表 + **否决**标记（not-write-back）；**无正向"已审核"戳记**（audited-by / audit-event-id）。"被担保"的正向证据缺失。修复：通过审核的条目登记 audit-event 引用。

### ③ 计算结果可信（未实现——元信任对象提案）

- 命题 P₃(node, result) = "result 是 node 在其责任/权利范围内、按所在图法律产生的计算输出"。
- **构造：结果附四元组证据（证据指针，惰性物化）**：

| 边 | 证据指针 | 收敛根 |
|---|---|---|
| 资格边 | 装配记录（assembler 填槽、RESERVED_IDS 校验通过、初始权限⊆治理者权限的授权记录） | 宪法（资格域根） |
| 法律边 | 所在图当前法律（rule 链锚定）+ 该法律对 node 的责任/权利条款 | axiom（规则域根） |
| 结算边 | 任务结算 ledger 行（executor→publisher / 评审者→central-pool）——**最强证据**：真金白银背书 | central-pool（经济域根） |
| 相位边 | 实例图观测记录（machine.transition 事件序列、checkpointId、预算守卫记录） | （观测记录本身，声明式） |

- **元信任对象 M₃（我的主张）**：**不是单一对象，而是复合根** M₃ = {axiom} ∪ {central-pool} ∪ {宪法}。理由：P₃ 是**复合命题**（资格×法律×经济×时序），四个维度各有自己的锚，单一根无法同时支撑四维。§7.1 表格每行列单一元信任对象，我明确反对将 ③ 也压成单根——这是 **Round 2 核心分歧**。
- **为什么"结果自证"不可行**：任何节点都可自称结果可信——节点自证无宪法背书，与 axiom 的自证（预置 + 不可修改守卫）本质不同。**判据：元信任对象的"无需担保"必须来自宪法级封闭性，而非任意节点的自我声明。**
- **声明式适配**：P₃ 不拦截结果使用（§7.2），结果只附**证据指针**（ledger 行号、转换序列号、法律版本号），V₃ 审计时按指针展开。避免"每结果附全量证据"的存储放大。**承诺保留**：结算边使 P₃ 有经济分量（A2 硬约束）——结果对应结算缺失 = 链在最强一环断裂。
- **Important——套利面**：声明式 + 无签名下，伪造资格边/结算边指针无成本（指针指向不存在的行即"证据缺失"，V₃ 不成立但**不拦截**）。必须明确：**P₃ 不成立 ≠ 结果不可用，只 = 审计时无证据路径**。任何"不可信结果不得结算/不得使用"的提法都违反声明式裁决，且创造伪造担保操纵结算的套利空间。

---

## 5. 关键分歧点自陈（Round 2 对抗准备）

1. **链 vs DAG vs 证据指针**：我主张担保 DAG + 命题类型化（§1）；反对统一单链模型（会把三类边、多担保结构压扁失真）。
2. **M 的封闭性（最可能爆发）**：我主张 M 宪法级封闭、图法律不可追加自证锚；反对"子图可自定义元信任对象"。后者 = 自指漏洞 = 信任链可被任意构造 = 整个概念空转。
3. **③ 的复合根 vs 单根**：我主张 M₃ 三域复合；§7.1 表格暗示单根。若裁决单根，必须回答"单一对象如何同时担保资格与结算"。
4. **单跳 vs 传递**：实现是单跳；§7.1 说"链"。传递引入环检测/版本钉扎/性能三件套，且会破坏已钉死的测试基线（memory-pipeline.test.ts / memory-audit-chain.test.ts 语义）。需要裁决"链成立"深度。
5. **声明式的边界**：信任链能否进任何机制性判定（回退触发/结算条件）？我主张**不能**（除图法律显式追加的观测型触发）；这是声明式裁决的推论，但必然有人主张"薄弱结果不结算"——那是套利入口。
6. **版本钉扎/担保时效**：担保边带版本 + 失效传播 + 时效默认值？现实现零版本钉扎、零担保过期。
7. **② 的引用链缺失**：MemoryEntry 无引用字段——"信息可信"降级定义为事件证据链（我），还是先物化引用字段（反对者需承担存储/审计/防伪成本）。
8. **§4.2 vs §7.2 的矛盾裁决**：§4.2 的"信任链验证"到底是登记还是门禁——此裁决先行，其余分歧才有落点。

---

## 附录：对抗性实证清单（按严重度）

**Critical（必须修复）**
1. spec §4.2"信任链验证→填槽生效" vs §7.2"声明式非强制拦截"——内部矛盾，部署语义不可实现。
2. ② 的"条目间引用链"（§7.1）无物化载体：`extensions/agent-lab/src/memory/entry.ts` MemoryEntry 无引用字段——正式章节须降级定义或新增字段。
3. M 开放性未定义：§7.1"自证/无需担保的根"若被解释为"任意节点可自证"，则信任链可任意构造（自指漏洞）——须宪法级封闭。

**Important（应修复）**
4. ruleRef 环无检测（entry.ts validateEntryStructure 仅查非空；rules.ts validateContent 单跳不触环）——传递验证前必须加环检测。
5. 版本漂移：条目存 ruleRef 不存版本（rules.ts resolveRule 解析当前版本）——审计不可重现。
6. rule 链单跳 vs §7.1"链"表述：rules.ts registerRule 不解析 rule 自身 ruleRef——传递链不存在。
7. sourceTraces 不可反向验证（pipeline.ts 追加 {traceId, transitionSeq}，memory 侧无转移证据索引）——P₂ 仅"证据齐全性"。
8. 版本哈希不链接（store.ts versions[] 无 prevHash）——历史版本可整体替换不可检测。
9. 无正向审核戳记（audit-chain.ts 仅事件表 + not-write-back 否决标记）——"被担保"正向证据缺失。
10. 声明式下不得进机制性判定：信任链不可作为回退触发/结算条件输入（除图法律追加的观测型触发）。

**Minor（可改进）**
11. contentHash 截断 16 hex（64 bit，store.ts）——防篡改证据偏弱，审计用途可接受。
12. axiom 空语法不可被条目引用（rules.ts）——需在正式章节说明 axiom 不可引用性。
13. 担保时效无默认值（草稿 7 天/审计 5 分钟是过程默认，非担保时效默认）。

**Verified sound（攻击不动，确认合理）**
- 声明式裁决与 §1.2"实例图不可序列化只能观测/记录"天然一致——③ 的相位边证据定位为观测记录，不要求序列化实例图。
- axiom 不可更新守卫（rules.ts bootstrapAxiom + updateRule）与 §1.7"宪法不可由系统内机制修改"同构——元信任对象"预置 + 不可修改"模式在实现中已有正确先例。
- central-pool 允许赤字/顶层不破产（economy/central-pool.ts debitUnclamped）与 A4"顶层治理者不破产、级联在顶层终止"一致——经济域锚确实"无需更高担保者"。
- not-write-back 幂等标记 + promote 写校验链拒绝（audit-chain.ts / pipeline.ts）——否决证据的反向路径闭合正确。
- 审核链 operator 最终否决权（audit-chain.ts）——与"回退节点/治理节点分离"精神一致：否决权在 operator（人类侧通道），不授权给被审计者。

**Open questions（需会谈裁决）**
1. §4.2 的"信任链验证"= 登记 or 门禁？（必须先裁决）
2. M 是否允许图法律追加？（我：禁止）
3. ③ 元信任对象 = 复合根 or 单根？（我：复合）
4. ② 引用链 = 物化字段 or 降级定义？（我：降级）
5. 担保版本钉扎 + 时效的默认值？（我：钉扎必选，时效默认 0=不自动过期，由法律显式设定）

---

## 验收报告

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "提案含具体 finding 及文件路径与严重度：Critical 3 项（spec §4.2 vs §7.2 声明式矛盾；entry.ts 无引用字段致 §7.1 引用链无物化；M 开放性自指漏洞）、Important 7 项（entry.ts/rules.ts 环检测与单跳、版本漂移、sourceTraces 不可验证、store.ts 哈希不链接、audit-chain.ts 无正向戳记、声明式不得进机制判定）、Minor 3 项（contentHash 64bit、axiom 空语法不可引用、担保时效无默认）+ Verified sound 5 项 + Open questions 5 项，全部附代码位置"
    }
  ],
  "changedFiles": [
    "/tmp/trust-chain-panel/proposal-deepseek-v4-flash.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read 2026-08-05-federation-skeleton-design.md（§1-§9 全读）",
      "result": "passed",
      "summary": "完整读取 spec v1.0，重点 §1.8/§4.2/§6/§7"
    },
    {
      "command": "grep sourceTraces/trust/auditChain（src + extensions）",
      "result": "passed",
      "summary": "src 与 extensions 全库 trust 零实现；记忆子系统定位在 extensions/agent-lab/src/memory/"
    },
    {
      "command": "read audit-chain.ts / rules.ts / entry.ts / pipeline.ts / store.ts / ebnf.ts 片段",
      "result": "passed",
      "summary": "核验单跳验证、axiom 守卫、not-write-back、版本哈希、三类表决矩阵语义"
    },
    {
      "command": "grep RESERVED_IDS/central-pool/debitUnclamped",
      "result": "passed",
      "summary": "RESERVED_IDS={central-pool,calibration-executor}；池允许赤字=顶层不破产"
    },
    {
      "command": "sed 修正 bootstrapAxiom 拼写",
      "result": "passed",
      "summary": "代码事实引用准确性修正，无语义影响"
    }
  ],
  "validationOutput": [
    "提案文件 175 行；五节结构（形式化定义/结构/与骨架关系/三语境实例化/分歧点自陈）+ 对抗性实证附录 + 验收报告完整落盘",
    "已核验实现事实与提案断言一致：单跳验证、无环检测、无引用字段、哈希不链接、无正向审核戳记"
  ],
  "residualRisks": [
    "会话为纯概念提案，未与其他 3 模型（deepseek-v4-pro/minimax-m3/kimi-k3-256）提案交叉比对——分歧点自陈（§5）为单方立场，Round 2 对抗后可能修正",
    "③ 的复合根 M₃={axiom}∪{central-pool}∪{宪法} 是主张而非裁决结果，可能被会谈否决为单根",
    "声明式 + 无密码学的证据边界（append-only 为进程约定非密码学属性）是接受的风险而非可消除缺陷，已在提案中诚实标注"
  ],
  "noStagedFiles": true,
  "diffSummary": "新建信任链形式化独立提案（deepseek-v4-flash Round 1）：担保 DAG + 命题类型化定义、宪法级封闭 M、三语境实例化（①单跳+三缺口、②降级定义+四缺口、③四元组证据+复合根）、8 个分歧点、对抗性实证清单",
  "reviewFindings": [
    "Critical: spec §4.2（信任链验证→填槽生效）与 §7.2（声明式非强制拦截）矛盾，需裁决为登记或门禁",
    "Critical: entry.ts MemoryEntry 无引用字段，§7.1 语境②'条目间引用链'无物化载体",
    "Critical: §7.1'自证/无需担保的根'若被解释为任意节点可自证=自指漏洞，M 须宪法级封闭",
    "Important: rules.ts/entry.ts ruleRef 单跳且无环检测；版本漂移（不存 ruleVersion）；sourceTraces 不可反向验证；store.ts 哈希不链接；audit-chain.ts 无正向审核戳记；声明式不得进机制性判定",
    "Minor: contentHash 64bit 截断；axiom 空语法不可引用；担保时效无默认值"
  ],
  "manualNotes": "本提案为会谈 Round 1 独立产物，对抗性证据全部来自只读代码核验；无任何文件被修改（仅新建 /tmp/trust-chain-panel/proposal-deepseek-v4-flash.md）；建议 Round 2 优先裁决 §5 Open questions 1（§4.2 语义）与 2（M 封闭性），二者是其余分歧的落点。"
}
```
