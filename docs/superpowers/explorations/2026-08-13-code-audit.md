# 代码审计报告（2026-08-13——复用率与模块化解耦专项）

> 工具：ts-prune（未使用导出）+ knip（未使用文件/依赖/导出）+ madge（循环依赖）+ 人工逐边核实（运行时/类型级判定）。
> 基线：main @ 28ce108（1560 测试全绿）；上轮基线：2026-08-10（a22c6a8，9 环全类型级）。

## 一、结论速览

| 维度 | 判定 | 要点 |
|------|------|------|
| 运行时循环依赖 | ✅ 无（13 环全部类型级——madge 不区分 type/runtime，逐边核实后运行时图无环） | 与上轮一致，但环数 9→13，结构债在积累 |
| 复用率 | ⚠️ 死导出约 60+（集中 4 个 barrel + 3 个孤儿导出） | 上轮删的 barrel 又新增两处同类问题（impls/kernels、interpreter） |
| 模块化解耦 | ⚠️ 4 处运行时跨层耦合（核心→实现装配点）+ 2 处核心↔存储耦合 | 均为已知装配模式，但类型放置是环的根源 |
| 依赖卫生 | ⚠️ 2 个测试用 workspace 包未声明（类 zod 事件风险）+ 1 未用 devDep + knip.json 陈旧 | P0 建议修 |
| 本轮新代码（N1/N3/N9） | ✅ 零新增环、零死导出、端到端接线完整 | cache-store/task-loop/optimizer-loop 未入任何环 |

## 二、复用率——死导出清单（分级）

### A 级：整 barrel 半死（重导出面误导——消费方已直连子文件）

| barrel | 死重导出（ts-prune 实测） | 建议 |
|--------|--------------------------|------|
| `src/pth/impls/kernels/index.ts` | **25 项**：TsInterpreter/PythonInterpreter/WebCapability/RecallState/createWebCapability/createRecallState/PyKernel/BashKernel/SandboxKernel/CCompiledKernel/SandboxCompiledKernel/SandboxDebugSession/CDebugSession/CDebugAdapterOptions/MiValue/MiRecord/parseMiLine/stoppedFromRecord/framesFromResult/variablesFromResult/默认常量×5/选项类型×3 | 删死重导出或拆 barrel——消费方（kernel-manager/ts-interpreter）直 import 子文件 |
| `src/pth/kernel/interpreter/index.ts` | **约 20 项**：ExecuteOptions/DebugBreakpoint/DebugStackFrame/DebugVariable/DebugStopped/DebugSnapshot/DebugEvent/DebugSession/Debuggable/LlmMessage/LlmCompleteOptions/LlmResult/Toolstore/createLlmFn/createToolstore/listToolstoreIndex/createReadSource | Debug* 类型应迁至 interpreter/types.ts（活文件已有）——barrel 只留活面 |
| `packages/framework/src/lab-data/index.ts` | **17 项 + 零引用**（barrel 本身无任何 import 者——上轮"半死"已转"全死"） | 删除 barrel（子文件 arena/telemetry 被 tui-lab 直连） |

### B 级：孤儿导出（无引用——删除或降级）

| 导出 | 位置 | 备注 |
|------|------|------|
| `AGENT_TOOLS_DESCRIPTION` | agent-tools.ts:763 | 大段工具契约文档常量——零引用（工具描述实际走场景化三要素路径）；可转 doc 或删 |
| `buildKernelHostApp` | sandbox/kernel-host.ts:365 | 组合式独立 app 入口——sandbox main.ts 用 registerKernelHost，此变体无引用 |
| `collectStats` / `suggest` | kernel/execution/stats.ts | stats.ts 仅剩 `BatchSuggestion` 类型被 batch-scaler/batch-manager 引用——两函数死；考虑整文件并入 batch-scaler |
| `isResolvable` | resolver-core.ts:120 | 无引用（模块内其他函数活） |
| `resetConfig` | perf-params.ts:70 | 测试用还是死？核实后定 |
| `LogComponent` / `ToolEvent` / `CredentialProvider` 等 8 个类型 | logger/tools/storage | 类型面——多数可保留为公共 API 面（标注即可） |

### C 级：保留观察（上轮已标——本轮复核）

- `run.ts` printBanner/printHelp/getVersion/resolveOrFail 重导出——消费方走 cli/main.js 中转（冗余一跳，非死）
- tui-shared 6 组件（TopBar/TabBar/StatusBar/SparkLine/BarChart/layoutChart）**仍零引用**——TUI 演进中，维持 ⏸
- 复用正面确认：上轮 `PthClient.streamSSE` 统一出口仍在生效（client/console 两调用方）；SQL upsert 样板唯一源 memory-store-pg（scripts/seed-wiki.ts 手写迷你 upsert——独立脚本可接受，标注）

## 三、模块化解耦——循环依赖全景（13 环）

### 判定方法

madge 报环不区分 `import` 与 `import type`——本轮逐边核实：**13 环全部为类型级闭合，运行时图无环**（1560 测试 + 生产运行佐证）。但类型级环同样是结构债：它说明"类型没有归位"。

### 环成因归类

| 类 | 环 | 成因 | 修法 |
|----|----|------|------|
| **barrel 型 ×9**（4,5,6,8,9,10,12,13 + framework 1,2） | extensions/index 与 context/manage/perf/memory/model/obs 互引；storage/index、interpreter/index 参与长链 | 子文件 `import type` 从 barrel 取类型，barrel 又重导出子文件 | **抽 types 模块**：extensions/types.ts 放 TsReplExtension/ExtContext（一次杀 6 环）；interpreter 类型已可迁 types.ts；framework containers/commands 同理 |
| **组件对偶 ×1**（3） | slot-binding ↔ store | slot-binding `import type { ComponentType }` from store；store 运行时 import slot-binding | ComponentType 下沉至 slot-binding 或共享 types |
| **核心→实现装配 ×2**（7,11） | space-registry ↔ builtin-spaces；worker-cluster ↔ default-roles | 核心模块运行时 import 实现模块做装配（函数式注册已是对的姿势——见下），实现模块 type-only 反引核心 | 结构环由 type-only 反边构成——**类型下沉**（WorkerRole 已在 worker-cluster，default-roles 只引类型 ✓；SpaceRegistry 类型同构）或**装配期注入**（assembly.ts 传 DEFAULT_ROLES 进 worker-cluster 构造——彻底解耦核心与 impls 模块） |

### 运行时跨层耦合（非环——但方向值得审视）

| 边 | 方向 | 评价 |
|----|------|------|
| worker-cluster → impls/roles/default-roles | 核心→实现（运行时） | 已按"纯数据定义 + 函数式装配"注释自觉——但装配发生在核心模块内而非装配层；**建议移 assembly.ts 注入** |
| space-registry → impls/spaces/builtin-spaces | 核心→实现（运行时） | registerBuiltinSpaces(spaceRegistry) 参数注入 ✓——此边姿势正确，保留 |
| task-store-pg → role-router → worker-cluster | 存储→执行（运行时） | 持久层调用路由校验（routeTaskRole/checkTaskRouting/allKnownRoles）——**分层倒置**：建议路由校验上移 gateway/服务层，task-store 只存不判 |
| ext-registry → worker-cluster（registerWorkerRole） | 扩展→执行（运行时） | 注册通道需要回调核心——可接受（事件/注册表模式），标注 |

## 四、依赖卫生（knip）

| 项 | 现状 | 建议 |
|----|------|------|
| **未声明依赖（P0——类 zod 事件）** | test/* 6 处 import `@away_from/mailbox`、`@away_from/extensions-in-container`——root devDeps 只声明了 infra/shared | devDeps 补 `file:packages/mailbox`、`file:packages/extensions-in-container` |
| 未用 devDep | `@vscode/debugprotocol` | 删除 |
| knip.json 陈旧 | `pit` ignoreBinaries（已改名 ptl）、多个 entry/ignore 模式无匹配 | 清理配置——审计保持锋利 |

## 五、体量与拆分候选（复用/解耦的大头）

| 文件 | 行数 | 上轮 | 拆分建议 |
|------|------|------|---------|
| core/agent-engine.ts | 979 | 979 | 不变——已知大工程（会话恢复/检查点/drain 子模块） |
| kernel/execution/agent-loop.ts | 976 | + | 负结果收敛窗口（约 120 行）+ prompt 框架渲染 + trace 收集可拆 3 子模块 |
| kernel/execution/agent-tools.ts | 773 | + | 工具 description/场景化文案块 → 数据模块；AGENT_TOOLS_DESCRIPTION 处置后更瘦 |
| components/store.ts | 621 | + | 与 slot-binding 的类型对偶见上 |
| kernel/execution/optimizer-loop.ts | 406 | 384→406 | detectHotspots（8 模式）+ PATTERN_DESC + renderSuggestion 可拆 optimizer-hotspots.ts（本轮新增 cache-waste 前已 384） |

## 六、本轮新增代码审计结论（28ce108 N1/N3/N9）

- cache-store/worker-scorecard/task-loop/optimizer-loop 修改：**零新增环、零死导出**；cacheUtilization 接线 scorecard→聚合→热点→sensor 全链路闭环（已实机验收）
- scripts/seed-wiki.ts：独立脚本、零 repo 依赖（仅 pg）——手写 upsert 与 memory-store-pg.write() 语义重复（幂等判定不同：content 比对 vs version CAS）——**接受**（脚本需零依赖），已标注
- Dockerfile×2：镜像层改动无代码影响

## 七、建议修复批次（不执行——待裁决）

| 批 | 内容 | 收益 | 风险 |
|----|------|------|------|
| P0 | devDeps 补 mailbox/extensions-in-container；删 @vscode/debugprotocol；knip.json 清理 | 断依赖侥幸、审计锋利 | 极低 |
| P1 | extensions/types.ts 抽类型（杀 6 环）+ interpreter 类型迁移 + lab-data/index barrel 删除 + impls/kernels barrel 瘦身 | 环 13→5、死导出 -40 | 低（类型迁移——tsc 双查 + 1560 测试兜底） |
| P1b | 删孤儿导出（AGENT_TOOLS_DESCRIPTION/buildKernelHostApp/collectStats/suggest/isResolvable 等——逐个 grep+测试核实） | 复用面干净 | 低 |
| P2 | task-store 路由校验上移；worker-cluster 装配期注入；agent-loop/agent-tools/optimizer-hotspots 拆分 | 分层正位、单文件可读 | 中（行为保持需测试兜底） |

## 八、审计方法（可复跑）

```bash
npx knip --config knip.json
npx ts-prune | grep -v "used in module"
npx madge --circular --extensions ts src/pth packages/framework/src
# 环核实：madge 报环后逐边 grep "^import" 区分 import / import type
```

## 九、执行记录（2026-08-13 同日三环节全部落地）

| 环节 | 提交 | 内容 | 验证 |
|------|------|------|------|
| 1 · P0 依赖卫生 | `bb80456` | devDeps 补 mailbox/extensions-in-container（file: 链接）；删 @vscode/debugprotocol；knip.json 清理（pit 陈旧项等） | knip 未声明依赖/未用 devDep/配置提示全部清零 |
| 2 · P1 类型归位 + barrel 瘦身 | `6e78ef8` | extensions/types.ts（杀 6 环）；interpreter/types.ts 收 WorkerKernel；components/types.ts（slot-binding/store 断环）；impls/kernels barrel 25 死重导出删除；lab-data barrel 瘦身 + schema.ts 删除 | madge 13→5；ts-prune 60→48 |
| 3 · P2 分层正位 + 模块拆分 | `00eef9e` | task-store 路由 DIP（存储只存不判）；worker-cluster setDefaultRoles 装配注入（核心不 import 实现层）；batch-process 子进程入口自注入；optimizer-hotspots.ts 拆分（406→245 行）；test/helpers.ts 显式注入装配 | **madge 13→3**；tsc×2 干净；**1560 测试全绿** |

**执行后剩余**（标注保留——非债务）：
- madge 剩余 3 环：framework containers/commands 2 环（类型级）+ space-registry↔builtin-spaces（姿势正确的装配环——函数式注册 + type-only 反边，测试依赖自动注册，保留）
- 测试引用类导出保留（仓库惯例）：AGENT_TOOLS_DESCRIPTION/buildKernelHostApp/collectStats/suggest/isResolvable/resetConfig/SandboxDebugSession
- 大文件拆分剩余：agent-engine 979（已知大工程）、agent-loop 976、agent-tools 773（下轮专项）
