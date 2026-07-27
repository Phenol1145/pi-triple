import type { DatabaseSync } from "node:sqlite";
import { createLabCore } from "../core/create-core.ts";
import type { LabCore } from "../core/create-core.ts";
import { WorkLoopRegistry } from "../workloop/registry.ts";
import { WorkLoopRunner } from "../workloop/runner.ts";
import { AgentRuntimeStateStore } from "../workloop/state-store.ts";
import { CheckpointStore } from "../workloop/checkpoints.ts";
import type { WorkLoopDefinition } from "../core/contracts.ts";
import type {
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../workloop/contracts.ts";

// ── Experiment runtime composite ────────────────────────────────────

export interface ExperimentRuntime {
  core: LabCore;
  workloopRegistry: WorkLoopRegistry;
  workloopRunner: WorkLoopRunner;
  stateStore: AgentRuntimeStateStore;
  checkpointStore: CheckpointStore;
  dispose: () => void;
}

export interface ExperimentRuntimeOptions {
  model: ModelPort;
  tools: ToolPort;
  artifacts: ArtifactPort;
}

// ── WorkLoopDefinitions for experiment managed loops ────────────────

/**
 * budgeted-history@1.0.0: retains system prompt + most recent messages
 * fitting within a configurable budgetTokens ceiling (default 8192).
 * Discards middle segments and emits context.transformed on truncation.
 *
 * Supports "fresh" clone mode only in P6a (fork support TBD in P6b).
 */
export const BUDGETED_HISTORY_DEFINITION: WorkLoopDefinition = {
  kind: "workloop",
  id: "budgeted-history",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: {
    type: "object",
    properties: {
      model: { type: "string" },
      systemPrompt: { type: "string" },
      budgetTokens: { type: "number", default: 8192 },
      maxModelCalls: { type: "number", default: 8 },
      tokenCeiling: { type: "number", default: 32000 },
    },
    required: ["model"],
  },
  requiredCapabilities: [],
  cloneModes: ["fresh"],
};

/**
 * selective-summary@1.0.0: summarises the oldest message segment via a
 * dedicated LLM call when context exceeds budgetTokens.  Preserves system
 * prompt + newest messages and emits context.summary.created for per-round
 * cost attribution (P6b).
 *
 * Supports "fresh" clone mode only.
 */
export const SELECTIVE_SUMMARY_DEFINITION: WorkLoopDefinition = {
  kind: "workloop",
  id: "selective-summary",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: {
    type: "object",
    properties: {
      model: { type: "string" },
      systemPrompt: { type: "string" },
      budgetTokens: { type: "number", default: 8192 },
      maxModelCalls: { type: "number", default: 8 },
      tokenCeiling: { type: "number", default: 32000 },
      maxSummaryCalls: { type: "number", default: 1 },
      summaryWindow: { type: "number", default: 0.5 },
      summaryModel: { type: "string" },
    },
    required: ["model"],
  },
  requiredCapabilities: [],
  cloneModes: ["fresh"],
};

// ── Registration helper ─────────────────────────────────────────────

/**
 * Validate and register a WorkLoopDefinition with the core DefinitionRegistry.
 *
 * Performs runtime shape validation of critical fields that control-plane
 * draft validation depends on (id, version, cloneModes, configSchema).
 * Throws on invalid shape before registration is attempted.
 *
 * The definition is then registered with core.definitions so that
 * control-plane validation (service.ts §6: workloop-not-found) passes for
 * agents referencing this workloop.
 */
export function registerWorkLoopDefinition(
  core: LabCore,
  def: WorkLoopDefinition,
): void {
  // Runtime shape validation: surface clear errors before registry
  if (!def || typeof def !== "object") {
    throw new TypeError("registerWorkLoopDefinition: definition must be an object");
  }
  if (def.kind !== "workloop") {
    throw new TypeError(
      `registerWorkLoopDefinition: kind must be "workloop", got "${def.kind}"`,
    );
  }
  if (!def.id || typeof def.id !== "string" || def.id.trim().length === 0) {
    throw new TypeError("registerWorkLoopDefinition: id must be a non-empty string");
  }
  if (!def.version || typeof def.version !== "string" || def.version.trim().length === 0) {
    throw new TypeError("registerWorkLoopDefinition: version must be a non-empty string");
  }
  if (!def.sdkVersionRange || typeof def.sdkVersionRange !== "string") {
    throw new TypeError("registerWorkLoopDefinition: sdkVersionRange must be a string");
  }
  if (!def.configSchema || typeof def.configSchema !== "object" || Array.isArray(def.configSchema)) {
    throw new TypeError("registerWorkLoopDefinition: configSchema must be a non-null object");
  }
  if (!Array.isArray(def.requiredCapabilities)) {
    throw new TypeError("registerWorkLoopDefinition: requiredCapabilities must be an array");
  }
  if (!Array.isArray(def.cloneModes) || def.cloneModes.length === 0) {
    throw new TypeError("registerWorkLoopDefinition: cloneModes must be a non-empty array");
  }
  for (const mode of def.cloneModes) {
    if (typeof mode !== "string" || mode.trim().length === 0) {
      throw new TypeError("registerWorkLoopDefinition: each cloneMode must be a non-empty string");
    }
  }

  core.definitions.register(def);
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Compose an Experiment Runtime from the given database and ports.
 *
 * Creates LabCore, WorkLoopRegistry, WorkLoopRunner, and associated
 * infrastructure using the caller-supplied model, tools, and artifacts ports.
 *
 * Does NOT accept/require an eventBus parameter. Does NOT construct a
 * PiSubagentsAdapter. Does NOT register pi-default-loop.
 *
 * Callers must register WorkLoopDefinitions and implementations separately
 * using registerWorkLoopDefinition() and workloopRegistry.register().
 *
 * dispose() is a no-op currently; there is no persistent adapter to clean up.
 */
export function createExperimentRuntime(
  db: DatabaseSync,
  options: ExperimentRuntimeOptions,
): ExperimentRuntime {
  const core = createLabCore(db);

  const workloopRegistry = new WorkLoopRegistry(core.definitions);
  const stateStore = new AgentRuntimeStateStore(core.storage);
  const checkpointStore = new CheckpointStore(core.storage);

  const workloopRunner = new WorkLoopRunner(
    workloopRegistry,
    stateStore,
    checkpointStore,
    core.events,
    core.storage,
    options.model,
    options.tools,
    options.artifacts,
  );

  return {
    core,
    workloopRegistry,
    workloopRunner,
    stateStore,
    checkpointStore,
    dispose: () => {
      // no-op: no persistent adapter to clean up
    },
  };
}
