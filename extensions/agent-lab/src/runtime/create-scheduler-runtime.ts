import type { DatabaseSync } from "node:sqlite";
import { createLabCore } from "../core/create-core.ts";
import type { LabCore } from "../core/create-core.ts";
import { DefinitionRegistry } from "../core/definitions/registry.ts";
import { SchedulerRegistry } from "../scheduler/registry.ts";
import { SchedulerRunner } from "../scheduler/runner.ts";
import { WorkLoopRunner } from "../workloop/runner.ts";
import { WorkLoopRegistry } from "../workloop/registry.ts";
import { AgentRuntimeStateStore } from "../workloop/state-store.ts";
import { CheckpointStore } from "../workloop/checkpoints.ts";
import { PiSubagentsAdapter } from "./pi-subagents-adapter.ts";
import type { DelegationEventBus } from "./pi-subagents-adapter.ts";
import { createPiDefaultLoop } from "../workloops/pi-default-loop.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "./create-runtime.ts";
import { marketBidLoop } from "../workloops/market-bid-loop.ts";
import type { WorkLoopDefinition } from "../core/contracts.ts";
import type {
  ModelPort,
  ToolPort,
  ArtifactPort,
} from "../workloop/contracts.ts";

// ── market-bid-loop@1.0.0 definition ────────────────────────────────

export const MARKET_BID_LOOP_DEFINITION: WorkLoopDefinition = {
  kind: "workloop",
  id: "market-bid-loop",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: {
    type: "object",
    properties: {
      model: { type: "string" },
      balance: { type: "number" },
      promptTemplate: { type: "string" },
    },
    required: [],
  },
  requiredCapabilities: [],
  cloneModes: ["fresh"],
};

// ── Runtime composite ───────────────────────────────────────────────

export interface SchedulerRuntime {
  core: LabCore;
  schedulers: SchedulerRegistry;
  schedulerRunner: SchedulerRunner;
  workloopRuntime?: WorkLoopRuntimeLite;
  dispose: () => void;
}

export interface WorkLoopRuntimeLite {
  core: LabCore;
  registry: WorkLoopRegistry;
  runner: WorkLoopRunner;
  adapter: PiSubagentsAdapter;
  stateStore: AgentRuntimeStateStore;
  checkpointStore: CheckpointStore;
  dispose: () => void;
}

export interface SchedulerRuntimeOptions {
  eventBus?: DelegationEventBus;
  model?: ModelPort;
  tools?: ToolPort;
  artifacts?: ArtifactPort;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Compose a Scheduler Runtime from the given database.
 *
 * Without an eventBus, creates a SchedulerRunner that supports select mode
 * but rejects execute-mode agents.run with a typed unavailable error.
 *
 * With an eventBus (and model, tools, artifacts), composes the full
 * WorkLoopRuntime underneath and wires its WorkLoopRunner into the
 * SchedulerRunner, enabling execute-mode dispatches.
 *
 * Always registers the pi-default-loop@1.0.0 definition so that bootstrap
 * validation can resolve agent workloop references.
 *
 * dispose() cleans up the workloop runtime adapter when present.
 */
export function createSchedulerRuntime(
  db: DatabaseSync,
  options: SchedulerRuntimeOptions,
): SchedulerRuntime {
  const core = createLabCore(db);

  // Register workloop definitions (required for validation of
  // agent workloop references during bootstrap)
  try {
    core.definitions.register(PI_DEFAULT_LOOP_DEFINITION);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }
  try {
    core.definitions.register(MARKET_BID_LOOP_DEFINITION);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }

  const schedulers = new SchedulerRegistry(core.definitions);

  // Without eventBus: no WorkLoopRunner → execute mode rejects
  if (!options.eventBus) {
    return {
      core,
      schedulers,
      schedulerRunner: new SchedulerRunner({
        core,
        schedulers,
        // No runner → execute mode agents.run rejects with typed unavailable
      }),
      workloopRuntime: undefined,
      dispose: () => {
        // no-op: nothing to clean up
      },
    };
  }

  // With eventBus: compose full WorkLoopRuntime
  const { eventBus, model, tools, artifacts } = options;

  if (!model || !tools || !artifacts) {
    throw new Error(
      "model, tools, and artifacts ports are required when eventBus is provided",
    );
  }

  const wlRegistry = new WorkLoopRegistry(core.definitions);
  const stateStore = new AgentRuntimeStateStore(core.storage);
  const checkpointStore = new CheckpointStore(core.storage);
  const adapter = new PiSubagentsAdapter(eventBus);
  const wlRunner = new WorkLoopRunner(
    wlRegistry,
    stateStore,
    checkpointStore,
    core.events,
    core.storage,
    model,
    tools,
    artifacts,
  );

  // Register workloop implementations
  const loop = createPiDefaultLoop(adapter);
  wlRegistry.register(loop);
  try {
    wlRegistry.register(marketBidLoop);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }

  const workloopRuntime: WorkLoopRuntimeLite = {
    core,
    registry: wlRegistry,
    runner: wlRunner,
    adapter,
    stateStore,
    checkpointStore,
    dispose: () => adapter.dispose(),
  };

  return {
    core,
    schedulers,
    schedulerRunner: new SchedulerRunner({
      core,
      schedulers,
      runner: wlRunner,
    }),
    workloopRuntime,
    dispose: () => adapter.dispose(),
  };
}
