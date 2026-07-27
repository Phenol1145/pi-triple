# Agent Lab Phase 1 Core Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有 Weighted Scorer、Arena 和 subagent 在线路径的前提下，建立版本化定义注册、Core 持久化、追加事件、命名空间存储及 SchedulerInstance 的 Draft → Validate → Activate 原子控制面。

**Architecture:** 新代码全部放在 `src/core/`，通过一个独立 `createLabCore(db)` 工厂组装；P1 不修改 `index.ts`，因此新 Core 处于旁路状态。定义先保存在进程内不可变注册表中，实例、Agent、Round、草稿、事件和命名空间 KV 追加到现有 SQLite 数据库的新表；激活由单一事务原子创建 SchedulerInstance、Round 0、初始 Agent 和审计事件。

**Tech Stack:** TypeScript ESM；Node v24.14.1；`node:sqlite` `DatabaseSync`；`node:test`；`node --experimental-strip-types --test`；相对导入使用 `.ts`。

## Global Constraints

- 本阶段不得修改 `index.ts` 的在线调度装配，不得接管现有 interceptor 或 telemetry hook。
- 当前 `classic/market` 配置和旧表保持原样；数据库变更只能新增表和索引。
- 当前 63 项测试是行为基线，阶段结束时必须全部通过。
- SchedulerDefinition、WorkLoopDefinition 和 OptimizerDefinition 的同一 `kind/id/version` 不可覆盖。
- SchedulerInstance 激活必须原子创建实例、Round 0、初始 Agent 和审计事件；失败不得留下半成品。
- AgentInstance 创建后不得改变 `schedulerInstanceId`。
- Round 0 参数和 AgentDefinition 必须保存不可变 JSON 快照。
- 事件写入按 `eventId` 幂等；同一 trace/execution 的 sequence 由调用方提供，本阶段只保存和查询。
- 命名空间 KV 使用显式版本和 compare-and-swap；冲突不得静默覆盖。
- P1 不执行 WorkLoop、不调用模型、不实现 Optimizer 运行、灰度或数据投影。
- 每个任务先写失败测试，再写最小实现，并以独立 commit 结束。

---

## File Structure

```text
src/core/
├── contracts.ts                 # P1 公共 ID、定义、实例、轮次、事件和验证类型
├── definitions/registry.ts      # 不可变的进程内 DefinitionRegistry
├── storage/schema.ts            # 仅追加的 Core SQLite DDL
├── storage/repository.ts        # draft/instance/agent/round 查询与激活事务
├── storage/namespaced-store.ts  # 带版本的 Scheduler/Agent 命名空间 KV
├── events/event-log.ts          # 幂等追加及按 trace/type 查询
├── control-plane/service.ts     # Draft→Validate→Activate 业务服务
└── create-core.ts               # P1 旁路 Core 组装工厂

test/
├── core-definition-registry.test.ts
├── core-repository.test.ts
├── core-event-log.test.ts
├── core-namespaced-store.test.ts
└── core-control-plane.test.ts
```

文件职责边界：

- `contracts.ts` 只定义可序列化契约和少量纯辅助类型，不访问 SQLite。
- `registry.ts` 只管理定义，不管理运行实例。
- `repository.ts` 拥有关系表写入和跨表事务；不解释插件业务参数。
- `event-log.ts` 只管理追加式事件。
- `namespaced-store.ts` 只管理私有 KV 与 CAS。
- `service.ts` 负责草稿验证、Definition 调用和状态转换，不直接拼 SQL。
- `create-core.ts` 只组装依赖，P1 不从 `index.ts` 调用。

---

### Task 1: Core Contracts and Immutable Definition Registry

**Files:**
- Create: `src/core/contracts.ts`
- Create: `src/core/definitions/registry.ts`
- Test: `test/core-definition-registry.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `DefinitionRef`, `DefinitionKind`, `ValidationIssue`, `ValidationResult`
  - `SchedulerDefinition`, `WorkLoopDefinition`, `OptimizerDefinition`, `LabDefinition`
  - `DefinitionRegistry.register(definition): void`
  - `DefinitionRegistry.resolve(ref): LabDefinition | undefined`
  - `DefinitionRegistry.require(ref): LabDefinition`
  - `DefinitionRegistry.list(kind?): DefinitionSummary[]`

- [ ] **Step 1: Write the failing registry tests**

Create `test/core-definition-registry.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DefinitionRegistry, DefinitionConflictError, DefinitionNotFoundError } from "../src/core/definitions/registry.ts";
import type { SchedulerDefinition, WorkLoopDefinition } from "../src/core/contracts.ts";

const ok = { ok: true as const, value: {} };

function scheduler(version = "1.0.0"): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "test-scheduler",
    version,
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: { limit: 1 },
    tunablePaths: ["limit"],
    validateParameters: () => ok,
    validateAgentDefinition: () => ok,
  };
}

function workLoop(): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: "test-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
  };
}

test("DefinitionRegistry stores and resolves exact kind/id/version", () => {
  const registry = new DefinitionRegistry();
  registry.register(scheduler());
  registry.register(workLoop());
  assert.equal(registry.require({ kind: "scheduler", id: "test-scheduler", version: "1.0.0" }).kind, "scheduler");
  assert.equal(registry.require({ kind: "workloop", id: "test-loop", version: "1.0.0" }).kind, "workloop");
});

test("DefinitionRegistry permits a new version but rejects overwrite", () => {
  const registry = new DefinitionRegistry();
  registry.register(scheduler("1.0.0"));
  registry.register(scheduler("1.1.0"));
  assert.equal(registry.list("scheduler").length, 2);
  assert.throws(() => registry.register(scheduler("1.0.0")), DefinitionConflictError);
});

test("DefinitionRegistry returns defensive immutable snapshots", () => {
  const registry = new DefinitionRegistry();
  const original = scheduler();
  registry.register(original);
  (original.defaultParameters as { limit: number }).limit = 99;
  const stored = registry.require({ kind: "scheduler", id: "test-scheduler", version: "1.0.0" }) as SchedulerDefinition;
  assert.deepEqual(stored.defaultParameters, { limit: 1 });
  assert.ok(Object.isFrozen(stored));
});

test("DefinitionRegistry require throws a typed missing-definition error", () => {
  const registry = new DefinitionRegistry();
  assert.throws(
    () => registry.require({ kind: "optimizer", id: "missing", version: "1" }),
    DefinitionNotFoundError,
  );
});
```

- [ ] **Step 2: Run the registry test and verify it fails**

Run:

```bash
node --experimental-strip-types --test test/core-definition-registry.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/core/definitions/registry.ts`.

- [ ] **Step 3: Add the public contracts**

Create `src/core/contracts.ts` with these exact public shapes:

```ts
export type JsonSchema = Readonly<Record<string, unknown>>;
export type DefinitionKind = "scheduler" | "workloop" | "optimizer";

export interface DefinitionRef {
  kind: DefinitionKind;
  id: string;
  version: string;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  validatedAt: number;
}

export type ValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

interface DefinitionBase {
  kind: DefinitionKind;
  id: string;
  version: string;
  sdkVersionRange: string;
}

export interface SchedulerDefinition extends DefinitionBase {
  kind: "scheduler";
  parameterModelVersion: string;
  agentDefinitionSchemaVersion: string;
  parameterSchema: JsonSchema;
  agentDefinitionSchema: JsonSchema;
  schedulerStateSchema?: JsonSchema;
  defaultParameters: unknown;
  tunablePaths: string[];
  validateParameters(value: unknown): ValidationResult;
  validateAgentDefinition(value: unknown): ValidationResult;
  validateTransition?(current: unknown, proposed: unknown): ValidationResult;
}

export interface WorkLoopDefinition extends DefinitionBase {
  kind: "workloop";
  configSchema: JsonSchema;
  stateSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  errorSchema?: JsonSchema;
  traceSchema?: JsonSchema;
  requiredCapabilities: string[];
  cloneModes: string[];
}

export interface OptimizerDefinition extends DefinitionBase {
  kind: "optimizer";
  configurationSchema: JsonSchema;
  stateSchema?: JsonSchema;
  requiredMetrics: string[];
  compatibleSchedulers: Array<{ id: string; versionRange: string }>;
  parameterModelVersionRange: string;
}

export type LabDefinition = SchedulerDefinition | WorkLoopDefinition | OptimizerDefinition;

export interface DefinitionSummary extends DefinitionRef {
  sdkVersionRange: string;
}

export interface AgentDefinition {
  standard: {
    name: string;
    description?: string;
    capabilities: string[];
    executionKind: string;
    labels: Record<string, string>;
  };
  workLoop: { id: string; version: string; config: unknown };
  custom: unknown;
}

export type SchedulerInstanceStatus = "draft" | "active" | "inactive" | "migrating";
export type OptimizationRoundStatus = "initial" | "proposed" | "validated" | "canary" | "active" | "rejected" | "superseded" | "rolled-back";
export type AgentInstanceStatus = "ready" | "running" | "queued" | "inactive" | "failed";

export interface FallbackTargetScheduler { type: "scheduler-instance"; id: string }
export interface FallbackTargetOriginal { type: "original-request" }
export interface FallbackTargetFail { type: "fail"; errorCode: string }
export type FallbackTarget = FallbackTargetScheduler | FallbackTargetOriginal | FallbackTargetFail;

export interface AgentCreateSpec {
  id: string;
  definition: AgentDefinition;
  sourceAgentId?: string;
  cloneOperationId?: string;
}

export interface SchedulerInstanceDraftSpec {
  id: string;
  schedulerDefinition: DefinitionRef;
  initialParameters?: unknown;
  agents: AgentCreateSpec[];
  fallbackChain: FallbackTarget[];
  routingBindings: Array<{
    id: string;
    priority: number;
    match: { role?: string; taskCategory?: string; labels?: Record<string, string>; caller?: string };
  }>;
  metadata?: Record<string, string>;
}

export interface SchedulerInstanceRecord {
  id: string;
  definition: DefinitionRef;
  parameterModelVersion: string;
  agentDefinitionSchemaVersion: string;
  status: SchedulerInstanceStatus;
  currentRoundId: string;
  fallbackChain: FallbackTarget[];
  createdAt: number;
}

export interface OptimizationRoundRecord {
  id: string;
  schedulerInstanceId: string;
  sequence: number;
  parentRoundId?: string;
  parameters: unknown;
  optimizer?: { instanceId: string; definitionId: string; definitionVersion: string };
  proposalId?: string;
  status: OptimizationRoundStatus;
  createdAt: number;
  activatedAt?: number;
}

export interface AgentInstanceRecord {
  id: string;
  schedulerInstanceId: string;
  definition: AgentDefinition;
  sourceAgentId?: string;
  cloneOperationId?: string;
  createdAtRoundId: string;
  status: AgentInstanceStatus;
  createdAt: number;
}

export interface LabEvent<TPayload = unknown> {
  eventId: string;
  eventType: string;
  schemaVersion: string;
  timestamp: number;
  sequence?: number;
  identity: {
    traceId: string;
    sessionId?: string;
    dispatchId?: string;
    executionId?: string;
    parentExecutionId?: string;
    schedulerInstanceId?: string;
    schedulerDefinitionId?: string;
    schedulerDefinitionVersion?: string;
    optimizationRoundId?: string;
    agentInstanceId?: string;
    workLoopId?: string;
    workLoopVersion?: string;
    checkpointId?: string;
    optimizerInstanceId?: string;
    proposalId?: string;
  };
  payload: TPayload;
  metrics?: Record<string, string | number | boolean | null>;
  artifactRefs?: string[];
}
```

P1 通过定义中的校验函数执行确定性验证，不新增 JSON Schema 编译依赖。Schema 描述仍被保存和版本化；统一编译器在插件 compliance 阶段加入。

- [ ] **Step 4: Implement the immutable registry**

Create `src/core/definitions/registry.ts`:

```ts
import type { DefinitionKind, DefinitionRef, DefinitionSummary, LabDefinition } from "../contracts.ts";

function keyOf(ref: DefinitionRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}`;
}

function cloneDefinition<T extends LabDefinition>(definition: T): T {
  if (definition.kind === "scheduler") {
    const { validateParameters, validateAgentDefinition, validateTransition, ...serializable } = definition;
    return deepFreeze({
      ...structuredClone(serializable),
      validateParameters,
      validateAgentDefinition,
      validateTransition,
    }) as T;
  }
  return deepFreeze(structuredClone(definition));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export class DefinitionConflictError extends Error {}
export class DefinitionNotFoundError extends Error {}

export class DefinitionRegistry {
  private readonly definitions = new Map<string, LabDefinition>();

  register(definition: LabDefinition): void {
    const ref: DefinitionRef = { kind: definition.kind, id: definition.id, version: definition.version };
    const key = keyOf(ref);
    if (this.definitions.has(key)) throw new DefinitionConflictError(`definition already registered: ${definition.kind}/${definition.id}@${definition.version}`);
    this.definitions.set(key, cloneDefinition(definition));
  }

  resolve(ref: DefinitionRef): LabDefinition | undefined {
    return this.definitions.get(keyOf(ref));
  }

  require(ref: DefinitionRef): LabDefinition {
    const definition = this.resolve(ref);
    if (!definition) throw new DefinitionNotFoundError(`definition not found: ${ref.kind}/${ref.id}@${ref.version}`);
    return definition;
  }

  list(kind?: DefinitionKind): DefinitionSummary[] {
    return [...this.definitions.values()]
      .filter((definition) => !kind || definition.kind === kind)
      .map((definition) => ({ kind: definition.kind, id: definition.id, version: definition.version, sdkVersionRange: definition.sdkVersionRange }))
      .sort((a, b) => `${a.kind}/${a.id}@${a.version}`.localeCompare(`${b.kind}/${b.id}@${b.version}`));
  }
}
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
node --experimental-strip-types --test test/core-definition-registry.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 6: Run the baseline suite**

Run:

```bash
npm test
```

Expected: existing 63 tests plus 4 new tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/contracts.ts src/core/definitions/registry.ts test/core-definition-registry.test.ts
git commit -m "feat(core): add versioned definition contracts and registry"
```

---

### Task 2: Additive Core Schema and Runtime Repository

**Files:**
- Create: `src/core/storage/schema.ts`
- Create: `src/core/storage/repository.ts`
- Test: `test/core-repository.test.ts`

**Interfaces:**
- Consumes: records from `src/core/contracts.ts`.
- Produces:
  - `CORE_SCHEMA`
  - `CoreRepository.saveDraft(spec): void`
  - `CoreRepository.getDraft(id): StoredDraft | undefined`
  - `CoreRepository.listInstances(): SchedulerInstanceRecord[]`
  - `CoreRepository.getInstance(id): SchedulerInstanceRecord | undefined`
  - `CoreRepository.getRound(id): OptimizationRoundRecord | undefined`
  - `CoreRepository.listAgents(schedulerInstanceId): AgentInstanceRecord[]`
  - `CoreRepository.transaction<T>(fn): T`
  - package-private insert/update methods used by Task 5.

- [ ] **Step 1: Write failing repository tests**

Create `test/core-repository.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { SchedulerInstanceDraftSpec } from "../src/core/contracts.ts";

function draft(): SchedulerInstanceDraftSpec {
  return {
    id: "coding-scheduler",
    schedulerDefinition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    initialParameters: { completion: 0.7 },
    agents: [],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [{ id: "coding", priority: 10, match: { role: "worker" } }],
    metadata: { owner: "test" },
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  const repo = new CoreRepository(db);
  return { db, repo };
}

test("CoreRepository stores draft as an immutable JSON snapshot", () => {
  const { db, repo } = setup();
  const value = draft();
  repo.saveDraft(value);
  value.initialParameters = { completion: 0 };
  assert.deepEqual(repo.getDraft("coding-scheduler")?.spec.initialParameters, { completion: 0.7 });
  db.close();
});

test("CoreRepository rejects duplicate draft ids", () => {
  const { db, repo } = setup();
  repo.saveDraft(draft());
  assert.throws(() => repo.saveDraft(draft()), /draft already exists/);
  db.close();
});

test("CoreRepository transaction rolls back every write on error", () => {
  const { db, repo } = setup();
  assert.throws(() => repo.transaction(() => {
    repo.saveDraft(draft());
    throw new Error("stop");
  }), /stop/);
  assert.equal(repo.getDraft("coding-scheduler"), undefined);
  db.close();
});

test("Core schema is additive and does not alter legacy tables", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, role TEXT NOT NULL)");
  new CoreRepository(db);
  db.prepare("INSERT INTO runs (role) VALUES (?)").run("worker");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);
  db.close();
});
```

- [ ] **Step 2: Run the repository test and verify it fails**

Run:

```bash
node --experimental-strip-types --test test/core-repository.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `repository.ts`.

- [ ] **Step 3: Add the additive schema**

Create `src/core/storage/schema.ts` with these tables and indexes:

```ts
export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS lab_scheduler_drafts (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'validated', 'activated', 'rejected')),
  validation_json TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_scheduler_instances (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  parameter_model_version TEXT NOT NULL,
  agent_schema_version TEXT NOT NULL,
  status TEXT NOT NULL,
  current_round_id TEXT NOT NULL,
  fallback_chain_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_optimization_rounds (
  id TEXT PRIMARY KEY,
  scheduler_instance_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  parent_round_id TEXT,
  parameters_json TEXT NOT NULL,
  optimizer_json TEXT,
  proposal_id TEXT,
  status TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  activated_ts INTEGER,
  UNIQUE(scheduler_instance_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_lab_rounds_scheduler ON lab_optimization_rounds(scheduler_instance_id, sequence);

CREATE TABLE IF NOT EXISTS lab_agent_instances (
  id TEXT PRIMARY KEY,
  scheduler_instance_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  source_agent_id TEXT,
  clone_operation_id TEXT,
  created_round_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_agents_scheduler ON lab_agent_instances(scheduler_instance_id, id);

CREATE TABLE IF NOT EXISTS lab_routing_bindings (
  id TEXT PRIMARY KEY,
  scheduler_instance_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  match_json TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_routes_priority ON lab_routing_bindings(priority DESC, id);
`;
```

Foreign keys are intentionally omitted in P1 because the existing database may not enable `PRAGMA foreign_keys`; transactional service validation enforces relationships. Add real FKs only in a versioned migration after the database policy is standardized.

- [ ] **Step 4: Implement draft persistence, queries, and transaction helper**

Create `src/core/storage/repository.ts`. Use explicit `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK`, and reject nested `transaction()` calls with `nested core transaction is not supported`.

Required stored helper type:

```ts
export interface StoredDraft {
  id: string;
  spec: SchedulerInstanceDraftSpec;
  status: "draft" | "validated" | "activated" | "rejected";
  validation?: ValidationReport;
  createdAt: number;
  updatedAt: number;
}
```

Required public constructor and methods:

```ts
export class CoreRepository {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(CORE_SCHEMA);
  }

  transaction<T>(fn: () => T): T;
  saveDraft(spec: SchedulerInstanceDraftSpec): void;
  getDraft(id: string): StoredDraft | undefined;
  setDraftValidation(id: string, result: ValidationReport): void;
  setDraftStatus(id: string, status: StoredDraft["status"]): void;
  getInstance(id: string): SchedulerInstanceRecord | undefined;
  listInstances(): SchedulerInstanceRecord[];
  getRound(id: string): OptimizationRoundRecord | undefined;
  listAgents(schedulerInstanceId: string): AgentInstanceRecord[];
  getRoutingOwner(bindingId: string): string | undefined;
}
```

Also add these write methods for Task 5; they are public because the service is in a separate module, but only Core control-plane code should call them:

```ts
insertInstance(record: SchedulerInstanceRecord, metadata: Record<string, string>): void;
insertRound(record: OptimizationRoundRecord): void;
insertAgent(record: AgentInstanceRecord): void;
insertRoutingBinding(schedulerInstanceId: string, binding: SchedulerInstanceDraftSpec["routingBindings"][number]): void;
```

Use `JSON.stringify` on writes and `JSON.parse` on reads. Return newly parsed objects, never internal mutable references. `saveDraft` uses plain `INSERT`; convert SQLite unique errors into `new Error("draft already exists: <id>")`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --experimental-strip-types --test test/core-repository.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 6: Run all tests**

Run:

```bash
npm test
```

Expected: all baseline and new tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/storage/schema.ts src/core/storage/repository.ts test/core-repository.test.ts
git commit -m "feat(core): add additive instance and round repository"
```

---

### Task 3: Idempotent Append-Only Event Log

**Files:**
- Modify: `src/core/storage/schema.ts`
- Create: `src/core/events/event-log.ts`
- Test: `test/core-event-log.test.ts`

**Interfaces:**
- Consumes: `LabEvent` from Task 1 and `DatabaseSync`.
- Produces:
  - `EventLog.append(event): "inserted" | "duplicate"`
  - `EventLog.get(eventId): LabEvent | undefined`
  - `EventLog.query({ traceId?, eventType?, limit? }): LabEvent[]`

- [ ] **Step 1: Write failing event-log tests**

Create `test/core-event-log.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventLog } from "../src/core/events/event-log.ts";
import type { LabEvent } from "../src/core/contracts.ts";

function event(id: string, type = "scheduler.started", traceId = "trace-1"): LabEvent {
  return {
    eventId: id,
    eventType: type,
    schemaVersion: "1",
    timestamp: 100,
    sequence: 1,
    identity: { traceId, schedulerInstanceId: "scheduler-1" },
    payload: { answer: 42 },
    metrics: { durationMs: 12 },
    artifactRefs: ["artifact-1"],
  };
}

test("EventLog appends and reads an event without losing envelope fields", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  assert.equal(log.append(event("e1")), "inserted");
  assert.deepEqual(log.get("e1"), event("e1"));
  db.close();
});

test("EventLog treats repeated eventId as an idempotent duplicate", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  assert.equal(log.append(event("e1")), "inserted");
  assert.equal(log.append(event("e1")), "duplicate");
  assert.equal(log.query({ traceId: "trace-1" }).length, 1);
  db.close();
});

test("EventLog rejects conflicting payload reuse for the same eventId", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  log.append(event("e1"));
  const conflict = event("e1");
  conflict.payload = { answer: 7 };
  assert.throws(() => log.append(conflict), /event id conflict/);
  db.close();
});

test("EventLog queries deterministically by trace and type", () => {
  const db = new DatabaseSync(":memory:");
  const log = new EventLog(db);
  log.append(event("e2", "scheduler.completed"));
  log.append(event("e1", "scheduler.started"));
  log.append(event("e3", "scheduler.started", "trace-2"));
  assert.deepEqual(log.query({ traceId: "trace-1", eventType: "scheduler.started" }).map((x) => x.eventId), ["e1"]);
  db.close();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
node --experimental-strip-types --test test/core-event-log.test.ts
```

Expected: FAIL with missing module.

- [ ] **Step 3: Add the event table to `CORE_SCHEMA`**

Append before the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS lab_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sequence INTEGER,
  trace_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_events_trace ON lab_events(trace_id, ts, event_id);
CREATE INDEX IF NOT EXISTS idx_lab_events_type ON lab_events(event_type, ts, event_id);
```

- [ ] **Step 4: Implement canonical hashing and event queries**

Create `src/core/events/event-log.ts` using `createHash` from `node:crypto`.

Canonicalize the complete event before hashing by recursively sorting object keys while preserving array order:

```ts
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
```

Required API:

```ts
export class EventLog {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(CORE_SCHEMA);
  }

  append(event: LabEvent): "inserted" | "duplicate";
  get(eventId: string): LabEvent | undefined;
  query(filter: { traceId?: string; eventType?: string; limit?: number }): LabEvent[];
}
```

`append` behavior:

1. Compute SHA-256 of canonical JSON.
2. If `eventId` exists with the same hash, return `duplicate`.
3. If it exists with a different hash, throw `event id conflict: <id>`.
4. Otherwise insert all fields and return `inserted`.

`query` builds one of four fixed SQL statements rather than concatenating arbitrary field names. Order by `ts ASC, event_id ASC`; default limit is 1000, clamped to 1..10000.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --experimental-strip-types --test test/core-event-log.test.ts
npm test
```

Expected: focused 4 tests PASS; full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/storage/schema.ts src/core/events/event-log.ts test/core-event-log.test.ts
git commit -m "feat(core): add idempotent append-only event log"
```

---

### Task 4: Versioned Namespaced Storage with Compare-and-Swap

**Files:**
- Modify: `src/core/storage/schema.ts`
- Create: `src/core/storage/namespaced-store.ts`
- Test: `test/core-namespaced-store.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` and `CORE_SCHEMA`.
- Produces:
  - `NamespacedStore.get(namespace, key): VersionedValue | undefined`
  - `NamespacedStore.put(namespace, key, value, expectedVersion): VersionedValue`
  - `NamespacedStore.delete(namespace, key, expectedVersion): void`
  - `VersionConflictError`

- [ ] **Step 1: Write failing CAS tests**

Create `test/core-namespaced-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NamespacedStore, VersionConflictError } from "../src/core/storage/namespaced-store.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  return { db, store: new NamespacedStore(db) };
}

test("NamespacedStore creates at expected version 0 and increments versions", () => {
  const { db, store } = setup();
  assert.deepEqual(store.put("scheduler:s1", "state", { n: 1 }, 0), { value: { n: 1 }, version: 1 });
  assert.deepEqual(store.put("scheduler:s1", "state", { n: 2 }, 1), { value: { n: 2 }, version: 2 });
  assert.deepEqual(store.get("scheduler:s1", "state"), { value: { n: 2 }, version: 2 });
  db.close();
});

test("NamespacedStore rejects stale writers", () => {
  const { db, store } = setup();
  store.put("agent:a1", "runtime", { step: 1 }, 0);
  assert.throws(() => store.put("agent:a1", "runtime", { step: 2 }, 0), VersionConflictError);
  assert.deepEqual(store.get("agent:a1", "runtime"), { value: { step: 1 }, version: 1 });
  db.close();
});

test("NamespacedStore isolates equal keys across namespaces", () => {
  const { db, store } = setup();
  store.put("scheduler:s1", "state", "one", 0);
  store.put("scheduler:s2", "state", "two", 0);
  assert.equal(store.get("scheduler:s1", "state")?.value, "one");
  assert.equal(store.get("scheduler:s2", "state")?.value, "two");
  db.close();
});

test("NamespacedStore delete requires the current version", () => {
  const { db, store } = setup();
  store.put("agent:a1", "state", { ok: true }, 0);
  assert.throws(() => store.delete("agent:a1", "state", 0), VersionConflictError);
  store.delete("agent:a1", "state", 1);
  assert.equal(store.get("agent:a1", "state"), undefined);
  db.close();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --experimental-strip-types --test test/core-namespaced-store.test.ts
```

Expected: FAIL with missing module.

- [ ] **Step 3: Add KV schema**

Append to `CORE_SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS lab_namespace_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY(namespace, key)
);
```

- [ ] **Step 4: Implement atomic CAS**

Create `src/core/storage/namespaced-store.ts`:

```ts
export interface VersionedValue<T = unknown> {
  value: T;
  version: number;
}

export class VersionConflictError extends Error {}

export class NamespacedStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(CORE_SCHEMA);
  }

  get<T = unknown>(namespace: string, key: string): VersionedValue<T> | undefined;
  put<T>(namespace: string, key: string, value: T, expectedVersion: number): VersionedValue<T>;
  delete(namespace: string, key: string, expectedVersion: number): void;
}
```

Implementation rules:

- Reject empty namespace or key with `namespace and key are required`.
- `expectedVersion === 0` uses `INSERT ... ON CONFLICT DO NOTHING`; `changes !== 1` means conflict.
- Existing values use `UPDATE ... SET version = version + 1 WHERE namespace = ? AND key = ? AND version = ?`; `changes !== 1` means conflict.
- `delete` uses `DELETE ... WHERE ... version = ?`; `changes !== 1` means conflict.
- Reject negative or non-integer expected versions.
- Serialize with JSON and return parsed snapshots.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --experimental-strip-types --test test/core-namespaced-store.test.ts
npm test
```

Expected: focused 4 tests PASS; full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/storage/schema.ts src/core/storage/namespaced-store.ts test/core-namespaced-store.test.ts
git commit -m "feat(core): add versioned namespaced storage"
```

---

### Task 5: Draft Validation and Atomic Activation Control Plane

**Files:**
- Create: `src/core/control-plane/service.ts`
- Test: `test/core-control-plane.test.ts`

**Interfaces:**
- Consumes:
  - `DefinitionRegistry.require()` from Task 1
  - `CoreRepository` from Task 2
  - `EventLog` from Task 3
- Produces:
  - `ControlPlane.createDraft(spec): void`
  - `ControlPlane.validateDraft(id): ValidationReport`
  - `ControlPlane.activateDraft(id): ActivationResult`
  - `DraftValidationError`

- [ ] **Step 1: Write the failing control-plane tests**

Create `test/core-control-plane.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { ControlPlane, DraftValidationError } from "../src/core/control-plane/service.ts";
import type { SchedulerDefinition, SchedulerInstanceDraftSpec, WorkLoopDefinition } from "../src/core/contracts.ts";

function scheduler(): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "weighted-scorer",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: { topN: 1 },
    tunablePaths: ["topN"],
    validateParameters: (value) => {
      const topN = (value as { topN?: unknown })?.topN;
      return Number.isInteger(topN) && Number(topN) > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "topN", code: "range", message: "topN must be a positive integer" }] };
    },
    validateAgentDefinition: (value) => {
      const name = (value as { standard?: { name?: unknown } })?.standard?.name;
      return typeof name === "string" && name.length > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "standard.name", code: "required", message: "agent name is required" }] };
    },
  };
}

const loop: WorkLoopDefinition = {
  kind: "workloop",
  id: "pi-default-loop",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: { type: "object" },
  requiredCapabilities: [],
  cloneModes: ["fresh", "fork"],
};

function draft(overrides: Partial<SchedulerInstanceDraftSpec> = {}): SchedulerInstanceDraftSpec {
  return {
    id: "coding-scorer",
    schedulerDefinition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    initialParameters: { topN: 2 },
    agents: [{
      id: "coding-agent-1",
      definition: {
        standard: { name: "Coding Agent", capabilities: ["code"], executionKind: "pi-subagent", labels: {} },
        workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
        custom: { model: "openai/gpt-5" },
      },
    }],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [{ id: "coding-route", priority: 10, match: { role: "worker" } }],
    ...overrides,
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  const definitions = new DefinitionRegistry();
  definitions.register(scheduler());
  definitions.register(loop);
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const service = new ControlPlane(definitions, repository, events, () => 1_000);
  return { db, definitions, repository, events, service };
}

test("validateDraft reports parameters, workloop references, duplicate agent ids, and fallback targets", () => {
  const { db, service } = setup();
  service.createDraft(draft({
    initialParameters: { topN: 0 },
    agents: [draft().agents[0], draft().agents[0]],
    fallbackChain: [{ type: "scheduler-instance", id: "missing" }],
  }));
  const report = service.validateDraft("coding-scorer");
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.map((x) => x.code).sort(), ["duplicate-agent-id", "fallback-not-active", "range"]);
  db.close();
});

test("validateDraft rejects indirect fallback cycles", () => {
  const { db, repository, service } = setup();
  repository.insertInstance({
    id: "existing",
    definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    status: "active",
    currentRoundId: "existing:round:0",
    fallbackChain: [{ type: "scheduler-instance", id: "coding-scorer" }],
    createdAt: 1,
  }, {});
  service.createDraft(draft({ fallbackChain: [{ type: "scheduler-instance", id: "existing" }] }));
  const report = service.validateDraft("coding-scorer");
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((x) => x.code === "fallback-cycle"));
  db.close();
});

test("activateDraft atomically creates active instance, round 0, agent, route, and event", () => {
  const { db, repository, events, service } = setup();
  service.createDraft(draft());
  const report = service.validateDraft("coding-scorer");
  assert.equal(report.ok, true);
  const result = service.activateDraft("coding-scorer");
  assert.deepEqual(result, { schedulerInstanceId: "coding-scorer", roundId: "coding-scorer:round:0", agentIds: ["coding-agent-1"] });
  assert.equal(repository.getInstance("coding-scorer")?.status, "active");
  assert.deepEqual(repository.getRound("coding-scorer:round:0")?.parameters, { topN: 2 });
  assert.equal(repository.listAgents("coding-scorer")[0].schedulerInstanceId, "coding-scorer");
  assert.equal(events.query({ eventType: "instance.activated" }).length, 1);
  db.close();
});

test("activateDraft refuses unvalidated or invalid drafts without partial state", () => {
  const { db, repository, service } = setup();
  service.createDraft(draft({ initialParameters: { topN: 0 } }));
  assert.throws(() => service.activateDraft("coding-scorer"), DraftValidationError);
  assert.equal(repository.getInstance("coding-scorer"), undefined);
  assert.equal(repository.getRound("coding-scorer:round:0"), undefined);
  assert.deepEqual(repository.listAgents("coding-scorer"), []);
  db.close();
});

test("activation rolls back if any insert conflicts", () => {
  const { db, repository, service } = setup();
  service.createDraft(draft());
  assert.equal(service.validateDraft("coding-scorer").ok, true);
  repository.insertAgent({
    id: "coding-agent-1",
    schedulerInstanceId: "other",
    definition: draft().agents[0].definition,
    createdAtRoundId: "other:round:0",
    status: "ready",
    createdAt: 1,
  });
  assert.throws(() => service.activateDraft("coding-scorer"));
  assert.equal(repository.getInstance("coding-scorer"), undefined);
  assert.equal(repository.getRound("coding-scorer:round:0"), undefined);
  db.close();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --experimental-strip-types --test test/core-control-plane.test.ts
```

Expected: FAIL with missing control-plane module.

- [ ] **Step 3: Implement validation reports**

Create `src/core/control-plane/service.ts` with:

```ts
export interface ActivationResult {
  schedulerInstanceId: string;
  roundId: string;
  agentIds: string[];
}

export class DraftValidationError extends Error {
  constructor(readonly report: ValidationReport) {
    super(`scheduler draft validation failed with ${report.issues.length} issue(s)`);
  }
}
```

`validateDraft(id)` must apply these exact checks:

1. Draft exists.
2. `schedulerDefinition.kind === "scheduler"` and exact definition exists.
3. `validateParameters(initialParameters ?? defaultParameters)` succeeds; append returned issues unchanged.
4. Every Agent ID is non-empty and unique; duplicates produce `{ path: "agents", code: "duplicate-agent-id", message: "duplicate agent id: <id>" }`.
5. Every Agent definition passes `validateAgentDefinition`.
6. Every Agent workloop exact `id@version` exists; missing produces `workloop-not-found`.
7. Each fallback SchedulerInstance exists and is active; otherwise `fallback-not-active`.
8. Build the fallback graph from the draft plus every reachable active instance's stored `fallbackChain`. If any path reaches the draft ID again, append `{ path: "fallbackChain", code: "fallback-cycle", message: "fallback cycle reaches draft: <id>" }`. Use a visited set so pre-existing unrelated cycles cannot loop validation forever.
9. Routing binding IDs in the draft are unique; duplicate produces `duplicate-route-id`.
10. A routing binding ID already owned by another instance, via `repository.getRoutingOwner(id)`, produces `route-id-conflict`.

Save the report through `repository.setDraftValidation()`. A successful report sets draft status `validated`; a failed report sets status `rejected`.

- [ ] **Step 4: Implement atomic activation**

`activateDraft(id)` behavior:

1. Load draft; missing throws `draft not found: <id>`.
2. Always re-run `validateDraft` immediately before activation so stale fallback/definition state is caught.
3. If invalid, throw `DraftValidationError`.
4. Resolve SchedulerDefinition and effective parameters (`initialParameters ?? defaultParameters`).
5. Build deterministic Round 0 ID `${draft.id}:round:0`.
6. Inside one `repository.transaction()`:
   - Insert active SchedulerInstance.
   - Insert active Round 0 with `sequence: 0`, `status: "active"`, `createdAt/activatedAt = now`.
   - Insert all initial Agents with `schedulerInstanceId = draft.id`, `createdAtRoundId = roundId`, `status = "ready"`.
   - Insert all routing bindings.
   - Append an `instance.activated` event using EventLog. Because EventLog shares the same `DatabaseSync`, its insert participates in the transaction.
   - Set draft status `activated`.
7. Return IDs in input Agent order.

Activation event:

```ts
{
  eventId: `instance.activated:${draft.id}`,
  eventType: "instance.activated",
  schemaVersion: "1",
  timestamp: now,
  identity: {
    traceId: `control:${draft.id}`,
    schedulerInstanceId: draft.id,
    schedulerDefinitionId: definition.id,
    schedulerDefinitionVersion: definition.version,
    optimizationRoundId: roundId,
  },
  payload: { agentIds, routeIds },
}
```

The EventLog `append` call must occur inside the same transaction; do not catch insertion errors.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --experimental-strip-types --test test/core-control-plane.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 6: Run all Core tests together**

Run:

```bash
node --experimental-strip-types --test test/core-*.test.ts
```

Expected: all Core tests PASS.

- [ ] **Step 7: Run the full baseline**

Run:

```bash
npm test
```

Expected: all existing and new tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/control-plane/service.ts test/core-control-plane.test.ts
git commit -m "feat(core): add draft validation and atomic activation"
```

---

### Task 6: Assemble the Sidecar Core and Verify Isolation

**Files:**
- Create: `src/core/create-core.ts`
- Modify: `test/core-control-plane.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Registry, Repository, EventLog, NamespacedStore, ControlPlane.
- Produces:
  - `createLabCore(db, options?): LabCore`
  - `LabCore` dependency bundle for P2.

- [ ] **Step 1: Add a failing factory/isolation test**

Append to `test/core-control-plane.test.ts`:

```ts
import { createLabCore } from "../src/core/create-core.ts";

test("createLabCore assembles sidecar services without registering runtime hooks", () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db, { now: () => 2_000 });
  assert.ok(core.definitions);
  assert.ok(core.repository);
  assert.ok(core.events);
  assert.ok(core.storage);
  assert.ok(core.controlPlane);
  assert.equal(Object.prototype.hasOwnProperty.call(core, "pi"), false);
  db.close();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --experimental-strip-types --test test/core-control-plane.test.ts
```

Expected: FAIL with missing `create-core.ts`.

- [ ] **Step 3: Implement the composition root**

Create `src/core/create-core.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "./definitions/registry.ts";
import { CoreRepository } from "./storage/repository.ts";
import { EventLog } from "./events/event-log.ts";
import { NamespacedStore } from "./storage/namespaced-store.ts";
import { ControlPlane } from "./control-plane/service.ts";

export interface LabCore {
  definitions: DefinitionRegistry;
  repository: CoreRepository;
  events: EventLog;
  storage: NamespacedStore;
  controlPlane: ControlPlane;
}

export function createLabCore(
  db: DatabaseSync,
  options: { now?: () => number } = {},
): LabCore {
  const definitions = new DefinitionRegistry();
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);
  const controlPlane = new ControlPlane(definitions, repository, events, options.now ?? Date.now);
  return { definitions, repository, events, storage, controlPlane };
}
```

Do not import pi APIs, existing config, catalog, interceptor, telemetry, scorer, or Arena modules.

- [ ] **Step 4: Document P1 sidecar status**

Add a `## Global architecture migration` section to `README.md` containing:

```markdown
## Global architecture migration

The target architecture is documented in `docs/specs/2026-07-26-agent-lab-global-architecture-design.md`.
Phase 1 adds a sidecar Core for versioned definitions, instances, optimization rounds, events, and control-plane validation. It is intentionally not wired into `index.ts`; the existing Classic/Arena runtime remains the production path until later migration phases pass their acceptance gates.
```

- [ ] **Step 5: Run module-load smoke tests**

Run:

```bash
node --experimental-strip-types -e "import('./src/core/create-core.ts').then(() => console.log('core loads'))"
node --experimental-strip-types -e "import('./index.ts').then(() => console.log('extension loads'))"
```

Expected:

```text
core loads
extension loads
```

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --experimental-strip-types --test test/core-*.test.ts
npm test
git diff --check
```

Expected: all tests PASS; `git diff --check` produces no output.

- [ ] **Step 7: Verify no online wiring was introduced**

Run:

```bash
git diff HEAD~1 -- index.ts src/interceptor src/telemetry src/arena src/scorer
```

Expected: no diff for these paths.

- [ ] **Step 8: Commit**

```bash
git add src/core/create-core.ts test/core-control-plane.test.ts README.md
git commit -m "feat(core): assemble sidecar control-plane services"
```

---

## Phase 1 Final Verification

After all six tasks:

- [ ] **Run every test**

```bash
npm test
```

Expected: 63 baseline tests plus all P1 tests PASS, zero failures.

- [ ] **Run Core tests independently**

```bash
node --experimental-strip-types --test test/core-*.test.ts
```

Expected: all P1 contract tests PASS.

- [ ] **Verify extension and Core imports**

```bash
node --experimental-strip-types -e "import('./index.ts').then(() => console.log('extension loads'))"
node --experimental-strip-types -e "import('./src/core/create-core.ts').then(() => console.log('core loads'))"
```

Expected: both load messages, no warnings or errors.

- [ ] **Verify migration isolation**

```bash
git diff c8e5f0c..HEAD -- index.ts src/interceptor src/telemetry src/arena src/scorer src/config.ts src/types.ts
```

Expected: no diff. P1 must not change the production dispatch path or existing config types.

- [ ] **Inspect commit boundaries**

```bash
git log --oneline c8e5f0c..HEAD
```

Expected: one focused commit per task, in this order:

```text
feat(core): add versioned definition contracts and registry
feat(core): add additive instance and round repository
feat(core): add idempotent append-only event log
feat(core): add versioned namespaced storage
feat(core): add draft validation and atomic activation
feat(core): assemble sidecar control-plane services
```

- [ ] **Record residual risks before P2**

The P1 completion report must state:

- Definitions are process-local in P1; persistent plugin manifests/signatures are deferred to the plugin loading phase.
- Schema descriptions are stored, but validation is executed by definition-provided deterministic functions; a common JSON Schema compiler is deferred to compliance tooling.
- SQLite foreign keys are not introduced until database-wide `PRAGMA foreign_keys` policy and migrations are defined.
- P1 does not execute WorkLoops or change online scheduling.
- Event projections, Artifact storage, Runtime integration, Optimizer execution, canary and migration are later phases.

These are explicit stage boundaries, not untracked implementation omissions.
