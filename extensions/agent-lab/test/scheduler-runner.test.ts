import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { SchedulerRunner } from "../src/scheduler/runner.ts";
import type { LabCore } from "../src/core/create-core.ts";
import type {
  SchedulerDefinition,
  WorkLoopDefinition,
  AgentInstanceRecord,
} from "../src/core/contracts.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulingResult,
  SchedulerSDK,
} from "../src/scheduler/contracts.ts";
import type {
  WorkLoopImplementation,
  WorkLoopInput,
  WorkLoopResult,
  WorkLoopSDK,
  WorkContext,
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../src/workloop/contracts.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function testContext(id = "ctx-1"): WorkContext {
  return {
    messages: [{ role: "user", content: "hello" }],
    metadata: { contextId: id, sourceRefs: [], artifactRefs: [] },
  };
}

function schedulerDef(
  overrides: Partial<SchedulerDefinition> = {},
): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "test-scheduler",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1.0.0",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: { weight: 0.5 },
    tunablePaths: ["weight"],
    validateParameters: () => ({ ok: true as const, value: {} }),
    validateAgentDefinition: () => ({ ok: true as const, value: {} }),
    ...overrides,
  };
}

function workloopDef(
  overrides: Partial<WorkLoopDefinition> = {},
): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: "pi-default-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
    ...overrides,
  };
}

function scheduleResult(
  status: SchedulingResult["status"],
  overrides: Partial<SchedulingResult> = {},
): SchedulingResult {
  switch (status) {
    case "completed":
      return {
        status: "completed",
        selectedAgentId: "agent-1",
        model: "gpt-4",
        reason: "best score",
        ...overrides,
      } as SchedulingResult;
    case "abstained":
      return { status: "abstained", reason: "no candidates", ...overrides };
    case "failed":
      return {
        status: "failed",
        error: { code: "ERR", message: "fail", retryable: false },
        ...overrides,
      };
  }
}

function noopModel(): ModelPort {
  return {
    complete: async () => ({ message: { role: "assistant", content: "ok" } }),
  };
}

function noopTools(): ToolPort {
  return { execute: async () => "done" };
}

function noopArtifacts(): ArtifactPort {
  return {
    put: async () => "ref-1",
    get: async () => "value",
  };
}

/**
 * Build a full LabCore wired to an in-memory DB with seeded data.
 */
function buildCore(opts?: {
  instanceId?: string;
  agents?: Array<{
    id: string;
    definition: AgentInstanceRecord["definition"];
  }>;
  routingBindings?: Array<{
    id: string;
    priority: number;
    match: { role?: string; taskCategory?: string; labels?: Record<string, string>; caller?: string };
  }>;
}): { core: LabCore; db: DatabaseSync; roundId: string; instanceId: string } {
  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(workloopDef());

  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);

  const controlPlane = new ControlPlane(definitions, repository, events);

  const instanceId = opts?.instanceId ?? "test-instance";
  const agents = opts?.agents ?? [];
  const routingBindings = opts?.routingBindings ?? [];

  const draftSpec = {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler" as const, id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: agents.map((a) => ({
      id: a.id,
      definition: a.definition,
    })),
    fallbackChain: [{ type: "original-request" as const }],
    routingBindings,
    metadata: {},
  };

  // Manually activate: save draft, create round, insert instance + agents + bindings
  repository.saveDraft(draftSpec);
  const roundId = `${instanceId}:round:0`;
  const now = Date.now();

  repository.transaction(() => {
    repository.insertInstance(
      {
        id: instanceId,
        name: instanceId,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: roundId,
        fallbackChain: [{ type: "original-request" }],
        createdAt: now,
      },
      {},
    );

    repository.insertRound({
      id: roundId,
      schedulerInstanceId: instanceId,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: now,
      activatedAt: now,
    });

    for (const agent of agents) {
      repository.insertAgent({
        id: agent.id,
        schedulerInstanceId: instanceId,
        definition: agent.definition,
        createdAtRoundId: roundId,
        status: "ready",
        createdAt: now,
      });
    }

    for (const binding of routingBindings) {
      repository.insertRoutingBinding(instanceId, binding);
    }
  });

  const core: LabCore = { definitions, repository, events, storage, controlPlane };
  return { core, db, roundId, instanceId };
}

function agentDef(
  id: string,
  model = "gpt-4",
): AgentInstanceRecord["definition"] {
  return {
    standard: {
      name: id,
      capabilities: [],
      executionKind: "model-candidate",
      labels: { provider: "openai" },
    },
    workLoop: {
      id: "pi-default-loop",
      version: "1.0.0",
      config: { cwd: ".", contextMode: "fresh", model },
    },
    custom: { model },
  };
}

// ── Test A: Explicit schedulerInstanceId wins over routing ───────────

test("A: explicit schedulerInstanceId wins over routing; routing.failed + SchedulingError when unknown", async () => {
  const { core, db } = buildCore({
    routingBindings: [
      { id: "r1", priority: 10, match: { role: "worker" } },
    ],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedInput: SchedulingInput | undefined;
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (input, _params, _sdk) => {
      capturedInput = input;
      return scheduleResult("completed", { model: "gpt-4" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  // Even with routing bindings present, explicit instanceId wins
  const result = await runner.dispatch({
    traceId: "t1",
    schedulerInstanceId: "test-instance",
    role: "architect",
    task: "do it",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.schedulerInstanceId, "test-instance");

  // No routing event — explicit skip
  const events = core.events.query({ traceId: "t1" });
  const routingResolved = events.filter((e) => e.eventType === "routing.resolved");
  assert.equal(routingResolved.length, 0);

  db.close();
});

test("A2: explicit schedulerInstanceId for unknown instance → scheduling.requested + routing.failed", async () => {

  const { core, db } = buildCore({ instanceId: "real-instance" });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("completed"),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t2",
    schedulerInstanceId: "nonexistent",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "failed");
  assert.ok("error" in result);
  assert.equal((result as any).error?.standard?.code, "scheduler-error");

  const events = core.events.query({ traceId: "t2" });
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("scheduling.requested"));
  assert.ok(types.includes("routing.failed"));

  db.close();
});

// ── Test B: Static routing ──────────────────────────────────────────

test("B: static routing — exact role match beats catch-all; higher priority wins on ties; routing.resolved carries bindingId + instanceId", async () => {

  const { core, db, instanceId } = buildCore({
    routingBindings: [
      { id: "catch-all", priority: 0, match: {} },
      { id: "worker-route", priority: 10, match: { role: "worker" } },
    ],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("completed", { model: "gpt-4" }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t3",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.schedulerInstanceId, instanceId);

  const events = core.events.query({ traceId: "t3" });
  const routingEvt = events.find((e) => e.eventType === "routing.resolved");
  assert.ok(routingEvt);
  assert.equal(routingEvt.identity.schedulerInstanceId, instanceId);

  db.close();
});

test("B2: no matching route → routing.failed, no scheduler.started", async () => {

  const { core, db } = buildCore({
    routingBindings: [
      { id: "r1", priority: 10, match: { role: "worker" } },
    ],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t4",
    role: "architect",
    task: "do it",
  });

  assert.equal(result.status, "failed");

  const events = core.events.query({ traceId: "t4" });
  assert.ok(events.some((e) => e.eventType === "routing.failed"));
  assert.ok(!events.some((e) => e.eventType === "scheduler.started"));

  db.close();
});

// ── Test C: Round pinning ───────────────────────────────────────────

test("C: schedule() receives parameters from instance.currentRoundId; missing round → scheduler.failed", async () => {

  const { core, db, roundId, instanceId } = buildCore({
    routingBindings: [{ id: "r1", priority: 10, match: {} }],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedParams: unknown | undefined;
  let capturedRoundId: string | undefined;

  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (input, params, _sdk) => {
      capturedParams = params;
      capturedRoundId = input.dispatchId; // dispatchId used to verify
      return scheduleResult("completed");
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "t5",
    role: "worker",
    task: "do it",
  });

  assert.deepEqual(capturedParams, { weight: 0.5 });
  assert.ok(Object.isFrozen(capturedParams));

  // Verify round identity in events
  const events = core.events.query({ traceId: "t5" });
  const started = events.find((e) => e.eventType === "scheduler.started");
  assert.ok(started);
  assert.equal(started.identity.optimizationRoundId, roundId);
  assert.equal(started.identity.schedulerInstanceId, instanceId);

  db.close();
});

test("C2: missing round → scheduler.failed", async () => {

  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);
  const core: LabCore = {
    definitions,
    repository,
    events,
    storage,
    controlPlane: new ControlPlane(definitions, repository, events),
  };

  // Insert instance with a round that doesn't exist
  repository.insertInstance(
    {
      id: "broken-instance",
      name: "broken-instance",
      definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
      parameterModelVersion: "1.0.0",
      agentDefinitionSchemaVersion: "1.0.0",
      status: "active",
      currentRoundId: "broken-instance:round:0",
      fallbackChain: [{ type: "original-request" }],
      createdAt: Date.now(),
    },
    {},
  );

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("completed"),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t6",
    schedulerInstanceId: "broken-instance",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "failed");

  const evs = events.query({ traceId: "t6" });
  assert.ok(evs.some((e) => e.eventType === "scheduler.failed"));

  db.close();
});

// ── Test D: Event order with identity fields ────────────────────────

test("D: scheduling.requested → routing.resolved → scheduler.started → scheduler.agent.selected → scheduler.completed", async () => {

  const { core, db, instanceId, roundId } = buildCore({
    routingBindings: [{ id: "r1", priority: 10, match: {} }],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("completed", { selectedAgentId: "agent-1", model: "gpt-4" }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t7",
    dispatchId: "d7",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "completed");
  assert.equal((result as any).selectedAgentId, "agent-1");
  assert.equal((result as any).model, "gpt-4");

  const events = core.events.query({ traceId: "t7" });
  events.sort((a, b) => {
    const seqA = parseInt(a.eventId.split(":").pop()!, 10);
    const seqB = parseInt(b.eventId.split(":").pop()!, 10);
    return seqA - seqB;
  });

  const types = events.map((e) => e.eventType);
  assert.deepStrictEqual(types, [
    "scheduling.requested",
    "routing.resolved",
    "scheduler.started",
    "scheduler.agent.selected",
    "scheduler.completed",
  ]);

  // Check identity fields on scheduler.started
  const started = events.find((e) => e.eventType === "scheduler.started")!;
  assert.equal(started.identity.traceId, "t7");
  assert.ok(started.identity.dispatchId);
  assert.equal(started.identity.schedulerInstanceId, instanceId);
  assert.equal(started.identity.schedulerDefinitionId, "test-scheduler");
  assert.equal(started.identity.schedulerDefinitionVersion, "1.0.0");
  assert.equal(started.identity.optimizationRoundId, roundId);

  // Event IDs are deterministic: ${traceId}:${dispatchId}:${eventType}:${seq}
  for (const evt of events) {
    assert.ok(evt.eventId.startsWith("t7:d7"));
  }

  db.close();
});

// ── Test E: SDK agents.list scoped ───────────────────────────────────

test("E: SDK agents.list returns only owning instance agents; agents.create inserts via repository", async () => {

  const { core, db, instanceId, roundId } = buildCore({
    agents: [{ id: "agent-1", definition: agentDef("agent-1") }],
    routingBindings: [{ id: "r1", priority: 10, match: {} }],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedSDK: SchedulerSDK | undefined;

  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, _params, sdk) => {
      capturedSDK = sdk;
      return scheduleResult("completed");
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  await runner.dispatch({
    traceId: "t8",
    role: "worker",
    task: "do it",
  });

  assert.ok(capturedSDK);
  const agents = await capturedSDK!.agents.list();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, "agent-1");
  assert.equal(agents[0].definition.standard.name, "agent-1");
  assert.equal(agents[0].status, "ready");

  // agents.create
  const created = await capturedSDK!.agents.create({
    id: "agent-2",
    definition: agentDef("agent-2", "claude"),
  });
  assert.equal(created.id, "agent-2");

  // Verify via repository
  const allAgents = core.repository.listAgents(instanceId);
  assert.equal(allAgents.length, 2);

  const a2 = allAgents.find((a) => a.id === "agent-2")!;
  assert.ok(a2);
  assert.equal(a2.createdAtRoundId, roundId);
  assert.equal(a2.status, "ready");

  // agent.created event emitted
  const events = core.events.query({ traceId: "t8" });
  assert.ok(events.some((e) => e.eventType === "scheduler.agent.created"));

  // Now list should include both
  const agentsAgain = await capturedSDK!.agents.list();
  assert.equal(agentsAgain.length, 2);

  db.close();
});

// ── Test F: SDK agents.run execute mode ──────────────────────────────

test("F: SDK agents.run delegates to WorkLoopRunner with merged config; rejects for foreign agent", async () => {

  // Build a workloop runner with real impl
  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(workloopDef());

  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const store = new NamespacedStore(db);

  const controlPlane = new ControlPlane(definitions, repository, events);
  const core: LabCore = { definitions, repository, events, storage: store, controlPlane };

  const instanceId = "instance-run";
  const roundId = `${instanceId}:round:0`;
  const now = Date.now();

  const draftSpec = {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler" as const, id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [{ id: "agent-run", definition: agentDef("agent-run", "gpt-4") }],
    fallbackChain: [{ type: "original-request" as const }],
    routingBindings: [{ id: "r1", priority: 10, match: {} }],
    metadata: {},
  };

  repository.saveDraft(draftSpec);
  repository.transaction(() => {
    repository.insertInstance(
      {
        id: instanceId,
        name: instanceId,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: roundId,
        fallbackChain: [{ type: "original-request" }],
        createdAt: now,
      },
      {},
    );
    repository.insertRound({
      id: roundId,
      schedulerInstanceId: instanceId,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: now,
      activatedAt: now,
    });
    repository.insertAgent({
      id: "agent-run",
      schedulerInstanceId: instanceId,
      definition: agentDef("agent-run", "gpt-4"),
      createdAtRoundId: roundId,
      status: "ready",
      createdAt: now,
    });
    repository.insertRoutingBinding(instanceId, { id: "r1", priority: 10, match: {} });
  });

  // Create WorkLoopRunner
  const wlRegistry = new WorkLoopRegistry(core.definitions);
  wlRegistry.register({
    id: "pi-default-loop",
    version: "1.0.0",
    cloneModes: ["fresh"],
    initialContext: () => testContext("init"),
    initialState: () => ({ counter: 0 }),
    run: async (input: WorkLoopInput, _sdk: WorkLoopSDK): Promise<WorkLoopResult> => ({
      status: "completed",
      output: { standard: { text: `did: ${input.task}` } },
      context: testContext("done"),
      state: { counter: 1 },
    }),
  });

  const stateStore = new AgentRuntimeStateStore(store);
  const checkpointStore = new CheckpointStore(store);

  const wlRunner = new WorkLoopRunner(
    wlRegistry,
    stateStore,
    checkpointStore,
    events,
    store,
    noopModel(),
    noopTools(),
    noopArtifacts(),
  );

  // Initialize the agent state (required by WorkLoopRunner)
  stateStore.initialize("agent-run", testContext("init"), { counter: 0 });

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedSDK: SchedulerSDK | undefined;

  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, _params, sdk) => {
      capturedSDK = sdk;
      return scheduleResult("completed", { selectedAgentId: "agent-run" });
    },
  });

  const runner = new SchedulerRunner({
    core,
    schedulers,
    runner: wlRunner,
  });

  await runner.dispatch({
    traceId: "t9",
    role: "worker",
    task: "do it",
  });

  assert.ok(capturedSDK);

  // Run the agent
  const runResult = await capturedSDK!.agents.run("agent-run", {
    task: "solve problem",
    configOverrides: { extra: true },
  });

  assert.equal(runResult.status, "completed");
  assert.equal(runResult.output?.text, "did: solve problem");

  // Foreign agent → reject
  await assert.rejects(
    () => capturedSDK!.agents.run("agent-foreign", { task: "x" }),
    /agent not found/,
  );

  // agents.run without runner → throws typed unavailable error
  let sdkNoWL: SchedulerSDK | undefined;
  const schedulers2 = new SchedulerRegistry(core.definitions);
  schedulers2.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, _params, sdk) => {
      sdkNoWL = sdk;
      return scheduleResult("completed");
    },
  });

  const runnerNoWL = new SchedulerRunner({ core, schedulers: schedulers2 });

  await runnerNoWL.dispatch({
    traceId: "t9b",
    role: "worker",
    task: "do it",
  });

  assert.ok(sdkNoWL);
  await assert.rejects(
    () => sdkNoWL!.agents.run("agent-run", { task: "x" }),
    /workloop runner not available/,
  );

  db.close();
});

// ── Test G: Fallback chain ──────────────────────────────────────────

test("G: fallback chain — failed → next target; original-request returns fallback result", async () => {

  // Instance with fallback: original-request
  const { core, db, instanceId } = buildCore({
    routingBindings: [{ id: "r1", priority: 10, match: { role: "worker" } }],
    // default fallbackChain: [{ type: "original-request" }]
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("failed", {
        error: { code: "NO_MODEL", message: "no model found", retryable: false },
      }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t10",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "fallback");
  assert.deepEqual((result as any).target, { type: "original-request" });
  assert.ok((result as any).attempts);
  assert.equal((result as any).attempts.length, 1);
  assert.equal((result as any).attempts[0].status, "failed");

  db.close();
});

test("G2: fail target → returns failed with that error code", async () => {

  const { core, db } = buildCore({
    instanceId: "fail-target-instance",
    routingBindings: [{ id: "r1", priority: 10, match: { role: "worker" } }],
  });

  // Override the instance fallback to include a fail target
  // We need to insert a different instance with fail target
  const db2 = memoryDB();
  const defs = new DefinitionRegistry();
  defs.register(schedulerDef());
  defs.register(workloopDef());
  const repo2 = new CoreRepository(db2);
  const evts2 = new EventLog(db2);
  const store2 = new NamespacedStore(db2);
  const core2: LabCore = {
    definitions: defs,
    repository: repo2,
    events: evts2,
    storage: store2,
    controlPlane: new ControlPlane(defs, repo2, evts2),
  };

  const iid = "fail-target-instance";
  const rid = `${iid}:round:0`;
  const n = Date.now();
  repo2.saveDraft({
    id: iid,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "fail", errorCode: "ALL_DOWN" }],
    routingBindings: [{ id: "r1", priority: 10, match: { role: "worker" } }],
    metadata: {},
  });
  repo2.transaction(() => {
    repo2.insertInstance(
      {
        id: iid,
        name: iid,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: rid,
        fallbackChain: [{ type: "fail", errorCode: "ALL_DOWN" }],
        createdAt: n,
      },
      {},
    );
    repo2.insertRound({
      id: rid,
      schedulerInstanceId: iid,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: n,
      activatedAt: n,
    });
    repo2.insertRoutingBinding(iid, { id: "r1", priority: 10, match: { role: "worker" } });
  });

  const scheds2 = new SchedulerRegistry(core2.definitions);
  scheds2.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("failed", {
        error: { code: "NO_MODEL", message: "no model found", retryable: false },
      }),
  });

  const runner2 = new SchedulerRunner({ core: core2, schedulers: scheds2 });

  const result = await runner2.dispatch({
    traceId: "t11",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "failed");
  assert.equal((result as any).error?.standard?.code, "ALL_DOWN");

  db2.close();
  db.close();
});

test("G3: scheduler-instance fallback re-enters dispatch; maxDepth 3 aborts", async () => {

  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(workloopDef());
  const repo = new CoreRepository(db);
  const evts = new EventLog(db);
  const store = new NamespacedStore(db);
  const core: LabCore = {
    definitions,
    repository: repo,
    events: evts,
    storage: store,
    controlPlane: new ControlPlane(definitions, repo, evts),
  };

  // First instance: always fails, fallback to second
  const iid1 = "instance-fail";
  const rid1 = `${iid1}:round:0`;
  const n = Date.now();

  repo.saveDraft({
    id: iid1,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "scheduler-instance", id: "instance-ok" }],
    routingBindings: [{ id: "r1", priority: 10, match: { role: "worker" } }],
    metadata: {},
  });

  // Second instance: succeeds, fallback to original
  const iid2 = "instance-ok";
  const rid2 = `${iid2}:round:0`;

  repo.saveDraft({
    id: iid2,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [{ id: "r2", priority: 10, match: { role: "worker" } }],
    metadata: {},
  });

  repo.transaction(() => {
    repo.insertInstance(
      {
        id: iid1,
        name: iid1,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: rid1,
        fallbackChain: [{ type: "scheduler-instance", id: "instance-ok" }],
        createdAt: n,
      },
      {},
    );
    repo.insertRound({
      id: rid1,
      schedulerInstanceId: iid1,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: n,
      activatedAt: n,
    });
    repo.insertRoutingBinding(iid1, { id: "r1", priority: 10, match: { role: "worker" } });

    repo.insertInstance(
      {
        id: iid2,
        name: iid2,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: rid2,
        fallbackChain: [{ type: "original-request" }],
        createdAt: n,
      },
      {},
    );
    repo.insertRound({
      id: rid2,
      schedulerInstanceId: iid2,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: n,
      activatedAt: n,
    });
    repo.insertRoutingBinding(iid2, { id: "r2", priority: 10, match: { role: "worker" } });
  });

  const schedulers = new SchedulerRegistry(core.definitions);

  // First instance always fails
  let callCount = 0;
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => {
      callCount++;
      if (callCount === 1) {
        // First call (instance-fail) → fails
        return scheduleResult("failed", {
          error: { code: "FAIL1", message: "first fails", retryable: false },
        });
      }
      // Second call (instance-ok) → completes
      return scheduleResult("completed", { model: "recovered-model" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t12",
    role: "worker",
    task: "do it",
  });

  // Should complete via fallback chain
  assert.equal(result.status, "completed");
  assert.equal(callCount, 2);

  // Both attempts recorded
  assert.ok((result as any).attempts);
  assert.equal((result as any).attempts.length, 2);
  assert.equal((result as any).attempts[0].status, "failed");
  assert.equal((result as any).attempts[1].status, "completed");

  // Events from first failure preserved
  const evs = evts.query({ traceId: "t12" });
  assert.ok(evs.some((e) => e.eventType === "scheduler.failed"));

  db.close();
});

test("G4: maxDepth exceeded → failed", async () => {

  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(workloopDef());
  const repo = new CoreRepository(db);
  const evts = new EventLog(db);
  const store = new NamespacedStore(db);
  const core: LabCore = {
    definitions,
    repository: repo,
    events: evts,
    storage: store,
    controlPlane: new ControlPlane(definitions, repo, evts),
  };

  // Create instances that all fail and fallback to scheduler-instance chain
  const n = Date.now();
  const instances = ["i0", "i1", "i2", "i3", "i4"];
  for (let i = 0; i < instances.length; i++) {
    const iid = instances[i];
    const rid = `${iid}:round:0`;
    const next = i < instances.length - 1
      ? [{ type: "scheduler-instance" as const, id: instances[i + 1] }]
      : [{ type: "original-request" as const }];

    repo.saveDraft({
      id: iid,
      schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
      initialParameters: { weight: 0.5 },
      agents: [],
      fallbackChain: next,
      routingBindings: [{ id: `r-${iid}`, priority: 10, match: {} }],
      metadata: {},
    });
  }

  repo.transaction(() => {
    for (let i = 0; i < instances.length; i++) {
      const iid = instances[i];
      const rid = `${iid}:round:0`;
      const next = i < instances.length - 1
        ? [{ type: "scheduler-instance" as const, id: instances[i + 1] }]
        : [{ type: "original-request" as const }];

      repo.insertInstance(
        {
          id: iid,
          name: iid,
          definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
          parameterModelVersion: "1.0.0",
          agentDefinitionSchemaVersion: "1.0.0",
          status: "active",
          currentRoundId: rid,
          fallbackChain: next,
          createdAt: n,
        },
        {},
      );
      repo.insertRound({
        id: rid,
        schedulerInstanceId: iid,
        sequence: 0,
        parameters: { weight: 0.5 },
        status: "active",
        createdAt: n,
        activatedAt: n,
      });
      repo.insertRoutingBinding(iid, { id: `r-${iid}`, priority: 10, match: {} });
    }
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("failed", {
        error: { code: "FAIL", message: "always fails", retryable: false },
      }),
  });

  const runner = new SchedulerRunner({ core, schedulers, maxFallbackDepth: 3 });

  const result = await runner.dispatch({
    traceId: "t13",
    role: "worker",
    task: "do it",
  });

  // Should fail when maxDepth exceeded
  assert.equal(result.status, "failed");
  // At most attempts tracked up to maxDepth
  const attempts = (result as any).attempts;
  assert.ok(attempts.length <= 3);

  const evs = evts.query({ traceId: "t13" });
  assert.ok(evs.some((e) => e.eventType === "scheduler.failed"));

  db.close();
});

test("G5: cycle detection aborts with routing/fallback failure event", async () => {

  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(workloopDef());
  const repo = new CoreRepository(db);
  const evts = new EventLog(db);
  const store = new NamespacedStore(db);
  const core: LabCore = {
    definitions,
    repository: repo,
    events: evts,
    storage: store,
    controlPlane: new ControlPlane(definitions, repo, evts),
  };

  const n = Date.now();
  const iid1 = "cycle-a";
  const iid2 = "cycle-b";
  const rid1 = `${iid1}:round:0`;
  const rid2 = `${iid2}:round:0`;

  repo.saveDraft({
    id: iid1,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "scheduler-instance", id: iid2 }],
    routingBindings: [{ id: "ra", priority: 10, match: {} }],
    metadata: {},
  });
  repo.saveDraft({
    id: iid2,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "scheduler-instance", id: iid1 }],
    routingBindings: [{ id: "rb", priority: 10, match: {} }],
    metadata: {},
  });

  repo.transaction(() => {
    repo.insertInstance(
      {
        id: iid1,
        name: iid1,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: rid1,
        fallbackChain: [{ type: "scheduler-instance", id: iid2 }],
        createdAt: n,
      },
      {},
    );
    repo.insertRound({
      id: rid1,
      schedulerInstanceId: iid1,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: n,
      activatedAt: n,
    });
    repo.insertRoutingBinding(iid1, { id: "ra", priority: 10, match: {} });

    repo.insertInstance(
      {
        id: iid2,
        name: iid2,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: rid2,
        fallbackChain: [{ type: "scheduler-instance", id: iid1 }],
        createdAt: n,
      },
      {},
    );
    repo.insertRound({
      id: rid2,
      schedulerInstanceId: iid2,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: n,
      activatedAt: n,
    });
    repo.insertRoutingBinding(iid2, { id: "rb", priority: 10, match: {} });
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () =>
      scheduleResult("failed", {
        error: { code: "FAIL", message: "always fails", retryable: false },
      }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t14",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "failed");

  const evs = evts.query({ traceId: "t14" });
  assert.ok(evs.some((e) => e.eventType === "scheduler.failed"));

  db.close();
});

// ── Test H: Abstain ─────────────────────────────────────────────────

test("H: abstain → scheduler.abstained event, no fallback triggered", async () => {

  const { core, db, instanceId } = buildCore({
    routingBindings: [{ id: "r1", priority: 10, match: {} }],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("abstained", { reason: "no candidates" }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t15",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "abstained");
  assert.equal((result as any).reason, "no candidates");
  assert.equal((result as any).schedulerInstanceId, instanceId);

  const events = core.events.query({ traceId: "t15" });
  assert.ok(events.some((e) => e.eventType === "scheduler.abstained"));
  assert.ok(!events.some((e) => e.eventType === "fallback.started"));

  db.close();
});

// ── Test I: SDK storage namespaced per instance ─────────────────────

test("I: sdk.storage is namespaced per scheduler instance", async () => {

  const { core: core1, db: db1 } = buildCore({
    instanceId: "instance-1",
    routingBindings: [{ id: "r1a", priority: 10, match: {} }],
  });
  const { core: core2, db: db2 } = buildCore({
    instanceId: "instance-2",
    routingBindings: [{ id: "r1b", priority: 10, match: {} }],
  });

  const schedulers1 = new SchedulerRegistry(core1.definitions);
  let sdk1: SchedulerSDK | undefined;
  schedulers1.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, _params, sdk) => {
      sdk1 = sdk;
      return scheduleResult("completed");
    },
  });

  const schedulers2 = new SchedulerRegistry(core2.definitions);
  let sdk2: SchedulerSDK | undefined;
  schedulers2.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, _params, sdk) => {
      sdk2 = sdk;
      return scheduleResult("completed");
    },
  });

  const runner1 = new SchedulerRunner({ core: core1, schedulers: schedulers1 });
  const runner2 = new SchedulerRunner({ core: core2, schedulers: schedulers2 });

  await runner1.dispatch({ traceId: "t16a", role: "worker", task: "do it" });
  await runner2.dispatch({ traceId: "t16b", role: "worker", task: "do it" });

  assert.ok(sdk1);
  assert.ok(sdk2);

  // Write to instance-1 namespace
  sdk1.storage.put("my-key", "val-1", 0);
  assert.equal(sdk1.storage.get("my-key")?.value, "val-1");

  // Instance-2 does not see instance-1 data
  assert.equal(sdk2.storage.get("my-key"), undefined);

  // Write to instance-2 namespace
  sdk2.storage.put("my-key", "val-2", 0);
  assert.equal(sdk2.storage.get("my-key")?.value, "val-2");

  // Instance-1 still sees its own
  assert.equal(sdk1.storage.get("my-key")?.value, "val-1");

  db1.close();
  db2.close();
});

// ── Test J: Aborted signal before start ─────────────────────────────

test("J: dispatch input signal aborted before start → cancelled-style failure, no scheduler.started", async () => {

  const { core, db } = buildCore({
    routingBindings: [{ id: "r1", priority: 10, match: { role: "worker" } }],
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let scheduleCalled = false;
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => {
      scheduleCalled = true;
      return scheduleResult("completed");
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });
  const ac = new AbortController();
  ac.abort();

  const result = await runner.dispatch({
    traceId: "t17",
    role: "worker",
    task: "do it",
    signal: ac.signal,
  });

  assert.equal(result.status, "failed");
  assert.ok(!scheduleCalled);

  const events = core.events.query({ traceId: "t17" });
  assert.ok(!events.some((e) => e.eventType === "scheduler.started"));

  db.close();
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5b T5: Canary round pinning
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a core with a canary round configured on the instance.
 */
function buildCanaryCore(opts: {
  instanceId?: string;
  canaryPercent?: number;
  /** If true, don't insert the canary round (simulates missing round). */
  missingCanaryRound?: boolean;
}): { core: LabCore; db: DatabaseSync; currentRoundId: string; canaryRoundId: string; instanceId: string } {
  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(workloopDef());

  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);
  const controlPlane = new ControlPlane(definitions, repository, events);

  const instanceId = opts.instanceId ?? "canary-instance";
  const currentRoundId = `${instanceId}:round:0`;
  const canaryRoundId = `${instanceId}:round:1`;
  const now = Date.now();

  const draftSpec = {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler" as const, id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "original-request" as const }],
    routingBindings: [{ id: `r-${instanceId}`, priority: 10, match: {} }],
    metadata: {},
  };

  repository.saveDraft(draftSpec);

  repository.transaction(() => {
    repository.insertInstance(
      {
        id: instanceId,
        name: instanceId,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId,
        canaryRoundId: opts.missingCanaryRound ? canaryRoundId : canaryRoundId,
        canaryPercent: opts.canaryPercent,
        fallbackChain: [{ type: "original-request" }],
        createdAt: now,
      },
      {},
    );

    repository.insertRound({
      id: currentRoundId,
      schedulerInstanceId: instanceId,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: now,
      activatedAt: now,
    });

    if (!opts.missingCanaryRound) {
      repository.insertRound({
        id: canaryRoundId,
        schedulerInstanceId: instanceId,
        sequence: 1,
        parentRoundId: currentRoundId,
        parameters: { weight: 0.8, canary: true },
        status: "canary",
        createdAt: now,
      });
    }

    repository.insertRoutingBinding(instanceId, { id: `r-${instanceId}`, priority: 10, match: {} });
  });

  const core: LabCore = { definitions, repository, events, storage, controlPlane };
  return { core, db, currentRoundId, canaryRoundId, instanceId };
}

// ── Test K: Canary round pinned at 100% ─────────────────────────────

test("K: canaryPercent=100 always pins canary round; scheduler receives canary parameters; events carry canary roundId", async () => {
  const { core, db, currentRoundId, canaryRoundId, instanceId } = buildCanaryCore({
    canaryPercent: 100,
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedParams: unknown | undefined;

  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, params) => {
      capturedParams = params;
      return scheduleResult("completed", { model: "canary-model" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t-canary-100",
    role: "worker",
    task: "do it",
  });

  // Result uses canary round
  assert.equal(result.status, "completed");
  assert.equal((result as any).roundId, canaryRoundId);
  assert.notEqual((result as any).roundId, currentRoundId);

  // Scheduler received canary parameters
  assert.deepEqual(capturedParams, { weight: 0.8, canary: true });
  assert.ok(Object.isFrozen(capturedParams));

  // Events carry canary roundId in identity.optimizationRoundId
  const events = core.events.query({ traceId: "t-canary-100" });
  const started = events.find((e) => e.eventType === "scheduler.started")!;
  assert.ok(started);
  assert.equal(started.identity.optimizationRoundId, canaryRoundId);
  assert.equal(started.identity.schedulerInstanceId, instanceId);

  const completed = events.find((e) => e.eventType === "scheduler.completed")!;
  assert.ok(completed);
  assert.equal(completed.identity.optimizationRoundId, canaryRoundId);

  db.close();
});

// ── Test L: Canary round load failure → fallback to currentRoundId ──

test("L: canary round not found → fail-open: falls back to currentRoundId", async () => {
  const { core, db, currentRoundId, instanceId } = buildCanaryCore({
    canaryPercent: 100,
    missingCanaryRound: true,
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedParams: unknown | undefined;

  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, params) => {
      capturedParams = params;
      return scheduleResult("completed", { model: "fallback-model" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t-canary-failopen",
    role: "worker",
    task: "do it",
  });

  // Completes normally via fallback to currentRoundId
  assert.equal(result.status, "completed");
  assert.equal((result as any).roundId, currentRoundId);

  // Scheduler received current round parameters (not canary)
  assert.deepEqual(capturedParams, { weight: 0.5 });

  // Events carry current roundId
  const events = core.events.query({ traceId: "t-canary-failopen" });
  const started = events.find((e) => e.eventType === "scheduler.started")!;
  assert.ok(started);
  assert.equal(started.identity.optimizationRoundId, currentRoundId);

  db.close();
});

// ── Test M: canaryPercent=0 → always uses current round ────────────

test("M: canaryPercent=0 always uses current round (short-circuit)", async () => {
  const { core, db, currentRoundId } = buildCanaryCore({
    canaryPercent: 0,
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedParams: unknown | undefined;

  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (_input, params) => {
      capturedParams = params;
      return scheduleResult("completed", { model: "current-model" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t-canary-zero",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "completed");
  assert.equal((result as any).roundId, currentRoundId);
  assert.deepEqual(capturedParams, { weight: 0.5 });

  // Events carry current roundId
  const events = core.events.query({ traceId: "t-canary-zero" });
  const started = events.find((e) => e.eventType === "scheduler.started")!;
  assert.equal(started.identity.optimizationRoundId, currentRoundId);

  db.close();
});

// ── Test N: Pin distribution — large-N statistical tolerance ────────

test("N: canary pin distribution ≈ canaryPercent over N=2000 (statistical tolerance)", async () => {
  const { core, db, currentRoundId, canaryRoundId } = buildCanaryCore({
    canaryPercent: 50,
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("completed", { model: "dist-model" }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const N = 2000;
  let canaryCount = 0;
  let currentCount = 0;

  for (let i = 0; i < N; i++) {
    const result = await runner.dispatch({
      traceId: `t-dist-${i}`,
      role: "worker",
      task: "do it",
    });

    if ((result as any).roundId === canaryRoundId) {
      canaryCount++;
    } else if ((result as any).roundId === currentRoundId) {
      currentCount++;
    }
  }

  // Total dispatches
  assert.equal(canaryCount + currentCount, N);

  // With p=0.5 and N=2000, the 99.99% CI is roughly ±4.5% (3.9σ)
  // Use a generous ±8% band to avoid flakiness
  const canaryPct = (canaryCount / N) * 100;
  assert.ok(
    canaryPct >= 42 && canaryPct <= 58,
    `Expected canary % near 50, got ${canaryPct.toFixed(1)}% (${canaryCount}/${N})`,
  );

  db.close();
});

// ── Test O: canary round pinned at 100% with abstain ────────────────

test("O: canary pinning works with abstain path; events carry canary roundId", async () => {
  const { core, db, canaryRoundId } = buildCanaryCore({
    canaryPercent: 100,
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => scheduleResult("abstained", { reason: "no canary agents" }),
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t-canary-abstain",
    role: "worker",
    task: "do it",
  });

  assert.equal(result.status, "abstained");
  assert.equal((result as any).roundId, canaryRoundId);

  // Events carry canary roundId
  const events = core.events.query({ traceId: "t-canary-abstain" });
  const abstained = events.find((e) => e.eventType === "scheduler.abstained")!;
  assert.ok(abstained);
  assert.equal(abstained.identity.optimizationRoundId, canaryRoundId);

  db.close();
});

// ── Test P: canary pinning with fallback chain ──────────────────────

test("P: canary-pinned failure triggers fallback; attempts carry canary roundId", async () => {
  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());
  definitions.register(workloopDef());
  const repo = new CoreRepository(db);
  const evts = new EventLog(db);
  const store = new NamespacedStore(db);
  const core: LabCore = {
    definitions,
    repository: repo,
    events: evts,
    storage: store,
    controlPlane: new ControlPlane(definitions, repo, evts),
  };

  // Instance A: canary pinned, always fails, fallback to instance B
  const iidA = "canary-fallback-a";
  const currentRoundA = `${iidA}:round:0`;
  const canaryRoundA = `${iidA}:round:1`;
  const iidB = "canary-fallback-b";
  const roundB = `${iidB}:round:0`;
  const n = Date.now();

  repo.saveDraft({
    id: iidA,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "scheduler-instance" as const, id: iidB }],
    routingBindings: [{ id: "r-a", priority: 10, match: { role: "worker" } }],
    metadata: {},
  });
  repo.saveDraft({
    id: iidB,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 1.0 },
    agents: [],
    fallbackChain: [{ type: "original-request" as const }],
    routingBindings: [{ id: "r-b", priority: 10, match: { role: "worker" } }],
    metadata: {},
  });

  repo.transaction(() => {
    repo.insertInstance(
      {
        id: iidA,
        name: iidA,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: currentRoundA,
        canaryRoundId: canaryRoundA,
        canaryPercent: 100,
        fallbackChain: [{ type: "scheduler-instance", id: iidB }],
        createdAt: n,
      },
      {},
    );
    repo.insertRound({
      id: currentRoundA,
      schedulerInstanceId: iidA,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: n,
      activatedAt: n,
    });
    repo.insertRound({
      id: canaryRoundA,
      schedulerInstanceId: iidA,
      sequence: 1,
      parentRoundId: currentRoundA,
      parameters: { weight: 0.9, canary: true },
      status: "canary",
      createdAt: n,
    });
    repo.insertRoutingBinding(iidA, { id: "r-a", priority: 10, match: { role: "worker" } });

    repo.insertInstance(
      {
        id: iidB,
        name: iidB,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: roundB,
        fallbackChain: [{ type: "original-request" }],
        createdAt: n,
      },
      {},
    );
    repo.insertRound({
      id: roundB,
      schedulerInstanceId: iidB,
      sequence: 0,
      parameters: { weight: 1.0 },
      status: "active",
      createdAt: n,
      activatedAt: n,
    });
    repo.insertRoutingBinding(iidB, { id: "r-b", priority: 10, match: { role: "worker" } });
  });

  const schedulers = new SchedulerRegistry(core.definitions);
  let callCount = 0;
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async () => {
      callCount++;
      if (callCount === 1) {
        return scheduleResult("failed", {
          error: { code: "CANARY_FAIL", message: "canary scheduler failed", retryable: false },
        });
      }
      return scheduleResult("completed", { model: "fallback-recovery" });
    },
  });

  const runner = new SchedulerRunner({ core, schedulers });

  const result = await runner.dispatch({
    traceId: "t-canary-fallback",
    role: "worker",
    task: "do it",
  });

  // Should complete via fallback
  assert.equal(result.status, "completed");
  assert.equal(callCount, 2);

  // First attempt carries canary roundId
  const attempts = (result as any).attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "failed");
  assert.equal(attempts[0].roundId, canaryRoundA);
  assert.equal(attempts[1].status, "completed");

  db.close();
});
