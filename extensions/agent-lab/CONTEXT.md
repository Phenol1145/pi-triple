# Agent Lab

Agent Lab 是一个遥测驱动的模型选择与 agent 编排框架：调度哪个模型/agent 处理任务、经由可插拔的执行循环运行 agent、并从观测到的遥测中优化调度参数。

## Language

### 执行模型（图灵机类比）

**WorkLoop**:
状态转移函数（δ）。给定 context、state 与 task，产出新的 context、state 与 output。每个 WorkLoop 实现是同一基底上的不同转移函数。
_Avoid_: runner, executor, engine, loop

**Context**:
纸带。WorkLoop 读取、追加、变换的累积消息历史与元数据；经 checkpoint 跨转移持久化。
_Avoid_: conversation, history, session

**State**:
有限控制状态。跨转移携带、经 checkpoint 持久化的、各 WorkLoop 自有的不透明数据。与 Context（消息纸带）相区别。
_Avoid_: context, memory

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
