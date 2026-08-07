# Scout-1: 单复数目录对侦察报告（scheduler/schedulers, workloop/workloops, optimizer/optimizers）

> 侦察范围：`extensions/agent-lab/src/`。方法：find + wc -l、grep export、全库 import 计数、交叉 import 检查、git log 溯源、导出名碰撞比对。

## 总体结论（先读这个）

三对目录**不是重复实现**，而是刻意的一层化分割：**单数 = 框架层（contracts/registry/runner 基础设施），复数 = 插件层（具体 definition/实现/引导）**。依赖方向设计为 复数→单数 单向。

- scheduler、workloop 两对：分层**干净**（0 条反向 import），仅各有 1 处**兼容 re-export** 造成"看起来重复"的名字（有 git commit 明证是刻意为之）。
- optimizer 对：分层**有脏点**——框架层 2 个文件反向 import 插件层（`facade.ts:15`、`shadow.ts:28`），另有 `shadow.ts:29` 跨到兄弟插件目录 `schedulers/`。这是三对中唯一需要动手的。

canonical（按全库 import 计数）：**三个单数目录全部是 canonical**（框架层被广泛消费），复数目录是注册进框架的插件实现，二者都不是对方的遗留版本。

---

## 1. scheduler/（单数） vs schedulers/（复数）

### 文件与行数
| 目录 | 文件 | 总行数 |
|---|---|---|
| `src/scheduler/` | 9 个：contracts(126), names(10), registry(67), runner-sdk(220), runner-types(116), runner(968), strategy(26), timed-trigger(558), with-timeout(53) | 2144 |
| `src/schedulers/` | 5 个：arena-definition(510), arena-scheduler(470), bootstrap(404), context-experiment(566), names(22), weighted-scorer(502) | 2474 |

### 主要导出
- **scheduler/**：`SchedulerImplementation`/`SchedulingInput`/`SchedulerSDK`（contracts.ts:16,49,113）、`SchedulerRegistry`（registry.ts:13）、`SchedulerRunner`（runner.ts:28）、`buildSchedulerSDK`（runner-sdk.ts:69）、`TimedTrigger`/`parseCron`（timed-trigger.ts:425,89）、`withTimeout`（with-timeout.ts:29）、定义 id 常量（names.ts:9-10）。
- **schedulers/**：`ARENA_DEFINITION`（arena-definition.ts:395）、`createArenaSchedulerImplementation`（arena-scheduler.ts:99）、`weightedScorerDefinition`（weighted-scorer.ts:189）、`createWeightedScorer`（weighted-scorer.ts:295）、`contextExperimentDefinition`（context-experiment.ts:233）、`ensureArenaInstance`/`ensureWeightedScorerInstance`（bootstrap.ts:215,47）。

### 判断：真实边界，非重复
复数目录的文件实现 `SchedulerImplementation`（scheduler/contracts.ts:113 定义的接口），注册进单数目录的 `SchedulerRegistry`。职责互补：单数=执行调度与契约，复数=三种具体调度策略（market/weighted-scorer/context-experiment）+ 实例引导。

### 交叉 import
- scheduler → schedulers：**0 条**。
- schedulers → scheduler：**6 处**，全为类型/契约/注册表依赖（如 schedulers/arena-scheduler.ts:8、weighted-scorer.ts:10、bootstrap.ts:2）。

### 唯一"重复"点：names.ts
`src/schedulers/names.ts:9` re-export `scheduler/names.ts` 的两个常量：
```ts
export { MARKET_SCHEDULER_DEFINITION_ID, WEIGHTED_SCORER_DEFINITION_ID } from "../scheduler/names.ts";
```
git 明证：commit `184eca7`（"scheduler definition id 常量下沉框架层（解 scheduler↔schedulers 环——schedulers re-export 兼容）"）——这是**刻意保留的兼容垫片**，注释（schedulers/names.ts:7-8）明确写了"消费方 import 路径不变"。非遗留。

### canonical 与建议
- import 计数：`scheduler/` 60 处 vs `schedulers/` 29 处 → **scheduler/ canonical**（框架层）。
- 建议：**保持现状**。可选清理：`schedulers/names.ts` 的 re-export 若消费方已全部迁移到 `scheduler/names.ts` 可删除，但需先 grep 消费方（commands/register.ts:13、optimizer/shadow.ts 等均走 schedulers/names.ts，短期不建议动）。

---

## 2. workloop/（单数） vs workloops/（复数）

### 文件与行数
| 目录 | 文件 | 总行数 |
|---|---|---|
| `src/workloop/` | 10 个：checkpoints(235), context(135), contracts(140), index(26), instrumented-model-port(139), machine-runtime(276), machine(58), registry(72), runner(618), state-store(80) | 1779 |
| `src/workloops/` | 9 个：budgeted-history(159), context-events(131), context-metrics(76), managed-loop(318), market-bid-loop(122), model-port(403), pi-default-loop(340), selective-summary(309), executors/pi-delegate-executor(29) | 1858 |

### 主要导出
- **workloop/**：`WorkLoopImplementation`/`WorkLoopSDK`/`ModelPort`（contracts.ts:127,110,62）、`WorkLoopRegistry`（registry.ts:13）、`WorkLoopRunner`（runner.ts:48）、`MachineDefinition`/`Executor`（machine.ts:39,53）、`MachineRuntime`（machine-runtime.ts:88）、`CheckpointStore`/`AgentCloneService`（checkpoints.ts:75,167）、`createInstrumentedModelPort`（instrumented-model-port.ts:68）、barrel `index.ts`。
- **workloops/**：`createPiDefaultLoop`（pi-default-loop.ts:156）、`createMarketBidLoop`（market-bid-loop.ts:52）、`budgetedHistory`/`selectiveSummary` 已注册实现（budgeted-history.ts:159、selective-summary.ts:309）、`managedMachine` 共享状态机核心（managed-loop.ts:197，注释明确"不提供独立 implementation"）、`createPiModelPort`/`createMultiModelPort`（model-port.ts:273,316）、`PiDelegateExecutor`（executors/pi-delegate-executor.ts:29）。

### 判断：真实边界，非重复
复数目录的 loop 工厂实现 `WorkLoopImplementation`（workloop/contracts.ts:127）与 `MachineDefinition`（workloop/machine.ts:39），由单数目录的 `WorkLoopRunner`+`MachineRuntime` 驱动。managed-loop.ts 头部注释直接写明消费方/复用关系。

### 交叉 import
- workloop → workloops：**0 条**。
- workloops → workloop：**13 处**，全为契约/状态机/插桩依赖（如 managed-loop.ts:49-55、executors/pi-delegate-executor.ts:17-18、model-port.ts:62-72）。

### 唯一"重复"点：model-port.ts 的 re-export
`src/workloops/model-port.ts:67`：
```ts
export { createInstrumentedModelPort } from "../workloop/instrumented-model-port.ts";
```
git 明证：commit `294ec19`（"createInstrumentedModelPort 下沉框架层（解 workloop↔workloops 环——插桩是框架能力，re-export 兼容）"）。与 scheduler 对同款**刻意兼容垫片**。

### canonical 与建议
- import 计数：`workloop/` 107 处 vs `workloops/` 33 处 → **workloop/ canonical**。
- 建议：**保持现状**。注意 `workloops/` 无 barrel（`index.ts` 只在单数侧），消费方直接按文件 import——不是 bug，但若插件目录增长可加 barrel。

---

## 3. optimizer/（单数） vs optimizers/（复数） ⚠️ 唯一有脏点的对

### 文件与行数
| 目录 | 文件 | 总行数 |
|---|---|---|
| `src/optimizer/` | 9 个：auto-flow(407), auto-trigger(109), canary-eval(230), context-projector(442), contracts(134), data-api(156), facade(398), registry(366), shadow(346) | 2588 |
| `src/optimizers/` | 2 个：weighted-tuner(328), ws-projector(97) | 425 |

### 主要导出
- **optimizer/**：`OptimizerInstance`/`MetricsProjector`/`OptimizationDataAPI`（contracts.ts:106,130,47）、`OptimizerRegistry`（registry.ts:144）、模块级 `registerMetricsProjector`（registry.ts:50）、`buildOptimizerFacade`（facade.ts:54）、`evaluateShadow`（shadow.ts:104）、`projectContextStrategies`（context-projector.ts:128）。
- **optimizers/**：`weightedTunerDefinition`（weighted-tuner.ts:82）、`createWeightedTunerInstance`（weighted-tuner.ts:219）、`decide`（weighted-tuner.ts:125）、`ModelAggregate`（ws-projector.ts:39）。

### 判断：真实边界 + **双向依赖脏点**
正方向（插件→框架）正确：
- `optimizers/ws-projector.ts:34` import `registerMetricsProjector` from `../optimizer/registry.ts`（自注册模式）
- `optimizers/weighted-tuner.ts:47` import contracts

**反向（框架→插件）2 处，破坏分层**：
1. `src/optimizer/facade.ts:15` — `import { createWeightedTunerInstance } from "../optimizers/weighted-tuner.ts";`（**值 import**，框架直接硬编码具体插件工厂，绕过 registry 的定义工厂）
2. `src/optimizer/shadow.ts:28` — `import type { ModelAggregate } from "../optimizers/ws-projector.ts";`（类型 import，框架依赖插件导出的类型）

另有跨对脏点：`src/optimizer/shadow.ts:29` — `import { buildLabConfigFromParams, type WeightedScorerParameters } from "../schedulers/weighted-scorer.ts";`（框架层依赖兄弟插件目录 `schedulers/`）。

目录级 import 计数：`optimizer/` 27 vs `optimizers/` 11 → **optimizer/ canonical**（框架层）。

### 建议（优先级从高到低）
1. **facade.ts:15**：改为经 `OptimizerRegistry` 按 definitionId 解析工厂（registry.ts:144 已有 `OptimizerInstanceCreationError` 路径），消除对具体插件的硬编码。当前"只有一个 optimizer 定义"所以没炸，加第二个定义时必踩。
2. **shadow.ts:28**：`ModelAggregate` 是查询返回的形状，应上移为框架类型（如进 `optimizer/contracts.ts` 或 `core`），ws-projector 实现它。
3. **shadow.ts:29**：`buildLabConfigFromParams`/`WeightedScorerParameters` 属 scheduler 插件域——框架侧需要的是参数→LabConfig 的转换接口，应抽象成契约或由调用方注入。

---

## 横向总结表

| 对 | 职责分割 | 文件数(单/复) | 是否重复 | canonical | 反向 import | 结论 |
|---|---|---|---|---|---|---|
| scheduler/schedulers | 框架执行+契约 / 具体调度实现+引导 | 9 / 5 | 否 | scheduler/（60 vs 29） | 0 | 干净，1 处刻意 compat re-export（names.ts:9） |
| workloop/workloops | 框架状态机+执行 / 具体 loop 实现+端口 | 10 / 9 | 否 | workloop/（107 vs 33） | 0 | 干净，1 处刻意 compat re-export（model-port.ts:67） |
| optimizer/optimizers | 框架注册+评估 / 具体 tuner+projector | 9 / 2 | 否 | optimizer/（27 vs 11） | **2 处** | **有脏点**：facade.ts:15、shadow.ts:28(+29) |

## 给后续 agent 的入口
- 要理解分层约定：先读 `src/scheduler/contracts.ts:113`（SchedulerImplementation）与 `src/workloop/contracts.ts:127`（WorkLoopImplementation）——单数目录定义、复数目录实现。
- 要动手修 optimizer 脏点：`src/optimizer/facade.ts:15`（改走 registry 工厂）、`src/optimizer/shadow.ts:28-29`（类型上移/注入）。
- 要清理 compat re-export：`src/schedulers/names.ts:9`、`src/workloops/model-port.ts:67`——先全库 grep 消费方再删（当前均有活跃消费方，不建议删）。

## 残余风险
- compat re-export（schedulers/names.ts:9、workloops/model-port.ts:67）是"重复名字"表象的来源；若后续重构忘记其存在，可能被误当作重复实现删除，破坏 import 路径兼容。
- optimizer 对反向依赖虽未构成运行时模块环（shadow→ws-projector→registry 不回头），但属架构分层违规，新 optimizer 定义接入时风险累积。
- scheduler/runner.ts（968 行）是单数侧最大文件，接近"大文件拆分"（commit c2629b7）后再膨胀的阈值，但不在本任务范围内。
