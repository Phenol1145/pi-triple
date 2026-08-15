# PTH 模块化迁移 v2（新范围可执行计划）

> **计划状态：可执行（2026-08-15 建立）** —— 本文件是 PTH 模块化迁移的唯一执行入口。
> 旧五份 Reference-only 计划（`2026-08-15-pth-modularization-program.md`、
> `2026-08-15-pth-contracts-boundaries.md`、`2026-08-15-pth-tasking-runner.md`、
> `2026-08-15-pth-execution-isolation.md`、`2026-08-15-pth-catalog-profiles.md`）
> 自本文件生效起转为历史参考，不再按原 checkbox 执行。
>
> **实际文件名说明（本次盘点确认）**：旧计划目录中不存在
> `2026-08-15-pth-tasking.md`、`2026-08-15-pth-runner.md`、`2026-08-15-pth-execution.md`、
> `2026-08-15-pth-catalog.md`、`2026-08-15-pth-session.md`，也不存在 `2026-08-15-pth-knowledge.md`；
> 实际五份文件以上方列出的文件名为准。

## 背景与新范围输入

- **ADR 0001（PTH 与 PTL 目标范围再界定，2026-08-15）**：PTH 是自耦自然语言解释器（解释即执行）；
  PTL 是基于 pi 的多环境共存平台；两者不是前后端关系；PTL 通过 PTH CLI 调用 PTH；
  现有 HTTP 桥降级为兼容通道，不再定义两者关系。PTH 专属前端、无容器版本为后续方向（由其他 ADR 管）。
- **拆分裁决（`docs/pth/split-design.md`，2026-08-15）**：单仓 workspace 包形态；
  `packages/pth-memory`（记忆域）与 `packages/pth-sandbox`（沙箱域）已拆为独立包；
  **内核契约包含在沙箱包内**——不新建独立的 `@away_from/pth-contracts` workspace 包。
- **当前基线（2026-08-15）**：全量测试 204 文件 / 1716 用例绿；`npm run lint`、`npm run build` 干净；
  Node 22 + TS 5.7 + Vitest + Fastify + PostgreSQL + Redis + Docker Compose。
- **已完成且不重复的业务功能**：P3.5 LLM 调用链审计收口、P3.6 debug-case-dispatch 调试闭环、
  concept-design 概念设计交接、`src/pth/kernel/ptc/contract.ts`（PTC 契约注册表）、
  `src/pth/kernel/ptc/runner.ts`（PTC 统一执行缝）、storage 双平面归并（session 迁入
  `src/pth/kernel/storage/session/`）、pth-memory/pth-sandbox 拆分及包内测试归位。
  本计划只做**模块边界与架构整理**，不重做上述业务功能；业务文件在边界迁移中只允许做 import/装配调整。
- **本计划目标**：在不重写公开 HTTP API、不重写数据库 schema（只做幂等增量迁移）、不重做已交付业务功能的前提下，
  把当前 `KernelRuntime` + `DataWorldAccess` + 全局注册表驱动的单体，整理为
  `contracts / tasking / runner / execution / catalog / bootstrap` 模块边界清晰的单体；
  旧 facade 在过渡期内保留，直到调用方迁移完成。

## 现状盘点表（逐份旧计划对比结论）

> 盘点时点：2026-08-15 工作树（`src/pth/**`、`packages/**`、`test/**` 与 git log 390f471 之前状态）。

| 旧计划文件 | 有效步骤（仍应执行） | 已落地 | 过时原因 | 处置 |
|---|---|---|---|---|
| `2026-08-15-pth-modularization-program.md`（总控） | 工程约束：阶段退出门禁、每阶段全量 vitest + lint + build、独立提交、TDD、兼容 facade、release report 思路 | 无（总控本身未被执行）；pth-memory/pth-sandbox 拆分按 `split-design.md` 另一条线完成 | 假设 PTL/PTH 前后端与 HTTP 桥定位（被 ADR 0001 推翻）；以 `@away_from/pth-contracts` 为最终形态（与拆分裁决冲突）；Control/Standard/Full 三产品 Profile 需按新范围重估 | 退役为历史参考；其工程约束吸收进 v2 各阶段 |
| `2026-08-15-pth-contracts-boundaries.md` | gateway route facade（`PthGatewayFacade`）；scoped storage ports；`DataWorldAccess` 收缩为 assembly-only；import boundary checker（`check:pth-boundaries`） | pth-memory/pth-sandbox 拆分；storage 归并（session 平面迁入 `kernel/storage/session/`）；auth 边缘已有 server-side tenant/space（P0-1/P0-3 部分）；`ptc/contract.ts`、`ptc/runner.ts` 存在（属业务功能，非本计划产物） | 核心目标「新建 `packages/pth-contracts`」与拆分裁决冲突；Task 2 把 interpreter/worker-ipc 协议迁出 `pth-sandbox` 与裁决冲突；PTL bridge facade 假设过时 | 有效步骤转入 v2 P0/P1，协议归属调整为「tasking/execution 协议随模块，内核协议留 pth-sandbox」；其余退役 |
| `2026-08-15-pth-tasking-runner.md` | `TaskLease`/CAS（`lease_id`/`lease_generation`/`lease_expires_at` + 原子 claim/complete/reject/cancel）；`TaskControlService`；`TaskDispatcher`（claim→load→run→commit）；`AgentTaskRunner`（只收 lease+work，产出 outcome）；post-commit observers 隔离；flow/trigger 迁入 tasking | 几乎未落地：`TaskLoop` 仍 claim→execute→submit 一体（`kernel/execution/task-loop.ts`）；`tasks` 表仍 `claimed_by`/`claims_count`，无 lease 列；observer 仍内嵌 TaskLoop/event-bus；flow/trigger 仍在 `kernel/execution/task-resolver.ts`/`trigger-engine.ts`。部分落地：P0-3 租户隔离（auth token tenant + workspace 0700 + 私有工作区拷贝） | 「PTL→PTH bridge 保持兼容」的定位表述过时（ADR 0001）；对 Fastify 请求体兼容的强调降级为普通约束 | 核心步骤转入 v2 P0/P1/P2；PTL bridge 兼容表述剔除 |
| `2026-08-15-pth-execution-isolation.md` | `ExecutionPort` + 签名 `ExecutionGrant`（grant 化执行认证）；cancel-ack-release 竞态闭环；stdout/stderr 输出上限与 truncation marker；进程组统一收割；liveness/readiness 拆分；部署渲染/clean build 校验；hostile integration matrix | P0-1 记忆桥 token 化 + auth 豁免取消；P0-2 workload allowlist env + UID/GID 2001；P0-3 私有工作区拷贝 + 租户目录 0700；P0-4 opaque `SandboxLease` + `kernelId` 退役；P0-5 clean build 验证；P1-6 声明式部署网络修复（`2f97600`） | 「移除旧 bridge 而非包装」与当前「token 化 bridge 作为兼容通道」的现状不一致（是否彻底移除改由后续 ADR 决定）；默认 `SANDBOX_SHARED_SECRET` 已由 compose `${VAR:?}` 强制，但 kernel host 仍以共享密钥认证——这属有效未做（grant 化），不是过时 | 未完成的 P1-1~P1-6 与 grant 化转入 v2 P2；已落地的 P0 项只做回归保护，不重复实现 |
| `2026-08-15-pth-catalog-profiles.md` | 不可变 `RuntimeCatalogSnapshot`；注入式 `RoleRoutingPolicy`/`SpaceLookup`；扩展贡献显式化（只支持有真实宿主路径的贡献）；bootstrap 统一装配（API Host / runner Host 同源 catalog） | 无：无 `src/pth/catalog`/`bootstrap`/`profiles`；`ExtRegistry` 仍扫描 + eval + `loadAll`；`worker-cluster`/`space-registry` 全局注册仍由 `assembly.ts` 与 `batch-process.ts` 各自重复执行。部分：装配层已注入角色/空间注册（`setDefaultRoles`/`registerBuiltinSpaces`/`setSpaceLookup`） | Control/Standard/Full 三产品 Profile 是否仍为 PTH 目标需按 ADR 0001 重估（PTH 独立产品化、无容器版本由其他 ADR 管）；PTL bridge/client 处理 capability-disabled 的步骤过时 | catalog 注入与扩展收敛转入 v2 P3；三 Profile 发布级步骤退役，另行 ADR |

## 执行阶段

> 每个子项 = 一个独立提交；子项内先写失败测试再实现（TDD）。
> 每阶段结束运行阶段验收（全量 vitest + lint + build 绿线 + 独立提交），不通过不得进入下一阶段。
> 所有公开 HTTP 路径、请求/响应 JSON、现有数据库 schema（除 P1 幂等增量列）与已支持环境变量保持兼容；
> 破坏性替换必须先提供 deprecated facade 与迁移测试。

---

### P0：契约与边界（gateway facade + 内部契约 + import 边界检查）

- [ ] **P0-1 建立内部契约层 `src/pth/contracts/`（纯类型 + 校验，不新建 workspace 包）**
  - 文件：Create `src/pth/contracts/identity.ts`（`TenantScope`、`WorkspaceRef`）、
    `src/pth/contracts/tasking.ts`（`TaskLease`、`TaskOutcome`、`TaskWorkItem`、`TaskRepository`、`TaskReadModel`、`TaskRunner` ports）、
    `src/pth/contracts/execution.ts`（`ExecutionRequest`、`ExecutionGrant`、`ExecutionResult`、`ExecutionPort`）、
    `src/pth/contracts/index.ts`；Create `test/pth-contracts/contracts.test.ts`。
  - 验收：`npx vitest run test/pth-contracts` 绿；`grep` 证明 contracts 目录不 import `fastify`/`pg`/`redis`/`@away_from/pth-sandbox` 运行时；
    内核 interpreter 契约仍从 `@away_from/pth-sandbox` 导出（遵守拆分裁决）。
- [ ] **P0-2 引入 import 边界检查 `npm run check:pth-boundaries`**
  - 文件：Create `scripts/check-pth-boundaries.ts`、Create `test/pth-architecture/phase-boundaries.test.ts`、Modify `package.json`。
  - 规则：`src/pth/gateway/**` 不 import `KernelRuntime`/`DataWorldAccess`，不访问 `kernel.pool`/`kernel.dataWorld`；
    `tasking`/`runner`/`execution`/`catalog` 模块之间只 import 公共 API，不 import 他方 storage adapter；
    domain 模块不 import `@away_from/pth-sandbox` 运行时 adapter（`impls/kernels/**`、`bootstrap/**`、`main.ts` 除外）。
  - 验收：`npm run check:pth-boundaries` 可运行并输出违规清单；当前违规被测试显式记录为「待修」，后续阶段逐项清零。
- [ ] **P0-3 建立 `PthGatewayFacade` 并迁移 gateway 路由数据访问**
  - 文件：Create `src/pth/application/gateway/pth-gateway-facade.ts`、Create `test/pth-application/pth-gateway-facade.test.ts`；
    Modify `src/pth/gateway/routes-kernel.ts`、`routes-jobs.ts`、`routes-lineage.ts`、`routes-trigger.ts`、
    `src/pth/gateway/server.ts`、`src/pth/kernel/assembly.ts`、`src/pth/main.ts`。
  - 验收：`test/pth-gateway/*` 路由测试绿；facade 暴露 route 形状方法（`publishTask`/`listTasks`/`getTask`/`spawnBatch` 等），
    不含 `pool`/`dataWorld`/`batchManager` 字段；`check:pth-boundaries` 中 gateway 组违规为 0。
- [ ] **P0-4 将 `DataWorldAccess` 收缩为 assembly-only legacy**
  - 文件：Modify `src/pth/kernel/storage/index.ts`（标记 deprecated + 文档说明）、`src/pth/kernel/assembly.ts`、
    `src/pth/kernel/execution/batch-process.ts`；Create `test/pth-architecture/dataworld-boundary.test.ts`。
  - 验收：`createDataWorld()` 保留给 bootstrap/assembly 兼容；gateway/新模块构造器只接收窄 ports；
    测试证明 gateway 不 import `DataWorldAccess`。
- [ ] **P0-5 补内核契约归属回归（守护拆分裁决）**
  - 文件：Create `packages/pth-sandbox/test/interpreter-contract-export.test.ts`；Modify `src/pth/kernel/ptc/runner.ts`
    （如需要，把类型 import 集中到 `src/pth/impls/kernels/` 的 re-export 点）。
  - 验收：测试证明 `Interpreter`/`InterpreterResult`/`WorkerKernel` 契约仍由 `@away_from/pth-sandbox` 稳定导出；
    PTH 业务代码不因契约归属变更而散落 import。
- [ ] **P0-6 阶段验收：全量绿线 + 独立提交**
  - 运行 `npx vitest run`、`npm run lint`、`npm run build` 全绿；`npm run check:pth-boundaries` 记录基线违规清单。
  - 独立提交：只暂存本阶段列出的文件，`git diff --cached --check` 通过后提交。

---

### P1：Task Control 与 Runner 分离（lease/CAS + dispatcher + observers）

- [ ] **P1-1 幂等 schema 迁移：tasks 表新增真实 lease 列**
  - 文件：Modify `src/pth/kernel/storage/schema.ts`、`src/pth/kernel/storage/task-store-pg.ts`；
    Modify `test/pth-kernel-storage/schema.test.ts`、`test/pth-kernel-storage/task-store-pg.test.ts`。
  - SQL：`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_id UUID;`、
    `lease_generation BIGINT NOT NULL DEFAULT 0`、`lease_expires_at TIMESTAMPTZ`；
    索引 `idx_tasks_active_lease (tenant_id, lease_id, lease_generation) WHERE status='claimed'`。
  - 验收：旧数据（无 lease 列值）迁移后仍可读写；`claimed_by`/`claims_count` 保留为诊断字段。
- [ ] **P1-2 新建 `src/pth/tasking/adapters/pg-task-repository.ts`（原子 claim + CAS outcome）**
  - 文件：Create `src/pth/tasking/adapters/pg-task-repository.ts`、Create `test/pth-tasking/pg-task-repository.test.ts`；
    Modify `packages/pth-contracts`（如 P0 未建则 Modify `src/pth/contracts/tasking.ts`）。
  - 验收：并发 claim 只发一个 lease；stale lease/重复 outcome/跨租户读均不生效；
    `recoverExpired` 只清过期 claimed 行且 generation 单调；测试需真实 PostgreSQL fixture。
- [ ] **P1-3 新建 `TaskControlService` / `TaskQueries` / `TaskWorkItemReader`，scope 从 auth 派生**
  - 文件：Create `src/pth/tasking/task-control-service.ts`、`task-queries.ts`、`task-work-item-reader.ts`、
    Create `test/pth-tasking/task-control-service.test.ts`；Modify `src/pth/gateway/auth.ts`、
    `src/pth/application/gateway/pth-gateway-facade.ts`、`src/pth/gateway/routes-kernel.ts`、`routes-jobs.ts`。
  - 验收：`createdBy` 使用服务器端 `scope.principalId`，body 字段不可覆盖；跨租户 `get`/`list` 返回 404/空；
    路由 JSON 形状不变；现有 `test/pth-gateway/kernel-routes.test.ts`、`jobs-routes.test.ts` 绿。
- [ ] **P1-4 新建 `src/pth/runner/`（`AgentTaskRunner` + `TaskWorkspace` + `RunnerConfig`）**
  - 文件：Create `src/pth/runner/agent-task-runner.ts`、`task-workspace.ts`、`runner-config.ts`、
    Create `test/pth-runner/agent-task-runner.test.ts`；Modify `src/pth/kernel/execution/agent-loop.ts`
    （必要时抽取纯执行函数）、`src/pth/kernel/execution/workspace.ts`。
  - 验收：runner 只接收 `{ lease, work }`，返回 `TaskOutcome`，不调用 repository/audit/transcript/notify；
    测试证明 `await kernel.reset()` 完成后才执行；agent 失败/PTC 失败/取消信号产生正确 outcome。
- [ ] **P1-5 新建 `TaskDispatcher` + `TaskOutcomeCommitter`，固定 claim→load→run→commit 序列**
  - 文件：Create `src/pth/tasking/task-dispatcher.ts`、`task-outcome-committer.ts`、
    Create `test/pth-tasking/task-dispatcher.test.ts`。
  - 验收：claim 空则不执行；`commit` 返回 `{ committed:false }` 时 runner 结果不触发任何 observer；
    runner 抛错生成 terminal outcome 且不二次执行；行为测试覆盖 pause/stop/stale work item。
- [ ] **P1-6 将 `TaskLoop` 改为薄兼容 wrapper，保持现有 fork 拓扑**
  - 文件：Modify `src/pth/kernel/execution/task-loop.ts`、`batch-process.ts`、`batch-manager.ts`；
    Modify `test/pth-kernel-execution/task-loop.test.ts`、`test/pth-kernel-execution/batch-process.integration.test.ts`。
  - 验收：`BatchTaskLoop extends TaskLoop` 改为组合 dispatcher；现有 IPC 消息名与 `runOnce()` 布尔语义不变；
    batch fork 集成测试绿。
- [ ] **P1-7 新建 `src/pth/runner/observers/`，observer 只在 committed 后 fan-out**
  - 文件：Create `src/pth/runner/observers/audit-observer.ts`、`transcript-observer.ts`、`activity-observer.ts`、
    `metrics-observer.ts`、`notifier-observer.ts`、`refine-observer.ts`、`optimizer-observer.ts`、
    Create `src/pth/tasking/task-outcome-observers.ts`、Create `test/pth-tasking/task-outcome-observers.test.ts`；
    Modify `src/pth/kernel/execution/event-bus.ts`、`activity-hub.ts`、`src/pth/kernel/storage/audit-store.ts`、`transcript-store.ts`。
  - 验收：`committed:false` 不触发任何 observer；单个 observer 失败不影响其他 observer 与已持久化 outcome；
    audit/transcript 写入带 `tenantId`；慢 refine/optimizer 用有界后台队列，不阻塞下一轮 claim。
- [ ] **P1-8 阶段验收：全量绿线 + 独立提交**
  - 运行 `npx vitest run`、`npm run check:pth-boundaries`（tasking/runner 组违规为 0）、`npm run lint`、`npm run build` 全绿。
  - 独立提交：只暂存本阶段列出的文件，`git diff --cached --check` 通过后提交。

---

### P2：Execution 隔离收口（grant 化 + 取消/释放竞态 + 输出与进程边界）

- [ ] **P2-1 新建 `src/pth/execution/`，实现 `ExecutionPort` + 签名 `ExecutionGrantService`**
  - 文件：Create `src/pth/execution/execution-service.ts`、`authorization/execution-grant-service.ts`、
    `authorization/grant-key-provider.ts`、`adapters/sandbox-execution-adapter.ts`、`index.ts`、
    Create `test/pth-execution/execution-grant-service.test.ts`、`sandbox-execution-adapter.test.ts`；
    Modify `src/pth/contracts/execution.ts`（若 P0 已建）。
  - 验收：grant 绑定 lease/scope/workspace/language/capability/generation/deadline，可验证过期、重放、generation 不匹配；
    签名密钥由 bootstrap 注入，无默认 `sandbox-dev-secret`。
- [ ] **P2-2 sandbox `acquire` 改为 grant 校验，退役执行认证共享密钥**
  - 文件：Create `packages/pth-sandbox/src/authorization/grant-verifier.ts`、
    Create `packages/pth-sandbox/test/grant-verifier.test.ts`；Modify `packages/pth-sandbox/src/kernel-host.ts`、
    `packages/pth-sandbox/src/sandbox-kernel.ts`、`packages/pth-sandbox/test/sandbox-kernel-host.test.ts`。
  - 验收：`/kernel/acquire` 接受 grant 并返回 opaque `SandboxLease`；`SANDBOX_SHARED_SECRET` 不再作为 kernel 执行认证
    （仅可保留为 controller 内部服务间认证）；malformed/expired/wrong-key/wrong-tenant grant 一律拒绝。
- [ ] **P2-3 取消/释放竞态闭环：cancel → ack → release**
  - 文件：Modify `packages/pth-sandbox/src/kernel-host.ts`、`kernel-pool.ts`、`sandbox-kernel.ts`、`exec-api.ts`；
    Create `packages/pth-sandbox/test/cancel-release-race.test.ts`。
  - 验收：client abort 后必须等 controller 确认执行停止才 release；ack 不可达时 entry 进入 cancelling/disposed，
    绝不乐观回 idle；transport deadline = min(grant deadline, 请求 timeout) + 清理余量，不再用历史固定 10 秒。
- [ ] **P2-4 stdout/stderr 输出上限 + 统一进程组收割**
  - 文件：Modify `packages/pth-sandbox/src/exec-api.ts`、`py-kernel.ts`、`bash-kernel.ts`、`compiled-kernel.ts`、`gdb-mi.ts`；
    Create `packages/pth-sandbox/test/output-bound.test.ts`（或并入 `cancel-release-race.test.ts`）。
  - 验收：输出按字节上限截断并返回 contracts `truncated` 标记；超限即杀进程组；
    Python/Bash/C/gdb 的 timeout/abort 均 kill + wait + reap 整棵进程树，无残留后代。
- [ ] **P2-5 记忆桥收敛为 grant-bound `KnowledgeBroker`（保留 token 化 HTTP 桥为兼容通道）**
  - 文件：Create `src/pth/execution/knowledge-broker.ts`、`adapters/pth-knowledge-broker.ts`、
    Create `test/pth-execution/knowledge-broker.test.ts`；Modify `src/pth/gateway/routes-kernel.ts`、
    `packages/pth-sandbox/src/kernel-host.ts`（memory-bridge 转发路径）。
  - 验收：执行期知识访问必须带 grant 且具备 `memory.read` capability；body 自报 `space` 不可授权；
    未授权访问返回 403/空；现有 token 化 bridge 测试继续绿（兼容通道）。
- [ ] **P2-6 liveness/readiness 拆分 + `scripts/check-sandbox-env.sh` 路径修正**
  - 文件：Modify `packages/pth-sandbox/src/exec-api.ts`、`kernel-host.ts`、`deploy/docker-compose.yaml`；
    Modify `scripts/check-sandbox-env.sh`（扫描 `packages/pth-sandbox/Dockerfile.sandbox`，缺文件必须失败）。
  - 验收：`/health` 只做 liveness；新增 readiness 检查共享密钥/内核池/必要目录；
    compose healthcheck 指向正确端点；`check-sandbox-env.sh` 在目标 Dockerfile 缺失时非零退出。
- [ ] **P2-7 阶段验收：全量绿线 + 独立提交**
  - 运行 `npx vitest run`、`npm run lint`、`npm run build` 全绿；
    `docker compose -f deploy/docker-compose.yaml config` 通过；sandbox clean build 冒烟通过。
  - 独立提交：只暂存本阶段列出的文件，`git diff --cached --check` 通过后提交。

---

### P3：Catalog 注入与扩展收敛（模块边界整理，不发布三产品 Profile）

- [ ] **P3-1 新建 `src/pth/catalog/`：不可变 `RuntimeCatalogSnapshot` + builder**
  - 文件：Create `src/pth/catalog/runtime-catalog.ts`、`catalog-builder.ts`、`capability-policy.ts`、
    Create `test/pth-catalog/runtime-catalog.test.ts`。
  - 验收：snapshot 冻结后不可变（roles/spaces/extension allowlist/capability policy）；
    builder 在 `build()` 后拒绝修改；重复 ID/非法 capability/非法 policy fail closed；
    排序确定，同 manifest 构建结果一致。
- [ ] **P3-2 角色/空间全局注册改为 catalog 注入**
  - 文件：Create `src/pth/catalog/adapters/builtin-catalog-contributions.ts`、`role-routing-policy.ts`、`space-lookup.ts`；
    Modify `src/pth/kernel/execution/worker-cluster.ts`、`space-registry.ts`、`tag-registry.ts`、`role-router.ts`、
    `src/pth/impls/roles/default-roles.ts`、`src/pth/impls/spaces/builtin-spaces.ts`、
    `src/pth/kernel/assembly.ts`、`src/pth/kernel/execution/batch-process.ts`。
  - 验收：`RoleRoutingPolicy`/`SpaceLookup` 读取注入的 snapshot；`assembly.ts` 与 `batch-process.ts`
    由同一 manifest 构建出等价 catalog（测试断言角色/空间/扩展键一致）；
    旧全局 getter 仅作 deprecated 兼容出口，新生产代码零调用。
- [ ] **P3-3 扩展贡献显式化：`ExtRegistry` 只支持有真实宿主路径的贡献**
  - 文件：Create `src/pth/catalog/extensions/contribution-schema.ts`、`extension-loader.ts`、`extension-context.ts`、`extension-policy.ts`；
    Modify `src/pth/kernel/extensions/ext-registry.ts`、`src/pth/kernel/interpreter/ext-capability.ts`、
    `scripts/ext-check.ts`；Modify `test/pth-kernel-execution/ext-registry.test.ts` 等既有扩展测试。
  - 验收：仅 roles/spaces/observers/capabilityPolicies 等有宿主实现的贡献可进 catalog；
    不支持的 `tools`/`events`/`kernels`/`debugAdapters`/`onStartup` 声明被拒绝并给出诊断；
    `ext-check.ts` 区分 PTH 插件 / 外来工具目录 / 坏插件，坏插件失败、外来目录不报错。
- [ ] **P3-4 新建 `src/pth/bootstrap/`：统一装配入口（单 Host + module manifest，不发布三产品 Profile）**
  - 文件：Create `src/pth/bootstrap/pth-host.ts`、`module-manifest.ts`、`bootstrap-config.ts`；
    Modify `src/pth/kernel/assembly.ts`、`src/pth/main.ts`、`src/pth/kernel/execution/batch-process.ts`。
  - 验收：main 与 batch-process 共用同一 manifest/catalog 构建路径；缺依赖、未知 module、非法 policy 在监听端口前 fail closed；
    `createKernelRuntime()` 作为 deprecated 兼容入口保留；**不引入** `PTH_PROFILE=control|standard|full` 产品选择。
- [ ] **P3-5 边界检查覆盖新模块目录并纳入 CI 语义**
  - 文件：Modify `scripts/check-pth-boundaries.ts`、`package.json`；Create `test/pth-architecture/final-boundaries.test.ts`。
  - 验收：`npm run check:pth-boundaries` 对 `contracts/tasking/runner/execution/catalog/bootstrap/gateway` 全量执行，
    违规为 0；测试证明 bootstrap 可组装 adapters，业务模块不可 import 他方 storage adapter。
- [ ] **P3-6 阶段验收：全量绿线 + 独立提交 + 旧计划 Retirement notice**
  - 运行 `npx vitest run`、`npm run lint`、`npm run build`、`npm run check:pth-boundaries` 全绿。
  - 独立提交：只暂存本阶段列出的文件与旧计划 Retirement notice 标注，`git diff --cached --check` 通过后提交。

---

## 每阶段验收统一要求（不通过不得进入下一阶段）

- [ ] 全量 `npx vitest run` 绿（基线 1716 用例；新增/迁移测试计入后不得有回退）。
- [ ] `npm run lint` 绿。
- [ ] `npm run build` 绿。
- [ ] 独立提交：只暂存该阶段明确列出的文件；`git diff --cached --check` 通过；提交信息按阶段命名
  （例如 `refactor(pth): P0 contracts and gateway facade`）。

## 不在本计划内（由其他 ADR / 计划管理）

- **PTL 前端与 PTL 平台改造**：PTL 的 pi 环境共存、模板隔离、并行管理等由 PTL 侧计划管。
- **PTH 专属前端**：ADR 0001 后续方向，需独立产品/设计 ADR。
- **无容器版本 PTH**：ADR 0001 后续方向，需独立 ADR。
- **进一步分仓**：`split-design.md` 已裁决单仓 workspace 包；是否拆为多仓由未来 ADR 管。
- **Control/Standard/Full 三产品 Profile 发布**：PTH 产品化形态需按 ADR 0001 重估，另行 ADR；
  v2 只做单 Host + module manifest 的边界整理。
- **已完成的业务功能**：P3.5 LLM 调用链审计、P3.6 debug-case-dispatch、concept-design、
  `ptc/contract.ts`、`ptc/runner.ts`、B4 skills、storage 归并、pth-memory/pth-sandbox 拆分内容
  ——本计划不重做、不扩围，只在这些文件跨越模块边界时做 import/装配调整。
- **数据库 schema 大改**：除 P1-1 幂等 lease 列外，不做表结构重设计。
- **Docker/mailbox/dev-container 包内业务整理**：各包按包内 TODO 独立推进。

## 计划完成后：旧五份计划处理

- [ ] 在五份旧计划文件顶部统一添加 Retirement notice（不删除正文）：
  > **Retirement notice（2026-08-15）**：本计划已由 `2026-08-15-pth-modularization-v2.md` 取代，
  > 仅保留为历史参考，不再作为执行依据。
- [ ] 五份文件保留在 `docs/superpowers/plans/` 下，git 历史完整保留。
- [ ] 本 v2 计划成为唯一执行入口；后续如需新增模块化工作，先更新本文件或另立新计划。
