# Scout 5 — agent-lab 当前运行路径（runtime 路径）侦察

> 范围：`extensions/agent-lab/src/runtime/` 四个工厂 + `extensions/agent-lab/index.ts` 接线总纲。
> 定位：这是 agent-lab **当前实际运行**的 agent 构造路径（与 assembly 完整路径并存），轻量组合。
> 日期：2026-08-07

---

## 0. 一句话结论

当前运行路径 = **`index.ts → createSchedulerRuntime`（SchedulerRunner + 内嵌 WorkLoopRuntimeLite）→ WorkLoopRunner → MachineRuntime + 注册的 workloop 实现（pi-default-loop / market-bid-loop）**。`create-runtime.ts`（createWorkLoopRuntime）是**休眠 sidecar**（文件头自述"intentionally not wired into index.ts"）；`create-experiment-runtime.ts` 只在 `/lab experiment` 命令路径（experiment/facade.ts）惰性构造。assembly 全套（AgentRuntime/MemoryHost/assembler）**未接入 index.ts**，只在测试与 bench 中。

---

## A. 当前 runtime 路径的 agent 执行链

### A.1 组装位置（index.ts）

- `index.ts:212` `delegationBus = pi.events`（扩展共享 EventBus，即 DelegationEventBus，无需等待首次 tool_call）。
- `index.ts:236-472` `schedulerRuntimeFactory()` 惰性单例：
  - `index.ts:245` 调 `createSchedulerRuntime(sharedStore.raw, {...})`。
  - `index.ts:246-272` 传入 ports：
    - `eventBus: delegationBus`（index.ts:247）
    - `model`: 防御性闭包，每次调用解析 `capturedModelRegistry` → `cachedMultiModelPort = createMultiModelPort({modelRegistry})`（index.ts:253-260）
    - `tools`: **stub**，`execute()` 直接 throw "stub: tools not available in managed loop v1"（index.ts:261-262）
    - `artifacts`: **stub**，`put()→randomUUID`、`get()→undefined`（index.ts:263-265）
  - `index.ts:275` `capturedWlRunner = rt.workloopRuntime?.runner`（workloop 执行器捕获给 arena 竞价）。
  - bootstrap：`ensureWeightedScorerInstance`（index.ts:316）+ `ensureArenaInstance`（index.ts:372）。

### A.2 createSchedulerRuntime 组装了什么（create-scheduler-runtime.ts）

`createSchedulerRuntime(db, options)`（line 105）：
1. `core = createLabCore(db)`（line 106）→ definitions/repository/events/storage/controlPlane。
2. 注册 workloop **定义**（验证用）：`PI_DEFAULT_LOOP_DEFINITION`（line 113-119）、`MARKET_BID_LOOP_DEFINITION`（line 121-127）。
3. `schedulers = new SchedulerRegistry(core.definitions)`（line 129）。
4. **无 eventBus 分支**（line 116-126）：返回 `SchedulerRunner`（无 runner → execute 模式 `agents.run` 抛 typed unavailable），`workloopRuntime: undefined`。
5. **有 eventBus 分支**（line 128-191）：
   - `wlRegistry`（line 141）、`stateStore = AgentRuntimeStateStore`（line 142）、`checkpointStore = CheckpointStore`（line 143）、`adapter = new PiSubagentsAdapter(eventBus)`（line 144）。
   - `wlRunner = new WorkLoopRunner(wlRegistry, stateStore, checkpointStore, core.events, core.storage, model, tools, artifacts)`（line 145-151）。
   - **注册 workloop 实现**：`createPiDefaultLoop(adapter)`（line 156-157）、`createMarketBidLoop()`（line 161，**默认空 config**）。
   - `workloopRuntime: WorkLoopRuntimeLite`（line 172-182，含 adapter/stateStore/checkpointStore）。
   - `schedulerRunner = new SchedulerRunner({core, schedulers, runner: wlRunner, strategyConfig})`（line 184-191）。

### A.3 执行链（dispatch → workloop）

**select 模式（interceptor 主路径）**：
1. pi 发起 `subagent` tool_call → `registerInterceptor`（interceptor/register.ts:19-49，`pi.on("tool_call")`）。
2. `decideSchedulerSelection`（interceptor/scheduler-bridge.ts:64-116）→ `runtime.dispatch({mode:"select", role, task, settlementRef})`。
3. `SchedulerRunner.dispatch`（scheduler/runner.ts:118）→ resolveStrategy → `dispatchToInstance`（runner.ts:266）→ 按 instanceId/binding 解析 → round → `impl.schedule(...)`（weighted-scorer 或 arena）。
4. arena `schedule`（schedulers/arena-scheduler.ts:109-385）：选候选 → endowment → bidder 竞价（默认 `engine: "model-caller"` 走 `ports.modelCaller`；`engine: "workloop"` 走 `ports.workLoopBidder`）→ 冻结 → winner。
5. select 模式只返回 `{status:"completed", model, selectedAgentId}` → `processCompleted`（runner.ts:394）→ interceptor `action:"apply"` 改写 `input.model` → **真正执行仍由 pi-subagents 官方循环完成**（runtime 只做模型选择）。

**execute 模式（workloop 真实执行）**：
- `/lab execute`（index.ts:843-898 `executeDispatch`）、arenaSmoke、bench 走 `rt.dispatch({mode:"execute"})`。
- arena-scheduler 选出 winner 后 `sdk.agents.run(winner.agent, {task, timeoutMs})`（arena-scheduler.ts:330-341；runner-sdk.ts:100-158 `agents.run`）→ `wlRunner.run(...)`。
- `WorkLoopRunner.run`（workloop/runner.ts:97）→ `executeRun`（runner.ts:194）：
  - registry.require(workLoopId, version)（runner.ts:206）
  - stateStore CAS snapshot 初始化/加载（runner.ts:220-249）
  - `buildSDK`（runner.ts:444-550，含 memory/comms/sorter 可选字段挂载点，见 D）
  - `new MachineRuntime({machine, input, sdk, executor, budgets})`（runner.ts:480-505）→ `runtime.run()`（machine-runtime.ts:112）
  - MachineRuntime 驱动：start 事件 → transitions → step（δ）→ 自动 checkpoint → terminal。
- pi-default-loop 是**委托式**：`PiDelegateExecutor.start`（pi-delegate-executor.ts:46）→ `adapter.delegate(v2req, {onUpdate})`（pi-subagents-adapter.ts:110）→ emit `prompt-template:subagent:request` → pi-subagents 官方循环真正跑 → response 事件 → onResponse 相关 → 转成 `pi_terminal` → mapResponse → `{status:"completed", output:{standard, custom}}`。

### A.4 关键点：market-bid-loop 的 per-bid config 疑似断线（潜在缺陷）

- `create-scheduler-runtime.ts:161` 注册的是 `createMarketBidLoop()` —— **工厂默认空 config**（`config = {}` → `config.model` undefined、`config.balance = MAX_SAFE_INTEGER`）。
- `index.ts:363-364` workLoopBidder 传的 `config: { model: model.id, balance: opts.balance }` 走的是 **WorkLoopRunRequest.config**，只会进 `input.config` / `initialContext(config)` / `initialState(config)`。
- 但 market-bid-loop 的 `machine.step` **读取的是工厂闭包 `config`**（market-bid-loop.ts:81 `buildBidContext(task, config)`、:85 `sdk.model.complete(bidContext, { model: config.model })`），step 签名 `(ctx, state, event, sdk)` **没有 input.config 注入**（machine.ts:48-50；machine-runtime.ts step 调用处 line 249）。
- 后果：runtime 路径下 workloop 竞价引擎实际用 `model: undefined` → `createMultiModelPort.complete` 会抛 "options.model is required per call"（workloops/model-port.ts:333-337）→ step catch → terminal failed(retryable) → workLoopBidder 返回 undefined → fail-open stake=0。arena 侧默认 `engine:"model-caller"`（config.ts:19），workloop 引擎只在 arenaSmoke 显式指定 `engine:"workloop"` 时才走该断线路径。
- **风险级别：中（仅 workloop 竞价引擎受影响；model-caller 默认路径无碍）。** 测试 `arena-workloop-bidding.test.ts` 直接注入 workLoopBidder port 造结果，绕过了该 gap，所以测试全绿。

---

## B. runtime 路径缺什么（对比 assembly）

| 维度 | assembly 完整路径 | runtime 路径（当前） |
|---|---|---|
| 记忆域 | MemoryHost + MemoryStore/RuleRegistry/MemoryPipeline/Watermark/DSP + PublicDomain/RuleBootstrap（assembler.ts:151-166） | **无**。SDK 的 `memory?`/`comms?` 字段保持 undefined（workloop/contracts.ts:120-124） |
| 账本/身份 | SqliteLedgerAdapter(LedgerPort) open/removeAccount + IdentityMap/comms 身份 + AgentRuntime 绑定（assembler.ts:180-207） | **无**。arena 有 SqliteLedger（index.ts:16, arena 竞价用），但**不挂 SDK**、无 per-agent 经济账户挂载 |
| memory+sorter SDK 挂载 | `AgentRuntime.attachSdkOnce` → `runner.onSdkBuilt(sdk => memory.attachSdk(sdk); mountSorterSdk(...))`（agent-runtime.ts:155-188） | **无**。`runner.onSdkBuilt` 钩子存在（workloop/runner.ts:151-155）但 runtime 路径**无人注册** |
| checkpoint→DSP 联动 | `runner.onCheckpoint` → dsp.snapshot(seq) + bridge.ack(seq)（agent-runtime.ts:168-176） | **无** |
| 收件缓冲/纸带注入 | `AgentRuntime.drainInbox`（agent-runtime.ts:212-223） | **无** |
| DSP restore 顺序 | `restoreDspOrder`（agent-runtime.ts:191-209） | **无**（MachineRuntime 只做 deriveDsp 合成 system，不做持久记忆恢复） |

补充对比：runtime 路径的 agent 身份 = arena UUID（`findOrCreateAgentByModel`，arena/agent-id.ts:15-37），**没有** assembly 的 IdentityMap/tenant/session/comms 身份体系。

---

## C. index.ts 里接入运行路径 vs 休眠的模块

**已接入（运行路径活跃）**：
- `createSchedulerRuntime`（index.ts:19 import，:245 调用）——核心运行时。
- `registerInterceptor`（index.ts:10/499）、`decideSchedulerSelection`（interceptor/scheduler-bridge.ts:64）——dispatch 入口。
- `SqliteLedger` + `EndowmentPolicyV1`（index.ts:15-16, :149-152）——arena 竞价账本。
- `createMultiModelPort`/`createModelCaller`（index.ts:28, :24, :486）——model port 来源。
- `createSettleDispatch`/`registerTelemetry`（index.ts:475-478）。
- `wireSystemEvents`（index.ts:12, :217）。
- `registerCommands`（index.ts:903）——arenaSmoke/bench/executeDispatch/scheduler 状态命令。
- `createTaskPoolFactory`（index.ts:60-83, :966）——**命令层**任务池（`/lab task`），惰性工厂，冷库幂等 exec CORE_SCHEMA；`SorterEngine` 建了但**只服务命令**。
- bootstrap：`ensureWeightedScorerInstance`/`ensureArenaInstance`（index.ts:316/:372）+ optimizer/auto-trigger/auto-flow（index.ts:~403-450）。
- experiment：`buildExperimentFacade`（index.ts:38, :~940）——惰性，`createExperimentRuntime` 在**每个 experiment 命令调用时**现场构造（experiment/facade.ts:331）。

**休眠（未接入 index.ts 运行路径）**：
- `createWorkLoopRuntime`（runtime/create-runtime.ts:84）——仅测试（test/pi-default-loop.test.ts）与 Phase2 验证使用；文件头 line 80-82 自述"intentionally not wired into index.ts"。
- `assembly/*` 全套（AgentRuntime、createAgentAssembler、MemoryHost、CommsBridge、SqliteLedgerAdapter、PublicDomainBootstrap、RuleBootstrap）——**index.ts 零引用**，仅在 test/ 与 bench/assembly-demo.ts 使用。
- `memory/sdk.ts mountMemorySdk` / `taskpool/sdk.ts mountSorterSdk`——只在 assembly 路径调用（memory-host.ts:126、agent-runtime.ts:180）。
- `WorkLoopRunner.onSdkBuilt`/`onCheckpoint` 钩子——钩子实现就绪（runner.ts:129/:151，buildSDK 应用处 runner.ts:540-546），但 runtime 路径无注册者。

---

## D. 让 runtime 路径挂上记忆/任务池/sorter SDK（不切 assembly）要动的地方

**最小改动点（全部在 index.ts + 新增一个"记忆挂载"适配）**：

1. **挂载点（现成钩子）**：`WorkLoopRunner.onSdkBuilt(cb)`（runner.ts:151-155）在每次 `buildSDK` 后按注册顺序应用（runner.ts:540-546）。在 index.ts `capturedWlRunner = rt.workloopRuntime?.runner`（index.ts:275）处注册：
   ```ts
   capturedWlRunner.onSdkBuilt((sdk) => {
     memoryHost.attachSdk(sdk);              // 需要 memoryHost（见下）
     mountSorterSdk(sdk, { store: taskStore, agentId: () => agentIdResolver() });
   });
   ```
2. **记忆域来源**：可复用 `MemoryHost`（assembly/memory-host.ts:65）——它不依赖 assembly 的其他接线，构造需 `{workDir, pubDir, ruleBootstrap, spec, seqProvider}`。但 runtime 路径当前**没有 workDir/ruleBootstrap/publicDomain 基础设施**，需要：
   - 选一个 memory 根目录（如 `localConfigDir()/memory` 或 shared 层）。
   - `RuleBootstrap`（assembly/rule-bootstrap.ts）与 `PublicDomainBootstrap`（assembly/public-bootstrap.ts）的实例化/引导。
   - per-agent workDir 需要 agent UUID → 目录映射（`<root>/agents/<agentId>/`，同 assembler.ts:133 约定）。
3. **taskStore 来源**：`createTaskPoolFactory`（index.ts:60-83）已产出 `SqliteTaskStore`（index.ts:966 只喂给命令层）。要改为**共享单例**：把 taskPool factory 的 store 提升为模块级（或新增共享 store 实例），再传给 `mountSorterSdk`。
4. **checkpoint→DSP 联动**：`capturedWlRunner.onCheckpoint(...)`（runner.ts:129）按 agentId 过滤后做 `dsp.snapshot(seq)`（可抄 agent-runtime.ts:168-176）。
5. **model/tools/artifacts 端口升级**（可选但相关）：当前 tools/artifacts 是 stub（index.ts:261-265）；若 workloop 内部要用工具/持久 artifact，需换成真实实现（否则 sdk.tools.execute 恒抛错）。

**备选（更省事但"切了"）**：直接把 `AgentRuntime`/`createAgentAssembler` 接进 index.ts —— 但任务明确"不切到 assembly"，故上述 1-4 为推荐路径。

---

## 关键文件与行号索引

- `extensions/agent-lab/index.ts` — 接线总纲；factory at :236-472；ports at :246-272；workLoopBidder :348-371；taskPool :60-83/:966。
- `src/runtime/create-scheduler-runtime.ts` — 调度运行时；createSchedulerRuntime :105；无 eventBus 分支 :116-126；有 eventBus 组装 :128-191。
- `src/runtime/create-runtime.ts` — createWorkLoopRuntime :84（休眠 sidecar）；PI_DEFAULT_LOOP_DEFINITION :44。
- `src/runtime/create-experiment-runtime.ts` — createExperimentRuntime :161；budgeted-history :38 / selective-summary :62 定义。
- `src/runtime/pi-subagents-adapter.ts` — PiSubagentsAdapter :66；delegate :110；onResponse :270；dispose :215；事件名在 delegation-v2.ts:8-13（`prompt-template:subagent:*`，protocol v2）。
- `src/runtime/delegation-v2.ts` — V2 协议类型/事件常量 :8-13。
- `src/workloop/runner.ts` — run :97；executeRun :194；buildSDK :444；onSdkBuilt :151；onCheckpoint :129。
- `src/workloop/machine.ts` + `machine-runtime.ts` — 状态机契约/驱动；start 事件 payload :118-126。
- `src/workloops/pi-default-loop.ts`（:156）+ `src/workloops/executors/pi-delegate-executor.ts`（:46）。
- `src/workloops/market-bid-loop.ts` — createMarketBidLoop :52；step 读闭包 config :81/:85（**per-bid config 断线点**）。
- `src/scheduler/runner.ts`（dispatch :118；dispatchToInstance :266）+ `runner-sdk.ts`（agents.run :100-158）。
- `src/interceptor/register.ts` :19 + `scheduler-bridge.ts` :64。
- 对比参照：`src/assembly/agent-runtime.ts`（attachSdkOnce :155；mountSorterSdk :180）、`src/assembly/assembler.ts`（:94-207）、`src/assembly/memory-host.ts`（:65/:126）、`src/memory/sdk.ts` :54、`src/taskpool/sdk.ts` :19。

## 残余风险 / 开放问题

1. **market-bid-loop per-bid config 断线**（A.4）：`createMarketBidLoop()` 默认空 config + step 闭包读 config → workloop 竞价引擎在 runtime 路径下拿不到 model/balance。需确认是设计遗留（等待 workLoopBidder 改经工厂传入）还是回归；若是缺陷，改法 = index.ts workLoopBidder 改为按 model 动态 `wlRegistry` 注册带 config 的实例，或让 step 读 `input.config`。
2. `experiment/facade.ts` 的 `createExperimentRuntime` 与 `create-scheduler-runtime.ts` 各自建 `LabCore`（同 db 双 core）——同一 db 上多个 core 并存，事件/storage 共享语义需留意（现状不冲突但重复）。
3. create-runtime.ts 的 `PI_DEFAULT_LOOP_DEFINITION` 被 create-scheduler-runtime.ts import 复用（create-scheduler-runtime.ts:14），而 create-runtime.ts 本身休眠——定义与实现的生命周期归属略混乱。
4. tools/artifacts stub 意味着 runtime 路径的 workloop 执行无工具能力（pi-default-loop 委托给官方循环不受影响；local-model 类 loop 受限）。
