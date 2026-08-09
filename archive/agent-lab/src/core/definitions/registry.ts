import type { DefinitionKind, DefinitionRef, DefinitionSummary, LabDefinition } from "../contracts.ts";

function keyOf(ref: DefinitionRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}`;
}

function cloneDefinition<T extends LabDefinition>(definition: T): T {
  if (definition.kind === "scheduler") {
    const { validateParameters, validateAgentDefinition, validateTransition, ...serializable } = definition;
    return deepFreeze({
      ...structuredClone(serializable),
      validateParameters,
      validateAgentDefinition,
      validateTransition,
    }) as T;
  }
  return deepFreeze(structuredClone(definition));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export class DefinitionConflictError extends Error {}
export class DefinitionNotFoundError extends Error {}

export class DefinitionRegistry {
  private readonly definitions = new Map<string, LabDefinition>();

  register(definition: LabDefinition): void {
    const ref: DefinitionRef = { kind: definition.kind, id: definition.id, version: definition.version };
    const key = keyOf(ref);
    if (this.definitions.has(key)) throw new DefinitionConflictError(`definition already registered: ${definition.kind}/${definition.id}@${definition.version}`);
    this.definitions.set(key, cloneDefinition(definition));
  }

  resolve(ref: DefinitionRef): LabDefinition | undefined {
    return this.definitions.get(keyOf(ref));
  }

  require(ref: DefinitionRef): LabDefinition {
    const definition = this.resolve(ref);
    if (!definition) throw new DefinitionNotFoundError(`definition not found: ${ref.kind}/${ref.id}@${ref.version}`);
    return definition;
  }

  list(kind?: DefinitionKind): DefinitionSummary[] {
    return [...this.definitions.values()]
      .filter((definition) => !kind || definition.kind === kind)
      .map((definition) => ({ kind: definition.kind, id: definition.id, version: definition.version, sdkVersionRange: definition.sdkVersionRange }))
      .sort((a, b) => `${a.kind}/${a.id}@${a.version}`.localeCompare(`${b.kind}/${b.id}@${b.version}`));
  }
}