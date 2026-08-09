import type { DatabaseSync } from "node:sqlite";
import type {
  DefinitionRef,
  JsonSchema,
  OptimizerDefinition,
  ValidationIssue,
  ValidationResult,
} from "../core/contracts.ts";
import { DefinitionRegistry } from "../core/definitions/registry.ts";
import type { CoreRepository, OptimizerInstanceRecord } from "../core/storage/repository.ts";
import type { EventLog } from "../core/events/event-log.ts";
import { matchesVersionRange } from "../core/version-range.ts";
import type { MetricsProjector } from "./contracts.ts";

// ── Errors ──────────────────────────────────────────────────────────────────

export class ProjectorNotRegisteredError extends Error {
  constructor(schedulerDefinitionId: string) {
    super(`no metrics projector registered for scheduler definition "${schedulerDefinitionId}"`);
    this.name = "ProjectorNotRegisteredError";
  }
}

export class OptimizerRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizerRegistrationError";
  }
}

export class OptimizerInstanceCreationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "OptimizerInstanceCreationError";
    this.issues = issues;
  }
}

// ── Projector registry (module-level) ───────────────────────────────────────

const projectors = new Map<string, MetricsProjector>();

/**
 * Register a metrics projector for a scheduler definition.
 *
 * Only one projector per definition id is allowed; re-registration
 * overwrites silently (last-write-wins).
 */
export function registerMetricsProjector(
  schedulerDefinitionId: string,
  projector: MetricsProjector,
): void {
  projectors.set(schedulerDefinitionId, projector);
}

/** @internal exported for DataAPI use */
export function getProjector(
  schedulerDefinitionId: string,
): MetricsProjector | undefined {
  return projectors.get(schedulerDefinitionId);
}

// ── Minimal JSON Schema config validator ────────────────────────────────────

/**
 * Validate `config` against a JSON Schema (minimal `type`/`required`/`properties` subset).
 *
 * Supported:
 *  - root `type: "object"`
 *  - `properties` with per-property `type` (`"string"`, `"number"`, `"boolean"`)
 *  - `required` array
 *  - `additionalProperties` is ignored (open by default)
 *
 * Unsupported schema constructs are **silently ignored** — they do not
 * cause errors, but also do not enforce constraints.
 */
function validateConfigAgainstSchema(
  config: unknown,
  schema: JsonSchema,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (schema.type !== "object") {
    // Non-object root type — skip detailed validation, just check typeof
    const expected = schema.type;
    if (typeof config !== expected) {
      issues.push({
        path: "",
        code: "type",
        message: `expected ${expected}, got ${typeof config}`,
      });
    }
    return issues.length === 0 ? { ok: true, value: config } : { ok: false, issues };
  }

  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    issues.push({
      path: "",
      code: "type",
      message: `expected object, got ${config === null ? "null" : typeof config}`,
    });
    return { ok: false, issues };
  }

  const obj = config as Record<string, unknown>;

  // Required properties
  const required: string[] = (schema.required as string[]) ?? [];
  for (const prop of required) {
    if (!(prop in obj)) {
      issues.push({
        path: prop,
        code: "required",
        message: `missing required property: ${prop}`,
      });
    }
  }

  // Property type checks
  const properties = (schema.properties as Record<string, { type?: string }>) ?? {};
  for (const [prop, propSchema] of Object.entries(properties)) {
    const value = obj[prop];
    if (value === undefined) continue; // missing optional prop is fine

    const expectedType = propSchema.type;
    if (!expectedType) continue; // no type constraint → skip

    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== expectedType) {
      issues.push({
        path: prop,
        code: "type",
        message: `expected ${expectedType}, got ${actualType}`,
      });
    }
  }

  return issues.length === 0 ? { ok: true, value: config } : { ok: false, issues };
}

// ── Registry ────────────────────────────────────────────────────────────────

export class OptimizerRegistry {
  private readonly definitions: DefinitionRegistry;
  private readonly repository: CoreRepository;
  private readonly events: EventLog;

  constructor(
    definitions: DefinitionRegistry,
    repository: CoreRepository,
    events: EventLog,
  ) {
    this.definitions = definitions;
    this.repository = repository;
    this.events = events;
  }

  /**
   * Register an optimizer definition.
   *
   * Validates:
   *  - `kind === "optimizer"`
   *  - `configurationSchema` is present
   *  - `compatibleSchedulers` is non-empty
   *
   * @throws {OptimizerRegistrationError} on validation failure.
   */
  registerOptimizer(definition: OptimizerDefinition): void {
    if (definition.kind !== "optimizer") {
      throw new OptimizerRegistrationError(
        `expected kind "optimizer", got "${definition.kind}"`,
      );
    }
    if (!definition.configurationSchema || Object.keys(definition.configurationSchema).length === 0) {
      throw new OptimizerRegistrationError(
        `configurationSchema must be non-empty for optimizer "${definition.id}"`,
      );
    }
    if (
      !definition.compatibleSchedulers ||
      definition.compatibleSchedulers.length === 0
    ) {
      throw new OptimizerRegistrationError(
        `compatibleSchedulers must be non-empty for optimizer "${definition.id}"`,
      );
    }
    this.definitions.register(definition);
  }

  /**
   * Create a persisted optimizer instance after running all compatibility gates.
   *
   * Gates (in order):
   *  1. Optimizer definition exists and is resolvable.
   *  2. `config` passes {@link OptimizerDefinition.configurationSchema} validation.
   *  3. For every `targetSchedulers` entry:
   *     a. Scheduler instance exists in the repository.
   *     b. A matching `compatibleSchedulers` entry exists (by id).
   *     c. The scheduler instance version satisfies the `versionRange`.
   *     d. The scheduler instance `parameterModelVersion` satisfies the
   *        optimizer's `parameterModelVersionRange`.
   *     e. A metrics projector is registered for that scheduler definition id (M16).
   *
   * On success, the instance record is persisted and
   * `optimizer.instance.created` is emitted.
   *
   * @returns The persisted {@link OptimizerInstanceRecord}.
   * @throws {OptimizerInstanceCreationError} on any gate failure.
   */
  createOptimizerInstance(
    definitionRef: DefinitionRef,
    opts: {
      instanceId: string;
      config: unknown;
      targetSchedulers: string[];
    },
  ): OptimizerInstanceRecord {
    const def = this.definitions.require(definitionRef) as OptimizerDefinition;
    if (def.kind !== "optimizer") {
      throw new OptimizerInstanceCreationError(
        `definition "${definitionRef.id}@${definitionRef.version}" is not an optimizer (kind: ${def.kind})`,
      );
    }

    // Gate 2 — config schema
    const configResult = validateConfigAgainstSchema(opts.config, def.configurationSchema);
    if (!configResult.ok) {
      throw new OptimizerInstanceCreationError(
        `config validation failed for optimizer "${definitionRef.id}"`,
        configResult.issues,
      );
    }

    // Gate 3 — per-target compatibility checks
    const issues: ValidationIssue[] = [];

    if (opts.targetSchedulers.length === 0) {
      issues.push({
        path: "targetSchedulers",
        code: "empty",
        message: "targetSchedulers must be non-empty",
      });
    }

    for (const sid of opts.targetSchedulers) {
      const instance = this.repository.getInstance(sid);
      if (!instance) {
        issues.push({
          path: `targetSchedulers.${sid}`,
          code: "instance-not-found",
          message: `scheduler instance "${sid}" not found`,
        });
        continue;
      }

      // Find matching compatibleSchedulers entry
      const compat = def.compatibleSchedulers.find((c) => c.id === instance.definition.id);
      if (!compat) {
        issues.push({
          path: `targetSchedulers.${sid}`,
          code: "scheduler-not-compatible",
          message: `scheduler definition "${instance.definition.id}" not in optimizer compatibleSchedulers`,
        });
        continue;
      }

      // Version range check
      try {
        if (!matchesVersionRange(instance.definition.version, compat.versionRange)) {
          issues.push({
            path: `targetSchedulers.${sid}`,
            code: "version-range-mismatch",
            message: `scheduler version "${instance.definition.version}" does not satisfy range "${compat.versionRange}"`,
          });
        }
      } catch (e) {
        issues.push({
          path: `targetSchedulers.${sid}`,
          code: "version-range-error",
          message: e instanceof Error ? e.message : String(e),
        });
      }

      // parameterModelVersion range check
      try {
        if (!matchesVersionRange(instance.parameterModelVersion, def.parameterModelVersionRange)) {
          issues.push({
            path: `targetSchedulers.${sid}`,
            code: "parameter-model-version-mismatch",
            message: `instance parameterModelVersion "${instance.parameterModelVersion}" does not satisfy optimizer range "${def.parameterModelVersionRange}"`,
          });
        }
      } catch (e) {
        issues.push({
          path: `targetSchedulers.${sid}`,
          code: "parameter-model-version-error",
          message: e instanceof Error ? e.message : String(e),
        });
      }

      // Projector registered (M16)
      if (!getProjector(instance.definition.id)) {
        issues.push({
          path: `targetSchedulers.${sid}`,
          code: "projector-not-registered",
          message: `no metrics projector registered for scheduler definition "${instance.definition.id}"`,
        });
      }
    }

    if (issues.length > 0) {
      throw new OptimizerInstanceCreationError(
        `cannot create optimizer instance "${opts.instanceId}": ${issues.length} issue(s)`,
        issues,
      );
    }

    // Persist
    const now = Date.now();
    const record: OptimizerInstanceRecord = {
      id: opts.instanceId,
      name: opts.instanceId,
      definitionId: definitionRef.id,
      definitionVersion: definitionRef.version,
      config: opts.config,
      targetSchedulers: opts.targetSchedulers,
      status: "active",
      createdAt: now,
    };

    this.repository.insertOptimizerInstance(record);

    // Emit event
    this.events.append({
      eventId: `optimizer.instance.created:${opts.instanceId}`,
      eventType: "optimizer.instance.created",
      schemaVersion: "1",
      timestamp: now,
      identity: {
        traceId: `optimizer:${opts.instanceId}`,
        optimizerInstanceId: opts.instanceId,
        schedulerDefinitionId: definitionRef.id,
        schedulerDefinitionVersion: definitionRef.version,
      },
      payload: {
        instanceId: opts.instanceId,
        definitionId: definitionRef.id,
        definitionVersion: definitionRef.version,
        targetSchedulers: opts.targetSchedulers,
      },
    });

    return record;
  }

  /** Return the persisted record for an optimizer instance. */
  getInstance(instanceId: string): OptimizerInstanceRecord | undefined {
    return this.repository.getOptimizerInstance(instanceId);
  }

  /** List all persisted optimizer instances. */
  listInstances(): OptimizerInstanceRecord[] {
    return this.repository.listOptimizerInstances();
  }
}
