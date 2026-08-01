# Agent Lab

Agent Lab 是一个遥测驱动的模型选择与 agent 编排框架：调度哪个模型/agent 处理任务、经由可插拔的执行循环运行 agent、并从观测到的遥测中优化调度参数。

## Language

### 执行模型（图灵机类比）

**WorkLoop**:
状态转移函数（δ）。给定 context、state 与 task，产出新的 context、state 与 output。每个 WorkLoop 实现是同一基底上的不同转移函数。
_Avoid_: runner, executor, engine, loop

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
