import type { LabCore } from "../core/create-core.ts";
import type {
  FallbackTarget,
  AgentCreateSpec,
  LabEvent,
} from "../core/contracts.ts";
import type {
  StandardAgentError,
  StandardAgentOutput,
} from "../workloop/contracts.ts";
import { WorkLoopRunner, type WorkLoopRunRequest } from "../workloop/runner.ts";
import { SchedulerRegistry } from "./registry.ts";
import type {
  SchedulingMode,
  SchedulingResult,
  SchedulerSDK,
  AgentSnapshot,
  AgentRunRequest,
  AgentRunResult,
  SettleOutcome,
} from "./contracts.ts";

// ── Public types ──────────────────────────────────────────────────────

export interface DispatchAttempt {
  schedulerInstanceId: string;
  roundId?: string;
  status: "completed" | "abstained" | "failed";
  error?: StandardAgentError;
}

export type DispatchResult =
  | {
      status: "completed";
      schedulerInstanceId: string;
      roundId: string;
      selectedAgentId?: string;
      model?: string;
      output?: StandardAgentOutput;
      reason?: string;
      settlementRef?: string;
      attempts: DispatchAttempt[];
    }
  | {
      status: "abstained";
      schedulerInstanceId: string;
      roundId: string;
      reason: string;
      attempts: DispatchAttempt[];
    }
  | {
      status: "fallback";
      target: FallbackTarget;
      attempts: DispatchAttempt[];
    }
  | {
      status: "failed";
      error: StandardAgentError;
      attempts: DispatchAttempt[];
    };

export interface DispatchRequest {
  traceId: string;
  dispatchId?: string;
  schedulerInstanceId?: string;
  role: string;
  task: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
  mode?: SchedulingMode;
  signal?: AbortSignal;
  settlementRef?: string;
}

// ── Routing match types ───────────────────────────────────────────────

interface RoutingMatch {
  role?: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
}

interface RoutingBinding {
  id: string;
  schedulerInstanceId: string;
  priority: number;
  match: RoutingMatch;
}

// ── SchedulerRunner ───────────────────────────────────────────────────

export class SchedulerRunner {
  private readonly core: LabCore;
  private readonly schedulers: SchedulerRegistry;
  private readonly wlRunner: WorkLoopRunner | undefined;
  private readonly maxFallbackDepth: number;
  private readonly nowFn: () => number;
  private readonly pendingSettlements = new Map<
    string,
    { schedulerInstanceId: string; roundId?: string; traceId: string }
  >();
  private static readonly MAX_PENDING_SETTLEMENTS = 1000;

  constructor(opts: {
    core: LabCore;
    schedulers: SchedulerRegistry;
    runner?: WorkLoopRunner;
    maxFallbackDepth?: number;
    now?: () => number;
  }) {
    this.core = opts.core;
    this.schedulers = opts.schedulers;
    this.wlRunner = opts.runner;
    this.maxFallbackDepth = opts.maxFallbackDepth ?? 3;
    this.nowFn = opts.now ?? Date.now;
  }

  async settle(taskRef: string, outcome: SettleOutcome): Promise<boolean> {
    const entry = this.pendingSettlements.get(taskRef);
    if (!entry) {
      return false;
    }

    // Remove from map immediately to avoid double-settle
    this.pendingSettlements.delete(taskRef);

    // Resolve instance
    const instance = this.core.repository.getInstance(entry.schedulerInstanceId);
    if (!instance || instance.status !== "active") {
      return false;
    }

    // Resolve implementation
    let impl;
    try {
      impl = this.schedulers.require(
        instance.definition.id,
        instance.definition.version,
      );
    } catch {
      return false;
    }

    if (!impl.settle) {
      return false;
    }

    // Thread schedule-time round parameters when available
    let parameters: Readonly<unknown> | undefined;
    if (entry.roundId) {
      const round = this.core.repository.getRound(entry.roundId);
      parameters = round?.parameters;
    }

    const ctx = {
      schedulerInstanceId: entry.schedulerInstanceId,
      roundId: entry.roundId,
      traceId: entry.traceId,
      parameters,
      telemetry: {
        emit: (
          eventType: string,
          payload: unknown,
          metrics?: Record<string, string | number | boolean | null>,
        ) => {
          const eventId = `settle:${entry.traceId}:${eventType}:${crypto.randomUUID().slice(0, 8)}`;
          this.emitEvent(
            eventId,
            eventType,
            payload,
            metrics,
            entry.traceId,
            entry.traceId + ":dispatch:settle",
            entry.schedulerInstanceId,
            undefined,
            undefined,
            entry.roundId,
          );
        },
      },
      now: this.nowFn(),
    };

    try {
      await impl.settle(ctx, taskRef, outcome);
    } catch (err) {
      // fail-open: log and return false
      console.error(
        `scheduler settle hook error (instance=${entry.schedulerInstanceId}, taskRef=${taskRef}):`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }

    // Emit audit event
    const auditId = `scheduler.settled:${entry.traceId}:${crypto.randomUUID().slice(0, 8)}`;
    this.emitEvent(
      auditId,
      "scheduler.settled",
      {
        taskRef,
        outcomeCompletion: outcome.completion,
        outcomeMajorError: outcome.majorError,
      },
      undefined,
      entry.traceId,
      entry.traceId + ":dispatch:settle",
      entry.schedulerInstanceId,
      undefined,
      undefined,
      entry.roundId,
    );

    return true;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const {
      traceId,
      role,
      task,
      taskCategory,
      labels,
      caller,
      mode = "execute",
      signal,
    } = request;

    const dispatchId = request.dispatchId ?? `${traceId}:dispatch:${crypto.randomUUID().slice(0, 8)}`;
    let seq = 0;
    const nextEventId = (eventType: string): string =>
      `${traceId}:${dispatchId}:${eventType}:${seq++}`;

    const now = this.nowFn();

    // ── scheduling.requested ──────────────────────────────────────
    this.emitEvent(nextEventId("scheduling.requested"), "scheduling.requested", {
      role,
      task,
      taskCategory,
      labels,
      caller,
      mode,
      explicitInstanceId: request.schedulerInstanceId,
    }, undefined, traceId, dispatchId);

    // ── Aborted signal before start ───────────────────────────────
    if (signal?.aborted) {
      return {
        status: "failed",
        error: {
          standard: {
            code: "scheduler-error",
            message: "dispatch cancelled before start",
            retryable: false,
          },
        },
        attempts: [],
      };
    }

    // ── Resolve scheduler instance ────────────────────────────────
    let instanceId: string | undefined;
    let bindingId: string | undefined;

    if (request.schedulerInstanceId) {
      // Explicit wins
      const inst = this.core.repository.getInstance(request.schedulerInstanceId);
      if (!inst || inst.status !== "active") {
        this.emitEvent(
          nextEventId("routing.failed"),
          "routing.failed",
          { reason: `scheduler instance not found or not active: ${request.schedulerInstanceId}` },
          undefined,
          traceId,
          dispatchId,
        );
        return {
          status: "failed",
          error: {
            standard: {
              code: "scheduler-error",
              message: `scheduler instance not found or not active: ${request.schedulerInstanceId}`,
              retryable: false,
            },
          },
          attempts: [],
        };
      }
      instanceId = request.schedulerInstanceId;
    } else {
      // Static routing
      const bindings = this.core.repository.listRoutingBindings();
      const match = this.resolveRoute(bindings, { role, taskCategory, labels, caller });
      if (!match) {
        this.emitEvent(
          nextEventId("routing.failed"),
          "routing.failed",
          { reason: "no matching routing binding", role, taskCategory, labels, caller },
          undefined,
          traceId,
          dispatchId,
        );
        return {
          status: "failed",
          error: {
            standard: {
              code: "scheduler-error",
              message: "no matching routing binding",
              retryable: false,
            },
          },
          attempts: [],
        };
      }
      instanceId = match.binding.schedulerInstanceId;
      bindingId = match.binding.id;

      // routing.resolved
      this.emitEvent(
        nextEventId("routing.resolved"),
        "routing.resolved",
        { bindingId, instanceId },
        undefined,
        traceId,
        dispatchId,
        instanceId,
      );
    }

    // ── Run with fallback chain ───────────────────────────────────
    return this.dispatchToInstance(
      instanceId,
      request,
      dispatchId,
      nextEventId,
      now,
      new Set<string>(),
      0,
    );
  }

  // ── Dispatch to a specific instance ───────────────────────────────

  private async dispatchToInstance(
    instanceId: string,
    request: DispatchRequest,
    dispatchId: string,
    nextEventIdFactory: (eventType: string) => string,
    now: number,
    visitedInstances: Set<string>,
    depth: number,
  ): Promise<DispatchResult> {
    const { traceId, role, task, taskCategory, labels, caller, mode = "execute", signal } = request;

    // Cycle detection
    if (visitedInstances.has(instanceId)) {
      const err: StandardAgentError = {
        code: "scheduler-error",
        message: `fallback cycle detected: ${instanceId}`,
        retryable: false,
      };
      return {
        status: "failed",
        error: { standard: err },
        attempts: [],
      };
    }

    // Max depth
    if (depth >= this.maxFallbackDepth) {
      const err: StandardAgentError = {
        code: "scheduler-error",
        message: `max fallback depth ${this.maxFallbackDepth} exceeded`,
        retryable: false,
      };
      return {
        status: "failed",
        error: { standard: err },
        attempts: [],
      };
    }

    visitedInstances.add(instanceId);

    // Load instance
    const instance = this.core.repository.getInstance(instanceId);
    if (!instance || instance.status !== "active") {
      const err: StandardAgentError = {
        code: "scheduler-error",
        message: `instance not found or not active: ${instanceId}`,
        retryable: false,
      };
      return {
        status: "failed",
        error: { standard: err },
        attempts: [],
      };
    }

    // Resolve effective round: canary pinning (fail-open)
    const effectiveRoundId = (() => {
      const cid = instance.canaryRoundId;
      const cp = instance.canaryPercent;
      if (!cid || !cp || cp <= 0) return instance.currentRoundId;
      if (Math.random() >= cp / 100) return instance.currentRoundId;
      // Canary group: verify the round is loadable
      if (this.core.repository.getRound(cid)) return cid;
      return instance.currentRoundId; // fail-open: canary round not found
    })();

    // Load round
    const round = this.core.repository.getRound(effectiveRoundId);
    if (!round) {
      this.emitEvent(
        nextEventIdFactory("scheduler.failed"),
        "scheduler.failed",
        { reason: `round not found: ${effectiveRoundId}` },
        undefined,
        traceId,
        dispatchId,
        instanceId,
        instance.definition.id,
        instance.definition.version,
      );
      const err: StandardAgentError = {
        code: "scheduler-error",
        message: `round not found: ${effectiveRoundId}`,
        retryable: false,
      };
      return {
        status: "failed",
        error: { standard: err },
        attempts: [],
      };
    }

    // Freeze parameters
    const frozenParams = Object.freeze(structuredClone(round.parameters));

    // Resolve implementation
    const impl = this.schedulers.require(
      instance.definition.id,
      instance.definition.version,
    );

    // Build SDK for this dispatch
    const sdk = this.buildSDK(
      instanceId,
      effectiveRoundId,
      traceId,
      dispatchId,
      nextEventIdFactory,
      signal,
    );

    // ── scheduler.started ─────────────────────────────────────────
    this.emitEvent(
      nextEventIdFactory("scheduler.started"),
      "scheduler.started",
      null,
      undefined,
      traceId,
      dispatchId,
      instanceId,
      instance.definition.id,
      instance.definition.version,
      effectiveRoundId,
    );

    // ── Invoke implementation ─────────────────────────────────────
    let schedulingResult: SchedulingResult;
    try {
      schedulingResult = await impl.schedule(
        {
          traceId,
          dispatchId,
          role,
          task,
          taskCategory,
          labels,
          caller,
          mode,
          signal,
          settlementRef: request.settlementRef,
        },
        frozenParams,
        sdk,
      );
    } catch (err) {
      // Implementation threw
      const stdErr: StandardAgentError = {
        code: "scheduler-error",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };

      this.emitEvent(
        nextEventIdFactory("scheduler.failed"),
        "scheduler.failed",
        { error: stdErr },
        undefined,
        traceId,
        dispatchId,
        instanceId,
        instance.definition.id,
        instance.definition.version,
        effectiveRoundId,
      );

      return this.processFallback(
        instance,
        request,
        dispatchId,
        nextEventIdFactory,
        now,
        visitedInstances,
        depth,
        [{ schedulerInstanceId: instanceId, roundId: effectiveRoundId, status: "failed", error: stdErr }],
      );
    }

    // ── Process result ────────────────────────────────────────────
    const attempt: DispatchAttempt = {
      schedulerInstanceId: instanceId,
      roundId: effectiveRoundId,
      status: schedulingResult.status,
      error: schedulingResult.status === "failed" ? schedulingResult.error : undefined,
    };

    if (schedulingResult.status === "completed") {
      if (schedulingResult.selectedAgentId) {
        this.emitEvent(
          nextEventIdFactory("scheduler.agent.selected"),
          "scheduler.agent.selected",
          { agentInstanceId: schedulingResult.selectedAgentId },
          undefined,
          traceId,
          dispatchId,
          instanceId,
          instance.definition.id,
          instance.definition.version,
          effectiveRoundId,
          schedulingResult.selectedAgentId,
        );
      }

      this.emitEvent(
        nextEventIdFactory("scheduler.completed"),
        "scheduler.completed",
        {
          selectedAgentId: schedulingResult.selectedAgentId,
          model: schedulingResult.model,
          reason: schedulingResult.reason,
        },
        undefined,
        traceId,
        dispatchId,
        instanceId,
        instance.definition.id,
        instance.definition.version,
        effectiveRoundId,
      );

      // Record pending settlement if settlementRef is threaded back
      if (schedulingResult.settlementRef) {
        if (this.pendingSettlements.size >= SchedulerRunner.MAX_PENDING_SETTLEMENTS) {
          // FIFO: evict oldest entry
          const oldest = this.pendingSettlements.keys().next().value;
          if (oldest !== undefined) {
            this.pendingSettlements.delete(oldest);
          }
        }
        this.pendingSettlements.set(schedulingResult.settlementRef, {
          schedulerInstanceId: instanceId,
          roundId: effectiveRoundId,
          traceId,
        });
      }

      return {
        status: "completed",
        schedulerInstanceId: instanceId,
        roundId: effectiveRoundId,
        selectedAgentId: schedulingResult.selectedAgentId,
        model: schedulingResult.model,
        output: schedulingResult.output,
        reason: schedulingResult.reason,
        settlementRef: schedulingResult.settlementRef,
        attempts: [attempt],
      };
    }

    if (schedulingResult.status === "abstained") {
      this.emitEvent(
        nextEventIdFactory("scheduler.abstained"),
        "scheduler.abstained",
        { reason: schedulingResult.reason },
        undefined,
        traceId,
        dispatchId,
        instanceId,
        instance.definition.id,
        instance.definition.version,
        effectiveRoundId,
      );

      // Abstain does NOT trigger fallback
      return {
        status: "abstained",
        schedulerInstanceId: instanceId,
        roundId: effectiveRoundId,
        reason: schedulingResult.reason,
        attempts: [attempt],
      };
    }

    // status === "failed" → process fallback
    this.emitEvent(
      nextEventIdFactory("scheduler.failed"),
      "scheduler.failed",
      { error: schedulingResult.error },
      undefined,
      traceId,
      dispatchId,
      instanceId,
      instance.definition.id,
      instance.definition.version,
      effectiveRoundId,
    );

    return this.processFallback(
      instance,
      request,
      dispatchId,
      nextEventIdFactory,
      now,
      visitedInstances,
      depth,
      [attempt],
    );
  }

  // ── Fallback chain ─────────────────────────────────────────────────

  private async processFallback(
    instance: { fallbackChain: FallbackTarget[] },
    request: DispatchRequest,
    dispatchId: string,
    nextEventIdFactory: (eventType: string) => string,
    now: number,
    visitedInstances: Set<string>,
    depth: number,
    priorAttempts: DispatchAttempt[],
  ): Promise<DispatchResult> {
    const { traceId } = request;

    // Walk the fallback chain
    for (const target of instance.fallbackChain) {
      if (target.type === "scheduler-instance") {
        // Re-enter dispatch on target instance
        // Emit fallback.started
        this.emitEvent(
          nextEventIdFactory("fallback.started"),
          "fallback.started",
          { target },
          undefined,
          traceId,
          dispatchId,
        );

        const result = await this.dispatchToInstance(
          target.id,
          request,
          dispatchId,
          nextEventIdFactory,
          now,
          new Set(visitedInstances),
          depth + 1,
        );

        // Merge attempts
        const mergedAttempts = [
          ...priorAttempts,
          ...("attempts" in result ? result.attempts : []),
        ];

        if (result.status === "completed" || result.status === "abstained") {
          this.emitEvent(
            nextEventIdFactory("fallback.completed"),
            "fallback.completed",
            { target, resultStatus: result.status },
            undefined,
            traceId,
            dispatchId,
          );

          if (result.status === "completed") {
            return {
              status: "completed",
              schedulerInstanceId: result.schedulerInstanceId,
              roundId: result.roundId,
              selectedAgentId: result.selectedAgentId,
              model: result.model,
              output: result.output,
              reason: result.reason,
              settlementRef: result.settlementRef,
              attempts: mergedAttempts,
            };
          }
          return {
            status: "abstained",
            schedulerInstanceId: result.schedulerInstanceId,
            roundId: result.roundId,
            reason: result.reason,
            attempts: mergedAttempts,
          };
        }

        if (result.status === "fallback") {
          // Sub-fallback continues; just keep latest attempts
          // (fallback already emitted its own events; we keep going in our chain)
          // But this shouldn't happen since fallback is terminal in sub-dispatch
          continue;
        }

        // result.status === "failed" → continue to next fallback target
        // attempts already merged; continue loop
        // BUT: need to update priorAttempts so next iteration carries full history
        priorAttempts = mergedAttempts;

        // Continue to next target in this chain
        continue;
      }

      if (target.type === "original-request") {
        this.emitEvent(
          nextEventIdFactory("fallback.started"),
          "fallback.started",
          { target },
          undefined,
          traceId,
          dispatchId,
        );
        this.emitEvent(
          nextEventIdFactory("fallback.completed"),
          "fallback.completed",
          { target, resultStatus: "fallback" },
          undefined,
          traceId,
          dispatchId,
        );
        return {
          status: "fallback",
          target,
          attempts: priorAttempts,
        };
      }

      if (target.type === "fail") {
        this.emitEvent(
          nextEventIdFactory("fallback.started"),
          "fallback.started",
          { target },
          undefined,
          traceId,
          dispatchId,
        );
        this.emitEvent(
          nextEventIdFactory("fallback.completed"),
          "fallback.completed",
          { target, resultStatus: "failed" },
          undefined,
          traceId,
          dispatchId,
        );
        return {
          status: "failed",
          error: {
            standard: {
              code: target.errorCode,
              message: `fallback fail target: ${target.errorCode}`,
              retryable: false,
            },
          },
          attempts: priorAttempts,
        };
      }
    }

    // No fallback targets left → failed with last error
    const lastError = priorAttempts[priorAttempts.length - 1]?.error ?? {
      code: "scheduler-error",
      message: "scheduler failed with no fallback",
      retryable: false,
    };

    return {
      status: "failed",
      error: { standard: lastError },
      attempts: priorAttempts,
    };
  }

  // ── Routing resolution ─────────────────────────────────────────────

  private resolveRoute(
    bindings: RoutingBinding[],
    request: { role: string; taskCategory?: string; labels?: Record<string, string>; caller?: string },
  ): { binding: RoutingBinding } | undefined {
    // bindings are already sorted by priority DESC, id ASC from repository

    // Exact role match beats catch-all
    let best: RoutingBinding | undefined;
    let bestIsExact = false;

    for (const binding of bindings) {
      const hasRole = binding.match.role !== undefined;
      const isExact = hasRole && binding.match.role === request.role;
      const isCatchAll = !hasRole;

      if (isExact) {
        if (!bestIsExact) {
          // First exact match (highest priority due to sort)
          best = binding;
          bestIsExact = true;
        }
        // Higher priority exact matches already came first, so skip lower ones
        continue;
      }

      if (isCatchAll && !bestIsExact && !best) {
        // First catch-all (highest priority)
        best = binding;
      }
    }

    return best ? { binding: best } : undefined;
  }

  // ── SDK builder ─────────────────────────────────────────────────────

  private buildSDK(
    schedulerInstanceId: string,
    roundId: string,
    traceId: string,
    dispatchId: string,
    nextEventId: (eventType: string) => string,
    signal?: AbortSignal,
  ): SchedulerSDK {
    const core = this.core;
    const wlRunner = this.wlRunner;

    const storageNs = `scheduler:${schedulerInstanceId}`;

    return {
      agents: {
        list: async (): Promise<AgentSnapshot[]> => {
          const records = core.repository.listAgents(schedulerInstanceId);
          return records.map((r) => ({
            id: r.id,
            definition: r.definition,
            status: r.status,
          }));
        },

        create: async (spec: AgentCreateSpec): Promise<{ id: string }> => {
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

          // Emit scheduler.agent.created
          this.emitEvent(
            nextEventId("scheduler.agent.created"),
            "scheduler.agent.created",
            { agentInstanceId: spec.id },
            undefined,
            traceId,
            dispatchId,
            schedulerInstanceId,
            undefined,
            undefined,
            roundId,
            spec.id,
          );

          return { id: spec.id };
        },

        run: async (agentId: string, runReq: AgentRunRequest): Promise<AgentRunResult> => {
          if (!wlRunner) {
            throw new Error(
              "agents.run unavailable: workloop runner not available (execute mode requires a runtime)",
            );
          }

          // Find the agent
          const agents = core.repository.listAgents(schedulerInstanceId);
          const agent = agents.find((a) => a.id === agentId);
          if (!agent) {
            throw new Error(`agent not found: ${agentId}`);
          }

          // Merge config
          const mergedConfig = {
            ...(agent.definition.workLoop.config as Record<string, unknown>),
            ...(runReq.configOverrides ?? {}),
          };

          // Build WorkLoopRunRequest
          const wlRequest: WorkLoopRunRequest = {
            traceId,
            executionId: `${dispatchId}:agent:${agentId}:${crypto.randomUUID().slice(0, 8)}`,
            agentInstanceId: agentId,
            optimizationRoundId: roundId,
            workLoopId: agent.definition.workLoop.id,
            workLoopVersion: agent.definition.workLoop.version,
            config: mergedConfig,
            task: runReq.task,
            signal,
            schedulerInstanceId,
            dispatchId,
          };

          const result = await wlRunner.run(wlRequest);

          // Normalize to AgentRunResult
          return {
            status: result.status,
            output: result.output?.standard,
            error: result.error?.standard,
          };
        },
      },

      storage: {
        get<T>(key: string) {
          return core.storage.get<T>(storageNs, key);
        },
        put<T>(key: string, value: T, expectedVersion: number) {
          return core.storage.put<T>(storageNs, key, value, expectedVersion);
        },
      },

      telemetry: {
        emit: (
          eventType: string,
          payload: unknown,
          metrics?: Record<string, string | number | boolean | null>,
        ) => {
          this.emitEvent(
            nextEventId(eventType),
            eventType,
            payload,
            metrics,
            traceId,
            dispatchId,
            schedulerInstanceId,
            undefined,
            undefined,
            roundId,
          );
        },
      },

      control: {
        signal: signal ?? new AbortController().signal,
      },
    };
  }

  // ── Event emission ──────────────────────────────────────────────────

  private emitEvent(
    eventId: string,
    eventType: string,
    payload: unknown,
    metrics: Record<string, string | number | boolean | null> | undefined,
    traceId: string,
    dispatchId: string,
    schedulerInstanceId?: string,
    schedulerDefinitionId?: string,
    schedulerDefinitionVersion?: string,
    optimizationRoundId?: string,
    agentInstanceId?: string,
  ): void {
    const event: LabEvent = {
      eventId,
      eventType,
      schemaVersion: "1.0",
      timestamp: this.nowFn(),
      identity: {
        traceId,
        dispatchId,
        schedulerInstanceId,
        schedulerDefinitionId,
        schedulerDefinitionVersion,
        optimizationRoundId,
        agentInstanceId,
      },
      payload: payload ?? {},
      metrics,
    };
    this.core.events.append(event);
  }
}
