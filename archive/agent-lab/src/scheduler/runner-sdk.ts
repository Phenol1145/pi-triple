import type { LabCore } from "../core/create-core.ts";
import type { AgentCreateSpec, LabEvent } from "../core/contracts.ts";
import type { WorkLoopRunner, WorkLoopRunRequest } from "../workloop/runner.ts";
import type { AgentSnapshot, AgentRunRequest, AgentRunResult, SchedulerSDK } from "./contracts.ts";
import {
  withTimeout,
  isTimeoutFailure,
  DEFAULT_EXECUTION_TIMEOUT_MS,
} from "./with-timeout.ts";

// ── Event emission (extracted from SchedulerRunner.emitEvent) ─────────

export type EmitRunnerEvent = (
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
) => void;

export function emitRunnerEvent(
  deps: { nowFn: () => number; append: (event: LabEvent) => void },
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
    timestamp: deps.nowFn(),
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
  deps.append(event);
}

// ── SDK builder (extracted from SchedulerRunner.buildSDK) ─────────────

export interface SchedulerSDKBuildDeps {
  core: LabCore;
  wlRunner: WorkLoopRunner | undefined;
  emit: EmitRunnerEvent;
}

export function buildSchedulerSDK(
  deps: SchedulerSDKBuildDeps,
  schedulerInstanceId: string,
  roundId: string,
  traceId: string,
  dispatchId: string,
  nextEventId: (eventType: string) => string,
  signal?: AbortSignal,
): SchedulerSDK {
  const core = deps.core;
  const wlRunner = deps.wlRunner;

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
        deps.emit(
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

        // Find the agent — 按 id 全局单查（direct 短路下 agent 可能不属于任何
        // scheduler instance；listAgents 按 instanceId 过滤无法覆盖）
        const agent = core.repository.getAgent(agentId);
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

        // 墙钟超时：默认 DEFAULT_EXECUTION_TIMEOUT_MS（= DEFAULT_MARKET_CONFIG.execution.timeoutMs，
        // 经 arena 调度参数 execution.timeoutMs 透传）；超时 → failed(execution-timeout, retryable)。
        const timeoutMs = runReq.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
        const resultOrTimeout = await withTimeout(wlRunner.run(wlRequest), timeoutMs);
        if (isTimeoutFailure(resultOrTimeout)) {
          // 尽力取消底层 workloop（signal 可能是外部 AbortSignal，无 abort 则跳过）
          signal?.abort?.();
          return {
            status: "failed",
            error: {
              code: "execution-timeout",
              message: resultOrTimeout.error.message,
              retryable: true,
            },
          };
        }
        const result = resultOrTimeout;

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
        deps.emit(
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
