# Scout-4 深度侦察：agent-lab `src/assembly/` 完整装配路径

> 侦察结论：assembly 是一个**完整、已测试、未接线**的装配层（AgentAssembler 六步装配 → MemoryHost 记忆域 → AgentRuntime 经济主体生命周期），全仓库 `src/` 内**零生产引用**（只有 `test/` 与 `bench/assembly-demo.ts` 消费）。当前生产路径（`index.ts` → interceptor → SchedulerRunner）在 select 模式下根本不创建 AgentInstance 级运行体；execute 模式下 `wlRunner.run` 直接裸跑 workloop，无记忆域/无账本开户/无 SDK 挂载/无身份。

---

## A. assembly 路径相对当前 runtime 路径的增量能力

当前生产路径（`index.ts` 236-497 `schedulerRuntimeFactory` → `registerInterceptor` 499 → `SchedulerRunner`）：
- **select 模式**（默认）：调度器只选 model，pi-subagents 原生执行。AgentInstance 记录由 `arena/agent-id.ts:9-45 findOrCreateAgentByModel` / `:47-77 ensureSessionAgent` / `scheduler/runner-sdk.ts:94-122 agents.create` 直接 `core.repository.insertAgent`（repository.ts:422），**无**记忆域目录、无开户、无 SDK。
- **execute 模式**（`scheduler/runner.ts:365-383` → `scheduler/runner-sdk.ts:124-176 agents.run` → `wlRunner.run`）：裸跑 workloop。runner 的 `sdkExtensions`（runner.ts:70）在生产中**从无注册者**——`buildSDK`（runner.ts:436-549）末尾 545-547 的应用循环永远空转。

assembly 路径（`assembler.ts` + `agent-runtime.ts` + `memory-host.ts`）补齐的六块能力：

| 能力 | 实现位置 | runtime 路径现状 |
|---|---|---|
| **六步装配生命周期**（解析→校验→记忆域→开户→注册→Runtime） | `assembler.ts:94-206` `assembleAgent` | 无；agent 由 `insertAgent` 一步裸插 |
| **校验**：configSchema（json-schema-min）、幂等冲突、`RESERVED_IDS` 黑名单、memorySpec 白名单 | `assembler.ts:104-128` | 无（runner-sdk 只做 merge config） |
| **记忆域**：私域 MemoryStore + 公域联合检索 + 水位过滤 + TTL sweeper + 方言预检 + revive | `memory-host.ts:78-230` | 无 |
| **账本**：LedgerPort 语义（flat-K 开户、balance 预检 debit、freeze/unfreeze、removeAccount 回滚） | `ledger-port.ts:32-107` | 生产用 `SqliteLedger` 直连（model 键→UUID 迁移），无 Port 语义 |
| **SDK 挂载**：经 runner `onSdkBuilt` 真实钩子 → `memory.attachSdk` + `mountSorterSdk`；`onCheckpoint` → `dsp.snapshot` + `bridge.ack` | `agent-runtime.ts:217-252` `attachSdkOnce`；runner.ts:151/129 | 无（sdkExtensions 空） |
| **身份/comms**：IdentityMap（`<root>/identity/`）+ CommsBridge 收件缓冲 + delivery 强制 auto | `assembler.ts:158-175`；`comms-bridge.ts:47-196` | 无 |
| **生命周期**：收窄 run 签名、resume(latest)、dispose（停 sweeper+反注册钩子）、inbox drain "task:" 前缀、resume 时 pruneDedup/pruneIdem | `agent-runtime.ts:93-214` | 无 |

失败清理：`assembler.ts:198-207` catch → `rmSync` 记忆域 + `ledger.removeAccount`（attempt-local）。

---

## B. 为什么没接线 + 依赖清单

### 没接线的直接证据
1. `src/` 内无任何 `assembly/` import（grep 仅命中 `test/`、`bench/assembly-demo.ts`）。`index.ts` 从不 import `createAgentAssembler`。
2. README.md:346 「Runtime remains sidecar and is not wired into index.ts」；`docs/framework-vs-construction.md:68-73` 把「调 assembly/assembler → 装配 operator + 首批 agent」列为**构造层 E 的引导脚本指引**（文档建议，未实施）。
3. 生产需要的部分依赖无来源（见下），尤其是 **workDir（记忆域根目录）与 CommsTransport** 在 agent-lab 内无生产者——这两点使装配无法直接落地。

### AgentAssemblerDeps 全清单（assembler.ts:52-72）
| dep | 类型 | 生产来源现状 |
|---|---|---|
| `registry` | DefinitionRegistry | ✅ `schedulerCore.definitions`（create-core.ts:9）；`resolve` 在 registry.ts:41 |
| `agentStore` | `{getAgent, insertAgent}` | ✅ `schedulerCore.repository`（repository.ts:422/449） |
| `ledger` | LedgerPort | ⚠️ 需 `SqliteLedgerAdapter(new SqliteLedger(sharedStore.raw, endowment))` 包裹现有 ledger（ledger-port.ts:26-107）；语义与 arena 直连不同 |
| `ruleBootstrap` | RuleBootstrap | ⚠️ 需 `PublicDomainBootstrap(pubDir).ensureInitialized()` 先种公域目录——生产从未初始化 |
| `runner` | WorkLoopRunner | ✅ `capturedWlRunner` / `rt.workloopRuntime.runner`；`currentSeqOf` 在 runner.ts:143（特性检测兼容） |
| `workDir` | string（记忆域根） | ❌ **生产无此概念**——状态全在 SQLite，记忆域是目录制（`<root>/agents/<id>/`，types.ts:54） |
| `comms?` | `{transport, identity, delivery?}` | ❌ **CommsTransport 无生产实现**（memory/comms.ts:39-43 接口；仅测试 mock）——Task 12 ptl-communicate 未落地 |
| `now?`/`idGen?`/`checkpointStore?`/`bridge?`/`identityMap?` | 可选 | checkpointStore ✅（create-scheduler-runtime.ts 的 `workloopRuntime.checkpointStore`）；其余缺省自足 |

### AgentRuntimeDeps 全清单（agent-runtime.ts:23-42）
必填：`agentId`、`definition`（绑定 workloop，自填字段）、`schedulerInstanceId`、`runner`、`memory: MemoryHost`、`ledger: LedgerPort`。
可选：`idGen`、`checkpointStore`（无参 resume latest，checkpoints.ts:142）、`bridge`（comms 桥）、`taskStore`（sorter SDK 端口，缺省不挂）。

**结论：要跑起来，最小接线 = registry/agentStore/ledger/ruleBootstrap/runner/workDir 六项 + checkpointStore；comms 桥整链（transport/identity/bridge）可暂时缺省（装配产物里 bridge/identity 为空、`delivery` 特性缺省 auto）。**

---

## C. 把 assembly 接入实际运行的精确改动点

### 1. `index.ts`（扩展入口 = 生产接线点）
- **L14**：`import { findOrCreateAgentByModel, ensureSessionAgent } from "./src/arena/agent-id.ts"` —— 这两个是"裸 insertAgent"创建路径，与装配冲突。
- **L236-497** `schedulerRuntimeFactory`：装配器最自然的构造点（此作用域已有 `schedulerCore`、`capturedWlRunner`、`ledger`、`cfg`）。在此处：
  - 构造 `ruleBootstrap = new RuleBootstrap(pubDir)` + `PublicDomainBootstrap(pubDir).ensureInitialized()`（pubDir 需选型：`join(localDir, PUBLIC_DOMAIN_DIR)`）。
  - 构造 `ledgerAdapter = new SqliteLedgerAdapter(ledger)`（包裹 L110 `SqliteLedger`）。
  - 构造 `assembler = createAgentAssembler({ registry: schedulerCore.definitions, agentStore: schedulerCore.repository, ledger: ledgerAdapter, ruleBootstrap, runner: capturedWlRunner!, workDir, checkpointStore: rt.workloopRuntime?.checkpointStore })`；维护 `Map<agentId, AgentRuntime>`。
- **L499** `registerInterceptor(pi, cfg, schedulerRuntimeFactory)` —— 拦截器→调度路径入口（不直接改，但 execute 模式下派发终点见下）。
- **L502-513** `pi.on("session_start")` → **L512** `ensureSessionAgent(...)`：这是"把 workloop 变成可运行 agent"的最自然替换点——改调 `assembler.assembleAgent({kind:"workloop", id:"pi-default-loop", version:"1.0.0"}, {cloneMode:"fresh", schedulerInstanceId: arenaId, agentId: agentInstanceId, memory:{dialect:"json"}})`。
  - ⚠️ 注意幂等：`assembleAgent` 对已注册 agent 抛错（assembler.ts:116-118）；`ensureSessionAgent` 现在幂等复用既有 agent——接入时需先 `getAgent` 判断 or 让装配成为唯一创建者。

### 2. `src/arena/agent-id.ts`（创建路径）
- **L9-45** `findOrCreateAgentByModel`、**L47-77** `ensureSessionAgent`：若装配成为 agent 唯一创建者，这两个函数要么改走 assembler、要么被 index.ts 弃用。它们创建的记录无 `memorySpec/endowment`（虽然 repository.ts:431-448 已支持写入）且无记忆域目录。

### 3. execute 模式派发终点（可选改造，若要让"调度执行"也走装配产物）
- `src/scheduler/runner-sdk.ts:124-176` `agents.run` —— 目前 `getAgent` → merge config → `wlRunner.run` 裸跑。可改为：命中 `Map<agentId, AgentRuntime>` → `runtime.run({task, config, signal})`（保留 withTimeout/abort/Normalize 包装）。
- `src/scheduler/runner.ts:365-383` `directExecute` 与 :534-542 `buildSchedulerSDK` —— 与上同理；不改也能跑通（execute 路径降级为裸 workloop）。

### 4. 新增组合根（推荐）
- 新建 `src/runtime/create-assembly-runtime.ts`（或扩 `create-scheduler-runtime.ts`）：把 assembler + agentRuntime 注册表 + sweeper 生命周期集中；`index.ts` 只接线。参照 `bench/assembly-demo.ts:55-130`（已证明的最小可跑组装：registry+adapter+ruleBootstrap+内存 agentStore+mock runner）与 `test/assembly-wiring.test.ts`（C 接线包组合测试）。

### 5. 无需改的既有设施（已就绪）
- `core/contracts.ts:152-175` `AgentInstanceRecord` 已含 `memorySpec?/endowment?`（不再是结构超集）；`schema.ts:51-52` 已有 `memory_spec/endowment` 列；`repository.ts:422-458` insertAgent/getAgent 已持久化/读取。
- runner 钩子齐备：`onSdkBuilt` runner.ts:151-156、`onCheckpoint` runner.ts:129-136、`currentSeqOf` runner.ts:143-145、`buildSDK` 应用扩展 runner.ts:545-547。

---

## D. 风险 / 难点

1. **workDir 无主（blocker）**：装配产物全部落在文件系统目录（`<root>/agents/<id>/`、`public-domain/`、`identity/`，types.ts:54-56），生产状态在 SQLite。根目录选型未定；`docs/framework-vs-construction.md:81` 的跨容器状态问题（共享卷/服务化/postgres）未裁决。多容器/PTH 多进程下记忆域不可共享。
2. **CommsTransport 无生产实现（blocker）**：`comms.transport`（memory/comms.ts:39-43）仅测试 mock；ptl-communicate（Task 12）未落地。缺省则 bridge/identity 全链为空（装配可跑但 comms 契约⑥⑨失效）。
3. **公域种子未初始化**：`RuleBootstrap` 依赖 `public-domain/` 被 `PublicDomainBootstrap` 种过（rule-bootstrap.ts:38-47）；生产 bootstrap 序列（E 脚本）未实施。
4. **账本键域冲突**：生产 ledger 以 model 键开户后经 `ledger.migrateAgentKeys` 迁 UUID（index.ts ~L350）；装配 `SqliteLedgerAdapter.open` 直接 UUID flat-K 开户。两条创建路径（arena bootstrap 的 `ensureArenaInstance/syncArenaAgents` vs 装配）可能对同一 agent 双开户——`open` 幂等（{created:false}）但 `assembleAgent` 的 `getAgent` 预检会抛"already registered"，**装配无法吸收既有 agent**，需创建路径统一。
5. **DSP loadSnapshot 未交付**：`agent-runtime.ts:14-15` 明示 `src/memory/dsp.ts`（DspBuilder:64）只有 build/snapshot/restore，无 `loadSnapshot`（Task 11 交付项）——`restoreDspOrder`（agent-runtime.ts:254-267）特性检测回退 `build("realtime")`，契约⑦快照恢复暂为防御语义。
6. **无参 resume 依赖 checkpointStore**：注入缺省 → resume 退化为新 run（agent-runtime.ts:117-121）。生产 `workloopRuntime.checkpointStore` 可用，但接线必须显式传。
7. **sweeper 定时器**：每个 AgentRuntime 构造即 `startSweeper`（agent-runtime.ts:89-91；memory-host.ts:196-203，interval unref）——生产必须保证 dispose，否则长期会话泄漏。
8. **RESERVED_IDS 边界**：`central-pool`/`calibration-executor` 被装配拒绝（assembler.ts:121-124、ledger-port.ts:36-38）；中央池 bootstrap 走 SqliteLedger 底层（central-pool.ts:25-26）不受影响——接线时勿把池装配进来。
9. **duck-typed 定义字段**：`wlDef.config`/`wlDef.memory` 是 `WorkLoopDefinition` 无此字段的结构超集（assembler.ts:7-10, 102, 125）——`pi-default-loop@1.0.0` 定义（create-runtime.ts:42-70）**不含** config/memory 字段，实际装配时 config 恒 undefined、memory 需经 `AssembleOptions.memory` 显式传。

---

## E. 关键文件索引（按优先级）

| 文件 | 行 | 为什么重要 |
|---|---|---|
| `src/assembly/assembler.ts` | 52-72（deps）、94-206（六步）、198-207（回滚） | 装配核心 |
| `src/assembly/agent-runtime.ts` | 23-42（deps）、93-143（run/resume）、217-252（attachSdkOnce） | 经济主体生命周期 + SDK 挂载 |
| `src/assembly/memory-host.ts` | 78-125（构造）、127-159（retrieve）、161-193（attachSdk）、196-203（sweeper） | 记忆域宿主 |
| `src/assembly/ledger-port.ts` | 26-107 | 账本 Port 语义 |
| `src/assembly/comms-bridge.ts` | 47-196 | 收件缓冲 + 身份权威 |
| `index.ts` | 236-497（factory）、499（interceptor）、502-513（session_start） | 生产接线点 |
| `src/arena/agent-id.ts` | 9-77 | 现存裸创建路径（与装配冲突） |
| `src/scheduler/runner-sdk.ts` | 94-176 | execute 模式 agents.create/run |
| `src/workloop/runner.ts` | 101、129、143、151、436-549 | 钩子（onSdkBuilt/onCheckpoint/currentSeqOf） |
| `bench/assembly-demo.ts` | 55-130 | 最小可跑组装参照 |
| `test/assembly-wiring.test.ts` | 全文 | C 接线包组合测试 |
| `src/core/storage/repository.ts` | 422-458 | insertAgent/getAgent（已含 memorySpec/endowment） |
