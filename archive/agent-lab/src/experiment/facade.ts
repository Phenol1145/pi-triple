/**
 * ExperimentFacade — production wiring for the /lab experiment command family.
 *
 * Mirrors the OptimizerFacade pattern: lazy-resolved core, fail-open telemetry,
 * and bootstrap-pending branches.  Built for testability via dep injection.
 *
 * ## Model resolution (I8)
 *
 * `run()` receives a cmdCtx with a `modelRegistry` and builds a real
 * `createPiModelPort` so that model calls are foreground command-driven
 * (real API keys, no synthetic dispatch).
 *
 * ## T3 projection
 *
 * `compare()` delegates to the context-projector (T3).  If not yet landed,
 * returns `available: false` with reason "projection pending".
 *
 * @module experiment/facade
 */

import type { DatabaseSync } from "node:sqlite";
import { createLabCore, type LabCore } from "../core/create-core.ts";
import {
  createExperimentRuntime,
  registerWorkLoopDefinition,
  BUDGETED_HISTORY_DEFINITION,
  SELECTIVE_SUMMARY_DEFINITION,
} from "../runtime/create-experiment-runtime.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../runtime/create-runtime.ts";
import { createPiModelPort, type ModelRegistryLike } from "../workloops/model-port.ts";
import { createToolPort, createMemoryArtifactPort } from "../workloops/model-port.ts";
import { budgetedHistory } from "../workloops/budgeted-history.ts";
import { selectiveSummary } from "../workloops/selective-summary.ts";

import {
  createContextExperiment,
  createExperimentInstance,
  type Assignment,
  type ContextExperimentParameters,
} from "../schedulers/context-experiment.ts";
import {
  projectContextStrategies,
  projectContextStrategiesByRound,
} from "../optimizer/context-projector.ts";
import { SchedulerRegistry } from "../scheduler/registry.ts";
import { WorkLoopRegistry } from "../workloop/registry.ts";
import type { WorkLoopRunner } from "../workloop/runner.ts";
import type { WorkLoopRunRequest } from "../workloop/runner.ts";

import type {
  SchedulerSDK,
  SchedulingInput,
  SchedulingResult,
  AgentSnapshot,
  AgentRunRequest,
  AgentRunResult,
} from "../scheduler/contracts.ts";
import type { AgentCreateSpec } from "../core/contracts.ts";

// ── Public types ──────────────────────────────────────────────────────

export interface ExperimentFacade {
  /** Create a context-experiment instance from assignments. Idempotent. */
  create(assignments: Assignment[]): Promise<{
    instanceId: string;
    roundId: string;
    agentIds: string[];
  }>;

  /**
   * Run one variant of the experiment in command-foreground mode (I8).
   *
   * Builds a live PiModelPort from cmdCtx.modelRegistry, targets a
   * specific assignment by optional labels (strategy / assignmentIndex),
   * dispatches through the context-experiment scheduler, and returns a
   * rendered summary with status / usage / strategy.
   */
  run(
    instanceId: string,
    task: string,
    cmdCtx: { modelRegistry: ModelRegistryLike },
    labels?: { strategy?: string; assignmentIndex?: number },
  ): Promise<ExperimentRunResult>;

  /** Show the instance status and its variant agents. */
  status(instanceId: string): ExperimentStatusResult;

  /**
   * Per-strategy comparison via T3 context-projector.
   *
   * If the projector is not yet landed (T3), returns `available: false`
   * with reason "projection pending".
   *
   * @param opts.roundId - optional filter by optimizationRoundId
   * @param opts.byRound - when true, returns per-round grouped comparison
   */
  compare(instanceId: string, opts?: { roundId?: string; byRound?: boolean }): ExperimentCompareResult;
}

export interface ExperimentRunResult {
  status: "completed" | "abstained" | "failed";
  model?: string;
  strategy?: string;
  agentId?: string;
  output?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
    durationMs: number;
    source: "observed" | "derived";
  };
  error?: string;
}

export interface ExperimentStatusResult {
  instanceId: string;
  status: string;
  definitionId: string;
  definitionVersion: string;
  roundId: string;
  agents: Array<{
    id: string;
    model: string;
    strategy: string;
    status: string;
  }>;
}

export interface ExperimentCompareResult {
  available: boolean;
  data?: unknown;
  reason?: string;
}

// ── Deps ──────────────────────────────────────────────────────────────

export interface ExperimentFacadeDeps {
  /** Raw SQLite handle shared with the main store. */
  getDb(): DatabaseSync;
}

// ── Builder ───────────────────────────────────────────────────────────

export function buildExperimentFacade(deps: ExperimentFacadeDeps): ExperimentFacade {
  const { getDb } = deps;

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Build a lightweight LabCore on the shared DB for read-only operations
   * (status, create) that don't need a real ModelPort.
   */
  function readCore(): LabCore {
    return createLabCore(getDb());
  }

  /**
   * Register all managed workloop definitions + implementations on the
   * given core and registry.  Idempotent-registration is best-effort;
   * duplicate definitions are caught and ignored.
   */
  function ensureDefinitions(core: LabCore, wlRegistry: WorkLoopRegistry): void {
    // Register definitions (best-effort idempotent)
    try { core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION)); } catch { /* idempotent */ }
    try { registerWorkLoopDefinition(core, structuredClone(BUDGETED_HISTORY_DEFINITION)); } catch { /* idempotent */ }
    try { registerWorkLoopDefinition(core, structuredClone(SELECTIVE_SUMMARY_DEFINITION)); } catch { /* idempotent */ }

    // Register implementations (idempotent via registry conflict)
    try { wlRegistry.register(budgetedHistory); } catch { /* already registered */ }
    try { wlRegistry.register(selectiveSummary); } catch { /* already registered */ }
    // pi-default-loop is registered via createPiDefaultLoop — we register
    // the definition above so draft validation passes; the implementation
    // is a factory that requires a full runtime (not wired here).
  }

  /**
   * Build a SchedulerSDK backed by the experiment runtime's WorkLoopRunner.
   * Mirrors SchedulerRunner.buildSDK() with minimal event emission.
   */
  function buildSdk(
    core: LabCore,
    wlRunner: WorkLoopRunner,
    schedulerInstanceId: string,
    roundId: string,
    experimentInstanceId: string,
  ): SchedulerSDK {
    return {
      agents: {
        async list(): Promise<AgentSnapshot[]> {
          const records = core.repository.listAgents(schedulerInstanceId);
          return records.map((r) => ({
            id: r.id,
            definition: r.definition,
            status: r.status,
          }));
        },

        async create(spec: AgentCreateSpec): Promise<{ id: string }> {
          core.repository.insertAgent({
            id: spec.id,
            schedulerInstanceId,
            definition: spec.definition,
            sourceAgentId: spec.sourceAgentId,
            cloneOperationId: spec.cloneOperationId,
            createdAtRoundId: roundId,
            status: "ready",
            createdAt: Date.now(),
          });
          return { id: spec.id };
        },

        async run(agentId: string, runReq: AgentRunRequest): Promise<AgentRunResult> {
          const agents = core.repository.listAgents(schedulerInstanceId);
          const agent = agents.find((a) => a.id === agentId);
          if (!agent) {
            throw new Error(`agent not found: ${agentId}`);
          }

          const mergedConfig = {
            ...(agent.definition.workLoop.config as Record<string, unknown>),
            ...(runReq.configOverrides ?? {}),
          };

          const wlRequest: WorkLoopRunRequest = {
            traceId: `experiment:${experimentInstanceId}:${Date.now()}`,
            executionId: `experiment-exec:${agentId}:${crypto.randomUUID().slice(0, 8)}`,
            agentInstanceId: agentId,
            optimizationRoundId: roundId,
            workLoopId: agent.definition.workLoop.id,
            workLoopVersion: agent.definition.workLoop.version,
            config: mergedConfig,
            task: runReq.task,
            schedulerInstanceId,
            dispatchId: `experiment-dispatch:${Date.now()}`,
          };

          const result = await wlRunner.run(wlRequest);

          return {
            status: result.status,
            output: result.output?.standard,
            error: result.error?.standard,
          };
        },
      },

      storage: {
        get<T>(key: string) {
          return core.storage.get<T>(`scheduler:${schedulerInstanceId}`, key);
        },
        put<T>(key: string, value: T, expectedVersion: number) {
          return core.storage.put<T>(`scheduler:${schedulerInstanceId}`, key, value, expectedVersion);
        },
      },

      telemetry: {
        emit(_eventType: string, _payload: unknown, _metrics?: Record<string, string | number | boolean | null>) {
          // Best-effort; full telemetry is wired through the WorkLoopRunner's
          // own event emission, not through this SDK shim.
        },
      },

      control: { signal: new AbortController().signal },
    };
  }

  // ── Public methods ─────────────────────────────────────────────────

  return {
    async create(assignments: Assignment[]) {
      const core = readCore();

      // Register workloop definitions (needed for draft validation)
      try { core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION)); } catch { /* idempotent */ }
      try { registerWorkLoopDefinition(core, structuredClone(BUDGETED_HISTORY_DEFINITION)); } catch { /* idempotent */ }
      try { registerWorkLoopDefinition(core, structuredClone(SELECTIVE_SUMMARY_DEFINITION)); } catch { /* idempotent */ }

      return createExperimentInstance(core, { assignments });
    },

    async run(
      instanceId: string,
      task: string,
      cmdCtx: { modelRegistry: ModelRegistryLike },
      labels?: { strategy?: string; assignmentIndex?: number },
    ) {
      const db = getDb();

      // 1. Look up instance assignments to determine which model to target
      const lookupCore = readCore();
      const inst = lookupCore.repository.getInstance(instanceId);
      if (!inst || inst.status !== "active") {
        return {
          status: "failed" as const,
          error: `experiment instance not found or not active: ${instanceId}`,
        };
      }

      const round = lookupCore.repository.getRound(inst.currentRoundId);
      if (!round) {
        return { status: "failed" as const, error: "current round not found" };
      }

      const params = round.parameters as ContextExperimentParameters;
      const assignments = params.assignments;
      if (!assignments || assignments.length === 0) {
        return { status: "abstained" as const, error: "no assignments configured" };
      }

      // 2. Resolve which assignment to target
      let assignment: Assignment = assignments[0];
      if (labels?.strategy) {
        const found = assignments.find((a) => a.strategy === labels!.strategy);
        if (found) assignment = found;
      }
      if (labels?.assignmentIndex !== undefined) {
        const idx = labels.assignmentIndex;
        if (Number.isInteger(idx) && idx >= 0 && idx < assignments.length) {
          assignment = assignments[idx];
        }
      }

      // 3. Build model port for the targeted assignment model
      const modelPort = createPiModelPort(cmdCtx, { modelId: assignment.model });

      // 4. Build experiment runtime
      const rt = createExperimentRuntime(db, {
        model: modelPort,
        tools: createToolPort(),
        artifacts: createMemoryArtifactPort(),
      });

      // 5. Register definitions + implementations
      ensureDefinitions(rt.core, rt.workloopRegistry);

      // 6. Register context-experiment scheduler implementation
      const schedRegistry = new SchedulerRegistry(rt.core.definitions);
      const { definition: ceDef, implementation: ceImpl } = createContextExperiment();
      try {
        rt.core.definitions.register(ceDef);
      } catch { /* idempotent */ }
      schedRegistry.register(ceImpl);

      // Ensure instance exists
      try {
        await createExperimentInstance(rt.core, { instanceId, assignments });
      } catch { /* idempotent — may already exist */ }

      // 7. Build SDK and call schedule()
      const inst2 = rt.core.repository.getInstance(instanceId);
      if (!inst2) {
        return { status: "failed" as const, error: "instance not found after ensure" };
      }
      const roundId = inst2.currentRoundId;

      const sdk = buildSdk(rt.core, rt.workloopRunner, instanceId, roundId, instanceId);

      const input: SchedulingInput = {
        traceId: `experiment-run:${instanceId}:${Date.now()}`,
        dispatchId: `experiment-dispatch:${crypto.randomUUID().slice(0, 8)}`,
        role: "experiment",
        task,
        mode: "execute",
        labels: {
          ...(labels?.strategy ? { strategy: labels.strategy } : {}),
          ...(labels?.assignmentIndex !== undefined ? { assignmentIndex: String(labels.assignmentIndex) } : {}),
        },
      };

      let schedResult: SchedulingResult;
      try {
        schedResult = await ceImpl.schedule(input, params, sdk);
      } catch (err) {
        return {
          status: "failed" as const,
          error: `schedule failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // 8. Map SchedulingResult → ExperimentRunResult
      if (schedResult.status === "completed") {
        return {
          status: "completed",
          model: schedResult.model ?? assignment.model,
          strategy: assignment.strategy,
          agentId: schedResult.selectedAgentId,
          output: schedResult.output?.text,
          usage: schedResult.output?.usage
            ? {
                input: schedResult.output.usage.input,
                output: schedResult.output.usage.output,
                cacheRead: schedResult.output.usage.cacheRead ?? 0,
                cacheWrite: schedResult.output.usage.cacheWrite ?? 0,
                cost: schedResult.output.usage.cost,
                turns: schedResult.output.usage.turns,
                durationMs: schedResult.output.usage.durationMs ?? 0,
                source: (schedResult.output.usage as Record<string, unknown>)._source as "observed" | "derived" ?? "derived",
              }
            : undefined,
        };
      }

      if (schedResult.status === "abstained") {
        return { status: "abstained", error: schedResult.reason };
      }

      return {
        status: "failed",
        error: schedResult.error?.message ?? "unknown error",
      };
    },

    status(instanceId: string): ExperimentStatusResult {
      const core = readCore();
      const inst = core.repository.getInstance(instanceId);

      if (!inst) {
        return {
          instanceId,
          status: "not-found",
          definitionId: "",
          definitionVersion: "",
          roundId: "",
          agents: [],
        };
      }

      const agents = core.repository.listAgents(instanceId);

      // Extract model + strategy from each agent's workLoop config or id
      const agentInfos = agents.map((a) => {
        const config = (a.definition.workLoop.config ?? {}) as Record<string, unknown>;
        // Strategy extraction: try known suffixes from agent id
        // Agent id format: agent-<sanitizedModelId>-<strategy>
        const knownStrategies = ["default", "budgeted-history", "selective-summary"] as const;
        let strategy = "?";
        for (const s of knownStrategies) {
          if (a.id.endsWith(`-${s}`)) {
            strategy = s;
            break;
          }
        }
        const model = String(config.model ?? "?");
        return {
          id: a.id,
          model,
          strategy,
          status: a.status,
        };
      });

      return {
        instanceId,
        status: inst.status,
        definitionId: inst.definition.id,
        definitionVersion: inst.definition.version,
        roundId: inst.currentRoundId,
        agents: agentInfos,
      };
    },

    compare(instanceId: string, opts?: { roundId?: string; byRound?: boolean }): ExperimentCompareResult {
      try {
        readCore();
        const db = getDb();

        if (opts?.byRound) {
          const rounds = projectContextStrategiesByRound(db, {
            schedulerInstanceId: instanceId,
          });
          return { available: true, data: { mode: "byRound", rounds } };
        }

        const data = projectContextStrategies(db, {
          schedulerInstanceId: instanceId,
          roundId: opts?.roundId,
        });
        return { available: true, data: { mode: "single", projection: data } };
      } catch (err) {
        return {
          available: false,
          reason: `projection query failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
