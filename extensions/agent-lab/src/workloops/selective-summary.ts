/**
 * selective-summary@1.0.0 — context-management strategy that summarises
 * the oldest message segment via a dedicated LLM call when the context
 * exceeds the token budget, preserving system prompt + newest messages.
 *
 * ## Strategy
 *
 * 1. Compute current token count via `contextTokenTotal`.
 * 2. If under `budgetTokens` (default 8192): no transform.
 * 3. If over: select the oldest fraction of messages (config.summaryWindow,
 *    default 0.5) and call `sdk.model.complete` with a summarisation
 *    system prompt.  config.summaryModel, when set, overrides the main
 *    model for the summary call.
 * 4. Replace that oldest segment with ONE summary message (role "user",
 *    content prefixed `[summary] `).  Keep systemPrompt + newest messages.
 * 5. Emit `context.summary.created` (P6b cost attribution) BEFORE
 *    `context.transformed` (kind "summarize").
 * 6. Hard caps: config.maxSummaryCalls (default 1 per run) enforced via
 *    sdk.storage; summary model calls count toward managed-loop maxModelCalls
 *    via the `summaryCalls` return field.
 * 7. Fail-open: if the summarisation model call throws, fall back to
 *    budgeted truncation of the same oldest segment (kind "truncate",
 *    fallback:true in payload) — never crash the run.
 *
 * ## cloneModes
 *
 * Only `"fresh"` is declared — matches `SELECTIVE_SUMMARY_DEFINITION` in
 * `src/runtime/create-experiment-runtime.ts`.
 *
 * @module selective-summary
 */

import { estimateTokens, contextTokenTotal } from "./context-metrics.ts";
import { emitContextTransform, emitSummaryCreated } from "./context-events.ts";
import { managedMachine } from "./managed-loop.ts";
import type { ManagedLoopConfig, StrategyHook } from "./managed-loop.ts";
import type {
  WorkLoopImplementation,
  WorkContext,
  WorkLoopSDK,
  WorkMessage,
} from "../workloop/contracts.ts";

// ── Constants ───────────────────────────────────────────────────────

const STORAGE_KEY_CALL_COUNT = "_selective-summary:callCount";

const SUMMARIZATION_SYSTEM_PROMPT =
  "Summarize the following conversation segment concisely. " +
  "Preserve key facts, decisions, and context that are relevant for continuing the conversation. " +
  "Output only the summary text — no preamble, no meta-commentary.";

// ── Strategy hook ───────────────────────────────────────────────────

/**
 * Create the selective-summary strategy hook.
 *
 * The strategy makes an LLM call for summarisation (via sdk.model.complete)
 * and attributes its cost via `context.summary.created`.  If the summary
 * call fails the strategy falls back to budgeted truncation.
 */
function createSelectiveSummaryStrategy(): StrategyHook {
  return {
    budgetThreshold(config: Record<string, unknown>): number {
      return (config.budgetTokens as number | undefined) ?? 8192;
    },

    async transform(
      context: WorkContext,
      config: Record<string, unknown>,
      sdk: WorkLoopSDK,
    ): Promise<{ context: WorkContext; transformed: boolean; summaryCalls?: number }> {
      const budgetTokens = (config.budgetTokens as number | undefined) ?? 8192;
      const maxSummaryCalls = (config.maxSummaryCalls as number | undefined) ?? 1;
      const summaryWindow = (config.summaryWindow as number | undefined) ?? 0.5;
      const summaryModel = config.summaryModel as string | undefined;

      // ── Fast path: under budget ─────────────────────────────
      const beforeTokens = contextTokenTotal(context);
      if (beforeTokens <= budgetTokens) {
        return { context, transformed: false };
      }

      // ── Enforce maxSummaryCalls via storage ─────────────────
      const stored = sdk.storage.get<number>(STORAGE_KEY_CALL_COUNT);
      const callCount = stored?.value ?? 0;
      if (callCount >= maxSummaryCalls) {
        // Already hit the cap — fall back to truncation
        return fallbackTruncate(context, sdk, beforeTokens, budgetTokens);
      }

      // ── Compute oldest segment ──────────────────────────────
      const messages = context.messages;
      const splitIdx = Math.max(1, Math.floor(messages.length * summaryWindow));
      const oldestSegment = messages.slice(0, splitIdx);
      const newestSegment = messages.slice(splitIdx);

      if (oldestSegment.length === 0) {
        return fallbackTruncate(context, sdk, beforeTokens, budgetTokens);
      }

      // ── Summarisation call ──────────────────────────────────
      try {
        // Bump call count BEFORE the model call so that a crash
        // after the call but before the storage write doesn't allow
        // an extra call (worst case we lose one call, not gain one).
        const newCount = callCount + 1;
        const storedVersion = stored?.version ?? 0;
        try {
          sdk.storage.put(STORAGE_KEY_CALL_COUNT, newCount, storedVersion);
        } catch {
          // Storage write failed — still proceed but don't fail the run.
        }

        const summaryOptions: Record<string, unknown> = {
          strategyId: "selective-summary",
        };
        if (summaryModel) {
          summaryOptions.model = summaryModel;
        }

        // Build a context for the summary call: the oldest segment
        // without the system prompt (the summary system prompt replaces it).
        const summaryContext: WorkContext = {
          systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
          messages: oldestSegment.map((m) => ({ ...m })),
          metadata: {
            contextId: `ctx-summary-${crypto.randomUUID()}`,
            parentContextId: context.metadata.contextId,
            sourceRefs: [...context.metadata.sourceRefs],
            artifactRefs: [...context.metadata.artifactRefs],
          },
        };

        const summaryResult = await sdk.model.complete(summaryContext, summaryOptions);

        // ── Emit context.summary.created BEFORE transformed ───
        if (summaryResult.usage) {
          const usageAny = summaryResult.usage as Record<string, unknown>;
          emitSummaryCreated(sdk.telemetry, {
            strategyId: "selective-summary",
            inputTokens: summaryResult.usage.input,
            outputTokens: summaryResult.usage.output,
            cost: summaryResult.usage.cost,
            durationMs: summaryResult.usage.durationMs,
            source: (usageAny._source === "derived" ? "derived" : "observed"),
          });
        } else {
          // Usage absent entirely — emit with zeros and derived source.
          emitSummaryCreated(sdk.telemetry, {
            strategyId: "selective-summary",
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            durationMs: 0,
            source: "derived",
          });
        }

        // ── Build summary message ─────────────────────────────
        const summaryText =
          typeof summaryResult.message.content === "string"
            ? summaryResult.message.content
            : JSON.stringify(summaryResult.message.content);
        const summaryMessage: WorkMessage = {
          role: "user",
          content: `[summary] ${summaryText}`,
        };

        // ── Build new context ─────────────────────────────────
        const newContextId = `ctx-${crypto.randomUUID()}`;
        const newMessages = [summaryMessage, ...newestSegment.map((m) => ({ ...m }))];
        const newContext: WorkContext = {
          systemPrompt: context.systemPrompt,
          messages: newMessages,
          tools: context.tools,
          metadata: {
            contextId: newContextId,
            parentContextId: context.metadata.contextId,
            sourceRefs: [...context.metadata.sourceRefs],
            artifactRefs: [...context.metadata.artifactRefs],
          },
        };

        const afterTokens = contextTokenTotal(newContext);

        // ── Emit context.transformed (AFTER summary.created) ──
        emitContextTransform(sdk.telemetry, {
          strategyId: "selective-summary",
          kind: "summarize",
          beforeTokens,
          afterTokens,
          droppedSegments: oldestSegment.length,
        });

        return { context: newContext, transformed: true, summaryCalls: 1 };
      } catch {
        // ── Fail-open: fall back to truncation ────────────────
        return fallbackTruncate(context, sdk, beforeTokens, budgetTokens);
      }
    },
  };
}

// ── Fallback truncation ─────────────────────────────────────────────

/**
 * Budgeted truncation used as a fail-open fallback when the summarisation
 * LLM call throws.  Drops oldest messages first, keeping system prompt
 * and most-recent messages within the budget.
 *
 * Emits `context.transformed` with kind "truncate" and `fallback: true`.
 */
async function fallbackTruncate(
  context: WorkContext,
  sdk: WorkLoopSDK,
  beforeTokens: number,
  budgetTokens: number,
): Promise<{ context: WorkContext; transformed: boolean }> {
  const messages = context.messages;
  const kept: typeof messages = [];
  let keptTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const msgTokens = estimateTokens(msg.content);
    if (keptTokens + msgTokens <= budgetTokens) {
      kept.unshift(msg);
      keptTokens += msgTokens;
    } else {
      break;
    }
  }

  const droppedSegments = messages.length - kept.length;
  const newContextId = `ctx-${crypto.randomUUID()}`;
  const newContext: WorkContext = {
    systemPrompt: context.systemPrompt,
    messages: kept,
    tools: context.tools,
    metadata: {
      contextId: newContextId,
      parentContextId: context.metadata.contextId,
      sourceRefs: [...context.metadata.sourceRefs],
      artifactRefs: [...context.metadata.artifactRefs],
    },
  };

  const afterTokens = contextTokenTotal(newContext);

  emitContextTransform(sdk.telemetry, {
    strategyId: "selective-summary",
    kind: "truncate",
    beforeTokens,
    afterTokens,
    droppedSegments,
    fallback: true,
  });

  return { context: newContext, transformed: true };
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * 创建 selective-summary@1.0.0 WorkLoopImplementation（machine 驱动）。
 *
 * - config：ManagedLoopConfig + 策略扩展配置（budgetTokens / maxSummaryCalls /
 *   summaryWindow / summaryModel 等），工厂参数传入（原 input.config 改为工厂参数）。
 * - initialContext: an empty context seeded with a system prompt from
 *   config if provided.
 * - initialState: initialises the per-run summary call counter.
 * - machine: managedMachine(config, selective-summary strategy) 五状态机。
 * - cloneModes: `["fresh"]` — matches `SELECTIVE_SUMMARY_DEFINITION`.
 */
export function createSelectiveSummaryLoop(config: ManagedLoopConfig = { model: "default" }): WorkLoopImplementation {
  return {
    id: "selective-summary",
    version: "1.0.0",
    cloneModes: ["fresh"],
    executorKind: "local-model",

    initialContext(cfg: unknown): WorkContext {
      const c = cfg as Record<string, unknown> | undefined;
      return {
        systemPrompt: typeof c?.systemPrompt === "string" ? c.systemPrompt : undefined,
        messages: [],
        tools: undefined,
        metadata: {
          contextId: "ctx-initial",
          sourceRefs: [],
          artifactRefs: [],
        },
      };
    },

    initialState(_config: unknown): unknown {
      return {};
    },

    machine: managedMachine(config, createSelectiveSummaryStrategy()),
  };
}

/**
 * 默认实例（兼容现有注册方/形状断言）；等价 createSelectiveSummaryLoop()。
 * 已迁移为 machine 驱动，不再提供 run。
 */
export const selectiveSummary: WorkLoopImplementation = createSelectiveSummaryLoop();
