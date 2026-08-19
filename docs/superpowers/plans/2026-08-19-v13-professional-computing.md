# v1.3 Professional Computing and Executable Tutorials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver four real professional-computing Role verticals and one Jupyter tutorial Role on the shared five-type memory and PTH execution core.

**Architecture:** Add Index Memory and a typed `ProfessionalRuntimeAdapter` seam without adding a Workflow engine or a new top-level PTH module. Professional Roles are explicit-only lineage leaves with zero default replicas; adapters execute through Task Lease, Execution Grant, bounded workspaces and artifact-backed results. The tutorial Role consumes verified job artifacts and produces cleanly executable notebooks.

**Tech Stack:** TypeScript 5.7, Node.js 22, PostgreSQL, PTH Task/Grant/Memory contracts, toolstore extensions, Docker, binutils/QEMU, Lean 4/Lake/Mathlib, Wolfram Engine, Psi4, Quantum ESPRESSO, Jupyter nbformat v4, Vitest/Testcontainers.

**Spec:** `docs/pth/n32-v13-professional-computing-design.md`

## Global Constraints

- Target release is `v1.3.0`; current `v1.2.0` behaviour remains the compatibility baseline.
- Every finite durable work item has exactly one server-stamped `WorkMode`: `intake`, `optimize`, or `run`; the three modes may execute concurrently.
- Delegation inherits WorkMode; a cross-mode request creates a new work ID and Work Envelope and never mutates mode in place.
- N31 Workflow Definition/Compiler/Run stays deferred to 2.0; no task may introduce a generic workflow abstraction.
- The only memory types are `setting`, `wiki`, `skill`, `log`, and `index`.
- Index Memory stores navigation metadata, never full source bodies.
- All lazy reads reuse verified tenant/space/status/grant checks and the task `CognitiveBudget` ledger.
- Professional adapters never accept arbitrary command arrays or shell text supplied by the LLM.
- Every Professional Job binds task, lease, worker, role revision, grant, deadline, runtime version, input hash and output artifacts.
- `assembly-engineer`, `computational-chemist`, `lean4-prover`, `symbolic-mathematician`, and `technical-educator` have zero default replicas.
- Runtime dependencies use committed exact stable versions in `deploy/professional-runtime-lock.json`; runtime network installation is forbidden.
- Wolfram tests require a real licensed kernel; absence is `EVALUATION-INCOMPLETE`, never PASS or fallback masquerading as Wolfram.
- Notebook success requires a fresh-kernel execute-all run; stored historical cell output is not evidence.
- No lane may weaken N29 TrustPolicy, source revision, promotion, tenant, stage-CAS, or official-memory gates.
- Each task follows TDD and ends in an independently reviewable commit.

---

### Task 0: Work Mode and Server-Stamped Work Envelope

**Files:**
- Create: `src/pth/contracts/work-mode.ts`
- Modify: `src/pth/contracts/index.ts`
- Modify: `src/pth/contracts/tasking.ts`
- Modify: `src/pth/contracts/knowledge-intake.ts`
- Modify: `src/pth/kernel/storage/schema.ts`
- Modify: `src/pth/kernel/storage/task-store-pg.ts`
- Modify: `src/pth/tasking/task-control-service.ts`
- Modify: `src/pth/kernel/templates.ts`
- Modify: `src/pth/kernel/execution/optimizer-loop.ts`
- Create: `test/pth-contracts/work-mode.test.ts`
- Modify: `test/pth-tasking/task-control-service.test.ts`
- Modify: `test/pth-knowledge-intake/knowledge-intake-pg.test.ts`
- Create: `test/pth-composition/work-mode-classification.test.ts`

**Interfaces:**
- Consumes: trusted task publish/delegate, IntakeRun creation, optimizer/system templates, tenant scope and causation IDs.
- Produces: `WorkMode`, `WorkEnvelope`, `createServerWorkEnvelope()`, `assertWorkModeImmutable()`, inherited delegation stamping, explicit `createCrossModeWork()` and durable `tasks.work_mode`.

- [ ] **Step 1: Write failing pure contract tests**

```ts
expect(WORK_MODES).toEqual(["intake", "optimize", "run"]);
expect(createServerWorkEnvelope({
  workId: "task-1",
  mode: "run",
  objective: "prove theorem",
  authorityPolicyRef: "authority:run-v1",
  budgetPolicyRef: "budget:lean-v1",
  causationId: "turn-1",
}).mode).toBe("run");
expect(() => assertWorkModeImmutable(
  { workId: "task-1", mode: "run" },
  { workId: "task-1", mode: "intake" },
)).toThrow(/new work/i);
```

- [ ] **Step 2: Run contract tests and confirm the model is absent**

Run: `npx vitest run test/pth-contracts/work-mode.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement the pure contract and server-only constructor**

```ts
export const WORK_MODES = ["intake", "optimize", "run"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export interface WorkEnvelope {
  workId: string;
  mode: WorkMode;
  objective: string;
  authorityPolicyRef: string;
  budgetPolicyRef: string;
  parentWorkId?: string;
  causationId: string;
}

export function assertWorkModeImmutable(
  before: Pick<WorkEnvelope, "workId" | "mode">,
  after: Pick<WorkEnvelope, "workId" | "mode">,
): void {
  if (before.workId === after.workId && before.mode !== after.mode) {
    throw new Error("cross-mode work requires a new work id");
  }
}
```

Validation rejects unknown modes, empty policies, self-parenting and missing causation. Do not expose a public body-to-envelope parser.

- [ ] **Step 4: Add durable Task mode and backfill**

Add `tasks.work_mode TEXT NOT NULL DEFAULT 'run' CHECK (...)`. Task repository readers stamp `TaskWorkItem.workMode`. Gateway/user publish always writes `run`; request body values are ignored/rejected. Trusted system-template publishing accepts a code-owned mode.

- [ ] **Step 5: Implement inheritance and cross-mode creation**

`delegate()` copies the parent mode. `createCrossModeWork({fromWorkId,toMode,objective,...})` always publishes a new task with `parentWorkId` and `causationId`; it rejects `toMode===from.mode`. Fixed allowed handoffs are `run→intake`, `run→optimize`, `intake→optimize`, `optimize→intake`; return to run happens through published knowledge or an approved revision, not by mutating the source work.

- [ ] **Step 6: Stamp native Intake and Optimize work**

`IntakeRun` exposes `workMode:"intake"` as a fixed discriminant. Intake stage tasks inherit `intake`. Optimizer/system templates are code-owned `optimize`; ordinary templates remain `run`. Trigger remains only a wake-up source and does not define mode itself.

- [ ] **Step 7: Add authority-matrix tests**

Tests prove run cannot direct-write official knowledge/config, intake cannot modify Role/Tool/config, optimize cannot install untrusted source content, client cannot self-report optimize/intake, and all cross-mode operations produce different work IDs and audit causation.

- [ ] **Step 8: Run focused tests and commit**

Run: `npx vitest run test/pth-contracts/work-mode.test.ts test/pth-tasking/task-control-service.test.ts test/pth-knowledge-intake/knowledge-intake-pg.test.ts test/pth-composition/work-mode-classification.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add src/pth/contracts/work-mode.ts src/pth/contracts/index.ts src/pth/contracts/tasking.ts src/pth/contracts/knowledge-intake.ts src/pth/kernel/storage/schema.ts src/pth/kernel/storage/task-store-pg.ts src/pth/tasking/task-control-service.ts src/pth/kernel/templates.ts src/pth/kernel/execution/optimizer-loop.ts test/pth-contracts/work-mode.test.ts test/pth-tasking/task-control-service.test.ts test/pth-knowledge-intake/knowledge-intake-pg.test.ts test/pth-composition/work-mode-classification.test.ts
git commit -m "feat(work): classify intake optimize and run"
```

---

### Task 1: Fifth Memory Type and Index Memory

**Files:**
- Modify: `src/pth/contracts/cognitive-responsibility.ts`
- Modify: `src/pth/execution/memory-type-classifier.ts`
- Create: `src/pth/execution/index-memory.ts`
- Modify: `src/pth/execution/index.ts`
- Modify: `packages/pth-memory/src/memory-policy.ts`
- Test: `test/pth-contracts/cognitive-responsibility.test.ts`
- Test: `test/pth-execution/memory-type-classifier.test.ts`
- Create: `test/pth-execution/index-memory.test.ts`
- Modify: `packages/pth-memory/test/memory-policy.test.ts`

**Interfaces:**
- Consumes: `MemoryType`, `VerifiedTaskReadScope`, `CognitiveBudgetLedger`, `MemoryEntry`.
- Produces: `IndexMemoryRecord`, `IndexMemoryLocator`, `validateIndexMemoryRecord()`, `IndexMemoryReader.readExact()`, and the fifth `MemoryType` value `index`.

- [ ] **Step 1: Write failing five-type and classification tests**

```ts
expect([...MEMORY_TYPES].sort()).toEqual(["index", "log", "setting", "skill", "wiki"]);
expect(classifyFeasibilityMemoryType({ kind: "source-index" })).toBe("index");
expect(classifyFeasibilityMemoryType({ kind: "symbol-index" })).toBe("index");
expect(classifyFeasibilityMemoryType({ kind: "memory-collection-index" })).toBe("index");
```

- [ ] **Step 2: Run the tests and confirm the old four-type contract fails**

Run: `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts test/pth-execution/memory-type-classifier.test.ts`

Expected: FAIL because `index` and the three index kinds are absent.

- [ ] **Step 3: Extend the pure contract and canonical classifier**

```ts
export const MEMORY_TYPES = ["setting", "wiki", "skill", "log", "index"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

const FEASIBILITY_KIND_TO_MEMORY_TYPE = Object.freeze({
  // existing mappings remain unchanged
  "source-index": "index",
  "symbol-index": "index",
  "memory-collection-index": "index",
} satisfies Record<string, MemoryType>);
```

- [ ] **Step 4: Write failing Index Memory invariant and lazy-read tests**

The tests must reject body-shaped fields, non-stable channels, empty hashes, unknown locator kinds, cross-tenant reads, expired grants and budget overflow. They must prove one exact locator returns only the referenced span and charges its actual characters.

```ts
const record = validateIndexMemoryRecord({
  entryId: "idx:lean:list-map",
  sourceId: "lean4-mathlib",
  product: "Mathlib",
  version: "stable-lock",
  releaseChannel: "stable",
  canonicalUri: "artifact://mathlib-docs",
  artifactHash: "sha256:" + "a".repeat(64),
  locator: { kind: "symbol", value: "List.map" },
  domains: ["formal-methods"],
  license: "Apache-2.0",
});
expect("content" in record).toBe(false);
```

- [ ] **Step 5: Implement `IndexMemoryReader` with the existing authorized read scope and ledger**

`readExact()` must accept the verified scope, an index record, and a source adapter returning one exact span. It calls the backing adapter only after authorization, verifies artifact hash and locator identity, then charges the returned span through the same ledger used by memory/skill reads. It must not expose a `readWholeCorpus()` method.

- [ ] **Step 6: Force index writes to draft and run focused tests**

Update memory policy so `source-index`, `symbol-index`, and `memory-collection-index` cannot self-declare `official` through worker `memory.write`.

Run: `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts test/pth-execution/memory-type-classifier.test.ts test/pth-execution/index-memory.test.ts packages/pth-memory/test/memory-policy.test.ts test/pth-runner/cognitive-working-set.test.ts`

Expected: PASS, zero skipped tests.

- [ ] **Step 7: Commit**

```bash
git add src/pth/contracts/cognitive-responsibility.ts src/pth/execution/memory-type-classifier.ts src/pth/execution/index-memory.ts src/pth/execution/index.ts packages/pth-memory/src/memory-policy.ts test/pth-contracts/cognitive-responsibility.test.ts test/pth-execution/memory-type-classifier.test.ts test/pth-execution/index-memory.test.ts packages/pth-memory/test/memory-policy.test.ts
git commit -m "feat(memory): add bounded index memory"
```

---

### Task 2: Professional Job Contract, Stable Runtime Lock, and Adapter Registry

**Files:**
- Create: `src/pth/contracts/professional-computing.ts`
- Modify: `src/pth/contracts/index.ts`
- Create: `src/pth/execution/professional-runtime.ts`
- Modify: `src/pth/execution/index.ts`
- Create: `deploy/professional-runtime-lock.json`
- Create: `scripts/update-professional-runtime-lock.ts`
- Create: `test/pth-contracts/professional-computing.test.ts`
- Create: `test/pth-execution/professional-runtime.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef`, `TaskLeaseReference`, `TenantScope`, `WorkerReplicaRef`, `ExecutionGrant` verification.
- Produces: `ProfessionalRuntimeId`, six discriminated job specs, `ProfessionalJobRequest`, `ProfessionalJobResult`, `VerifiedProfessionalJobAuth`, `validateProfessionalJobRequest()`, `ProfessionalRuntimeAdapter`, `ProfessionalRuntimeRegistry`, and `ProfessionalRuntimeLock`.

- [ ] **Step 1: Write compile-time and runtime contract tests**

```ts
const artifact: ArtifactRef = {
  kind: "source",
  uri: "artifact://tenant-a/assembly-source",
};
const request: ProfessionalJobRequest<AssemblyJobSpec> = {
  jobId: "job-1",
  taskId: "task-1",
  tenantId: "tenant-a",
  space: "dev",
  worker,
  lease,
  roleRevision: worker.role.revision,
  runtimeId: "assembly",
  runtimeVersion: "lock:assembly",
  deadlineAt: "2030-01-01T00:01:00.000Z",
  inputHash: "sha256:" + "b".repeat(64),
  spec: { operation: "build-run-disassemble", target: "riscv64", sourceRef: artifact },
};
expect(validateProfessionalJobRequest(request).ok).toBe(true);
expect(validateProfessionalJobRequest({ ...request, spec: { command: "bash -lc env" } }).ok).toBe(false);
```

- [ ] **Step 2: Run the tests and confirm the contract is missing**

Run: `npx vitest run test/pth-contracts/professional-computing.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement discriminated specs and the common result envelope**

Define exact specs for `assembly`, `lean4`, `wolfram`, `psi4`, `quantum-espresso`, and `jupyter`. The common result contains `status`, `runtime`, `runtimeVersion`, `inputHash`, `outputHash`, `artifacts`, `diagnostics`, `usage`, `traceId`, and timestamps. It contains no executable callback and no raw secret.

- [ ] **Step 4: Write registry denial, cancellation and version-lock tests**

Tests must cover duplicate adapter IDs, adapter/runtime mismatch, unregistered runtime, role not permitted, expired deadline, cancel idempotency, non-stable lock entries and installed-version mismatch.

- [ ] **Step 5: Implement `ProfessionalRuntimeRegistry`**

```ts
export interface ProfessionalRuntimeRegistry {
  register<S, R>(adapter: ProfessionalRuntimeAdapter<S, R>): void;
  probe(id: ProfessionalRuntimeId): Promise<ProfessionalRuntimeProbe>;
  execute<S, R>(request: ProfessionalJobRequest<S>, auth: VerifiedProfessionalJobAuth): Promise<ProfessionalJobResult<R>>;
  cancel(id: ProfessionalRuntimeId, jobId: string, auth: VerifiedProfessionalJobAuth): Promise<boolean>;
}
```

The registry verifies role/runtime allowlists, lease/grant/deadline binding and the committed lock before invoking an adapter. Adapter errors become structured results; they do not bypass artifact or audit handling.

- [ ] **Step 6: Implement the lock updater**

`scripts/update-professional-runtime-lock.ts` probes installed tools, rejects prerelease/nightly/dev identifiers, captures exact version output and writes sorted canonical JSON. It may run with network during an explicit dependency update, but the runtime image consumes only the committed lock and preinstalled packages.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run test/pth-contracts/professional-computing.test.ts test/pth-execution/professional-runtime.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add src/pth/contracts/professional-computing.ts src/pth/contracts/index.ts src/pth/execution/professional-runtime.ts src/pth/execution/index.ts deploy/professional-runtime-lock.json scripts/update-professional-runtime-lock.ts test/pth-contracts/professional-computing.test.ts test/pth-execution/professional-runtime.test.ts
git commit -m "feat(runtime): add professional adapter contract"
```

---

### Task 3: Five Explicit-Only Professional Roles and Shared Memory Responsibilities

**Files:**
- Create: `src/pth/kernel/execution/professional-roles.ts`
- Modify: `src/pth/kernel/execution/worker-cluster.ts`
- Modify: `src/pth/catalog/adapters/builtin-catalog-contributions.ts`
- Modify: `src/pth/bootstrap/pth-host.ts`
- Modify: `src/pth/kernel/assembly.ts`
- Modify: `src/pth/bootstrap/batch-process.ts`
- Modify: `test/helpers.ts`
- Modify: `test/pth-kernel-execution/role-lineage.test.ts`
- Modify: `test/pth-kernel-execution/role-weights.test.ts`
- Create: `test/pth-kernel-execution/professional-roles.test.ts`

**Interfaces:**
- Consumes: `RoleDefinition`, `RoleDefinitionRef`, `WorkerReplicaRef`, `MemoryRegion`, `CognitiveBudget`.
- Produces: `PROFESSIONAL_ROLES`, `professionalRuntimeIdsForRole()`, explicit-only weight semantics, and frozen responsibility/budget policy references.

- [ ] **Step 1: Write failing lineage and default-zero tests**

```ts
expect(PROFESSIONAL_ROLES.map((r) => r.id).sort()).toEqual([
  "assembly-engineer",
  "computational-chemist",
  "lean4-prover",
  "symbolic-mathematician",
  "technical-educator",
]);
expect(parseRoleWeights(undefined).get("assembly-engineer")).toBe(0);
expect(parseRoleWeights("assembly-engineer:1").get("assembly-engineer")).toBe(1);
```

- [ ] **Step 2: Run tests and verify roles are absent**

Run: `npx vitest run test/pth-kernel-execution/role-lineage.test.ts test/pth-kernel-execution/role-weights.test.ts test/pth-kernel-execution/professional-roles.test.ts`

Expected: FAIL on missing `PROFESSIONAL_ROLES`.

- [ ] **Step 3: Define the five Roles with narrow capability and adapter sets**

Use parents and generations frozen by the spec. Every Role declares `loadPolicyRef`; none receives generic `ext`, unrestricted `bash`, or all professional adapters. `technical-educator` receives only Jupyter publication capability and read-only artifact access.

- [ ] **Step 4: Integrate lineage/catalog without changing the default batch**

Add professional roles to the known lineage/catalog set and explicit weight parser, but keep them out of the implicit one-copy loop. Main and batch construct the same catalog snapshot. Add an invariant test that `PTH_WORKER_ROLES` omission creates zero specialist replicas.

- [ ] **Step 5: Freeze overlapping responsibilities and budgets**

Create five policy fixtures using shared regions: all may reference shared `index/wiki`; Assembly emphasizes `skill/log` for toolchains, chemistry emphasizes chemistry `wiki/index/log`, Lean emphasizes theorem `index/wiki/skill`, Wolfram emphasizes mathematics `wiki/index/skill`, educator reads reviewed result/index/skill. Assert capacity and task budgets through existing N28 validators.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/pth-kernel-execution/role-lineage.test.ts test/pth-kernel-execution/role-weights.test.ts test/pth-kernel-execution/professional-roles.test.ts test/pth-catalog/catalog-injection.test.ts test/pth-runner/cognitive-responsibility.vertical.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add src/pth/kernel/execution/professional-roles.ts src/pth/kernel/execution/worker-cluster.ts src/pth/catalog/adapters/builtin-catalog-contributions.ts src/pth/bootstrap/pth-host.ts src/pth/kernel/assembly.ts src/pth/bootstrap/batch-process.ts test/helpers.ts test/pth-kernel-execution/role-lineage.test.ts test/pth-kernel-execution/role-weights.test.ts test/pth-kernel-execution/professional-roles.test.ts
git commit -m "feat(roles): add explicit professional specialists"
```

---

### Task 4: Shared Professional Capability and Artifact-Safe Execution Host

**Files:**
- Create: `src/pth/runner/professional-task-capability.ts`
- Create: `src/pth/bootstrap/professional-runtime-adapters.ts`
- Modify: `src/pth/runner/agent-task-runner.ts`
- Modify: `src/pth/bootstrap/batch-process.ts`
- Modify: `src/pth/impls/kernels/capability.ts`
- Modify: `src/pth/runner/index.ts`
- Create: `test/pth-runner/professional-task-capability.test.ts`
- Modify: `test/pth-runner/agent-task-runner.test.ts`
- Create: `test/pth-kernel-execution/professional-capability.integration.test.ts`

**Interfaces:**
- Consumes: registry from Task 2, exact Role/Worker from Task 3, Task Lease, verified grant, artifact store.
- Produces: `assembleProfessionalRuntimeRegistry()`, task-scoped `professional.probe()`, `professional.execute()`, and `professional.cancel()` capability.

- [ ] **Step 1: Write denial-before-backing-call tests**

Cover wrong role revision, wrong worker ID, missing capability, expired task lease, expired grant, runtime not in Role allowlist, workspace escape, input artifact tenant mismatch and output over limit. Each case asserts adapter invocation count is zero.

- [ ] **Step 2: Run tests and confirm the capability does not exist**

Run: `npx vitest run test/pth-runner/professional-task-capability.test.ts`

Expected: FAIL on missing factory.

- [ ] **Step 3: Implement the task-scoped facade**

```ts
export interface ProfessionalArtifactPort {
  getInput(tenantId: string, artifact: ArtifactRef): Promise<Uint8Array>;
  putOutput(input: {
    tenantId: string;
    jobId: string;
    kind: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<ArtifactRef>;
}

export function createProfessionalTaskCapability(input: {
  lease: TaskLease;
  work: TaskWorkItem;
  worker: WorkerReplicaRef;
  role: RoleDefinition;
  grant: ExecutionGrant;
  registry: ProfessionalRuntimeRegistry;
  artifacts: ProfessionalArtifactPort;
  clock?: () => Date;
}): ProfessionalTaskCapability;
```

The facade creates all identity fields server-side. LLM input supplies only the typed adapter spec and artifact IDs; it cannot set tenant, role, worker, runtime version, deadline or filesystem paths.

`assembleProfessionalRuntimeRegistry()` is the single production composition point. It receives the committed lock and adapter factories, registers only adapters whose dependencies probe successfully, and never imports fixture data.

- [ ] **Step 4: Inject the facade without overwriting existing capabilities**

Follow the N28 merge pattern in `agent-task-runner.ts`: add `professional` under the existing capability object and preserve memory/skills/state. Batch process supplies the same registry and artifact adapter to every specialist Worker Replica.

- [ ] **Step 5: Test success, cancel and trace/artifact binding**

Use a fake adapter returning a deterministic artifact. Assert request identity equals the Worker Replica, result artifacts are tenant-scoped, audit contains jobId/runtime/trace and cancel is idempotent.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/pth-runner/professional-task-capability.test.ts test/pth-runner/agent-task-runner.test.ts test/pth-kernel-execution/professional-capability.integration.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add src/pth/runner/professional-task-capability.ts src/pth/bootstrap/professional-runtime-adapters.ts src/pth/runner/agent-task-runner.ts src/pth/bootstrap/batch-process.ts src/pth/impls/kernels/capability.ts src/pth/runner/index.ts test/pth-runner/professional-task-capability.test.ts test/pth-runner/agent-task-runner.test.ts test/pth-kernel-execution/professional-capability.integration.test.ts
git commit -m "feat(runtime): expose task-scoped professional execution"
```

---

### Task 5: Assembly Engineer Vertical Slice

**Files:**
- Create: `src/pth/execution/adapters/assembly-runtime-adapter.ts`
- Modify: `src/pth/bootstrap/professional-runtime-adapters.ts`
- Modify: `toolstore/extensions/asm-kernel/index.js.template`
- Modify: `toolstore/extensions/asm-kernel/test/ext-check.js`
- Create: `test/pth-professional/assembly-engineer.integration.test.ts`

**Interfaces:**
- Consumes: existing asm-kernel build/run/disasm/status operations and Professional Runtime contract.
- Produces: `createAssemblyRuntimeAdapter()` returning typed build/run/disassembly artifacts.

- [ ] **Step 1: Write a real three-target acceptance test**

The test builds a nontrivial byte-sum or dot-product routine for x86-64, AArch64 and RISC-V, executes it through native/QEMU as appropriate, compares output with a reference implementation and inspects disassembly. Tool absence is a failing preflight, not a skipped test.

- [ ] **Step 2: Run the test and observe missing adapter failure**

Run: `npx vitest run test/pth-professional/assembly-engineer.integration.test.ts`

Expected: FAIL on missing adapter export.

- [ ] **Step 3: Wrap existing asm-kernel operations in the typed adapter**

The adapter maps only `AssemblyJobSpec` operations to fixed asm-kernel calls. It validates target, source artifact, timeout and output limits; it records assembler/linker/QEMU versions and produces source/object/binary/disassembly/run artifacts.

- [ ] **Step 4: Add ABI and negative-path tests**

Cover invalid target, unsupported instruction, linker failure, timeout, non-zero exit, wrong expected output and an attempted arbitrary command property. Assert no success result for any negative path.

- [ ] **Step 5: Run existing asm checks plus the vertical test**

Run: `node toolstore/extensions/asm-kernel/test/ext-check.js`

Run: `node toolstore/extensions/asm-kernel/test/run-sim-tests.js`

Run: `npx vitest run test/pth-kernel-execution/agent-tool-convergence.test.ts test/pth-professional/assembly-engineer.integration.test.ts`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/pth/execution/adapters/assembly-runtime-adapter.ts src/pth/bootstrap/professional-runtime-adapters.ts toolstore/extensions/asm-kernel/index.js.template toolstore/extensions/asm-kernel/test/ext-check.js test/pth-professional/assembly-engineer.integration.test.ts
git commit -m "feat(professional): validate assembly engineer vertical"
```

---

### Task 6: Lean 4 Prover Vertical Slice

**Files:**
- Create: `toolstore/extensions/lean4-runtime/plugin.json`
- Create: `toolstore/extensions/lean4-runtime/index.js`
- Create: `toolstore/extensions/lean4-runtime/README.md`
- Create: `src/pth/execution/adapters/lean4-runtime-adapter.ts`
- Modify: `src/pth/bootstrap/professional-runtime-adapters.ts`
- Modify: `deploy/Dockerfile`
- Create: `test/pth-professional/lean4-prover.integration.test.ts`

**Interfaces:**
- Consumes: `Lean4JobSpec`, locked Lean/Lake/Mathlib versions, task workspace/artifacts.
- Produces: `createLean4RuntimeAdapter()`, proof source artifact, build log, theorem/dependency manifest and no-placeholder verdict.

- [ ] **Step 1: Write a real clean-project proof test**

Create a fixture theorem that needs Mathlib rather than `rfl`, execute `lake build` in a fresh task workspace, and assert the generated source contains none of `sorry`, `admit`, `by_contra?` placeholders or unclosed goals.

- [ ] **Step 2: Run the test and confirm Lean adapter/toolchain is absent**

Run: `npx vitest run test/pth-professional/lean4-prover.integration.test.ts`

Expected: FAIL at adapter preflight.

- [ ] **Step 3: Add the locked stable toolchain to the production image**

Install the exact version and dependency archive named in `deploy/professional-runtime-lock.json`; verify checksums during image build. No `elan default stable` or moving branch is permitted in the final Dockerfile.

- [ ] **Step 4: Implement the Lean extension and adapter**

Expose only `probe`, `check`, and `buildProject`. Reject arbitrary commands, external paths, source placeholders and dependency mutation. Parse compiler diagnostics into line/column/severity/message and attach `lake-manifest.json` plus tool versions.

- [ ] **Step 5: Add diagnostics and security tests**

Cover syntax errors, unresolved theorem, `sorry`, timeout, workspace escape, changed dependency lock and runtime version mismatch.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/pth-professional/lean4-prover.integration.test.ts test/pth-execution/professional-runtime.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add toolstore/extensions/lean4-runtime src/pth/execution/adapters/lean4-runtime-adapter.ts src/pth/bootstrap/professional-runtime-adapters.ts deploy/Dockerfile deploy/professional-runtime-lock.json test/pth-professional/lean4-prover.integration.test.ts
git commit -m "feat(professional): add lean4 prover vertical"
```

---

### Task 7: Wolfram Symbolic Mathematics Vertical Slice

**Files:**
- Create: `toolstore/extensions/wolfram-runtime/plugin.json`
- Create: `toolstore/extensions/wolfram-runtime/index.js`
- Create: `src/pth/execution/adapters/wolfram-runtime-adapter.ts`
- Modify: `src/pth/bootstrap/professional-runtime-adapters.ts`
- Modify: `src/pth/config/schema.ts`
- Create: `test/pth-professional/wolfram-mathematician.integration.test.ts`

**Interfaces:**
- Consumes: `WolframJobSpec`, server-side kernel path/license environment, runtime lock.
- Produces: `createWolframRuntimeAdapter()`, held-expression result, assumptions, messages, numeric verification and license-safe diagnostics.

- [ ] **Step 1: Write licensed-kernel preflight and real calculation tests**

The fixture performs a symbolic integral or equation solve with explicit assumptions and verifies the result numerically at deterministic sample points. The test requires the exact locked kernel version.

- [ ] **Step 2: Run the test and record either missing adapter or licensed environment precondition**

Run: `npx vitest run test/pth-professional/wolfram-mathematician.integration.test.ts`

Expected before implementation: FAIL. If no licensed kernel is available, record `EVALUATION-INCOMPLETE`; do not skip or substitute SymPy.

- [ ] **Step 3: Implement config and secret boundaries**

Add server-only `PTH_WOLFRAM_KERNEL_PATH` and license-provider settings to the centralized config schema. Never place license data in task payloads, artifacts, audit logs, Notebook cells or browser responses.

- [ ] **Step 4: Implement a fixed Wolfram execution protocol**

Pass expressions through a generated, quoted `.wl` file in the task workspace. The adapter controls `$Assumptions`, time/memory constraints and JSON serialization. It returns `$Messages` and kernel version; it never evaluates shell escapes or arbitrary file imports.

- [ ] **Step 5: Test failure and leakage paths**

Cover missing license, wrong version, timeout, unevaluated result, assumptions mismatch, numeric counterexample, filesystem access attempt and log secret scan.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/pth-professional/wolfram-mathematician.integration.test.ts test/pth-config/config.test.ts`

Expected: PASS with a real licensed kernel and zero skipped tests.

```bash
git add toolstore/extensions/wolfram-runtime src/pth/execution/adapters/wolfram-runtime-adapter.ts src/pth/bootstrap/professional-runtime-adapters.ts src/pth/config/schema.ts test/pth-professional/wolfram-mathematician.integration.test.ts
git commit -m "feat(professional): add wolfram symbolic vertical"
```

---

### Task 8: Computational Chemistry Vertical Slice

**Files:**
- Create: `toolstore/extensions/computational-chemistry/plugin.json`
- Create: `toolstore/extensions/computational-chemistry/index.js`
- Create: `src/pth/execution/adapters/computational-chemistry-adapter.ts`
- Modify: `src/pth/bootstrap/professional-runtime-adapters.ts`
- Modify: `deploy/Dockerfile`
- Create: `test/pth-professional/computational-chemist.integration.test.ts`

**Interfaces:**
- Consumes: `Psi4JobSpec`, `QuantumEspressoJobSpec`, locked engines/data, bounded workspace and resource limits.
- Produces: `createPsi4RuntimeAdapter()`, `createQuantumEspressoRuntimeAdapter()`, structured convergence and result artifacts.

- [ ] **Step 1: Write real Psi4 and QE acceptance fixtures**

Psi4 fixture: a small molecule single-point energy plus geometry optimization. QE fixture: a small periodic SCF calculation. Both assert exact engine version, declared model inputs, convergence state, result units and artifact hashes.

- [ ] **Step 2: Run tests and confirm engines/adapters are absent**

Run: `npx vitest run test/pth-professional/computational-chemist.integration.test.ts`

Expected: FAIL at preflight or missing exports.

- [ ] **Step 3: Install exact offline runtime dependencies**

Build the image with versions and package hashes from `deploy/professional-runtime-lock.json`. Pseudopotentials and basis data are immutable artifacts with license and hash records; jobs cannot download replacements at runtime.

- [ ] **Step 4: Implement typed adapters**

Psi4 input requires geometry, charge, multiplicity, method, basis, calculation and convergence limits. QE input requires cell, species, positions, k-points, cutoffs, pseudopotential artifact IDs and convergence limits. The adapters generate engine files server-side and do not accept raw executable commands.

- [ ] **Step 5: Add resource and scientific-integrity tests**

Cover invalid geometry, missing pseudopotential, unit mismatch, resource estimate above budget, timeout, SCF non-convergence, engine error, output parser mismatch and artifact tampering. `not-converged` is a valid structured outcome but not success.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/pth-professional/computational-chemist.integration.test.ts test/pth-runner/professional-task-capability.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add toolstore/extensions/computational-chemistry src/pth/execution/adapters/computational-chemistry-adapter.ts src/pth/bootstrap/professional-runtime-adapters.ts deploy/Dockerfile deploy/professional-runtime-lock.json test/pth-professional/computational-chemist.integration.test.ts
git commit -m "feat(professional): add computational chemistry vertical"
```

---

### Task 9: Technical Educator and Executable Jupyter Guides

**Files:**
- Create: `src/pth/contracts/notebook-guide.ts`
- Modify: `src/pth/contracts/index.ts`
- Create: `src/pth/execution/notebook-guide.ts`
- Create: `src/pth/execution/adapters/jupyter-runtime-adapter.ts`
- Modify: `src/pth/bootstrap/professional-runtime-adapters.ts`
- Modify: `toolstore/extensions/jupyter-asm/kernel.py`
- Create: `toolstore/extensions/jupyter-guide/validate.py`
- Create: `test/pth-professional/notebook-guide.test.ts`
- Create: `test/pth-professional/technical-educator.integration.test.ts`

**Interfaces:**
- Consumes: verified Professional Job Results and artifacts from Tasks 5–8, Index Memory citations, Jupyter service.
- Produces: `NotebookGuideManifest`, deterministic nbformat builder, `createJupyterRuntimeAdapter()`, execute-all report and domain-review result.

- [ ] **Step 1: Write manifest and hidden-state tests**

```ts
expect(validateNotebookGuideManifest(manifest).ok).toBe(true);
expect(validateNotebookGuideManifest({ ...manifest, sourceJobIds: [] }).ok).toBe(false);
expect(scanNotebook(notebook)).toEqual({ secrets: [], absolutePaths: [], oversizedOutputs: [] });
```

- [ ] **Step 2: Run tests and confirm the guide contract is absent**

Run: `npx vitest run test/pth-professional/notebook-guide.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement deterministic nbformat v4 generation**

Build cells from a typed lesson model containing objectives, prerequisites, environment, explanation, executable steps, expected checks, error guidance, exercises and citations. IDs and ordering derive from canonical input; no LLM-generated arbitrary metadata is trusted.

- [ ] **Step 4: Implement clean-kernel execution and validation**

The Jupyter adapter copies the draft into a fresh workspace, clears outputs, runs the entire notebook with a timeout, writes an executed notebook and execution report, then compares expected checks. It scans for secrets, host paths, hidden-state failures and output-size limits.

- [ ] **Step 5: Produce and review four real tutorials**

Generate one Notebook for each professional vertical. Each manifest binds source job and artifact hashes. The matching professional Role reviews technical results; `technical-educator` cannot self-approve technical correctness.

- [ ] **Step 6: Run Jupyter and role integration tests**

Run: `bash toolstore/extensions/jupyter-asm/test/run_tests.sh`

Run: `npx vitest run test/pth-professional/notebook-guide.test.ts test/pth-professional/technical-educator.integration.test.ts`

Expected: four fresh-kernel notebooks executed and reviewed; zero skipped tests.

- [ ] **Step 7: Commit**

```bash
git add src/pth/contracts/notebook-guide.ts src/pth/contracts/index.ts src/pth/execution/notebook-guide.ts src/pth/execution/adapters/jupyter-runtime-adapter.ts src/pth/bootstrap/professional-runtime-adapters.ts toolstore/extensions/jupyter-asm/kernel.py toolstore/extensions/jupyter-guide test/pth-professional/notebook-guide.test.ts test/pth-professional/technical-educator.integration.test.ts
git commit -m "feat(tutorials): add executable jupyter guide pipeline"
```

---

### Task 10: Shared-Memory Cross-Role Acceptance and v1.3 Authority

**Files:**
- Create: `scripts/eval-v13-professional-computing.ts`
- Create: `scripts/accept-v13.ts`
- Create: `test/pth-composition/v13-professional-computing.test.ts`
- Create: `docs/pth/v13-professional-computing-report.md`
- Create: `docs/pth/v13-professional-computing-envelope.json`
- Modify: `docs/README.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: Tasks 1–9 and the N30 acceptance envelope from the separate N30 plan.
- Produces: mechanical M0/P0–P6 decision, version report and commit-bound acceptance envelope.

- [ ] **Step 1: Write the composition test before the evaluator**

The test creates overlapping regions over one canonical memory corpus, assigns four professional Worker Replicas, runs one real `run` task per Role, generates four notebooks and asserts no body duplication. It also creates one `run→intake` knowledge-gap handoff and one `run→optimize` telemetry handoff, verifying new work IDs, immutable source modes and complete causation. It verifies an index entry can route more than one Role to the same artifact while each Task Working Set stays inside its own budget.

- [ ] **Step 2: Add sabotage cases**

Add one executable sabotage per boundary: work-mode in-place mutation, client mode self-stamp, copied index body, budget bypass, wrong role/runtime, arbitrary command field, missing artifact hash, Lean placeholder, Wolfram fallback masquerade, chemistry non-convergence marked success, Notebook historical-output-only success, and specialist default replica creation. Each sabotage must flip only its mapped gate.

- [ ] **Step 3: Implement evaluator metrics and fail-closed decision**

The evaluator reports exact denominators for memory types, adapters, real job cases, notebooks, authorization probes and sabotage probes. Missing/NaN/zero denominators are NO-GO. It runs twice and requires byte-identical output.

- [ ] **Step 4: Implement acceptance driver**

The driver records evaluated commit, clean-tree state, professional dependency preflight, focused test JSON, full test JSON, lint, build, N29 regression envelope and N30 envelope. Environment absence is `EVALUATION-INCOMPLETE`; any started non-zero gate is NO-GO.

- [ ] **Step 5: Run the complete authority sequence**

Run: `node --import tsx scripts/eval-v13-professional-computing.ts`

Run again and compare byte-for-byte.

Run: `npx vitest run test/pth-professional test/pth-composition/v13-professional-computing.test.ts --reporter=json --outputFile /tmp/v13-focused.json`

Run: `npm test -- --reporter=json --outputFile /tmp/v13-full.json`

Run: `npm run lint`

Run: `npm run build`

Run: `node --import tsx scripts/accept-v13.ts`

Expected: GO only when all professional dependencies, N29 regressions and the N30 envelope pass with no new skips.

- [ ] **Step 6: Commit implementation evidence, then generate the final report commit**

```bash
git add scripts/eval-v13-professional-computing.ts scripts/accept-v13.ts test/pth-composition/v13-professional-computing.test.ts
git commit -m "test(v13): add professional computing authority gate"
```

Run the acceptance driver on that commit, write the report/envelope with the evaluated SHA, then:

```bash
git add docs/pth/v13-professional-computing-report.md docs/pth/v13-professional-computing-envelope.json docs/README.md TODO.md
git commit -m "docs(v13): publish professional computing acceptance"
```
