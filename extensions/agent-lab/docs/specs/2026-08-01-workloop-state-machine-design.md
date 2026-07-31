# WorkLoop 状态机化设计（图灵机模型落地）

- **日期**：2026-08-01
- **状态**：设计已确认，待实现规划
- **范围**：workloop 基底（contracts / runner / 全部 workloop 实现）重构为显式状态机运行时；契约重构（`machine` 取代 `run`）；执行器双轨；转移级自动 checkpoint；Trace 重定义
- **核心定位**：把 WorkLoop 从「runner/executor/loop 式命令式代码」统一为 CONTEXT.md 认知模型中的图灵机形态——显式状态机（有限控制 + 数据域 + 纸带），确定性骨架约束无状态概率 LLM
- **文档优先级**：本设计是对 `2026-07-26-agent-lab-global-architecture-design.md` 第 5 节（WorkLoop 与 WorkLoop SDK）的执行层细化；认知模型术语以 `CONTEXT.md` 为准（本设计修订其 State/Trace 条目，修订内容见 §3、§7）

---

## 1. 背景与目标

### 1.1 认知模型（CONTEXT.md，图灵机类比）

| 术语 | 定义 |
|------|------|
| **WorkLoop** | 状态转移函数（δ）。给定 context、state 与 task，产出新的 context、state 与 output |
| **Context** | 纸带。WorkLoop 读取、追加、变换的累积消息历史与元数据；经 checkpoint 跨转移持久化 |
| **Session** | 纸带的持久化实例（jsonl 契约，pi 交互会话为规范实现） |
| **State** | 跨转移携带、经 checkpoint 持久化的数据（本设计修订：见 §3） |
| **Trace** | 状态追踪（本设计重定义：见 §7） |
| **Agent** | 状态存储实体：持久、带身份、绑定默认 WorkLoop、context 与 state 跨运行持久化 |

### 1.2 代码现状与模型的差距

- `workloops/managed-loop.ts`：命令式 `while + break + 局部变量累加`——循环逻辑、停止判定、上下文管理策略散落在过程代码里，无显式状态
- `workloops/pi-default-loop.ts`：一次性委托 pi + 隐式分支表（`mapResponse`）——执行在黑盒 pi 进程内，本地无循环、无中间观测、中断即丢进度
- `workloops/market-bid-loop.ts` / `budgeted-history.ts` / `selective-summary.ts`：单次询问 / 策略钩子，同样非状态机形态
- `workloop/runner.ts`：已具图灵机雏形（快照 + CAS 提交 + checkpoint + 事件），但 workloop 内部逻辑仍是黑盒

### 1.3 官方循环（pi agent-loop）分析

pi 官方循环（`pi-agent-core/dist/agent-loop.js`）是双层 while 循环：内循环 = 工具调用链（turn），外循环 = follow-up 消息；每 turn：注入 steering → LLM 调用 → stopReason 处理（length → 整批失败）→ tool batch（默认并行）→ 结果入 context → compaction 决策。**循环骨架固定，数据驱动决策**——与图灵机模型同构，但为命令式、不可观测、不可恢复。

本设计在 workloop 基底**本地镜像官方语义**：官方循环继续负责 pi 进程内执行（委托式），状态机表达同等语义（turn 级转移、stopReason、tool batch、预算终止），作为可观测、可持久化的编排层。

### 1.4 目标

1. WorkLoop 统一为显式状态机：状态枚举 + 转移表 + δ（step）
2. 每次转移可观测（Trace）、可持久化（checkpoint）、可恢复（resume）
3. 执行器双轨插拔：委托式（pi 事件流 → 转移）与本地式（model.complete + tools 直接驱动）收敛到同一基底
4. 对外契约重构为状态机原生，调用方（scheduler / experiment / arena）迁移后零行为变化

---

## 2. 概念模型（经讨论确认）

### 2.1 三层结构

```
第一层  控制状态（有限、可枚举、转移表定义域）
            ↑ 派生（阈值分类）
第二层  记忆/数据域（credit 等持久化数值：无限取值、checkpoint 持久化、不透明于 LLM）
            ↑ 读写
第三层  纸带（消息历史：追加式、可 fork/clone/branch、LLM 的唯一信息源）
```

### 2.2 LLM 的地位

LLM = **无状态概率读写头**：读纸带（确定），写纸带（概率分布），停止行为概率性（stopReason 分布）。推论：

- LLM 不持有任何跨调用状态 → 纸带必须累积、记忆只能维护在状态机/存储域侧
- 停止不可直接控制 → 终止由状态机 + 预算（turn/tool budget + timeout）强制保证

状态机 = **确定性骨架**：模型输出作为事件进入转移表；模型可以不收敛，但预算强制终结。

### 2.3 记忆的地位（修订 State 条目）

**State（总状态）= 控制状态 + 记忆/数据域**：

- **控制状态**：有限、可枚举、转移表定义域；描述执行位置；本身不携带信息（非记忆）
- **记忆/数据域**：credit 等跨转移存活的不透明持久化数据；四个作用——跨转移存活（checkpoint 落盘）、**派生**（阈值分类 → 控制状态，如 `credit < 0 → BANKRUPT`）、δ 的决策输入与副作用（读作出价、结算写回）、按需**投影到模型可见层**（DSP，§2.6）
- 连续值（credit）不进转移表定义域；经派生分类后的有限语义（破产/正常）才进入转移表
- 与纸带区分：状态 vs 上下文（CONTEXT.md 术语纪律：memory 专指状态型记忆，纸带用 Context/Session 表述）

### 2.4 记忆系统预留（未来）

传统语义记忆系统（事实/经验/偏好，跨任务存活、可检索、会演化）= **数据域扩展**（第三类记忆）。与 credit 同性质：不透明于 LLM、按需投影到模型可见层（DSP / 检索注入）、跨运行持久化；多出检索与演化语义。追踪方式：记忆变更走 tx 审计（复用 credit_tx 模式），见 §7.3。

### 2.5 状态认知（agent 如何知道自己处于什么状态）

分层知道：

| 主体 | 方式 | 精度 |
|------|------|------|
| 状态机引擎 | 寄存器持有当前状态 | 精确（私有） |
| LLM（行为体） | **状态投影**（控制状态 + 记忆摘要 → 注入 DSP / 任务文本） | 近似（语义化） |
| 外部观察者 | Trace 转移序列 | 精确（事后） |

**双约束**：

- **硬约束**（引擎侧）：转移表/δ 校验——BANKRUPT 状态无"竞价"边，即使模型发了竞价工具调用，δ 拒绝执行（余额校验失败）。模型"不知道"也能被约束
- **软约束**（行为侧）：状态投影——转移后引擎自动把状态摘要投影，模型"知道"后自觉按状态行事

投影机制：每个状态在 MachineDefinition 声明 `projection?: (ctx, memory) => string`；引擎在每次转移后自动投影（本地式 → DSP，§2.6；委托式 → 任务文本，§5.2）。投影 = 记忆 → 模型可见层的官方接口。

### 2.6 上下文构件地位（SSP / DSP）

现有上下文构件（systemPrompt、AGENTS.md、SYSTEM.md、skills 描述、工具描述、task）按性质分为三层：

| 构件 | 归属 | 性质 |
|------|------|------|
| AGENTS.md / CLAUDE.md、SYSTEM.md / APPEND_SYSTEM.md、skills 描述、工具描述、pi 文档 | **SSP** | 不变量：跨转移、跨运行不变 |
| 状态投影、预算剩余、环境元数据（时间/cwd）、动态工具集 | **DSP** | 派生物：每轮由引擎从（控制状态 + 记忆 + 元数据）重新派生 |
| messages、task 种子 | **纸带消息段** | 追加式、可 fork/clone/branch、checkpoint 持久化 |

**SSP（Static System Prompt）**：配置层，pi 侧拼好后以 `WorkContext.systemPrompt` 传入；状态机不管理、不修改；checkpoint 原样随存。

**DSP（Dynamic System Prompt）**：系统级派生层：

- **引擎统一组装**：从（控制状态投影 + 预算剩余 + 环境元数据 + workloop 声明的投影）派生；δ 不直接写 DSP（只声明投影）
- **每轮重建**：非追加式（区别于消息段）；LLM 调用边界合成 `system = SSP + DSP`
- **不持久化**：派生源（控制状态 + 记忆 + 元数据）都在 checkpoint 内，恢复时重建即可；Trace 记录 DSP 变化（delta），审计不丢
- **不参与分支**：fork/clone/branch 只作用于消息段；SSP 原样继承、DSP 重建

**分界线规则**：是否随转移变化——不变进 SSP，随转移/预算/环境变化进 DSP，对话内容进消息段。

**投影语义**：状态投影注入 DSP（本地式）——它本质是系统对模型的约束指令（"你处于 BANKRUPT 状态"），比消息注入更强制（模型更遵从 system），且不污染纸带审计。

**特殊构件**：

- **task**：初始事件（`start` 事件的 payload）→ δ 写入纸带成为首条 user 消息（种子消息，属消息段）
- **skills**：外部指令源（文件系统），模型经 `read` 工具按需取用，结果 append 进纸带——工具可及的静态指令；该"按需检索 → 注入"路径是未来记忆系统检索的雏形（复用模式）
- **AGENTS.md**：已拼入 SSP，workloop 不感知（黑盒字符串）；未来可作记忆系统的种子来源（可扩展点，本次不做）

---

## 3. 状态机契约（接口重构）

### 3.1 MachineDefinition

```typescript
interface MachineState {
  id: string;
  terminal?: boolean;                                   // 终止状态
  projection?: (ctx: WorkContext, memory: unknown) => string;  // 状态投影（§2.5）
}

interface MachineEvent {
  type: string;
  payload?: unknown;
}

interface StepResult {
  context: WorkContext;        // 纸带新值
  state: unknown;              // 记忆/数据域新值
  event?: MachineEvent;        // 产出的下一个事件（自驱动）
  terminal?: WorkLoopResult;   // 到达终止 → 返回
}

interface MachineDefinition {
  states: ReadonlyArray<MachineState>;                       // 状态枚举（显式）
  initial: string;                                           // 初始状态 id
  transitions: (state: string, event: MachineEvent) => string | undefined;  // 转移表
  step: (ctx: WorkContext, state: unknown, event: MachineEvent, sdk: WorkLoopSDK)
    => Promise<StepResult>;                                  // δ 转移函数
}

interface WorkLoopImplementation {
  id: string;
  version: string;
  cloneModes: string[];
  executorKind: "pi-delegate" | "local-model";  // 执行器声明（§5.1：runner 按 kind 解析实例）
  initialContext(config: unknown): WorkContext;
  initialState(config: unknown): unknown;   // 记忆/数据域初值
  forkState?(state: unknown): unknown;
  machine: MachineDefinition;               // 取代 run()
}
```

语义要点：

- **转移表只对有限控制状态定义**；记忆（数据域）不进入转移表定义域——作为 δ 的决策输入与副作用（§2.3）
- **事件来源统一为两种**：外部（委托式 executor 的 pi 事件流）与内部（δ 自己产出下一事件，如本地式 complete 后发 `turn_finished`）。MachineRuntime 循环 = `state + event → 转移 → δ → 新纸带/记忆 → 下一事件…`，与官方 agent-loop 的 turn 循环同构但显式、可观测、可恢复
- **自驱动与外部驱动可混合**：δ 可产出自驱动事件（本地式）；委托式等待 executor 外部事件

### 3.2 执行器声明与绑定

`WorkLoopImplementation.executorKind` 声明所需执行器；**runner 按 kind 解析实例**（委托式需要 adapter——runner 构造时可选注入；本地式用现有 model/tools 端口），调用方（工厂）零改动。

`run()` 删除；runner 直接驱动 `machine`（§4）。所有调用方经 runner 使用，无直接 `run()` 依赖（§8 迁移面确认）。

### 3.3 上下文契约（SSP / DSP）

- `WorkContext.systemPrompt` 保留 = **SSP**（不变量，checkpoint 原样随存）；MachineRuntime 不管理、不修改
- **DSP** 为 MachineRuntime 内部派生串（投影 + 预算剩余 + 环境元数据），不落 WorkContext；本地式 LLM 调用边界合成 `system = SSP + DSP`（§5.3）；委托式投影并入任务文本（§5.2）
- `WorkContext.messages` = 消息段（状态机管理、checkpoint 持久化、分支语义的唯一作用域）

---

## 4. MachineRuntime（runner 内核心）

### 4.1 驱动循环

```
run(machine, input, executor, sdk):
  state ← machine.initial
  ctx, memory ← input.context, input.state
  event ← { type: "start" }
  loop:
    next ← machine.transitions(state, event)      // 查转移表（硬约束入口）
    if next 未定义 → 事件忽略 + Trace 记录（warning，不中断循环）
    若 δ 抛错 → failed（沿用现 workloop-error 语义）
    result ← machine.step(ctx, memory, event, sdk) // δ
    ctx, memory ← result.context, result.state
    state ← next
    自动投影（state.projection → DSP 派生项 / 委托式任务文本；记 Trace 副作用 dspChanged）
    自动 checkpoint（§4.2）
    转移级 Trace（§7.2）
    if result.terminal → 返回 terminal（runner 按 status 提交 CAS）
    event ← result.event 或等待 executor 外部事件
```

### 4.2 自动 checkpoint 与恢复

- **转移级自动 checkpoint**：每次转移后 `sdk.checkpoint.save(ctx, memory, { label: `${next}#${seq}`, controlState: next })`——纸带（SSP + 消息段）+ 记忆 + 控制状态 + 事件队列全部落盘（复用现有 CheckpointStore）；**DSP 不落盘**（派生源在 checkpoint 内，恢复时重建，§2.6）
- **恢复**：`resume(checkpointId)` → 从 checkpoint 重建（纸带 + 记忆 + 当前控制状态 + 待处理事件），继续循环；中断（pi 进程死亡 / abort）后从最近 checkpoint 重放
- checkpoint 记录关联 Trace：`(traceId, transitionSeq, checkpointId)` 互相索引（恢复位置 = Trace 中该转移的记录）

### 4.3 预算强制终止

turn budget / tool budget / timeout 作为 MachineRuntime 级守卫（不依赖 δ 自觉）：预算耗尽 → 强制 terminal（状态 `budget_exhausted`，对应 `failed` / `cancelled` 语义，沿用现契约状态映射）。

---

## 5. 执行器双轨

### 5.1 Executor 接口

执行器 = **模型调用抽象**（LLM 读写头的封装）；工具执行留在 δ 里（`sdk.tools`，现有）。

```typescript
interface Executor {
  /** 启动执行；返回事件源（外部事件驱动） */
  start(input: WorkLoopInput, sdk: WorkLoopSDK): AsyncIterable<MachineEvent>;
  /** 终止（取消委托 / 释放资源） */
  dispose(): void;
}
```

MachineRuntime 语义：δ 未产出自驱动事件时，从 executor 事件源取下一个事件（委托式：等待 pi update；本地式：见 5.3）。

### 5.2 PiDelegateExecutor（委托式）

包装 `PiSubagentsAdapter.delegate()`：

- `onUpdate` 回调 → 事件流：`pi_turn_start` / `pi_turn_end` / `pi_tool_call` / `pi_tool_result`（含 usage 增量）
- terminal response → `pi_terminal` 事件（payload = 现有 SubagentDelegationV2TerminalResponse 全量）
- 状态机侧：pi-default-loop 声明四状态（`idle → delegating → terminal`），δ 在 `delegating` 状态把事件映射为 Trace 副作用并 checkpoint——**执行仍全在 pi 内，本地获得显式可观测、可恢复的转移序列**
- **中断恢复**：resume 后重新 delegate 使用**新 requestId**（新执行，不依赖 adapter 幂等）；纸带已含历史（fork/continue 语义由 adapter 按 contextMode 处理），本地转移序列从 checkpoint 续接

### 5.3 LocalModelExecutor（本地式）

包装 `sdk.model.complete` + 官方 stopReason 语义：

- `start()` 产出事件流；每个事件 = 一次 complete 的完成（`assistant_turn`：含 stopReason / toolCalls / usage）
- 工具批量执行（parallel / sequential）在 δ 中实现（`sdk.tools.execute` + 结果写回纸带）
- stopReason 转移：`stop` → 终止；`tool_call` → 工具批量 → 下一轮；`length` → 整批失败（镜像官方 failToolCallsFromTruncatedMessage）；`error` → 重试策略（沿用现有 retryable 语义）
- 预算由 MachineRuntime 守卫（§4.3），本地式无需自行检查

---

## 6. 官方语义镜像范围

本次实现（本地式需要真实语义，委托式作为观测/映射）：

| 官方语义 | 本次 | 说明 |
|---------|------|------|
| turn 级转移（turn_start/turn_end） | ✅ | 事件 + 转移 + Trace |
| stopReason 处理（stop/tool_call/length/error） | ✅ | 本地式 δ 实现；length → 整批失败 |
| tool batch（parallel/sequential） | ✅ | 本地式 δ 实现（sdk.tools） |
| 预算终止（turn/tool/timeout） | ✅ | MachineRuntime 守卫（§4.3） |
| steering / follow-up 队列 | ⛔ 不做 | 委托式在 pi 内；本地式 v1 无此需求；留接口（事件类型可扩展） |
| compaction 决策（overflow/threshold） | ⛔ 不做 | 委托式在 pi 内；本地式上下文管理已有策略钩子（budgeted-history / selective-summary），不重复实现；留事件类型 |

---

## 7. Trace 重定义与记忆预留

### 7.1 Trace（重定义，修订 CONTEXT.md 条目）

**Trace**: 状态机转移轨迹。记录状态机从初始到终止的每一次转移：转移前控制状态、触发事件、转移后控制状态、δ 副作用摘要（纸带写入 / 记忆变化 / 工具调用）、关联 checkpointId。

粒度（两级）：

- **执行级（转移级）**：一次运行 = `traceId` + 按序递增的**转移序列**（`transitionSeq`）。转移记录以 `(traceId, transitionSeq)` 唯一定位——状态机的执行轨迹 = 转移序列，可从任意 checkpoint 重放/恢复
- **状态级**：记忆域变化（credit 变化、结算）作为**转移的副作用事件**，以 `(traceId, transitionSeq)` 关联到产生它的那次转移（旧定义仅 traceId 关联，定位不到具体转移）

新语义：**Trace = 恢复的索引**——`resume(checkpointId)` 从 Trace 中该转移的记录重建（纸带 + 记忆 + 控制状态 + 事件队列）。

### 7.2 LabEvent 契约扩展

```typescript
identity: {
  ...现有字段（traceId / executionId / agentInstanceId / optimizationRoundId / workLoopId / workLoopVersion）,
  transitionSeq?: number;   // 可选：转移级事件填充；状态级事件填充以关联来源转移
}
```

新增转移级事件类型：`machine.transition`（转移记录：fromState / event / toState / 副作用摘要 / checkpointId）。向后兼容：旧事件无 `transitionSeq`，消费者按缺省处理。

### 7.3 副作用注册制（记忆系统预留）

转移记录的副作用摘要与状态级事件**注册制**，非硬编码：新存储域 = 新副作用类型 / 新状态级事件类型（`credit_tx` / `market_tasks` / 未来 `memory_tx`…），由各 provider（TUI 阶段确立的 Provider 注册制）声明结构。Trace 核心不感知具体类型。记忆系统的追踪 = 把记忆当作"有检索能力的 credit"：

- 变更类（write / update / forget）= 状态级 tx 事件（含 before/after/version，CAS 语义同 state-store）
- 读取类（retrieve）= 审计事件（记录哪次转移检索了什么、投影到模型可见层的哪段——行为归因）
- 溯源链：记忆条目携带来源（sourceTraceId, sourceTransitionSeq）

本次**不实现**记忆系统，仅保证契约可扩展（副作用摘要字段 + 事件类型注册制）。

---

## 8. 迁移面

### 8.1 文件变更

**新增**：
- `src/workloop/machine.ts`：MachineDefinition / MachineEvent / StepResult / MachineState（§3.1）
- `src/workloop/machine-runtime.ts`：MachineRuntime（§4：驱动循环 / 自动 checkpoint / resume / 预算守卫 / 投影 / 转移 Trace）
- `src/workloop/executor.ts`：Executor 接口（§5.1）
- `src/workloops/executors/pi-delegate-executor.ts`：委托式（§5.2）
- `src/workloops/executors/local-model-executor.ts`：本地式（§5.3）
- `test/unit` 新测试（§9）

**重构**：
- `src/workloop/contracts.ts`：`WorkLoopImplementation.machine` 取代 `run()`；WorkLoopSDK 不变（context / model / tools / storage / artifacts / checkpoint / telemetry / control）
- `src/workloop/runner.ts`：executeRun 检测 `machine` → MachineRuntime 驱动；CAS 提交 / 生命周期事件（agent.started / workloop.* / agent.completed）保持不变；新增 resume 入口
- `src/workloops/pi-default-loop.ts`：四状态机（idle / delegating / terminal）+ PiDelegateExecutor；`mapResponse` 逻辑并入 terminal 转移
- `src/workloops/managed-loop.ts`：五状态机（check / manage / call / append / done）+ LocalModelExecutor；累加器进记忆域（checkpoint 后不丢）
- `src/workloops/market-bid-loop.ts`：单转移状态机
- `src/workloops/budgeted-history.ts` / `selective-summary.ts`：策略钩子迁移为状态机策略（StrategyHook 接口保留，接入 check → manage 转移）

**消费方**（工厂调用点不变，仅依赖重构后的契约）：
- `src/runtime/create-runtime.ts` / `create-scheduler-runtime.ts` / `create-experiment-runtime.ts`
- `src/experiment/facade.ts`

**文档**：
- `CONTEXT.md`：State 条目修订（§2.3）、Trace 条目重定义（§7.1）
- 本 spec 存档

### 8.2 测试迁移

- `test/pi-default-loop.test.ts`、`test/workloops-managed-loop.test.ts`：改为断言状态机行为（转移序列 / terminal 结果与现契约一致）
- `test/workloop-runner.test.ts`：适配 machine 驱动；新增 resume 用例
- 新增：machine-runtime 单测（转移表 / δ / checkpoint / resume / 投影 / 预算守卫）、executor 测试（委托事件映射 / 本地 complete + stopReason）
- 回归：arena-scheduler / arena-execute-mode / experiment 系列（行为不变则全部通过）

---

## 9. 测试策略

1. **MachineRuntime 单测**（纯逻辑，无外部依赖）：转移表查表、非法转移、δ 副作用、自驱动事件循环、自动 checkpoint（次数/内容/label）、resume 重建、预算守卫、投影注入（纸带内容断言）
2. **执行器单测**：PiDelegateExecutor 事件映射（mock adapter onUpdate 序列 → 事件流）；LocalModelExecutor（mock model.complete → stopReason 事件）
3. **workloop 迁移测试**：pi-default（mock adapter → 四状态转移 + terminal 映射与现行为一致）；managed（mock complete → 五状态路径 + 预算/策略路径）
4. **集成回归**：arena 系列 + experiment 系列全绿（契约行为不变性证明）
5. **冒烟**：真实 pi 委托一次（pi-default 状态机路径产出 machine.transition 事件 + checkpoint 文件）

---

## 10. 范围与非目标（YAGNI）

- ⛔ 不实现 steering / follow-up 队列（本地式）
- ⛔ 不实现 compaction 决策（本地式；保留策略钩子现状）
- ⛔ 不实现记忆系统本身（仅预留 Trace 契约：副作用注册制 + 事件类型）
- ⛔ 不新增执行器种类（仅委托式 + 本地式两个）
- ⛔ 不改 WorkLoopSDK 与 runner 对外事件语义（agent.started / workloop.* / agent.completed 等事件类型与载荷不变）
- ✅ 状态投影（§2.5）本次实现（状态声明 projection + 引擎自动注入）

---

## 11. 关键不变量

1. **转移表只对有限控制状态定义**；记忆（数据域）不进入转移表定义域（δ 决策输入 + 副作用）
2. **终止由 MachineRuntime + 预算保证**，不依赖模型自觉
3. **每次转移 = checkpoint + Trace 记录**（三者互相索引：traceId / transitionSeq / checkpointId）
4. **硬约束在引擎**（转移表 / δ 校验），投影是软约束（行为配合）
5. **对外行为不变**：同一 workloop 的 terminal 结果（status / output / context / state）与迁移前一致
6. **CAS 提交语义不变**：仅 completed 提交，failed / paused 不提交（沿用现有）
7. **事件兼容**：LabEvent identity 新增可选 transitionSeq，旧事件无此字段不受影响
8. **SSP 不变量 / DSP 可重建**：`WorkContext.systemPrompt`（SSP）跨转移不变；DSP 由引擎从（控制状态 + 记忆 + 元数据）每轮派生，不落盘、不参与分支，恢复时重建
9. **投影不污染消息段**：本地式投影入 DSP、委托式入任务文本，不写入 messages

---

## 12. 总结

本次设计把 WorkLoop 统一为图灵机形态的显式状态机：有限控制状态（转移表域）+ 记忆/数据域（credit 等，checkpoint 持久化）+ 纸带（消息历史），LLM 作为无状态概率读写头被确定性骨架约束。执行器双轨（委托 / 本地）收敛到同一 MachineRuntime；每次转移自动 checkpoint + Trace 记录，使执行可观测、可恢复、可重放；Trace 重定义为转移轨迹并为记忆系统预留注册制扩展。契约重构为状态机原生，调用方迁移后行为不变。
