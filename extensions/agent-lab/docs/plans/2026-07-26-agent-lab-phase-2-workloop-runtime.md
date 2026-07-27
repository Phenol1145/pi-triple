# Agent Lab Phase 2 WorkLoop SDK and Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不接管当前在线调度路径的前提下，实现可执行的 WorkLoop SDK、Agent context/state/checkpoint、single-flight Runner，以及基于 pi-subagents Delegation V2 公共事件协议的 `pi-default-loop@1` Runtime 适配器。

**Architecture:** P2 继续作为旁路能力。Agent Lab 自己管理 WorkContext、Agent state、checkpoint、fresh/fork 和 single-flight；pi-subagents 只负责一次子 Agent 的实际启动和会话执行。两者通过 `pi-subagents/delegation` V2 的 request/started/update/response/cancel 事件形状连接；为保证本仓库单测不依赖 Pi peer packages，Agent Lab 使用与公开协议结构等价的本地 transport types，并在 package metadata 中声明可选的 `pi-subagents >=0.36.0` peer。

**Tech Stack:** TypeScript ESM；Node v24.14.1；`node:sqlite` `DatabaseSync`；`node:test`；pi-ai `Context` 结构兼容模型；pi-subagents Delegation V2 protocol v2；相对导入使用 `.ts`。

## Global Constraints

- 本阶段不得修改 `index.ts` 的在线装配，不得接管现有 interceptor、telemetry、Weighted Scorer 或 Arena 路径。
- P1 的 85 项测试是行为基线；每个任务结束和阶段结束时必须全部通过。
- WorkLoop 是普通命令式异步函数；不得引入状态机、DAG 或 DSL。
- 一个 AgentInstance 同时最多运行一个 WorkLoop；并发请求必须 FIFO 排队，不得并行写同一 Agent state。
- WorkContext 首版与 pi-ai `Context` 结构兼容，但单元测试不得要求安装 Pi peer packages。
- 正常完成时以 compare-and-swap 原子提交 context/state；失败或取消不得覆盖上次已提交状态。
- 中间恢复只能来自显式 checkpoint；未 checkpoint 的局部变量、活动工具调用和锁不得复制。
- `fresh` 使用目标 WorkLoop 的初始 context/state；`fork` 复制指定 checkpoint 的 context 和 WorkLoop 明确转换后的 forkable state。
- 所有 Runtime 外部动作通过可注入端口；WorkLoop 不直接调用 provider、Pi tool 或公共数据库。
- pi-subagents adapter 必须使用 Delegation V2 identity tuple `(requestId, ownerRunId, nodeId)` 关联 update/response/cancel。
- Delegation cancel payload 只能包含 `version/requestId/ownerRunId/nodeId`；不得附加其他字段。
- P2 不宣称支持 V2 没有暴露的 pause/resume、checkpoint、steering、逐工具生命周期或接受度审查。
- P2 不持久化插件代码；WorkLoop implementation registry 仍为进程内不可变注册。
- 每个任务先写失败测试，再写最小实现，并以独立 commit 结束。

---

## File Structure

```text
src/workloop/
├── contracts.ts             # WorkContext、WorkLoop input/result/SDK/port 契约
├── context.ts               # 纯不可变 ContextOperations
├── registry.ts              # metadata Definition + executable WorkLoop 绑定
├── state-store.ts            # Agent context/state CAS 快照
├── checkpoints.ts           # checkpoint、fresh/fork 和血缘快照
└── runner.ts                # single-flight、执行、状态提交和标准事件

src/runtime/
├── delegation-v2.ts         # pi-subagents v2 公共 transport 的结构等价类型/常量
├── pi-subagents-adapter.ts  # event bus request/update/response/cancel Promise 适配
└── create-runtime.ts        # P2 sidecar Runtime composition root

src/workloops/
└── pi-default-loop.ts       # 通过 delegation adapter 执行一次 pi subagent

test/
├── workloop-context.test.ts
├── workloop-registry.test.ts
├── workloop-state.test.ts
├── workloop-runner.test.ts
├── pi-subagents-adapter.test.ts
└── pi-default-loop.test.ts
```

职责边界：

- `workloop/contracts.ts` 只定义 Runtime 契约，不依赖 Pi extension API。
- `context.ts` 只进行内存中的不可变 context 变换，不产生外部副作用。
- `state-store.ts` 和 `checkpoints.ts` 只使用 P1 `NamespacedStore`。
- `registry.ts` 绑定 P1 WorkLoopDefinition metadata 与可执行 implementation；不修改 P1 DefinitionRegistry 的持久化边界。
- `runner.ts` 管理 Agent single-flight、执行信封、状态 CAS 和标准事件。
- `delegation-v2.ts` 必须逐字段匹配 pi-subagents 0.36.0 公共 V2 API，不复制其执行代码。
- `pi-subagents-adapter.ts` 只负责 event transport，不解释 WorkLoop 业务结果。
- `pi-default-loop.ts` 只负责 Delegation V2 与 WorkLoopResult 的映射。
- `create-runtime.ts` 只组装旁路服务，P2 不从 `index.ts` 调用。

---

### Task 1: WorkLoop Contracts and Immutable Context Operations

**Files:**
- Create: `src/workloop/contracts.ts`
- Create: `src/workloop/context.ts`
- Test: `test/workloop-context.test.ts`

**Interfaces:**
- Consumes: P1 `LabEvent` identity conventions only; no runtime imports.
- Produces:
  - `WorkContext`, `WorkLoopInput`, `WorkLoopResult`, `WorkLoopImplementation`
  - `WorkLoopSDK`, `ModelPort`, `ToolPort`, `ArtifactPort`, `WorkLoopTelemetry`, `WorkLoopControl`
  - `ContextOperations` and `createContextOperations()`

- [ ] **Step 1: Write failing context tests**

Create `test/workloop-context.test.ts` with tests for:

```ts
const base: WorkContext = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "one" }],
  tools: [{ name: "read" }],
  metadata: { contextId: "c1", sourceRefs: ["source-1"], artifactRefs: [] },
};
```

Required assertions:

1. `append(base, [{ role: "assistant", content: "two" }], "c2")` returns a new context, preserves `base`, sets `parentContextId: "c1"`, and has two messages.
2. `filterMessages(base, () => false, "c2")` returns zero messages without mutating `base`.
3. `merge(base, other, "c3")` concatenates messages, deduplicates `sourceRefs` and `artifactRefs` in first-seen order, uses `other.systemPrompt` only when base has none, and deduplicates tools by `name`.
4. `truncateMessages(baseWithFourMessages, 2, "c2")` keeps the newest two messages; negative/noninteger limits throw `message limit must be a nonnegative integer`.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/workloop-context.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` for `src/workloop/context.ts`.

- [ ] **Step 3: Add exact Runtime contracts**

`src/workloop/contracts.ts` must define structurally pi-ai-compatible context without a runtime dependency:

```ts
export interface WorkMessage { role: string; content: unknown; [key: string]: unknown }
export interface WorkTool { name: string; [key: string]: unknown }
export interface WorkContext {
  systemPrompt?: string;
  messages: WorkMessage[];
  tools?: WorkTool[];
  metadata: {
    contextId: string;
    parentContextId?: string;
    sourceRefs: string[];
    artifactRefs: string[];
  };
}

export type WorkLoopStatus = "completed" | "failed" | "cancelled" | "paused";

export interface StandardAgentOutput {
  text?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; toolCalls: number; durationMs: number };
}

export interface StandardAgentError { code: string; message: string; retryable: boolean }

export interface WorkLoopInput<TConfig = unknown, TState = unknown> {
  traceId: string;
  executionId: string;
  agentInstanceId: string;
  optimizationRoundId: string;
  task: string;
  context: WorkContext;
  config: Readonly<TConfig>;
  state: TState;
}

export interface WorkLoopResult<TOutput = unknown, TError = unknown, TTrace = unknown, TState = unknown> {
  status: WorkLoopStatus;
  output?: { standard: StandardAgentOutput; custom?: TOutput };
  error?: { standard: StandardAgentError; custom?: TError };
  trace?: { custom?: TTrace };
  context: WorkContext;
  state: TState;
}

export interface ModelPort { complete(context: WorkContext, options?: Record<string, unknown>): Promise<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }> }
export interface ToolPort { execute(name: string, args: unknown): Promise<unknown> }
export interface ArtifactPort { put(value: unknown, mediaType: string): Promise<string>; get(ref: string): Promise<unknown> }
export interface WorkLoopTelemetry { emit(eventType: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>): void }
export interface WorkLoopControl { signal: AbortSignal; throwIfCancelled(): void }
export interface CheckpointPort { save(context: WorkContext, state: unknown, label?: string): Promise<{ checkpointId: string }> }
export interface AgentStoragePort { get<T = unknown>(key: string): { value: T; version: number } | undefined; put<T>(key: string, value: T, expectedVersion: number): { value: T; version: number } }

export interface WorkLoopSDK {
  context: ContextOperations;
  model: ModelPort;
  tools: ToolPort;
  storage: AgentStoragePort;
  artifacts: ArtifactPort;
  checkpoint: CheckpointPort;
  telemetry: WorkLoopTelemetry;
  control: WorkLoopControl;
}

export interface WorkLoopImplementation {
  id: string;
  version: string;
  cloneModes: string[];
  initialContext(config: unknown): WorkContext;
  initialState(config: unknown): unknown;
  forkState?(state: unknown): unknown;
  run(input: WorkLoopInput, sdk: WorkLoopSDK): Promise<WorkLoopResult>;
}
```

`ContextOperations` exposes `append`, `filterMessages`, `merge`, and `truncateMessages` with the signatures used by tests.

- [ ] **Step 4: Implement pure immutable operations**

Use shallow copies of message/tool objects and new arrays/metadata objects. Do not use JSON serialization because WorkTool may later contain non-JSON schema values. `merge` deduplicates tools by `tool.name`; unnamed duplicates are retained.

- [ ] **Step 5: Run GREEN and full suite**

```bash
node --experimental-strip-types --test test/workloop-context.test.ts
npm test
```

Expected: 4 new tests and all 85 baseline tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/workloop/contracts.ts src/workloop/context.ts test/workloop-context.test.ts
git commit -m "feat(workloop): add runtime contracts and context operations"
```

---

### Task 2: Executable WorkLoop Registry

**Files:**
- Create: `src/workloop/registry.ts`
- Test: `test/workloop-registry.test.ts`

**Interfaces:**
- Consumes: P1 `DefinitionRegistry`, `DefinitionRef`, and Task 1 `WorkLoopImplementation`.
- Produces:
  - `WorkLoopRegistry.register(implementation): void`
  - `WorkLoopRegistry.require(id, version): WorkLoopImplementation`
  - `WorkLoopImplementationConflictError`, `WorkLoopImplementationNotFoundError`

- [ ] **Step 1: Write failing tests**

Required tests:

1. Registration succeeds only when matching `kind:"workloop"/id/version` metadata exists in P1 DefinitionRegistry.
2. Registering the same implementation twice throws typed conflict.
3. Registration with mismatched `cloneModes` against metadata throws `workloop implementation does not match definition clone modes`.
4. `require` returns the frozen implementation and missing refs throw typed not-found.

Use a no-op implementation returning `completed` with unchanged context/state.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/workloop-registry.test.ts
```

- [ ] **Step 3: Implement the registry**

`WorkLoopRegistry` constructor takes P1 `DefinitionRegistry`. `register` calls `definitions.require({kind:"workloop", id, version})`, verifies exact sorted `cloneModes`, freezes a shallow implementation snapshot, and keys by `id\u0000version`. It must not alter P1 `DefinitionRegistry` or add executable functions to persisted metadata.

- [ ] **Step 4: Run focused and full tests**

```bash
node --experimental-strip-types --test test/workloop-registry.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/workloop/registry.ts test/workloop-registry.test.ts
git commit -m "feat(workloop): bind definitions to executable implementations"
```

---

### Task 3: Agent Runtime State, Checkpoints, Fresh and Fork

**Files:**
- Create: `src/workloop/state-store.ts`
- Create: `src/workloop/checkpoints.ts`
- Test: `test/workloop-state.test.ts`

**Interfaces:**
- Consumes: P1 `NamespacedStore`; Task 1 `WorkContext`, `WorkLoopImplementation`.
- Produces:
  - `AgentRuntimeStateStore.initialize/get/commit`
  - `CheckpointStore.save/get`
  - `AgentCloneService.fresh/fork`

- [ ] **Step 1: Write failing state/checkpoint tests**

Required tests:

1. `initialize(agentId, context, state)` creates version 1; a second initialize conflicts.
2. `commit(agentId, context, state, expectedVersion)` increments version; stale expectedVersion throws P1 `VersionConflictError` and preserves old snapshot.
3. `CheckpointStore.save` persists an immutable snapshot with execution/workloop/round/parent metadata; mutating caller objects afterward does not alter `get`.
4. `fresh` initializes target from `implementation.initialContext/config` and `initialState/config`, without source state.
5. `fork` requires implementation clone mode `fork`, loads a specified checkpoint, calls `implementation.forkState` when provided, initializes a new target agent, and preserves source/checkpoint.
6. `fork` rejects absent checkpoint or unsupported mode with typed errors.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/workloop-state.test.ts
```

- [ ] **Step 3: Implement combined runtime snapshots**

Store one CAS value under namespace `agent:<agentId>`, key `runtime`:

```ts
export interface AgentRuntimeSnapshot {
  context: WorkContext;
  state: unknown;
  lastCheckpointId?: string;
}
```

Keeping context/state in one KV value makes normal completion atomic.

Checkpoint namespace/key:

```text
namespace = agent:<agentId>
key = checkpoint:<checkpointId>
```

Checkpoint records include `checkpointId`, `agentInstanceId`, `executionId`, `workLoopId/version`, `optimizationRoundId`, optional parent and label, context, state, and createdAt. Use `structuredClone` before storing/returning and surface clear `checkpoint not found: <id>` errors.

- [ ] **Step 4: Implement clone service**

`fresh` and `fork` create only target runtime snapshots. They do not create P1 AgentInstance records; Scheduler ownership and lineage remain Scheduler responsibilities in P3. Fork never copies active locks or execution state.

- [ ] **Step 5: Run focused and full tests**

```bash
node --experimental-strip-types --test test/workloop-state.test.ts
npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/workloop/state-store.ts src/workloop/checkpoints.ts test/workloop-state.test.ts
git commit -m "feat(workloop): add agent state checkpoints and clone modes"
```

---

### Task 4: Delegation V2 Event Adapter

**Files:**
- Modify: `package.json` (optional `pi-subagents >=0.36.0` peer only)
- Create: `src/runtime/delegation-v2.ts`
- Create: `src/runtime/pi-subagents-adapter.ts`
- Test: `test/pi-subagents-adapter.test.ts`

**Interfaces:**
- Consumes: an injected event bus with `on/emit`.
- Produces:
  - exact V2 structural types and event constants
  - `PiSubagentsAdapter.delegate(request, {signal?, onUpdate?, transportTimeoutMs?})`
  - `PiSubagentsAdapter.cancel(identity)` and `dispose()`

- [ ] **Step 1: Write failing adapter tests with a fake event bus**

Required tests:

1. `delegate` subscribes before emitting request, emits exact V2 request, ignores foreign tuple updates/responses, forwards matching update, and resolves matching terminal response.
2. AbortSignal emits exact cancel payload containing only `version/requestId/ownerRunId/nodeId`; terminal cancelled response resolves once.
3. Duplicate in-flight attempt tuple rejects with `delegation already in flight` without emitting a second request.
4. Local transport timeout emits cancel and rejects with `delegation transport timed out`; late terminal response is ignored.
5. `dispose` unsubscribes listeners, emits cancel for each inflight request, and rejects pending promises with `delegation adapter disposed`.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/pi-subagents-adapter.test.ts
```

- [ ] **Step 3: Define exact V2 protocol subset**

`src/runtime/delegation-v2.ts` must match pi-subagents 0.36.0 public `pi-subagents/delegation` V2 fields:

```ts
export const SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION = 2 as const;
export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";
```

Include exact request, started, update, cancel, result, usage, terminal/invalid response and status unions. Add a header comment naming `pi-subagents/delegation` v2 and minimum version 0.36.0 as the canonical source.

Update `package.json`:

```json
"pi-subagents": ">=0.36.0"
```

under `peerDependencies`, with optional peer metadata. Do not add a runtime import in P2 tests.

- [ ] **Step 4: Implement event adapter**

Track inflight requests by canonical JSON tuple `[requestId, ownerRunId, nodeId]`. Register one handler per started/update/response event in constructor. Subscribe before any request can emit. Terminal statuses resolve as protocol results; only local adapter failures reject.

Default local transport timeout is `max(request.timeoutMs ?? 30_000, 1_000) + 5_000`. Timers use injected `setTimeout/clearTimeout` seams or short explicit test timeout. Cleanup listeners/timers/signal handlers on every terminal path.

- [ ] **Step 5: Run focused and full tests**

```bash
node --experimental-strip-types --test test/pi-subagents-adapter.test.ts
npm test
```

- [ ] **Step 6: Commit**

```bash
git add package.json src/runtime/delegation-v2.ts src/runtime/pi-subagents-adapter.ts test/pi-subagents-adapter.test.ts
git commit -m "feat(runtime): adapt pi-subagents delegation v2 transport"
```

---

### Task 5: Single-Flight WorkLoop Runner

**Files:**
- Create: `src/workloop/runner.ts`
- Test: `test/workloop-runner.test.ts`

**Interfaces:**
- Consumes: WorkLoopRegistry, AgentRuntimeStateStore, CheckpointStore, P1 EventLog/NamespacedStore, injected SDK ports.
- Produces:
  - `WorkLoopRunner.run(request): Promise<WorkLoopResult>`
  - FIFO single-flight per Agent
  - standard workloop/agent/checkpoint events

- [ ] **Step 1: Write failing Runner tests**

Required tests:

1. Completed run loads current snapshot, invokes exact implementation, commits returned context/state by expected version, and appends `agent.started`, `workloop.started`, `workloop.completed`, `agent.completed` events with trace/execution/agent/workloop/round IDs.
2. Failed WorkLoop returns failure and emits failure events but does not commit returned context/state.
3. Abort before start returns cancelled without invoking implementation; abort during run is visible through `sdk.control.signal` and does not commit.
4. Two concurrent runs for the same Agent execute FIFO with maximum active count 1; different Agent IDs may execute concurrently.
5. `sdk.checkpoint.save` writes checkpoint using current execution/workloop/round metadata and emits `checkpoint.created`.
6. CAS conflict on final commit returns standardized `state-conflict` error and preserves winning state.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/workloop-runner.test.ts
```

- [ ] **Step 3: Implement runner and SDK binding**

`run` request includes `traceId`, `executionId`, `agentInstanceId`, `optimizationRoundId`, WorkLoop ref, config, task, optional AbortSignal. Use a per-agent Promise tail map and remove settled tails. Never hold a global lock across agents.

Bind SDK ports:

- context operations from Task 1;
- model/tools/artifacts supplied to Runner constructor;
- storage namespaced to `agent:<id>:workloop`;
- checkpoint bound to current metadata;
- telemetry writes P1 LabEvents with deterministic event IDs `${executionId}:${eventType}:${sequence}`;
- control wraps AbortSignal.

Catch thrown errors and return `workloop-error`; map P1 VersionConflictError to `state-conflict`. Commit only when `status === "completed"`.

- [ ] **Step 4: Run focused/Core/full tests**

```bash
node --experimental-strip-types --test test/workloop-runner.test.ts
node --experimental-strip-types --test test/core-*.test.ts test/workloop-*.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/workloop/runner.ts test/workloop-runner.test.ts
git commit -m "feat(workloop): add single-flight runner and lifecycle events"
```

---

### Task 6: pi-default-loop and Sidecar Runtime Composition

**Files:**
- Create: `src/workloops/pi-default-loop.ts`
- Create: `src/runtime/create-runtime.ts`
- Test: `test/pi-default-loop.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: PiSubagentsAdapter, WorkLoopRegistry/Runner, P1 LabCore.
- Produces:
  - `createPiDefaultLoop(adapter): WorkLoopImplementation`
  - `createWorkLoopRuntime(db, eventBus, options?): WorkLoopRuntime`
  - sidecar integration test over fake delegation transport

- [ ] **Step 1: Write failing pi-default-loop tests**

Required tests:

1. Completed Delegation V2 response maps text result and exact usage to StandardAgentOutput, appends one assistant message to WorkContext, and preserves state.
2. Structured result maps into custom output without stringifying.
3. `failed`, `timed_out`, `turn_budget_exhausted`, `tool_budget_exhausted`, `structured_output_failed`, `invalid_request`, `unavailable_context`, and `duplicate_node` map to failed WorkLoopResult with stable error codes and retryability (`timed_out/unavailable_context/duplicate_node` retryable; invalid/structured failures not retryable).
4. `cancelled` and `interrupted` map to cancelled WorkLoopResult.
5. Matching delegation updates emit `runtime.pi_subagents.update` telemetry metrics.
6. Runtime composition registers metadata `pi-default-loop@1.0.0`, executable implementation, and can execute one initialized Agent against a fake event bus response without touching `index.ts`.

- [ ] **Step 2: Run RED**

```bash
node --experimental-strip-types --test test/pi-default-loop.test.ts
```

- [ ] **Step 3: Implement pi-default-loop**

Config shape:

```ts
interface PiDefaultLoopConfig {
  agent: string;
  cwd: string;
  contextMode: "fresh" | "fork";
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  result?: { kind: "text" } | { kind: "structured"; schema: Record<string, unknown> };
}
```

Build V2 identity from WorkLoop input: `requestId=input.executionId`, `ownerRunId=input.traceId`, `nodeId=input.agentInstanceId`. Do not pass WorkContext to pi-subagents; `contextMode` is the pi session fresh/fork choice. On text completion append an assistant message. On structured completion retain context unchanged unless output also includes text.

- [ ] **Step 4: Implement sidecar composition**

`createWorkLoopRuntime(db, eventBus, options)` requires injected `model`, `tools`, and `artifacts` ports for SDK completeness even though `pi-default-loop@1` does not call them. It composes `createLabCore(db)`, WorkLoopRegistry, state/checkpoint stores, PiSubagentsAdapter, Runner, and registers P1 WorkLoopDefinition metadata plus executable implementation for `pi-default-loop@1.0.0`. It returns `dispose()` which disposes the adapter. It must not import ExtensionAPI and must not be called from `index.ts` in P2.

- [ ] **Step 5: Update README**

Extend `Global architecture migration` to state that Phase 2 adds a sidecar WorkLoop SDK and pi-subagents Delegation V2 adapter, still not wired to production routing. Explicitly list unsupported protocol features: pause/resume, steering, per-tool events.

- [ ] **Step 6: Run all verification**

```bash
node --experimental-strip-types --test test/pi-default-loop.test.ts
node --experimental-strip-types --test test/core-*.test.ts test/workloop-*.test.ts test/pi-*.test.ts
npm test
node --experimental-strip-types -e "import('./src/runtime/create-runtime.ts').then(() => console.log('runtime loads'))"
git diff --check
```

Expected: all tests pass; runtime loads; no formatting errors.

- [ ] **Step 7: Verify isolation**

```bash
BASE=$(git merge-base main HEAD)
git diff "$BASE"..HEAD -- index.ts src/interceptor src/telemetry src/arena src/scorer src/config.ts src/types.ts
```

Expected: no diff.

- [ ] **Step 8: Commit**

```bash
git add src/workloops/pi-default-loop.ts src/runtime/create-runtime.ts test/pi-default-loop.test.ts README.md
git commit -m "feat(runtime): compose pi-default WorkLoop sidecar"
```

---

## Phase 2 Final Verification

- [ ] `npm test` passes with all 85 P1/baseline tests and all P2 tests.
- [ ] Core + WorkLoop + Runtime focused suites pass independently.
- [ ] `create-runtime.ts` import smoke passes without Pi peer packages installed.
- [ ] Full diff from P2 base has no changes in production online paths.
- [ ] Commit history has one focused commit per Task 1-6.
- [ ] Whole-branch review reports zero open Critical/Important findings.
- [ ] Completion report states these deliberate boundaries:
  - Runtime remains sidecar and is not wired into `index.ts`.
  - Delegation V2 provides start/update/terminal/cancel, but not pause/resume/checkpoint/steering/per-tool events.
  - Agent Lab checkpoint/fresh/fork state is separate from pi-subagents session context fresh/fork.
  - Definitions and executable WorkLoop registry remain process-local.
  - Full Artifact persistence, model/tool native SDK implementations, Scheduler integration, Agent lineage persistence, and production routing are later phases.
