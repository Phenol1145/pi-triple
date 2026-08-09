import type { DefinitionRef, WorkLoopDefinition } from "../core/contracts.ts";
import type { DefinitionRegistry } from "../core/definitions/registry.ts";
import { DefinitionNotFoundError } from "../core/definitions/registry.ts";
import type { WorkLoopImplementation } from "./contracts.ts";

export class WorkLoopImplementationConflictError extends Error {}
export class WorkLoopImplementationNotFoundError extends Error {}

function keyOf(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

export class WorkLoopRegistry {
  private readonly definitions: DefinitionRegistry;
  private readonly implementations = new Map<string, WorkLoopImplementation>();

  constructor(definitions: DefinitionRegistry) {
    this.definitions = definitions;
  }

  register(implementation: WorkLoopImplementation): void {
    const ref: DefinitionRef = {
      kind: "workloop",
      id: implementation.id,
      version: implementation.version,
    };

    let definition: WorkLoopDefinition;
    try {
      definition = this.definitions.require(ref) as WorkLoopDefinition;
    } catch (err) {
      if (err instanceof DefinitionNotFoundError) {
        throw new WorkLoopImplementationNotFoundError(
          `workloop implementation definition not found: ${implementation.id}@${implementation.version}`,
        );
      }
      throw err;
    }

    // Verify that exactly the same cloneModes exist (order-independent via sorted compare)
    const expectedModes = [...definition.cloneModes].sort();
    const actualModes = [...implementation.cloneModes].sort();
    if (
      expectedModes.length !== actualModes.length ||
      expectedModes.some((m, i) => m !== actualModes[i])
    ) {
      throw new WorkLoopImplementationConflictError(
        `workloop implementation does not match definition clone modes`,
      );
    }

    const key = keyOf(implementation.id, implementation.version);
    if (this.implementations.has(key)) {
      throw new WorkLoopImplementationConflictError(
        `implementation already registered: ${implementation.id}@${implementation.version}`,
      );
    }

    // Shallow-freeze the implementation so callers cannot mutate it
    this.implementations.set(key, Object.freeze({ ...implementation }));
  }

  require(id: string, version: string): WorkLoopImplementation {
    const impl = this.implementations.get(keyOf(id, version));
    if (!impl) {
      throw new WorkLoopImplementationNotFoundError(
        `implementation not found: ${id}@${version}`,
      );
    }
    return impl;
  }
}
