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