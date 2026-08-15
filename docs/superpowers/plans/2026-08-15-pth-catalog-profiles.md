# PTH Runtime Catalog 与 Product Profiles Implementation Plan（参考计划）

> **计划状态：参考计划（Reference-only）** —— 本文件仅作架构与实施思路参考，当前不作为执行依据；实施前必须重新评审可行性并另建可执行计划。
>
> **For agentic workers:** 请勿直接按本计划 checkbox 开工。若后续决定实施，需先转为可执行计划，再使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。

**Goal:** 用启动期构建的、不可变 `RuntimeCatalog` 取代角色/空间/扩展的模块级全局注册表，并用显式 PTH Host manifests 交付 Control、Standard、Full 三种静态产品 Profile；private deployment 作为策略 overlay，而不是第四套 fork。

**Architecture:** `catalog` 拥有 roles、spaces、capability policy 和批准扩展 contribution 的启动快照；`bootstrap` 拥有 profile 选择、配置验证、module/adapters 装配与生命周期；每个 API Host 和 runner Host 由同一 Profile manifest 构建相同 catalog。扩展只能经过受限贡献协议进入 catalog：一方模块可在部署期明确启用，toolstore 扩展只能使用受限 SDK；没有真实宿主行为的 manifest 字段被拒绝而非假装激活。

**Tech Stack:** Node.js 22、TypeScript 5.7、Fastify、npm workspaces、Vitest、Docker Compose、PTH extension/toolstore SDK。

## Global Constraints

- 前置条件：完成 [Contracts 与边界](2026-08-15-pth-contracts-boundaries.md)、[Task Control 与 Runner](2026-08-15-pth-tasking-runner.md) 和 [Execution 与 sandbox 隔离](2026-08-15-pth-execution-isolation.md) 的退出门禁。
- `RuntimeCatalogSnapshot` 是不可变值；角色、空间、capability policy、extension allowlist 不得由模块级 singleton、后门 mutation 或任务代码在运行中修改。
- 只有 bootstrap/PTH Host 能选择 Profile、adapter、可信模块和启用的 extension ID；Profile 仅在启动/部署时选择，不能由 HTTP 请求、task payload 或未受信任 extension 动态卸载/加载业务模块。
- Control、Standard、Full 是静态 module manifests。private deployment 是同一 profile 的 adapter/configuration overlay（model/storage/secret/egress/extension/audit policy），不得用 fork 或条件散落在业务逻辑中。
- catalog/extension code不得拿到 `PthHost`、`pg.Pool`、Fastify app、sandbox grant key、controller client 或 raw `process.env`。每类 extension context 只提供其经过 capability policy 的最小 API。
- 当前 `ExtRegistry.loadAll()` 只真正处理部分 contribution，且 assembly/batch process 会丢弃 registry。不要继续文档化 `onStartup`、tools、capabilities、events、kernels、debugAdapters 为可用语义，除非本计划对应任务实现并测试了端到端宿主调用。
- 启动依赖缺失、未知 profile、未批准 extension、manifest/version 不兼容和非法 policy 必须 fail closed；不得悄悄回退到 Full、全局 registry 或任意 toolstore scan。
- 保留当前默认部署兼容：未设置 `PTH_PROFILE` 时先显式映射为 `full`，同时输出一次结构化迁移诊断；默认值不得暗含任意扩展全启用。
- 每个任务按 TDD 单独提交，且只暂存本任务列出的文件。不要把现有未相关的 dev-container/mailbox/compose 迁移混入提交。

---

## Task 1: Define catalog and Profile contracts as immutable startup values

**Files:**

- Create: `packages/pth-contracts/src/catalog.ts`
- Create: `packages/pth-contracts/src/profiles.ts`
- Create: `packages/pth-contracts/test/catalog-profile-contract.test.ts`
- Modify: `packages/pth-contracts/src/index.ts`
- Create: `src/pth/catalog/runtime-catalog.ts`
- Create: `src/pth/catalog/catalog-builder.ts`
- Create: `src/pth/catalog/capability-policy.ts`
- Create: `test/pth-catalog/runtime-catalog.test.ts`

**Interfaces:**

- Produces: `RuntimeCatalogSnapshot`, `CatalogBuilder`, `ProfileManifest`, `ProfileId`, `DeploymentPolicy`.
- Consumed later by: role/space adapters, extension loader, PTH Host, API and runner bootstrap.

- [ ] **Step 1: write failing immutability and dependency tests**

```ts
// test/pth-catalog/runtime-catalog.test.ts
import { describe, expect, it } from "vitest";
import { RuntimeCatalogBuilder } from "../../src/pth/catalog/catalog-builder.js";

it("freezes a deterministic catalog snapshot after build", () => {
  const builder = new RuntimeCatalogBuilder({ profileId: "standard" });
  builder.addRole({ id: "developer", tags: ["code"] });
  const catalog = builder.build();

  expect(catalog.roles.get("developer")?.id).toBe("developer");
  expect(() => (catalog.roles as Map<string, unknown>).set("intruder", {})).toThrow();
  expect(() => builder.addRole({ id: "late", tags: [] })).toThrow(/built/);
});

it("rejects a profile with a missing required module or adapter", () => {
  expect(() => validateProfileManifest({ id: "standard", modules: ["runner"], adapters: {} } as never)).toThrow(/tasking|execution/);
});
```

Add tests for duplicate role/space/extension IDs, invalid capability declarations, profile-specific forbidden modules, deterministic ordering and private policy overlay validation.

- [ ] **Step 2: run and verify failure**

Run: `npx vitest run packages/pth-contracts/test/catalog-profile-contract.test.ts test/pth-catalog/runtime-catalog.test.ts`

Expected: FAIL because no catalog/profile contracts or builder exists.

- [ ] **Step 3: implement small serializable contracts**

```ts
// packages/pth-contracts/src/catalog.ts
export interface CatalogRole { readonly id: string; readonly tags: readonly string[]; }
export interface CatalogSpace { readonly id: string; readonly policyId: string; }
export interface RuntimeCatalogSnapshot {
  readonly profileId: ProfileId;
  readonly version: string;
  readonly roles: ReadonlyMap<string, CatalogRole>;
  readonly spaces: ReadonlyMap<string, CatalogSpace>;
  readonly enabledExtensions: readonly string[];
  readonly capabilityPolicy: CapabilityPolicySnapshot;
}
```

```ts
// packages/pth-contracts/src/profiles.ts
export type ProfileId = "control" | "standard" | "full";
export type PthModuleId = "tasking" | "runner" | "execution" | "knowledge" | "catalog" | "operations" | "session" | "programs" | "workflow";

export interface ProfileManifest {
  readonly id: ProfileId;
  readonly modules: readonly PthModuleId[];
  readonly requiredAdapters: readonly string[];
  readonly enabledExtensionIds: readonly string[];
}

export interface DeploymentPolicy {
  readonly model: "managed" | "private";
  readonly storage: "managed" | "private";
  readonly egress: "disabled" | "allowlisted";
  readonly extensionAllowlist: readonly string[];
  readonly auditRetentionDays: number;
}
```

The builder creates copies of collections, freezes records/arrays, returns read-only wrappers and cannot be modified after `build()`. It takes no concrete adapter or extension executable. Keep functions and lifecycle hooks out of serializable contracts; trusted module wiring belongs in bootstrap.

- [ ] **Step 4: run contract and builder tests**

```bash
npx vitest run packages/pth-contracts/test/catalog-profile-contract.test.ts test/pth-catalog/runtime-catalog.test.ts
npm run lint
```

- [ ] **Step 5: commit catalog foundation**

```bash
git add -- packages/pth-contracts/src/catalog.ts packages/pth-contracts/src/profiles.ts packages/pth-contracts/src/index.ts packages/pth-contracts/test/catalog-profile-contract.test.ts src/pth/catalog test/pth-catalog
git diff --cached --check
git commit -m "feat(catalog): add immutable profile contracts"
```

## Task 2: Replace roles, spaces and tag globals with injected catalog snapshots

**Files:**

- Create: `src/pth/catalog/adapters/builtin-catalog-contributions.ts`
- Create: `src/pth/catalog/role-routing-policy.ts`
- Create: `src/pth/catalog/space-lookup.ts`
- Create: `test/pth-catalog/builtin-catalog-contributions.test.ts`
- Modify: `src/pth/kernel/execution/worker-cluster.ts`
- Modify: `src/pth/kernel/execution/space-registry.ts`
- Modify: `src/pth/kernel/execution/tag-registry.ts`
- Modify: `src/pth/kernel/execution/role-router.ts`
- Modify: `src/pth/impls/roles/default-roles.ts`
- Modify: `src/pth/impls/spaces/builtin-spaces.ts`
- Modify: `src/pth/kernel/assembly.ts`
- Modify: `src/pth/kernel/execution/batch-process.ts`
- Modify: `test/pth-kernel-execution/worker-cluster.test.ts`
- Modify: `test/pth-kernel-execution/space-governance.test.ts`
- Modify: `test/pth-kernel-execution/role-weights.test.ts`

**Interfaces:**

- Produces: injected `RoleRoutingPolicy` and `SpaceLookup` backed by `RuntimeCatalogSnapshot`.
- Retires: `setDefaultRoles`, `registerWorkerRole`, `allWorkerRoles`, `spaceRegistry`, `tagRegistry` and `setSpaceLookup` as globally mutable runtime state.

- [ ] **Step 1: write independent-catalog tests**

```ts
it("keeps two Host catalogs independent in one process", () => {
  const control = buildCatalog({ profileId: "control", roles: ["controller"] });
  const standard = buildCatalog({ profileId: "standard", roles: ["developer"] });
  expect(createRoleRoutingPolicy(control).roleFor({ tags: ["code"] })).toBeUndefined();
  expect(createRoleRoutingPolicy(standard).roleFor({ tags: ["code"] })).toBe("developer");
});

it("does not allow a runner to mutate the snapshot it received", () => {
  const catalog = buildCatalog({ profileId: "standard", roles: ["developer"] });
  expect(() => addRoleToCatalog(catalog, "intruder")).toThrow(/immutable/);
});
```

Add a regression that main and a batch child built from the same manifest calculate identical worker roles, tags and spaces without a singleton registration order dependency.

- [ ] **Step 2: run tests and confirm initial failure**

Run: `npx vitest run test/pth-catalog/builtin-catalog-contributions.test.ts test/pth-kernel-execution/worker-cluster.test.ts test/pth-kernel-execution/space-governance.test.ts`

Expected: FAIL because current assembly and batch process mutate separate global role/space registries.

- [ ] **Step 3: build built-ins as catalog contributions**

Translate `ORIGIN_ROLE`, `DEFAULT_ROLES`, `MID_ROLES`, `GOVERNANCE_ROLES` and built-in spaces into explicit data contributions accepted by `RuntimeCatalogBuilder`. Do not import `worker-cluster` merely to register global values. Keep existing role behavior and tag routing exactly, but have `RoleRoutingPolicy` read the injected snapshot.

```ts
export interface RoleRoutingPolicy {
  validate(input: { tags?: readonly string[]; payload?: unknown }): { ok: true } | { ok: false; error: string };
  assign(input: { id: string; tags?: readonly string[]; payload?: unknown }): string;
  workerRoles(): readonly CatalogRole[];
}

export interface SpaceLookup {
  get(id: string): CatalogSpace | undefined;
}
```

- [ ] **Step 4: refactor callers through injection, not fallback globals**

`assembly.ts` creates its catalog once, then gives `RoleRoutingPolicy` to task storage/routing and `SpaceLookup` to PTH memory capability composition. `batch-process.ts` receives the same selected manifest/catalog input and builds its own immutable snapshot using the same contribution set. Do not serialize executable functions over IPC; trusted bootstrap code locally rebuilds from an approved manifest. Remove dynamic side-effect calls that depend on previous global initialization order.

- [ ] **Step 5: retain transitional compatibility only at legacy exports**

If old tests/commands require `worker-cluster` or `space-registry` exports, make them forward to an explicitly injected compatibility catalog in bootstrap test setup. No production module may call a zero-argument global getter. Add deprecation warnings behind a development flag and a boundary test that rejects new uses.

- [ ] **Step 6: run routing/space/batch regression tests and commit**

```bash
npx vitest run test/pth-catalog/builtin-catalog-contributions.test.ts test/pth-kernel-execution/worker-cluster.test.ts test/pth-kernel-execution/space-governance.test.ts test/pth-kernel-execution/role-weights.test.ts test/pth-kernel-execution/task-resolver.test.ts test/pth-kernel-assembly/assembly.test.ts test/pth-kernel-assembly/batch-manager-fork.integration.test.ts
npm run lint
git add -- src/pth/catalog src/pth/kernel/execution/worker-cluster.ts src/pth/kernel/execution/space-registry.ts src/pth/kernel/execution/tag-registry.ts src/pth/kernel/execution/role-router.ts src/pth/impls/roles src/pth/impls/spaces src/pth/kernel/assembly.ts src/pth/kernel/execution/batch-process.ts test/pth-catalog test/pth-kernel-execution test/pth-kernel-assembly
git diff --cached --check
git commit -m "refactor(catalog): inject role and space snapshots"
```

## Task 3: Define real extension contributions and remove fictional activation semantics

**Files:**

- Create: `src/pth/catalog/extensions/contribution-schema.ts`
- Create: `src/pth/catalog/extensions/extension-loader.ts`
- Create: `src/pth/catalog/extensions/extension-context.ts`
- Create: `src/pth/catalog/extensions/extension-policy.ts`
- Create: `test/pth-catalog/extension-loader.test.ts`
- Modify: `src/pth/kernel/extensions/ext-registry.ts`
- Modify: `src/pth/kernel/interpreter/ext-capability.ts`
- Modify: `scripts/ext-check.ts`
- Modify: `test/pth-kernel-execution/ext-registry.test.ts`
- Modify: `test/pth-kernel-execution/extensions-registry.test.ts`
- Modify: `test/pth-kernel-execution/ext-capability.test.ts`
- Modify: `test/pth-kernel-execution/ext-e2e-hello-world.test.ts`
- Modify: `docs/pth/extensions-dev.md`

**Interfaces:**

- Produces: validated `ExtensionContribution`, `ExtensionContext`, allowlist loader and end-to-end activation semantics.
- Retires: blind scan of every `toolstore/extensions/*`, dropped registry after `loadAll()`, undocumented `new Function` activation as a plugin system.

- [ ] **Step 1: write contribution and negative-discovery tests**

```ts
it("loads only an allowlisted plugin with a valid supported contribution", async () => {
  const result = await loader.load({ id: "hello", source: fixturePlugin("hello"), policy: allowOnly(["hello"]) });
  expect(result.catalogContribution.roles).toContainEqual(expect.objectContaining({ id: "hello-role" }));
});

it("rejects a Jupyter kernel directory instead of treating it as a broken PTH extension", async () => {
  const result = await loader.inspect(fixtureDirectory("jupyter-asm"));
  expect(result.kind).toBe("foreign-tool-directory");
});

it("does not execute an unsupported onStartup field", async () => {
  const result = await loader.load({ id: "unsupported", source: fixturePlugin("unsupported-activation"), policy: allowOnly(["unsupported"]) });
  expect(result).toMatchObject({ accepted: false, reason: "unsupported-contribution" });
});
```

Include tests proving a contribution context exposes no Host, PG pool, sandbox credential, unrestricted filesystem or arbitrary evaluation API; a disabled extension cannot affect catalog/runner; and a contribution's declared capability must be permitted by both Profile and deployment policy.

- [ ] **Step 2: run and establish failure**

Run: `npx vitest run test/pth-catalog/extension-loader.test.ts test/pth-kernel-execution/ext-registry.test.ts test/pth-kernel-execution/ext-capability.test.ts`

Expected: FAIL because existing registry scans directory names indiscriminately, only handles some roles, and loses the registry after assembly/batch load.

- [ ] **Step 3: make contribution support explicit and constrained**

Define a versioned manifest schema. For this release, support only contributions with an implemented host path, such as approved `roles`, `spaces`, declarative `capabilityPolicies` and post-commit `observers`. Each is validated before it reaches the catalog. Do not promise `tools`, `events`, `kernels`, `debugAdapters` or `onStartup` until a host API and an end-to-end test are introduced in a later approved change.

```ts
export interface ExtensionContribution {
  readonly id: string;
  readonly apiVersion: 1;
  readonly roles?: readonly CatalogRole[];
  readonly spaces?: readonly CatalogSpace[];
  readonly capabilityPolicies?: readonly CapabilityPolicyDeclaration[];
  readonly observers?: readonly ObserverDeclaration[];
}

export interface ExtensionContext {
  readonly extensionId: string;
  readonly profileId: ProfileId;
  readonly policy: Readonly<ExtensionPolicy>;
  register(contribution: ExtensionContribution): void;
}
```

Trusted first-party modules may be statically imported by bootstrap and contribute typed factories. Toolstore extensions are loaded only from an explicit configured root/index and profile/deployment allowlist. Any code execution used to parse a third-party extension is treated as untrusted: use declarative data where possible; never pass the Host or raw adapters into the parser.

- [ ] **Step 4: preserve `ext.use` only as a constrained task capability**

Evaluate whether existing `ext.use` needs to remain. If it remains, it is an execution capability controlled by `ExecutionGrant` and catalog policy, receives a sandboxed/deterministic API and cannot register host modules. If it cannot meet those constraints, deprecate/remove it from supported toolstore behavior. Do not call it a module activation mechanism.

- [ ] **Step 5: make check tooling and documentation match runtime**

`scripts/ext-check.ts` must classify explicit PTH plugins, foreign tool directories (such as Jupyter kernels) and malformed PTH plugins separately. It must fail for the third category, not for the second. Update extension documentation to name the exact supported contribution fields and activation point; remove claims that `loadAll` registers tools/capabilities/events/roles when it does not.

- [ ] **Step 6: run extension test suite and commit**

```bash
npx vitest run test/pth-catalog/extension-loader.test.ts test/pth-kernel-execution/ext-registry.test.ts test/pth-kernel-execution/extensions-registry.test.ts test/pth-kernel-execution/ext-capability.test.ts test/pth-kernel-execution/ext-e2e-hello-world.test.ts
npm run ext:check
npm run lint
git add -- src/pth/catalog/extensions src/pth/kernel/extensions/ext-registry.ts src/pth/kernel/interpreter/ext-capability.ts scripts/ext-check.ts test/pth-catalog test/pth-kernel-execution docs/pth/extensions-dev.md
git diff --cached --check
git commit -m "refactor(catalog): constrain extension contributions"
```

## Task 4: Build the PTH Host and static Profile manifests

**Files:**

- Create: `src/pth/bootstrap/pth-host.ts`
- Create: `src/pth/bootstrap/profile-manifest.ts`
- Create: `src/pth/bootstrap/profile-config.ts`
- Create: `src/pth/bootstrap/profiles/control.ts`
- Create: `src/pth/bootstrap/profiles/standard.ts`
- Create: `src/pth/bootstrap/profiles/full.ts`
- Create: `src/pth/bootstrap/private-deployment-policy.ts`
- Create: `test/pth-profiles/profile-config.test.ts`
- Create: `test/pth-profiles/profile-manifest.test.ts`
- Create: `test/pth-profiles/pth-host.test.ts`
- Modify: `src/pth/kernel/assembly.ts`
- Modify: `src/pth/main.ts`

**Interfaces:**

- Produces: lifecycle-owned `PthHost` and three static manifests.
- Consumes: module public APIs, catalog builder, adapter factories and deployment policy overlay.

- [ ] **Step 1: write failing host/profile tests**

```ts
it("starts Control without runner, language execution or session adapters", async () => {
  const host = await createPthHost({ profile: "control", adapters: controlTestAdapters() });
  expect(host.modules).toEqual(expect.arrayContaining(["tasking", "catalog", "operations"]));
  expect(host.modules).not.toContain("runner");
  expect(host.capabilities.execution).toBe(false);
  await host.shutdown();
});

it("fails closed when Standard lacks its execution adapter", async () => {
  await expect(createPthHost({ profile: "standard", adapters: { ...standardTestAdapters(), execution: undefined } })).rejects.toThrow(/execution adapter/);
});

it("maps an omitted compatibility setting to Full but emits a migration diagnostic", async () => {
  const result = parseProfileConfig({});
  expect(result.profile).toBe("full");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "default-profile-full" }));
});
```

- [ ] **Step 2: run and verify failure**

Run: `npx vitest run test/pth-profiles/profile-config.test.ts test/pth-profiles/profile-manifest.test.ts test/pth-profiles/pth-host.test.ts`

Expected: FAIL because main/assembly directly construct the all-in-one runtime and no profile manifest exists.

- [ ] **Step 3: declare the three manifests and module dependency matrix**

```ts
export const CONTROL: ProfileManifest = {
  id: "control",
  modules: ["tasking", "catalog", "operations"],
  requiredAdapters: ["taskRepository", "taskReadModel", "auditSink", "identity"],
  enabledExtensionIds: [],
};

export const STANDARD: ProfileManifest = {
  id: "standard",
  modules: ["tasking", "runner", "execution", "knowledge", "catalog", "operations"],
  requiredAdapters: ["taskRepository", "taskReadModel", "execution", "knowledge", "workspaceBroker", "identity"],
  enabledExtensionIds: [],
};

export const FULL: ProfileManifest = {
  id: "full",
  modules: ["tasking", "runner", "execution", "knowledge", "catalog", "operations", "session", "programs", "workflow"],
  requiredAdapters: ["taskRepository", "taskReadModel", "execution", "knowledge", "workspaceBroker", "identity", "sessionStore", "programStore"],
  enabledExtensionIds: [],
};
```

Manifest data is static code reviewed with the release. `PTH_PROFILE` selects only these names. Module IDs must have a dependency matrix (for example runner requires tasking+execution; workflow requires tasking+operations; session/programs require their storage adapters). A private deployment policy overlay changes adapter factories/allowlists, not `modules` or domain branching.

- [ ] **Step 4: implement Host lifecycle and error boundaries**

```ts
export interface PthHost {
  readonly profile: ProfileId;
  readonly catalog: RuntimeCatalogSnapshot;
  readonly modules: readonly PthModuleId[];
  readonly capabilities: Readonly<{ execution: boolean; session: boolean; programs: boolean }>;
  start(): Promise<void>;
  health(): Promise<HostHealth>;
  shutdown(): Promise<void>;
}
```

`createPthHost()` validates config, overlay, adapters, extension allowlist and catalog before starting any module. On failure, it disposes already-created modules in reverse dependency order and returns a clear startup error. It does not begin a partial API Host that silently accepts tasks it cannot run.

- [ ] **Step 5: migrate assembly/main through an embedded Full Host compatibility path**

Keep `createKernelRuntime()` as a deprecated adapter that creates `PthHost({ profile: "full" })` and exposes its old facade only for unconverted callers. `main.ts` uses parsed profile config and passes the Host's gateway facade/lifecycle to server. Do not copy module wiring into three separate `if (profile)` blocks.

- [ ] **Step 6: run profile unit/assembly tests and commit**

```bash
npx vitest run test/pth-profiles/profile-config.test.ts test/pth-profiles/profile-manifest.test.ts test/pth-profiles/pth-host.test.ts test/pth-kernel-assembly/assembly.test.ts
npm run lint
git add -- src/pth/bootstrap src/pth/kernel/assembly.ts src/pth/main.ts test/pth-profiles test/pth-kernel-assembly
git diff --cached --check
git commit -m "feat(bootstrap): add PTH profile host"
```

## Task 5: Wire API Host, runner Host and operations to the same profile catalog

**Files:**

- Create: `src/pth/bootstrap/api-host.ts`
- Create: `src/pth/bootstrap/runner-host.ts`
- Create: `src/pth/bootstrap/host-health.ts`
- Create: `test/pth-profiles/api-runner-catalog.integration.test.ts`
- Modify: `src/pth/application/gateway/pth-gateway-facade.ts`
- Modify: `src/pth/gateway/server.ts`
- Modify: `src/pth/runner/runner-process.ts`
- Modify: `src/pth/runner/runner-manager.ts`
- Modify: `src/pth/kernel/execution/batch-process.ts`
- Modify: `src/pth/observability/metrics.ts`
- Modify: `src/pth/observability/audit.ts`
- Modify: `src/pth/observability/resource-provider.ts`
- Modify: `src/pth/observability/kernel-metrics.ts`
- Modify: `deploy/docker-compose.yaml`

**Interfaces:**

- Produces: API Host and runner Host that consume one manifest/canonical catalog input.
- Prevents: parent/child role-space-extension drift and profile-incompatible routes being accidentally enabled.

- [ ] **Step 1: write a cross-process catalog consistency integration test**

```ts
it("builds equivalent approved catalogs in API and runner Hosts", async () => {
  const manifest = profileManifest("standard", { enabledExtensionIds: ["hello-role"] });
  const api = await createApiHost({ manifest, adapters: standardTestAdapters() });
  const runner = await createRunnerHost({ manifest, adapters: standardRunnerAdapters() });
  expect(api.catalog.version).toBe(runner.catalog.version);
  expect([...api.catalog.roles.keys()]).toEqual([...runner.catalog.roles.keys()]);
  expect(api.catalog.enabledExtensions).toEqual(runner.catalog.enabledExtensions);
});

it("does not register execution routes in Control", async () => {
  const app = await startProfileApp("control");
  await expect(app.inject({ method: "POST", url: "/api/v1/kernel/exec", payload: { code: "1" } })).resolves.toMatchObject({ statusCode: 404 });
});
```

- [ ] **Step 2: run and verify failure**

Run: `npx vitest run test/pth-profiles/api-runner-catalog.integration.test.ts`

Expected: FAIL because child batch process repeats side-effect registration and server always registers full runtime routes.

- [ ] **Step 3: establish host-specific bootstrap entrypoints**

`ApiHost` builds Fastify routes only for modules enabled by the selected Profile. `RunnerHost` builds only runner/tasking/execution/catalog dependencies it needs. Both build catalog from the same versioned manifest + approved contribution list, and include the catalog version/profile in readiness metadata. The child runner process receives profile ID/config reference and rebuilds from trusted code; it never receives a mutable registry object or arbitrary extension source over IPC.

- [ ] **Step 4: map disabled capabilities to documented API behavior**

For routes that are not part of Control, do not register them. For a retained status endpoint, report `capability: disabled` without leaking internal adapter names/secrets. Full preserves existing public routes and response formats. Update PTL bridge/client handling to report an actionable capability-disabled response rather than treating it as a database/sandbox failure.

- [ ] **Step 5: make health and graceful shutdown profile-aware**

Host health reports profile, catalog version, enabled module IDs and safe adapter readiness only. It must not report raw workspace paths, grant keys, extension source paths or internal pool IDs. On shutdown, stop API acceptance, drain runner leases, stop operations observers, release execution resources, then dispose adapters in reverse dependency order.

- [ ] **Step 6: run host integration tests and commit**

```bash
npx vitest run test/pth-profiles/api-runner-catalog.integration.test.ts test/pth-gateway/kernel-routes.test.ts test/pth-kernel-assembly/batch-manager-fork.integration.test.ts test/pth-observability/kernel-metrics.test.ts
npm run lint
git add -- src/pth/bootstrap src/pth/application/gateway/pth-gateway-facade.ts src/pth/gateway/server.ts src/pth/runner src/pth/kernel/execution/batch-process.ts src/pth/observability deploy/docker-compose.yaml test/pth-profiles test/pth-gateway test/pth-kernel-assembly test/pth-observability
git diff --cached --check
git commit -m "refactor(bootstrap): wire profile hosts through catalog"
```

## Task 6: Publish Profile startup matrix, extension delivery rules and release evidence

**Files:**

- Create: `test/pth-profiles/profile-startup.matrix.test.ts`
- Create: `docs/pth/profiles.md`
- Create: `docs/pth/extension-contribution-contract.md`
- Modify: `README.md`
- Modify: `docs/pth/development.md`
- Modify: `docs/pth/extensions-dev.md`
- Modify: `deploy/docker-compose.yaml`
- Modify: `deploy/pth.deployment.json`
- Modify: `scripts/ext-check.ts`
- Modify: `docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md`

- [ ] **Step 1: implement the startup matrix test**

For each Control, Standard and Full, run clean configuration cases for:

1. complete dependencies and graceful shutdown;
2. a missing required adapter (must fail before listening);
3. an unknown profile (must fail closed);
4. an extension not allowed by Profile/deployment policy (must not load);
5. an extension contribution with unsupported field (must be rejected with diagnostic);
6. profile-specific forbidden capability/route;
7. private policy overlay using private model/storage/egress configuration without changing module manifest.

Run the matrix against source mode and clean built package/image mode. Full must run the legacy default deployment compatibility fixture; Standard must execute a scoped task through `ExecutionPort`; Control must be able to manage scoped tasks but have no local agent/kernel runtime.

- [ ] **Step 2: create an extension developer delivery contract**

Document the supported manifest schema, validation command, allowlist registration, test fixture layout, profile compatibility declaration and packaging path. Explicitly separate:

- trusted first-party module contribution;
- restricted toolstore contribution;
- untrusted task code executed through sandbox.

Do not say that editing an extension inside the sandbox container is a supported persistent development workflow. The dev environment must provide Node/TypeScript validation and an explicit toolstore publish/mount path before it is documented as such.

- [ ] **Step 3: make deployment select only a static Profile**

Add an explicit `PTH_PROFILE` configuration with allowed values `control|standard|full` and document default compatibility behavior. Compose/declarative deployment must inject profile config and extension allowlist/policy inputs, not source directory switches or custom branch names. Preserve the sandbox isolation security requirements from the execution plan for all profiles.

- [ ] **Step 4: run the release matrix**

```bash
npx vitest run test/pth-profiles test/pth-catalog test/pth-gateway test/pth-kernel-assembly test/pth-kernel-execution/ext-registry.test.ts test/pth-kernel-execution/ext-capability.test.ts
npm run ext:check
npm run check:pth-boundaries
npm run lint
npm run build
npm pack --dry-run
docker compose -f deploy/docker-compose.yaml config
```

- [ ] **Step 5: commit profile documentation and evidence**

```bash
git add -- test/pth-profiles docs/pth/profiles.md docs/pth/extension-contribution-contract.md README.md docs/pth/development.md docs/pth/extensions-dev.md deploy/docker-compose.yaml deploy/pth.deployment.json scripts/ext-check.ts docs/superpowers/explorations/2026-08-15-pth-sandbox-security-audit.md
git diff --cached --check
git commit -m "docs(pth): publish profile and extension delivery rules"
```

## Completion criteria

- A PTH Host can build exactly Control, Standard or Full from a validated static manifest, with missing dependencies and unknown profiles failing before service start.
- Role, space, routing and extension contribution behavior is derived from an immutable catalog snapshot, not global registration order.
- API and runner hosts use the same approved Profile/catalog version and do not silently activate incompatible routes or extensions.
- Extension docs, checker and runtime agree on actual contribution/activation semantics; untrusted extension/task code never receives Host adapters or execution secrets.
- Private deployment changes adapter/policy choices without creating a fork or alternate business module graph.
- All Profiles, clean builds and deployment renders pass their startup and security matrices.
