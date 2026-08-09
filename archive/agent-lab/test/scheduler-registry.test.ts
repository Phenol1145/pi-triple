import { test } from "node:test";
import assert from "node:assert/strict";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import {
  SchedulerRegistry,
  SchedulerImplementationConflictError,
  SchedulerImplementationNotFoundError,
} from "../src/scheduler/registry.ts";
import type { SchedulerDefinition } from "../src/core/contracts.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulingResult,
  SchedulerSDK,
} from "../src/scheduler/contracts.ts";

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
    defaultParameters: {},
    tunablePaths: [],
    validateParameters: () => ({ ok: true as const, value: {} }),
    validateAgentDefinition: () => ({ ok: true as const, value: {} }),
    ...overrides,
  };
}

function noopImpl(
  id = "test-scheduler",
  version = "1.0.0",
): SchedulerImplementation {
  return {
    id,
    version,
    schedule: async (
      _input: SchedulingInput,
      _parameters: Readonly<unknown>,
      _sdk: SchedulerSDK,
    ): Promise<SchedulingResult> => {
      return { status: "completed", reason: "noop" };
    },
  };
}

test("register(impl) succeeds when matching scheduler definition exists", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const registry = new SchedulerRegistry(definitions);
  assert.doesNotThrow(() => registry.register(noopImpl()));
});

test("register throws typed SchedulerImplementationNotFoundError when no definition stored", () => {
  const definitions = new DefinitionRegistry();
  const registry = new SchedulerRegistry(definitions);

  assert.throws(
    () => registry.register(noopImpl()),
    SchedulerImplementationNotFoundError,
  );
});

test("register throws typed not-found when definition exists but with different kind", () => {
  const definitions = new DefinitionRegistry();
  definitions.register({
    kind: "workloop",
    id: "test-scheduler",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
  });

  const registry = new SchedulerRegistry(definitions);

  assert.throws(
    () => registry.register(noopImpl()),
    SchedulerImplementationNotFoundError,
  );
});

test("registering the same implementation twice throws typed conflict", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const registry = new SchedulerRegistry(definitions);
  registry.register(noopImpl());

  assert.throws(
    () => registry.register(noopImpl()),
    SchedulerImplementationConflictError,
  );
});

test("require returns a frozen implementation", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const registry = new SchedulerRegistry(definitions);
  registry.register(noopImpl());

  const impl = registry.require("test-scheduler", "1.0.0");
  assert.equal(impl.id, "test-scheduler");
  assert.equal(impl.version, "1.0.0");
  assert.ok(Object.isFrozen(impl));
});

test("require throws typed not-found for missing id/version", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const registry = new SchedulerRegistry(definitions);

  assert.throws(
    () => registry.require("missing-scheduler", "1.0.0"),
    SchedulerImplementationNotFoundError,
  );
});

test("register does not alter the P1 DefinitionRegistry", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const registry = new SchedulerRegistry(definitions);
  registry.register(noopImpl());

  // DefinitionRegistry should still have the original definition, not the implementation
  const def = definitions.require({
    kind: "scheduler",
    id: "test-scheduler",
    version: "1.0.0",
  });
  assert.ok(!("schedule" in def));
  assert.equal(def.kind, "scheduler");
});
