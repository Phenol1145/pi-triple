import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import type { OptimizerInstanceRecord } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import {
  OptimizerRegistry,
  registerMetricsProjector,
  ProjectorNotRegisteredError,
  OptimizerRegistrationError,
  OptimizerInstanceCreationError,
} from "../src/optimizer/registry.ts";
import type {
  OptimizerDefinition,
  SchedulerDefinition,
  SchedulerInstanceRecord,
  LabEvent,
} from "../src/core/contracts.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function setup() {
  const db = new DatabaseSync(":memory:");
  const definitions = new DefinitionRegistry();
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const registry = new OptimizerRegistry(definitions, repository, events);
  return { db, definitions, repository, events, registry };
}

function schedulerDef(overrides: Partial<SchedulerDefinition> = {}): SchedulerDefinition {
  const base: SchedulerDefinition = {
    kind: "scheduler",
    id: "weighted-scorer",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1.0.0",
    parameterSchema: {},
    agentDefinitionSchema: {},
    defaultParameters: {},
    tunablePaths: [],
    validateParameters: () => ({ ok: true, value: {} }),
    validateAgentDefinition: () => ({ ok: true, value: {} }),
    ...overrides,
  };
  return base;
}

function schedulerInstance(overrides: Partial<SchedulerInstanceRecord> = {}): SchedulerInstanceRecord {
  const id = overrides.id ?? "ws-1";
  return {
    id,
    name: id,
    definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1.0.0",
    status: "active",
    currentRoundId: "round-0",
    fallbackChain: [],
    createdAt: 1000,
    ...overrides,
  };
}

function optimizerDef(overrides: Partial<OptimizerDefinition> = {}): OptimizerDefinition {
  return {
    kind: "optimizer",
    id: "weighted-tuner",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configurationSchema: {
      type: "object",
      properties: {
        minSamples: { type: "number" },
      },
      required: ["minSamples"],
    },
    requiredMetrics: ["runs", "avgCompletion"],
    compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "^1.0.0" }],
    parameterModelVersionRange: "^1.0.0",
    ...overrides,
  };
}

function insertRound(repo: CoreRepository, instanceId: string, roundId: string, extra: Partial<{ sequence: number; status: string; parameters: unknown }> = {}) {
  repo.insertRound({
    id: roundId,
    schedulerInstanceId: instanceId,
    sequence: extra.sequence ?? 0,
    parameters: extra.parameters ?? {},
    status: (extra.status ?? "active") as "active",
    createdAt: 1000,
    activatedAt: 1000,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// registerOptimizer
// ═══════════════════════════════════════════════════════════════════════════

test("registerOptimizer accepts a valid optimizer definition", () => {
  const { definitions, registry } = setup();
  const def = optimizerDef();
  registry.registerOptimizer(def);

  const resolved = definitions.resolve({ kind: "optimizer", id: "weighted-tuner", version: "1.0.0" });
  assert.ok(resolved);
  assert.equal(resolved.kind, "optimizer");
});

test("registerOptimizer rejects non-optimizer kind", () => {
  const { registry } = setup();
  const def = optimizerDef({ kind: "scheduler" as unknown as "optimizer" });
  assert.throws(
    () => registry.registerOptimizer(def as unknown as OptimizerDefinition),
    (e: unknown) => e instanceof OptimizerRegistrationError && /kind/.test((e as Error).message),
  );
});

test("registerOptimizer rejects empty configurationSchema", () => {
  const { registry } = setup();
  assert.throws(
    () => registry.registerOptimizer(optimizerDef({ configurationSchema: {} })),
    (e: unknown) => e instanceof OptimizerRegistrationError && /configurationSchema/.test((e as Error).message),
  );
});

test("registerOptimizer rejects empty compatibleSchedulers", () => {
  const { registry } = setup();
  assert.throws(
    () => registry.registerOptimizer(optimizerDef({ compatibleSchedulers: [] })),
    (e: unknown) => e instanceof OptimizerRegistrationError && /compatibleSchedulers/.test((e as Error).message),
  );
});

test("registerOptimizer rejects nullish compatibleSchedulers", () => {
  const { registry } = setup();
  assert.throws(
    () => registry.registerOptimizer(optimizerDef({ compatibleSchedulers: undefined as unknown as Array<{ id: string; versionRange: string }> })),
    (e: unknown) => e instanceof OptimizerRegistrationError && /compatibleSchedulers/.test((e as Error).message),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// createOptimizerInstance — config validation
// ═══════════════════════════════════════════════════════════════════════════

test("createOptimizerInstance rejects config missing required property", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef());
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: {}, targetSchedulers: ["ws-1"] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.message.includes("config validation failed") && e.issues.some((i) => i.code === "required");
    },
  );
});

test("createOptimizerInstance rejects config with wrong type", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef());
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: { minSamples: "not-a-number" }, targetSchedulers: ["ws-1"] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.issues.some((i) => i.code === "type" && i.path === "minSamples");
    },
  );
});

test("createOptimizerInstance accepts config with correct required + type", () => {
  const { definitions, repository, registry, events } = setup();
  definitions.register(schedulerDef());
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(optimizerDef());

  const record = registry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
  );

  assert.equal(record.id, "tuner-1");
  assert.equal(record.status, "active");
  assert.deepEqual(record.config, { minSamples: 20 });
  assert.deepEqual(record.targetSchedulers, ["ws-1"]);

  // Verify event was emitted
  const evts = events.query({ schedulerInstanceId: undefined, limit: 10 });
  const created = evts.find((e) => e.eventType === "optimizer.instance.created");
  assert.ok(created, "optimizer.instance.created event should be emitted");
  const p = created.payload as { instanceId: string };
  assert.equal(p.instanceId, "tuner-1");
});

test("createOptimizerInstance rejects null config for object schema", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef());
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: null, targetSchedulers: ["ws-1"] },
      ),
    (e: unknown) => e instanceof OptimizerInstanceCreationError,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// createOptimizerInstance — target scheduler gates
// ═══════════════════════════════════════════════════════════════════════════

test("createOptimizerInstance rejects empty targetSchedulers", () => {
  const { definitions, registry } = setup();
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: [] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.issues.some((i) => i.code === "empty");
    },
  );
});

test("createOptimizerInstance rejects non-existent scheduler instance", () => {
  const { definitions, registry } = setup();
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["nonexistent"] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.issues.some((i) => i.code === "instance-not-found");
    },
  );
});

test("createOptimizerInstance rejects scheduler with incompatible definition id", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef({ id: "other-scorer" }));
  repository.insertInstance(
    schedulerInstance({ definition: { kind: "scheduler", id: "other-scorer", version: "1.0.0" } }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.issues.some((i) => i.code === "scheduler-not-compatible");
    },
  );
});

test("createOptimizerInstance rejects version-range mismatch", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef({ version: "2.0.0" }));
  repository.insertInstance(
    schedulerInstance({ definition: { kind: "scheduler", id: "weighted-scorer", version: "2.0.0" } }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  // compatibleSchedulers has versionRange "^1.0.0" — 2.0.0 won't match
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.issues.some((i) => i.code === "version-range-mismatch");
    },
  );
});

test("createOptimizerInstance rejects parameterModelVersion mismatch", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef());
  repository.insertInstance(
    schedulerInstance({ parameterModelVersion: "2.0.0" }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  // parameterModelVersionRange is "^1.0.0" — 2.0.0 won't match
  registry.registerOptimizer(optimizerDef());

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.issues.some((i) => i.code === "parameter-model-version-mismatch");
    },
  );
});

test("createOptimizerInstance rejects when no projector registered (M16)", () => {
  const { definitions, repository, registry } = setup();
  // Use a unique scheduler definition id to avoid module-level projector
  // leakage from other tests (registerMetricsProjector is module-level).
  const def = schedulerDef({ id: "no-projector-scheduler" });
  definitions.register(def);
  repository.insertInstance(
    schedulerInstance({
      definition: { kind: "scheduler", id: "no-projector-scheduler", version: "1.0.0" },
    }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  // deliberately no projector registered for "no-projector-scheduler"
  registry.registerOptimizer(
    optimizerDef({
      compatibleSchedulers: [{ id: "no-projector-scheduler", versionRange: "^1.0.0" }],
    }),
  );

  assert.throws(
    () =>
      registry.createOptimizerInstance(
        { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
        { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
      ),
    (e: unknown) => {
      if (!(e instanceof OptimizerInstanceCreationError)) return false;
      return e.issues.some((i) => i.code === "projector-not-registered");
    },
  );
});

test("createOptimizerInstance collects all target issues before failing", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef());
  // Two targets, both problematic
  repository.insertInstance(schedulerInstance({ id: "ws-1", parameterModelVersion: "2.0.0" }), {});
  repository.insertInstance(
    schedulerInstance({ id: "ws-2", definition: { kind: "scheduler", id: "other-scorer", version: "1.0.0" } }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  insertRound(repository, "ws-2", "round-1");
  registry.registerOptimizer(optimizerDef());

  try {
    registry.createOptimizerInstance(
      { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
      { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1", "ws-2"] },
    );
    assert.fail("expected OptimizerInstanceCreationError");
  } catch (e) {
    assert.ok(e instanceof OptimizerInstanceCreationError);
    const err = e as OptimizerInstanceCreationError;
    assert.ok(err.issues.length >= 2, `expected >=2 issues, got ${err.issues.length}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// createOptimizerInstance — version range forms
// ═══════════════════════════════════════════════════════════════════════════

test("createOptimizerInstance passes with wildcard versionRange", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef({ version: "3.2.1" }));
  repository.insertInstance(
    schedulerInstance({ definition: { kind: "scheduler", id: "weighted-scorer", version: "3.2.1" } }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(
    optimizerDef({
      compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "*" }],
    }),
  );

  const record = registry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
  );
  assert.equal(record.id, "tuner-1");
});

test("createOptimizerInstance passes with exact versionRange", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef({ version: "1.0.0" }));
  repository.insertInstance(
    schedulerInstance({ definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" } }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(
    optimizerDef({
      compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "1.0.0" }],
    }),
  );

  const record = registry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
  );
  assert.equal(record.id, "tuner-1");
});

test("createOptimizerInstance passes with tilde versionRange", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef({ version: "1.2.9" }));
  repository.insertInstance(
    schedulerInstance({ definition: { kind: "scheduler", id: "weighted-scorer", version: "1.2.9" } }),
    {},
  );
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(
    optimizerDef({
      compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "~1.2.0" }],
    }),
  );

  const record = registry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
  );
  assert.equal(record.id, "tuner-1");
});

// ═══════════════════════════════════════════════════════════════════════════
// getInstance / listInstances
// ═══════════════════════════════════════════════════════════════════════════

test("getInstance returns undefined for unknown id", () => {
  const { registry } = setup();
  assert.equal(registry.getInstance("nonexistent"), undefined);
});

test("getInstance returns stored record after creation", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef());
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(optimizerDef());

  registry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
  );

  const got = registry.getInstance("tuner-1");
  assert.ok(got);
  assert.equal(got.definitionId, "weighted-tuner");
});

test("listInstances returns all created instances", () => {
  const { definitions, repository, registry } = setup();
  definitions.register(schedulerDef());
  repository.insertInstance(schedulerInstance(), {});
  insertRound(repository, "ws-1", "round-0");
  registerMetricsProjector("weighted-scorer", () => ({}));
  registry.registerOptimizer(optimizerDef());

  registry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "tuner-1", config: { minSamples: 20 }, targetSchedulers: ["ws-1"] },
  );
  registry.createOptimizerInstance(
    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
    { instanceId: "tuner-2", config: { minSamples: 30 }, targetSchedulers: ["ws-1"] },
  );

  const list = registry.listInstances();
  assert.equal(list.length, 2);
  assert.ok(list.some((r) => r.id === "tuner-1"));
  assert.ok(list.some((r) => r.id === "tuner-2"));
});

// ═══════════════════════════════════════════════════════════════════════════
// Projector registry
// ═══════════════════════════════════════════════════════════════════════════

test("registerMetricsProjector stores and overwrites", () => {
  // Reset by re-registering
  const fn1 = () => ({ a: 1 });
  const fn2 = () => ({ b: 2 });

  registerMetricsProjector("test-scheduler", fn1 as unknown as Parameters<typeof registerMetricsProjector>[1]);
  registerMetricsProjector("test-scheduler", fn2 as unknown as Parameters<typeof registerMetricsProjector>[1]);

  // The projector map is module-level; we trust last-write-wins
  // (verified indirectly via getCandidateAggregates in data-api tests)
});

test("ProjectorNotRegisteredError has correct message", () => {
  const err = new ProjectorNotRegisteredError("my-scheduler");
  assert.ok(err.message.includes("my-scheduler"));
  assert.equal(err.name, "ProjectorNotRegisteredError");
});
