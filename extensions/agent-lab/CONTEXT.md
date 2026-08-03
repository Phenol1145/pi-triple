# Agent Lab

Agent Lab 是一个遥测驱动的模型选择与 agent 编排框架：调度哪个模型/agent 处理任务、经由可插拔的执行循环运行 agent、并从观测到的遥测中优化调度参数。

## Language

### 执行模型（图灵机类比）

**WorkLoop**:
状态转移函数（δ）。给定 context、state 与 task，产出新的 context、state 与 output。每个 WorkLoop 实现是同一基底上的不同转移函数。
_Avoid_: runner, executor, engine, loop
（实现痕迹：`runner`（WorkLoopRunner/SchedulerRunner）为实现级容器名（hosts MachineRuntime），非域概念，不计入本 Avoid 术语。）

**Context**:
纸带。WorkLoop 读取、追加、变换的累积消息历史与元数据；经 checkpoint 跨转移持久化。
_Avoid_: conversation, history, session（session 专指纸带的落盘实例，见下）

**Session**:
纸带的持久化实例。WorkLoop 推理消息历史的落盘形态（pi 交互会话为规范实现，jsonl 格式契约）。纸带是数据——可复制（fork/clone）、分叉（branch）、转移所有权（transfer）。任何 WorkLoop 只要按纸带契约持久化推理历史（含竞价中的模型询问），即产出 Session。
_Avoid_: conversation, chat；不要用 session 指代运行中的纸带（那是 Context）

**State**:
总状态 = 控制状态 + 记忆/数据域。
**控制状态**：有限、可枚举、转移表定义域——描述执行位置，本身不携带信息（非记忆）。
**记忆/数据域**：credit 等跨转移存活的不透明持久化数据（无限取值，不进转移表定义域）——四个作用：跨转移存活（checkpoint 落盘）、派生（阈值分类 → 控制状态）、δ 的决策输入与副作用、按需投影到模型可见层（DSP）。
_Avoid_: context, memory（避免与纸带/Context 混淆）

**Trace**:
状态机转移轨迹。记录状态机从初始到终止的每一次转移：转移前控制状态、触发事件、转移后控制状态、δ 副作用摘要（纸带写入 / 记忆变化 / 工具调用）、关联 checkpointId。
粒度（两级）：执行级（转移级）= 一次运行 = `traceId` + 转移序列（`transitionSeq`），转移记录以 `(traceId, transitionSeq)` 唯一定位；状态级 = 记忆域变化（credit 变化、结算）作为转移的副作用事件，以 `(traceId, transitionSeq)` 关联来源转移。
新语义：Trace = 恢复的索引——`resume(checkpointId)` 从 Trace 中该转移的记录重建（纸带 + 记忆 + 控制状态 + 事件队列）。
_Avoid_: session, log（log 太泛）

**Agent**:
状态存储实体。一个持久、带身份的实体，绑定一个默认 WorkLoop，其 context 与 state 跨运行持久化。Agent 被 WorkLoop 驱动；它本身不是 WorkLoop。
_Avoid_: model, candidate, worker

### 调度

**Candidate**:
在一次调度轮中被提供以供选择的模型。Candidate 实例化后成为 Agent。
_Avoid_: contestant, option

**Scheduler**:
选择由哪个 Agent 处理任务、并驱动相应 WorkLoop 的编排者。**Market** 按出价选择；Weighted Scorer 按评分选择。
_Avoid_: Arena（旧代号，已弃用，统一为 Market）
（实现痕迹：`src/arena/` 目录与 `arena-*` 文件保留共享库前缀（有意，Phase 7 legacy retirement 决策），外部概念统一称 Market。）

**Market**:
基于出价的调度器代号（agents 以 credits 竞标，最高价中标，对照结果结算）。是 "market" 这一调度器类型的规范名称。
_Avoid_: Arena

**Bid**:
Agent 为赢得任务在 Market 中出的押注（credits）。由竞价 WorkLoop 产出，并对照任务结果结算。

### 竞价

**Bidding WorkLoop**:
调度器级的单一职责 WorkLoop，向某 Agent 的模型询问一个 stake。它是 Scheduler 在竞价轮中施加到 Candidate 上的转移函数——不是该 Agent 自己的（执行用）WorkLoop。
_Avoid_: bid agent, bidding subagent

### 身份与命名（存储对象）

**核心原则（身份/名称解耦）**：会被改名、被外键引用、有运行生命周期的「实例」用**不可变 UUID 身份 + 可变 name**；代码按语义引用的「定义」与做幂等的「事件键」保持**语义名**。身份与名称解耦——改名不改身份，从根本消除名称错配/碰撞。

**Instance（实例）**:
运行时创建、有生命周期、被外键引用的具体实体：Scheduler Instance、Optimizer Instance、Agent、Optimization Round、Routing Binding。身份是不可变 UUID（主键/被外键引用）；name 是可变的逻辑标识，用于幂等查找（findOrCreate by name）与人类可读。
_Avoid_: 用名称字符串作主键/身份（natural key）

**Definition（定义）**:
调度器 / WorkLoop / 优化器的**类型标识**（如 `market`、`weighted-scorer`、`pi-default-loop`、`weighted-tuner`）。语义契约，代码按语义名（names.ts 常量）引用，稳定不变。不是实例身份，**不 UUID 化**。
_Avoid_: 把定义 id 当作实例身份去 UUID 化

**Event（事件）**:
事件日志（lab_events）的条目。`event_id` 是**确定性幂等键**（重放不重复），用于幂等追加；不是要解耦的身份，**不用随机 UUID**。
_Avoid_: 用随机 UUID 作事件幂等键

**判断标准**：是「某个具体运行实例」（会改名、被 FK 引用、有生命周期）→ UUID 身份 + name；是「类型/契约」（代码按语义引用）或「幂等键」→ 保持语义名。

### 记忆系统（L3 语义记忆，`src/memory/`）

**三层记忆**：L1 纸带（Context/Session，append-only + 时间索引）；L2 数据域（credit/elo 等 State 面持久数据）；**L3 语义记忆**（LLM 可读写的知识库——本子系统）。**统一不变量：LLM 是无状态读写头；L2/L3 进模型可见层的唯一通道 = 投影（DSP）；通讯与用户消息 = 纸带 user 通道（不冒充记忆）**。

**MemoryEntry**:
L3 的原子单位——单一清晰语义、不可再分、版本化（content 不可变、修改即新版本）、溯源数组、锚点非空（`anchor: <文本> `，`text` 段）。kind 开放注册（`kind:<id>`）；内置 **axiom**（唯一公理——自我引用「遵循公理」的自我指涉，存在性等同一阶逻辑一致性，冲突须拒绝）、**rule**（行为规则：id/触发条件/参数/EBNF 语法/默认值/优先级）、**fact**、**experience**、**preference**；其余记为方言条目。参数无单位（仅实例局部语义）。
_Avoid_: note, snippet, chunk

**语言体系（四层）**：L0 语义层（knowledge/experience/preference/...）；L1 语法层（**EBNF**——人类可续写的表达文法；其他结构化格式（JSON/XML）经 fenced 围栏识别转交确定性解析）；L2 方言层（JSON/XML 确定性 + markdown（默认低置信 → draft-only 草稿区）；自然语言永不承诺）；L3 语义约束层（事实=两实体+关系；经验=场景+动作+效果）。LLM 读取时**只看语义不懂语法**——语法服务于持久化与迁移。

**DSP（动态系统提示词）**：每轮运行时重建的可见层投影——记忆入口区（工作记忆）+ 工具列表区 + 投影区（阈值参数注入）。静态协议（SSP）= AGENT.md 固定工作协议（仅纸带方式/delivery=auto/身份/记乎原则），**不写具体记忆**。L2 credit → DSP 投影注入（非条目）。

**公域（Public Domain）**：全局共享 L3（全部 kind 的检索作用域）。**私域**：每 agent 自己的 L3。写入私域自由；**发轫（genesis）**：私域→公域 fork-merge（发轫分支自由 merge，merge 需审核链）；公域记忆**不可直接编辑**。规则的唯一解析依赖 = 公域（fallback 链）。

**审核链**：单一审核算子 compose：operator（信任源）/model（agent）/self（预定义规则，无 LLM 参与，试运行/拒绝词）；组合矩阵（C1-C9）+ quorum + 超时/弃权规则 + operator 一票否决；结果仅入审计事件表（不可回写标记）。

**通讯**：agent↔agent / agent↔operator = **纸带交换**（CommsChannel：msgId 幂等；auto mode：写入方写纸带（L1）+ 接收方 user 消息注入；TUI 收集通讯记录）。桥接 pit-communicate 传输。

### 装配层（Agent Assembly，`src/assembly/`）

**Assembler**：6 步装配（resolve workloop → configSchema 校验 → 注册预检 → 记忆域初始化 → 开户 → 注册持久化）→ 组装 AgentRuntime。**装配原子性**（attempt-local）：任何后续步骤失败 → 回滚本次副作用（记忆域目录删除 + 账户注销——仅限本次创建）。

**AgentRuntime**：装配产物——run(task, config) 自填绑定字段（traceId/executionId/agentInstanceId/workLoopId/optimizerRoundId），委托共享注入的 WorkLoopRunner 执行；resume = resumeFromCheckpointId；dispose 停后台组件。

**记忆域**：agent 专属 L2+L3 落盘目录（`.pi-platform-data/agents/<id>/`）。**fresh** = 最小记忆合集（公理 + 基础规则 + 空私域）；**fork** = 最小合集 + 源私域整库拷贝（索引重建 + 独立演化）。

**LedgerPort**：账本抽象——open（endowment 首次记账，返回 created 标记）/balance/debit（**余额预检抛错**——钱的事 fail-fast）/freeze/unfreeze/settle；removeAccount 仅装配回滚（attempt-local）。**记忆域初始化与开户成功解耦**：记忆域失败不取消既有账户（新开户失败则回滚——语义差异）。

**续跑幂等**（崩溃后重装配）：oracle = **注册记录预检**（getAgent——唯一全序 oracle）；开户幂等 = created 标记（余额不参与判定）；记忆域残留不删除（保守）。

**规则链（Rule Chain）**：agent 的完整行为规则 = 公域规则库（kind=rule 只读视图）+ 私域解析/公理——可续写（LLM 生成 EBNF → 私域 → 发轫进公域）。**修改规则：改公共规则 = 版本分叉 + 审核；改自己 = 私域新规则条目（若公域已有更具体规则则冗余）**。规则冲突 = 规则条目自身（触发相同、参数不同）→ **每次装配时审核**（默认值候补）+ 发轫进公域时审核。

_Avoid_: （装配层）provision, bootstrap（bootstrap 已用于种子初始化场景，避免泛指装配）
