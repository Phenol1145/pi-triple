# Agent Lab Phase 3: Weighted Scorer Scheduler Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encapsulate the current Classic model-selection logic as the first `SchedulerDefinition` (`weighted-scorer@1.0.0`), executable through the P1 Core + P2 Runtime, with an explicit opt-in production switch whose fixed-input selection/pin behavior is identical to the legacy path.

**Architecture:** P1 Core (definitions, repository, event log, namespaced storage, control plane) stays unchanged except one additive read method. P2 Runtime (workloop registry/runner, pi-subagents adapter) is reused as the execution engine behind the new Scheduler SDK. New code lives in `src/scheduler/` (contracts, registry, runner) and `src/schedulers/` (weighted-scorer definition + implementation + bootstrap). Production wiring is a strictly opt-in, fail-open branch in the existing interceptor.

**Tech Stack:** Node 24 built-in test runner (`node --experimental-strip-types --test`), `node:sqlite`, TypeScript type stripping, no new runtime dependencies.

---

## Scope decisions (locked)

1. **Select mode vs execute mode.** pi's `tool_call` event can only mutate `event.input` or block; it cannot substitute a tool result. Therefore the P3 production switch is a **selection-path switch**: the scheduler performs routing, round pinning, candidate assembly, scoring and pin handling, records standard events, and returns the selected model; the interceptor then mutates `input.model` exactly as the legacy path does, and pi-subagents executes natively. The full dispatch+execute path (`SchedulerSDK.agents.run` → `WorkLoopRunner` → Delegation V2) is delivered and tested as the programmable sidecar path, but production wiring uses select mode only. Execute mode becomes the production path in a later phase (P6/P7).
2. **Parity data sources.** Scoring aggregates (`Aggregate` per role/model), pins, and the model candidate catalog are read from the **legacy** store/catalog via injected ports, so fixed-input parity with the legacy pipeline is exact and no data migration is needed in P3. New-path executions additionally write standard events to the P1 EventLog. Dual-source migration is P5 scope.
3. **Scheduler SDK minimal surface.** `agents.list`, `agents.create`, `agents.run`, `storage` (scheduler-instance namespace), `telemetry.emit`, `control.signal`. `agents.clone/deactivate/runParallel` are deliberately NOT defined yet (Arena/P4 will add them with their semantics).
4. **Additive-only persistence.** No schema changes. One additive repository read method (`listRoutingBindings()`). Legacy tables untouched.
5. **Fail-open everywhere in the wiring.** Any error in the new path falls back to legacy classic behavior silently (plus a console.error, matching the existing interceptor style). Default config keeps the new path disabled.
6. **Existing 181 tests are the behavior baseline and must stay green.** Protected paths (telemetry, arena, scorer, catalog, store, commands) may only receive additive, opt-in changes specified in Tasks 5–6.

## Contracts referenced (already in tree)

- `src/core/contracts.ts`: `SchedulerDefinition`, `SchedulerInstanceRecord`, `OptimizationRoundRecord`, `AgentInstanceRecord`, `AgentDefinition`, `AgentCreateSpec`, `SchedulerInstanceDraftSpec`, `FallbackTarget`, `ValidationResult`, `LabEvent`.
- `src/workloop/contracts.ts`: `WorkLoopImplementation`, `WorkLoopInput`, `WorkLoopResult`, `StandardAgentOutput`, `StandardAgentError`.
- `src/workloop/runner.ts`: `WorkLoopRunner.run(request: WorkLoopRunRequest): Promise<WorkLoopResult>`; request = `{ traceId, executionId, agentInstanceId, optimizationRoundId, workLoopId, workLoopVersion, config, task, signal? }`.
- `src/runtime/create-runtime.ts`: `createWorkLoopRuntime(db, eventBus, options)` → `{ core, registry, runner, adapter, stateStore, checkpointStore, cloneService, dispose }`.
- `src/core/create-core.ts`: `createLabCore(db)` → `{ definitions, repository, events, storage, controlPlane }`.
- `src/scorer/scorer.ts`: `scoreCandidates(candidates, aggsByModel, cfg)`, `recommend(...)`, `minmax`, `staticProxy`, `representativeBenchmark` (pure; imported, not moved).
- `src/types.ts`: `LabConfig`, `ModelInfo`, `Aggregate`, `ScoredModel`.
- Design doc: `docs/specs/2026-07-26-agent-lab-global-architecture-design.md` §4 (Scheduler/SDK), §9.2/9.3 (execution + fallback chain), §11.3 (standard event families), §12.4 (routing).

## Standard events emitted in P3 (per design §11.3)

`scheduling.requested`, `routing.resolved`, `routing.failed`, `scheduler.started`, `scheduler.completed`, `scheduler.failed`, `scheduler.abstained`, `scheduler.agent.selected`, `scheduler.agent.created`, `fallback.started`, `fallback.completed`. Event identity carries `traceId`, `dispatchId`, `schedulerInstanceId`, `schedulerDefinitionId/Version`, `optimizationRoundId`, `agentInstanceId` as applicable. Custom metrics use the `scheduler.weighted_scorer.*` namespace (e.g. `scheduler.weighted_scorer.score`, candidate counts, pin hit).

---

### Task 1: Scheduler executable contracts + SchedulerRegistry

Mirror the WorkLoopRegistry pattern (`src/workloop/registry.ts`) for schedulers.

**Files:**
- Create: `src/scheduler/contracts.ts`
- Create: `src/scheduler/registry.ts`
- Test: `test/scheduler-registry.test.ts`

- [ ] **Step 1: Write failing tests** for the contracts/registry:

```ts
// test/scheduler-registry.test.ts — behaviors:
// 1. register(impl) succeeds when a matching scheduler definition (kind "scheduler",
//    same id+version) exists in the P1 DefinitionRegistry.
// 2. register throws typed SchedulerImplementationNotFoundError at require() for missing id/version.
// 3. register throws typed not-found when definition missing or kind mismatched.
// 4. Registering the same implementation id+version twice throws typed conflict.
// 5. require returns a frozen implementation (Object.isFrozen).
// 6. register does not alter the P1 DefinitionRegistry beyond the pre-registered definition.
```

- [ ] **Step 2: Implement `src/scheduler/contracts.ts`:**

```ts
export type SchedulingMode = "select" | "execute";

export interface SchedulingInput {
  traceId: string;
  dispatchId: string;
  role: string;
  task: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
  mode: SchedulingMode;              // "select": choose only; "execute": choose + run via sdk.agents.run
  signal?: AbortSignal;
}

export interface AgentSnapshot {       // sdk.agents.list element
  id: string;
  definition: AgentDefinition;         // from src/core/contracts.ts
  status: AgentInstanceStatus;
}

export interface AgentRunRequest {
  task: string;
  configOverrides?: Record<string, unknown>;  // merged over definition.workLoop.config
  timeoutMs?: number;
}

export interface AgentRunResult {      // normalized from WorkLoopResult
  status: WorkLoopStatus;
  output?: StandardAgentOutput;
  error?: StandardAgentError;
}

export interface SchedulerSDK {
  agents: {
    list(): Promise<AgentSnapshot[]>;                                  // scoped to owning instance
    create(spec: AgentCreateSpec): Promise<{ id: string }>;            // owning instance fixed
    run(agentId: string, request: AgentRunRequest): Promise<AgentRunResult>;
  };
  storage: {                                                           // namespace scheduler:<instanceId>
    get<T = unknown>(key: string): { value: T; version: number } | undefined;
    put<T>(key: string, value: T, expectedVersion: number): { value: T; version: number };
  };
  telemetry: { emit(eventType: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>): void };
  control: { signal: AbortSignal };
}

export type SchedulingResult =
  | { status: "completed"; selectedAgentId?: string; model?: string; output?: StandardAgentOutput; reason?: string }
  | { status: "abstained"; reason: string }
  | { status: "failed"; error: StandardAgentError };

export interface SchedulerImplementation {
  id: string;
  version: string;
  schedule(input: SchedulingInput, parameters: Readonly<unknown>, sdk: SchedulerSDK): Promise<SchedulingResult>;
}
```

- [ ] **Step 3: Implement `src/scheduler/registry.ts`** mirroring `WorkLoopRegistry`: constructor takes the P1 `DefinitionRegistry`; `register(impl)` requires a stored definition with `kind === "scheduler"`, exact `id`/`version` match, freezes the impl, throws typed `SchedulerImplementationConflictError` / `SchedulerImplementationNotFoundError`; `require(id, version)` returns the frozen impl or throws typed not-found.

- [ ] **Step 4: Run tests** — new suite green; `npm test` still 181 + new.

- [ ] **Step 5: Commit** `feat(scheduler): add executable scheduler contracts and registry`

---

### Task 2: SchedulerRunner — routing, round pinning, events, fallback chain, SDK

**Files:**
- Create: `src/scheduler/runner.ts`
- Modify: `src/core/storage/repository.ts` (add ONE additive method `listRoutingBindings(): Array<{ id: string; schedulerInstanceId: string; priority: number; match: RoutingMatch }>` reading `lab_routing_bindings`)
- Test: `test/scheduler-runner.test.ts`
- Test: extend `test/core-storage.test.ts` (one additive test for `listRoutingBindings`)

- [ ] **Step 1: Write failing tests** covering:

```ts
// A. Explicit schedulerInstanceId wins over routing; routing.failed + SchedulingError when unknown.
// B. Static routing: exact role match beats catch-all (empty match); higher priority wins on ties;
//    routing.resolved event carries bindingId + instanceId snapshot.
// C. Round pinning: schedule() receives parameters from instance.currentRoundId; event identity
//    carries optimizationRoundId; missing round -> scheduler.failed.
// D. Events: scheduling.requested -> routing.resolved -> scheduler.started ->
//    scheduler.agent.selected (from result) -> scheduler.completed, in order, with identity fields.
// E. SDK agents.list returns only the owning instance's agents; agents.create inserts via
//    repository.insertAgent with createdAtRoundId = current round and emits scheduler.agent.created.
// F. SDK agents.run (execute mode) delegates to WorkLoopRunner.run with merged config
//    (definition.workLoop.config + overrides) and normalizes WorkLoopResult -> AgentRunResult;
//    agents.run for a foreign/unknown agentId rejects.
// G. Fallback chain: scheduler result "failed" -> next target; { type: "original-request" } ->
//    dispatch returns { status: "fallback", target: { type: "original-request" }, attempts };
//    { type: "fail", errorCode } -> returns failed with that code; scheduler-instance target
//    re-enters dispatch on that instance; cycle detection and maxDepth 3 both abort with
//    routing/fallback failure events; earlier failures remain in the event log (no erasure).
// H. Abstain: SchedulingResult "abstained" -> scheduler.abstained event, dispatch returns
//    abstained WITHOUT triggering fallback.
// I. sdk.storage is namespaced per scheduler instance (two instances, same key, isolated).
// J. dispatch() input signal aborted before start -> cancelled-style failure, no scheduler.started.
```

`SchedulerRunner` constructor surface (tests pin it):

```ts
new SchedulerRunner({
  core: LabCore,
  schedulers: SchedulerRegistry,
  runner?: WorkLoopRunner,      // required only when a dispatch reaches agents.run (execute mode)
  maxFallbackDepth?: number,    // default 3
  now?: () => number,
});

dispatch(request: {
  traceId: string;
  dispatchId?: string;          // generated deterministically when omitted
  schedulerInstanceId?: string; // explicit wins
  role: string;
  task: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
  mode: SchedulingMode;         // default "execute" when omitted
  signal?: AbortSignal;
}): Promise<DispatchResult>;

type DispatchResult =
  | { status: "completed"; schedulerInstanceId: string; roundId: string; selectedAgentId?: string; model?: string; output?: StandardAgentOutput; reason?: string; attempts: DispatchAttempt[] }
  | { status: "abstained"; schedulerInstanceId: string; roundId: string; reason: string; attempts: DispatchAttempt[] }
  | { status: "fallback"; target: FallbackTarget; attempts: DispatchAttempt[] }
  | { status: "failed"; error: StandardAgentError; attempts: DispatchAttempt[] };

interface DispatchAttempt { schedulerInstanceId: string; roundId?: string; status: "completed" | "abstained" | "failed"; error?: StandardAgentError }
```

Event ids: deterministic per dispatch (`${traceId}:${dispatchId}:${eventType}:${seq}`), matching the workloop runner convention.

- [ ] **Step 2: Add `listRoutingBindings()`** to `CoreRepository` (pure read, no schema change).

- [ ] **Step 3: Implement `src/scheduler/runner.ts`** per the behaviors above. Validation-light (routing resolution trusts control-plane validated data). `agents.create` must emit `scheduler.agent.created` and use the current round id. Scheduler parameters passed to `schedule()` are the round's frozen `parameters` (structuredClone, never mutated).

- [ ] **Step 4: Run tests** — new + storage suites green; full `npm test` green.

- [ ] **Step 5: Commit** `feat(scheduler): add dispatch runner with routing, rounds, and fallback chain`

---

### Task 3: `weighted-scorer@1.0.0` definition + implementation

**Files:**
- Create: `src/schedulers/weighted-scorer.ts`
- Test: `test/weighted-scorer.test.ts`

Parameter model (`parameterModelVersion: "1.0.0"`):

```ts
interface WeightedScorerParameters {
  weights: { completion: number; costEffectiveness: number; performance: number; benchmark: number };
  topN: number;                 // >= 1
  pinBehavior: "respect" | "ignore";   // default "respect"
  syncOnDispatch: boolean;      // default false; when true, create agents for catalog models missing from the population
}
// defaults mirror src/config.ts LabConfig defaults exactly (weights identical, topN identical)
// tunablePaths: ["weights.completion","weights.costEffectiveness","weights.performance","weights.benchmark","topN","pinBehavior","syncOnDispatch"]
```

Implementation ports (constructor-injected; tests use fakes):

```ts
interface WeightedScorerPorts {
  candidates(): ModelInfo[];                                   // legacy catalog
  aggregates(role: string): Map<string, Aggregate>;            // legacy telemetry store
  pinLookup(role: string): string | undefined;                 // legacy pin store
}
createWeightedScorer(ports): { definition: SchedulerDefinition; implementation: SchedulerImplementation }
```

- [ ] **Step 1: Write failing tests:**

```ts
// 1. Definition: validateParameters accepts defaults; rejects non-numeric/negative weights,
//    all-zero weights, topN < 1, non-integer topN, unknown pinBehavior, unknown top-level keys kept
//    permissive? NO — reject unknown keys (schema additionalProperties false semantics via manual checks).
// 2. validateTransition rejects changing weights to all-zero (non-trivial rule), accepts weight tuning.
// 3. Cold start: no aggregates -> staticProxy completion path identical to legacy scoreCandidates output
//    (same scores, same order) for a fixed ModelInfo fixture set.
// 4. Warm: aggregates present -> identical scores/order as legacy recommend() for the same fixtures.
// 5. Pin respect: pinLookup returns a model present in candidates -> that model selected regardless of
//    score; reason mentions pin; metrics include pin hit.
// 6. Pin to model absent from population (select mode): completed with model=<pinned>, no selectedAgentId.
// 7. Empty candidate list -> abstained with reason (NOT failed; no fallback triggered).
// 8. syncOnDispatch=true: catalog model missing from sdk.agents.list() -> sdk.agents.create called with
//    an AgentDefinition embedding the ModelInfo snapshot in custom, workLoop pi-default-loop@1.0.0
//    config template { cwd, contextMode: "fresh", model: <id> }; syncOnDispatch=false -> no creates.
// 9. Execute mode: sdk.agents.run called for the selected agent with merged config
//    ({ ...template, agent: input.role }) and input.task; AgentRunResult normalized into output;
//    run failure -> SchedulingResult failed with retryable propagated.
// 10. Select mode: sdk.agents.run NEVER called.
// 11. Telemetry: implementation emits scheduler.weighted_scorer.score metrics (top score, candidateCount).
// 12. Score equality guard: for the fixture matrix (cold/warm/pinned/free-only/single-candidate/
//    all-equal-scores), new selection == legacy (recommend + decideIntercept pin logic) selection.
//    Implement the legacy side by calling the REAL src/scorer/scorer.ts functions, not a copy.
```

- [ ] **Step 2: Implement `src/schedulers/weighted-scorer.ts`.** Scoring MUST import and reuse `scoreCandidates`/`minmax`/`staticProxy`/`representativeBenchmark` from `src/scorer/scorer.ts` (no logic copies). Candidate → AgentDefinition mapping: `standard = { name: model.id, capabilities: [], executionKind: "model-candidate", labels: { provider: providerPrefix(model.id) } }`; `workLoop = { id: "pi-default-loop", version: "1.0.0", config: { cwd: process.cwd(), contextMode: "fresh", model: model.id } }`; `custom = { model }` (ModelInfo snapshot). Selection: score all population-backed candidates, pick max score; ties keep scorer.ts order (stable). Pin "ignore" → pure score order.

- [ ] **Step 3: Run tests** — suite green; full `npm test` green.

- [ ] **Step 4: Commit** `feat(schedulers): add weighted-scorer scheduler definition and implementation`

---

### Task 4: Bootstrap — default instance seeding, agent sync, composition

**Files:**
- Create: `src/schedulers/bootstrap.ts`
- Create: `src/runtime/create-scheduler-runtime.ts`
- Test: `test/weighted-scorer-bootstrap.test.ts`

- [ ] **Step 1: Write failing tests:**

```ts
// bootstrap:
// 1. ensureWeightedScorerInstance(core, schedulers, ports, { instanceId? }) registers the definition,
//    creates draft (agents seeded from ports.candidates(), fallbackChain [{ type: "original-request" }],
//    one catch-all routing binding { id: "default", priority: 0, match: {} }), validates, activates;
//    returns { instanceId, roundId, agentCount }.
// 2. Idempotent: second call returns the same instance WITHOUT creating a new draft/round/agents.
// 3. syncWeightedScorerAgents(core, instanceId, candidates) creates agents only for models not already
//    in the population (no duplicates on re-run; never deactivates).
// 4. Activated instance passes control-plane validation end-to-end (definition, workloop ref
//    pi-default-loop@1.0.0 must be registered first — bootstrap accepts an optional registrar hook or
//    requires caller to pre-register; pin the chosen contract in tests).
// composition:
// 5. createSchedulerRuntime(db, { ports, eventBus? }) -> { core, schedulers, schedulerRunner,
//    workloopRuntime? , dispose }; without eventBus, schedulerRunner has no WorkLoopRunner and
//    execute-mode agents.run rejects with a typed unavailable error (select mode fully works).
// 6. With a fake eventBus + ports (model/tools/artifacts fakes), execute-mode dispatch of a seeded
//    instance completes end-to-end through WorkLoopRunner and the pi-subagents adapter fake bus.
// 7. Dispose disposes the workloop runtime when present.
```

- [ ] **Step 2: Implement `src/schedulers/bootstrap.ts`** and `src/runtime/create-scheduler-runtime.ts`. Default instance id: `default-weighted-scorer`. Round 0 parameters = definition defaults. All bootstrap emits standard control-plane events via existing services.

- [ ] **Step 3: Run tests** — green; full `npm test` green.

- [ ] **Step 4: Commit** `feat(schedulers): add weighted-scorer bootstrap and scheduler runtime composition`

---

### Task 5: Opt-in production wiring (select mode) + dual-run comparison

**Files:**
- Modify: `src/types.ts` (additive `LabConfig.scheduler?: { enabled?: boolean; instanceId?: string; dualRun?: boolean }`)
- Modify: `src/config.ts` (defaults: scheduler absent/disabled; merge keeps it)
- Modify: `src/config-io.ts` (additive key passthrough/merge for `scheduler`)
- Modify: `src/interceptor/register.ts` (opt-in branch, fail-open)
- Create: `src/interceptor/scheduler-bridge.ts` (pure decision logic, testable without pi)
- Test: `test/scheduler-bridge.test.ts`
- Test: extend `test/config.test.ts` / `test/config-io` coverage (additive keys)

`scheduler-bridge.ts` pure core (all side effects injected):

```ts
export interface SchedulerBridgeDeps {
  runtime(): SchedulerRuntimeLike | undefined;   // lazy singleton getter; undefined when unavailable
  modelAllowed(model: string): boolean;
  legacyRecommend(role: string): ScoredModel[];  // existing recommend pipeline, for dualRun
}
// decideSchedulerSelection({ role, task, toolCallId, cfg }, deps) ->
//   { action: "apply"; model: string; source: "scheduler"; dualMatch?: boolean }
// | { action: "skip"; reason: string }   // caller falls through to legacy classic
```

- [ ] **Step 1: Write failing tests:**

```ts
// 1. cfg.scheduler.enabled falsy -> skip (never touches runtime).
// 2. Enabled + runtime dispatch completed + modelAllowed -> apply selected model.
// 3. Enabled + dispatch abstained/failed/fallback(original-request) -> skip with reason.
// 4. Enabled + selected model fails modelAllowed -> skip.
// 5. Enabled + runtime() throws / dispatch rejects -> skip (fail-open), error captured.
// 6. dualRun=true: legacyRecommend compared; mismatch -> dualMatch false in result (event emitted by caller).
// 7. instanceId override forwarded to dispatch request.
// 8. traceId = toolCallId when provided (stable correlation with tool_result telemetry).
// 9. Config: mergeConfig keeps scheduler block; applyArenaConfig-style applyConfig accepts
//    scheduler.enabled=true|false, scheduler.dualRun, scheduler.instanceId=<string>; unknown keys rejected.
```

- [ ] **Step 2: Implement bridge + config changes**, then wire into `registerInterceptor` classic branch:

```ts
// before legacy classic recommend:
if (cfg.scheduler?.enabled) {
  try {
    const decision = await decideSchedulerSelection(...);
    if (decision.action === "apply") { input.model = decision.model; setStatus(...); return; }
    // dualRun mismatch -> console.error/log line only (no UI spam)
  } catch (err) { console.error("[agent-lab] scheduler bridge failed (fail-open):", err); }
}
// ... legacy classic path unchanged
```

The lazy runtime singleton is constructed from the same `db` the extension already opens, with `ensureWeightedScorerInstance` called once; construction failures are caught and the bridge stays unavailable (fail-open). No `index.ts` changes beyond passing already-available deps into `registerInterceptor` (extend its signature additively, keeping the existing exported shape working).

- [ ] **Step 3: Run tests** — new suites green; full `npm test` green; legacy interceptor tests untouched and green.

- [ ] **Step 4: Commit** `feat(interceptor): add opt-in weighted-scorer scheduler selection path`

---

### Task 6: `/lab scheduler` commands + docs

**Files:**
- Modify: `src/commands/register.ts` (add `scheduler` subcommand group; extend `Deps` additively)
- Modify: `README.md` (P3 section: architecture state, select vs execute, opt-in config, deferred items)
- Test: `test/scheduler-commands.test.ts` (render-level tests with fakes, following existing command test patterns if present; otherwise pure render functions + tests)

Commands:

```text
/lab scheduler status                 -> instance id, definition@version, round, agent count, enabled flag
/lab scheduler select <role>          -> run select-mode dispatch against live runtime; show selected model,
                                         score, reason, and (dualRun style) the legacy recommendation side-by-side
/lab scheduler sync                   -> syncWeightedScorerAgents against current catalog; report added count
/lab scheduler events [--limit N]     -> last N scheduling.* / scheduler.* events from the EventLog
```

- [ ] **Step 1: Write failing tests** for the four render paths (ready/unavailable/empty-catalog/error).

- [ ] **Step 2: Implement commands** (fail-open notifies, consistent with existing `/lab` style).

- [ ] **Step 3: Update README** — architecture state after P3, opt-in instructions (`/lab config scheduler.enabled true`), select vs execute semantics, dual-run behavior, deferred items carried from P2 (LabEvent.sequence numeric ordering, throwIfCancelled active-run test, unused imports, context tool-dedup duplication).

- [ ] **Step 4: Run full verification** — `npm test`, focused suites, `node --experimental-strip-types -e "import('./src/runtime/create-scheduler-runtime.ts')"` smoke, `git diff --check`, protected-path diff limited to the additive changes listed in Tasks 5–6.

- [ ] **Step 5: Commit** `feat(commands): add /lab scheduler inspection commands and P3 docs`

---

## Final whole-phase verification (after Task 6)

- `npm test` green (baseline 181 + all new).
- Focused: `node --experimental-strip-types --test test/core-*.test.ts test/workloop-*.test.ts test/pi-*.test.ts test/scheduler-*.test.ts test/weighted-scorer*.test.ts` green.
- Runtime import smokes for `create-runtime.ts` and `create-scheduler-runtime.ts`.
- `git diff --check` clean.
- `git status --short` clean.
- Diff audit vs main: only the files listed in this plan changed; legacy behavior baseline tests untouched.
