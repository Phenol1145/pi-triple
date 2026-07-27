import type { PiSubagentsAdapter } from "../runtime/pi-subagents-adapter.ts";
import type {
  SubagentDelegationV2Request,
  SubagentDelegationV2TerminalResponse,
  SubagentDelegationV2Status,
  SubagentDelegationV2Thinking,
  SubagentDelegationV2ResultRequest,
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

// ── Config ──────────────────────────────────────────────────────────

export interface PiDefaultLoopConfig {
  agent: string;
  cwd: string;
  contextMode: "fresh" | "fork";
  model?: string;
  thinking?: SubagentDelegationV2Thinking;
  timeoutMs?: number;
  result?: SubagentDelegationV2ResultRequest;
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
): SubagentDelegationV2Request {
  const cfg = input.config;
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: input.executionId,
    ownerRunId: input.traceId,
    nodeId: input.agentInstanceId,
    agent: cfg.agent,
    task: input.task,
    context: cfg.contextMode,
    cwd: cfg.cwd,
    model: cfg.model,
    thinking: cfg.thinking,
    timeoutMs: cfg.timeoutMs,
    result: cfg.result ?? { kind: "text" },
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
 * Maps WorkLoopInput identity fields:
 *   executionId → requestId
 *   traceId     → ownerRunId
 *   agentInstanceId → nodeId
 *
 * The WorkContext is NOT passed to pi-subagents; only config.contextMode
 * controls the pi session fresh/fork choice.
 */
export function createPiDefaultLoop(
  adapter: PiSubagentsAdapter,
): WorkLoopImplementation {
  return {
    id: "pi-default-loop",
    version: "1.0.0",
    cloneModes: ["fresh", "fork"],

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

    async run(
      input: WorkLoopInput<PiDefaultLoopConfig>,
      sdk: WorkLoopSDK,
    ): Promise<WorkLoopResult> {
      const v2req = buildV2Request(input);

      const response = await adapter.delegate(v2req, {
        onUpdate: (update) => {
          const metrics: Record<string, string | number | boolean | null> = {};
          if (update.durationMs !== undefined) metrics.durationMs = update.durationMs;
          if (update.tokens !== undefined) metrics.tokens = update.tokens;
          if (update.toolCount !== undefined) metrics.toolCount = update.toolCount;

          sdk.telemetry.emit("runtime.pi_subagents.update", update, metrics);
        },
        signal: sdk.control.signal,
      });

      return mapResponse(response, input.context, input.state);
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
