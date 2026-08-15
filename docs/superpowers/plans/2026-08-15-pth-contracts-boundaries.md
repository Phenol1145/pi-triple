# PTH Contracts 与边界迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建纯 TypeScript workspace `@away_from/pth-contracts`，把 PTH 的跨模块协议、执行协议、任务 lease 和事件协议从当前 `@away_from/pth-sandbox`、`DataWorldAccess` 与 `KernelRuntime` 中分离出来，同时以 facade 保持 gateway、batch runner 与现有 package 消费者兼容。

**Architecture:** Contracts 是唯一可被 PTH modules 与 adapters 共同依赖的底层 package。它只包含值对象、DTO、ports 和事件类型，不能 import Fastify、PostgreSQL、Redis、Pi SDK、Node process API 或具体 sandbox 实现。现有 `pth-sandbox` 暂时 re-export 已迁移类型以维持兼容；`KernelRuntime` 先实现窄的 facade，再由后续 work package 移除裸 `pool` 与 `dataWorld` 暴露。

**Tech Stack:** npm workspaces、TypeScript 5.7、Vitest、ESM/Node16 module resolution、PostgreSQL adapter contract tests。

## Global Constraints

- `@away_from/pth-contracts` 只能向外依赖 TypeScript 标准库类型；不得新增运行时依赖或隐式单例。
- Contracts 中的 workspace 必须是 opaque `WorkspaceRef`，不得出现容器宿主路径、Docker volume 名或可直接用于文件系统访问的 string path。
- 所有 command/port 调用显式携带 `TenantScope`；没有 scope 的查询不得被用于 tenant/user 数据。
- `TaskLease` 与 `ExecutionGrant` 是 capability，不是可预测字符串。必须包含 UUID/nonce、generation 和 deadline，并可被验证为过期或失效。
- Adapter 可以将 `pg.Pool`、Fastify request 或 sandbox HTTP client 变换为 port 实现，但这些具体类型不得越过 adapter 边界。
- 旧的 `DataWorldAccess` 在本 work package 只允许留作组装兼容对象；禁止在新业务代码中新增对它的依赖。
- 所有 import boundary 测试必须扫描编译后的生产源，不以注释、测试 mock 或 barrel 中的偶然重导出作为合规证据。
- 每个任务分别提交；不要暂存当前工作树里不属于本计划的 `deploy/`、mailbox、dev-container 或测试迁移改动。

---

## Task 1: Create the pure contracts workspace and its value protocols

**Files:**

- Create: `packages/pth-contracts/package.json`
- Create: `packages/pth-contracts/tsconfig.json`
- Create: `packages/pth-contracts/src/index.ts`
- Create: `packages/pth-contracts/src/identity.ts`
- Create: `packages/pth-contracts/src/tasking.ts`
- Create: `packages/pth-contracts/src/execution.ts`
- Create: `packages/pth-contracts/src/ports.ts`
- Create: `packages/pth-contracts/src/worker-ipc.ts`
- Create: `packages/pth-contracts/test/contracts.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `packages/pth-sandbox/package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces: `TenantScope`, `WorkspaceRef`, `TaskLease`, `TaskOutcome`, `ExecutionRequest`, `ExecutionGrant`, `ExecutionResult`, port types and IPC message parsers.
- Consumed later by: `tasking`, `runner`, `execution`, `catalog`, gateway facade and sandbox adapters.

- [ ] **Step 1: write failing protocol tests**

```ts
// packages/pth-contracts/test/contracts.test.ts
import { describe, expect, it } from "vitest";
import { isExecutionGrantStructurallyValid, type ExecutionGrant, type TenantScope } from "../src/index.js";

const scope: TenantScope = {
  tenantId: "tenant-a",
  principalId: "worker:origin",
  roles: ["origin"],
  traceId: "trace-001",
};

describe("PTH contracts", () => {
  it("models opaque, scope-bound leases and grants without creating authority", () => {
    const grant: ExecutionGrant = {
      grantId: "0c4a2c7d-800c-4e3e-8a0b-6d3e3474627d",
      nonce: "8efab84f-e946-4b84-a49e-e1d08cc38a50",
      lease: { taskId: "task-001", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
      scope,
      workspace: { tenantId: "tenant-a", workspaceId: "ws-opaque-001", taskId: "task-001" },
      language: "python",
      capabilities: ["memory.read"],
      issuedAt: "2030-01-01T00:00:00.000Z",
      deadlineAt: "2030-01-01T00:00:10.000Z",
    };

    expect(isExecutionGrantStructurallyValid(grant)).toBe(true);
    expect(grant.workspace.workspaceId).toBe("ws-opaque-001");
    expect(grant.lease.generation).toBe(1);
  });

  it("rejects a malformed cross-boundary grant value", () => {
    const malformed = { grantId: "not-a-uuid", scope, workspace: { tenantId: "tenant-b" } };
    expect(isExecutionGrantStructurallyValid(malformed)).toBe(false);
  });
});
```

- [ ] **Step 2: run the targeted test and verify the initial failure**

Run: `npx vitest run packages/pth-contracts/test/contracts.test.ts`

Expected: FAIL because the package and exports do not exist.

- [ ] **Step 3: implement the smallest dependency-free contract surface**

```ts
// packages/pth-contracts/src/identity.ts
export interface TenantScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly roles: readonly string[];
  readonly traceId: string;
}

export interface WorkspaceRef {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly taskId?: string;
}
```

```ts
// packages/pth-contracts/src/tasking.ts
import type { TenantScope, WorkspaceRef } from "./identity.js";

export interface TaskLease {
  readonly taskId: string;
  readonly leaseId: string;
  readonly scope: TenantScope;
  readonly workspace: WorkspaceRef;
  readonly roleId: string;
  readonly deadlineAt: string;
  readonly generation: number;
}

export interface TaskWorkItem {
  readonly taskId: string;
  readonly scope: TenantScope;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly payload: unknown;
  readonly assignedRole: string;
}

export interface ArtifactRef {
  readonly kind: string;
  readonly uri: string;
  readonly mediaType?: string;
}

export interface TaskOutcome {
  readonly lease: Pick<TaskLease, "taskId" | "leaseId" | "generation">;
  readonly status: "completed" | "rejected" | "cancelled";
  /** A rejected outcome may be deliberately released back to the queue. */
  readonly retryable?: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string };
  readonly artifacts: readonly ArtifactRef[];
  readonly usage?: Readonly<Record<string, number>>;
  readonly traceId: string;
}
```

```ts
// packages/pth-contracts/src/execution.ts
import type { TenantScope, WorkspaceRef } from "./identity.js";
import type { TaskLease } from "./tasking.js";

export type ExecutionLanguage = "ts" | "python" | "bash" | "c" | (string & {});

export interface ExecutionRequest {
  readonly scope: TenantScope;
  readonly workspace: WorkspaceRef;
  readonly language: ExecutionLanguage;
  readonly program: string;
  readonly timeoutMs: number;
  readonly maxStdout: number;
  readonly maxStderr: number;
}

export interface ExecutionGrant {
  readonly grantId: string;
  readonly lease: Pick<TaskLease, "taskId" | "leaseId" | "generation">;
  readonly scope: TenantScope;
  readonly workspace: WorkspaceRef;
  readonly language: ExecutionLanguage;
  readonly capabilities: readonly string[];
  readonly issuedAt: string;
  readonly deadlineAt: string;
  readonly nonce: string;
}

export interface ExecutionResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: { code: string; message: string };
  readonly truncated?: Readonly<Record<"stdout" | "stderr" | "value", boolean>>;
}

export interface ExecutionPort {
  execute(request: ExecutionRequest, grant: ExecutionGrant, signal?: AbortSignal): Promise<ExecutionResult>;
}
```

Do not expose an unchecked `Record<string, unknown>` as a substitute for scope, lease, grant or result. Contracts validate structural shape only; issuance of random IDs, durable lease state, signing and grant verification begin in Phase 2/3. Phase 1 must not feed an optional grant into the old shared-secret sandbox endpoint, because that would create an unsafe fallback authorization path.

- [ ] **Step 4: wire workspace compilation and test it**

Add `@away_from/pth-contracts` to root build and lint scripts before packages that consume it. Add the root TypeScript `paths` entry only if TypeScript cannot resolve its generated declarations through the npm workspace link. Then run:

```bash
npx vitest run packages/pth-contracts/test/contracts.test.ts
tsc -p packages/pth-contracts
npm run lint
```

Expected: all pass without importing a PTH runtime implementation.

- [ ] **Step 5: commit the package foundation**

```bash
git add -- package.json package-lock.json tsconfig.json packages/pth-contracts
git diff --cached --check
git commit -m "feat(pth-contracts): add scope lease grant protocols"
```

## Task 2: Move portable interpreter and worker IPC types behind contracts

**Files:**

- Create: `packages/pth-contracts/src/interpreter.ts`
- Create: `packages/pth-contracts/src/worker-ipc.ts`
- Create: `packages/pth-contracts/test/interpreter-contract.test.ts`
- Create: `packages/pth-contracts/test/worker-ipc.test.ts`
- Modify: `packages/pth-contracts/src/index.ts`
- Modify: `packages/pth-sandbox/src/kernel/interpreter/types.ts`
- Modify: `packages/pth-sandbox/src/index.ts`
- Modify: `src/pth/kernel/interpreter/index.ts`
- Modify: `src/pth/impls/kernels/kernel-manager.ts`
- Modify: `src/pth/impls/kernels/ts-interpreter.ts`
- Modify: `src/pth/impls/kernels/python-interpreter.ts`
- Modify: `src/pth/impls/kernels/capability.ts`
- Modify: `src/pth/impls/kernels/index.ts`
- Modify: `src/pth/kernel/exec-channel.ts`
- Modify: `src/pth/kernel/execution/archive.ts`
- Modify: `src/pth/kernel/execution/batch-manager.ts`
- Modify: `src/pth/kernel/execution/batch-process.ts`
- Modify: `src/pth/kernel/execution/refiner.ts`
- Modify: `src/pth/kernel/execution/worker-cluster.ts`
- Modify: `src/pth/kernel/ptc/runner.ts`
- Modify: `src/pth/kernel/interpreter/ext-capability.ts`
- Test: `test/pth-kernel-interpreter/kernel.test.ts`
- Test: `test/pth-kernel-interpreter/ts-interpreter.test.ts`
- Test: `test/pth-kernel-interpreter/python-interpreter.test.ts`
- Test: `test/pth-kernel-interpreter/kernel-manager.test.ts`
- Test: `test/pth-kernel-interpreter/kernel-manager-sandbox.test.ts`
- Test: `test/pth-kernel-execution/batch-manager.test.ts`
- Test: `test/pth-kernel-execution/batch-process.integration.test.ts`

**Interfaces:**

- Produces: portable `ExecuteOptions`, `ExecutionResult`, `InterpreterSnapshot`, `Interpreter`, `WorkerKernel`, `HostToRunnerMessage`, `RunnerToHostMessage` and input parsers.
- Keeps in sandbox: concrete `PyKernel`, `BashKernel`, `SandboxKernel`, Docker/HTTP host, debug implementation details.

- [ ] **Step 1: write compatibility tests at both import locations**

```ts
import { describe, expect, it } from "vitest";
import type { Interpreter, InterpreterResult } from "@away_from/pth-contracts";
import type { Interpreter as ReexportedInterpreter } from "@away_from/pth-sandbox";

describe("interpreter contract migration", () => {
  it("keeps the sandbox type export assignable during the deprecation window", () => {
    const assertSame: Interpreter | null = null as unknown as ReexportedInterpreter | null;
    expect(assertSame).toBeNull();
  });

  it("requires asynchronous reset and disposal boundaries", async () => {
    const runtime = {
      language: "python",
      state: {},
      execute: async (): Promise<InterpreterResult> => ({ ok: true, stdout: "", stderr: "", durationMs: 0 }),
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset: async () => undefined,
      dispose: async () => undefined,
    } satisfies Interpreter;
    await runtime.reset();
    await runtime.dispose();
  });
});
```

- [ ] **Step 2: establish the initial failure**

Run: `npx vitest run packages/pth-contracts/test/interpreter-contract.test.ts`

Expected: FAIL because the contracts package has no interpreter/runner IPC export and current `reset`/`dispose` types are synchronous.

- [ ] **Step 3: define the portable surface and compatibility re-exports**

```ts
// packages/pth-contracts/src/interpreter.ts
import type { ExecutionLanguage, ExecutionResult } from "./execution.js";

export interface ExecuteOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly maxStdout?: number;
  readonly maxStderr?: number;
  readonly structured?: boolean;
  readonly captureResult?: boolean;
  readonly exec?: "single" | "program" | "auto";
}

export type InterpreterResult = ExecutionResult;

export interface Interpreter {
  readonly language: ExecutionLanguage;
  execute(program: string, options?: ExecuteOptions): Promise<InterpreterResult>;
  snapshot(): Promise<InterpreterSnapshot>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
  abort?(): Promise<void>;
}
```

```ts
// packages/pth-contracts/src/worker-ipc.ts
// Each member is JSON-serializable. Dynamic role/metric/activity data stays unknown
// until the owning module gives it a stable contract.
export type HostToRunnerMessage =
  | { readonly type: "shutdown" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "worker-pause"; readonly role: string }
  | { readonly type: "worker-resume"; readonly role: string }
  | { readonly type: "worker-remove"; readonly role: string }
  | { readonly type: "worker-add"; readonly role: string; readonly copies: number }
  | { readonly type: "role-register"; readonly role: unknown }
  | { readonly type: "set-param"; readonly name: string; readonly value: unknown }
  | { readonly type: "obs-resp"; readonly requestId: string; readonly value: unknown };

export type RunnerToHostMessage =
  | { readonly type: "status"; readonly value: unknown }
  | { readonly type: "worker-status"; readonly value: unknown }
  | { readonly type: "param-status"; readonly value: unknown }
  | { readonly type: "log"; readonly message: string }
  | { readonly type: "cleanup"; readonly value?: unknown }
  | { readonly type: "metric"; readonly value: unknown }
  | { readonly type: "activity"; readonly value: unknown }
  | { readonly type: "obs-req"; readonly requestId: string; readonly request: string; readonly params: unknown };
```

Also export the lean lifecycle-only `WorkerKernel`: `ts`, `bash`, `python`, optional `c`, optional language `execute`, `snapshot`, asynchronous `reset`/`dispose`, optional `abort`. It must not contain `llm`, `dataWorld`, `ModelRouter`, a sandbox client or untyped capability bag. Keep those composition dependencies in a PTH-local `WorkerKernelRuntime` / `WorkerKernelFactoryDeps` under `src/pth/impls/kernels/` during the compatibility window.

Implement `parseHostToRunnerMessage(value: unknown)` and `parseRunnerToHostMessage(value: unknown)` beside these unions. They must check `type` and required primitive fields before dispatch; unknown commands and malformed role/copies/request IDs return `null` and are logged at the process boundary.

Change all concrete kernels to return `Promise<void>` for reset/dispose. Make cleanup awaitable before moving any release logic; do not wrap a synchronous reset in `Promise.resolve()` while leaving child-process or HTTP cleanup detached. Preserve old `@away_from/pth-sandbox` type exports as deprecated aliases during this work package.

- [ ] **Step 4: migrate imports in dependency order**

1. Migrate `src/pth/kernel/interpreter/index.ts` and its tests to `@away_from/pth-contracts`.
2. Migrate `src/pth/impls/kernels/kernel-manager.ts` and adapter tests.
3. Migrate `batch-manager.ts` / `batch-process.ts` IPC messages through `parseHostToRunnerMessage` and `parseRunnerToHostMessage`; preserve every current wire message name.
4. Re-export the same types from `@away_from/pth-sandbox` with deprecation JSDoc.
5. Run typecheck after each file group, fixing awaited lifecycle calls rather than suppressing errors.

- [ ] **Step 5: run focused regression suites**

```bash
npx vitest run packages/pth-contracts/test/interpreter-contract.test.ts test/pth-kernel-interpreter packages/pth-sandbox/test/sandbox-kernel.test.ts packages/pth-sandbox/test/sandbox-kernel-abort.test.ts test/pth-kernel-execution/batch-manager.test.ts test/pth-kernel-execution/batch-process.integration.test.ts
npm run lint
```

Expected: PTH code imports portable protocols from contracts; sandbox keeps concrete implementation ownership.

- [ ] **Step 6: commit the protocol migration**

```bash
git add -- packages/pth-contracts packages/pth-sandbox/src src/pth/kernel/interpreter src/pth/impls/kernels src/pth/kernel/execution/batch-manager.ts src/pth/kernel/execution/batch-process.ts test/pth-kernel-interpreter test/pth-kernel-execution
git diff --cached --check
git commit -m "refactor(pth): move execution protocols to contracts"
```

## Task 3: Define repository and observer ports without moving database code yet

**Files:**

- Create: `packages/pth-contracts/src/task-ports.ts`
- Create: `packages/pth-contracts/src/knowledge-ports.ts`
- Create: `packages/pth-contracts/src/operations-ports.ts`
- Create: `packages/pth-contracts/test/ports.test.ts`
- Modify: `packages/pth-contracts/src/index.ts`
- Modify: `src/pth/kernel/storage/index.ts`
- Test: `test/pth-kernel-storage/index.test.ts`

**Interfaces:**

- Produces: `TaskRepository`, `TaskReadModel`, `TranscriptRepository`, `AuditSink`, `MemoryRepository` interfaces.
- Sets up: future adapters for `PgTaskStore`, `PgTranscriptStore`, `PgAuditStore`, `PgMemoryStore`; no database migration or lease implementation in this task.

- [ ] **Step 1: write a fake-port contract test**

```ts
import { describe, expect, it } from "vitest";
import type { TaskRepository, TenantScope } from "@away_from/pth-contracts";

it("task repository takes a scope on every externally visible operation", async () => {
  const calls: unknown[] = [];
  const repository: TaskRepository = {
    publish: async (scope, input) => { calls.push([scope, input]); return { id: "task-1", status: "pending" }; },
    get: async () => null,
  };
  const scope: TenantScope = { tenantId: "t", principalId: "p", roles: [], traceId: "trace" };
  await repository.publish(scope, { title: "x", text: "y", createdBy: "p" });
  expect(calls).toHaveLength(1);
});
```

- [ ] **Step 2: verify failure**

Run: `npx vitest run packages/pth-contracts/test/ports.test.ts`

Expected: FAIL because no ports exist.

- [ ] **Step 3: add narrow ports and adapter conformance tests**

The repository surface must distinguish state-changing commands from read models. Phase 1 defines the interfaces but does not falsely implement leases on the legacy table. For example:

```ts
export interface TaskRepository {
  publish(scope: TenantScope, input: PublishTask): Promise<TaskRecord>;
  get(scope: TenantScope, taskId: string): Promise<TaskRecord | null>;
}

export interface TaskReadModel {
  list(scope: TenantScope, filter: TaskListFilter): Promise<readonly TaskSummary[]>;
  counts(scope: TenantScope): Promise<Readonly<Record<string, number>>>;
}

export interface TaskWorkItemReader {
  load(lease: TaskLease): Promise<TaskWorkItem | null>;
}

export interface TaskRunner {
  run(input: { lease: TaskLease; work: TaskWorkItem }): Promise<TaskOutcome>;
}
```

Define the Phase 2-only `TaskLeaseRepository` separately with `claim`, `complete`, `reject`, `cancel` and stale-lease recovery operations. Do not bind it to `PgTaskStore` until Phase 2 adds `lease_id`, `lease_generation`, `lease_expires_at`, proper tenant propagation and CAS completion checks. A generated `TaskLease` against today's `claimed_by` row would look like an authorization boundary but would not be one.

For Phase 1, wrap existing PG classes only for non-lease read/publish compatibility or leave them behind the assembly facade. Do not leak `pg.Pool` through an interface. The storage schema already contains `tasks.tenant_id`, but the current `Task` mapping and routes do not propagate it; tenant-safe query/write behavior is a Phase 2 implementation task, not a claim in this task.

- [ ] **Step 4: shrink `DataWorldAccess` to an assembly-only compatibility shape**

Keep `createDataWorld()` for existing callers and mark its interface as legacy assembly compatibility. Its returned object may be passed only to bootstrap/facade code. New module constructors take the narrow ports. Add a test that `DataWorldAccess` is not exported from the new contracts package. Do not change database schema or claim semantics here.

- [ ] **Step 5: run adapter regression tests**

```bash
npx vitest run packages/pth-contracts/test/ports.test.ts test/pth-kernel-storage/index.test.ts
npm run lint
```

- [ ] **Step 6: commit the port layer**

```bash
git add -- packages/pth-contracts src/pth/kernel/storage test/pth-kernel-storage
git diff --cached --check
git commit -m "refactor(pth): introduce scoped storage ports"
```

## Task 4: Introduce gateway route facades and preserve HTTP compatibility

**Files:**

- Create: `src/pth/application/gateway/pth-gateway-facade.ts`
- Create: `test/pth-application/pth-gateway-facade.test.ts`
- Modify: `src/pth/kernel/assembly.ts`
- Modify: `src/pth/gateway/routes-kernel.ts`
- Modify: `src/pth/gateway/routes-jobs.ts`
- Modify: `src/pth/gateway/routes-lineage.ts`
- Modify: `src/pth/gateway/routes-trigger.ts`
- Modify: `src/pth/gateway/server.ts`
- Modify: `test/pth-gateway/kernel-routes.test.ts`
- Modify: `test/pth-gateway/jobs-routes.test.ts`
- Modify: `test/pth-gateway/lineage-routes.test.ts`
- Create: `test/pth-gateway/trigger-routes.test.ts`
- Modify: `test/pth-kernel-assembly/assembly.test.ts`

**Interfaces:**

- Produces: `PthGatewayFacade` with `KernelRoutesApi`, `JobRoutesApi`, `LineageRoutesApi`, `TriggerRoutesApi`.
- Removes from gateway dependency: `KernelRuntime.pool`, `KernelRuntime.dataWorld`, concrete `BatchManager` and raw `KernelExecChannel` field access.

- [ ] **Step 1: write failure tests against facade-only gateway dependencies**

```ts
// test/pth-application/pth-gateway-facade.test.ts
import { describe, expect, it, vi } from "vitest";
import { createPthGatewayFacade } from "../../src/pth/application/gateway/pth-gateway-facade.js";

it("maps public task commands without exposing a pool", async () => {
  const facade = createPthGatewayFacade({
    taskCommands: { publish: vi.fn().mockResolvedValue({ id: "task-1", status: "pending" }) },
    taskQueries: { get: vi.fn(), list: vi.fn(), counts: vi.fn() },
    execution: { execute: vi.fn() },
    operations: { listBatches: vi.fn(), status: vi.fn(), transcript: vi.fn() },
  });
  expect("pool" in facade.kernel).toBe(false);
  expect(await facade.kernel.publishTask({ title: "a", text: "b", createdBy: "ptl" })).toMatchObject({ id: "task-1" });
});
```

- [ ] **Step 2: verify failure**

Run: `npx vitest run test/pth-application/pth-gateway-facade.test.ts test/pth-gateway/kernel-routes.test.ts`

Expected: FAIL because the facade does not exist and routes expect `KernelRuntime` internals.

- [ ] **Step 3: implement a compatibility facade**

```ts
export interface PthGatewayFacade {
  readonly kernel: KernelRoutesApi;
  readonly jobs: JobRoutesApi;
  readonly lineage: LineageRoutesApi;
  readonly triggers: TriggerRoutesApi;
}
```

`KernelRoutesApi` must expose route-shaped methods such as `publishTask`, `listTasks`, `getTask`, `executeDirect`, `listTranscripts`, `spawnBatch`, `controlWorker` and `runtimeStatus`. The other route APIs must similarly expose only operations their route file needs. Use a translation adapter at the route edge for legacy request bodies and response field casing. The facade itself must receive validated commands, not `FastifyRequest`. Move raw SQL used by `/tasks` and `/status` into `TaskReadModel` / `OperationsQueries`; move memory bridge behind an explicit `KnowledgeQueries` contract. Do not preserve direct access by giving the facade a `pool` escape hatch.

- [ ] **Step 4: migrate routes incrementally and run the public fixture suite**

Migrate in this order: kernel task publish/list/get, transcript, direct exec, batch/status/optimizer/memory administration; then jobs; then lineage; then triggers. After each group, rerun its corresponding route suite and compare the Task 1 baseline fixtures. Fix a difference by deliberate compatibility translation or a reviewed API-version decision.

- [ ] **Step 5: make raw runtime fields private to assembly consumers**

Change `KernelRuntime` so its gateway-facing outward API is the facade plus lifecycle coordination. If bootstrap still needs concrete adapters, hold them in a non-exported assembly-local object. `main.ts` is the only place that creates the PTH gateway facade before handing it to `gateway/server.ts`. Do not use TypeScript `private` alone as a boundary if a public factory still returns the object.

- [ ] **Step 6: run focused checks and commit**

```bash
npx vitest run test/pth-application/pth-gateway-facade.test.ts test/pth-gateway/kernel-routes.test.ts test/pth-gateway/jobs-routes.test.ts test/pth-gateway/lineage-routes.test.ts test/pth-gateway/trigger-routes.test.ts test/pth-kernel-assembly/assembly.test.ts
npm run lint
git add -- src/pth/application/gateway src/pth/kernel/assembly.ts src/pth/gateway src/pth/main.ts test/pth-application test/pth-gateway test/pth-kernel-assembly
git diff --cached --check
git commit -m "refactor(pth): place gateway behind route facades"
```

## Task 5: Enforce dependency direction and remove transitional imports

**Files:**

- Create: `scripts/check-pth-boundaries.ts`
- Create: `test/pth-architecture/phase-1-boundaries.test.ts`
- Modify: `package.json`
- Modify: `docs/pth/development.md`
- Modify: `src/pth/impls/kernels/kernel-manager.ts`
- Modify: `src/pth/impls/kernels/ts-interpreter.ts`
- Modify: `src/pth/impls/kernels/python-interpreter.ts`
- Modify: `src/pth/impls/kernels/capability.ts`
- Modify: `src/pth/impls/kernels/index.ts`
- Modify: `src/pth/kernel/exec-channel.ts`
- Modify: `src/pth/kernel/execution/archive.ts`
- Modify: `src/pth/kernel/execution/batch-process.ts`
- Modify: `src/pth/kernel/execution/refiner.ts`
- Modify: `src/pth/kernel/execution/worker-cluster.ts`
- Modify: `src/pth/kernel/ptc/runner.ts`
- Modify: `src/pth/kernel/interpreter/ext-capability.ts`

- [ ] **Step 1: write failing boundary examples**

The checker test must reject at least these cases:

```ts
// illegal: a domain module importing a concrete sandbox adapter
import { SandboxKernel } from "@away_from/pth-sandbox";

// illegal: a gateway handler importing a raw storage adapter
import { PgTaskStore } from "../kernel/storage/task-store-pg.js";
```

It must allow `bootstrap` to import adapters and allow `pth-sandbox` to re-export contract types.

- [ ] **Step 2: run and confirm failure**

Run: `npx vitest run test/pth-architecture/phase-1-boundaries.test.ts`

Expected: FAIL until the checker and a deliberate test fixture are present.

- [ ] **Step 3: implement static import checks and CI script**

Implement a deterministic scanner over `src/pth/` and `packages/`. The rules must cover:

1. `src/pth/gateway/**` does not import `KernelRuntime`, and contains no `kernel.dataWorld`, `kernel.pool` or `kernel.batchManager` access.
2. PTH business protocols import from `@away_from/pth-contracts`, not `@away_from/pth-sandbox`.
3. Direct `@away_from/pth-sandbox` runtime adapter imports are allowed only in `src/pth/impls/kernels/**`, `src/pth/main.ts`, `src/pth/core/agent-engine.ts`, `src/pth/gateway/routes-debug.ts` and `src/pth/gateway/routes-self.ts` until later plans replace them.
4. No new module-level registry singleton is added outside bootstrap construction.
5. The new `tasking`, `runner`, `execution`, `knowledge`, `catalog`, `operations`, `session` directories import contracts or another module's public API, never another module's storage adapter.

Add `npm run check:pth-boundaries` and make CI run it after typecheck.

- [ ] **Step 4: remove compatibility imports only after zero production violations**

Search with:

```bash
rg -n 'from "@away_from/pth-sandbox"|from .*storage/(task-store-pg|audit-store|transcript-store)' src/pth
```

Every result must be either an adapter/bootstrap import permitted by the checker or be migrated. Do not remove sandbox re-exports until all first-party consumers are migrated and a separate deprecation release window has elapsed.

- [ ] **Step 5: run Phase 1 exit matrix and commit**

```bash
npx vitest run packages/pth-contracts/test test/pth-application test/pth-architecture test/pth-gateway test/pth-kernel-assembly test/pth-kernel-storage test/pth-kernel-interpreter packages/pth-sandbox/test
npm run check:pth-boundaries
npm run lint
npm run build
git add -- scripts/check-pth-boundaries.ts test/pth-architecture/phase-1-boundaries.test.ts package.json docs/pth/development.md src/pth packages/pth-contracts
git diff --cached --check
git commit -m "test(pth): enforce modular import boundaries"
```

## Completion criteria

- `@away_from/pth-contracts` builds independently and exports only pure protocols and port interfaces.
- Existing `@away_from/pth-sandbox` consumers remain type-compatible through deprecated re-exports during the agreed compatibility window.
- Gateway routes use `PthGatewayFacade` route APIs; no route reaches `pg.Pool`, `DataWorldAccess`, concrete task store or concrete sandbox client directly.
- `DataWorldAccess` remains only as a deprecated assembly compatibility object and is absent from new module constructors.
- The import checker has zero production violations and is part of CI.
