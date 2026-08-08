# PTH Kernel 设计综合总览（既有设计整理）

> 日期：2026-08-09
>
> 类型：synthesis（维护者视角）
>
> 依据：2026-08-07 至 2026-08-09 已提交的 Kernel SPEC、计划、exploration 与当前代码。
>
> 边界：本文不增加新设计、不替未决事项作裁决，只归纳既有设计、演进关系和实施状态。
>
> 代码核对基线：`9622a4d` 及其工作区当前状态。

## 1. 本文解决什么问题

近期 Kernel 设计由多份连续 SPEC 构成。每份文档聚焦一个主题，但其中同时出现了：

- 最初目标、后续修订和实测结果；
- 已批准设计、已实现代码和未来阶段；
- 同一术语在不同阶段的扩展；
- 后续 SPEC 对早期结论的更新。

本文提供一个维护入口，将这些内容分为四类：

1. 已有设计共同确认的结构；
2. 当前代码已经体现的部分；
3. 已批准但尚未观察到落地的目标；
4. 文档之间仍存在的分歧或未闭合项。

## 2. 设计演进顺序

```text
Kernel 架构总纲（解释器 / 执行 / 存储）
  ├─ 解释器持久化：snapshot → refine → memory / toolstore
  ├─ 多语言 REPL：TS / Python / Bash 的持久运行时与 Observation
  ├─ TaskResolver：payload.flow 驱动的任务链
  ├─ 性能指标 + 日志：Kernel、任务、Refine、资源的可观测性
  ├─ LLM agent loop：意图任务由 LLM 规划并调用 REPL / capability
  ├─ Kernel sandbox：Python / Bash 的目标执行位置迁到隔离容器
  └─ Environment 生命周期：把会话延续、Kernel 状态、快照和 GC 组合起来
```

仓库拆分 SPEC 与上述运行时设计并行，处理 PTL、PTH、infra、agent-lab 的代码与发布归属。

## 3. 既有文档中的核心术语

### 3.1 Task

Task 是任务池中的基本工作单元，持久化在 PostgreSQL。它同时承载：

- 描述：title、text、tags；
- 生命周期：pending、claimed、submitted、completed、rejected 等；
- 执行归属：claimed_by / role；
- 扩展语义：payload.kind、payload.flow、outputRef、resolvedStages 等。

文档中的“任务 = 意图/工单”和“任务 = 可执行代码”代表两条并存路径：LLM agent SPEC 将其归纳为不同 `kind`，并保留代码直通路径。

### 3.2 Kind 与 Role

- **kind**：任务处理路径，例如 intent、code、chain、ops。
- **role**：同一路径中的工作者定位，例如 analyst、developer、acceptor。

LLM agent SPEC 的既有裁决是“任务分化先于角色分化”。当前基础执行仍保留按角色创建 TaskLoop 的结构。

### 3.3 Flow 与 TaskResolver

- **Flow**：任务 `payload.flow.stages` 中携带的有序阶段表。
- **TaskResolver**：独立于 TaskLoop 的流程解析组件，负责匹配、变形、分解、分支、循环和阶段注销。

“任务池即工作流”指工作流状态附着在任务数据上，而不是另建一个长期 Workflow 实体；TaskResolver 仍然是执行这些规则的确定性组件。

### 3.4 Batch、Worker 与 TaskLoop

- **Batch**：PTH 主进程 fork 出的执行批次进程。
- **Worker**：文档中的角色执行者；当前物理实现主要表现为每个角色一条 TaskLoop 和对应 KernelManager。
- **TaskLoop**：认领任务、选择执行路径、提交结果、归档并触发 Refine 的循环。

### 3.5 Interpreter、REPL Kernel 与 KernelManager

- **Interpreter**：统一的执行接口。
- **TS Interpreter**：基于 Node `vm` 的持久 context。
- **PyKernel / BashKernel**：持久子进程和统一 Observation 通道。
- **KernelManager**：按语言路由执行、统一 reset / snapshot，并承接生命周期和指标事件。

多语言 REPL SPEC 先形成了本地 per-worker Kernel；后续 sandbox SPEC 将共享池的目标归属调整到 sandbox 侧。

### 3.6 Snapshot、Refine、Memory 与 Toolstore

- **Snapshot**：某次任务后可观察到的解释器状态描述。
- **Refine**：由 LLM 从快照和任务上下文中筛选可复用函数与洞察。
- **Memory**：PostgreSQL 中可按 anchors 检索的持久条目。
- **Toolstore**：文档规划的文件型工具/数据通道。

当前代码已经存在三 Kernel snapshot 聚合、Refiner、memory 写入和 recall 能力；protobuf 快照、完整文件双通道和 `state.export` 未在当前代码中观察到完整实现。

### 3.7 Environment

Environment SPEC 将其定义为：`env-id` 加上绑定的 TS/Python/Bash 临时状态，并由任务路由决定 fresh 或延续。

这是已批准的目标模型；当前代码尚未观察到 Environment 注册表、`route.env`、引用计数、环境快照目录和 GC 循环。该词还与 PTL 的环境概念同名，阅读时应按所属产品区分。

### 3.8 Sandbox

Sandbox 是 Python/Bash 非可信代码的目标执行位置。既有设计将 PTH 定位为持有 LLM、记忆和指挥能力的受信侧，将持久 Python/Bash Kernel 放到无业务密钥、受网络限制的 sandbox 侧。

当前 compose 已有一次性 Bash `/exec` sandbox；持久 kernel host、SandboxKernel 适配器和 sandbox 共享池尚未在当前代码中观察到。

## 4. 综合后的系统分层

### 4.1 接入与控制

PTH gateway 接收任务与运维请求；Kernel runtime 装配 BatchManager、TaskResolver、watchdog、scaler、日志和指标。LLM agent loop、模型路由和 capability 也位于 PTH 侧。

### 4.2 批次与任务执行

BatchManager 管理 batch 子进程。每个 batch 创建角色 TaskLoop；TaskLoop 认领任务后，根据已有实现和设计选择代码执行、NL/agent 路径，并在结束后提交、归档和触发 Refine。

### 4.3 多语言计算

KernelManager 为 TS、Python、Bash 提供统一入口：

- TS 用于程序化组合和 PTH capability 调用；
- Python 面向计算与 Python 工具链；
- Bash 面向系统命令和命令行工具链；
- Observation 统一返回 value、stdout、stderr、错误、耗时和截断信息。

### 4.4 状态与知识

短期状态存在解释器 context / namespace / session；任务结果与转录进入 PostgreSQL 和工作区；Refine 把选中的函数与洞察写入 memory。Environment SPEC 进一步把跨任务延续和 GC 纳入统一生命周期，但尚处于目标设计层。

### 4.5 隔离与运行位置

当前本地模式在 batch 进程内启动 Python/Bash 子进程；已有 sandbox 提供一次性 Bash 执行。目标设计是由 sandbox kernel host 托管持久 Python/Bash Kernel，PTH 通过适配器调用，TS 指挥层仍留在 PTH。

## 5. 当前主执行链

按当前代码与已落地设计，可归纳为：

```text
发布 Task
  → PostgreSQL tasks
  → TaskResolver 处理 payload.flow（如存在）
  → 角色 TaskLoop 认领
  → 代码执行或基础 agent loop
  → KernelManager 调用 TS / Python / Bash
  → Observation
  → submit / reject
  → transcript 与 artifact 归档
  → snapshot
  → Refine 异步提炼并写 memory
```

Environment 路由、sandbox 持久 Kernel 和完整 kind 分化属于已批准目标，不应在维护文档中误写为当前主链已全部具备。

## 6. 当前实施状态

下表只表示在代码核对基线上能否观察到主体实现。

| 能力 | 状态 | 代码入口或说明 |
|---|---|---|
| Batch 子进程与角色 TaskLoop | 已落地（核心） | `kernel/execution/batch-manager.ts`、`batch-process.ts`、`task-loop.ts` |
| TS / Python / Bash 统一 KernelManager | 已落地（本地模式） | `kernel/interpreter/kernel-manager.ts` |
| PyKernel / BashKernel 持久进程 | 已落地（per-worker） | `py-kernel.ts`、`bash-kernel.ts` |
| Observation 截断与结构化结果 | 已落地（核心） | `kernel/interpreter/types.ts` 及各 Kernel |
| snapshot 聚合 | 已落地（核心） | `kernel/interpreter/index.ts`、`kernel-manager.ts` |
| Refiner 与 memory recall | 已落地（核心） | `execution/refiner.ts`、`interpreter/capability.ts` |
| 文件型 Toolstore 读取 | 部分落地 | `interpreter/toolstore.ts`；Refine 产物仍主要写 memory |
| protobuf 快照与 `state.export` | 未观察到完整落地 | 持久化 SPEC 的后续部分 |
| TaskResolver | 已落地（核心） | `execution/task-resolver.ts`、`resolver-core.ts` |
| 基础 LLM agent loop | Phase 1 部分落地 | `agent-loop.ts`、`agent-tools.ts`、`parse-agent-action.ts` |
| 完整 kind 路由、verify、多模型四级覆盖 | 未观察到完整落地 | LLM agent SPEC Phase 2/3 |
| Kernel 日志与 batch IPC | 已落地（核心） | `kernel/logger.ts`、`batch-process.ts`、`batch-manager.ts` |
| L0-L3 指标骨架 | 部分落地 | `observability/kernel-metrics.ts`、`resource-provider.ts` |
| sandbox 持久 kernel host / SandboxKernel | 未观察到主体落地 | 当前 `src/sandbox` 仍以一次性 exec API 为主 |
| Environment 注册、路由、快照与 GC | 未观察到主体落地 | Environment SPEC 的 Phase 1-3 |
| sandbox 共享 Kernel 池 | 未观察到主体落地 | sandbox SPEC 的目标形态 |
| 仓库拆分 | 未执行 | 当前仍为 pi-platform 单仓 |

## 7. 已有设计中的共同结论

以下结论在多份文档中重复出现，本文仅作汇总：

1. PTH 任务执行由确定性基础设施和 LLM 驱动执行共同组成。
2. TS、Python、Bash 通过统一解释器接口和 Observation 协议协作。
3. Python/Bash 持久进程用于保留状态并减少重复启动开销。
4. snapshot、Refine、memory/toolstore 形成“临时状态到长期知识”的路径。
5. TaskResolver 负责数据驱动的任务链，TaskLoop 负责实际任务执行。
6. 日志和指标分别提供事件叙事与趋势聚合。
7. Python/Bash 的目标生产执行位置是 sandbox；LLM、记忆与控制能力保留在 PTH。
8. Environment 目标模型用于表达 fresh、延续、恢复和 GC。
9. 仓库目标治理方向是 PTL/PTH 分离，并将 infra 作为共享依赖。

## 8. 已有文档之间的分歧与未闭合项

本节不作裁决，只登记维护者阅读时必须注意的差异。

### 8.1 Kernel 池归属

- 多语言 REPL SPEC 的落地起点是 per-worker 本地 Kernel，并将共享池列为 v2。
- sandbox SPEC 后续裁决共享池应位于 sandbox 侧，并供多个 batch 复用。
- 当前代码对应前者；后者是目标设计。

### 8.2 性能瓶颈判断

- 多语言 REPL SPEC 根据持久进程微基准，把 PostgreSQL 连接池列为主要并发瓶颈。
- LLM agent SPEC 的后续端到端实验显示，agent 任务约 95% 时间来自 LLM 调用，并将 LLM in-flight 视为主要扩缩容信号。
- 两组结论来自不同测试层级和不同阶段，不能直接互相替代。

### 8.3 默认任务 kind

- LLM agent SPEC 的目标语义是无显式 kind 时默认 intent。
- 同一文档的兼容阶段仍规定默认 code，待后续阶段切换。
- 当前维护说明应同时写清“兼容默认”和“目标默认”。

### 8.4 持久化通道

- 持久化 SPEC 同时描述 memory 表、protobuf 快照和文件型 toolstore。
- 当前 Refiner 主要把 tool-function、insight 和 report 写入 memory；toolstore 已有读取能力，但完整的“Refine 写文件 + memory 索引”未观察到。

### 8.5 Environment GC 与恢复

- Environment SPEC 描述 refine、内存释放、快照落盘以及 worker 崩溃后的重建。
- 当前文档没有给出持续 checkpoint 的既有实现，当前代码也未观察到相关组件。
- 因而“崩溃后恢复”仍属于目标描述，不是当前保证。

### 8.6 TaskResolver 文档状态

- TaskResolver 页首把嵌套表达式、`wait:true` 等标记为已裁决。
- 文末仍保留形成设计时的开放问题列表。
- 当前代码已经包含嵌套表达式与 `wait` 字段；开放问题章节应按历史分析阅读。

### 8.7 安全边界措辞

- 多份文档把 TS `vm` 称为“沙箱”或“白名单隔离”。
- sandbox SPEC 同时把容器侧定义为 Python/Bash 的目标隔离执行面。
- 现有文档尚未统一“能力约束”和“操作系统隔离”的术语强度，维护者需结合具体执行位置判断。

### 8.8 仓库拆分基线

- 拆分 SPEC 记录的是 2026-08-08 的 0.2.0 基线和当时文件规模。
- 当前包版本已进入 0.3.0，文件数量也继续增长。
- 文档中的版本和数量是历史快照，不是当前发布事实。

## 9. Exploration 的证据边界

### 9.1 Prime Agent 对照

该文档用于说明 PTC、递归 agent、分层记忆和长期运行的外部参照。它不是 PTH 的规范来源；其中“更安全”“已对齐”等判断仍应回到 PTH 自身 SPEC 和当前代码验证。

### 9.2 任务池运维实验

该文档记录了特定试运行环境中，任务通过 Bash 执行 PG 维护命令的现象。它能说明当时的路由、权限和执行能力，但不构成通用运维流程或安全授权规则。

### 9.3 性能数字

- 0.1ms / 12ms 主要是持久 Python 进程与重复 spawn 的微基准。
- 3-4.6s、约 1200 tokens 和 95% LLM 时间来自小规模 agent 任务实测。
- 10 batch、70 路并发等内容包含场景推演。

这些数字适合说明趋势，不应脱离测试场景作为固定容量承诺。

## 10. 推荐阅读路径

### 理解当前代码

1. Kernel 架构总纲；
2. 多语言 REPL；
3. TaskResolver；
4. 日志与性能指标；
5. LLM agent 执行；
6. 持久化与 Refine。

### 理解目标形态

在上述基础上继续阅读：

1. Kernel sandbox；
2. Environment 生命周期；
3. 仓库拆分。

### 理解设计来源

最后阅读 Prime Agent 对照和任务池实验，避免把探索记录误当成正式约束。

## 11. 原始文档索引

- [Kernel 架构总纲](./2026-08-07-pth-kernel-architecture.md)
- [Kernel 解释器](./2026-08-07-pth-kernel-interpreters.md)
- [Kernel 执行层](./2026-08-07-pth-kernel-execution.md)
- [Kernel 存储层](./2026-08-07-pth-kernel-storage.md)
- [解释器持久化](./2026-08-08-pth-interpreter-persistence-design.md)
- [多语言持久 REPL](./2026-08-08-pth-multilang-repl-design.md)
- [TaskResolver](./2026-08-08-pth-task-resolver-design.md)
- [性能计量](./2026-08-08-pth-perf-metrics-design.md)
- [日志体系](./2026-08-08-pth-logging-design.md)
- [LLM agent 执行](./2026-08-08-pth-llm-agent-execution-design.md)
- [Kernel sandbox](./2026-08-08-pth-kernel-sandbox-design.md)
- [Environment 生命周期](./2026-08-08-pth-environment-lifecycle-design.md)
- [仓库拆分](./2026-08-08-repo-split-design.md)
- [Prime Agent 对照](../explorations/2026-08-08-prime-agent-reference.md)
- [任务池运维实验](../explorations/2026-08-08-taskpool-ops-experiment.md)
