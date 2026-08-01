import type { PiSubagentsAdapter } from "../runtime/pi-subagents-adapter.ts";
import type {
  SubagentDelegationV2Request,
  SubagentDelegationV2Update,
  SubagentDelegationV2TerminalResponse,
  SubagentDelegationV2Status,
  SubagentDelegationV2Thinking,
  SubagentDelegationV2ResultRequest,
  SubagentDelegationTurnBudget,
  SubagentDelegationToolBudget,
} from "../runtime/delegation-v2.ts";
import { SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION } from "../runtime/delegation-v2.ts";
import type {
  WorkLoopImplementation,
  WorkLoopInput,
  WorkLoopResult,
  WorkLoopSDK,
  WorkContext,
  StandardAgentOutput,
} from "../workloop/contracts.ts";
import type { ExecutorContext } from "../workloop/machine.ts";
import { PiDelegateExecutor } from "./executors/pi-delegate-executor.ts";

// ── Config ──────────────────────────────────────────────────────────

export interface PiDefaultLoopConfig {
  agent: string;
  cwd: string;
  contextMode: "fresh" | "fork";
  model?: string;
  thinking?: SubagentDelegationV2Thinking;
  timeoutMs?: number;
  result?: SubagentDelegationV2ResultRequest;
  skill?: string | string[] | boolean;
  turnBudget?: SubagentDelegationTurnBudget;
  toolBudget?: SubagentDelegationToolBudget;
}

// ── Status → WorkLoopResult mapping ────────────────────────────────

/**
 * Terminal status → WorkLoopStatus + error code + retryable.
 *
 * Completed: maps directly.
 * Failed family (non-retryable): failed, turn_budget_exhausted,
 *   tool_budget_exhausted, structured_output_failed, invalid_request.
 * Failed family (retryable): timed_out, unavailable_context, duplicate_node.
 * Cancelled family: cancelled, interrupted.
 */
const FAILED_NON_RETRYABLE: SubagentDelegationV2Status[] = [
  "failed",
  "turn_budget_exhausted",
  "tool_budget_exhausted",
  "structured_output_failed",
  "invalid_request",
];

const FAILED_RETRYABLE: SubagentDelegationV2Status[] = [
  "timed_out",
  "unavailable_context",
  "duplicate_node",
];

const CANCELLED_STATUSES: SubagentDelegationV2Status[] = [
  "cancelled",
  "interrupted",
];

// ── Helpers ─────────────────────────────────────────────────────────

function buildV2Request(
  input: WorkLoopInput<PiDefaultLoopConfig>,
  ectx: ExecutorContext,
): SubagentDelegationV2Request {
  const cfg = input.config;
  // 委托式投影入任务文本（spec §2.6/§5.2）：ectx.deriveDsp() 派生的
  // 状态投影（idle/delegating 的 projection）+ 预算/序号 作为任务前缀，
  // 原 task 保留在末尾。derive 时刻在 executor 首个事件拉取（delegating
  // 状态，转移后）——故 delegating 也声明投影（见 machine.states）。
  const dsp = ectx.deriveDsp();
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: input.executionId,
    ownerRunId: input.traceId,
    nodeId: input.agentInstanceId,
    agent: cfg.agent,
    task: dsp ? `${dsp}\n\n${input.task}` : input.task,
    context: cfg.contextMode,
    cwd: cfg.cwd,
    model: cfg.model,
    thinking: cfg.thinking,
    timeoutMs: cfg.timeoutMs,
    result: cfg.result ?? { kind: "text" },
    skill: cfg.skill,
    turnBudget: cfg.turnBudget,
    toolBudget: cfg.toolBudget,
  };
}

function mapUsage(
  usage: SubagentDelegationV2TerminalResponse["usage"],
): StandardAgentOutput["usage"] | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
    turns: usage.turns,
    toolCalls: usage.toolCalls,
    durationMs: usage.durationMs,
  };
}

function appendAssistantMessage(
  context: WorkContext,
  text: string,
  newContextId: string,
): WorkContext {
  return {
    systemPrompt: context.systemPrompt,
    messages: [
      ...context.messages,
      { role: "assistant" as const, content: text },
    ],
    tools: context.tools ? [...context.tools] : undefined,
    metadata: {
      contextId: newContextId,
      parentContextId: context.metadata.contextId,
      sourceRefs: [...context.metadata.sourceRefs],
      artifactRefs: [...context.metadata.artifactRefs],
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a pi-default-loop WorkLoopImplementation backed by the
 * PiSubagentsAdapter for V2 delegation transport.
 *
 * Task 5 迁移：run() → 四状态机（idle → delegating → terminal）+ 委托式
 * PiDelegateExecutor。工厂创建 executor 并挂 implementation.executor
 * （runner 只读此字段，Task 6 接线 MachineRuntime 驱动）。
 *
 * Maps WorkLoopInput identity fields:
 *   executionId → requestId
 *   traceId     → ownerRunId
 *   agentInstanceId → nodeId
 *
 * The WorkContext is NOT passed to pi-subagents; only config.contextMode
 * controls the pi session fresh/fork choice. 委托式投影（spec §2.6）经
 * buildRequest 闭包把 ectx.deriveDsp() 并入任务文本（见 buildV2Request）。
 */
export function createPiDefaultLoop(
  adapter: PiSubagentsAdapter,
): WorkLoopImplementation {
  // 委托式执行器：工厂创建并挂载（local-model 不提供 executor 实例）
  const executor = new PiDelegateExecutor(adapter, buildV2Request);

  return {
    id: "pi-default-loop",
    version: "1.0.0",
    cloneModes: ["fresh", "fork"],
    executorKind: "pi-delegate",
    executor,

    initialContext(_config: unknown): WorkContext {
      const ctxId = crypto.randomUUID();
      return {
        messages: [],
        metadata: {
          contextId: ctxId,
          sourceRefs: [],
          artifactRefs: [],
        },
      };
    },

    initialState(_config: unknown): unknown {
      return {};
    },

    machine: {
      states: [
        {
          id: "idle",
          projection: () => "任务已委托给 pi（fresh/fork 由配置决定）",
        },
        // delegating 同样声明投影：委托式投影入任务文本在 buildRequest 闭包内
        // 经 ectx.deriveDsp() 完成，而 derive 时刻（executor 首个事件拉取，
        // idle→delegating 转移之后）控制状态已是 delegating——投影仅放 idle
        // 无法进入任务文本（spec §5.2：委托式投影并入任务文本）。
        {
          id: "delegating",
          projection: () => "任务已委托给 pi（fresh/fork 由配置决定）",
        },
        { id: "terminal", terminal: true },
      ],
      initial: "idle",
      transitions: (state, event) => {
        if (state === "idle" && event.type === "start") return "delegating";
        if (state === "delegating" && event.type === "pi_update") return "delegating";
        if (state === "delegating" && event.type === "pi_terminal") return "terminal";
        return undefined;
      },
      step: async (ctx, state, event, sdk) => {
        if (event.type === "start") {
          // 委托在 executor.start 时发起（MachineRuntime 启动即调用）；
          // δ 无自驱动事件——runtime 转移后从 executor 事件流取
          // pi_update / pi_terminal。
          return { context: ctx, state };
        }
        if (event.type === "pi_update") {
          // 镜像：pi 进度 → Trace（保留原 onUpdate 的 metrics 映射）
          const update = event.payload as SubagentDelegationV2Update;
          sdk.telemetry.emit("pi.progress", update, {
            ...(update.toolCount !== undefined ? { toolCount: update.toolCount } : {}),
            ...(update.tokens !== undefined ? { tokens: update.tokens } : {}),
            ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
          });
          return { context: ctx, state };
        }
        if (event.type === "pi_terminal") {
          const response = event.payload as SubagentDelegationV2TerminalResponse;
          return { context: ctx, state, terminal: mapResponse(response, ctx, state) };
        }
        return { context: ctx, state };
      },
    },
  };
}

// ── Response mapping ────────────────────────────────────────────────

function mapResponse(
  response: SubagentDelegationV2TerminalResponse,
  inputContext: WorkContext,
  inputState: unknown,
): WorkLoopResult {
  const status = response.status;

  // Completed
  if (status === "completed") {
    const resultKind = response.result?.kind;
    const newContextId = crypto.randomUUID();

    let context: WorkContext;
    if (resultKind === "text" && response.result && "text" in response.result) {
      context = appendAssistantMessage(inputContext, response.result.text, newContextId);
    } else {
      // Structured or no result: keep context unchanged
      context = {
        ...inputContext,
        metadata: {
          ...inputContext.metadata,
          contextId: newContextId,
        },
      };
    }

    const standard: StandardAgentOutput = {};
    if (resultKind === "text" && response.result && "text" in response.result) {
      standard.text = response.result.text;
    }
    const usage = mapUsage(response.usage);
    if (usage) standard.usage = usage;

    const custom =
      resultKind === "structured" && response.result && "value" in response.result
        ? response.result.value
        : undefined;

    return {
      status: "completed",
      output: {
        standard,
        ...(custom !== undefined ? { custom } : {}),
      },
      context,
      state: inputState,
    };
  }

  // Failed family — non-retryable
  if (FAILED_NON_RETRYABLE.includes(status)) {
    return {
      status: "failed",
      error: {
        standard: {
          code: status,
          message: response.error ?? status,
          retryable: false,
        },
      },
      context: inputContext,
      state: inputState,
    };
  }

  // Failed family — retryable
  if (FAILED_RETRYABLE.includes(status)) {
    return {
      status: "failed",
      error: {
        standard: {
          code: status,
          message: response.error ?? status,
          retryable: true,
        },
      },
      context: inputContext,
      state: inputState,
    };
  }

  // Cancelled family
  if (CANCELLED_STATUSES.includes(status)) {
    return {
      status: "cancelled",
      context: inputContext,
      state: inputState,
    };
  }

  // Fallback: any unhandled terminal status → failed, not retryable
  return {
    status: "failed",
    error: {
      standard: {
        code: status,
        message: response.error ?? status,
        retryable: false,
      },
    },
    context: inputContext,
    state: inputState,
  };
}
