# Scout 6 — 深度侦察：agent 在 PTH 里的执行链路（runtime vs assembly，vm 内核挂点）

> 前提（已确认）：**PTH = 联邦宿主/agent 实际运行处**（`src/pth/`）；**PTL = 本机开发工具链**（`src/ptl/`，不运行 agent 本体）。vm 执行内核是给 PTH 用的。
> 侦察范围：`src/pth/core/agent-engine.ts`、`src/pth/main.ts`、`extensions/agent-lab/index.ts`（+ interceptor/workloop/runtime/assembly 关键佐证）。

---

## A. agent 在 PTH 里的完整执行链路

### A1. PTH 启动装配（`src/pth/main.ts`）

1. **agent-lab 动态注入**：`main.ts:99-105` —— 非字面量 specifier `"../../extensions/agent-lab/index.ts"` 动态 `import()`（避免静态 import 破坏"PTH 零引用 agent-lab"契约，见 `main.ts:95-97` 注释），取 `agentLabModule.default`（裸 factory `(pi: ExtensionAPI) => Promise<void>`）push 进 `systemExtensionFactories`。**fail-open**：加载失败仅 warn，PTH 照常运行。
2. **引擎构造**：`main.ts:108` —— `new AgentEngine(..., sandboxBash, systemExtensionFactories)`（第 13 个参数即常驻会话编程注入扩展）。
3. **恢复 + 常驻会话**：`main.ts:125` `await engine.recoverAll()`（reserved 会话优先恢复）；`main.ts:129` `createSystemSession()`；`main.ts:135` `startSystemWatchdog()`。

### A2. 常驻系统会话构建（`agent-engine.ts:566-668 buildSystemSession`）

- `agent-engine.ts:574-577`：先 `prepareSystemEnv(sessionId)`（**定义在 674-679**）——设 `AGENT_LAB_DB_PATH`（默认 `<dataDir>/agent-lab/agent-lab.db`）、`AGENT_LAB_CONFIG_DIR`（`<dataDir>/agent-lab/config`）、`PI_AGENT_INSTANCE_ID=system-<sessionId>`。**设置后不恢复**（协调者裁决：单实例内配置路径全局唯一，避免每会话改 env 竞态）。agent-lab `loadConfig`/`sharedDbPath`/`localConfigDir` 在 load 期**同步读**这些 env（`src/config-io.ts:15-29`）。
- `agent-engine.ts:596-602`：`DefaultResourceLoader({ cwd, agentDir, noContextFiles:true, noExtensions:true, eventBus: systemEventBus, extensionFactories: [...systemExtensionFactories] })` → `await resourceLoader.reload()`。要点：**noExtensions:true 防用户 agentDir 扩展泄漏**（agent-lab 只能经 extensionFactories 进来）；**自建 loader 必须显式 reload**（S3 缺口 1，SDK 只在内部默认 loader 时代调 reload，否则扩展加载数为 0）。
- `agent-engine.ts:613-621`：`sdkCreateSession({..., resourceLoader, tools, customTools})`（`src/shared/sdk-adapter/index.ts` 是 SDK 唯一 import 边界，透传 `@earendil-works/pi-coding-agent` 的 `createAgentSession`）。
- `agent-engine.ts:617-631`：`session.bindExtensions({mode:"print", onError})` → SDK **emit session_start** → agent-lab 的 `pi.on("session_start")` 处理器触发（headless 常驻会话无 UI）。
- 池记录 `reserved:true`（`agent-engine.ts:641`）→ evict 豁免（`evictSession` 431-440）、destroy 拒绝（`destroySession` 706-712）、watchdog 重建（`startSystemWatchdog` 516 / `ensureSystemSessionAlive` 528-542 / 重建计数审计 533-538）。

### A3. agent-lab 扩展加载后做了什么（`extensions/agent-lab/index.ts` default export，接线总纲）

**load 期同步**（约 82-212 行）：`ensureDataDir`/`loadConfig` → 双 SqliteStore（`sharedStore` 遥测 + `localStore` 配置，index.ts:87-112 组合 `store`）→ UUID identity 迁移 → ledger → catalog refresh → stale task 恢复/冻结对账 → `wireSystemEvents`（217，订阅 `platform:external-event` / observe RPC / component-bound 通道）。

**关键：scheduler runtime 是惰性构造**——`schedulerRuntimeFactory`（`index.ts:236-`）有 `runtimeInitAttempted` 守卫（237-238），load 时**不执行**，`schedulerCore === undefined`。首次触发点：
- 外部事件/observe RPC → `wireSystemEvents.ensureCore`（221-224）；
- subagent tool_call → interceptor（499）→ `decideSchedulerSelection` → `deps.runtime()`（`interceptor/scheduler-bridge.ts:107-110`）；
- telemetry settle（475-481）；
- `/lab` 命令（903 registerCommands 的 schedulerRuntime getter，549/813/852/971）；
- system 会话 `session_start` → `systemEvents.start()`（230-234，仅 `PI_AGENT_INSTANCE_ID` 以 `system-` 开头时）。

runtime 构造时（237-274）：`createSchedulerRuntime(sharedStore.raw, {eventBus: pi.events, model, tools, artifacts, strategyConfig})` → `schedulerCore`、`capturedWlRunner = rt.workloopRuntime?.runner`（275）→ 顺序 bootstrap（weighted-scorer → arena → optimizer → auto-trigger/auto-flow，全 fail-open，`bootstrapPromise` fire-and-forget）。

### A4. 实际 agent 执行（三条并发路径）

| 路径 | 触发 | 执行体 | 工具 |
|---|---|---|---|
| **路径 1（主路径·用户会话）** | gateway → `engine.prompt`（`agent-engine.ts:227-330`）→ `session.prompt(text)`（SDK 原生 agent loop） | **pi SDK AgentSession 的回合循环**（事件经 `createBridge` 桥 SSE/WebSocket：`routes-sessions.ts:23`、`server.ts:75`、`routes-programs.ts:397`） | **真实**：bash 已被 PTH 平台级替换为 sandbox 转发（`main.ts:62-76` `createSandboxBashDefinition` → `agent-engine.ts:928-936 buildCustomTools` 同名覆盖） |
| **路径 2（subagent 委托）** | agent 调 `subagent` 工具 → agent-lab interceptor（`interceptor/register.ts:22-52`） | **只做模型选择**：`decideSchedulerSelection`（`scheduler-bridge.ts:100-152`）→ `runtime.dispatch({mode:"select"})`（weighted-scorer/arena 竞价；竞价本身经 `capturedWlRunner.run` 跑 market-bid-loop workloop，`index.ts:348-367`）→ 改写 `input.model` → **pi SDK 自己执行 subagent**（agent-lab 不执行） | pi SDK 原生 |
| **路径 3（agent-lab 内部 execute）** | 定时触发/事件订阅/taskpool 周期/optimizer auto-flow/`/lab scheduler dispatch --strategy X`/`/lab execute`（`index.ts:867`、`commands/register.ts:416`） | SchedulerRunner dispatch mode:"execute" → `sdk.agents.run` → **WorkLoopRunner.run**（`workloop/runner.ts`）→ pi-default-loop → **PiSubagentsAdapter 经事件总线 Delegation V2 委托 subagent**（`runtime/pi-subagents-adapter.ts`） | **stub**：`index.ts:263` `tools: { async execute() { throw new Error("stub: tools not available in managed loop v1"); } }` —— workloop 执行路径**无真实工具** |

**重要事实**：常驻系统会话**从不被 `prompt()`**（网关无任何对 system 会话的 prompt 调用；`session.prompt` 只服务于 tenant 会话）。系统会话是**纯宿主**：扩展 + 事件转发（`emitExternalEvent`/`querySystemEvents` 430-483）+ DB/注册表。**真正的对话执行全在 tenant 会话**（其 loader 从 agentDir 加载扩展；PTL dev 环境下 agentDir 含 agent-lab symlink → tenant 会话也各自加载一份 agent-lab，interceptor/DB 句柄每会话一份）。

---

## B. agent-lab 被 PTH 常驻会话加载后：runtime 路径还是 assembly 路径？

**结论：runtime 路径（轻量组合）；assembly 完全休眠，未接线。**

- **runtime**（`src/runtime/create-scheduler-runtime.ts`）：`createSchedulerRuntime(db, {eventBus, model, tools, artifacts})` 直组 `WorkLoopRegistry`（注册 `PI_DEFAULT_LOOP_DEFINITION` + `MARKET_BID_LOOP_DEFINITION`）→ `WorkLoopRunner` + `SchedulerRunner` + `PiSubagentsAdapter`，**无记忆/账本/身份装配**。index.ts:39 `import { createSchedulerRuntime }` 是唯一 runtime 入口，活跃。
- **assembly**（`src/assembly/`：`assembler.ts` AgentAssembler 六步装配 + `agent-runtime.ts` AgentRuntime + `memory-host.ts` MemoryHost + rule/public bootstrap）：**index.ts 零 import**（`grep "assembly/"` 在 src/index.ts 无命中），仅 `test/assembly-*.test.ts` 与 `bench/assembly-demo.ts` 消费。scout-2（`scout-2-agentlab-module-map.md` L20/L70-72/L123）已确认：assembly 是"完整路径（含记忆/账本/身份）但尚未接线"，两条构造路径收敛点是同一个 `workloop/runner.ts`。
- **且即便 runtime 路径，在常驻会话里也只活跃到"选择/竞价"层**：interceptor 只走 `mode:"select"`（scheduler-bridge.ts:120）；execute-mode 依赖 Delegation V2 总线委托（`runtime/pi-subagents-adapter.ts` 全程事件总线协议），而常驻会话 `noExtensions:true` + 仅注入 agent-lab → **系统会话内没有 pi-subagents 扩展监听委托事件** → execute-mode workloop 在系统会话内实际会超时/失败（除非总线另有监听者）。这是 agent-lab execute 路径在 PTH 里的真实缺口。
- **当前 agent 执行的构造路径总括**：`pi SDK 会话层（sdk-adapter createSession → AgentSession.prompt/subagent）`为主；agent-lab runtime 只贡献**模型选择 + 竞价 workloop（market-bid-loop，纯 LLM 端口）**。assembly 与 workloop execute 均为休眠/半瘫。

---

## C. vm 执行内核要真正被 PTH 用起来（不是休眠），必须挂哪个环节？

按"执行真实发生处"排序（从必须到可选）：

1. **PTH 会话层（首选）** —— `agent-engine.ts:613-621` 的 `sdkCreateSession` 调用点 / `src/shared/sdk-adapter/index.ts` 适配层。**所有**会话执行（tenant 主路径 + 系统会话宿主）都经此；这是唯一覆盖"路径 1（真实工具执行）"的挂点。已有先例：sandboxBash 在 PTH 侧以 `customTools` 同名覆盖平台级替换内建 bash（`main.ts:62-76` → `agent-engine.ts:928-936`），agent-lab 零适配。**若 vm 内核是"agent 回合/工具执行引擎"，挂这里 = 覆盖全部真实执行。**
2. **agent-lab workloop runner 的端口** —— `workloop/runner.ts` + `runtime/create-scheduler-runtime.ts:36-45`（`SchedulerRuntimeOptions` 的 `model/tools/artifacts` 端口）。若 vm 内核要驱动 agent-lab 内部 execute-mode（定时/事件/taskpool），把内核实现为 `ToolPort`/`ModelPort` 注入 `createSchedulerRuntime`——`index.ts:263` 的工具 stub 是**现成的洞**。
3. **agent-lab 扩展入口（index.ts default export）** —— 只是接线层（`pi.on` / `registerInterceptor` / `registerCommands`），不承载执行。内核只应在这里做事件钩子（如 `pi.on("tool_call")` 拦截），**不应**把执行逻辑写在这里。
4. **assembly（`src/assembly/`）** —— 休眠层；不接线它就没有执行发生，**不可作为"让内核被用起来"的挂点**（除非同时把 assembly 接进 index.ts 运行路径，成本高）。

**推荐**：内核挂 **PTH 会话层（选项 1）**——因为"PTH=agent 实际运行的地方"，且现有唯一真实工具执行通道（pi SDK agent loop + sandboxBash）在 PTH；若还需覆盖 agent-lab workloop execute，再以 port 实现形式（选项 2）补 agent-lab 侧工具口。**不可两个都半挂**。

---

## D. PTH 与 agent-lab 的边界：vm 内核代码写哪？

**现状边界契约（spec §6.0 选项 C，scout-3 确认）**：
- PTH 对 agent-lab：**零静态 import**。唯一接触点 = ①`main.ts:99-105` 动态 specifier；②`systemExtensionFactories` 构造参数（`agent-engine.ts:100`/599）；③env 注入 `AGENT_LAB_DB_PATH/CONFIG_DIR/PI_AGENT_INSTANCE_ID`（`agent-engine.ts:674-679`）。
- agent-lab 对 PTH：**零 import**（`config-io.ts` 自含 `pitHome()` 解析，与 pit 经 env 契约一致）。

**归属判定**：
- 内核定位 = **PTH 会话执行基座**（agent 回合宿主/替换、工具执行、回合调度、budget 控制）→ 代码写 **`src/pth/`**（或 `src/shared/` 被 pth 引用），经 `sdk-adapter` 挂 `createSession`/`session.prompt`/customTools。agent-lab 无感知（它经 SDK 会话天然获得内核提供的执行语义）。
- 内核定位 = **agent-lab 内部执行引擎**（workloop/assembly 的模型/工具/工件端口实现、checkpoint/resume）→ 代码写 **`extensions/agent-lab/src/`**，经 `createSchedulerRuntime` options 注入（`create-scheduler-runtime.ts:36-45`）。
- 结论：**执行内核本体（回合/工具执行）放 PTH 会话层**；agent-lab 侧只保留"消费端"（port 适配/接线）。保持"PTH 零引用 agent-lab + agent-lab 零引用 PTH"的边界不变——若内核是 PTH 侧的，agent-lab 通过 SDK 会话/端口间接获得，无需打破隔离。

---

## 关键文件索引（引用）

- `src/pth/main.ts:95-108`（agent-lab 动态 import + 引擎装配）、`:125-135`（recoverAll / createSystemSession / watchdog）
- `src/pth/core/agent-engine.ts:414-419`（createSystemSession 幂等）、`:516-542`（watchdog）、`:563-668`（buildSystemSession 核心）、`:596-602`（noExtensions+extensionFactories+eventBus loader）、`:613-631`（sdkCreateSession + bindExtensions）、`:674-679`（env 契约）、`:740-840`（recoverAll，reserved 优先 756-786）、`:928-936`（buildCustomTools 含 sandboxBash）
- `src/pth/gateway/routes-sessions.ts:23`、`server.ts:75`、`routes-programs.ts:397`（prompt 入口）
- `src/shared/sdk-adapter/index.ts:40-63`（PlatformAgentSession 接口）、`:92-110`（bindExtensions/shutdown 适配）、`:22-28`（InlineExtension/createEventBus 再导出）
- `extensions/agent-lab/index.ts:82-212`（load 期接线）、`:217-235`（wireSystemEvents + session_start/shutdown 钩子）、`:236-274`（惰性 schedulerRuntimeFactory）、`:263`（工具 stub）、`:275`（capturedWlRunner）、`:348-367`（market-bid-loop 竞价）、`:483-499`（tool_call 捕获 + registerInterceptor）、`:867`（execute mode dispatch）、`:903-999`（registerCommands 接线）
- `extensions/agent-lab/src/interceptor/register.ts:22-52`（subagent 工具拦截，仅 model 改写）
- `extensions/agent-lab/src/interceptor/scheduler-bridge.ts:100-152`（decideSchedulerSelection，mode:"select"）
- `extensions/agent-lab/src/runtime/create-scheduler-runtime.ts:36-45`（端口 options）、`:124`（无 eventBus → workloopRuntime undefined）、`:167-186`（WorkLoopRuntimeLite 组合）
- `extensions/agent-lab/src/workloop/runner.ts:1-130`（WorkLoopRunner FIFO + MachineRuntime）
- `extensions/agent-lab/src/runtime/pi-subagents-adapter.ts`（Delegation V2 事件总线委托）
- `extensions/agent-lab/src/assembly/index.ts:1-26`（assembly 导出面——无 src 消费者）
- `extensions/agent-lab/src/config-io.ts:15-29`（env 契约读取端）
- `extensions/agent-lab/src/federation/system-events.ts:1-70`（常驻会话线协议通道）

## 约束 / 风险

1. **execute-mode 缺口**：常驻系统会话 `noExtensions:true` + 只注入 agent-lab → Delegation V2 委托无监听者（pi-subagents 不在），workloop execute 在系统会话内会超时/失败；工具口是 stub（index.ts:263）。vm 内核若想走 workloop 路径，必须先补工具口 + 委托监听。
2. **系统会话从不 prompt**：对话执行全在 tenant 会话；给内核的"执行"挂点若只在系统会话 = 空转。
3. **双加载路径**：dev（PTL）环境 tenant 会话经 agentDir symlink 各自加载 agent-lab（interceptor/DB 句柄每会话一份）；系统会话走 extensionFactories。内核若依赖 agent-lab 状态，需注意双实例语义。
4. **惰性 runtime**：`schedulerCore` 首次触发才 bootstrap（fire-and-forget）——依赖 schedulerCore 的接线（wireSystemEvents.start 等）有竞态窗口，已有 fail-open 兜底。
