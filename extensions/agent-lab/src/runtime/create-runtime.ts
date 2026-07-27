import type { DatabaseSync } from "node:sqlite";
import { createLabCore } from "../core/create-core.ts";
import type { LabCore } from "../core/create-core.ts";
import { DefinitionRegistry } from "../core/definitions/registry.ts";
import { NamespacedStore } from "../core/storage/namespaced-store.ts";
import { EventLog } from "../core/events/event-log.ts";
import { WorkLoopRegistry } from "../workloop/registry.ts";
import { AgentRuntimeStateStore } from "../workloop/state-store.ts";
import { CheckpointStore, AgentCloneService } from "../workloop/checkpoints.ts";
import { WorkLoopRunner } from "../workloop/runner.ts";
import { PiSubagentsAdapter } from "./pi-subagents-adapter.ts";
import type { DelegationEventBus } from "./pi-subagents-adapter.ts";
import { createPiDefaultLoop } from "../workloops/pi-default-loop.ts";
import type { PiDefaultLoopConfig } from "../workloops/pi-default-loop.ts";
import type { WorkLoopDefinition } from "../core/contracts.ts";
import type {
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../workloop/contracts.ts";

// ── Runtime composite ───────────────────────────────────────────────

export interface WorkLoopRuntime {
  core: LabCore;
  registry: WorkLoopRegistry;
  runner: WorkLoopRunner;
  adapter: PiSubagentsAdapter;
  stateStore: AgentRuntimeStateStore;
  checkpointStore: CheckpointStore;
  cloneService: AgentCloneService;
  dispose: () => void;
}

export interface WorkLoopRuntimeOptions {
  model: ModelPort;
  tools: ToolPort;
  artifacts: ArtifactPort;
}

// ── pi-default-loop@1.0.0 definition ────────────────────────────────

export const PI_DEFAULT_LOOP_DEFINITION: WorkLoopDefinition = {
  kind: "workloop",
  id: "pi-default-loop",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: {
    type: "object",
    properties: {
      agent: { type: "string" },
      cwd: { type: "string" },
      contextMode: { type: "string", enum: ["fresh", "fork"] },
      model: { type: "string" },
      thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      timeoutMs: { type: "number" },
      result: {
        oneOf: [
          { type: "object", properties: { kind: { const: "text" } } },
          { type: "object", properties: { kind: { const: "structured" }, schema: { type: "object" } } },
        ],
      },
    },
    required: ["agent", "cwd", "contextMode"],
  },
  requiredCapabilities: [],
  cloneModes: ["fresh", "fork"],
};

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Compose a sidecar WorkLoop Runtime from the given database and event bus.
 *
 * Injects model, tools, and artifacts ports for SDK completeness even though
 * pi-default-loop@1 does not call them directly. Registers the WorkLoopDefinition
 * metadata and executable implementation for pi-default-loop@1.0.0.
 *
 * Returns a dispose() function that cleans up the adapter.
 *
 * This runtime is intentionally not wired into index.ts. It remains a sidecar
 * for Phase 2 verification.
 */
export function createWorkLoopRuntime(
  db: DatabaseSync,
  eventBus: DelegationEventBus,
  options: WorkLoopRuntimeOptions,
): WorkLoopRuntime {
  const core = createLabCore(db);

  // Register pi-default-loop definition metadata
  core.definitions.register(PI_DEFAULT_LOOP_DEFINITION);

  // Build workloop infrastructure
  const registry = new WorkLoopRegistry(core.definitions);
  const stateStore = new AgentRuntimeStateStore(core.storage);
  const checkpointStore = new CheckpointStore(core.storage);
  const cloneService = new AgentCloneService(stateStore, checkpointStore);

  // Create adapter and runner
  const adapter = new PiSubagentsAdapter(eventBus);
  const runner = new WorkLoopRunner(
    registry,
    stateStore,
    checkpointStore,
    core.events,
    core.storage,
    options.model,
    options.tools,
    options.artifacts,
  );

  // Register pi-default-loop implementation
  const loop = createPiDefaultLoop(adapter);
  registry.register(loop);

  return {
    core,
    registry,
    runner,
    adapter,
    stateStore,
    checkpointStore,
    cloneService,
    dispose: () => adapter.dispose(),
  };
}
