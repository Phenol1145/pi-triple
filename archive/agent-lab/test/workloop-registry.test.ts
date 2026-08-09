import { test } from "node:test";
import assert from "node:assert/strict";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { WorkLoopRegistry, WorkLoopImplementationConflictError, WorkLoopImplementationNotFoundError } from "../src/workloop/registry.ts";
import type { WorkLoopDefinition } from "../src/core/contracts.ts";
import type { WorkLoopImplementation, WorkLoopInput, WorkLoopResult, WorkLoopSDK } from "../src/workloop/contracts.ts";

function workLoopDef(overrides: Partial<WorkLoopDefinition> = {}): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: "test-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh"],
    ...overrides,
  };
}

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
    run: async (_input: WorkLoopInput, _sdk: WorkLoopSDK): Promise<WorkLoopResult> => {
      return {
        status: "completed",
        context: {
          messages: [],
          metadata: { contextId: "ctx-1", sourceRefs: [], artifactRefs: [] },
        },
        state: {},
      };
    },
  };
}

test("registration succeeds when matching workloop definition exists", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(workLoopDef());

  const registry = new WorkLoopRegistry(definitions);
  assert.doesNotThrow(() => registry.register(noopImpl()));
});

test("registration throws typed NotFound when no definition stored", () => {
  const definitions = new DefinitionRegistry();
  const registry = new WorkLoopRegistry(definitions);

  assert.throws(
    () => registry.register(noopImpl()),
    WorkLoopImplementationNotFoundError,
  );
});

test("registration throws typed NotFound when definition exists but with different kind", () => {
  const definitions = new DefinitionRegistry();
  definitions.register({
    kind: "scheduler",
    id: "test-loop",
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
  });

  const registry = new WorkLoopRegistry(definitions);

  assert.throws(
    () => registry.register(noopImpl()),
    WorkLoopImplementationNotFoundError,
  );
});

test("registering the same implementation twice throws typed conflict", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(workLoopDef());

  const registry = new WorkLoopRegistry(definitions);
  registry.register(noopImpl());

  assert.throws(
    () => registry.register(noopImpl()),
    WorkLoopImplementationConflictError,
  );
});

test("registration with mismatched cloneModes throws typed conflict", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(workLoopDef({ cloneModes: ["clone", "fresh"] }));

  const registry = new WorkLoopRegistry(definitions);

  assert.throws(
    () => registry.register(noopImpl("test-loop", "1.0.0", ["fresh"])),
    { message: /workloop implementation does not match definition clone modes/ },
  );
});

test("registration with sorted cloneModes matching sorted definition cloneModes succeeds", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(workLoopDef({ cloneModes: ["fresh", "clone"] }));

  const registry = new WorkLoopRegistry(definitions);

  assert.doesNotThrow(() =>
    registry.register(noopImpl("test-loop", "1.0.0", ["clone", "fresh"])),
  );
});

test("require returns a frozen implementation", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(workLoopDef());

  const registry = new WorkLoopRegistry(definitions);
  registry.register(noopImpl());

  const impl = registry.require("test-loop", "1.0.0");
  assert.equal(impl.id, "test-loop");
  assert.equal(impl.version, "1.0.0");
  assert.ok(Object.isFrozen(impl));
});

test("require throws typed not-found for missing id/version", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(workLoopDef());

  const registry = new WorkLoopRegistry(definitions);

  assert.throws(
    () => registry.require("missing-loop", "1.0.0"),
    WorkLoopImplementationNotFoundError,
  );
});

test("register does not alter the P1 DefinitionRegistry", () => {
  const definitions = new DefinitionRegistry();
  definitions.register(workLoopDef());

  const registry = new WorkLoopRegistry(definitions);
  registry.register(noopImpl());

  // DefinitionRegistry should still have the original definition, not the implementation
  const def = definitions.require({ kind: "workloop", id: "test-loop", version: "1.0.0" });
  assert.ok(!("run" in def));
  assert.equal(def.kind, "workloop");
});
