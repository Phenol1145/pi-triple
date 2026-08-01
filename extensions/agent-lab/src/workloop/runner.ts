import type { EventLog } from "../core/events/event-log.ts";
import type { LabEvent } from "../core/contracts.ts";
import { VersionConflictError } from "../core/storage/namespaced-store.ts";
import type { NamespacedStore } from "../core/storage/namespaced-store.ts";
import { WorkLoopRegistry } from "./registry.ts";
import { AgentRuntimeStateStore } from "./state-store.ts";
import { CheckpointStore } from "./checkpoints.ts";
import type { CheckpointRecord } from "./checkpoints.ts";
import { createContextOperations } from "./context.ts";
import { createInstrumentedModelPort } from "../workloops/model-port.ts";
import { MachineRuntime } from "./machine-runtime.ts";
import type { ResumeState } from "./machine-runtime.ts";
import type {
  WorkLoopImplementation,
  WorkLoopInput,
  WorkLoopResult,
  WorkLoopSDK,
  ModelPort,
  ToolPort,
  ArtifactPort,
  WorkContext,
} from "./contracts.ts";

// ── Request ──────────────────────────────────────────────────────────

export interface WorkLoopRunRequest {
  traceId: string;
  executionId: string;
  agentInstanceId: string;
  optimizationRoundId: string;
  workLoopId: string;
  workLoopVersion: string;
  config: unknown;
  task: string;
  signal?: AbortSignal;
  /** P6a I1: set by SchedulerRunner or experiment entry point for event identity */
  schedulerInstanceId?: string;
  /** P6a I1: set by SchedulerRunner or experiment entry point for event identity */
  dispatchId?: string;
  /** 从指定 checkpoint 恢复续跑（MachineRuntime.resumeStateOf 重建控制状态/序号） */
  resumeFromCheckpointId?: string;
  /** 转移预算上限（可选，默认 100；透传 MachineRuntime budgets.maxTurns） */
  maxTurns?: number;
}

// ── Runner ───────────────────────────────────────────────────────────

export class WorkLoopRunner {
  private readonly registry: WorkLoopRegistry;
  private readonly stateStore: AgentRuntimeStateStore;
  private readonly checkpointStore: CheckpointStore;
  private readonly eventLog: EventLog;
  private readonly storage: NamespacedStore;
  private readonly model: ModelPort;
  private readonly tools: ToolPort;
  private readonly artifacts: ArtifactPort;

  /** Per-agent FIFO tail: maps agentInstanceId → tail Promise<WorkLoopResult> */
  private readonly tails = new Map<string, Promise<WorkLoopResult>>();

  constructor(
    registry: WorkLoopRegistry,
    stateStore: AgentRuntimeStateStore,
    checkpointStore: CheckpointStore,
    eventLog: EventLog,
    storage: NamespacedStore,
    model: ModelPort,
    tools: ToolPort,
    artifacts: ArtifactPort,
  ) {
    this.registry = registry;
    this.stateStore = stateStore;
    this.checkpointStore = checkpointStore;
    this.eventLog = eventLog;
    this.storage = storage;
    this.model = model;
    this.tools = tools;
    this.artifacts = artifacts;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Enqueue a run. FIFO single-flight per agent.
   * Different agents may run concurrently.
   */
  async run(request: WorkLoopRunRequest): Promise<WorkLoopResult> {
    const aid = request.agentInstanceId;
    const prev = this.tails.get(aid) ?? Promise.resolve(undefined as unknown as WorkLoopResult);

    const tail = prev.then(
      () => this.executeRun(request),
      // If the previous run rejected (which shouldn't happen), still proceed
      () => this.executeRun(request),
    );

    // Capture the tail and clean up when settled
    this.tails.set(aid, tail);
    tail.finally(() => {
      if (this.tails.get(aid) === tail) {
        this.tails.delete(aid);
      }
    });

    return tail;
  }

  // ── Internal execution ───────────────────────────────────────────

  private async executeRun(request: WorkLoopRunRequest): Promise<WorkLoopResult> {
    const {
      traceId,
      executionId,
      agentInstanceId,
      optimizationRoundId,
      workLoopId,
      workLoopVersion,
      config,
      task,
      signal,
    } = request;

    // Per-run sequence counter for deterministic event IDs
    let seq = 0;
    const nextEventId = (eventType: string): string =>
      `${executionId}:${eventType}:${seq++}`;

    // ── Abort before start ──────────────────────────────────────
    if (signal?.aborted) {
      this.emitEvent(
        nextEventId("agent.cancelled"),
        "agent.cancelled",
        null,
        undefined,
        request,
      );
      return this.emptyResult("cancelled");
    }

    // ── Resolve implementation ──────────────────────────────────
    let implementation: WorkLoopImplementation;
    try {
      implementation = this.registry.require(workLoopId, workLoopVersion);
    } catch (err) {
      this.emitEvent(
        nextEventId("agent.failed"),
        "agent.failed",
        null,
        undefined,
        request,
      );
      return {
        status: "failed",
        error: {
          standard: {
            code: "workloop-error",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
        },
        context: this.emptyContext(),
        state: {},
      };
    }

    // ── Load CAS snapshot (auto-initialize on first run) ────────
    // First run for an agent (e.g. arena bidding candidates, fresh execute
    // agents) has no snapshot yet. Initialize it from the implementation's
    // initialContext/initialState. Per-agent single-flight (this.tails)
    // serializes runs for the same agent, so concurrent initialize races are
    // not expected; the VersionConflictError catch re-reads just in case.
    let snapshot = this.stateStore.get(agentInstanceId);
    if (!snapshot) {
      try {
        snapshot = this.stateStore.initialize(
          agentInstanceId,
          implementation.initialContext(config),
          implementation.initialState(config),
        );
      } catch {
        snapshot = this.stateStore.get(agentInstanceId);
      }
    }
    if (!snapshot) {
      this.emitEvent(
        nextEventId("agent.failed"),
        "agent.failed",
        null,
        undefined,
        request,
      );
      return {
        status: "failed",
        error: {
          standard: {
            code: "workloop-error",
            message: `no runtime snapshot for agent: ${agentInstanceId}`,
            retryable: false,
          },
        },
        context: this.emptyContext(),
        state: {},
      };
    }

    const expectedVersion = snapshot.version;
    const inputContext = snapshot.value.context;
    const inputState = snapshot.value.state;

    // ── Emit agent.started ──────────────────────────────────────
    this.emitLifecycleEvent(
      nextEventId("agent.started"),
      "agent.started",
      request,
    );

    // ── Build SDK ───────────────────────────────────────────────
    const sdk = this.buildSDK(request, nextEventId, signal);

    // ── Emit workloop.started ──────────────────────────────────
    this.emitLifecycleEvent(
      nextEventId("workloop.started"),
      "workloop.started",
      request,
    );

    // ── Invoke implementation ──────────────────────────────────
    const input: WorkLoopInput = {
      traceId,
      executionId,
      agentInstanceId,
      optimizationRoundId,
      task,
      context: inputContext,
      config: config as Readonly<unknown>,
      state: inputState,
    };

    let result: WorkLoopResult;
    try {
      // MachineRuntime 驱动（Task 6）：machine 必填（契约重构后，run 已删除）；
      // executor 由 workloop 工厂创建并挂在 implementation.executor（runner 只读）。
      let resumeFrom: ResumeState | undefined;
      if (request.resumeFromCheckpointId) {
        try {
          const cp = this.checkpointStore.get(
            agentInstanceId,
            request.resumeFromCheckpointId,
          );
          resumeFrom = MachineRuntime.resumeStateOf(cp);
        } catch {
          // checkpoint 不存在 → 容错按全新 run 处理（resume 信息缺失不致命）
        }
      }
      const runtime = new MachineRuntime({
        machine: implementation.machine,
        input,
        sdk,
        executor: implementation.executor,
        budgets: { maxTurns: request.maxTurns ?? 100 },
        resumeFrom,
      });
      const runResult = await runtime.run();
      result = runResult.result;
    } catch (err) {
      // Thrown error → workloop-error
      if (signal?.aborted) {
        this.emitLifecycleEvent(
          nextEventId("agent.cancelled"),
          "agent.cancelled",
          request,
        );
        return {
          status: "cancelled",
          context: inputContext,
          state: inputState,
        };
      }

      this.emitLifecycleEvent(nextEventId("workloop.failed"), "workloop.failed", request);
      this.emitLifecycleEvent(nextEventId("agent.failed"), "agent.failed", request);

      return {
        status: "failed",
        error: {
          standard: {
            code: "workloop-error",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
        },
        context: inputContext,
        state: inputState,
      };
    }

    // ── Handle result status ───────────────────────────────────

    if (result.status === "completed") {
      // Emit workloop.completed
      this.emitLifecycleEvent(
        nextEventId("workloop.completed"),
        "workloop.completed",
        request,
      );

      // ── CAS commit ──────────────────────────────────────────
      try {
        this.stateStore.commit(
          agentInstanceId,
          result.context,
          result.state,
          expectedVersion,
        );
      } catch (err) {
        if (err instanceof VersionConflictError) {
          // Reload winning state
          const winning = this.stateStore.get(agentInstanceId);
          this.emitLifecycleEvent(
            nextEventId("agent.failed"),
            "agent.failed",
            request,
          );
          return {
            status: "failed",
            error: {
              standard: {
                code: "state-conflict",
                message: `CAS conflict: expected version ${expectedVersion}`,
                retryable: true,
              },
            },
            context: winning?.value.context ?? inputContext,
            state: winning?.value.state ?? inputState,
          };
        }
        throw err;
      }

      // Emit agent.completed
      this.emitLifecycleEvent(
        nextEventId("agent.completed"),
        "agent.completed",
        request,
      );

      return result;
    }

    if (result.status === "cancelled" || signal?.aborted) {
      this.emitLifecycleEvent(
        nextEventId("agent.cancelled"),
        "agent.cancelled",
        request,
      );
      return {
        status: "cancelled",
        context: result.context ?? inputContext,
        state: result.state ?? inputState,
      };
    }

    // failed / paused → do not commit
    if (result.status === "failed") {
      this.emitLifecycleEvent(nextEventId("workloop.failed"), "workloop.failed", request);
      this.emitLifecycleEvent(nextEventId("agent.failed"), "agent.failed", request);
    }

    // paused: still emit agent.completed? No — paused is not committed.
    if (result.status === "paused") {
      this.emitLifecycleEvent(nextEventId("agent.paused"), "agent.paused", request);
    }

    return result;
  }

  // ── SDK factory ──────────────────────────────────────────────────

  private buildSDK(
    request: WorkLoopRunRequest,
    nextEventId: (eventType: string) => string,
    signal?: AbortSignal,
  ): WorkLoopSDK {
    const {
      traceId,
      executionId,
      agentInstanceId,
      optimizationRoundId,
      workLoopId,
      workLoopVersion,
    } = request;

    const storageNs = `agent:${agentInstanceId}:workloop`;

    return {
      context: createContextOperations(),

      model: createInstrumentedModelPort(this.model, {
        emit: (
          eventType: string,
          payload: unknown,
          metrics?: Record<string, string | number | boolean | null>,
        ) => {
          this.emitEvent(nextEventId(eventType), eventType, payload, metrics, request);
        },
      }),

      tools: this.tools,

      artifacts: this.artifacts,

      storage: {
        get<T>(key: string) {
          return this._store.get<T>(storageNs, key);
        },
        put<T>(key: string, value: T, expectedVersion: number) {
          return this._store.put<T>(storageNs, key, value, expectedVersion);
        },
        _store: this.storage,
      } as WorkLoopSDK["storage"] & { _store: NamespacedStore },

      checkpoint: {
        save: async (
          context: WorkContext,
          state: unknown,
          opts?: string | { label?: string; controlState?: string; seq?: number },
        ) => {
          const checkpointId = crypto.randomUUID();
          const record: CheckpointRecord = {
            checkpointId,
            agentInstanceId,
            executionId,
            workLoopId,
            workLoopVersion,
            optimizationRoundId,
            context,
            state,
            createdAt: Date.now(),
          };
          // 向后兼容字符串 label（旧调用形式）；对象形式携带 controlState/seq
          // （MachineRuntime 自动 checkpoint 写入，resume 时重建）。
          if (typeof opts === "string") {
            record.label = opts;
          } else if (opts) {
            if (opts.label !== undefined) record.label = opts.label;
            if (opts.controlState !== undefined) record.controlState = opts.controlState;
            if (opts.seq !== undefined) record.seq = opts.seq;
          }
          this.checkpointStore.save(agentInstanceId, record);

          this.emitEvent(
            nextEventId("checkpoint.created"),
            "checkpoint.created",
            { checkpointId, label: record.label },
            undefined,
            request,
          );

          return { checkpointId };
        },
      },

      telemetry: {
        emit: (
          eventType: string,
          payload: unknown,
          metrics?: Record<string, string | number | boolean | null>,
          identity?: { transitionSeq?: number; checkpointId?: string },
        ) => {
          this.emitEvent(nextEventId(eventType), eventType, payload, metrics, request, identity);
        },
      },

      control: {
        signal: signal ?? new AbortController().signal,
        throwIfCancelled() {
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted", "AbortError");
          }
        },
      },
    };
  }

  // ── Event helpers ────────────────────────────────────────────────

  private emitLifecycleEvent(
    eventId: string,
    eventType: string,
    request: WorkLoopRunRequest,
  ): void {
    this.emitEvent(eventId, eventType, null, undefined, request);
  }

  private emitEvent(
    eventId: string,
    eventType: string,
    payload: unknown,
    metrics: Record<string, string | number | boolean | null> | undefined,
    request: WorkLoopRunRequest | undefined,
    identity?: { transitionSeq?: number; checkpointId?: string },
  ): void {
    const event: LabEvent = {
      eventId,
      eventType,
      schemaVersion: "1.0",
      timestamp: Date.now(),
      identity: {
        traceId: request?.traceId ?? "",
        executionId: request?.executionId ?? "",
        agentInstanceId: request?.agentInstanceId ?? "",
        optimizationRoundId: request?.optimizationRoundId ?? "",
        workLoopId: request?.workLoopId ?? "",
        workLoopVersion: request?.workLoopVersion ?? "",
        ...(request?.schedulerInstanceId ? { schedulerInstanceId: request.schedulerInstanceId } : {}),
        ...(request?.dispatchId ? { dispatchId: request.dispatchId } : {}),
        ...(identity?.transitionSeq !== undefined ? { transitionSeq: identity.transitionSeq } : {}),
        ...(identity?.checkpointId ? { checkpointId: identity.checkpointId } : {}),
      },
      payload: payload ?? {},
      metrics,
    };
    this.eventLog.append(event);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private emptyContext(): WorkContext {
    return {
      messages: [],
      metadata: { contextId: "", sourceRefs: [], artifactRefs: [] },
    };
  }

  private emptyResult(status: WorkLoopResult["status"]): WorkLoopResult {
    return {
      status,
      context: this.emptyContext(),
      state: {},
    };
  }
}
