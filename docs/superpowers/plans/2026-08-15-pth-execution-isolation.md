> **Retirement notice（2026-08-16）**：本计划已由 `2026-08-15-pth-modularization-v2.md` 取代，
> 仅保留为历史参考，不再作为执行依据。

# PTH Execution 与 Sandbox 隔离整改 Implementation Plan（参考计划）

> **计划状态：参考计划（Reference-only）** —— 本文件仅作架构与实施思路参考，当前不作为执行依据；实施前必须重新评审可行性并另建可执行计划。
>
> **For agentic workers:** 请勿直接按本计划 checkbox 开工。若后续决定实施，需先转为可执行计划，再使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。

**Goal:** 将 PTH 的语言执行收敛到 `ExecutionPort`，用 scope/lease-bound `ExecutionGrant`、不可猜测 sandbox lease、受控 workspace broker 和可信 controller/workload 隔离，替换全局 sandbox shared secret、可预测 kernel ID、未授权 memory bridge、跨租户共享工作区和 timeout/release 竞态。

**Architecture:** PTH Runner 通过 `SandboxExecutionAdapter` 调用 sandbox controller。Bootstrap 签发短期、签名的 `ExecutionGrant`；controller 验证并消费 grant，创建不可预测的 `SandboxLease`，控制 kernel pool、workspace broker 和 workload。执行代码只在非特权 workload 身份下运行，无法读取 controller 密钥、controller socket、PTH DB 凭据或其他 workspace。controller 对 PTH 的知识访问通过受限、grant-bound broker 进行；旧 `/api/v1/kernel/memory-bridge` 与 `SANDBOX_SHARED_SECRET` 协议被移除而非保留可选回退。

**Tech Stack:** Node.js 22、TypeScript 5.7、Fastify、PostgreSQL/Redis（lease/grant 状态）、Docker/Compose、Unix permissions、Vitest、Docker clean-build/integration tests。

## Global Constraints

- 前置条件：完成 [Contracts 与边界迁移](2026-08-15-pth-contracts-boundaries.md) 和 [Task Control 与 Runner 分离](2026-08-15-pth-tasking-runner.md) 的退出门禁；本计划不得让旧共享密钥路径作为生产 fallback。
- `ExecutionGrant` 必须绑定 `TenantScope`、`WorkspaceRef`、`TaskLease`、language、capability set、generation、issued/deadline 与不可重放 nonce。它必须由可信 bootstrap/controller 签发/验证，不得由 HTTP body 或任务代码构造。
- 仅 sandbox controller 可以读取 grant-verification key、controller secret、workspaces root 和调度状态；不可信 workload 进程的 env 必须为 allowlist，不能继承 `process.env`。
- 外部 API、sandbox kernel API、raw exec API 和 memory bridge 不得接受仅凭 `kernelId`、`space`、cwd、默认 secret 或可猜测 sequence ID 的授权。每次操作必须验证当前 sandbox lease 及其 generation。
- 释放必须是一个确认后的状态转换：client abort → controller cancel/ack → process/kernel cleanup → release。不得在未确认 server execution 已停止时把 entry 重新分配给另一个 worker。
- Pool sweep 不得把 in-use entry 标为 idle。过期 active lease 只能进入 cancelling/disposed，等待执行停止并销毁 entry 后才允许容量被再次使用。
- Workspace 的路径只能由 broker/adapters 处理；contracts、route payload、task code、logs 和 artifact refs 不得泄露宿主绝对路径或其他租户目录。
- sandbox 镜像、compose 和 declarative deployment 的修复必须来自 clean checkout；本机未跟踪 `dist`、旧 extensions 或缓存不得掩盖构建失败。
- 每个任务先写失败测试，分别提交；当前工作树里与本计划无关的 Docker/mailbox/dev-container 迁移不得被暂存。

---

## Task 1: Add an execution module and grant issuance/verification protocol

**Files:**

- Create: `src/pth/execution/authorization/execution-grant-service.ts`
- Create: `src/pth/execution/authorization/grant-key-provider.ts`
- Create: `src/pth/execution/adapters/sandbox-execution-adapter.ts`
- Create: `src/pth/execution/execution-service.ts`
- Create: `src/pth/execution/index.ts`
- Create: `test/pth-execution/execution-grant-service.test.ts`
- Create: `test/pth-execution/sandbox-execution-adapter.test.ts`
- Create: `packages/pth-sandbox/src/authorization/grant-verifier.ts`
- Create: `packages/pth-sandbox/test/grant-verifier.test.ts`
- Modify: `packages/pth-contracts/src/execution.ts`
- Modify: `packages/pth-contracts/src/index.ts`
- Modify: `packages/pth-sandbox/package.json`
- Modify: `package.json`, `tsconfig.json`, `vitest.config.ts`, `package-lock.json`

**Interfaces:**

- Produces: `ExecutionPort`, `ExecutionGrantIssuer`, `ExecutionGrantVerifier`, `SandboxExecutionAdapter`.
- Consumes: Task Control's persisted `TaskLease`; no Fastify request or raw environment is accepted at this boundary.

- [ ] **Step 1: write grant validation and replay tests**

```ts
// test/pth-execution/execution-grant-service.test.ts
import { describe, expect, it } from "vitest";
import { ExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";

it("issues a signed, short-lived grant bound to lease, scope and workspace", async () => {
  const service = new ExecutionGrantService({ keys: fixedTestKeys(), clock: () => new Date("2030-01-01T00:00:00.000Z") });
  const grant = await service.issue({ lease: fakeLease({ generation: 7 }), language: "python", capabilities: ["memory.read"], ttlMs: 30_000 });
  expect(await service.verify(grant, { lease: fakeLease({ generation: 7 }) })).toMatchObject({ ok: true });
  expect(await service.verify(grant, { lease: fakeLease({ generation: 8 }) })).toMatchObject({ ok: false, reason: "generation-mismatch" });
});

it("rejects expiration, tenant/workspace mismatch and a replayed nonce", async () => {
  const service = new ExecutionGrantService({ keys: fixedTestKeys(), clock: controlledClock() });
  const grant = await service.issue({ lease: fakeLease(), language: "bash", capabilities: [], ttlMs: 1_000 });
  expect(await service.consume(grant)).toMatchObject({ ok: true });
  expect(await service.consume(grant)).toMatchObject({ ok: false, reason: "replayed" });
});
```

The sandbox verifier tests must use only a public/verification key or an injected test key and prove that a malformed signature, wrong key ID, expired clock, wrong tenant/workspace, wrong language, unsupported capability and reused nonce are rejected.

- [ ] **Step 2: run tests and confirm initial failure**

Run: `npx vitest run test/pth-execution/execution-grant-service.test.ts packages/pth-sandbox/test/grant-verifier.test.ts`

Expected: FAIL because PTH has no execution module and sandbox uses `SANDBOX_SHARED_SECRET`.

- [ ] **Step 3: make grants signed and key-managed**

Use a versioned key ID and a standard signed-token implementation supported by the chosen dependency set. The private signing key is read by PTH bootstrap from a secret file/managed secret provider; sandbox controller receives only verification material where asymmetric signing is used. If symmetric HMAC is retained for an initial deployment, the shared key must be mounted as a controller-only secret file and never injected into workload or ordinary PTH request environments. There is no `sandbox-dev-secret` default.

```ts
export interface ExecutionGrantIssuer {
  issue(input: {
    lease: TaskLease;
    language: ExecutionLanguage;
    capabilities: readonly ExecutionCapability[];
    ttlMs: number;
  }): Promise<SignedExecutionGrant>;
}

export interface ExecutionGrantVerifier {
  verify(token: SignedExecutionGrant, expected: {
    lease: Pick<TaskLease, "taskId" | "leaseId" | "generation">;
    scope: TenantScope;
    workspace: WorkspaceRef;
    language: ExecutionLanguage;
  }): Promise<{ ok: true; grant: ExecutionGrant } | { ok: false; reason: GrantFailureReason }>;
  consume(grant: ExecutionGrant): Promise<{ ok: true } | { ok: false; reason: "replayed" | "expired" }>;
}
```

The consumed nonce record must have TTL at least through grant expiry plus clock-skew allowance. `ExecutionGrant` remains a typed value in contracts; signing key material, token serialization and replay store are adapter details. Do not make a `grant?` optional field on the old secret API.

- [ ] **Step 4: implement the PTH adapter against a typed controller client**

`SandboxExecutionAdapter` implements `ExecutionPort`. It accepts a validated request plus signed grant, sends the grant only to the controller, uses no global secret header, and returns a bounded `ExecutionResult`. The adapter may retain a trusted sandbox lease internally for one runner task, but code executing inside that lease never sees the token or controller credentials.

- [ ] **Step 5: run type/contract tests and commit**

```bash
npx vitest run test/pth-execution/execution-grant-service.test.ts test/pth-execution/sandbox-execution-adapter.test.ts packages/pth-sandbox/test/grant-verifier.test.ts
npm run lint
git add -- src/pth/execution packages/pth-sandbox/src/authorization packages/pth-sandbox/test/grant-verifier.test.ts packages/pth-contracts package.json package-lock.json tsconfig.json vitest.config.ts packages/pth-sandbox/package.json
git diff --cached --check
git commit -m "feat(execution): introduce signed execution grants"
```

## Task 2: Make sandbox kernel allocation lease-safe and race-free

**Files:**

- Create: `packages/pth-sandbox/src/kernel-lease.ts`
- Create: `packages/pth-sandbox/test/kernel-lease.test.ts`
- Modify: `packages/pth-sandbox/src/kernel-pool.ts`
- Modify: `packages/pth-sandbox/src/kernel-host.ts`
- Modify: `packages/pth-sandbox/src/sandbox-kernel.ts`
- Modify: `packages/pth-sandbox/src/kernel/interpreter/types.ts` or its contracts re-export
- Modify: `packages/pth-sandbox/test/sandbox-kernel-host.test.ts`
- Modify: `packages/pth-sandbox/test/sandbox-kernel.test.ts`
- Modify: `packages/pth-sandbox/test/sandbox-kernel-abort.test.ts`

**Interfaces:**

- Produces: controller-only `KernelLease` state machine and client-visible opaque `SandboxLease`.
- Retires: sequential `py-N` / `sh-N` external identifiers and release by bare kernel ID.

- [ ] **Step 1: write ownership, generation and TTL-race failures**

```ts
it("does not reassign an executing entry when the entry TTL expires", async () => {
  const pool = new KernelPool({ lang: "python", max: 1, entryTtlMsMs: 10, clock: fakeClock() });
  const first = await pool.acquire(fakeGrant());
  const running = pool.execute(first, "await never()", { timeoutMs: 60_000 });
  advanceClock(20);
  await pool.sweepForTest();
  await expect(pool.acquire(fakeGrant())).rejects.toThrow(/exhausted|cancelling/);
  await pool.cancel(first);
  await expect(running).resolves.toMatchObject({ ok: false });
});

it("rejects execute, reset, snapshot and release with a stale lease generation", async () => {
  const lease = await pool.acquire(fakeGrant());
  await pool.release(lease);
  const next = await pool.acquire(fakeGrant());
  await expect(pool.execute(lease, "1")).rejects.toThrow(/stale lease/);
  expect(next.id).not.toBe(lease.id);
});
```

Add tests for lease owner/scope mismatch, an invalid grant acquiring nothing, reset awaiting kernel cleanup, release idempotency for the same lease and rejection for a different lease, and pool status without raw kernel IDs.

- [ ] **Step 2: verify failure**

Run: `npx vitest run packages/pth-sandbox/test/kernel-lease.test.ts packages/pth-sandbox/test/sandbox-kernel-host.test.ts`

Expected: FAIL because the pool exposes predictable IDs and sweep marks an in-use entry idle without invalidating the owner.

- [ ] **Step 3: implement a controller-owned lease state machine**

```ts
export interface SandboxLease {
  readonly id: string;
  readonly generation: number;
  readonly expiresAt: string;
}

type LeaseState = "active" | "cancelling" | "released" | "disposed";

interface PoolEntry {
  readonly internalId: string;
  readonly kernel: Interpreter;
  lease: { id: string; generation: number; expiresAt: number; scope: TenantScope } | null;
  state: LeaseState;
}
```

Generate `internalId` and `SandboxLease.id` using cryptographically secure UUIDs in the controller. `KernelPool.acquire()` validates and consumes a grant first, then binds an entry to its task lease/scope/generation. Every execute/reset/snapshot/cancel/release validates the exact sandbox lease token and generation; raw internal ID never crosses HTTP.

For an expired active lease, atomically transition `active → cancelling`, issue cancellation, await process/kernel termination and mark the entry `disposed`; create a fresh entry only after cleanup. Never set it idle or wake a waiter until the old owner has been invalidated and the old process is gone. Idle reaping is separate and can only dispose an entry whose state is released.

- [ ] **Step 4: upgrade the HTTP protocol and PTH client together**

Replace `/kernel/acquire {lang}` response `{kernelId}` with a grant-validated acquire returning opaque `SandboxLease`; all subsequent endpoints accept `{lease, ...}`. Keep a temporary adapter only in test fixtures, not as an HTTP compatibility path reachable in production. Change `SandboxKernel` to hold the lease and use fully async `reset`, `dispose`, `cancel`/`abort`; remove `disposeAndFlush` as a separate correctness escape hatch once `dispose` itself is awaitable.

- [ ] **Step 5: run pool, host and abort regression suites**

```bash
npx vitest run packages/pth-sandbox/test/kernel-lease.test.ts packages/pth-sandbox/test/sandbox-kernel-host.test.ts packages/pth-sandbox/test/sandbox-kernel.test.ts packages/pth-sandbox/test/sandbox-kernel-abort.test.ts packages/pth-sandbox/test/py-kernel.test.ts packages/pth-sandbox/test/bash-kernel.test.ts
npm run lint
```

- [ ] **Step 6: commit lease-safe allocation**

```bash
git add -- packages/pth-sandbox/src/kernel-lease.ts packages/pth-sandbox/src/kernel-pool.ts packages/pth-sandbox/src/kernel-host.ts packages/pth-sandbox/src/sandbox-kernel.ts packages/pth-sandbox/src/kernel/interpreter/types.ts packages/pth-sandbox/test
git diff --cached --check
git commit -m "fix(sandbox): bind kernel pool to opaque leases"
```

## Task 3: Separate trusted controller from untrusted workload and broker workspaces

**Files:**

- Create: `src/pth/execution/workspace-broker.ts`
- Create: `src/pth/execution/workspace-policy.ts`
- Create: `src/pth/execution/adapters/sandbox-workspace-broker.ts`
- Create: `test/pth-execution/workspace-broker.test.ts`
- Create: `packages/pth-sandbox/src/workload/workload-launcher.ts`
- Create: `packages/pth-sandbox/src/workload/environment.ts`
- Create: `packages/pth-sandbox/src/workload/workspace-mount.ts`
- Create: `packages/pth-sandbox/test/workload-isolation.test.ts`
- Modify: `packages/pth-sandbox/src/kernel-host.ts`
- Modify: `packages/pth-sandbox/src/exec-api.ts`
- Modify: `packages/pth-sandbox/Dockerfile.sandbox`
- Modify: `deploy/docker-compose.yaml`

**Interfaces:**

- Produces: `WorkspaceBroker`, workload launcher and controller-only control channel.
- Retires: global `/data/workspaces` availability to all workload code and environment inheritance from controller.

- [ ] **Step 1: write cross-tenant, credential and filesystem negative tests**

```ts
it("gives one execution only its own opaque workspace and allowlisted environment", async () => {
  const mount = await broker.open(fakeGrant({ tenantId: "tenant-a", workspaceId: "ws-a" }));
  const launched = await launcher.start({ mount, command: ["sh", "-lc", "env; ls -la .."] });
  expect(launched.environment).not.toHaveProperty("SANDBOX_SHARED_SECRET");
  expect(launched.environment).not.toHaveProperty("DATABASE_URL");
  expect(await launched.read("../tenant-b/secret.txt")).toMatchObject({ ok: false });
});

it("does not let workload code reach the controller control socket", async () => {
  const result = await launchUntrusted("test -e /run/pth-sandbox/controller.sock && cat /run/pth-sandbox/controller.sock");
  expect(result.exitCode).not.toBe(0);
});
```

Also test symlink escape, artifact copy-out, cleanup after cancel, a process trying to inspect parent/controller environment, and a workload unable to call raw `/kernel/*` endpoints with no trusted lease channel.

- [ ] **Step 2: run and establish failure**

Run: `npx vitest run test/pth-execution/workspace-broker.test.ts packages/pth-sandbox/test/workload-isolation.test.ts`

Expected: FAIL because all workloads share the `workspaces` volume and child processes inherit controller `process.env`.

- [ ] **Step 3: choose and implement a controller-owned workspace model**

`WorkspaceBroker.open(grant)` resolves an opaque ref only after verifying the grant and creates an execution-specific directory keyed by tenant/task/lease/generation. It copies or binds only approved task input, exposes a single working root to workload, validates canonical paths at every artifact/import boundary, and returns opaque artifact references to PTH. The broker retains the global storage mount; workload receives neither the global root nor the raw ref-to-path mapping.

The sandbox controller runs as a trusted service account. It launches workload under a distinct unprivileged account with an explicit env allowlist (`PATH`, language runtime variables, locale and per-execution nonsecret limits only), no Docker socket, no host IPC credentials, no PTH connection settings and no secret file mounts. The controller control socket/file must be owned by controller UID/group and inaccessible to workload. Ensure controller, workload and cleanup behavior work in the target Linux container runtime; a unit-only UID mock is not sufficient.

- [ ] **Step 4: route all exec modalities through the launcher**

Move Python/Bash kernel subprocesses, compiled C commands and raw `/exec` execution behind the same workload launcher or a documented equivalent isolation mechanism. The old raw exec endpoint must require a verified grant/lease and broker workspace; `cwd` becomes an internal relative path selected/validated by the broker, not a client-supplied absolute path. Replace `env: { ...process.env, ... }` with the explicit allowlist.

- [ ] **Step 5: run Linux-container integration tests**

```bash
npx vitest run test/pth-execution/workspace-broker.test.ts packages/pth-sandbox/test/workload-isolation.test.ts packages/pth-sandbox/test/sandbox-exec-api.test.ts packages/pth-sandbox/test/sandbox-compiled-kernel.test.ts
docker build --no-cache -f packages/pth-sandbox/Dockerfile.sandbox .
```

Expected: no workload can observe another tenant's files or trusted credentials; clean build succeeds without local artifacts.

- [ ] **Step 6: commit trusted/untrusted separation**

```bash
git add -- src/pth/execution/workspace-broker.ts src/pth/execution/workspace-policy.ts src/pth/execution/adapters/sandbox-workspace-broker.ts packages/pth-sandbox/src/workload packages/pth-sandbox/src/kernel-host.ts packages/pth-sandbox/src/exec-api.ts packages/pth-sandbox/Dockerfile.sandbox deploy/docker-compose.yaml test/pth-execution packages/pth-sandbox/test
git diff --cached --check
git commit -m "fix(sandbox): isolate workloads and broker workspaces"
```

## Task 4: Replace memory bridge and timeout/release races with scoped execution mediation

**Files:**

- Create: `src/pth/execution/knowledge-broker.ts`
- Create: `src/pth/execution/adapters/pth-knowledge-broker.ts`
- Create: `test/pth-execution/knowledge-broker.test.ts`
- Create: `packages/pth-sandbox/test/cancel-release-race.test.ts`
- Modify: `src/pth/gateway/auth.ts`
- Modify: `src/pth/gateway/routes-kernel.ts`
- Modify: `src/pth/gateway/server.ts`
- Modify: `packages/pth-sandbox/src/kernel-host.ts`
- Modify: `packages/pth-sandbox/src/sandbox-kernel.ts`
- Modify: `packages/pth-sandbox/src/exec-api.ts`
- Modify: `packages/pth-sandbox/test/sandbox-exec-api.test.ts`
- Modify: `test/pth-gateway/kernel-routes.test.ts`

**Interfaces:**

- Produces: grant-bound `KnowledgeBroker`, explicit cancel confirmation and bounded execution result protocol.
- Retires: unauthenticated-exempt `/api/v1/kernel/memory-bridge`, request-body `space` authority, arbitrary bridge SQL and 10-second client deadline for 300-second execution.

- [ ] **Step 1: write public-route and cancellation race failures**

```ts
it("never returns memory when a grant lacks the tenant and memory.read capability", async () => {
  const response = await internalExecutionMemoryRequest({ grant: signedGrant({ capabilities: [] }), op: "retrieve" });
  expect(response.statusCode).toBe(403);
  expect(response.body).not.toContain("memory entry");
});

it("cancels and confirms server stop before releasing a sandbox lease", async () => {
  const controller = deferredController();
  const kernel = new SandboxKernel({ client: controller, language: "python" });
  const running = kernel.execute("long_running()", { timeoutMs: 300_000 });
  await kernel.abort();
  expect(controller.calls).toEqual(["execute", "cancel", "await-cancelled", "release"]);
  await expect(running).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
});
```

Add a test that an aborted client cannot release an in-flight lease into a second acquisition, timeout is bounded by grant deadline, stdout/stderr are capped with a truncation marker, and descendant processes are reaped before final lease release.

- [ ] **Step 2: verify failure**

Run: `npx vitest run test/pth-execution/knowledge-broker.test.ts packages/pth-sandbox/test/cancel-release-race.test.ts test/pth-gateway/kernel-routes.test.ts`

Expected: FAIL because `/memory-bridge` bypasses regular auth, defaults to a global secret model, does not require scope when `space` is absent, and SandboxKernel releases after local abort without server acknowledgement.

- [ ] **Step 3: remove the old bridge rather than wrapping it**

Remove `/api/v1/kernel/memory-bridge` from the auth exemption and remove its shared-secret handling. Replace it with a controller-only, internal execution knowledge operation that accepts a verified grant and has no caller-supplied visibility field. Its allowed operations are fixed, typed `KnowledgeQueries` (for example `retrieve` and `get`); arbitrary user SQL is not an execution capability. The broker derives tenant, allowed scopes and trace from the grant and fails closed when metadata cannot be verified.

The sandbox controller invokes this broker only through a trusted controller channel. Workload code cannot directly call PTH endpoints, cannot access a grant bearer token, and cannot inject a tenant/space. Regular gateway auth remains mandatory for all ordinary HTTP routes.

- [ ] **Step 4: implement cancellation as a controller state transition**

On PTH client timeout/abort, send `cancel(lease)` and await controller acknowledgement that execution and child process group have stopped. Only then call `release(lease)`. If control-channel loss prevents acknowledgement, leave the entry cancelling/disposed and let controller cleanup reclaim it; never return it to idle optimistically. Set client transport timeout from the smaller of grant deadline and requested execution timeout plus an explicit cleanup margin, never the historical unconditional 10 seconds.

Bound stdout/stderr/value collection at the controller as data is received; return a contract truncation marker. Kill/reap the entire process group, wait for close, then mark execution stopped. Do not use only a fetch abort as evidence that work stopped.

- [ ] **Step 5: run bridge, cancel and output-control tests**

```bash
npx vitest run test/pth-execution/knowledge-broker.test.ts packages/pth-sandbox/test/cancel-release-race.test.ts packages/pth-sandbox/test/sandbox-kernel-abort.test.ts packages/pth-sandbox/test/sandbox-exec-api.test.ts test/pth-gateway/kernel-routes.test.ts
npm run lint
```

- [ ] **Step 6: commit mediation and cancellation correctness**

```bash
git add -- src/pth/execution/knowledge-broker.ts src/pth/execution/adapters/pth-knowledge-broker.ts src/pth/gateway/auth.ts src/pth/gateway/routes-kernel.ts src/pth/gateway/server.ts packages/pth-sandbox/src/kernel-host.ts packages/pth-sandbox/src/sandbox-kernel.ts packages/pth-sandbox/src/exec-api.ts packages/pth-sandbox/test test/pth-execution test/pth-gateway
git diff --cached --check
git commit -m "fix(execution): mediate memory and cancellation by grant"
```

## Task 5: Make sandbox images and deployment wiring secure and reproducible

**Files:**

- Modify: `packages/pth-sandbox/Dockerfile.sandbox`
- Modify: `deploy/docker-compose.yaml`
- Modify: `deploy/docker-compose.dev.yaml`
- Modify: `deploy/pth.deployment.json`
- Modify: `packages/framework/src/containers/deployment.ts`
- Modify: `packages/framework/src/ptl/commands/hub.ts` or the actual deployment-config resolver discovered during implementation
- Modify: `scripts/check-sandbox-env.sh`
- Modify: `scripts/sandbox-debug-entry.sh`
- Modify: `package.json`
- Create: `test/deploy/sandbox-compose-security.test.ts`
- Create: `test/deploy/declarative-deployment-render.test.ts`
- Create: `scripts/verify-clean-sandbox-build.sh`

**Interfaces:**

- Produces: clean-buildable sandbox image, controller-only secret mount, profile-compatible network/volume declarations and deploy render checks.
- Retires: default `SANDBOX_SHARED_SECRET`, public sandbox/control port exposure, compose-only assumptions omitted by declarative renderer, incorrect security-check file path.

- [ ] **Step 1: write static deployment and clean-build failures**

```ts
it("does not publish sandbox control ports or a default shared secret", () => {
  const compose = loadCompose("deploy/docker-compose.yaml");
  expect(compose.services.sandbox.ports ?? []).toEqual([]);
  expect(JSON.stringify(compose)).not.toContain("sandbox-dev-secret");
  expect(compose.services.sandbox.networks).toContain("pth-internal");
});

it("renders the same PTH/sandbox shared network from the declarative deployment", async () => {
  const rendered = await renderDeployment("deploy/pth.deployment.json");
  expect(rendered.services["pi-platform"].networks).toContain("pth-internal");
  expect(rendered.services.sandbox.networks).toContain("pth-internal");
});
```

The clean-build script must run from a temporary clean checkout or context that excludes local `dist`; it must fail if `tsconfig.base.json`, required package outputs, or migrated mailbox sources are absent.

- [ ] **Step 2: verify initial failure**

Run: `npx vitest run test/deploy/sandbox-compose-security.test.ts test/deploy/declarative-deployment-render.test.ts`

Expected: FAIL because the current deployment uses the shared-secret model, declarative renderer loses networks, and sandbox clean build relies on incomplete copy/build paths.

- [ ] **Step 3: repair the image build without relying on local artifacts**

Copy `tsconfig.base.json` and every source/package manifest necessary for the build stage. Build every package whose `dist` is copied into runtime, including framework when runtime requires it. Replace the stale `COPY extensions/mailbox` source with the current `packages/mailbox/src` package build or remove it from the image until a valid runtime loader is wired. Correct the debug entrypoint to invoke `ptl`, not `pit`. Make `scripts/check-sandbox-env.sh` inspect `packages/pth-sandbox/Dockerfile.sandbox` and fail on a missing target instead of swallowing the error.

- [ ] **Step 4: make secret, port, network and deployment discovery explicit**

Mount grant key material only into PTH bootstrap and sandbox controller using Docker secrets/read-only file mounts; do not expose it to workload. Sandbox controller has no published host port. PTH's external port is bound only through an explicit ingress/local-development policy, never assumed public by default. Declare the shared internal network explicitly in both Compose and the declarative deployment schema/renderer; add `networks` support to `ServiceSchema` and preserve it in `renderCompose()`.

Make deployment config lookup deterministic: `ptl hub deploy` receives or resolves `deploy/pth.deployment.json` from repository root, and generated compose resolves build contexts relative to its own output directory. Do not claim declarative deployment is the source of truth until its rendered config passes the same network/secret/build validation as hand-written compose.

- [ ] **Step 5: run clean-image and rendered-config checks**

```bash
npx vitest run test/deploy/sandbox-compose-security.test.ts test/deploy/declarative-deployment-render.test.ts
./scripts/verify-clean-sandbox-build.sh
docker compose -f deploy/docker-compose.yaml config
npm run ext:check
```

Expected: clean image build, declarative compose render, shared internal network and sandbox security checks all pass. If extension discovery remains intentionally constrained, the check must distinguish valid non-plugin directories from broken plugins rather than ignore errors.

- [ ] **Step 6: commit reproducible secure deployment**

```bash
git add -- packages/pth-sandbox/Dockerfile.sandbox deploy/docker-compose.yaml deploy/docker-compose.dev.yaml deploy/pth.deployment.json packages/framework/src/containers/deployment.ts packages/framework/src/ptl scripts/check-sandbox-env.sh scripts/sandbox-debug-entry.sh package.json scripts/verify-clean-sandbox-build.sh test/deploy
git diff --cached --check
git commit -m "fix(deploy): harden sandbox build and network wiring"
```

## Task 6: Prove security remediation with hostile integration tests and controlled rollout

**Files:**

- Create: `test/pth-execution/sandbox-security.integration.test.ts`
- Create: `docs/pth/sandbox-security-operations.md`
- Modify: `docs/pth/development.md`
- Modify: `docs/pth/extensions-dev.md`
- Modify: `docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md`
- Modify: `README.md` only if user-facing deployment instructions change

- [ ] **Step 1: create the hostile integration matrix**

Run the following against a disposable Docker Compose deployment with synthetic tenant A/B data:

1. tenant A execution cannot read tenant B workspace, artifact, task, memory, transcript or audit data;
2. malformed, expired, wrong-language, wrong-generation, replayed and revoked grants are rejected;
3. workload cannot read controller/PTH secret files, env, socket, database URL or Docker socket;
4. raw kernel ID, raw `space`, old `memory-bridge` URL and default shared secret cannot authorize execution or memory;
5. cancel, transport abort, controller timeout, pool expiry and worker crash never reassign a live REPL; stale lease calls fail;
6. recursive descendants are reaped, output flood is truncated, and resource metrics show cleanup;
7. controller and PTH use only the expected internal network; sandbox control is not host-published.

- [ ] **Step 2: establish deployment observability before rollout**

Add metrics/logs for grant validation failures, grant replay, lease state transitions, cancellation duration, forced disposal, workspace broker rejects, output truncation and observer-facing execution outcome. Do not log signed grant bodies, raw workspace paths, task source code or secret values.

- [ ] **Step 3: write operations guidance and rollback policy**

Document key rotation, controller health, lease-drain procedure, revocation/replay response, workspace cleanup, incident evidence and safe rollback. Rollback may select a prior image only in an isolated development environment; it must not restore the shared-secret/public-memory-bridge behavior in production.

- [ ] **Step 4: run full release gate**

```bash
npx vitest run test/pth-execution packages/pth-sandbox/test test/deploy test/pth-gateway/kernel-routes.test.ts
npm run check:pth-boundaries
npm run lint
npm run build
npm pack --dry-run
./scripts/verify-clean-sandbox-build.sh
docker compose -f deploy/docker-compose.yaml config
```

- [ ] **Step 5: commit evidence and documentation**

```bash
git add -- test/pth-execution/sandbox-security.integration.test.ts docs/pth/sandbox-security-operations.md docs/pth/development.md docs/pth/extensions-dev.md docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md README.md
git diff --cached --check
git commit -m "test(sandbox): prove execution isolation remediation"
```

## Completion criteria

- `ExecutionPort` is the only PTH execution seam; sandbox is a verified adapter, not the owner of PTH domain protocols.
- Every execution is authorized by a short-lived, scope/lease/workspace/language-bound grant and a non-replayable sandbox lease; no known default secret, sequence ID or request field serves as authority.
- No active kernel entry is reissued while its prior execution can still run; cancel/timeout/release has verified state transitions.
- Workloads cannot access controller/PTH secrets, global workspaces, other tenants' files, controller APIs or unrestricted memory.
- The old public memory bridge/shared-secret protocol is absent from production paths.
- Sandbox image and both hand-written/declarative deployment paths pass clean-build, network and secret validation.
