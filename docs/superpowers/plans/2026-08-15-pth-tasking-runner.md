# PTH Task Control 与 Runner 分离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将任务状态机、租约、发布/查询、flow 与 trigger 收敛到 `tasking`，将 leased task 的 Agent/PTC 执行与工作区编排收敛到 `runner`，使 runner 只接收 `TaskLease` + `TaskWorkItem` 并产生 `TaskOutcome`，而不再直接修改任务状态、持有 `DataWorldAccess` 或调用 Fastify。

**Architecture:** Task Control 通过 scoped repository 原子发放 lease、加载 work item、提交 outcome；Task Dispatcher 把 work item 交给 runner；Runner 用注入的 capabilities/config/workspace adapter 执行 AgentLoop/PTC，并返回 outcome；只在 outcome 被成功 CAS 持久化后触发 audit、transcript、metrics、activity、notify、refine、optimizer observers。现有 `TaskLoop`、`BatchTaskLoop`、`TaskResolver` 和 `TriggerEngine` 在迁移中保留为 thin compatibility entrypoints，直到所有调用方完成迁移。

**Tech Stack:** Node.js 22、TypeScript 5.7、PostgreSQL (`FOR UPDATE SKIP LOCKED`)、Vitest、child_process fork、Fastify、PTH Agent/PTC runtime。

## Global Constraints

- 前置条件：完成 [Contracts 与边界迁移计划](2026-08-15-pth-contracts-boundaries.md) 的所有 Phase 1 退出门禁。
- 不得把当前 `Task`、`claimed_by` 或 `claims_count` 包装成已安全的 `TaskLease`。真实 lease 必须有随机 `lease_id`、单调 `lease_generation`、过期时间和基于三者的 CAS 写入。
- `tasks.tenant_id`、`transcripts.tenant_id`、`audit_log.tenant_id` 是真实数据边界。所有外部 command/query 都必须从服务器端 `TenantScope` 派生 tenant 与 principal，不能信任 body 中的 `createdBy`、task ID、role 或 space 作为授权依据。
- `TaskDispatcher` 不能 import AgentLoop、WorkerKernel、Fastify、PG adapter 或 `DataWorldAccess`；`AgentTaskRunner` 不能 import task repository、task command/query、Fastify 或 gateway；boundary tests 必须对此做静态检查。
- 当前 forked batch topology 保持到本计划最后一个任务；不要把进程拆分当作 Task Control/Runner 分离的前置条件。
- 一旦 `TaskOutcomeCommitter.commit()` 返回 `committed: false`，任何 observer 都不得执行。observer 失败不得把已持久化的 completed outcome 改写成 rejected。
- runner 的配置由 bootstrap 注入；它不得直接读取 `PTH_AGENT_MODE`、`PTH_ASP_MODE`、通知 URL、数据库 URL 或原始 process environment。
- 保持现有 URI、请求 JSON 和响应 JSON 兼容。新增安全 scope 不得造成跨 tenant 数据泄漏；兼容层只能收窄访问、不能扩张访问。
- 每个任务先写失败测试，定向测试通过后单独提交；不得把当前无关的 dev-container/mailbox/deploy 迁移改动加入任何提交。

---

## Task 1: Persist tenant-scoped task leases and CAS outcomes

**Files:**

- Create: `src/pth/tasking/adapters/pg-task-repository.ts`
- Create: `src/pth/tasking/adapters/pg-task-read-model.ts`
- Create: `test/pth-tasking/pg-task-repository.test.ts`
- Modify: `src/pth/kernel/storage/schema.ts`
- Modify: `src/pth/kernel/storage/task-store-pg.ts`
- Modify: `src/pth/kernel/storage/index.ts`
- Modify: `packages/pth-contracts/src/tasking.ts`
- Modify: `packages/pth-contracts/src/ports.ts`
- Modify: `test/pth-kernel-storage/task-store-pg.test.ts`
- Modify: `test/pth-kernel-storage/claim-reaper.test.ts`

**Interfaces:**

- Produces: `TaskLeaseRepository`, `TaskCommands`, `TaskQueries`, `TaskWorkItemReader`, `TaskOutcomeCommitter` and PG adapters.
- Preserves: legacy `TaskStore` as a deprecated facade over the new adapter until its callers migrate.

- [ ] **Step 1: write failing lease and tenant-isolation tests**

```ts
// test/pth-tasking/pg-task-repository.test.ts
import { describe, expect, it } from "vitest";
import { PgTaskRepository } from "../../src/pth/tasking/adapters/pg-task-repository.js";

const tenantA = { tenantId: "tenant-a", principalId: "worker:a", roles: ["developer"], traceId: "trace-a" };
const tenantB = { tenantId: "tenant-b", principalId: "worker:b", roles: ["developer"], traceId: "trace-b" };

describe("PgTaskRepository leases", () => {
  it("issues one random lease for concurrent claims and makes the old generation stale", async () => {
    const repository = await createTestTaskRepository();
    const task = await repository.publish(tenantA, { title: "compile", text: "x", createdBy: "ignored-by-adapter" });
    const [first, second] = await Promise.all([
      repository.claim(tenantA, { workerId: "worker-a", roleId: "developer", limit: 1, ttlMs: 60_000 }),
      repository.claim(tenantA, { workerId: "worker-b", roleId: "developer", limit: 1, ttlMs: 60_000 }),
    ]);
    expect(first.length + second.length).toBe(1);

    const lease = [...first, ...second][0]!;
    await repository.recoverExpired(new Date(lease.deadlineAt));
    expect(await repository.complete(tenantA, completedOutcome(lease))).toEqual({ committed: false });
    expect((await repository.get(tenantA, task.id))?.status).toBe("pending");
  });

  it("does not expose tenant A tasks through tenant B commands or reads", async () => {
    const repository = await createTestTaskRepository();
    const task = await repository.publish(tenantA, { title: "private", text: "x", createdBy: "ignored" });
    expect(await repository.get(tenantB, task.id)).toBeNull();
    expect(await repository.list(tenantB, {})).toEqual([]);
  });
});
```

Add cases for duplicate outcome commit, a stale `leaseId`, a stale generation with the same `claimed_by`, cancelled transition and explicitly retryable rejection/requeue.

- [ ] **Step 2: run the test to establish the initial failure**

Run: `npx vitest run test/pth-tasking/pg-task-repository.test.ts`

Expected: FAIL because the tasking PG adapter and persisted lease columns do not exist.

- [ ] **Step 3: add an idempotent schema migration and scoped records**

Extend the schema in a migration-safe manner. The target columns and index are:

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tasks_active_lease
  ON tasks (tenant_id, lease_id, lease_generation)
  WHERE status = 'claimed';
```

Expand the task status constraint to include `cancelled`, retaining existing values. Do this through a named, idempotent constraint migration after inspecting its actual generated name on a populated database; do not rely on dropping an unknown constraint by guesswork. Preserve old rows: `lease_id` remains null until a post-migration claim, and `lease_generation` starts at zero.

Expand the mapped task record with `tenantId`, `leaseId`, `leaseGeneration`, and `leaseExpiresAt`. `WorkspaceRef` is derived from `tenantId` + task identity, not from a host path. `createdBy` is persisted as the server-derived `scope.principalId` for external requests; retain the old field in compatibility input only.

- [ ] **Step 4: implement atomic claim and outcome CAS**

Use a single transaction to lock a candidate task, derive the new generation, generate a UUID in the trusted Node PG adapter, set deadline, and return a serializable lease:

```ts
export interface TaskLeaseRepository {
  claim(scope: TenantScope, request: ClaimTasks): Promise<readonly TaskLease[]>;
  complete(scope: TenantScope, outcome: TaskOutcome): Promise<{ committed: boolean }>;
  reject(scope: TenantScope, outcome: TaskOutcome): Promise<{ committed: boolean }>;
  cancel(scope: TenantScope, taskId: string): Promise<{ committed: boolean }>;
  recoverExpired(now: Date): Promise<number>;
}

const result = await client.query(
  `UPDATE tasks
   SET status = 'completed', completed_at = now(), lease_expires_at = NULL, updated_at = now()
   WHERE id = $1
     AND tenant_id = $2
     AND lease_id = $3
     AND lease_generation = $4
     AND status = 'claimed'
   RETURNING id`,
  [outcome.lease.taskId, scope.tenantId, outcome.lease.leaseId, outcome.lease.generation],
);
```

`claimed_by` remains for diagnostics only. A stale or duplicate outcome returns `{ committed: false }`, never overwrites another worker's claim, and never raises a retry that could double-execute side effects. The reaper clears `lease_id`/expiry only for expired claimed rows and leaves generation monotonic. Explicit `retryable` rejection returns the task to `pending`; terminal rejection becomes `rejected`.

- [ ] **Step 5: keep the legacy store behavior through an adapter**

Implement the existing `TaskStore` methods as calls into the scoped adapter with an explicit legacy/system scope only where current internal callers require it. Do not make the facade a way for HTTP routes to bypass scope. Mark it deprecated and add a test that a public route cannot construct it.

- [ ] **Step 6: run storage and lease regression tests**

```bash
npx vitest run test/pth-tasking/pg-task-repository.test.ts test/pth-kernel-storage/task-store-pg.test.ts test/pth-kernel-storage/claim-reaper.test.ts
npm run lint
```

Expected: concurrent claim, cross-tenant read, stale lease, duplicate outcome and cancellation tests pass against real PostgreSQL integration fixtures.

- [ ] **Step 7: commit the lease foundation**

```bash
git add -- packages/pth-contracts/src/tasking.ts packages/pth-contracts/src/ports.ts src/pth/tasking/adapters src/pth/kernel/storage/schema.ts src/pth/kernel/storage/task-store-pg.ts src/pth/kernel/storage/index.ts test/pth-tasking test/pth-kernel-storage
git diff --cached --check
git commit -m "feat(tasking): persist tenant-scoped task leases"
```

## Task 2: Put task commands and queries behind route-safe APIs

**Files:**

- Create: `src/pth/tasking/task-control-service.ts`
- Create: `src/pth/tasking/task-work-item-reader.ts`
- Create: `src/pth/tasking/task-queries.ts`
- Create: `test/pth-tasking/task-control-service.test.ts`
- Modify: `src/pth/gateway/auth.ts`
- Modify: `src/pth/application/gateway/pth-gateway-facade.ts`
- Modify: `src/pth/gateway/routes-kernel.ts`
- Modify: `src/pth/gateway/routes-jobs.ts`
- Modify: `src/pth/kernel/assembly.ts`
- Modify: `test/pth-gateway/kernel-routes.test.ts`
- Modify: `test/pth-gateway/jobs-routes.test.ts`

**Interfaces:**

- Produces: `TaskCommands`, `TaskQueries`, `TaskWorkItemReader` implementation and gateway API methods.
- Consumes: scoped PG adapter from Task 1 and route-derived `TenantScope`.

- [ ] **Step 1: write failing service and gateway contract tests**

```ts
// test/pth-tasking/task-control-service.test.ts
import { describe, expect, it, vi } from "vitest";
import { TaskControlService } from "../../src/pth/tasking/task-control-service.js";

it("uses the authenticated principal instead of client-createdBy", async () => {
  const publish = vi.fn().mockResolvedValue({ id: "task-1", status: "pending" });
  const service = new TaskControlService({ repository: { publish } } as never);
  await service.publish(
    { tenantId: "tenant-a", principalId: "user:42", roles: [], traceId: "trace" },
    { title: "x", text: "y", createdBy: "forged-client-value" },
  );
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ principalId: "user:42" }), expect.objectContaining({ createdBy: "user:42" }));
});
```

In the route tests, provide only a facade with commands/queries. Deliberately omit `pool` and `dataWorld`; a route must still publish, list, fetch or reject a cross-tenant request with its current HTTP shape.

- [ ] **Step 2: verify failure**

Run: `npx vitest run test/pth-tasking/task-control-service.test.ts test/pth-gateway/kernel-routes.test.ts test/pth-gateway/jobs-routes.test.ts`

Expected: FAIL because current routes use `KernelRuntime.dataWorld`, `KernelRuntime.pool` and body-provided identity.

- [ ] **Step 3: derive tenant scope at the auth edge**

Extend the current auth context to provide a stable opaque `principalId`; use the authenticated identity/token claims rather than a request body field. For unconfigured local-development auth, the server may provide a documented fixed development principal only when an explicit development mode is enabled. No production fallback may silently map all callers to the same principal.

```ts
export interface TaskCommands {
  publish(scope: TenantScope, input: PublishTask): Promise<TaskRecord>;
  cancel(scope: TenantScope, taskId: string): Promise<{ committed: boolean }>;
}

export interface TaskQueries {
  get(scope: TenantScope, taskId: string): Promise<TaskRecord | null>;
  list(scope: TenantScope, filter: TaskListFilter): Promise<readonly TaskSummary[]>;
  getJob(scope: TenantScope, jobId: string): Promise<JobRecord | null>;
}
```

- [ ] **Step 4: migrate kernel and jobs routes with compatibility translations**

Maintain current paths and JSON fields, but route `POST /kernel/tasks`, task templates, `GET /kernel/tasks`, `GET /kernel/tasks/:id`, job creation/list/detail and their template paths through `TaskCommands`/`TaskQueries`. Cross-tenant `get` and job reads return the same 404 shape as absent records. Keep current validation (title/text size, template parameters, flow compatibility) in the route-to-command translator or command validation layer, not in a raw PG query.

- [ ] **Step 5: expose work only through a scoped reader**

`TaskWorkItemReader.load(lease)` must use the lease's task ID, tenant, lease ID and generation. It returns `null` for a stale lease or scope mismatch. The runner receives the returned immutable work item and never executes a task object supplied directly by a route or IPC message.

- [ ] **Step 6: run focused API and service tests**

```bash
npx vitest run test/pth-tasking/task-control-service.test.ts test/pth-gateway/kernel-routes.test.ts test/pth-gateway/jobs-routes.test.ts
npm run check:pth-boundaries
npm run lint
```

- [ ] **Step 7: commit the route boundary**

```bash
git add -- src/pth/tasking/task-control-service.ts src/pth/tasking/task-work-item-reader.ts src/pth/tasking/task-queries.ts src/pth/gateway/auth.ts src/pth/application/gateway/pth-gateway-facade.ts src/pth/gateway/routes-kernel.ts src/pth/gateway/routes-jobs.ts src/pth/kernel/assembly.ts test/pth-tasking test/pth-gateway
git diff --cached --check
git commit -m "feat(tasking): introduce task command and query facades"
```

## Task 3: Extract a lease-driven AgentTaskRunner

**Files:**

- Create: `src/pth/runner/agent-task-runner.ts`
- Create: `src/pth/runner/task-workspace.ts`
- Create: `src/pth/runner/runner-config.ts`
- Create: `test/pth-runner/agent-task-runner.test.ts`
- Modify: `src/pth/kernel/execution/task-loop.ts`
- Modify: `src/pth/kernel/execution/workspace.ts`
- Modify: `src/pth/kernel/execution/archive.ts`
- Modify: `src/pth/kernel/execution/agent-loop.ts`
- Modify: `src/pth/impls/kernels/kernel-manager.ts`
- Modify: `test/pth-kernel-execution/task-loop.test.ts`

**Interfaces:**

- Produces: `TaskRunner`, `AgentTaskRunner`, `TaskWorkspace`, `RunnerConfig`.
- Consumes: `TaskLease`, `TaskWorkItem`, contracts `WorkerKernel`, injected capability set and workspace adapter.

- [ ] **Step 1: write a runner test with no repository or gateway object**

```ts
// test/pth-runner/agent-task-runner.test.ts
import { describe, expect, it, vi } from "vitest";
import { AgentTaskRunner } from "../../src/pth/runner/agent-task-runner.js";

it("returns a completed outcome after reset resolves and does not commit it", async () => {
  let resetFinished = false;
  const kernel = {
    reset: vi.fn(async () => { await Promise.resolve(); resetFinished = true; }),
    dispose: vi.fn(), snapshot: vi.fn(), ts: {}, bash: {}, python: {},
  } as never;
  const runAgent = vi.fn(async () => {
    expect(resetFinished).toBe(true);
    return { ok: true, value: { answer: 1 }, steps: 1 };
  });
  const runner = new AgentTaskRunner({ kernel, runAgent, workspace: fakeWorkspace(), config: fakeConfig() });
  const outcome = await runner.run({ lease: fakeLease(), work: fakeWorkItem() });
  expect(outcome.status).toBe("completed");
  expect("repository" in runner).toBe(false);
});
```

Add tests for agent error/no output/PTC failure → rejected outcome, cancelled signal → cancelled outcome, artifact refs in the outcome, no-LLM/agent-off compatibility, and absence of audit/metric/notifier calls.

- [ ] **Step 2: demonstrate current failure**

Run: `npx vitest run test/pth-runner/agent-task-runner.test.ts`

Expected: FAIL because task execution is embedded in `TaskLoop` and `kernel.reset()` is not awaited.

- [ ] **Step 3: move execution mechanics into the runner**

```ts
export interface TaskRunner {
  run(input: { lease: TaskLease; work: TaskWorkItem }, signal?: AbortSignal): Promise<TaskOutcome>;
}

export interface RunnerConfig {
  readonly agentMode: "agent" | "translate";
  readonly aspEnabled: boolean;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly notifyPolicy: "observer-only";
}
```

Move existing AgentLoop/PTC/degraded translation branches into `AgentTaskRunner`. Begin every task with `await kernel.reset()` and make the PTH-local kernel runtime lifecycle fully asynchronous. Use an injected `TaskWorkspace` that maps `WorkspaceRef` to a current compatibility path and archives artifacts into opaque `ArtifactRef` values. It may preserve the legacy default physical layout during this phase, but it must not expose that path in `TaskOutcome` or contracts.

The runner must translate execution result into a single outcome and return it; it must not call `submit`, `reject`, audit, transcript, activity, optimizer, refiner or notification code. A post-success archive failure becomes a recorded observer/artifact failure, not a second state transition to rejected.

- [ ] **Step 4: make compatibility TaskLoop a thin delegating wrapper**

Keep the current `TaskLoop` constructor/export temporarily, but extract the existing `execute(task)` body into a compatibility adapter that obtains a lease/work item and delegates to `AgentTaskRunner`. Remove raw environment reads, global event bus emission, direct `kernel.dataWorld.audit` access, transcript write and notification fetch from its hot path.

- [ ] **Step 5: run runner/lifecycle regression tests**

```bash
npx vitest run test/pth-runner/agent-task-runner.test.ts test/pth-kernel-execution/task-loop.test.ts test/pth-kernel-execution/agent-loop.test.ts test/pth-kernel-execution/agent-loop-ptc.integration.test.ts test/pth-kernel-interpreter/kernel-manager.test.ts test/pth-kernel-interpreter/kernel-manager-sandbox.test.ts
npm run lint
```

- [ ] **Step 6: commit runner extraction**

```bash
git add -- src/pth/runner src/pth/kernel/execution/task-loop.ts src/pth/kernel/execution/workspace.ts src/pth/kernel/execution/archive.ts src/pth/kernel/execution/agent-loop.ts src/pth/impls/kernels/kernel-manager.ts test/pth-runner test/pth-kernel-execution test/pth-kernel-interpreter
git diff --cached --check
git commit -m "refactor(runner): extract lease-driven agent execution"
```

## Task 4: Replace TaskLoop's main path with a TaskDispatcher

**Files:**

- Create: `src/pth/tasking/task-dispatcher.ts`
- Create: `src/pth/tasking/task-outcome-committer.ts`
- Create: `test/pth-tasking/task-dispatcher.test.ts`
- Modify: `src/pth/kernel/execution/task-loop.ts`
- Modify: `src/pth/kernel/execution/batch-process.ts`
- Modify: `src/pth/kernel/execution/batch-manager.ts`
- Modify: `test/pth-kernel-execution/batch-process.integration.test.ts`
- Modify: `test/pth-kernel-execution/batch-manager.test.ts`

**Interfaces:**

- Produces: `TaskDispatcher` and `TaskOutcomeCommitter`.
- Preserves: `TaskLoop.runOnce()` boolean, pause/resume/stop and current batch IPC message names.

- [ ] **Step 1: write dispatcher behavior tests**

```ts
it("does not execute a task when the atomic claim loses a race", async () => {
  const runner = { run: vi.fn() };
  const dispatcher = new TaskDispatcher({ leases: { claim: async () => [] }, reader: fakeReader(), runner, committer: fakeCommitter() } as never);
  await expect(dispatcher.runOnce({ workerId: "batch-1/developer-1", roleId: "developer" })).resolves.toBe(false);
  expect(runner.run).not.toHaveBeenCalled();
});

it("commits exactly once and returns false for a stale duplicate outcome", async () => {
  const committer = { commit: vi.fn().mockResolvedValueOnce({ committed: true }).mockResolvedValueOnce({ committed: false }) };
  // Exercise the same outcome twice through the dispatcher integration fixture.
});
```

Include pause/stop tests, runner-throws → one terminal rejection, stale-work-item → no runner call, and real PostgreSQL + fork integration coverage.

- [ ] **Step 2: run the test and verify failure**

Run: `npx vitest run test/pth-tasking/task-dispatcher.test.ts`

Expected: FAIL because there is no dispatcher and TaskLoop owns candidate/claim/execute/commit logic.

- [ ] **Step 3: implement the fixed dispatcher sequence**

```ts
export class TaskDispatcher {
  async runOnce(worker: { workerId: string; roleId: string }): Promise<boolean> {
    const leases = await this.leases.claim(this.systemScope, { ...worker, limit: 1, ttlMs: this.leaseTtlMs });
    if (leases.length === 0) return false;
    const lease = leases[0]!;
    const work = await this.reader.load(lease);
    if (!work) return false;
    const outcome = await this.runner.run({ lease, work });
    await this.committer.commit(outcome);
    return true;
  }
}
```

The actual implementation must handle runner throw/cancel with a generated terminal/cancelled outcome tied to the same lease. It must not retry by calling the runner a second time. `BatchTaskLoop extends TaskLoop` becomes composition over dispatcher; retain its public process behavior until callers migrate.

- [ ] **Step 4: give each forked worker a unique identity**

In `batch-process.ts`, derive a worker ID that includes batch PID/UUID, role and replica sequence. Keep role ID for routing, but no longer use role alone as lease ownership. Preserve `worker-pause`, `worker-resume`, `worker-remove`, `worker-add`, `pause`, `resume`, `shutdown` semantics and parse IPC through the contracts parser.

- [ ] **Step 5: run behavior and fork integration suites**

```bash
npx vitest run test/pth-tasking/task-dispatcher.test.ts test/pth-kernel-execution/task-loop.test.ts test/pth-kernel-execution/batch-manager.test.ts test/pth-kernel-execution/batch-process.integration.test.ts test/pth-kernel-assembly/batch-manager-fork.integration.test.ts
npm run lint
```

- [ ] **Step 6: commit dispatcher migration**

```bash
git add -- src/pth/tasking/task-dispatcher.ts src/pth/tasking/task-outcome-committer.ts src/pth/kernel/execution/task-loop.ts src/pth/kernel/execution/batch-process.ts src/pth/kernel/execution/batch-manager.ts test/pth-tasking test/pth-kernel-execution test/pth-kernel-assembly
git diff --cached --check
git commit -m "refactor(tasking): dispatch claimed leases through runners"
```

## Task 5: Deliver committed outcomes through isolated observers

**Files:**

- Create: `src/pth/tasking/task-outcome-observers.ts`
- Create: `src/pth/runner/observers/activity-observer.ts`
- Create: `src/pth/runner/observers/audit-observer.ts`
- Create: `src/pth/runner/observers/metrics-observer.ts`
- Create: `src/pth/runner/observers/notifier-observer.ts`
- Create: `src/pth/runner/observers/transcript-observer.ts`
- Create: `src/pth/runner/observers/refine-observer.ts`
- Create: `src/pth/runner/observers/optimizer-observer.ts`
- Create: `test/pth-tasking/task-outcome-observers.test.ts`
- Modify: `src/pth/kernel/execution/activity-hub.ts`
- Modify: `src/pth/kernel/execution/event-bus.ts`
- Modify: `src/pth/kernel/storage/audit-store.ts`
- Modify: `src/pth/kernel/storage/transcript-store.ts`
- Modify: `src/pth/kernel/execution/task-loop.ts`
- Modify: `src/pth/kernel/execution/batch-process.ts`

**Interfaces:**

- Produces: `TaskOutcomeObserver` fan-out and typed committed outcome event.
- Consumes: post-commit task data, not mutable task control dependencies.

- [ ] **Step 1: write failure-isolation tests**

```ts
it("runs no observer for an uncommitted duplicate and isolates individual failures", async () => {
  const first = { onCommitted: vi.fn().mockRejectedValue(new Error("audit unavailable")) };
  const second = { onCommitted: vi.fn() };
  const observers = new TaskOutcomeObservers([first, second], fakeLogger());

  await observers.publish({ committed: false, lease: fakeLease(), work: fakeWorkItem(), outcome: completedOutcome(fakeLease()) });
  expect(first.onCommitted).not.toHaveBeenCalled();

  await observers.publish({ committed: true, lease: fakeLease(), work: fakeWorkItem(), outcome: completedOutcome(fakeLease()) });
  expect(second.onCommitted).toHaveBeenCalledOnce();
});
```

Add tests that completed/rejected/cancelled produce one compatible activity event, a transcript/audit is tenant-filtered, and a slow refine/optimizer observer cannot block the next claim.

- [ ] **Step 2: verify initial failure**

Run: `npx vitest run test/pth-tasking/task-outcome-observers.test.ts`

Expected: FAIL because current TaskLoop performs effects before/around task state changes and uses a global event bus.

- [ ] **Step 3: make observer delivery explicitly post-commit**

```ts
export interface TaskOutcomeObserver {
  onCommitted(input: { lease: TaskLease; work: TaskWorkItem; outcome: TaskOutcome }): Promise<void>;
}

export interface TaskOutcomeObservers {
  publish(input: { committed: boolean; lease: TaskLease; work: TaskWorkItem; outcome: TaskOutcome }): Promise<void>;
}
```

Use `Promise.allSettled` or an equivalent supervised queue and record observer failures to operations telemetry. Activity/IPC and legacy EventBus become observer adapters only; neither dispatcher nor runner may call `getEventBus()`. Every event carries `TenantScope` or at least tenant/principal/trace fields required by its recipient. Use a bounded background queue for refinement/optimization so a failure or backlog is observable and cannot halt claiming.

- [ ] **Step 4: make audit and transcript scoped**

Propagate `tenantId` from lease scope into audit/transcript writes and read APIs. If a legacy transcript insert or query has no tenant field, add a compatible migration and backfill default rows before exposing query filters. Route reads must use scope and return 404/empty results for another tenant.

- [ ] **Step 5: run observer and API regression suites**

```bash
npx vitest run test/pth-tasking/task-outcome-observers.test.ts test/pth-kernel-storage/transcript-audit.test.ts test/pth-kernel-execution/activity-hub.test.ts test/pth-kernel-execution/event-bus.test.ts test/pth-gateway/kernel-routes.test.ts
npm run lint
```

- [ ] **Step 6: commit observer delivery**

```bash
git add -- src/pth/tasking/task-outcome-observers.ts src/pth/runner/observers src/pth/kernel/execution/activity-hub.ts src/pth/kernel/execution/event-bus.ts src/pth/kernel/storage/audit-store.ts src/pth/kernel/storage/transcript-store.ts src/pth/kernel/execution/task-loop.ts src/pth/kernel/execution/batch-process.ts test/pth-tasking test/pth-kernel-storage test/pth-kernel-execution test/pth-gateway
git diff --cached --check
git commit -m "refactor(tasking): publish committed outcomes to observers"
```

## Task 6: Move flow resolution and triggers into Task Control

**Files:**

- Create: `src/pth/tasking/flow-core.ts`
- Create: `src/pth/tasking/flow-resolver.ts`
- Create: `src/pth/tasking/trigger-service.ts`
- Create: `test/pth-tasking/flow-resolver.test.ts`
- Create: `test/pth-tasking/trigger-service.test.ts`
- Modify: `src/pth/kernel/execution/task-resolver.ts`
- Modify: `src/pth/kernel/execution/resolver-core.ts`
- Modify: `src/pth/kernel/execution/trigger-engine.ts`
- Modify: `src/pth/gateway/routes-trigger.ts`
- Modify: `src/pth/kernel/assembly.ts`
- Modify: `packages/pth-memory/src/memory-store-pg.ts` for scope-aware trigger reads/writes
- Modify: `packages/pth-memory/src/memory-policy.ts` for scoped visibility checks
- Modify: `packages/pth-memory/src/index.ts` to export the scoped adapter surface

**Interfaces:**

- Produces: `FlowResolver`, `TriggerService`, `TaskFlowRepository` and scoped trigger operations.
- Consumes: `TaskCommands`, `TaskQueries`, scoped memory adapter, injected `RoutingPolicy`.

- [ ] **Step 1: write concurrency and inheritance failures**

```ts
it("creates child tasks once when two resolvers see the same unresolved stage", async () => {
  const [left, right] = await Promise.all([resolver.resolveLoop(), resolver.resolveLoop()]);
  expect(await taskQueries.list(scope, { parentTaskId: parent.id })).toHaveLength(2);
  expect(left.generated + right.generated).toBe(2);
});

it("publishes a trigger task in the source outcome tenant", async () => {
  await triggers.onOutcome(committedOutcomeForTenant("tenant-a"));
  expect(await taskQueries.list(tenantA, {})).toHaveLength(1);
  expect(await taskQueries.list(tenantB, {})).toEqual([]);
});
```

Keep regressions for transform/decompose/branch/loop/terminal, trigger once/maxFires/self-trigger/depth, and intentionally missing/invalid flow data.

- [ ] **Step 2: run and establish failure**

Run: `npx vitest run test/pth-tasking/flow-resolver.test.ts test/pth-tasking/trigger-service.test.ts`

Expected: FAIL because resolver uses a raw pool and trigger engine has unscoped TaskStore/MemoryStore dependencies.

- [ ] **Step 3: make each flow transition transactional and scoped**

`FlowResolver` must lock parent state, validate the current unresolved stage, publish all child tasks, persist the advanced stage state and commit in the same transaction. It may use a `TaskFlowRepository` adapter internally, but not `pg.Pool` from its module surface. Two resolvers must not duplicate children. Inject `RoutingPolicy` from catalog/assembly; do not import tag/role globals inside runner.

- [ ] **Step 4: make trigger data scope-aware before calling it tenant-safe**

`memory_entries` already has tenant information, but current `PgMemoryStore` does not consistently propagate it. Add a narrow scoped memory adapter or complete the relevant `pth-memory` scope propagation before trigger CRUD/query is moved. The source activity/outcome scope is copied to the generated task command. A trigger must never discover, fire from, or modify another tenant's definition.

- [ ] **Step 5: retain legacy entrypoints as forwarding wrappers**

`TaskResolver` and `TriggerEngine` keep their exported names for existing assembly/tests, but delegate into `FlowResolver`/`TriggerService`. Delete raw pool access only after their integration suites pass.

- [ ] **Step 6: run task-control regression tests and commit**

```bash
npx vitest run test/pth-tasking/flow-resolver.test.ts test/pth-tasking/trigger-service.test.ts test/pth-kernel-execution/task-resolver.test.ts test/pth-kernel-execution/trigger-engine.test.ts test/pth-gateway/trigger-routes.test.ts
npm run lint
git add -- src/pth/tasking src/pth/kernel/execution/task-resolver.ts src/pth/kernel/execution/resolver-core.ts src/pth/kernel/execution/trigger-engine.ts src/pth/gateway/routes-trigger.ts src/pth/kernel/assembly.ts packages/pth-memory/src test/pth-tasking test/pth-kernel-execution test/pth-gateway
git diff --cached --check
git commit -m "refactor(tasking): isolate flow resolution and triggers"
```

## Task 7: Assemble tasking and runner modules behind compatible runtime facades

**Files:**

- Create: `src/pth/runner/runner-process.ts`
- Create: `src/pth/runner/runner-manager.ts`
- Create: `test/pth-runner/runner-process.integration.test.ts`
- Create: `test/pth-architecture/tasking-runner-boundaries.test.ts`
- Modify: `src/pth/kernel/assembly.ts`
- Modify: `src/pth/kernel/execution/batch-process.ts`
- Modify: `src/pth/kernel/execution/batch-manager.ts`
- Modify: `src/pth/main.ts`
- Modify: `src/pth/application/gateway/pth-gateway-facade.ts`
- Modify: `src/pth/gateway/server.ts`

**Interfaces:**

- Produces: bootstrap-composed `tasking` and `runner` facades; `RunnerAdmin` adapter for current batch routes.
- Retires from route dependencies: raw `dataWorld.tasks`, raw task pool reads and direct batch manager access.

- [ ] **Step 1: write architecture boundary tests**

The static test must fail when either of these is added:

```ts
// src/pth/runner/example.ts — forbidden
import { PgTaskStore } from "../kernel/storage/task-store-pg.js";

// src/pth/tasking/example.ts — forbidden
import { runAgentTask } from "../kernel/execution/agent-loop.js";
```

It must allow bootstrap to compose adapters and allow `runner-process.ts` to import a runner public API. Add a fork integration test that starts a runner, claims a scoped task, emits one outcome, shuts down, and releases kernels cleanly.

- [ ] **Step 2: run and confirm failure**

Run: `npx vitest run test/pth-architecture/tasking-runner-boundaries.test.ts test/pth-runner/runner-process.integration.test.ts`

Expected: FAIL because target module directories and runner process facade do not yet exist.

- [ ] **Step 3: switch assembly to composition only**

Assembly constructs PG adapters, `TaskControlService`, `TaskDispatcher`, `AgentTaskRunner`, observers, flow/trigger services and a `RunnerManager`. It exposes route-facing task commands/queries and `RunnerAdmin`, not raw storage. `main.ts` passes these APIs to the gateway facade. `BatchManager` may remain the implementation behind `RunnerManager` so existing `/kernel/batch/*` behavior survives.

- [ ] **Step 4: turn batch-process into a runner-process compatibility entrypoint**

Move child-process assembly to `runner-process.ts`. Keep `batch-process.ts` as a forwarding executable/import compatibility entrypoint until existing deployment commands and fork tests use the new path. The runner process gets only its explicitly required config/ports; it must not recreate unrelated gateway/knowledge/catalog singletons from environment side effects.

- [ ] **Step 5: run the final Phase 2 matrix**

```bash
npx vitest run \
  test/pth-tasking \
  test/pth-runner \
  test/pth-architecture/tasking-runner-boundaries.test.ts \
  test/pth-kernel-storage/task-store-pg.test.ts \
  test/pth-kernel-storage/claim-reaper.test.ts \
  test/pth-kernel-execution/batch-manager.test.ts \
  test/pth-kernel-execution/batch-process.integration.test.ts \
  test/pth-kernel-assembly/batch-manager-fork.integration.test.ts \
  test/pth-gateway/kernel-routes.test.ts \
  test/pth-gateway/jobs-routes.test.ts
npm run check:pth-boundaries
npm run lint
npm run build
```

- [ ] **Step 6: commit assembly wiring**

```bash
git add -- src/pth/runner/runner-process.ts src/pth/runner/runner-manager.ts src/pth/kernel/assembly.ts src/pth/kernel/execution/batch-process.ts src/pth/kernel/execution/batch-manager.ts src/pth/main.ts src/pth/application/gateway/pth-gateway-facade.ts src/pth/gateway/server.ts test/pth-runner test/pth-architecture
git diff --cached --check
git commit -m "refactor(pth): assemble tasking and runner modules"
```

## Completion criteria

- Every claimed task has an actual tenant-scoped lease ID, generation and expiry; complete/reject/cancel use CAS conditions and duplicate/stale outcomes are inert.
- Public task/job routes derive scope from authenticated server context and cannot read another tenant's task, job, transcript or audit record.
- `TaskDispatcher` owns claim → load → run → commit; `AgentTaskRunner` owns execution only; neither has the other's forbidden dependencies.
- All effects run only after a committed outcome, are tenant-contextual and cannot mutate an already finalized task outcome.
- Flow and trigger writes are transactionally scoped and concurrent resolvers cannot duplicate child tasks.
- The existing forked batch behavior and HTTP routes remain compatible behind runner/tasking facades, ready for the later optional process split.
