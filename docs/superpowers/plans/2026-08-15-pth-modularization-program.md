# PTH 模块化与产品 Profile 迁移总控 Implementation Plan（参考计划）

> **计划状态：参考计划（Reference-only）** —— 本文件及其四个子计划仅作架构与实施思路参考，当前不作为执行依据；实施前必须重新评审可行性并另建可执行计划。
>
> **For agentic workers:** 请勿直接按本计划及其子计划的 checkbox 开工。若后续决定实施，需先转为可执行计划，再使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。

**Goal:** 在不维护平行产品分支、不重写公开 HTTP API 或数据库 schema 的前提下，把 PTH 从 `KernelRuntime`/`DataWorldAccess`/全局注册表驱动的系统，迁移为由 PTH Host 组合的模块化单体，并交付 Control、Standard、Full 三个可验证的 Profile。

**Architecture:** 先建立独立于 Fastify、PostgreSQL、Pi SDK 与 sandbox 的 contracts/ports；随后把任务状态机与任务执行分开；再把语言执行收敛到持有短期 `ExecutionGrant` 的 adapter；最后以不可变 catalog 和显式 manifest 组合 Host。迁移期间保留 facade，使既有 gateway、PTL bridge、数据库与环境变量兼容。详情以已批准的 [设计规格](../specs/2026-08-15-pth-modular-profiles-design.md) 和 [术语表](../../../CONTEXT.md) 为准。

**Tech Stack:** Node.js 22、TypeScript 5.7、npm workspaces、Vitest、Fastify、PostgreSQL、Redis、Docker Compose、Pi SDK。

## Global Constraints

- 本计划按阶段实施；任何阶段不通过退出门禁，不得开始后续阶段。
- 仅 `bootstrap` 可以同时选择 module 与 adapter；业务模块不得直接 import `pg.Pool`、Fastify 实例、`child_process` 或具体 sandbox client。
- 新建 workspace package 只承载跨 Profile 的稳定协议。不得把每个目录或一次性 helper 包装为 package。
- 运行在同一 Host 内的模块保持函数调用；在 runner 被明确拆为独立进程前，不用内部 HTTP/RPC 代替函数调用。
- 公开 HTTP 请求/响应、现有数据库 schema、PTL→PTH bridge 和已支持的环境变量在每个阶段都保持兼容；破坏性替换必须先提供 deprecated facade 与迁移测试。
- `TenantScope`、`TaskLease`、`ExecutionGrant`、`TaskOutcome`、`DomainEvent` 是跨边界的必需上下文。禁止依赖环境变量、cwd、可预测 ID 或请求体中的 `space` 推断授权。
- 执行不可信任务的进程或容器不得读取 Host 级数据库凭据、sandbox controller 凭据、toolstore 写权限或其他租户工作区。
- 每项实现先添加失败测试，再写最小实现；每个任务单独提交，提交前只暂存该任务明确列出的文件。当前工作树中与本计划无关的迁移改动必须保留且不得暂存。
- 每一阶段均运行对应的定向 Vitest、`npm run lint`、`npm run build`；交付前还必须运行 clean Docker build、Profile 启动矩阵和 `npm pack --dry-run`。

---

## Work-package map and ordering

| 阶段 | 计划 | 前置条件 | 交付物 | 退出门禁 |
|---|---|---|---|---|
| 0–1 | [Contracts 与边界](2026-08-15-pth-contracts-boundaries.md) | 当前 API/lifecycle 基线可运行 | `@away_from/pth-contracts`、ports、Kernel facade、依赖守卫 | PTH 领域代码不再从 sandbox package 导入执行协议 |
| 2 | [Task Control 与 Runner](2026-08-15-pth-tasking-runner.md) | contracts facade 已合入 | `TaskControlService`、`TaskRunnerService`、Outcome observers | `TaskLoop` 不再读取万能 `dataWorld`、raw env 或全局 bus |
| 3 | [Execution 与 sandbox 隔离](2026-08-15-pth-execution-isolation.md) | lease/outcome 已稳定 | `ExecutionPort`、grant、lease、workspace broker、隔离部署 | 所有 sandbox P0 负向安全测试通过 |
| 4–5 | [Catalog 与 Profiles](2026-08-15-pth-catalog-profiles.md) | runner/execution 的 ports 已固定 | immutable catalog、extension contribution、Host manifest | 三个 Profile 都能 clean build、启动并通过 smoke test |

下游计划只能引用上表所列的公开产物，不能临时 import 上游内部实现。执行顺序是严格的：Contracts → Tasking/Runner → Execution → Catalog/Profile。`session` 和 `knowledge` 在该序列中只通过已有 facade 逐步接入；它们不阻塞 Control/Standard 的最小成形，但 Full 发布前必须完成其 Profile wiring。

## Task 1: Freeze a reproducible baseline before structural changes

**Files:**

- Modify: `docs/superpowers/specs/2026-08-15-pth-modular-profiles-design.md` only when a reviewed ADR changes a decision
- Create: `docs/superpowers/explorations/2026-08-15-pth-modularization-baseline.md`
- Test: existing `test/pth-gateway/kernel-routes.test.ts`, `test/pth-kernel-assembly/assembly.test.ts`, `test/pth-kernel-execution/task-loop.test.ts`, `packages/pth-sandbox/test/sandbox-kernel-host.test.ts`

- [ ] **Step 1: record the executable baseline**

Run the four targeted suites, `npm run lint`, `npm run build`, and `npm pack --dry-run`. Record exact commands, platform, relevant environment values, passing/failing suites, and any pre-existing failures in the baseline document. Do not normalize a pre-existing failure away.

- [ ] **Step 2: capture public compatibility samples**

Save representative request/response fixtures for kernel routes, task publish/claim/submit, PTL bridge calls, and sandbox acquire/execute/release. Fixtures must redact credentials and use synthetic tenant/workspace identifiers.

- [ ] **Step 3: add regression harnesses before refactoring**

Add snapshot or contract tests around the saved public behavior. New harnesses may call existing facades but must not assert private field layout such as `KernelRuntime.pool`.

- [ ] **Step 4: commit the baseline independently**

```bash
git add -- docs/superpowers/explorations/2026-08-15-pth-modularization-baseline.md test/pth-gateway test/pth-kernel-assembly test/pth-kernel-execution packages/pth-sandbox/test
git diff --cached --check
git commit -m "test(pth): freeze modularization compatibility baseline"
```

## Task 2: Establish phase gates and ownership

**Files:**

- Create: `docs/pth/modularization-release-gates.md`
- Modify: `docs/pth/development.md`
- Modify: `.github/workflows/ci.yml` if this repository uses it; otherwise modify the existing CI entrypoint discovered during implementation

- [ ] **Step 1: make the phase gates machine-readable**

Define named scripts or CI jobs for `contracts`, `tasking-runner`, `execution-isolation`, and `profiles`. Each must name its focused test command, typecheck, build and integration prerequisites.

- [ ] **Step 2: define responsibility boundaries**

Assign code ownership by module rather than legacy directory. At minimum document owners/reviewers for contracts, tasking, runner, execution, catalog, operations, bootstrap, and deployment/security review.

- [ ] **Step 3: specify rollback behavior**

For every phase, document the feature flag or compatibility facade used to return to the prior implementation without schema reversal. A release cannot depend on a flag that gives unsafe sandbox behavior a path back to production.

- [ ] **Step 4: run the baseline after adding gates**

Run the baseline matrix from Task 1. Expected result: no API/runtime behavior change; only new validation metadata and CI wiring exist.

## Task 3: Execute the Contracts and boundary work package

**Plan:** [2026-08-15-pth-contracts-boundaries.md](2026-08-15-pth-contracts-boundaries.md)

- [ ] **Step 1: complete every unchecked task in the work package**

Do not start Task Control extraction until its compatibility and import-boundary tests pass.

- [ ] **Step 2: run the Phase 1 exit matrix**

```bash
npx vitest run test/pth-kernel-assembly test/pth-gateway packages/pth-contracts/test packages/pth-sandbox/test
npm run lint
npm run build
```

- [ ] **Step 3: review the boundary report**

Verify that no production PTH module imports execution domain types from `@away_from/pth-sandbox`, and that gateway code only uses the Kernel facade / module query-command APIs.

## Task 4: Execute the Task Control and Runner work package

**Plan:** [2026-08-15-pth-tasking-runner.md](2026-08-15-pth-tasking-runner.md)

- [ ] **Step 1: complete Task Control before changing runner process topology**

Task state transitions remain in `tasking`; `runner` only receives `TaskLease` and produces `TaskOutcome`. Preserve current forked batch topology until that contract is proven.

- [ ] **Step 2: run concurrency and recovery checks**

Use isolated PostgreSQL data to exercise simultaneous claim, stale-lease recovery, duplicate outcome, cancellation, retry and process crash/restart scenarios.

- [ ] **Step 3: verify observer isolation**

Force audit, notification and refinement observers to fail independently. Expected result: the persisted task outcome remains correct and is not submitted twice.

## Task 5: Execute the Execution and sandbox-isolation work package

**Plan:** [2026-08-15-pth-execution-isolation.md](2026-08-15-pth-execution-isolation.md)

- [ ] **Step 1: close the P0 security findings before enabling Profiles in production**

No production rollout is allowed while a shared sandbox secret, predictable kernel identifier, unscoped memory bridge, global workspace mount, or known-broken clean image path remains.

- [ ] **Step 2: run the hostile-input test matrix**

Exercise cross-tenant workspace reads, expired/replayed grants, generation mismatch, cancellation race, controller-credential access from workload code, arbitrary memory-bridge requests, output flooding, child process escape and lease reuse.

- [ ] **Step 3: verify clean deployment artifacts**

Build sandbox and PTH images from a clean checkout without local `dist`; render compose/declarative deployment paths; confirm PTH and sandbox share only the networks and volumes explicitly required by the selected Profile.

## Task 6: Execute the Catalog and Profiles work package

**Plan:** [2026-08-15-pth-catalog-profiles.md](2026-08-15-pth-catalog-profiles.md)

- [ ] **Step 1: complete catalog snapshot migration**

Remove runtime registry globals only after every embedded and child runner builds a catalog from the same manifest.

- [ ] **Step 2: run the three-profile matrix**

Start Control, Standard and Full from clean configuration. For each, test complete dependencies, a deliberately missing required adapter, disabled extension contribution, health endpoint, graceful shutdown and profile-specific forbidden capability.

- [ ] **Step 3: perform deployment migration rehearsal**

Upgrade a disposable instance using the previous default configuration. Expected result: it maps to Full (or the explicitly documented compatibility profile), produces clear migration diagnostics, and preserves supported API/database behavior.

## Task 7: Release readiness and optional runner split decision

**Files:**

- Create: `docs/pth/modularization-release-report.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/pth/development.md`
- Modify: `README.md` only after Profile behavior is production-ready

- [ ] **Step 1: produce evidence-based release report**

List all module versions, Profile manifests, test outputs, Docker image digests, compatibility fixtures and unresolved risks. Link to the security remediation tests rather than declaring them complete without evidence.

- [ ] **Step 2: decide on the optional `pth-runner` process split**

Evaluate it only after Standard/Full contracts, leases, outcomes, observer delivery and operational telemetry are stable. Record a separate ADR; a process split is not a prerequisite for this plan to succeed.

- [ ] **Step 3: final release commands**

```bash
npm test
npm run lint
npm run build
npm pack --dry-run
docker compose -f deploy/docker-compose.yaml config
```

- [ ] **Step 4: tag the release only after all gates pass**

The release report must identify which Profile is the default, whether private-deployment policy overlays were exercised, and whether any compatibility facade remains scheduled for removal.

## Final acceptance criteria

- Control, Standard and Full are explicit static manifests rather than branches, arbitrary runtime plugin sets or source deletions.
- PTH domain protocols come from `@away_from/pth-contracts`; `@away_from/pth-sandbox` is an execution adapter implementation.
- Task Control owns task state transitions; Runner owns leased-work execution; Execution owns language execution; observers cannot alter an already-persisted outcome.
- Tenant, workspace, lease and execution authorization are explicit at every cross-module boundary.
- Sandbox P0 findings are demonstrably remediated with negative tests and clean-image deployment evidence.
- No untouched user migration file is included in an implementation commit for this program.
