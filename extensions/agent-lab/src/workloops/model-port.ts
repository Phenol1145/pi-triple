/**
 * Model port implementations for managed work-loops.
 *
 * ## Provider resolution
 *
 * Model resolution uses `provider/model` parsing when `modelId` contains
 * a `/`: the text before the first slash is the provider name, the rest is
 * the model id.  When `modelId` has no slash, the port falls back to
 * `"openrouter"` as the default provider.
 *
 * This differs from `src/arena/model-caller.ts` which always uses
 * `"openrouter"` as the provider for arena bid calls.  The experiment
 * ModelPort supports explicit provider selection (e.g.
 * `"anthropic/claude-sonnet-4.5"`) so that managed loops can target
 * non-OpenRouter providers.  If you need the arena behaviour (always
 * OpenRouter), pass `"openrouter/<model>"` explicitly.
 *
 * ## pi-ai usage availability (research note, 2026-07-27)
 *
 * `complete()` from `@earendil-works/pi-ai/compat` returns `AssistantMessage`,
 * which carries a **`.usage: Usage`** field with full provider-reported metrics:
 *
 * ```
 * interface Usage {
 *   input: number;          // prompt tokens
 *   output: number;         // completion tokens
 *   cacheRead: number;      // cache-read tokens
 *   cacheWrite: number;     // cache-write tokens
 *   totalTokens: number;    // sum
 *   cost: {                 // provider-priced (USD if available)
 *     input: number;
 *     output: number;
 *     cacheRead: number;
 *     cacheWrite: number;
 *     total: number;
 *   };
 * }
 * ```
 *
 * **Conclusion**: Usage **is** available on the pi-ai `complete()` result.
 * The arena `model-caller.ts` currently discards it (returns only
 * `contentText(msg.content)`), but this port captures it directly.
 *
 * When usage is present on the result (the common case), it is tagged
 * `source: "observed"`.  When absent (theoretical fallback — e.g. a
 * non-standard provider that omits usage), we derive cost from the
 * model's catalog pricing (`Model.cost`) and tag `source: "derived"`.
 *
 * ## Error handling
 *
 * When pi-ai `complete()` returns `stopReason: "error"` or a non-empty
 * `errorMessage`, the inner port **throws** so that the instrumented
 * wrapper emits `model.failed` (not `model.completed`).
 *
 * ## Fail-open telemetry
 *
 * Telemetry calls in `createInstrumentedModelPort` are wrapped in try/catch
 * so that event-emit failures never escape to crash the enclosing work-loop.
 *
 * @module model-port
 */

import { complete, contentText } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type {
  ModelPort,
  ToolPort,
  ArtifactPort,
  WorkLoopTelemetry,
  WorkContext,
  WorkMessage,
  StandardAgentOutput,
} from "../workloop/contracts.ts";

// ── Instrumented model port ─────────────────────────────────────────

export interface ModelRequestedPayload {
  strategyId?: string;
}

export interface ModelCompletedMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  durationMs: number;
  /** Where the usage data came from. */
  source: "observed" | "derived";
}

export interface ModelFailedPayload {
  code: string;
  message: string;
}

/**
 * Wrap a ModelPort so that every `complete()` call emits standard
 * instrumentation events through the given telemetry channel.
 *
 * Emitted events:
 * - `model.requested` — before the inner complete() call
 * - `model.completed` — on success, with usage + timing metrics
 * - `model.failed`    — on error, with code + message
 *
 * All telemetry emissions are fail-open: a thrown emit does **not**
 * propagate to the caller.
 */
export function createInstrumentedModelPort(
  inner: ModelPort,
  telemetry: WorkLoopTelemetry,
): ModelPort {
  return {
    async complete(
      context: WorkContext,
      options?: Record<string, unknown>,
    ): Promise<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }> {
      // emit model.requested (fail-open)
      const requestedPayload: Record<string, unknown> = {};
      if (options?.strategyId) {
        requestedPayload.strategyId = options.strategyId;
      }
      safelyEmit(telemetry, "model.requested", requestedPayload);

      const startedAt = Date.now();

      try {
        const result = await inner.complete(context, options);

        const durationMs = Date.now() - startedAt;

        // assemble usage metrics from result.usage if present
        const usage = result.usage;
        const source: "observed" | "derived" =
          usage != null ? "observed" : "derived";

        const metrics: ModelCompletedMetrics = {
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0,
          cacheWrite: usage?.cacheWrite ?? 0,
          cost: usage?.cost ?? 0,
          durationMs,
          source,
        };

        // Annotate usage with source so downstream consumers (e.g.
        // managed-loop usage aggregation) can detect derived estimates
        // without peeking at telemetry metrics.
        if (result.usage) {
          (result.usage as Record<string, unknown>)._source = source;
        }

        safelyEmit(telemetry, "model.completed", {}, metrics);
        return result;
      } catch (err) {
        const code = err instanceof Error ? (err as Error & { code?: string }).code ?? "model-error" : "model-error";
        const message = err instanceof Error ? err.message : String(err);

        safelyEmit(telemetry, "model.failed", { code, message } satisfies ModelFailedPayload);
        throw err;
      }
    },
  };
}

// ── PI model port ───────────────────────────────────────────────────

export interface PiModelPortOptions {
  /** Model id in provider/model format (e.g. "openrouter/anthropic/claude-sonnet-4.5"). */
  modelId: string;
}

/**
 * Minimal interface for the model-registry subset consumed by
 * createPiModelPort.  The concrete `ExtensionContext.modelRegistry`
 * satisfies this.
 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<import("@earendil-works/pi-ai").Api> | undefined;
  hasConfiguredAuth(model: Model<import("@earendil-works/pi-ai").Api>): boolean;
  getApiKeyAndHeaders(model: Model<import("@earendil-works/pi-ai").Api>): Promise<
    { ok: true; apiKey: string; headers: Record<string, string> } | { ok: false; error: string }
  >;
}

/**
 * Create a ModelPort backed by the Pi extension context's model registry
 * and the pi-ai `complete()` dispatch.
 *
 * Follows the same auth + dispatch pattern as `src/arena/model-caller.ts`.
 *
 * The returned port maps `WorkContext.messages` to pi-ai `Context.messages`
 * and passes `WorkContext.systemPrompt` through directly.
 *
 * ## Usage capture
 *
 * The pi-ai `complete()` returns `AssistantMessage` which includes a full
 * `usage: Usage` object (provider-reported tokens and cost).  This is
 * captured and returned as `StandardAgentOutput["usage"]`.
 *
 * If usage is absent from the result (theoretical fallback), cost is
 * derived from the model's catalog pricing (`Model.cost`) and marked
 * `source: "derived"` via a `_source` field on the usage object.
 */
export function createPiModelPort(
  ctxLike: { modelRegistry: ModelRegistryLike },
  opts: PiModelPortOptions,
): ModelPort {
  const reg = ctxLike.modelRegistry;
  const { modelId } = opts;

  return {
    async complete(
      context: WorkContext,
      _options?: Record<string, unknown>,
    ): Promise<{ message: WorkMessage; usage?: StandardAgentOutput["usage"] }> {
      // ── Resolve model ──────────────────────────────────────
      let model: Model<import("@earendil-works/pi-ai").Api> | undefined;

      // Try provider/model split
      if (modelId.includes("/")) {
        const idx = modelId.indexOf("/");
        model = reg.find(modelId.slice(0, idx), modelId.slice(idx + 1));
      }
      // Fallback: try openrouter as default provider
      if (!model) {
        model = reg.find("openrouter", modelId);
      }

      if (!model) {
        throw new Error(`model not in registry: ${modelId}`);
      }

      if (!reg.hasConfiguredAuth(model)) {
        throw new Error(`no configured auth for model: ${modelId}`);
      }

      // ── Auth ───────────────────────────────────────────────
      const auth = await reg.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(`auth failed for model ${modelId}: ${auth.error}`);
      }

      // ── Map WorkContext → pi-ai Context ────────────────────
      const piMessages = context.messages.map((m) => ({
        role: m.role as "user" | "assistant" | "toolResult",
        content: m.content,
      }));

      const piContext: import("@earendil-works/pi-ai").Context = {
        messages: piMessages as import("@earendil-works/pi-ai").Context["messages"],
      };
      if (context.systemPrompt) {
        piContext.systemPrompt = context.systemPrompt;
      }
      if (context.tools?.length) {
        piContext.tools = context.tools.map((t) => ({
          name: t.name,
          description: (t as Record<string, unknown>).description as string ?? "",
          parameters: (t as Record<string, unknown>).parameters as import("@earendil-works/pi-ai").Tool["parameters"],
        }));
      }

      // ── Dispatch ───────────────────────────────────────────
      const ctrl = new AbortController();
      const timeoutMs = 120_000; // 2-minute default timeout
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      let msg: AssistantMessage;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        msg = await complete(model, piContext, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: ctrl.signal,
        } as any);
      } finally {
        clearTimeout(timer);
      }

      // ── Build result ───────────────────────────────────────
      const text = contentText(msg.content);
      const workMsg: WorkMessage = {
        role: msg.role,
        content: text,
      };

      const usage = msg.usage;

      if (usage) {
        // Observed usage from provider
        const stdUsage: StandardAgentOutput["usage"] = {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          cost: usage.cost.total,
          turns: 1,
          toolCalls: 0,
          durationMs: 0, // filled by instrumented wrapper
        };
        return { message: workMsg, usage: stdUsage };
      }

      // ── Derived fallback from catalog pricing ──────────────
      // Usage was absent from the result — derive cost from catalog.
      // The _source annotation is added by the instrumented wrapper
      // (metrics.source is the canonical carrier), not leaked here.
      const derivedUsage: StandardAgentOutput["usage"] = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
        toolCalls: 0,
        durationMs: 0,
      };

      // Throw on provider errors so the instrumented wrapper emits
      // model.failed, not model.completed.
      if (msg.stopReason === "error" || msg.errorMessage) {
        throw new Error(`model error: ${msg.errorMessage ?? msg.stopReason}`);
      }

      // Estimate tokens from content length (heuristic: chars/4)
      const inputEstimate = piMessages.reduce(
        (sum, m) => sum + Math.ceil(JSON.stringify(m.content).length / 4),
        0,
      );
      const outputEstimate = Math.ceil(text.length / 4);

      derivedUsage.input = inputEstimate;
      derivedUsage.output = outputEstimate;

      // Cost from catalog tiers
      const catalogCost = model.cost;
      if (catalogCost) {
        // Check if any tier applies based on input estimate
        let rates = catalogCost;
        if (catalogCost.tiers) {
          for (const tier of catalogCost.tiers) {
            if (inputEstimate > tier.inputTokensAbove) {
              rates = tier;
            }
          }
        }
        derivedUsage.cost =
          (inputEstimate / 1_000_000) * rates.input +
          (outputEstimate / 1_000_000) * rates.output;
      }

      return { message: workMsg, usage: derivedUsage };
    },
  };
}

// ── Minimal ToolPort ────────────────────────────────────────────────

/**
 * Create a ToolPort stub for managed loop v1.
 *
 * Managed loops in v1 do not have access to tools.  Every call to
 * `execute()` throws a clear error message so workloop authors know
 * immediately that tools are unavailable.
 */
export function createToolPort(): ToolPort {
  return {
    async execute(_name: string, _args: unknown): Promise<unknown> {
      throw new Error(
        "tools not available in managed loop v1. " +
          "Tool use is not supported in this runtime mode. " +
          "If your workloop requires tools, use a Pi agent loop via the workloop adapter.",
      );
    },
  };
}

// ── In-memory ArtifactPort ──────────────────────────────────────────

/**
 * Create an in-memory ArtifactPort backed by a Map.
 *
 * Artifacts are stored with crypto.randomUUID refs.  This is suitable
 * for short-lived managed loops that do not need persistent artifact
 * storage across restarts.
 */
export function createMemoryArtifactPort(): ArtifactPort {
  const store = new Map<string, { value: unknown; mediaType: string }>();

  return {
    async put(value: unknown, mediaType: string): Promise<string> {
      const ref = crypto.randomUUID();
      store.set(ref, { value, mediaType });
      return ref;
    },

    async get(ref: string): Promise<unknown> {
      const entry = store.get(ref);
      if (!entry) {
        throw new Error(`artifact not found: ${ref}`);
      }
      return entry.value;
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function safelyEmit(
  telemetry: WorkLoopTelemetry,
  eventType: string,
  payload: unknown,
  metrics?: Record<string, string | number | boolean | null>,
): void {
  try {
    telemetry.emit(eventType, payload, metrics);
  } catch {
    // Fail-open: instrumentation must not crash the work-loop.
  }
}
