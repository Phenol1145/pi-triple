import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { WorkLoopRegistry, WorkLoopImplementationConflictError } from "../src/workloop/registry.ts";
import type { WorkLoopDefinition, SchedulerDefinition, SchedulerInstanceDraftSpec } from "../src/core/contracts.ts";
import type {
  WorkLoopImplementation,
  WorkLoopInput,
  WorkLoopResult,
  WorkLoopSDK,
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../src/workloop/contracts.ts";
import {
  createExperimentRuntime,
  registerWorkLoopDefinition,
  BUDGETED_HISTORY_DEFINITION,
} from "../src/runtime/create-experiment-runtime.ts";
import type { ExperimentRuntime } from "../src/runtime/create-experiment-runtime.ts";

// ── Fake ports ──────────────────────────────────────────────────────

function fakeModel(): ModelPort {
  return {
    complete: async () => ({
      message: { role: "assistant", content: "ok" },
    }),
  };
}

function fakeTools(): ToolPort {
  return { execute: async () => "done" };
}

function fakeArtifacts(): ArtifactPort {
  return {
    put: async () => "ref-1",
    get: async () => "value",
  };
}

// ── Scheduler definition helper for draft validation tests ──────────

function testSchedulerDef(overrides: Partial<SchedulerDefinition> = {}): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "test-scheduler",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: {},
    tunablePaths: [],
    validateParameters: () => ({ ok: true as const, value: {} }),
    validateAgentDefinition: () => ({ ok: true as const, value: {} }),
    ...overrides,
  };
}

// ── WorkLoop implementation helper ──────────────────────────────────

function noopImpl(
  id = "test-loop",
  version = "1.0.0",
  cloneModes: string[] = ["fresh"],
): WorkLoopImplementation {
  return {
    id,
    version,
    cloneModes,
    initialContext: () => ({
      messages: [],
      metadata: { contextId: "ctx-1", sourceRefs: [], artifactRefs: [] },
    }),
    initialState: () => ({}),
    run: async (_input: WorkLoopInput, _sdk: WorkLoopSDK): Promise<WorkLoopResult> => ({
      status: "completed",
      context: {
        messages: [],
        metadata: { contextId: "ctx-1", sourceRefs: [], artifactRefs: [] },
      },
      state: {},
    }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════
// createExperimentRuntime — composition
// ═══════════════════════════════════════════════════════════════════

test("createExperimentRuntime: returns all expected fields with fake ports", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.ok(rt.core, "core is present");
  assert.ok(rt.core.definitions instanceof DefinitionRegistry, "core.definitions is DefinitionRegistry");
  assert.ok(rt.workloopRegistry instanceof WorkLoopRegistry, "workloopRegistry is WorkLoopRegistry");
  assert.ok(rt.workloopRunner !== undefined, "workloopRunner is present");
  assert.ok(rt.stateStore !== undefined, "stateStore is present");
  assert.ok(rt.checkpointStore !== undefined, "checkpointStore is present");
  assert.equal(typeof rt.dispose, "function", "dispose is a function");
});

test("createExperimentRuntime: does NOT register pi-default-loop definition", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  // pi-default-loop should NOT be in the definition registry
  const wlDefs = rt.core.definitions.list("workloop");
  const hasPiDefault = wlDefs.some((d) => d.id === "pi-default-loop");
  assert.equal(hasPiDefault, false, "pi-default-loop should not be automatically registered");
});

test("createExperimentRuntime: dispose is a no-op on fresh runtime", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.doesNotThrow(() => rt.dispose());
});

test("createExperimentRuntime: different DBs produce independent runtimes", () => {
  const db1 = new DatabaseSync(":memory:");
  const db2 = new DatabaseSync(":memory:");

  const rt1 = createExperimentRuntime(db1, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });
  const rt2 = createExperimentRuntime(db2, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.notEqual(rt1.core, rt2.core);
  assert.notEqual(rt1.workloopRegistry, rt2.workloopRegistry);
});

test("createExperimentRuntime: workloopRegistry can register an impl after definition is registered", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  // Register definition first
  rt.core.definitions.register({
    kind: "workloop",
    id: "custom-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
  });

  // Then register impl — should succeed
  assert.doesNotThrow(() =>
    rt.workloopRegistry.register(noopImpl("custom-loop", "1.0.0", ["fresh"])),
  );
});

// ═══════════════════════════════════════════════════════════════════
// workloopRegistry cloneModes validation
// ═══════════════════════════════════════════════════════════════════

test("workloopRegistry: cloneModes mismatch throws WorkLoopImplementationConflictError", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  rt.core.definitions.register({
    kind: "workloop",
    id: "multi-mode-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh", "fork"],
  });

  // Implementation only declares ["fresh"] — should conflict
  assert.throws(
    () => rt.workloopRegistry.register(noopImpl("multi-mode-loop", "1.0.0", ["fresh"])),
    WorkLoopImplementationConflictError,
    /clone modes/,
  );
});

test("workloopRegistry: matching cloneModes (order-independent) succeeds", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  rt.core.definitions.register({
    kind: "workloop",
    id: "sorted-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fork", "fresh"],
  });

  assert.doesNotThrow(() =>
    rt.workloopRegistry.register(noopImpl("sorted-loop", "1.0.0", ["fresh", "fork"])),
  );
});

// ═══════════════════════════════════════════════════════════════════
// registerWorkLoopDefinition — shape validation
// ═══════════════════════════════════════════════════════════════════

test("registerWorkLoopDefinition: registers budgeted-history definition successfully", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.doesNotThrow(() => registerWorkLoopDefinition(rt.core, BUDGETED_HISTORY_DEFINITION));

  // Verify it's resolvable
  const resolved = rt.core.definitions.resolve({
    kind: "workloop",
    id: "budgeted-history",
    version: "1.0.0",
  });
  assert.ok(resolved, "budgeted-history definition should be resolvable");
  assert.equal(resolved!.kind, "workloop");
  assert.equal(resolved!.id, "budgeted-history");
});

test("registerWorkLoopDefinition: rejects null/undefined", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () => registerWorkLoopDefinition(rt.core, null as unknown as WorkLoopDefinition),
    TypeError,
    /must be an object/,
  );
});

test("registerWorkLoopDefinition: rejects non-workloop kind", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () =>
      registerWorkLoopDefinition(rt.core, {
        kind: "scheduler",
        id: "x",
        version: "1.0.0",
        sdkVersionRange: "^1.0.0",
        configSchema: { type: "object" },
        requiredCapabilities: [],
        cloneModes: ["fresh"],
      } as unknown as WorkLoopDefinition),
    TypeError,
    /kind must be "workloop"/,
  );
});

test("registerWorkLoopDefinition: rejects empty id", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () =>
      registerWorkLoopDefinition(rt.core, {
        ...BUDGETED_HISTORY_DEFINITION,
        id: "",
      }),
    TypeError,
    /id must be a non-empty string/,
  );
});

test("registerWorkLoopDefinition: rejects empty version", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () =>
      registerWorkLoopDefinition(rt.core, {
        ...BUDGETED_HISTORY_DEFINITION,
        version: "",
      }),
    TypeError,
    /version must be a non-empty string/,
  );
});

test("registerWorkLoopDefinition: rejects missing configSchema", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () =>
      registerWorkLoopDefinition(rt.core, {
        ...BUDGETED_HISTORY_DEFINITION,
        configSchema: undefined as unknown as Record<string, unknown>,
      }),
    TypeError,
    /configSchema must be a non-null object/,
  );
});

test("registerWorkLoopDefinition: rejects empty cloneModes", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () =>
      registerWorkLoopDefinition(rt.core, {
        ...BUDGETED_HISTORY_DEFINITION,
        cloneModes: [],
      }),
    TypeError,
    /cloneModes must be a non-empty array/,
  );
});

test("registerWorkLoopDefinition: rejects cloneModes with empty strings", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () =>
      registerWorkLoopDefinition(rt.core, {
        ...BUDGETED_HISTORY_DEFINITION,
        cloneModes: ["fresh", ""],
      }),
    TypeError,
    /each cloneMode must be a non-empty string/,
  );
});

test("registerWorkLoopDefinition: rejects missing requiredCapabilities", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  assert.throws(
    () =>
      registerWorkLoopDefinition(rt.core, {
        ...BUDGETED_HISTORY_DEFINITION,
        requiredCapabilities: undefined as unknown as string[],
      }),
    TypeError,
    /requiredCapabilities must be an array/,
  );
});

// ═══════════════════════════════════════════════════════════════════
// Definition registration → draft validation for agent referencing
// budgeted-history
// ═══════════════════════════════════════════════════════════════════

test("draft validation passes when agent references registered budgeted-history", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  // Register budgeted-history definition via the helper
  registerWorkLoopDefinition(rt.core, BUDGETED_HISTORY_DEFINITION);

  // Register scheduler definition needed for validation
  rt.core.definitions.register(testSchedulerDef());

  const controlPlane = new ControlPlane(
    rt.core.definitions,
    rt.core.repository,
    rt.core.events,
  );

  const draftId = "draft-1";
  const draftSpec: SchedulerInstanceDraftSpec = {
    id: draftId,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    agents: [
      {
        id: "agent-test",
        definition: {
          standard: {
            name: "test-agent",
            capabilities: [],
            executionKind: "execute",
            labels: {},
          },
          workLoop: {
            id: "budgeted-history",
            version: "1.0.0",
            config: { model: "test-model" },
          },
          custom: {},
        },
      },
    ],
    fallbackChain: [],
    routingBindings: [],
  };

  controlPlane.createDraft(draftSpec);

  const report = controlPlane.validateDraft(draftId);

  // There should be no workloop-not-found issues
  const wlIssues = report.issues.filter((i) => i.code === "workloop-not-found");
  assert.equal(wlIssues.length, 0, `unexpected workloop-not-found issues: ${JSON.stringify(wlIssues)}`);

  // The only expected issue is empty agentIds check — our agent has an id, so it should be ok.
  // But validateDraft may still have other non-blocking issues.
  // The key assertion: no workloop-not-found
});

test("draft validation fails when agent references unregistered workloop", () => {
  const db = new DatabaseSync(":memory:");
  const rt = createExperimentRuntime(db, {
    model: fakeModel(),
    tools: fakeTools(),
    artifacts: fakeArtifacts(),
  });

  // Do NOT register budgeted-history — leave it missing
  rt.core.definitions.register(testSchedulerDef());

  const controlPlane = new ControlPlane(
    rt.core.definitions,
    rt.core.repository,
    rt.core.events,
  );

  const draftId = "draft-2";
  const draftSpec: SchedulerInstanceDraftSpec = {
    id: draftId,
    schedulerDefinition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
    agents: [
      {
        id: "agent-missing",
        definition: {
          standard: {
            name: "missing-loop-agent",
            capabilities: [],
            executionKind: "execute",
            labels: {},
          },
          workLoop: {
            id: "budgeted-history",
            version: "1.0.0",
            config: { model: "test-model" },
          },
          custom: {},
        },
      },
    ],
    fallbackChain: [],
    routingBindings: [],
  };

  controlPlane.createDraft(draftSpec);

  const report = controlPlane.validateDraft(draftId);

  // Must find workloop-not-found issue
  const wlIssues = report.issues.filter((i) => i.code === "workloop-not-found");
  assert.ok(wlIssues.length > 0, "expected workloop-not-found issue when definition not registered");
  assert.ok(wlIssues[0].message.includes("budgeted-history"), "issue should mention budgeted-history");
});

// ═══════════════════════════════════════════════════════════════════
// BUDGETED_HISTORY_DEFINITION constant shape
// ═══════════════════════════════════════════════════════════════════

test("BUDGETED_HISTORY_DEFINITION has correct shape", () => {
  assert.equal(BUDGETED_HISTORY_DEFINITION.kind, "workloop");
  assert.equal(BUDGETED_HISTORY_DEFINITION.id, "budgeted-history");
  assert.equal(BUDGETED_HISTORY_DEFINITION.version, "1.0.0");
  assert.equal(typeof BUDGETED_HISTORY_DEFINITION.sdkVersionRange, "string");
  assert.ok(typeof BUDGETED_HISTORY_DEFINITION.configSchema === "object" && BUDGETED_HISTORY_DEFINITION.configSchema !== null);
  assert.ok(Array.isArray(BUDGETED_HISTORY_DEFINITION.requiredCapabilities));
  assert.ok(Array.isArray(BUDGETED_HISTORY_DEFINITION.cloneModes));
  assert.ok(BUDGETED_HISTORY_DEFINITION.cloneModes.length > 0);
  assert.ok(BUDGETED_HISTORY_DEFINITION.cloneModes.includes("fresh"));
});
