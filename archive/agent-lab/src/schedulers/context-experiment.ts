/**
 * context-experiment@1.0.0 — execute-only scheduler definition for
 * side-by-side context-strategy comparison experiments.
 *
 * ## Design (D2, D4)
 *
 * - parameterModel: `{ assignments: Array<Assignment> }` where each
 *   Assignment carries a model id, a context strategy, and optional
 *   strategy-specific config.
 * - tunablePaths: `["assignments"]` — the whole assignments array is the
 *   only tunable path (D4).
 * - validateParameters: rejects bad shapes (non-array, empty, missing
 *   fields) and unknown strategy names.
 * - validateTransition: assignments arrays compared as whole leaves;
 *   any change passes structural validation.
 * - select/dispatch: this scheduler is **execute-only**. `select` mode
 *   returns `abstained`. `execute` mode performs a parameterized direct
 *   pick: the caller carries the desired assignment via `input.labels`
 *   (`strategy` → match by strategy name; `assignmentIndex` → numeric
 *   index). Falls back to the first assignment. No scoring.
 *
 * ## Agent ID convention
 *
 * `agent-<model>-<strategy>` where `/` encodes to `__` and other chars outside `[a-zA-Z0-9_-]`
 * are replaced with `-`.
 *
 * @module context-experiment
 */

import type {
  SchedulerDefinition,
  AgentDefinition,
  ValidationResult,
  AgentCreateSpec,
} from "../core/contracts.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulingResult,
  SchedulerSDK,
} from "../scheduler/contracts.ts";
import type { LabCore } from "../core/create-core.ts";

// ── Parameter model ────────────────────────────────────────────────

export type ContextStrategy = "default" | "budgeted-history" | "selective-summary";

export const VALID_STRATEGIES: ReadonlySet<string> = new Set<ContextStrategy>([
  "default",
  "budgeted-history",
  "selective-summary",
]);

/**
 * Strategy → workloop id lookup.
 *
 * - default: pi-default-loop (standard agent loop)
 * - budgeted-history: the P6a budgeted-history managed loop
 * - selective-summary: the P6b selective-summary managed loop (T1)
 */
export const STRATEGY_WORKLOOP_ID: Readonly<Record<ContextStrategy, string>> = {
  default: "pi-default-loop",
  "budgeted-history": "budgeted-history",
  "selective-summary": "selective-summary",
};

export interface Assignment {
  model: string;
  strategy: ContextStrategy;
  strategyConfig?: unknown;
}

export interface ContextExperimentParameters {
  assignments: Assignment[];
}

export const DEFAULT_CONTEXT_EXPERIMENT_PARAMETERS: ContextExperimentParameters = {
  assignments: [],
};

const TUNABLE_PATHS: string[] = ["assignments"];

// ── Validators ─────────────────────────────────────────────────────

export function validateParameters(
  value: unknown,
): ValidationResult<ContextExperimentParameters> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        { path: "", code: "INVALID_TYPE", message: "parameters must be an object" },
      ],
    };
  }

  const obj = value as Record<string, unknown>;
  const issues: Array<{ path: string; code: string; message: string }> = [];

  // Reject unknown keys
  for (const key of Object.keys(obj)) {
    if (key !== "assignments") {
      issues.push({
        path: key,
        code: "UNKNOWN_KEY",
        message: `unknown parameter key: ${key}`,
      });
    }
  }

  // Validate assignments
  if (!Array.isArray(obj.assignments)) {
    issues.push({
      path: "assignments",
      code: "INVALID_TYPE",
      message: "assignments must be an array",
    });
    return { ok: false, issues };
  }

  const seen = new Set<string>();
  for (let i = 0; i < (obj.assignments as unknown[]).length; i++) {
    const item = (obj.assignments as unknown[])[i];
    const base = `assignments.${i}`;

    if (typeof item !== "object" || item === null) {
      issues.push({
        path: base,
        code: "INVALID_TYPE",
        message: `assignments[${i}] must be an object`,
      });
      continue;
    }

    const a = item as Record<string, unknown>;

    // model
    if (typeof a.model !== "string" || a.model.trim().length === 0) {
      issues.push({
        path: `${base}.model`,
        code: "INVALID_TYPE",
        message: `assignments[${i}].model must be a non-empty string`,
      });
    }

    // strategy
    if (typeof a.strategy !== "string" || !VALID_STRATEGIES.has(a.strategy)) {
      issues.push({
        path: `${base}.strategy`,
        code: "INVALID_VALUE",
        message: `assignments[${i}].strategy must be one of: ${[...VALID_STRATEGIES].join(", ")}`,
      });
    }

    // strategyConfig is optional; if present must be object-like
    if (a.strategyConfig !== undefined && (typeof a.strategyConfig !== "object" || a.strategyConfig === null)) {
      issues.push({
        path: `${base}.strategyConfig`,
        code: "INVALID_TYPE",
        message: `assignments[${i}].strategyConfig must be an object if provided`,
      });
    }

    // Duplicate detection: same model+strategy pair
    if (typeof a.model === "string" && typeof a.strategy === "string") {
      const key = `${a.model}::${a.strategy}`;
      if (seen.has(key)) {
        issues.push({
          path: base,
          code: "DUPLICATE_ASSIGNMENT",
          message: `duplicate assignment: model="${a.model}" strategy="${a.strategy}"`,
        });
      }
      seen.add(key);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const assignments: Assignment[] = (obj.assignments as unknown[]).map((item) => {
    const a = item as Record<string, unknown>;
    return {
      model: a.model as string,
      strategy: a.strategy as ContextStrategy,
      ...(a.strategyConfig !== undefined ? { strategyConfig: a.strategyConfig } : {}),
    };
  });

  return { ok: true, value: { assignments } };
}

export function validateAgentDefinition(value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        { path: "", code: "INVALID_TYPE", message: "agent definition must be an object" },
      ],
    };
  }

  const obj = value as Record<string, unknown>;
  const issues: Array<{ path: string; code: string; message: string }> = [];

  if (typeof obj.standard !== "object" || obj.standard === null) {
    issues.push({ path: "standard", code: "MISSING", message: "standard is required" });
  }
  if (typeof obj.workLoop !== "object" || obj.workLoop === null) {
    issues.push({ path: "workLoop", code: "MISSING", message: "workLoop is required" });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: undefined };
}

/**
 * validateTransition: compare assignments arrays as whole leaves.
 *
 * Any change is accepted as long as the proposed parameters pass
 * structural validation first.  This is the simplest possible
 * transition rule — the assignments array is the only tunable path
 * and any valid reshuffle is permitted.
 */
export function validateTransition(
  _current: unknown,
  proposed: unknown,
): ValidationResult<ContextExperimentParameters> {
  return validateParameters(proposed);
}

// ── Definition ─────────────────────────────────────────────────────

export const contextExperimentDefinition: SchedulerDefinition = {
  kind: "scheduler",
  id: "context-experiment",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  parameterModelVersion: "1.0.0",
  agentDefinitionSchemaVersion: "1.0.0",
  parameterSchema: {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            model: { type: "string", minLength: 1 },
            strategy: { type: "string", enum: [...VALID_STRATEGIES] },
            strategyConfig: { type: "object" },
          },
          required: ["model", "strategy"],
        },
      },
    },
    required: ["assignments"],
  },
  agentDefinitionSchema: {
    type: "object",
    properties: {
      standard: {
        type: "object",
        properties: {
          name: { type: "string" },
          capabilities: { type: "array" },
          executionKind: { type: "string" },
          labels: { type: "object" },
        },
      },
      workLoop: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "string" },
          config: { type: "object" },
        },
      },
      custom: {},
    },
  },
  defaultParameters: structuredClone(DEFAULT_CONTEXT_EXPERIMENT_PARAMETERS),
  tunablePaths: [...TUNABLE_PATHS],
  validateParameters: validateParameters as (value: unknown) => ValidationResult,
  validateAgentDefinition,
  validateTransition: validateTransition as (
    current: unknown,
    proposed: unknown,
  ) => ValidationResult,
};

// ── Agent spec helpers ─────────────────────────────────────────────

/**
 * Sanitize a model id for use in agent ids.
 *
 * Encodes '/' as '__' (distinct from '-') so that `openai/gpt-4o` and
 * `openai-gpt-4o` never map to the same agent id. The encoding is
 * reversible since '__' cannot appear naturally from the second pass
 * which replaces remaining non-alphanumeric chars with '-'.
 */
function sanitizeModelId(modelId: string): string {
  return modelId.replace(/\//g, "__").replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Build an agent id from model and strategy.
 *
 * Convention: `agent-<sanitized-model>-<strategy>`
 */
export function experimentAgentId(model: string, strategy: ContextStrategy): string {
  return `agent-${sanitizeModelId(model)}-${strategy}`;
}

function providerPrefix(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(0, slash) : "unknown";
}

/**
 * Build an AgentDefinition for a context-experiment variant.
 */
export function assignmentToAgentDefinition(assignment: Assignment): AgentDefinition {
  const workLoopId = STRATEGY_WORKLOOP_ID[assignment.strategy];
  const config: Record<string, unknown> = { model: assignment.model };
  if (assignment.strategyConfig && typeof assignment.strategyConfig === "object") {
    Object.assign(config, assignment.strategyConfig as Record<string, unknown>);
  }

  return {
    standard: {
      name: `${assignment.model} [${assignment.strategy}]`,
      capabilities: [],
      executionKind: "experiment-variant",
      labels: {
        provider: providerPrefix(assignment.model),
        strategy: assignment.strategy,
      },
    },
    workLoop: {
      id: workLoopId,
      version: "1.0.0",
      config,
    },
    custom: {},
  };
}

/**
 * Build an AgentCreateSpec for a context-experiment variant.
 */
export function assignmentToAgentCreateSpec(assignment: Assignment): AgentCreateSpec {
  return {
    id: experimentAgentId(assignment.model, assignment.strategy),
    definition: assignmentToAgentDefinition(assignment),
  };
}

// ── Implementation ─────────────────────────────────────────────────

/**
 * Create the context-experiment SchedulerImplementation.
 *
 * **Execute-only**: `select` mode returns `abstained`. `execute` mode
 * performs a parameterized direct pick — the caller specifies the desired
 * variant via `input.labels`:
 *
 * - `labels.strategy` → match by strategy name
 * - `labels.assignmentIndex` → numeric index into `parameters.assignments`
 *
 * Falls back to the first assignment if no selector is provided.
 * No scoring is performed.
 */
export function createContextExperiment(): {
  definition: SchedulerDefinition;
  implementation: SchedulerImplementation;
} {
  const impl: SchedulerImplementation = {
    id: "context-experiment",
    version: "1.0.0",

    async schedule(
      input: SchedulingInput,
      parameters: Readonly<unknown>,
      sdk: SchedulerSDK,
    ): Promise<SchedulingResult> {
      const params = parameters as ContextExperimentParameters;
      const assignments = params.assignments;

      // ── Execute-only gate: select mode → abstain ─────────────
      if (input.mode === "select") {
        sdk.telemetry.emit("scheduler.context_experiment.abstained", {
          role: input.role,
          reason: "context-experiment is execute-only; use dispatch to run a specific variant",
        });
        return {
          status: "abstained",
          reason: "context-experiment is execute-only; use dispatch to run a specific variant",
        };
      }

      // ── Execute mode: parameterized direct pick ──────────────
      if (assignments.length === 0) {
        sdk.telemetry.emit("scheduler.context_experiment.abstained", {
          role: input.role,
          reason: "no assignments configured",
        });
        return { status: "abstained", reason: "no assignments configured" };
      }

      // Resolve assignment: labels.strategy, then labels.assignmentIndex, then first
      let assignment: Assignment | undefined;

      const { labels } = input;
      if (labels?.strategy && typeof labels.strategy === "string") {
        assignment = assignments.find((a) => a.strategy === labels!.strategy);
      }
      if (!assignment && labels?.assignmentIndex !== undefined) {
        const idx = Number(labels.assignmentIndex);
        if (Number.isInteger(idx) && idx >= 0 && idx < assignments.length) {
          assignment = assignments[idx];
        }
      }
      if (!assignment) {
        assignment = assignments[0];
      }

      const agentSpec = assignmentToAgentCreateSpec(assignment);
      const agentId = agentSpec.id;

      sdk.telemetry.emit("scheduler.context_experiment.pick", {
        role: input.role,
        model: assignment.model,
        strategy: assignment.strategy,
        agentId,
        totalAssignments: assignments.length,
      }, {
        "scheduler.context_experiment.assignment_count": assignments.length,
      });

      // Ensure agent exists (create if needed)
      const existing = await sdk.agents.list();
      const existingIds = new Set(existing.map((a) => a.id));
      if (!existingIds.has(agentId)) {
        await sdk.agents.create(agentSpec);
      }

      // Execute the agent
      try {
        const result = await sdk.agents.run(agentId, {
          task: input.task,
          configOverrides: { agent: input.role },
        });
        return {
          status: "completed",
          selectedAgentId: agentId,
          model: assignment.model,
          output: result.output,
          reason: `context-experiment: ${assignment.model} [${assignment.strategy}]`,
        };
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        return {
          status: "failed",
          error: {
            code: e.code ?? "EXECUTION_ERROR",
            message: e.message ?? String(err),
            retryable: true,
          },
        };
      }
    },
  };

  return { definition: contextExperimentDefinition, implementation: impl };
}

// ── Assembly helper ────────────────────────────────────────────────

/**
 * Result of creating a context-experiment instance.
 */
export interface ExperimentBootstrapResult {
  instanceId: string;
  roundId: string;
  agentIds: string[];
}

const DEFAULT_EXPERIMENT_INSTANCE_ID = "context-experiment";

/**
 * Create a context-experiment scheduler instance from a set of assignments.
 *
 * - Registers the `context-experiment@1.0.0` definition (idempotent).
 * - Creates a draft instance with variant agents, each wired to the
 *   appropriate workloop (`pi-default-loop`, `budgeted-history`, or
 *   `selective-summary`).
 * - Validates and activates the draft through the control plane.
 * - Idempotent: returns the existing instance on subsequent calls.
 *
 * The caller MUST pre-register any required WorkLoopDefinitions
 * (`pi-default-loop@1.0.0`, `budgeted-history@1.0.0`,
 * `selective-summary@1.0.0`) in `core.definitions` before calling this
 * function, otherwise draft validation will fail because agent workloop
 * references won't resolve.
 */
export async function createExperimentInstance(
  core: LabCore,
  opts: { instanceId?: string; assignments: Assignment[] },
): Promise<ExperimentBootstrapResult> {
  const instanceId = opts.instanceId ?? DEFAULT_EXPERIMENT_INSTANCE_ID;

  // 1. Idempotency check: if instance already exists and is active, return it
  const existing = core.repository.getInstance(instanceId);
  if (existing && existing.status === "active") {
    const agents = core.repository.listAgents(instanceId);
    return {
      instanceId,
      roundId: existing.currentRoundId,
      agentIds: agents.map((a) => a.id),
    };
  }

  // 2. Register definition (idempotent via DefinitionRegistry conflict)
  try {
    core.definitions.register(contextExperimentDefinition);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }

  // 3. Build agent specs from assignments
  const agents = opts.assignments.map((a) => assignmentToAgentCreateSpec(a));

  // 4. Build parameters
  const params: ContextExperimentParameters = {
    assignments: opts.assignments.map((a) => ({ ...a })),
  };

  // 5. Create draft
  core.controlPlane.createDraft({
    id: instanceId,
    schedulerDefinition: {
      kind: "scheduler",
      id: contextExperimentDefinition.id,
      version: contextExperimentDefinition.version,
    },
    initialParameters: params,
    agents,
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [],
    metadata: { kind: "experiment" },
  });

  // 6. Validate + activate
  const validation = core.controlPlane.validateDraft(instanceId);
  if (!validation.ok) {
    const issueList = validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`experiment draft validation failed: ${issueList}`);
  }

  const { agentIds } = core.controlPlane.activateDraft(instanceId);
  const inst = core.repository.getInstance(instanceId);
  if (!inst) throw new Error(`instance not found after activation: ${instanceId}`);

  return { instanceId, roundId: inst.currentRoundId, agentIds };
}
