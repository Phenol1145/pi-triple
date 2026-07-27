import type { DefinitionRef, SchedulerDefinition } from "../core/contracts.ts";
import type { DefinitionRegistry } from "../core/definitions/registry.ts";
import { DefinitionNotFoundError } from "../core/definitions/registry.ts";
import type { SchedulerImplementation } from "./contracts.ts";

export class SchedulerImplementationConflictError extends Error {}
export class SchedulerImplementationNotFoundError extends Error {}

function keyOf(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

export class SchedulerRegistry {
  private readonly definitions: DefinitionRegistry;
  private readonly implementations = new Map<string, SchedulerImplementation>();

  constructor(definitions: DefinitionRegistry) {
    this.definitions = definitions;
  }

  register(implementation: SchedulerImplementation): void {
    const ref: DefinitionRef = {
      kind: "scheduler",
      id: implementation.id,
      version: implementation.version,
    };

    let definition: SchedulerDefinition;
    try {
      definition = this.definitions.require(ref) as SchedulerDefinition;
    } catch (err) {
      if (err instanceof DefinitionNotFoundError) {
        throw new SchedulerImplementationNotFoundError(
          `scheduler implementation definition not found: ${implementation.id}@${implementation.version}`,
        );
      }
      throw err;
    }

    // Verify kind is exactly "scheduler" (caught by require, but double-check)
    if (definition.kind !== "scheduler") {
      throw new SchedulerImplementationNotFoundError(
        `scheduler implementation definition not found: ${implementation.id}@${implementation.version}`,
      );
    }

    const key = keyOf(implementation.id, implementation.version);
    if (this.implementations.has(key)) {
      throw new SchedulerImplementationConflictError(
        `implementation already registered: ${implementation.id}@${implementation.version}`,
      );
    }

    // Shallow-freeze the implementation so callers cannot mutate it
    this.implementations.set(key, Object.freeze({ ...implementation }));
  }

  require(id: string, version: string): SchedulerImplementation {
    const impl = this.implementations.get(keyOf(id, version));
    if (!impl) {
      throw new SchedulerImplementationNotFoundError(
        `implementation not found: ${id}@${version}`,
      );
    }
    return impl;
  }
}
