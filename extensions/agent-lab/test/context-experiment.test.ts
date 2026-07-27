/**
 * context-experiment scheduler definition + assembly tests
 *
 * Covers:
 * - Parameter validation (bad shape, unknown strategy, empty assignments)
 * - Transition validation (whole-leave comparison)
 * - Assembly happy path (3 variants of one model coexist, no id collision)
 * - Idempotent re-create
 * - SchedulerImplementation select/execute behavior
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { createLabCore } from "../src/core/create-core.ts";
import type { LabCore } from "../src/core/create-core.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import type { SchedulerDefinition } from "../src/core/contracts.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulerSDK,
} from "../src/scheduler/contracts.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import {
  BUDGETED_HISTORY_DEFINITION,
  registerWorkLoopDefinition,
} from "../src/runtime/create-experiment-runtime.ts";
import {
  contextExperimentDefinition,
  validateParameters,
  validateTransition,
  validateAgentDefinition,
  experimentAgentId,
  assignmentToAgentDefinition,
  assignmentToAgentCreateSpec,
  createContextExperiment,
  createExperimentInstance,
  VALID_STRATEGIES,
  STRATEGY_WORKLOOP_ID,
  type Assignment,
  type ContextExperimentParameters,
} from "../src/schedulers/context-experiment.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function makeCore(db: DatabaseSync): LabCore {
  const core = createLabCore(db);
  // Register workloops needed for validation
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  registerWorkLoopDefinition(core, structuredClone(BUDGETED_HISTORY_DEFINITION));
  // Register selective-summary workloop definition stub for tests
  core.definitions.register({
    kind: "workloop" as const,
    id: "selective-summary",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        budgetTokens: { type: "number", default: 8192 },
      },
      required: ["model"],
    },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
  });
  return core;
}

function assignment(model: string, strategy: string, strategyConfig?: unknown): Assignment {
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(`invalid strategy: ${strategy}`);
  }
  return { model, strategy: strategy as Assignment["strategy"], strategyConfig };
}

function fakeSdk(agents: Array<{ id: string }> = []): SchedulerSDK {
  const agentList = [...agents];
  return {
    agents: {
      async list() {
        return agentList.map((a) => ({
          id: a.id,
          definition: { standard: {}, workLoop: {}, custom: {} } as any,
          status: "ready" as const,
        }));
      },
      async create(spec) {
        agentList.push({ id: spec.id });
        return { id: spec.id };
      },
      async run(agentId, _req) {
        return { status: "completed" as const, output: { text: `ran ${agentId}` } };
      },
    },
    storage: {
      get() { return undefined; },
      put(key, value) { return { value, version: 0 }; },
    },
    telemetry: {
      emit() {},
    },
    control: { signal: new AbortController().signal },
  };
}

function selectInput(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    traceId: "t1",
    dispatchId: "d1",
    role: "coder",
    task: "build it",
    mode: "select",
    ...overrides,
  };
}

function execInput(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    traceId: "t2",
    dispatchId: "d2",
    role: "coder",
    task: "build it",
    mode: "execute",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Section 1: Parameter validation
// ═══════════════════════════════════════════════════════════════════

test("validateParameters: rejects non-object", () => {
  const result = validateParameters(null);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "" && i.code === "INVALID_TYPE"));
  }
});

test("validateParameters: rejects missing assignments", () => {
  const result = validateParameters({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "assignments" && i.code === "INVALID_TYPE"));
  }
});

test("validateParameters: rejects non-array assignments", () => {
  const result = validateParameters({ assignments: "not-array" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "assignments" && i.code === "INVALID_TYPE"));
  }
});

test("validateParameters: rejects unknown top-level keys", () => {
  const result = validateParameters({ assignments: [], extraKey: 123 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "extraKey" && i.code === "UNKNOWN_KEY"));
  }
});

test("validateParameters: rejects non-object assignment item", () => {
  const result = validateParameters({ assignments: ["not-object"] });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "assignments.0" && i.code === "INVALID_TYPE"));
  }
});

test("validateParameters: rejects missing model", () => {
  const result = validateParameters({
    assignments: [{ strategy: "default" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "assignments.0.model" && i.code === "INVALID_TYPE"));
  }
});

test("validateParameters: rejects empty model string", () => {
  const result = validateParameters({
    assignments: [{ model: "", strategy: "default" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "assignments.0.model" && i.code === "INVALID_TYPE"));
  }
});

test("validateParameters: rejects missing strategy", () => {
  const result = validateParameters({
    assignments: [{ model: "openai/gpt-4o" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "assignments.0.strategy" && i.code === "INVALID_VALUE"));
  }
});

test("validateParameters: rejects unknown strategy", () => {
  const result = validateParameters({
    assignments: [{ model: "openai/gpt-4o", strategy: "magic-context" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "assignments.0.strategy" && i.code === "INVALID_VALUE"));
  }
});

test("validateParameters: rejects non-object strategyConfig", () => {
  const result = validateParameters({
    assignments: [{ model: "openai/gpt-4o", strategy: "default", strategyConfig: "bad" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some((i) => i.path === "assignments.0.strategyConfig" && i.code === "INVALID_TYPE"),
    );
  }
});

test("validateParameters: accepts null/undefined strategyConfig (omitted)", () => {
  // strategyConfig omitted
  const r1 = validateParameters({
    assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
  });
  assert.equal(r1.ok, true);

  // strategyConfig explicitly undefined is fine (it's not a key)
  const r2 = validateParameters({
    assignments: [{ model: "openai/gpt-4o", strategy: "default", strategyConfig: undefined }],
  });
  assert.equal(r2.ok, true);
});

test("validateParameters: rejects duplicate model+strategy pairs", () => {
  const result = validateParameters({
    assignments: [
      { model: "openai/gpt-4o", strategy: "default" },
      { model: "openai/gpt-4o", strategy: "default" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.code === "DUPLICATE_ASSIGNMENT"));
  }
});

test("validateParameters: accepts valid assignments", () => {
  const result = validateParameters({
    assignments: [
      { model: "openai/gpt-4o", strategy: "default" },
      { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 4096 } },
      { model: "anthropic/claude-3", strategy: "selective-summary" },
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.assignments.length, 3);
    assert.equal(result.value.assignments[0].model, "openai/gpt-4o");
    assert.equal(result.value.assignments[0].strategy, "default");
    assert.equal(result.value.assignments[1].strategy, "budgeted-history");
    assert.deepEqual(result.value.assignments[1].strategyConfig, { budgetTokens: 4096 });
    assert.equal(result.value.assignments[2].strategy, "selective-summary");
  }
});

test("validateParameters: accepts empty assignments array", () => {
  const result = validateParameters({ assignments: [] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.assignments.length, 0);
  }
});

// ═══════════════════════════════════════════════════════════════════
// Section 2: Transition validation
// ═══════════════════════════════════════════════════════════════════

test("validateTransition: accepts any valid assignments change", () => {
  const current = {
    assignments: [{ model: "openai/gpt-4o", strategy: "default" as const }],
  };
  const proposed = {
    assignments: [
      { model: "openai/gpt-4o", strategy: "default" as const },
      { model: "openai/gpt-4o", strategy: "budgeted-history" as const },
    ],
  };
  const result = validateTransition(current, proposed);
  assert.equal(result.ok, true);
});

test("validateTransition: rejects invalid proposed shape", () => {
  const current = {
    assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
  };
  const proposed = { assignments: "bad" };
  const result = validateTransition(current, proposed);
  assert.equal(result.ok, false);
});

test("validateTransition: compares as whole leaves (any valid reshuffle passes)", () => {
  // Removing assignments is fine
  const r1 = validateTransition(
    { assignments: [{ model: "a", strategy: "default" }, { model: "b", strategy: "default" }] },
    { assignments: [{ model: "a", strategy: "default" }] },
  );
  assert.equal(r1.ok, true);

  // Swapping order is fine
  const r2 = validateTransition(
    { assignments: [{ model: "a", strategy: "default" }, { model: "b", strategy: "default" }] },
    { assignments: [{ model: "b", strategy: "default" }, { model: "a", strategy: "default" }] },
  );
  assert.equal(r2.ok, true);
});

// ═══════════════════════════════════════════════════════════════════
// Section 3: AgentDefinition validation
// ═══════════════════════════════════════════════════════════════════

test("validateAgentDefinition: rejects null", () => {
  const result = validateAgentDefinition(null);
  assert.equal(result.ok, false);
});

test("validateAgentDefinition: rejects missing standard", () => {
  const result = validateAgentDefinition({ workLoop: {} });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "standard"));
  }
});

test("validateAgentDefinition: rejects missing workLoop", () => {
  const result = validateAgentDefinition({ standard: {} });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "workLoop"));
  }
});

test("validateAgentDefinition: accepts valid shape", () => {
  const result = validateAgentDefinition({ standard: {}, workLoop: {} });
  assert.equal(result.ok, true);
});

// ═══════════════════════════════════════════════════════════════════
// Section 4: Agent spec helpers
// ═══════════════════════════════════════════════════════════════════

test("experimentAgentId: produces correct ids", () => {
  assert.equal(experimentAgentId("openai/gpt-4o", "default"), "agent-openai__gpt-4o-default");
  assert.equal(experimentAgentId("openai/gpt-4o", "budgeted-history"), "agent-openai__gpt-4o-budgeted-history");
  assert.equal(experimentAgentId("openai/gpt-4o", "selective-summary"), "agent-openai__gpt-4o-selective-summary");
  // '/' encoded as '__', dots as '-': "anthropic/claude-3.5-sonnet" → "agent-anthropic__claude-3-5-sonnet-default"
  assert.equal(experimentAgentId("anthropic/claude-3.5-sonnet", "default"), "agent-anthropic__claude-3-5-sonnet-default");
});

test("assignmentToAgentDefinition: wires correct workLoop per strategy", () => {
  // default → pi-default-loop
  const d1 = assignmentToAgentDefinition(assignment("openai/gpt-4o", "default"));
  assert.equal(d1.workLoop.id, "pi-default-loop");
  assert.equal(d1.workLoop.version, "1.0.0");
  assert.equal((d1.workLoop.config as any).model, "openai/gpt-4o");
  assert.equal(d1.standard.labels?.strategy, "default");

  // budgeted-history
  const d2 = assignmentToAgentDefinition(assignment("openai/gpt-4o", "budgeted-history", { budgetTokens: 4096 }));
  assert.equal(d2.workLoop.id, "budgeted-history");
  assert.equal(d2.workLoop.version, "1.0.0");
  assert.equal((d2.workLoop.config as any).model, "openai/gpt-4o");
  assert.equal((d2.workLoop.config as any).budgetTokens, 4096);

  // selective-summary
  const d3 = assignmentToAgentDefinition(assignment("openai/gpt-4o", "selective-summary"));
  assert.equal(d3.workLoop.id, "selective-summary");
  assert.equal(d3.workLoop.version, "1.0.0");
});

test("assignmentToAgentCreateSpec: produces correct id and definition", () => {
  const spec = assignmentToAgentCreateSpec(assignment("openai/gpt-4o", "budgeted-history"));
  assert.equal(spec.id, "agent-openai__gpt-4o-budgeted-history");
  assert.equal(spec.definition.workLoop.id, "budgeted-history");
});

// ═══════════════════════════════════════════════════════════════════
// Section 5: Definition contract
// ═══════════════════════════════════════════════════════════════════

test("contextExperimentDefinition: has all required fields", () => {
  assert.equal(contextExperimentDefinition.kind, "scheduler");
  assert.equal(contextExperimentDefinition.id, "context-experiment");
  assert.equal(contextExperimentDefinition.version, "1.0.0");
  assert.equal(contextExperimentDefinition.parameterModelVersion, "1.0.0");
  assert.ok(Array.isArray(contextExperimentDefinition.tunablePaths));
  assert.equal(contextExperimentDefinition.tunablePaths.length, 1);
  assert.equal(contextExperimentDefinition.tunablePaths[0], "assignments");
  assert.ok(contextExperimentDefinition.parameterSchema);
  assert.ok(contextExperimentDefinition.agentDefinitionSchema);
  assert.ok(contextExperimentDefinition.defaultParameters);
});

test("contextExperimentDefinition: registers in DefinitionRegistry", () => {
  const defs = new DefinitionRegistry();
  assert.doesNotThrow(() => defs.register(contextExperimentDefinition));

  const resolved = defs.resolve({ kind: "scheduler", id: "context-experiment", version: "1.0.0" });
  assert.ok(resolved);
  assert.equal(resolved?.id, "context-experiment");
});

// ═══════════════════════════════════════════════════════════════════
// Section 6: SchedulerImplementation — select (abstain)
// ═══════════════════════════════════════════════════════════════════

test("schedule: select mode returns abstained", async () => {
  const { implementation } = createContextExperiment();
  const result = await implementation.schedule(
    selectInput(),
    { assignments: [assignment("openai/gpt-4o", "default")] },
    fakeSdk(),
  );
  assert.equal(result.status, "abstained");
  assert.ok((result as any).reason.includes("execute-only"));
});

test("schedule: select mode abstains even with assignments", async () => {
  const { implementation } = createContextExperiment();
  const result = await implementation.schedule(
    selectInput({ labels: { strategy: "default" } }),
    {
      assignments: [
        assignment("openai/gpt-4o", "default"),
        assignment("openai/gpt-4o", "budgeted-history"),
      ],
    },
    fakeSdk(),
  );
  assert.equal(result.status, "abstained");
});

// ═══════════════════════════════════════════════════════════════════
// Section 7: SchedulerImplementation — execute (direct pick)
// ═══════════════════════════════════════════════════════════════════

test("schedule: execute mode picks first assignment by default", async () => {
  const { implementation } = createContextExperiment();
  const result = await implementation.schedule(
    execInput(),
    {
      assignments: [
        assignment("openai/gpt-4o", "default"),
        assignment("openai/gpt-4o", "budgeted-history"),
      ],
    },
    fakeSdk(),
  );
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.selectedAgentId, "agent-openai__gpt-4o-default");
    assert.equal(result.model, "openai/gpt-4o");
  }
});

test("schedule: execute mode picks by labels.strategy", async () => {
  const { implementation } = createContextExperiment();
  const result = await implementation.schedule(
    execInput({ labels: { strategy: "budgeted-history" } }),
    {
      assignments: [
        assignment("openai/gpt-4o", "default"),
        assignment("openai/gpt-4o", "budgeted-history"),
      ],
    },
    fakeSdk(),
  );
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.selectedAgentId, "agent-openai__gpt-4o-budgeted-history");
  }
});

test("schedule: execute mode picks by labels.assignmentIndex", async () => {
  const { implementation } = createContextExperiment();
  const result = await implementation.schedule(
    execInput({ labels: { assignmentIndex: "1" } }),
    {
      assignments: [
        assignment("openai/gpt-4o", "default"),
        assignment("openai/gpt-4o", "selective-summary"),
      ],
    },
    fakeSdk(),
  );
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.selectedAgentId, "agent-openai__gpt-4o-selective-summary");
  }
});

test("schedule: execute mode abstains when no assignments", async () => {
  const { implementation } = createContextExperiment();
  const result = await implementation.schedule(
    execInput(),
    { assignments: [] },
    fakeSdk(),
  );
  assert.equal(result.status, "abstained");
  assert.ok((result as any).reason.includes("no assignments"));
});

test("schedule: execute mode creates agent if missing", async () => {
  const { implementation } = createContextExperiment();
  const sdk = fakeSdk([]); // no existing agents
  const result = await implementation.schedule(
    execInput(),
    {
      assignments: [assignment("openai/gpt-4o", "default")],
    },
    sdk,
  );
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.selectedAgentId, "agent-openai__gpt-4o-default");
  }
});

// ═══════════════════════════════════════════════════════════════════
// Section 8: Assembly — happy path + id collision
// ═══════════════════════════════════════════════════════════════════

test("createExperimentInstance: creates instance with 3 variants of one model", async () => {
  const db = memoryDB();
  const core = makeCore(db);

  const assignments: Assignment[] = [
    { model: "openai/gpt-4o", strategy: "default" },
    { model: "openai/gpt-4o", strategy: "budgeted-history", strategyConfig: { budgetTokens: 4096 } },
    { model: "openai/gpt-4o", strategy: "selective-summary" },
  ];

  const result = await createExperimentInstance(core, { assignments });
  assert.equal(result.instanceId, "context-experiment");
  assert.equal(result.roundId, "context-experiment:round:0");
  assert.equal(result.agentIds.length, 3);
  assert.deepEqual(
    result.agentIds.sort(),
    [
      "agent-openai__gpt-4o-budgeted-history",
      "agent-openai__gpt-4o-default",
      "agent-openai__gpt-4o-selective-summary",
    ].sort(),
  );

  // Instance is active
  const inst = core.repository.getInstance("context-experiment");
  assert.ok(inst);
  assert.equal(inst!.status, "active");
  assert.equal(inst!.definition.id, "context-experiment");

  // Round exists
  const round = core.repository.getRound(result.roundId);
  assert.ok(round);
  assert.equal(round!.status, "active");

  // Agents have correct workloop references
  const agents = core.repository.listAgents("context-experiment");

  const defaultAgent = agents.find((a) => a.id === "agent-openai__gpt-4o-default");
  assert.ok(defaultAgent);
  assert.equal(defaultAgent!.definition.workLoop.id, "pi-default-loop");
  assert.equal((defaultAgent!.definition.workLoop.config as any).model, "openai/gpt-4o");

  const bhAgent = agents.find((a) => a.id === "agent-openai__gpt-4o-budgeted-history");
  assert.ok(bhAgent);
  assert.equal(bhAgent!.definition.workLoop.id, "budgeted-history");
  assert.equal((bhAgent!.definition.workLoop.config as any).budgetTokens, 4096);

  const ssAgent = agents.find((a) => a.id === "agent-openai__gpt-4o-selective-summary");
  assert.ok(ssAgent);
  assert.equal(ssAgent!.definition.workLoop.id, "selective-summary");

  db.close();
});

test("createExperimentInstance: variant agents of same model have unique ids", async () => {
  const db = memoryDB();
  const core = makeCore(db);

  const assignments: Assignment[] = [
    { model: "openai/gpt-4o", strategy: "default" },
    { model: "openai/gpt-4o", strategy: "budgeted-history" },
    { model: "openai/gpt-4o", strategy: "selective-summary" },
  ];

  const result = await createExperimentInstance(core, { assignments });
  const ids = result.agentIds;
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 3, "all agent ids must be unique");

  db.close();
});

test("createExperimentInstance: idempotent on second call", async () => {
  const db = memoryDB();
  const core = makeCore(db);

  const assignments: Assignment[] = [
    { model: "openai/gpt-4o", strategy: "default" },
  ];

  const first = await createExperimentInstance(core, { assignments });
  const second = await createExperimentInstance(core, { assignments });

  assert.deepEqual(first, second);
  assert.equal(core.repository.listAgents("context-experiment").length, 1);

  db.close();
});

test("createExperimentInstance: idempotent with different assignments returns original", async () => {
  const db = memoryDB();
  const core = makeCore(db);

  const first = await createExperimentInstance(core, {
    assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
  });

  // Second call with different assignments — should return original (idempotent)
  const second = await createExperimentInstance(core, {
    assignments: [
      { model: "openai/gpt-4o", strategy: "default" },
      { model: "openai/gpt-4o", strategy: "budgeted-history" },
    ],
  });

  assert.deepEqual(first, second);
  // Only 1 agent because original only had 1
  assert.equal(core.repository.listAgents("context-experiment").length, 1);

  db.close();
});

test("createExperimentInstance: custom instanceId", async () => {
  const db = memoryDB();
  const core = makeCore(db);

  const result = await createExperimentInstance(core, {
    instanceId: "my-experiment",
    assignments: [{ model: "openai/gpt-4o", strategy: "default" }],
  });

  assert.equal(result.instanceId, "my-experiment");
  assert.equal(result.roundId, "my-experiment:round:0");

  const inst = core.repository.getInstance("my-experiment");
  assert.ok(inst);
  assert.equal(inst!.status, "active");

  db.close();
});

test("createExperimentInstance: definition already registered is handled gracefully", async () => {
  const db = memoryDB();
  const core = makeCore(db);

  // Pre-register the definition (register the original — functions survive in the registry)
  core.definitions.register(contextExperimentDefinition);

  const assignments: Assignment[] = [
    { model: "openai/gpt-4o", strategy: "default" },
  ];

  // Should not throw despite definition already being registered
  const result = await createExperimentInstance(core, { assignments });
  assert.equal(result.agentIds.length, 1);

  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Section 9: Definition + implementation registration
// ═══════════════════════════════════════════════════════════════════

test("createContextExperiment: definition and implementation are coherent", () => {
  const { definition, implementation } = createContextExperiment();
  assert.equal(definition.id, "context-experiment");
  assert.equal(implementation.id, "context-experiment");
  assert.equal(definition.version, implementation.version);
});

test("SchedulerRegistry: context-experiment implementation registers", () => {
  const defs = new DefinitionRegistry();
  defs.register(contextExperimentDefinition);

  const registry = new SchedulerRegistry(defs);
  const { implementation } = createContextExperiment();
  assert.doesNotThrow(() => registry.register(implementation));
});

// ═══════════════════════════════════════════════════════════════════
// Section 10: strategy workloop mapping
// ═══════════════════════════════════════════════════════════════════

test("STRATEGY_WORKLOOP_ID: all valid strategies have mappings", () => {
  for (const strategy of VALID_STRATEGIES) {
    assert.ok(
      STRATEGY_WORKLOOP_ID[strategy as keyof typeof STRATEGY_WORKLOOP_ID],
      `strategy "${strategy}" must have a workloop mapping`,
    );
  }
});

test("STRATEGY_WORKLOOP_ID: all mappings reference valid loop ids", () => {
  for (const [strategy, loopId] of Object.entries(STRATEGY_WORKLOOP_ID)) {
    assert.ok(typeof loopId === "string" && loopId.length > 0, `strategy "${strategy}" loopId must be non-empty`);
  }
});
