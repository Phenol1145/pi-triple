# 记忆系统设计（子项目 B）

- **日期**：2026-08-02
- **状态**：设计（经两轮对抗性评审修订）
- **范围**：L3 语义记忆系统——MemoryEntry 最小单元、语言体系（EBNF + 方言层）、沉淀管道、检索、公域/私域作用域管理（fork-merge + 审核链）、SSP/DSP 明确化、通讯（纸带交换）与记忆的分离
- **定位**：市场经济体制（方案 A）三阶段之②——装配层（C）与经济层（D）之间的地基。前序：ptl-flow 运行时扩展（子项目 A ✅：code 节点 + metrics 声明 + 竞价 workflow）
- **对抗性评审记录**：两轮（kimi-k2.7-code / kimi-coding/k3-256k），关键裁决：方言层 C 渐进、唯一通道不变量修正、DSP 检索快照进 checkpoint、审核策略矩阵、版本 DAG 基线、write-behind 缓冲、comms 与用户消息同通道

---

## 1. 三层记忆结构

| 层 | 定义 | 契约 | 状态 |
|---|---|---|---|
| **L1 纸带** | 消息历史。**append-only**（不可原地修改/删除）+ **时间索引**（单调序号 + wall clock，可排序/时间窗口检索）；可 fork/clone/branch（副本自由，原文不改） | WorkContext | 已有 ✅ |
| **L2 数据域** | credit/elo 等跨转移状态。不透明（LLM 不可直接读）、投影；checkpoint 持久化 | state + checkpoint | 已有 ✅ |
| **L3 语义记忆** | 沉淀的观察事实，带锚点、可检索、统一入口、会演化 | 本次设计 ⛔→ | |

**统一不变量（修订版，两轮评审裁决）**：
1. **LLM 是无状态概率读写头**——所有记忆由状态机/存储侧持有
2. **"L2/L3 状态"进模型可见层的唯一通道 = 投影（DSP）**；comms 与用户消息 = 纸带 user 消息通道（带来源标记，是"通讯观察"不是"记忆"，不冒充记忆、不绕过 MemoryStore 校验链）
3. **层间冗余真相源优先级：L2 > L3 > L1 片段**（如 elo 矛盾时以 L2 数据域为准，L3 沉淀的派生事实降权）
4. **时间索引是分支局部的**（fork/branch 后各分支自持序号，不做全局全序；跨分支引用走内容哈希）

## 2. L3 最小单元 = MemoryEntry

```
MemoryEntry {
  id: string                        // UUID 身份（不可变）
  kind: "axiom" | "rule" | "fact" | "experience" | "preference" | <领域方言>
  anchors: string[]                 // ≥1，锚点非空（写入校验；语义稳定由规则条目维护）
  content: string                   // 规则约束的构成（语言体系，§3）
  ruleRef: string                   // 指定构造规则的规则条目 id（axiom 除外，自指）
  idempotencyKey?: string           // 沉淀幂等键（δ 观察时预分配，write 重放去重）
  status: "draft" | "official" | "archived"   // 草稿/正式/归档（草稿区生命周期）
  ttlExpiresAt?: number             // 草稿 TTL 到期时间（wall clock）
  promotedFrom?: string             // 正式条目记录其来源草稿 id（promote 链）
  meta: {
    version: number, createdAt, updatedAt,
    sourceTraces: Array<{ traceId, transitionSeq, branch? }>,   // 多源溯源（数组；branch 可选）
    hitCount: number,               // 旁路计数器（不参与版本化，不保证崩溃精确）
    dialectVersion?: string,        // 写入所用方言适配器版本
    versions?: Array<{ version, watermark, contentHash }>  // 版本级水位线（R1：每版本记录落地 seq）
  }
}
```

**不变量（五条，含修订）**：
1. **原子性**——一条目 = 一个可独立理解的语义事实。**约定级**（语义不可机械验证），EBNF 结构尽力约束（单谓词结构）；不做机械校验
2. **不可再分**——引用必须引用整个条目（不允许"条目的一部分"）
3. **版本化 CAS**——更新 = 新版本（不原地改）；**v1 版本模型 = 库级 generation + 条目级 entry-overlap 冲突检测**：generation 仅作快照标识/游标（不参与冲突判定）；回写声明 base（generation + 条目集合）→ merge 点做 **entry-overlap 检测**——**判定谓词（第五轮钉死）：条目 id 相同即冲突**（anchors 重叠但 id 不同 = 不冲突，允许同锚多条目，检索按 id 区分）→ 不重叠自动 **fast-forward**（零冲突合入），重叠 → 驳回（提交方基于新 base 重提 delta，重试 ≤3）；**merge 序列化 + generation 原子递增**（单写者 merge 队列）；**重试耗尽 → 死信区**（事件留痕 + operator 可处置，不静默丢）；DAG（parents[]+内容哈希+三路合并）列为后续专项
4. **溯源完整**——每条目携带完整 sourceTraces（数组）；跨 fork 拷贝时物化溯源摘要（源 agent 的 Trace 不可达时，拷贝时固化来源描述）
5. **锚点非空**——写入即校验；无锚点拒绝
6. **热字段分离**——hitCount 等高频字段走旁路计数器（独立存储，不触发版本化、不参与 CAS、崩溃回退可接受）

**bootstrap 特例**：axiom 条目（唯一、自指）的首次写入走**特例通道**（校验链自引用豁免，系统初始化时由宿主代码写入，非 δ 写入）。

## 3. 语言体系（核心要件）

### 3.1 分层模型

```
L2 方言层：多模型习惯表达（模型用母语表达，系统消化）
L1 语法层：EBNF 文法（结构解析；fenced 围栏转交 = 多段拼接）
L0 语义层：统一语义树（字段/关系/值域——模型无关）
语义约束层：解析后校验（值域谓词、规范引用如 skill 编写规范）
```

### 3.2 读取/执行版本分离

- **读取版本**：规则条目 content = EBNF 文本（LLM 可读可仿写、可审、可版本化）
- **执行版本**：内置解释器编译的确定性校验函数；**规则更新事务**：EBNF 文本 + 编译产物同版本原子生效（防校验器与规则文本脱节）；语法版本号嵌入每条 EBNF，旧条目保留原版本校验
- **v1 受限 EBNF 子集**：production / 选择 / 序列 / 重复（*+?）/ 终端 / 非终端；值约束注解 `(* min=0 max=1 *)`；**错误定位到生产式**（parser 需带位置信息）
- **fenced 围栏转交**：` ```dialect-id ... ``` ` 段 = 多方言拼接；**v1 围栏不嵌套**（一段一方言；嵌套 = 逃逸/转义）；嵌套精化为后续专项
- **校验链**：方言解析（L2）→ EBNF 结构解析（L1）→ 统一语义树（L0）→ 语义校验（约束层，谓词注册表——等第一条真实语义约束出现再建，v1 不预建）

### 3.3 方言层（C 渐进形态，用户裁决）

| 方言 | 解析方式 | 置信度 | v1 交付 |
|---|---|---|---|
| fenced JSON | 确定性解析 | 高 | ✅ 首批 |
| XML 标签 | 确定性解析 | 高 | ✅ 首批 |
| markdown 标记 | 结构锚点提取 | 中 | ✅ 低置信适配器（默认草稿区） |
| 自然语言标记 | 尽力提取 | 低 | ⛔ 永不承诺确定性；**不实现** |

- 方言适配器 = **确定性提取器**（正则/结构化解析），**非 LLM 解析**（避免漂移循环）
- 适配器版本化（模型版本 → 适配器版本）；格式漂移 = 更新适配器；**旧条目保留原适配器版本记录**（meta.dialectVersion），不自动重解析
- 缺失必填字段 → unverified 草稿区；缺失可选字段 → 默认值 + `source="partial"` 标记
- **重试上限**：每条目校验失败重试 ≤2 次，超限直接草稿区（token = 货币，封住烧钱循环）

**草稿区 promote 路径（第三轮 N5 + 第五轮钉死）**：
- 草稿条目可被 **δ 显式重写 promote**：修正 content 后重新 write → 校验通过 → 正式条目——**同 id、version 延续**（promote 是新版本而非新条目），`promotedFrom` 记录草稿 id，草稿 sourceTraces 并入正式条目，idempotencyKey 新生（草稿已消费的 key 不复用）
- **promote 与水位线**：promote 总是在当前转移动作——新版本 watermark = 当前转移 nextCheckpointSeq，**不存在“promote 到过去”的语义**（resume 后 promote 发生在恢复后的新时间线，watermark 天然 ≤ 新 checkpoint）；被屏蔽草稿（pending-activation）经 promote 后新版本正常可见
- 低置信方言（markdown）写入时**明确反馈**：返回 `unverified + TTL 7 天 + 可 promote`（写入方知道状态，不静默）
- **TTL 时钟语义**：wall clock（低频 agent 零活跃转移也到期）；TTL 到期 → archived（可 promote-from-archive 恢复——归档不删数据，仅检索排除）；事件表留痕

### 3.4 agent 理解语法的三重通道

主动检索规则条目（锚点查语法）/ 投影正反例（规则条目 `examples` 注入 DSP 记忆入口区）/ 校验错误反馈（定位到生产式，δ 修正重写）

## 4. 沉淀管道

```
δ 观察 → write-behind 观察缓冲（本地、checkpoint 随存；转移中途崩溃丢失窗口内未消费观察——已知边界，见 §4.3）
       → sdk.memory.write(entry)（显式调用，从缓冲消费）
       → ruleRef 校验（§3 校验链）
       → 溯源自动附加（当前 traceId/transitionSeq 追加进 sourceTraces）
       → memory_tx 事件（副作用注册制，§9 观测）
       → 原子落库（tmp+rename；写入顺序：条目先、索引后；启动时索引重建/校验）
```

### 4.2 resume 一致性（版本级水位线，第四轮评审 R1）

- **watermark 赋值语义（钉死）**：条目/版本落库时，watermark = **该转移完成时将保存的 checkpoint seq**（转移开始时即预定——引擎提供 nextCheckpointSeq；禁止取“上一已完成 seq”——会导致 sourceTraces 悬空）
- **版本级粒度**：watermark 挂在**版本**上（每版本记录落地 seq，`meta.versions[]`）——屏蔽规则：**遮蔽 watermark > S 的版本，可见版本 = watermark ≤ S 的最新版**（条目 v1 在 S 时可见、v2 被屏蔽，互不干扰；与 DSP 快照一致——快照在 S 时刻生成只含当时可见版本）
- **resume 时 L3 屏蔽规则（仅私域）**：恢复的 checkpoint seq 为 S——检索/投影默认排除 watermark > S 的版本（“未来沉淀”隔离，不删除）；**公域不随 resume 回滚**（性质同 comms，不可撤回）；**所有版本均被屏蔽的边界（第五轮）**：条目状态标记 `pending-activation`（不可见但存在），δ 可显式激活（重写新版本，watermark 正常赋值）
- 该机制在子项目 B 内实现，**不推给子项目 C**（C 的装配 fork 另定义记忆域快照的复制语义）

### 4.3 幂等与缓冲（第三轮 N3 + 第四轮 C-1）

- **write-behind 缓冲条目预分配 `idempotencyKey`**（UUID，δ 观察时即生成）
- `sdk.memory.write(entry)` 携带 key：落库时检查 key 已存在 → 返回已有条目（**幂等，重放不重复**）
- **幂等命中 × 屏蔽条目（C-1 修复）**：命中条目 watermark > 当前 resume seq（被水位线屏蔽的“未来沉淀”）→ **以同 key 重落库**（内容不变，watermark = 当前转移的 nextCheckpointSeq）——记忆复活，不永久不可见；**重落库 = 存储层操作**（更新版本 watermark），消费标记**保持不重置**（幂等键已消费 = write 不再重放，与复活语义正交）
- **幂等键表持久化粒度（第五轮）**：键表独立文件 + checkpoint 快照引用；resume 时丢弃晚于 S 的键表增量（S 落在 checkpoint 间隙 → 以最近 checkpoint 快照重建 + 丢弃晚于 S 增量）；**idempotencyKey 跨 fork/merge 保持**（防重提重复）；公域条目 key 仅用于写去重（公域无 watermark 语义）
- **消费标记与落库同批次**：条目文件 + 消费标记同目录顺序写（条目先、标记后、索引最后）——崩溃恢复后缓冲重放不再产生重复条目；**幂等键表随 checkpoint 水位同步**（resume 时丢弃晚于 S 的键表增量——防“键存在但条目被回滚”不对称）
- 诚实声明：转移中途崩溃时该转移内未消费的缓冲观察丢失（checkpoint 在转移完成后保存——已知边界，文档化）
- **沉淀自动钩子（v1 轻量）**：DSP 投影加"本轮可沉淀候选"提示位（转移结束时列出候选观察，δ 决定是否沉淀——缓解"LLM 忘了写"）
- **并发控制**：统一入口 MemoryStore 串行化写入（单写者队列），CAS 冲突重试语义明确
- **事件-落库顺序**：先落库、后发事件（事件可重放补偿）；崩溃窗口内以落库为准

## 5. 检索

- **v1：锚点精确检索**（常规库；锚点索引与条目同库，写入顺序保证一致性）
- 向量检索：**不做**（连 schema 字段都不预留——迁移加字段成本低；独立索引架构后续专项）
- 统一入口 MemoryStore：`write / retrieve / update / validate` 全走一处

## 6. 作用域管理（公域/私域）

```
私域：agent 专属，默认沉淀目标，读写仅本 agent
公域：fork-merge 模型（类 extension/git）
  初始化：从原始记忆库拷贝（fork）→ 本地自由修改
  回写：声明 base（generation + 条目集合）→ merge 点 **entry-overlap 检测**（判定：**条目 id 相同即冲突**；anchors 重叠但 id 不同不冲突）→ 不重叠自动 fast-forward（零冲突合入），重叠 → 驳回（基于新 base 重提 delta，重试 ≤3）→ 耗尽 → 死信区（事件留痕 + operator 处置，不静默丢）
  同步：显式 pull（定期拉取上游 + 冲突检测）；fork 漂移防护 = base version 强制
```

**审核链（v1 完整矩阵，用户裁决）**——参数化表（第三轮 N4 + 第四轮 R3）：
- agent 侧策略（可配置）：全员投票 / veto 制 / 评审代表；operator 侧策略（可配置）：agent 代审 / 一致放行 / 亲自审
- **合成规则（串联）**：agent 侧先审 → 通过后 operator 侧策略生效 → 任一否决 = 拒绝（agent 侧否决直接拒绝；operator 是最终否决权，可推翻 agent 侧通过）
- **策略 × 基数 × 弃权 × 平局组合矩阵**（第四轮 R3）：
  | agent 策略 | quorum 基数 | 弃权处理 | 平局 |
  |---|---|---|---|
  | 全员投票 | 活跃数（提交时在线快照） | 弃权计入分母（弃权≠通过票，也不稀释阈值——分母固定为提交时活跃快照）；默认需过半赞成 | 票数相等 → operator 裁决 |
  | veto 制 | 全部相关 agent（含离线） | 离线=弃权（不否决）；**无 veto = 通过**（不需赞成票过半） | 不适用 |
  | 评审代表 | 被选代表数（默认 2，可配） | 代表弃权 → 换选补充 | 代表分歧 → operator 裁决 |
- **超时参数**：默认 5 分钟（可配置）；超时未投 = 弃权
- **聚合投递**：审核请求按窗口聚合批量投递（默认 1 分钟窗口或 10 条，可配置）；**窗口关闭条件（第五轮钉死）**：veto 制 = 在线相关 agent 全部已投或超时（5 分钟）后强制关闭（离线不阻塞）；全员投票/评审代表 = 时间或数量硬截止（超时未投 = 弃权，按组合矩阵处理）
- **审核批准与 base 解耦（第四轮 R2）**：审核批准的是 delta **内容**；merge 点做 entry-overlap 检测——重叠 → 驳回重审（批准作废，重新提交），不重叠 → 自动 fast-forward（批准仍有效）——消除“审核通过 ≠ merge 成功”的 TOCTOU
- **operator 一票否决** + 否决时可附反馈（经 comms 送达提交 agent）
- **审核结果仅落审计事件表，不落 L3（第四轮 R3）**：审核动作/结果不是记忆条目——防递归审核；任何引用审核动作的条目标记**不可回写**（写校验链拒绝——**路径覆盖：promote 走校验链拒绝、merge 走校验链拒绝、fork 拷贝保留标记（后续回写拒绝）、resume 不触发写（仅可见性）**，防私域回写泄漏）
- **meta 审核循环**：审核规则/审核策略条目的修改固定走 operator 亲审
- 按域审核：团队域提交 → 团队相关 agent；全局域提交 → 全体 + operator
- **审核结果条目递归封堵**：审核结果/审核动作本身**不写入公域**（写审计事件表，不进公域记忆——防递归审核）
- **meta 审核循环**：审核规则/审核策略条目的修改固定走 operator 亲审
- 按域审核：团队域提交 → 团队相关 agent；全局域提交 → 全体 + operator

## 7. SSP / DSP（明确化）

- **SSP = AGENT.md（固定工作协议）**：不变量；checkpoint 原样随存（副本——外部编辑不影响恢复，恢复用副本，文档化）
- **DSP 三区**（每轮引擎重建、不持久化、不参与分支）：
  - **记忆入口区**：检索注入摘要（**v1 单一入口**——多入口冲突留后续；含"可沉淀候选"提示位）
  - **工具列表区**：动态可用性声明（工具描述在 SSP）
  - **投影区**：控制状态投影 + 预算剩余 + 环境元数据
- **DSP 可重放性（用户裁决 A）**：**检索结果快照纳入 checkpoint**——恢复时用快照而非重新检索（MemoryStore 演化不破坏确定性）；快照格式 = 检索摘要文本 + 记忆版本号（轻量）；**上限：实时场景 4KB/轮，恢复场景放宽 16KB**（可配置；恢复完整性优先——版本级水位线过滤后可见版本减少，截断风险在恢复场景降低）；内容寻址去重；恢复快照**不重检索不计数**（hitCount 以实时检索为准——快照恢复期间计数漂移，文档化接受）
- **预算**：DSP 有超预算截断策略，**牺牲顺序：投影区 → 工具列表区 → 记忆入口区（可沉淀候选提示位最后截断）**

## 8. 通讯（与记忆分离）

**通讯 = 纸带交换**（瞬态、定向、近实时）；公域记忆 ≠ 通讯（及时性差是特性）。

- **comms 与用户消息同通道（用户裁决）**：纸带片段作为 user 消息追加进接收方纸带（带来源标记 `peer:<id>`），与 operator 消息走完全相同注入路径——不绕过校验链（因为不冒充记忆）
- **传输复用 ptl-communicate + 语义桥接 `sdk.comms`**（C 方案）：`send(peer, tapeFragment)` / 收件事件 `comms_received`（可触发转移）；进 WorkLoopSDK
- **comms 独立日志**（append-only，checkpoint 只存日志指针——防 checkpoint 膨胀）
- **幂等**：接收侧按 msgId 去重——msgId 由 sdk.comms 发送方生成（UUID）；去重范围 = 接收 agent 全局；**去重状态随 checkpoint 水位同步（第四轮 R4）**：dedup 记录带 checkpoint 水位，resume 后丢弃晚于 S 的 dedup 记录（允许重复投递，纸带 append-only + 内容比对兜底——防“已投递但被拒收”的幽灵拒收）；纸带 fork/clone 时 comms 消息不随分支重放（消息是事件不是纸带内容）
- **mode 映射**：agent↔agent 消息**必须 auto 模式**（manual 模式会被人力门卡死"近实时"）
- **身份映射**：agentId → (tenantId, sessionId) 映射层（mailbox 按 tenant/session 寻址——需新建）；**映射持久化 + 刷新**：sessionId 易失（会话重启失效）——映射表存 agentId → tenantId + 最新 session 指针，会话重启时刷新指针；**投递失败（目标离线）→ 消息进队列等待上线**（mailbox pending 语义复用），不静默丢
- **大小上限**：tapeFragment 上限（默认 4KB，可配置——与 DSP 预算联动）；flow human 门 = comms 等待点（带超时/取消语义；等待中收到 comms_received 事件 → 排队不中断，waiting_human 恢复后一并处理）
- **operator peer = pi 会话**；pit TUI 收集通讯记录（comms 日志 → TUI 视图，按时间/peer/会话筛选）
- 通讯内容可沉淀：交换的纸带片段 → δ 提炼 → sdk.memory.write（走正常校验链）

## 9. 观测

- memory_tx / comms / 审核事件 → 注册进既有 Trace/telemetry（schema 扩展，向后兼容）
- Trace 记录：沉淀（含失败）、检索（hitCount 计数）、审核（提交/投票/否决）
- 与 D 的集成接口预留：货币循环消费 comms/审核事件（经济激励：审核付费——D 阶段定）

## 10. 范围与非目标（YAGNI）

- ✅ v1：MemoryEntry + 规则/公理 + EBNF 校验链（JSON/XML 方言 + markdown 低置信）+ 沉淀管道 + 锚点检索 + 私域/公域（fork-merge + 审核矩阵）+ DSP 三区 + comms 桥接
- ⛔ 向量检索（schema 字段都不预留）
- ⛔ fenced 嵌套（转义替代）+ DSL 拼接嵌套精化
- ⛔ 自然语言方言（永不承诺确定性）
- ⛔ 语义约束谓词注册表（等第一条真实约束）
- ⛔ 破产记忆回收/不良资产（子项目 D 经济循环）
- ⛔ 审核激励（D 阶段：审核付费）

## 11. 关键不变量

1. LLM 无状态读写头；记忆全部由状态机/存储侧持有
2. L2/L3 进可见层唯一通道 = 投影；comms/用户消息 = 纸带 user 通道（不冒充记忆）
3. 层间冗余真相源：L2 > L3 > L1 片段
4. 版本模型 = 库级 generation（仅作快照标识）+ 条目级 entry-overlap 冲突检测 + merge 原子递增 + fast-forward/重提重试（≤3）/死信区；条目级版本整数递增
5. 沉淀先落库后事件；写入顺序：条目 + 消费标记同批次、索引最后；启动索引重建
6. 草稿区 TTL + 重试上限 + 显式 promote 路径（同 id 新版本，不静默丢）
7. comms 幂等（msgId 去重，去重状态随 checkpoint 水位同步）+ auto mode + 大小上限 + 离线排队
8. DSP 检索快照进 checkpoint（可重放性；4KB 上限；恢复不计数；与版本级水位线一致——快照只含当时可见版本）
9. 规则更新事务（EBNF + 编译产物同版本原子生效）
10. 审核组合矩阵参数化（基数/弃权/平局）；审核批准与 base 解耦（merge 点重检）；审核结果仅审计事件表（防递归）；meta 规则修改 operator 亲审
11. resume 水位线（仅私域）：遮蔽 watermark > S 的版本，可见版本 = watermark ≤ S 的最新版；公域不随 resume 回滚（同 comms）

## 12. 隐藏依赖与风险（对抗性评审确认）

1. ptl-communicate delivery 语义（manual/hybrid/auto mode 分流）——comms 正确性依赖，agent 间必须 auto
2. agentId → (tenantId, sessionId) 身份映射层——需新建（mailbox 按 tenant/session 寻址）
3. audit.jsonl 4KB 原子追加限制（PIPE_BUF）——多 agent 并发写超 4KB 交错（记录风险）
4. pi 扩展点稳定性：comms 注入依赖 session_start + injectNextTurn/injectSteer——pi API 变更击穿通讯层
5. FlowCodeRegistry 复用：方言适配器/语义谓词注册表基于子项目 A 的注册表机制——接口稳定性是隐藏耦合
6. checkpointEvery 配置：调大则崩溃丢失窗口内全部沉淀与 comms 触发（默认 1）
7. EBNF parser 选型：手写带位置信息 parser（项目 expr.ts 先例）vs 引库——v1 手写（零新依赖约束）
8. MemoryStore 与 checkpoint/fork 的关系：装配时 fork 语义必须含记忆域快照（子项目 C 承接）
9. 经济层激励缺位：agent 为什么审核回写？——B 先于 D 建设，审核义务靠规则约束（D 阶段补激励）
