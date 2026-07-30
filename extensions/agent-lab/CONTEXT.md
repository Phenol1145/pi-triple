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
选择由哪个 Agent 处理任务、并驱动相应 WorkLoop 的编排者。Arena 按出价选择；Weighted Scorer 按评分选择。

**Bid**:
Agent 为赢得任务在 Arena 中出的押注（credits）。由竞价 WorkLoop 产出，并对照任务结果结算。

### 竞价

**Bidding WorkLoop**:
调度器级的单一职责 WorkLoop，向某 Agent 的模型询问一个 stake。它是 Scheduler 在竞价轮中施加到 Candidate 上的转移函数——不是该 Agent 自己的（执行用）WorkLoop。
_Avoid_: bid agent, bidding subagent
