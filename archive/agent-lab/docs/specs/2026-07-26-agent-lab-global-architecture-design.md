# Agent Lab 全局概要设计

- **日期**：2026-07-26
- **状态**：已实现；§5 执行模型与 §11 Trace 定义已被《WorkLoop 状态机化设计》(2026-08-01-workloop-state-machine-design.md) 取代（见节首标注），其余章节作为历史记录保留
- **范围**：Agent Lab 全局架构，以及现有 Weighted Scorer、Arena 与 pi-subagents 的重新定位
- **核心定位**：Agent Lab 是通用的 Agent 调度优化实验平台；Arena 是其中一种可插拔的调度器实现
- **文档优先级**：本设计取代旧文档中的 `classic/market` 顶层架构；旧 Core/Arena 文档继续作为迁移前实现的行为基线和历史决策记录

---

## 1. 背景与目标

当前 Agent Lab 已实现遥测驱动的 Weighted Scorer，以及基于 credits、竞价和结算的 Arena。现有实现以 `classic/market` 模式区分两套调度路径，调度、执行、遥测和优化概念尚未形成稳定边界。

新的全局架构将系统拆分为三个核心概念：

1. **Scheduler（调度器）**：负责实际调度操作、Agent 实例管理和执行编排，并暴露输入、输出、错误、过程数据及可调参数。
2. **Agent / WorkLoop**：Agent 是实际执行单元；每个 Agent 只有一个 WorkLoop，WorkLoop 是其上下文管理、模型/工具调用、状态演化和终止逻辑的执行核心。
3. **Optimizer（优化器）**：读取调度和执行数据，根据自身目标和触发逻辑优化 Scheduler 暴露的参数，但不直接操作 Agent 或 Scheduler 私有状态。

目标是建立一条可运行、可观测、可优化、可灰度、可回滚的通用闭环，同时允许实验不同调度方法、Agent 工作循环和上下文管理策略。

---

## 2. 总体架构

```text
Agent Lab Core
├── 控制面
│   ├── Scheduler / Optimizer / WorkLoop 定义注册
│   ├── Draft → Validate → Activate 实例构建
│   ├── 路由、迁移、灰度、发布与回滚
│   └── Agent 复制及血缘管理
├── 调度层
│   └── SchedulerInstance
│       ├── 固定 SchedulerDefinition 版本
│       ├── 固定 Agent Definition Schema 版本
│       ├── 管理所属 AgentInstance
│       ├── 保存私有运行状态
│       ├── 维护优化轮次历史
│       └── 通过 Scheduler SDK 编排执行
├── Agent 执行层
│   └── AgentInstance
│       ├── 唯一且不可变地隶属一个 SchedulerInstance
│       ├── 持有不可变 AgentDefinition
│       ├── 以唯一 WorkLoop 作为执行核心
│       ├── 单实例 single-flight
│       └── 保存 context / state / checkpoint
└── 优化层
    └── OptimizerInstance
        ├── 自行定义目标与触发时机
        ├── 读取调度数据和历史参数
        ├── 仅生成参数提案
        └── 不直接操作 Agent 或 Scheduler 状态
```

核心闭环：

```text
调度请求
  → 路由到 SchedulerInstance
  → Scheduler 按当前 OptimizationRound 参数运行
  → 选择、装配或复制 AgentInstance
  → Agent 的 WorkLoop 通过 SDK 执行
  → 记录 input / output / error / trace 与中间事件
  → Optimizer 判断是否触发优化
  → 生成 ParameterProposal
  → 验证、灰度、评估、发布
  → 形成新的不可变 OptimizationRound
```

职责边界：

- Agent Lab Core 提供定义注册、实例管理、SDK、存储、执行、安全、遥测和控制面。
- Scheduler 负责在线调度、Agent 装配与持久化、执行编排、结果聚合及回退意图。
- WorkLoop 负责单个 Agent 内部的上下文、推理、工具、状态及终止逻辑。
- Optimizer 负责分析数据和提出参数变更，不执行调度，也不修改运行状态。
- Arena、Weighted Scorer、未来 Bandit、协作或工作流方案均是 Scheduler 实现。
- pi-subagents 是首个 Agent Runtime 后端，不是 Agent Lab 的调度策略。

---

## 3. 定义、实例与不可变性

系统明确区分定义和实例：定义描述版本化规则与契约，实例承载实际运行数据。

```text
SchedulerDefinition ──创建──▶ SchedulerInstance
WorkLoopDefinition  ──引用──▶ AgentDefinition ──创建──▶ AgentInstance
OptimizerDefinition ──创建──▶ OptimizerInstance
```

### 3.1 SchedulerDefinition

```ts
interface SchedulerDefinition {
  id: string;
  version: string;
  implementation: SchedulerImplementation;

  parameterModel: SchedulerParameterModel<unknown>;
  agentDefinitionSchema: JsonSchema;
  schedulerStateSchema?: JsonSchema;

  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  errorSchema: JsonSchema;
  traceSchema?: JsonSchema;

  requiredSchedulerSdkVersion: string;
  capabilities: string[];
}
```

SchedulerDefinition 决定：

- 接受的调度输入及产生的输出、错误和 trace；
- 所管理 Agent 的自定义定义数据结构；
- 可向 Optimizer 暴露的参数模型；
- Agent 装配、复制、选择和执行方式；
- Scheduler 私有状态的数据契约。

同一 `id@version` 不可覆盖。实现、执行语义或 Schema 改变必须发布新版本。

### 3.2 SchedulerInstance

```ts
interface SchedulerInstance {
  id: string;
  definition: { id: string; version: string };
  status: "draft" | "active" | "inactive" | "migrating";
  currentRoundId: string;
  fallbackChain: FallbackTarget[];
  createdAt: number;
}
```

实例创建后固定：

- SchedulerDefinition 版本；
- Agent Definition Schema 版本；
- Parameter Model 版本。

实例拥有：

- 唯一隶属于它的 AgentInstance 集合；
- Scheduler 私有运行状态；
- 独立的 OptimizationRound 历史；
- 实例级回退链；
- 路由绑定和生命周期状态。

Agent Definition Schema 结构变化时，必须创建新的 SchedulerInstance 并显式迁移；旧实例和历史保持可查询。

### 3.3 AgentDefinition

Agent 定义采用“平台标准信封 + Scheduler 自定义定义”：

```ts
interface AgentDefinition<TCustom, TWorkLoopConfig> {
  standard: {
    name: string;
    description?: string;
    capabilities: string[];
    executionKind: string;
    labels: Record<string, string>;
  };
  workLoop: {
    id: string;
    version: string;
    config: Readonly<TWorkLoopConfig>;
  };
  custom: Readonly<TCustom>;
}
```

标准字段仅承担发现、展示、路由、基础权限和审计。`custom` 的结构由所属 SchedulerDefinition 的 `agentDefinitionSchema` 决定。

Agent 定义值不可原地修改。更换模型、prompt、工具、知识或 WorkLoop 配置时，Scheduler 创建新的 AgentInstance 并记录来源。只有定义 Schema 结构改变时，才需要新建 SchedulerInstance。

### 3.4 AgentInstance

```ts
interface AgentInstance {
  id: string;
  schedulerInstanceId: string;
  definition: Readonly<AgentDefinition<unknown, unknown>>;
  sourceAgentId?: string;
  cloneOperationId?: string;
  createdAtRoundId: string;
  status: "ready" | "running" | "queued" | "inactive" | "failed";
}
```

约束：

- `schedulerInstanceId` 创建后不可改变；
- 跨 SchedulerInstance 只能复制，不允许改变归属；
- 每个 AgentInstance 只有一个 WorkLoop；
- 同一个 AgentInstance 同一时刻最多有一个活动执行；
- 并行主要发生在不同 AgentInstance 之间；
- context、state 和 checkpoint 是实例运行数据，不进入不可变定义。

### 3.5 OptimizerDefinition 与 OptimizerInstance

```ts
interface OptimizerDefinition {
  id: string;
  version: string;
  requiredMetrics: MetricRequirement[];
  compatibility: SchedulerCompatibility;
  configurationSchema: JsonSchema;
  stateSchema?: JsonSchema;
}

interface OptimizerInstance {
  id: string;
  definitionId: string;
  definitionVersion: string;
  configuration: unknown;
  status: "active" | "inactive";
}
```

OptimizerInstance 保存自己的配置、触发状态和搜索历史。一个实例可以先后优化多个兼容的 SchedulerInstance；SchedulerInstance 的不同轮次也可以由不同 OptimizerInstance 产生。Optimizer 不永久拥有 Scheduler。

---

## 4. Scheduler 与 Scheduler SDK

### 4.1 编程模型

Scheduler 是普通命令式异步程序：

```ts
interface Scheduler<TInput, TOutput, TError, TTrace> {
  schedule(
    input: SchedulingInput<TInput>,
    parameters: Readonly<unknown>,
    sdk: SchedulerSDK,
  ): Promise<SchedulingResult<TOutput, TError, TTrace>>;
}
```

Scheduler 可以自由实现筛选、评分、竞价、Agent 创建或复制、串并行派发、重试、聚合和回退。所有 Agent 管理、执行和持久化操作必须经过 Scheduler SDK。

### 4.2 Scheduler SDK

```ts
interface SchedulerSDK {
  agents: {
    list(query?: AgentQuery): Promise<AgentSnapshot[]>;
    create(spec: AgentCreateSpec): Promise<AgentInstanceRef>;
    clone(sourceId: string, spec: AgentCloneSpec): Promise<AgentInstanceRef>;
    deactivate(agentId: string): Promise<void>;
    run(agentId: string, input: AgentRunInput): Promise<AgentRunResult>;
    runParallel(requests: AgentRunRequest[]): Promise<AgentRunResult[]>;
  };
  storage: NamespacedStorage;
  telemetry: SchedulerTelemetry;
  control: SchedulerControl;
}
```

Scheduler SDK 强制：

- Scheduler 只能管理所属实例的 Agent 和私有命名空间；
- Agent single-flight；
- 预算、取消、权限和生命周期检查；
- Agent 创建、复制、停用和血缘记录的原子性；
- 标准调度事件和指标记录。

### 4.3 Scheduler 管理 Agent 群体

Scheduler 负责 Agent 的装配、创建、复制、停用、持久化和运行管理。Optimizer 不能直接执行 Agent 管理操作。

Scheduler 可以把 `populationSize`、`clonePolicy`、`workLoopVariants` 等暴露为参数。Optimizer 仍只提出参数；参数轮次激活后，由 Scheduler 解释参数并执行受控 reconcile。

---

## 5. WorkLoop 与 WorkLoop SDK

> ⚠️ **SUPERSEDED (2026-08-01)**: 执行模型已被《WorkLoop 状态机化设计》(2026-08-01-workloop-state-machine-design.md) 取代——WorkLoop 为状态机（machine 契约），Trace 为转移轨迹（transitionSeq）。本节约保持历史记录。

### 5.1 WorkLoop 是 Agent 的核心

WorkLoop 不是 Agent 的可选组件，而是 Agent 的唯一执行核心，负责：

- 上下文构建和变换；
- 模型调用与工具调用循环；
- 工作状态演化；
- 反思、摘要、检索和恢复；
- 预算感知和终止条件；
- 最终输出、错误和 trace。

### 5.2 WorkLoopDefinition

WorkLoop 是受信任、版本化的 TypeScript 插件：

```ts
interface WorkLoopDefinition<TConfig, TState, TOutput, TError, TTrace> {
  id: string;
  version: string;
  sdkVersionRange: string;
  configSchema: JsonSchema<TConfig>;
  stateSchema?: JsonSchema<TState>;
  outputSchema?: JsonSchema<TOutput>;
  errorSchema?: JsonSchema<TError>;
  traceSchema?: JsonSchema<TTrace>;
  requiredCapabilities: WorkLoopCapability[];
  cloneModes: CloneModeDefinition[];
  run: WorkLoop<TConfig, TState, TOutput, TError, TTrace>;
}
```

AgentDefinition 只能引用已注册的 WorkLoop。插件代码、Schema 或执行语义变化必须发布新版本，既有 Agent 继续绑定原版本。

### 5.3 命令式 WorkLoop

WorkLoop 使用普通异步函数，不引入状态机、DAG 或专用 DSL：

```ts
async function run(input, sdk) {
  let context = input.context;
  let state = input.state;

  context = buildContext(context, state);
  const response = await sdk.model.complete(context);
  context = sdk.context.append(context, response.message);

  return {
    status: "completed",
    output: response,
    context,
    state,
  };
}
```

WorkLoop 可用普通 TypeScript 函数完成任意复杂的上下文过滤、排序、摘要、检索、合并、分支和多阶段重建。

### 5.4 WorkLoop SDK

```ts
interface WorkLoopSDK {
  context: ContextOperations;
  model: ModelOperations;
  tools: ToolOperations;
  storage: AgentStorage;
  artifacts: ArtifactOperations;
  checkpoint: CheckpointOperations;
  telemetry: WorkLoopTelemetry;
  control: WorkLoopControl;
}
```

- `context`：不可变的 append、filter、merge、truncate 等基础操作；
- `model`：模型解析、凭据、流式调用、usage、成本、重试、超时和取消；
- `tools`：工具发现、授权、执行、超时、错误和结果转换；
- `storage`：当前 Agent 获准的命名空间状态；
- `artifacts`：大型上下文、工具结果、摘要及可回放产物；
- `checkpoint`：可恢复、可 fork 的 context/state 快照；
- `telemetry`：WorkLoop 自定义事件，SDK 操作自动产生基础事件；
- `control`：预算、取消、暂停、结束和受控降级。

所有外部副作用和资源消耗必须经过 SDK。WorkLoop 不直接调用 provider、pi 工具、公共数据库或其他有副作用的 Runtime API。

### 5.5 WorkContext

首版直接基于 pi-ai `Context`：

```ts
interface WorkContext extends Context {
  metadata: {
    contextId: string;
    parentContextId?: string;
    sourceRefs: string[];
    artifactRefs: string[];
  };
}
```

每次变换产生新的逻辑上下文，不覆盖历史快照。敏感内容可只记录受控 Artifact 引用、哈希和统计，不强制进入普通遥测。

### 5.6 状态与 checkpoint

WorkLoop 正常结束时返回最终 `context` 和 `state`，由平台原子保存。长任务仅在显式调用时创建中间 checkpoint：

```ts
await sdk.checkpoint.save({
  context,
  state,
  label: "after-analysis",
});
```

平台不拦截普通局部变量。暂停、崩溃恢复和 fork 最多恢复到最近一次已提交 checkpoint。checkpoint 记录 Agent、execution、WorkLoop 版本、OptimizationRound、父 checkpoint、Schema 版本和 Artifact 引用。

### 5.7 中间事件

SDK 自动记录模型、工具、checkpoint、Artifact、预算和生命周期事件。WorkLoop 对复杂上下文变换主动发出标准或命名空间事件，但不需要遵守固定步骤。

标准类别包括：

```text
workloop.started / paused / resumed / completed / failed
context.created / transformed / restored
model.requested / completed / failed
tool.requested / completed / failed
checkpoint.created / restored
```

---

## 6. Agent 复制、迁移与并行

### 6.1 复制模式

Scheduler 必须定义 Agent 的定义性数据。复制时始终复制这些数据，暂态数据是否复制由复制模式决定。

首批标准模式：

```text
fresh
  复制 Agent 定义性数据
  使用 WorkLoop 初始 context/state

fork
  复制 Agent 定义性数据
  从指定 checkpoint 复制 WorkContext
  复制 WorkLoop 声明为 forkable 的 state
```

Scheduler 可定义其他模式，但必须声明：

- 复制和重置哪些暂态数据；
- 源、目标 Schema 和 WorkLoop 版本兼容条件；
- 是否允许跨 SchedulerInstance；
- 失败时是否允许退化为 fresh。

活动任务、工具调用、锁、连接、取消信号和未提交事务不得复制。

### 6.2 血缘

每次复制创建新的 Agent ID，并记录：

```ts
interface AgentLineage {
  sourceAgentId: string;
  targetAgentId: string;
  sourceSchedulerInstanceId: string;
  targetSchedulerInstanceId: string;
  cloneMode: string;
  sourceCheckpointId?: string;
  operationId: string;
  createdAt: number;
}
```

源 Agent 保持不变，目标 Agent 永久隶属于目标 SchedulerInstance。

### 6.3 并行语义

- 同一个 AgentInstance 采用 single-flight；
- 后续任务排队；
- Agent 间并行由 Scheduler 实现；
- WorkLoop 内部可以并行调用模型、工具或检索，但仍属于一次 execution；
- 需要独立演化路径时，使用 fresh 或 fork 创建新的 AgentInstance。

---

## 7. 参数模型与 OptimizationRound

### 7.1 参数和运行状态边界

凡 Scheduler 主动暴露的值，平台一律按参数处理；未暴露的数据一律按 Scheduler 私有运行状态处理。平台不根据业务语义推断二者边界。

例如 Arena 可以暴露初始 credits 公式、odds、税率、最大押注比例、bidder 选择策略和群体规模；当前余额、冻结资金、pending task 和竞标历史可以保持私有状态。

### 7.2 SchedulerParameterModel

```ts
interface SchedulerParameterModel<TParams> {
  version: string;
  schema: JsonSchema<TParams>;
  defaultParameters: Readonly<TParams>;
  tunablePaths: string[];
  validate(parameters: unknown): ParameterValidation<TParams>;
  validateTransition?(
    current: Readonly<TParams>,
    proposed: Readonly<TParams>,
  ): ParameterTransitionValidation;
}
```

平台负责 Schema、版本、可调路径和提案审计；Scheduler 负责参数业务语义和应用行为。

### 7.3 OptimizationRound

OptimizationRound 属于具体 SchedulerInstance：

```ts
interface OptimizationRound<TParams> {
  id: string;
  schedulerInstanceId: string;
  sequence: number;
  parentRoundId?: string;
  parameters: Readonly<TParams>;
  optimizer?: {
    instanceId: string;
    definitionId: string;
    definitionVersion: string;
  };
  proposalId?: string;
  status:
    | "initial"
    | "proposed"
    | "validated"
    | "canary"
    | "active"
    | "rejected"
    | "superseded"
    | "rolled-back";
  createdAt: number;
  activatedAt?: number;
}
```

语义：

- 初始参数形成 Round 0；
- 参数不可原地修改；
- 每次优化发布新的不可变轮次；
- 每次调度绑定实际使用的 `roundId` 和参数快照；
- 已开始任务继续使用其原轮次；
- 灰度时基线和候选轮次可并存；
- 回滚通过复制历史参数创建新轮次，不修改历史。

优化历史可以回答 SchedulerInstance 被优化了几次、由哪些 OptimizerInstance 优化、参数如何演化以及每轮效果如何。

---

## 8. Optimizer 与参数发布闭环

### 8.1 Optimizer 职责

Optimizer 自行定义：

- 优化目标；
- 触发时机；
- 数据窗口和最低样本；
- 参数搜索或学习方法；
- 候选轮次评估逻辑。

Agent Lab 提供事件订阅、指标查询、定时器和手动触发基础设施，但不替 Optimizer 决定何时运行或什么是业务最优。

### 8.2 兼容契约

```ts
interface OptimizerCompatibility {
  schedulerDefinitions?: Array<{ id: string; versionRange: string }>;
  parameterModelVersionRange: string;
  parameterSchemaFingerprint?: string;
  requiredSchedulerCapabilities: string[];
  requiredMetrics: MetricRequirement[];
  requiredCustomSchemas?: SchemaRequirement[];
}
```

运行前验证 Scheduler 版本、参数模型、指标和自定义事件可用性、数据权限及可调参数路径。

### 8.3 参数提案

```ts
interface ParameterProposal<TParams> {
  id: string;
  schedulerInstanceId: string;
  baseRoundId: string;
  proposedParameters: Readonly<TParams>;
  changedPaths: ParameterChange[];
  objective: unknown;
  dataWindow: DataWindowRef;
  rationale: string[];
  confidence?: number;
}
```

Optimizer 只能产生完整参数快照提案，不能直接创建、删除或修改 Agent，也不能写 Scheduler 私有状态。

### 8.4 提案到发布

```text
ParameterProposal
  → 基础 Schema 校验
  → tunablePaths 与版本兼容校验
  → Scheduler.validateTransition()
  → 平台安全策略校验
  → 可选离线回放或影子评估
  → 候选 OptimizationRound
  → Canary
  → Optimizer 评估
  → 平台推广或回滚
```

平台安全策略具有否决权，但不替 Optimizer 判断业务效果。过期 `baseRoundId` 提案不自动合并，必须重新优化。

### 8.5 灰度状态隔离

SchedulerDefinition 声明支持的发布方式：

```ts
type RoundRolloutCapability =
  | "shared-state-canary"
  | "isolated-state-canary"
  | "shadow-only";
```

- `shared-state-canary`：参数轮次安全共享 Scheduler 私有状态和 Agent 群体；
- `isolated-state-canary`：候选轮次使用独立状态命名空间和 Agent 副本；
- `shadow-only`：候选参数只做决策回放，不实际派发。

Arena 默认使用 `isolated-state-canary` 或 `shadow-only`；纯 Weighted Scorer 通常可以使用 `shared-state-canary`。

### 8.6 评估与发布

Optimizer 输出：

```text
promote | continue | rollback | inconclusive
```

Agent Lab 执行样本隔离、审批、安全门槛、灰度比例、原子推广和回滚。一个 SchedulerInstance 同一时刻只有一个参数发布流程，使用 compare-and-swap 防止过期提案覆盖新轮次。

---

## 9. 标准执行信封与数据流

### 9.1 标准信封 + 自定义数据

```ts
interface ExecutionEnvelope<TInput, TOutput, TError, TTrace> {
  identity: {
    dispatchId: string;
    executionId: string;
    schedulerInstanceId: string;
    optimizationRoundId: string;
    agentInstanceId?: string;
    traceId: string;
  };
  input: {
    standard: StandardInput;
    custom?: TInput;
  };
  result:
    | { status: "completed"; standard: StandardOutput; custom?: TOutput }
    | { status: "failed"; standard: StandardError; custom?: TError }
    | { status: "cancelled" | "paused" | "abstained"; reason: string };
  trace: {
    standard: StandardTrace;
    custom?: TTrace;
  };
}
```

标准字段用于跨 Scheduler、Agent 和 WorkLoop 比较；自定义字段承载 Arena bids、Weighted Scorer 特征、上下文变换原因等领域数据。

### 9.2 一次执行

```text
1. SchedulingRequest 进入 Agent Lab
2. 显式 schedulerInstanceId 或静态路由选择实例
3. 固定 OptimizationRound 参数快照
4. Scheduler 通过 SDK 选择、创建或复制 Agent
5. Scheduler SDK 检查 Agent single-flight，必要时排队
6. Runtime 加载 AgentDefinition、WorkLoop、context/state
7. WorkLoop 通过 SDK 执行上下文、模型和工具循环
8. WorkLoop 返回结果和最终 context/state，或 checkpoint 后暂停
9. Scheduler 根据 Agent 结果继续编排、聚合或请求回退
10. 平台保存执行信封、事件和 Artifact 引用
11. Optimizer 接收事件并自行判断是否触发
```

### 9.3 实例级回退链

```ts
type FallbackTarget =
  | { type: "scheduler-instance"; id: string }
  | { type: "original-request" }
  | { type: "fail"; errorCode: string };
```

平台负责循环检测、最大深度、预算、输入输出兼容、错误聚合和完整 trace。回退不改变 Agent 归属。前序失败、成本和延迟不会被最终成功覆盖。

---

## 10. Runtime 与 pi-subagents

首版不重新实现成熟的 subagent 基础设施，而是将 pi-subagents 作为默认 Runtime 后端：

- 复用 Agent 发现、模型解析、工具与 skill 注入；
- 复用会话持久化、异步执行、暂停、恢复、取消和 supervisor 通道；
- 增加程序化 Runtime 接口，使 `SchedulerSDK.agents.run()` 不依赖交互式文本协议；
- 将现有执行循环逐步适配到 WorkLoop SDK；
- 将 fresh、fork 映射到 Agent 复制和 checkpoint 语义；
- 为模型、工具、上下文和生命周期增加必要的标准事件。

当特定 WorkLoop 实验无法由现有 pi-subagents Runtime 承载时，可以修改该扩展的受支持接口，或注册另一个 Runtime 实现；所有 Runtime 仍必须遵守统一 WorkLoop SDK 和执行信封。

Agent Lab 不无必要地复制或重写 pi-subagents 的完整运行时，但架构允许针对复杂上下文管理实验替换 Runtime。

---

## 11. 遥测与优化数据

> ⚠️ **SUPERSEDED (2026-08-01)**: 执行模型已被《WorkLoop 状态机化设计》(2026-08-01-workloop-state-machine-design.md) 取代——WorkLoop 为状态机（machine 契约），Trace 为转移轨迹（transitionSeq）。本节约保持历史记录。

### 11.1 存储模型

```text
不可变追加式事件日志
  + 可重建的标准化查询投影
  + 大型/敏感内容的 Artifact 引用
```

遥测记录事实，不预先计算某个 Optimizer 专属的业务分数。事件不可修改，投影可以重建。

### 11.2 事件信封

```ts
interface LabEvent<TPayload> {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  timestamp: number;
  sequence?: number;
  identity: {
    traceId: string;
    sessionId?: string;
    dispatchId?: string;
    executionId?: string;
    parentExecutionId?: string;
    schedulerInstanceId?: string;
    schedulerDefinitionId?: string;
    schedulerDefinitionVersion?: string;
    optimizationRoundId?: string;
    agentInstanceId?: string;
    workLoopId?: string;
    workLoopVersion?: string;
    checkpointId?: string;
    optimizerInstanceId?: string;
    proposalId?: string;
  };
  payload: TPayload;
  metrics?: Record<string, MetricValue>;
  artifactRefs?: string[];
}
```

### 11.3 标准事件族

```text
请求与路由
  scheduling.requested
  routing.resolved / failed
  fallback.started / completed

Scheduler
  scheduler.started / completed / abstained / failed
  scheduler.agent.selected / created / cloned / deactivated

Agent 与 WorkLoop
  agent.queued / started / completed / failed / cancelled
  workloop.started / paused / resumed / completed / failed

上下文
  context.created / transformed / restored
  context.summary.created
  context.retrieval.completed
  checkpoint.created / restored

模型与工具
  model.requested / completed / failed / retried
  tool.requested / completed / failed

优化
  optimizer.triggered / skipped / started / completed / failed
  proposal.created / validated / rejected
  round.canary.started / evaluated / promoted / rolled_back

控制面
  instance.drafted / validated / activated / deactivated
  migration.started / completed / failed
  agent.clone.started / completed / failed
```

### 11.4 标准指标

核心指标至少覆盖：

- **调度输入**：role、任务类别、难度、输入规模、上下文/工具/能力需求和预算；
- **调度过程**：候选数、排除原因、选择理由、决策耗时、参数轮次、群体操作和回退路径；
- **WorkLoop**：循环步数、模型/工具次数、context token 变化、摘要/检索/合并、checkpoint 和恢复；
- **模型调用**：provider/model、tokens、缓存、价格、排队/首 token/推理/总延迟、重试和错误；
- **工具调用**：工具、成功率、耗时、输入输出规模、权限拒绝、超时和资源代理；
- **结果质量**：completion、acceptance、人工评分、Judge/测试结果、结构化输出合法性；
- **可靠性**：超时、限流、provider/model/tool/internal 错误、中断、恢复和回退；
- **资源经济**：实际美元成本、估算成本、token、时间及 Scheduler 自定义经济指标；
- **关联信息**：session、trace、dispatch、execution、parent/child、Scheduler、Agent、WorkLoop 和 round。

指标标明 `observed`、`estimated` 或 `derived` 来源，并记录口径版本。

### 11.5 自定义命名空间

插件注册自定义事件与指标 Schema，例如：

```text
scheduler.arena.stake
scheduler.arena.odds
scheduler.arena.balance_before
scheduler.arena.balance_after
scheduler.weighted_scorer.score
workloop.selective_memory.retrieval_hits
workloop.summary.compression_ratio
optimizer.bayesian.expected_improvement
```

平台保存但不解释其业务含义。

### 11.6 Artifact 与隐私

完整 prompt、上下文、输出、工具结果和 checkpoint 默认不进入普通指标表。事件保存 Artifact ID、哈希、媒体类型、Schema、大小、token 统计、加密和访问级别。Optimizer 读取原始 Artifact 必须显式声明并获得授权。

### 11.7 查询投影

```text
dispatch_runs
agent_executions
model_calls
tool_calls
context_operations
scheduler_agent_snapshots
optimization_rounds
optimization_proposals
metric_points
metric_aggregates
```

投影支持按 SchedulerInstance、OptimizationRound、Agent、WorkLoop、模型、role、任务类别和时间窗口聚合，并保存投影版本和处理水位。

### 11.8 OptimizationDataAPI

```ts
interface OptimizationDataAPI {
  queryExecutions(query: ExecutionQuery): Promise<ExecutionPage>;
  queryMetrics(query: MetricQuery): Promise<MetricSeries>;
  compareRounds(query: RoundComparisonQuery): Promise<RoundComparison>;
  getParameterHistory(schedulerInstanceId: string): Promise<RoundSummary[]>;
  getAgentPopulationSnapshot(ref: SnapshotRef): Promise<AgentPopulationSnapshot>;
  readArtifact(ref: ArtifactRef, grant: AccessGrant): Promise<Artifact>;
  subscribe(filter: EventFilter): AsyncIterable<LabEvent>;
}
```

Optimizer 不直接查询数据库。必要数据不足时必须跳过或显式降级，不得把缺失值静默视为零。

---

## 12. 控制面

### 12.1 定义注册

注册表管理 SchedulerDefinition、OptimizerDefinition 和 WorkLoopDefinition。注册时验证 ID/版本唯一性、内容指纹、Schema、SDK 兼容、capability、自定义事件和插件来源。同一 `id@version` 不可覆盖。

### 12.2 SchedulerInstance 构建

采用：

```text
Draft → Validate → Activate
```

Draft 包含 SchedulerDefinition 引用、初始参数、Agent、回退链、路由和发布策略。

Validate 检查：

1. Definition、Agent Schema 和 ParameterModel 版本；
2. Round 0 参数；
3. Agent 定义和 WorkLoop 引用；
4. SDK capability 与 Runtime；
5. Agent ID、路由和回退链冲突；
6. 凭据、权限、预算和存储；
7. Scheduler 初始化及私有状态创建。

Activate 原子创建 SchedulerInstance、Round 0、AgentInstance、私有状态、路由和审计事件。失败不留下可参与调度的半成品。

### 12.3 OptimizerInstance 构建

单独创建 OptimizerInstance，配置数据和 Artifact 授权、资源限制及状态。实际优化 SchedulerInstance 前再次验证兼容性。

### 12.4 路由

显式 `schedulerInstanceId` 优先；未指定时使用静态路由：

```ts
interface RoutingBinding {
  id: string;
  priority: number;
  match: {
    role?: string;
    taskCategory?: string;
    labels?: Record<string, string>;
    caller?: string;
  };
  targetSchedulerInstanceId: string;
}
```

路由只选择 SchedulerInstance，不筛选 Agent 或计算优化分数。冲突在验证阶段报告，每次调度记录路由快照。

### 12.5 迁移

SchedulerDefinition 或 Agent Schema 升级时：

```text
创建目标 Draft
  → 源实例 export
  → 目标 Scheduler migrate/import
  → 按策略复制 Agent
  → 初始化目标 Round 0
  → Validate
  → 原子切换路由
  → 保留或停用旧实例
```

迁移契约声明参数、Agent Definition、context/state/checkpoint 和私有状态转换规则。目标 Agent 使用新 ID，旧 Agent 归属不变。

### 12.6 对外接口

TypeScript API、`agent_lab` 工具、`/lab` 命令和未来 Dashboard 共享同一控制面服务。

建议命令空间：

```text
/lab definitions <list|inspect>
/lab schedulers <draft|validate|activate|list|inspect|deactivate|migrate>
/lab agents <create|clone|list|inspect|lineage|deactivate>
/lab optimizers <create|list|inspect|activate|deactivate|run>
/lab rounds <history|inspect|compare|promote|rollback>
/lab routes <list|set|remove|validate>
/lab telemetry <trace|metrics|data-quality>
```

复杂 spec 使用结构化对象或 Artifact 引用，不依赖脆弱的命令行字符串解析。

---

## 13. 存储、安全与故障处理

### 13.1 存储边界

Agent Lab 提供命名空间化存储 SDK、事务、版本、快照、审计和迁移原语。Scheduler 定义数据 Schema、生命周期和复制语义；WorkLoop 只访问当前 Agent 获准的命名空间。插件不能直接写公共数据库。

### 13.2 权限与隔离

- Scheduler 只能管理自身实例的 Agent 和私有状态；
- WorkLoop 只能访问声明并获准的模型、工具、存储和 Artifact；
- Optimizer 默认只读声明所需指标；
- provider 凭据短时注入，不进入参数、事件或 checkpoint；
- 首版允许同进程加载受信任插件，但 SDK 契约不依赖同进程特权，以便后续进程隔离。

### 13.3 预算

```ts
interface ExecutionBudget {
  deadline?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxAgentExecutions?: number;
  maxParallelism?: number;
}
```

Scheduler 可分配预算，但不得突破顶层上限。回退、重试、摘要、Judge 和竞价调用均计入总预算。

### 13.4 标准错误

至少区分：

```text
invalid-input
incompatible-definition
permission-denied
budget-exhausted
timeout
cancelled
provider-error
model-error
tool-error
workloop-error
scheduler-error
optimizer-error
storage-error
telemetry-gap
internal-error
```

### 13.5 处理原则

- Scheduler 失败按实例级回退链处理；
- Agent 失败由 Scheduler 决定重试、替换、部分聚合或 abstain；
- checkpoint 恢复形成新的 execution，原失败保留；
- Optimizer 失败不影响稳定轮次；
- 候选轮次故障不影响基线轮次；
- 遥测失败进入耐久重放队列，主路径可 fail-open，但必须暴露缺口；
- Agent 状态、轮次激活和群体 reconcile 使用事务或幂等补偿。

### 13.6 一致性

- Agent single-flight 使用租约强制；
- context/state 只由当前 execution 提交；
- Agent 复制及血缘原子完成；
- Round 激活与参数切换原子完成；
- Scheduler 私有事务按业务关联键隔离；Arena 冻结资金必须按 task/transaction 独立记录；
- 崩溃恢复和结算必须幂等。

---

## 14. 现有能力在新架构中的定位

### 14.1 Weighted Scorer

```text
WeightedScorerScheduler
  参数：评分权重、候选资格、探索率、可靠性门槛等
  输入：任务、Agent 群体和共享遥测
  输出：选择及执行结果
  私有状态：必要缓存和 Agent 运行数据

TelemetryWeightOptimizer / BayesianOptimizer
  读取质量、成本、延迟和可靠性指标
  提出新的评分参数
```

### 14.2 Arena

```text
ArenaScheduler
  参数：endowment、odds、tax、maxBidders、stakeLimit、资格及选择规则等
  输入：任务、Agent 群体和当前市场状态
  操作：竞价、选择、执行、结算和群体管理
  私有状态：credits、冻结资金、bid、pending task 和 Agent 群体

ArenaEconomicOptimizer / GenericBayesianOptimizer
  读取成功率、成本、延迟、市场效率、破产率和多样性
  提出新的 Arena 参数
```

Arena 不再是平台模式。现有 `market.eligibility` 等规则由 ArenaScheduler 自行解释；平台只执行不可绕过的权限和安全检查。

### 14.3 pi-subagents 与上下文实验

- pi-subagents 提供首个 Runtime；
- `pi-default-loop@1` 提供兼容现有行为的首个 WorkLoop；
- 新上下文策略通过新的 WorkLoop 实现或不可变 Agent 定义变体表达；
- Scheduler 装配并比较这些 Agent；
- Optimizer 只优化 Scheduler 暴露的参数，不直接选择或修改 WorkLoop。

---

## 15. 测试策略

1. **SDK 契约测试**：权限、预算、取消、事件、事务、checkpoint 和 Artifact。
2. **插件一致性测试**：Schema、版本、capability、错误及执行信封。
3. **WorkLoop 测试**：上下文变换、模型/工具 mock、checkpoint、恢复、fresh/fork。
4. **Scheduler 测试**：Agent 装配、选择、并行、回退、预算和群体 reconcile。
5. **Optimizer 测试**：触发、数据缺失、提案范围、过期基线和评估。
6. **控制面测试**：Draft→Validate→Activate、迁移、路由、灰度、推广和回滚。
7. **事件回放测试**：从事件日志重建投影并校验归因、成本和延迟口径。
8. **端到端测试**：真实 pi-ai/pi-subagents 执行及参数轮次比较。

每个插件必须通过平台 compliance suite。单元测试使用 fake Runtime，真实模型调用仅用于受控冒烟和实验验证。

---

## 16. 渐进迁移路线

### 阶段 0：固定行为基线

- 保留现有 63 项测试；
- 固定当前 SQLite 和配置格式；
- 补充竞价、结算及回退的可重复冒烟。

### 阶段 1：Core 契约

- Definition Registry；
- SchedulerInstance、AgentInstance、OptimizationRound；
- 标准执行信封、命名空间存储和最小控制面；
- 暂不改变现有 subagent 拦截行为。

### 阶段 2：WorkLoop SDK 与 Runtime

- 实现 `pi-default-loop@1`；
- 为 pi-subagents 增加程序化接口和生命周期事件；
- 验证 fresh、fork、checkpoint、取消和工具遥测。

### 阶段 3：迁移 Weighted Scorer

- 封装 `weighted-scorer` SchedulerDefinition；
- 创建默认 SchedulerInstance 和 AgentInstance；
- 保持旧 `/lab recommend` 行为兼容。

### 阶段 4：迁移 Arena

- 封装 `arena` SchedulerDefinition；
- 现有配置形成 Round 0；
- 迁移 credits 和 task 数据到 Arena 私有命名空间；
- 将 `classic/market` 转换为静态路由及实例级回退；
- 同时修复按 task 独立冻结、资格过滤和押注风控。

### 阶段 5：Optimizer 闭环

- 先实现只产生提案、人工推广的参考 Optimizer；
- 再加入灰度、评估、自动发布和回滚；
- 验证同一 SchedulerInstance 被不同 OptimizerInstance 连续优化。

### 阶段 6：上下文策略实验

- 用 WorkLoop SDK 实现多个不可变 Agent 变体；
- Scheduler 装配、复制和调度这些 Agent；
- 使用标准事件和 OptimizationRound 比较质量、成本、延迟和可靠性。

迁移期间保留 `/lab mode classic|market` 兼容入口，内部映射到默认 SchedulerInstance；新控制面稳定后再弃用。每一阶段均应可切回当前稳定实现。

---

## 17. 首版边界与非目标

首版必须形成一条可运行闭环：

1. 注册版本化 Scheduler、WorkLoop 和 Optimizer；
2. Draft → Validate → Activate 构建 SchedulerInstance；
3. 创建和持久化 AgentInstance；
4. 通过 pi-default-loop 和 pi-subagents Runtime 执行；
5. 保存标准执行信封和关键事件；
6. 建立 Round 0 并绑定每次调度；
7. 参考 Optimizer 读取数据并产生提案；
8. 验证、建立候选轮次、人工推广或回滚；
9. 迁移 Weighted Scorer 和 Arena；
10. 保留当前命令和数据的兼容路径。

首版明确不做：

- 通用状态机或 DAG DSL；
- 完整重写 pi-subagents Runtime；
- AgentDefinition 内嵌任意代码；
- Optimizer 直接修改 Agent、credits 或 Scheduler 私有状态；
- 多 Optimizer 同时合并一个提案；
- 任意 SchedulerDefinition 间自动迁移；
- 元调度器或无限制动态路由；
- Arena 经济概念进入 Agent Lab Core；
- 分布式执行和跨机器一致性；
- 强制把完整上下文原文写入遥测。

---

## 18. 关键不变量

1. Arena 只是 Scheduler 实现之一，Core 不依赖其经济概念。
2. Scheduler 负责实际操作、Agent 管理和持久化；Optimizer 只读取数据并提出参数。
3. AgentInstance 永久隶属于一个 SchedulerInstance；跨实例只能复制。
4. 一个 Agent 只有一个 WorkLoop；同一 Agent single-flight，并行主要发生在 Agent 之间。
5. WorkLoop 是 Agent 执行核心，负责上下文、模型/工具循环、状态和终止。
6. 所有外部副作用和资源消耗必须经过 SDK。
7. SchedulerInstance 固定 Definition 和 Schema 版本；Schema 变化必须新建实例并迁移。
8. Scheduler 暴露的值均为参数；未暴露的数据均为私有运行状态。
9. 参数不可原地修改；每次发布形成不可变 OptimizationRound。
10. 每次调度记录实际轮次、AgentDefinition 和 WorkLoop 版本。
11. Optimizer 自行定义目标、触发和评估；平台负责安全、灰度、发布和回滚。
12. 事件日志只追加且不可变；投影可重建，缺失数据不得静默视为零。
13. 前序失败、成本和延迟不得被后续回退成功覆盖。
14. 复制和迁移必须保留血缘；活动任务和未 checkpoint 状态不得复制。
15. 控制面操作必须可审计，不得直接修改配置或数据库绕过轮次历史。

---

## 19. 总结

Agent Lab 的目标架构是一个以 Scheduler、Agent/WorkLoop 和 Optimizer 为核心的通用调度优化平台：

```text
SchedulerDefinition
  → SchedulerInstance
      → 管理和调度 AgentInstance
          → 运行唯一 WorkLoop
              → 通过 WorkLoop SDK 调用模型、工具和上下文能力

执行事实
  → 追加式事件与标准投影
      → OptimizerInstance 自主触发和定义目标
          → ParameterProposal
              → 验证、灰度、评估与发布
                  → 新 OptimizationRound
                      → Scheduler 使用新参数继续运行
```

Weighted Scorer 和 Arena 都成为该架构上的具体 Scheduler。pi-subagents 提供首个 Runtime，pi-default-loop 提供首个 WorkLoop。不同上下文管理和 Agent 工作范式通过版本化 WorkLoop 与不可变 Agent 变体进行实验；不同优化方法通过兼容的 OptimizerInstance 接入，而无需改写 Scheduler 的在线执行逻辑。
