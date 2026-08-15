# PTH 模块化产品形态设计

> 日期：2026-08-15
> 设计状态：已获方向批准；等待规格审阅
> 实施状态：未开始。本文定义目标边界和迁移顺序，不把现有目录描述为已完成的目标架构。

## 1. 决策

PTH 将演进为一个由 **PTH Host** 组合的能力域模块化单体。产品通过静态、受支持的 **Profile** 选择模块，而不是通过长期维护 fork、任意运行时插件或过早拆分微服务获得不同形态。

近期不创建一个更大的 `pth-core` 包，也不把现有 `core/`、`kernel/`、`impls/` 视为未来架构的正统中心。它们是迁移来源，而不是目标边界：当前 `core/` 主要是会话运行时，`kernel/` 混合了任务控制、执行、知识和运维，语言 kernel 则是另一种概念。

`ARCHITECTURE.md` 继续描述当前系统事实；本 SPEC 描述前向目标。在迁移完成前，两者不应被混同。

## 2. 目标与非目标

### 目标

1. 支持可裁剪的 Control、Standard、Full 产品形态，不维护平行产品分支。
2. 让 PTH 的任务控制、任务执行、代码执行、知识、会话和运维具有可理解、可测试、可替换的边界。
3. 将租户、工作区、lease 和执行授权变为显式协议，以支撑 sandbox 安全整改。
4. 保持单仓和常规自托管部署路径；在边界未稳定前，不引入内部 HTTP 调用或微服务网格。
5. 允许未来把 runner 独立为进程，而不要求这一步作为本次重构前提。

### 非目标

- 不把所有内部能力变成 npm 包或动态插件。
- 不重写现有 HTTP API、数据库 schema 或 PTL→PTH 桥。
- 不让不可信扩展获得 Host、数据库连接、全局密钥或任意进程执行能力。
- 不以“模块化”为名制造一个万能 domain/shared/core 包。

## 3. 目标结构

```text
Entrypoints
  Fastify API · PTL bridge · worker process · CLI
       │
       ▼
PTH Host / bootstrap
  profile selection · configuration · lifecycle · dependency wiring
       │
       ├── Session Runtime
       ├── Task Control
       ├── Task Runner
       ├── Execution Runtime
       ├── Knowledge
       ├── Runtime Catalog
       └── Operations
       │
       ▼
Contracts and ports
  TenantScope · TaskLease · ExecutionGrant · TaskOutcome · domain events
       ▲
       │
Adapters
  PostgreSQL · Redis · Pi SDK · sandbox · filesystem · Fastify · child_process
```

依赖规则：

```text
entrypoints/bootstrap  →  modules  →  contracts
adapters               →  contracts
entrypoints/bootstrap  →  adapters
```

模块不得 import 另一个模块的 repository、数据库连接、Fastify 实例或 sandbox client。跨模块只经目标模块公开的 command/query API 或 contracts 中的事件/port 交互。适配器只能在 bootstrap 中被选择和装配。

## 4. 模块职责

| 模块 | 拥有的规则与状态 | 公共面 | 禁止依赖 |
|---|---|---|---|
| `session` | pi 会话、Program run、流式交互生命周期 | SessionCommands、SessionQueries | Task repository、worker process |
| `tasking` | 发布、路由、认领、取消、flow、trigger、任务状态机 | TaskCommands、TaskQueries、TaskLease | Interpreter、sandbox、原始 PG pool |
| `runner` | leased task 的 AgentLoop、工作区编排、结果归并 | RunTask、TaskOutcome | Task state mutation、Fastify request |
| `execution` | 语言执行契约、执行策略、执行结果 | ExecutionPort | task routing、memory store、HTTP route |
| `knowledge` | memory、retrieval、refine、visibility | KnowledgeCommands、KnowledgeQueries | worker lifecycle、gateway |
| `catalog` | roles、spaces、capability policy、已批准扩展贡献 | CatalogSnapshot、CatalogAdmin | module-level singleton |
| `operations` | audit、metrics、activity、notification、读模型 | observers、admin queries | TaskLoop 主路径控制 |
| `bootstrap` | profile、adapter 选择、生命周期和故障收敛 | PthHost | 业务状态机 |

`DataWorldAccess` 将被逐步淘汰。它目前把 task、memory、transcript、audit 和原始查询聚合为万能对象，促使应用逻辑绕开边界。替代物是由所属模块定义的小端口，例如 `TaskRepository`、`MemoryRepository`、`TranscriptRepository`、`AuditSink` 和 `TaskReadModel`。

## 5. 必要协议

以下类型属于 `pth-contracts`，不依赖 Fastify、PostgreSQL、Redis、Pi SDK 或 sandbox：

| 协议 | 含义 | 必须携带 |
|---|---|---|
| `TenantScope` | 某次调用可访问的数据与策略范围 | tenant、principal、roles、trace ID |
| `TaskLease` | 对一个已路由 task 的短期处理权 | task、tenant、workspace reference、role、deadline、generation |
| `ExecutionGrant` | 对一次语言执行的短期、单用途授权 | task lease、language、capability set、deadline、nonce |
| `TaskOutcome` | runner 对 Task Control 的唯一交付物 | status、result/error、artifacts、usage、trace ID |
| `DomainEvent` | 已提交状态变化的不可变通知 | event ID、scope、aggregate、time、payload summary |

`ExecutionGrant` 是 sandbox 协议整改的核心：它取代全局 `SANDBOX_SHARED_SECRET` 与可猜测 kernel ID 的授权含义。sandbox 只接受有效、未过期、绑定 tenant/workspace/generation 的 grant；它不再从环境变量、cwd 或调用者自报的 `space` 推断授权范围。

## 6. Runtime Catalog 与扩展

角色、空间、能力策略和扩展贡献不再以模块级全局注册表表达。每个 Host 或 Runner 在启动时构建一个 `RuntimeCatalog`，并向运行单元传递不可变快照。

扩展被分为两类：

1. **一方模块贡献**：编译期或部署期明确启用，能贡献 role、space、adapter 或 observer；由 Profile 白名单决定。
2. **受限 toolstore 扩展**：只能使用受限 SDK，并以声明式 contribution 被 catalog 验证；不能直接取得 Host、PG pool、sandbox credential 或 registry。

`onStartup`、event handler、tool/capability 等贡献必须有可验证的实际运行语义；没有宿主支持的 manifest 字段不得对作者承诺。动态 `new Function` 不是模块系统，也不能作为不可信扩展的安全边界。

## 7. 产品 Profiles

| Profile | 组合模块 | 适用场景 | 不包含 |
|---|---|---|---|
| **Control** | tasking、catalog、operations、最小 API/identity adapter | 轻量控制面，远程 runner 执行 | 本地 AgentLoop、语言执行、完整会话运行时 |
| **Standard** | Control + runner + execution + knowledge | 当前常规自托管的一体化形态 | 完整 Program/session、全部自动化扩展 |
| **Full** | Standard + session + programs + 高阶 workflow automation + full operations + 已批准扩展 | 团队与联邦平台 | 不受限第三方插件 |

**Private deployment** 不是第四套代码形态，而是任一 Profile 叠加的部署策略：私有模型路由、私有存储、密钥管理、egress policy、扩展 allowlist 和审计保留策略。它必须通过 adapter/configuration 选择实现，不能 fork PTH。

Profile 只能在启动或部署时选择；运行中不可任意加载/卸载业务模块。每个 Profile 有显式 module manifest 与启动测试，依赖缺失即 fail closed。

## 8. 迁移策略

迁移保持 API 与数据库兼容，按绞杀式替换进行。

### Phase 0：边界守卫

- 新增 `CONTEXT.md` 和本 SPEC 作为术语与目标来源。
- 建立依赖规则：禁止 gateway 直接访问 repository/PG pool；禁止模块依赖具体 sandbox 实现；禁止新增全局 registry。
- 为当前路由和 task lifecycle 建立兼容测试基线。

### Phase 1：Contracts 与 facade

- 创建 `packages/pth-contracts`，先放协议、ports、DTO 与事件类型。
- 将 `Interpreter`、`ExecutionResult`、worker IPC、lease 语义从 `@away_from/pth-sandbox` 移入 contracts。
- 提供兼容 facade，使现有 `KernelRuntime` 和 gateway 不必同步重写。

**验收**：PTH 业务代码不再从 sandbox 包 import 领域执行协议；现有 API 行为不变。

### Phase 2：Task Control / Runner 分离

- 将 task state transition、flow、trigger、claim 归入 `tasking`。
- 将 AgentLoop 和任务执行编排归入 `runner`；runner 只处理 `TaskLease` 并返回 `TaskOutcome`。
- 将 audit、metrics、notification、refine 改为 outcome/event 的 observer，不再直接嵌入 TaskLoop。

**验收**：TaskLoop 不再直接取得 `dataWorld`、原始环境变量、URL 或全局事件总线；所有 task completion 幂等。

### Phase 3：Execution 与 sandbox 整改

- 建立 `ExecutionPort` 和 sandbox/TS adapters。
- 将 workspace 改为 opaque `workspaceRef`；执行 adapter 只获得本次任务的挂载权限。
- 用 `ExecutionGrant` 替换共享 secret、predictable kernel ID 和 body-provided visibility scope。

**验收**：跨 tenant workspace、kernel state、memory visibility 的负向测试全部通过；取消、timeout、release 都有同一 generation 的确定语义。

### Phase 4：Catalog 与扩展收敛

- 将 roles、spaces、capability policy 改为 `RuntimeCatalog` snapshot。
- 主进程与 runner 子进程都从同一 manifest 构建 catalog，而非重复副作用注册。
- 将扩展 manifest 与真实 contribution model 对齐；不支持的激活模式从文档和 schema 移除。

**验收**：不同 Profile 的 catalog 可独立启动；一个 Profile 的扩展不影响另一个实例。

### Phase 5：Profile Host

- 将 `main.ts`、`assembly.ts`、`batch-process.ts` 收敛为 API Host、embedded Host、runner Host 三个 bootstrap。
- 发布 Control、Standard、Full 的 manifest 与启动测试。
- 将现有默认部署映射到 Full，保留兼容配置名并给出迁移提示。

**验收**：三种 Profile 均有 clean build、健康检查、模块依赖校验和端到端 smoke test；Profile 不通过删除源码实现裁剪。

### Phase 6：可选的进程拆分

仅在 Standard/Full 的 contracts、lease、outcome、观测和失败语义稳定后，才把 runner 从 embedded Host 提升为独立 `pth-runner` 进程。现有 batch fork 是迁移载体，不是最终架构约束。

## 9. 测试与交付规则

1. 每个模块拥有单元测试和 port contract tests；adapter 使用独立集成测试。
2. 每个 Profile 必须有启动矩阵：依赖完整、依赖缺失、权限拒绝、升级兼容。
3. tasking/runner/sandbox 必须有 lease、cancel、timeout、retry、idempotent outcome 的跨进程测试。
4. 扩展必须验证 manifest、贡献、capability policy 和禁用行为；不能只验证文件被扫描。
5. `npm pack --dry-run`、clean Docker build 和 profile compose render 是发布门禁；不得由本机残留 `dist` 掩盖失败。

## 10. 反过度抽象护栏

- 仅为稳定、跨 Profile 的协议创建 workspace 包；不要为每个目录创建包。
- 同一 Host 内不使用 HTTP/RPC 代替函数调用；只有 runner 独立进程后才通过 transport 实现 port。
- 领域事件用于已提交副作用和读模型，不取代明确的 task state transition。
- 模块只拥有自己的存储接口；跨模块读数据使用 query/read model，不借用底层 pool。
- 任何“插件”都先回答：它是可信模块、受限扩展，还是不可信任务代码；三者不得共享权限模型。

## 11. 完成定义

本设计完成不是把目录改名，而是同时满足：

1. Control、Standard、Full 都可由明确 manifest 组合并独立通过启动测试；
2. PTH 的业务协议不依赖 sandbox 包，sandbox 是 execution adapter；
3. Task Control、Runner、Execution、Knowledge、Catalog 的边界可在不读其内部实现的前提下使用；
4. 租户、workspace、lease、execution authority 在所有跨边界调用中显式存在；
5. 现有 API/数据兼容路径持续可用，且安全审计的 P0 结构问题有可验证的整改落点。
