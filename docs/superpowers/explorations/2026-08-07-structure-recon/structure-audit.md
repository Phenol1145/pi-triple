# 结构审计：agent-lab 执行路径的接线缺口与 vm 内核挂载决策

- 日期：2026-08-07
- 状态：审计结论（6 个 scout 侦察综合），作为 vm 执行内核 spec 的前置依据
- 触发：vm 执行内核（PTH 统一运行时）设计前，需先诊断项目结构性混乱、确定挂载点

---

## 1. 背景与触发

设计"vm 执行内核（skill 展开 + 记忆解析 + task 处理）"时，需要确定它挂载到哪条 agent 执行路径。用户指出"项目存在结构性混乱"，并要求先分清 PTL 与 PTH 定位。本审计用 6 个 scout 并行侦察，综合出执行路径现状与 vm 内核挂载结论。

## 2. 定位基线（PTL vs PTH，写死）

| | PTL（Pi-Triple-Lite） | PTH（Pi-Triple-Heavy） |
|---|---|---|
| 定位 | 轻量开发/调试工具链 | **agent 联邦平台（服务器）** |
| 入口 | `pit` CLI | `pth` server |
| 运行时 | 真实 pi 进程 × tmux | AgentEngine + Redis + BullMQ |
| 源码 | `src/ptl/` | `src/pth/` |
| agent 执行 | **不运行 agent 本体**（交互/触发/桥接） | **agent 实际运行处** |

**vm 内核是给 PTH 用的运行时组件**，不是 PTL 的工具链组件。agent-lab 以 pi 扩展形态被 PTH 的常驻系统会话托管（动态 import，PTH 主进程零静态引用）。

## 3. 澄清：不是混乱的地方

### 3.1 三对单复数目录是刻意的框架层/插件层分割（非重复）

| 对 | 框架层（单数） | 插件层（复数） | 反向 import | 结论 |
|---|---|---|---|---|
| scheduler/schedulers | 契约/注册表/runner/strategy | arena/weighted-scorer/context-experiment | 0 | 干净 |
| workloop/workloops | 契约/状态机/runner/checkpoint | pi-default/market-bid/budgeted/selective | 0 | 干净 |
| optimizer/optimizers | 注册表/facade/shadow/auto-flow | weighted-tuner/ws-projector | **2 处** | 有脏点 |

依赖方向：插件→框架单向（复数 import 单数）。canonical 均为单数目录。
- optimizer 脏点：`optimizer/facade.ts:15` 框架硬编码具体插件工厂（应走 registry）；`optimizer/shadow.ts:28-29` 框架依赖插件类型 + 兄弟插件目录。
- 兼容垫片：`schedulers/names.ts:9`、`workloops/model-port.ts:67` 的 re-export 是刻意保留（git commit 明证），非重复。

### 3.2 模块职责基本正交（无功能重复）
- taskpool（任务生命周期）vs scheduler（调度生命周期）：正交，taskpool→scheduler 单向。
- memory（L3 语义记忆）vs store（遥测模型选择）：无重叠，仅"store"命名歧义。

## 4. 结构性问题清单（按严重度）

### 4.1 大量"建好了但没通电"的休眠代码（最严重）

以下模块**在 `src/` 内零生产引用**（grep 验证 import 数 = 0）：

| 模块 | 职责 | 消费方 | 状态 |
|---|---|---|---|
| `assembly/*` | 完整装配层（六步装配+记忆域+账本+身份+SDK 挂载） | 仅 test/ + bench/assembly-demo.ts | 休眠 |
| `taskpool/cycle.ts` | 任务池周期自动派发 | 无（只有 /lab task 手工路径） | 休眠 |
| `ingest/cycle.ts` | 摄入周期流 | 无 | 休眠 |
| `economy/market-runner.ts` | 市场闭环全图（§5.1） | 仅 test/ | 休眠 |
| `memory/sdk.ts mountMemorySdk`、`taskpool/sdk.ts mountSorterSdk` | SDK 挂载 | 只在 assembly 路径调用（而 assembly 未接线） | 休眠 |

**官方自证**（agent-lab README:294-346）：
> "Phase 3 is delivered as a **select-mode sidecar**... Full dispatch+execute mode is delivered and tested as the programmable sidecar path but **is not wired for production**."
> "Runtime remains sidecar and is **not wired into index.ts**."

### 4.2 两条 agent 构造路径并存（真重叠）

| | runtime 路径（当前活跃） | assembly 路径（休眠） |
|---|---|---|
| 入口 | `index.ts:245 createSchedulerRuntime` | `assembler.ts assembleAgent` |
| 记忆域 | 无（SDK memory? 保持 undefined） | MemoryHost 完整 |
| 账本/身份 | 无 per-agent 经济账户挂载 | SqliteLedgerAdapter + IdentityMap |
| SDK 挂载 | 无（onSdkBuilt 钩子无人注册） | attachSdkOnce（memory+sorter） |
| 工具口 | **stub**（index.ts:263 throw） | 无此问题（但整体未接线） |
| 状态 | 活跃（模型选择+竞价） | 零引用 |

两条路径收敛点 = 同一个 `workloop/runner.ts`（执行引擎唯一咽喉）。

### 4.3 两条市场执行引擎并存（真冗余）
- `schedulers/arena-scheduler.ts`（活跃）：market 竞价调度器，被 SchedulerRunner + /lab scheduler/market 消费。
- `economy/market-runner.ts`（休眠）：§5.1 市场闭环全图（announce→…→settle→apply），仅测试。
- 表隔离是有意的（economy_tasks vs market_tasks，协调者裁决），但两套编排逻辑是真冗余，需 ADR 明确分工或合并。

### 4.4 execute-mode workloop 在 PTH 系统会话里实际瘫痪（关键缺口）
- PTH 常驻系统会话：`noExtensions:true` + 仅注入 agent-lab（agent-engine.ts:596-602）。
- **系统会话从不被 prompt**（纯宿主：扩展+事件转发），真实对话执行全在 tenant 会话。
- execute-mode（Delegation V2 委托）依赖 pi-subagents 扩展监听事件——系统会话内**没有该监听者** → workloop execute 超时/失败。
- 工具口是 stub（index.ts:263）→ workloop 内部无真实工具。

### 4.5 agent 在 PTH 里实际执行的真相
三条并发路径：
1. **主路径（tenant 用户会话）**：gateway → session.prompt → **pi SDK AgentSession 回合循环**（bash 被 PTH 平台级替换为 sandbox 转发）。**真实执行发生处**。
2. **subagent 委托**：interceptor 只做**模型选择**（mode:"select"），实际执行仍由 pi SDK 完成。
3. **agent-lab execute**：workloop 执行，但系统会话内瘫痪（见 4.4）。

**结论**：agent-lab 在 PTH 里只贡献"模型选择 + 竞价"，真实 agent 执行 = pi SDK 会话层。

## 5. vm 内核挂载结论

### 5.1 候选挂点评估

| 挂点 | 状态 | 可行性 |
|---|---|---|
| **PTH 会话层**（agent-engine.ts:613-621 sdkCreateSession / src/shared/sdk-adapter） | 活跃，覆盖全部真实执行 | **首选**——sandboxBash 同款先例（PTH 平台级替换，agent-lab 零适配） |
| agent-lab workloop runner 端口（ToolPort/ModelPort 注入） | 半瘫（工具 stub + 系统会话无委托监听） | 可选——需先补工具口+委托监听 |
| agent-lab 扩展入口（index.ts） | 接线层，不承载执行 | 只做事件钩子 |
| assembly | 休眠 | **不可作为挂点**（除非同时接线，成本高） |

### 5.2 代码归属
- **vm 内核本体 → `src/pth/`（或 `src/shared/` 被 pth 引用）**，经 `sdk-adapter` 挂 `createSession`/`session.prompt`/customTools。
- agent-lab 侧只保留消费端（port 适配/接线）。
- **不打破**"PTH 零引用 agent-lab + agent-lab 零引用 PTH"边界契约。

### 5.3 结构性结论
vm 内核 = **PTH 会话执行基座**（agent 回合宿主/工具执行/回合调度/budget 控制）。代码落在 PTH 侧，agent-lab 经 SDK 会话间接获得内核提供的执行语义。

## 6. 建议的后续路径

1. **vm 内核 spec（本设计主线）**：挂 PTH 会话层，代码落 src/pth（或 src/shared）。范围 = vm context 工厂 + TS strip 执行器 + 能力注入层 + 步数/超时守卫 + WM/转录接线。
2. **execute 链路缺口（独立任务）**：补 agent-lab execute-mode 的工具口 + Delegation V2 监听，让 taskpool/cycle、ingest/cycle 周期自动派发真正通电。这是休眠代码激活的前提。
3. **assembly 接线（独立任务，可选）**：完整装配路径接线到运行路径——但 scout-4 发现 2 个 blocker（workDir 无主、CommsTransport 无生产实现），成本高，建议暂缓。
4. **双市场引擎（ADR 裁决）**：arena-scheduler vs economy/MarketRunner 分工或合并。
5. **optimizer 反向依赖（小修）**：facade.ts:15 走 registry、shadow.ts:28-29 类型上移。

**优先级建议**：1（vm 内核主线）与 2（execute 缺口）应该一起考虑——vm 内核若要走 workloop 路径（可选挂点 2），必须先解决 2；若只走 PTH 会话层（首选挂点 1），2 是独立优化项。

## 7. 侦察引用索引

| 侦察 | 输出文件 |
|---|---|
| Scout-1 单复数对 | `docs/superpowers/explorations/2026-08-07-structure-recon/scout-1-duplicate-pairs.md` |
| Scout-2 模块地图 | `.../scout-2-agentlab-module-map.md` |
| Scout-3 src+设计意图 | `.../scout-3-src-and-docs-intent.md` |
| Scout-4 assembly 路径 | `.../scout-4-assembly-path.md` |
| Scout-5 runtime 路径 | `.../scout-5-runtime-path.md` |
| Scout-6 PTH 执行链 | `.../scout-6-pth-execution.md` |

关键代码事实（scout 已核实）：
- agent-lab README:294-346（sidecar 未接线自述）
- `extensions/agent-lab/index.ts:236-275`（惰性 schedulerRuntimeFactory + capturedWlRunner + 工具 stub）
- `src/pth/main.ts:95-108`（agent-lab 动态注入 systemExtensionFactories）
- `src/pth/core/agent-engine.ts:563-668`（常驻系统会话构建）、`:596-602`（noExtensions+extensionFactories）、`:613-621`（sdkCreateSession）
- `src/assembly/assembler.ts:52-72`（deps）、`agent-runtime.ts:23-42`（deps）、`memory-host.ts:65`（构造）
- `src/runtime/create-scheduler-runtime.ts:105-191`（组装）、`create-runtime.ts:84`（休眠 sidecar）
- `src/workloop/runner.ts:129/151/436-549`（onCheckpoint/onSdkBuilt/buildSDK 钩子，无人注册）
