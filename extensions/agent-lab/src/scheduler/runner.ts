import type { LabCore } from "../core/create-core.ts";
import type { FallbackTarget } from "../core/contracts.ts";
import type { StandardAgentError } from "../workloop/contracts.ts";
import { WorkLoopRunner } from "../workloop/runner.ts";
import { SchedulerRegistry } from "./registry.ts";
import { MARKET_SCHEDULER_DEFINITION_ID, WEIGHTED_SCORER_DEFINITION_ID } from "./names.ts";
import type { SchedulingResult, SettleOutcome } from "./contracts.ts";
import {
  type DispatchAttempt,
  type DispatchRequest,
  type DispatchResult,
  resolveRoute,
} from "./runner-types.ts";
import { resolveStrategy, type StrategyConfig } from "./strategy.ts";
import type { SchedulingStrategy } from "./strategy.ts";
import { emitRunnerEvent, buildSchedulerSDK } from "./runner-sdk.ts";

// Re-export dispatch types — public API preserved (consumers like
// bench/run.ts and scheduler-bridge-contract.test.ts import from runner.ts).
export type {
  DispatchAttempt,
  DispatchRequest,
  DispatchResult,
} from "./runner-types.ts";

// ── SchedulerRunner ───────────────────────────────────────────────────

export class SchedulerRunner {
  private readonly core: LabCore;
  private readonly schedulers: SchedulerRegistry;
  private readonly wlRunner: WorkLoopRunner | undefined;
  private readonly maxFallbackDepth: number;
  private readonly nowFn: () => number;
  private readonly strategyConfig: StrategyConfig;
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
    /** 调度策略解析配置（defaultStrategy/weightedRoles）；缺省走 { defaultStrategy: "market", weightedRoles: [] } */
    strategyConfig?: StrategyConfig;
  }) {
    this.core = opts.core;
    this.schedulers = opts.schedulers;
    this.wlRunner = opts.runner;
    this.maxFallbackDepth = opts.maxFallbackDepth ?? 3;
    this.nowFn = opts.now ?? Date.now;
    this.strategyConfig = opts.strategyConfig ?? { defaultStrategy: "market", weightedRoles: [] };
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
      strategy: explicitStrategy,
    } = request;

    const dispatchId = request.dispatchId ?? `${traceId}:dispatch:${crypto.randomUUID().slice(0, 8)}`;
    let seq = 0;
    const nextEventId = (eventType: string): string =>
      `${traceId}:${dispatchId}:${eventType}:${seq++}`;

    const now = this.nowFn();

    // ── Strategy resolution (explicit > labels > caller > whitelist > default) ──
    const strategy = resolveStrategy(
      { strategy: explicitStrategy, caller, role, labels },
      this.strategyConfig,
    );

    // ── scheduling.requested ──────────────────────────────────────
    this.emitEvent(nextEventId("scheduling.requested"), "scheduling.requested", {
      role,
      task,
      taskCategory,
      labels,
      caller,
      mode,
      strategy,
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
      // Resolve explicit instanceId: UUIDs get a fast id lookup first;
      // non-UUID values (e.g. cfg.scheduler.instanceId names) go straight
      // to name lookup to avoid a wasted DB roundtrip on primary key.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.schedulerInstanceId);
      let inst = isUuid ? this.core.repository.getInstance(request.schedulerInstanceId) : undefined;
      if (!inst) {
        // Name lookup: try both scheduler definitions.
        inst = this.core.repository.findInstanceByName(MARKET_SCHEDULER_DEFINITION_ID, request.schedulerInstanceId)
            ?? this.core.repository.findInstanceByName(WEIGHTED_SCORER_DEFINITION_ID, request.schedulerInstanceId);
        // Fallback: non-UUID string ids from legacy tests.
        if (!inst && !isUuid) {
          inst = this.core.repository.getInstance(request.schedulerInstanceId);
        }
      }
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
      instanceId = inst.id;
    } else {
      // Static routing
      const bindings = this.core.repository.listRoutingBindings();
      const match = resolveRoute(bindings, { role, taskCategory, labels, caller });
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
      strategy,
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
    strategy: SchedulingStrategy,
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
    const sdk = buildSchedulerSDK(
      { core: this.core, wlRunner: this.wlRunner, emit: this.emitEvent.bind(this) },
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
          strategy,
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
        strategy,
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
      strategy,
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
    strategy: SchedulingStrategy,
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
          strategy,
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

  // ── SDK builder / event emission (extracted to runner-sdk.ts) ──────

  // Thin wrapper preserving the private-method call sites; the logic lives
  // in emitRunnerEvent (runner-sdk.ts) parameterized over nowFn/append.
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
    emitRunnerEvent(
      { nowFn: this.nowFn, append: (e) => this.core.events.append(e) },
      eventId,
      eventType,
      payload,
      metrics,
      traceId,
      dispatchId,
      schedulerInstanceId,
      schedulerDefinitionId,
      schedulerDefinitionVersion,
      optimizationRoundId,
      agentInstanceId,
    );
  }
}
