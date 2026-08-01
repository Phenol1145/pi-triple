/**
 * Managed loop machine — internal shared machine core for managed work-loops
 * (no standalone implementation / no registered WorkLoopDefinition).
 *
 * 消费方：budgeted-history / selective-summary（各自注册 Definition，经
 * managedMachine + StrategyHook 复用本核心）。不提供独立 `managed-loop`
 * implementation（createManagedLoop 工厂已删除，健康审计 F3）。
 *
 * ## Design
 *
 * Managed loops differ from general-purpose WorkLoopImplementations: they
 * have no tool access (v1), run a model-complete → append loop, and
 * delegate context-size management to a pluggable strategy hook.
 *
 * 五状态机 `managedMachine(config, strategyHook): MachineDefinition`：
 *
 *   check →（ctx_ok）→ call →（assistant_turn）→ append →（more）→ check …
 *   check →（over_budget）→ manage →（transformed）→ call
 *                                            （untransformable）→ done
 *   append →（max_calls）→ done
 *
 * 记忆域（ManagedMemory：calls / totals / hasDerived）跨转移存活，经
 * MachineRuntime 自动 checkpoint。终止 = δ 在 max_calls / untransformable
 * 事件时直接返回 terminal（含 usage 汇总 + 最后文本）；done 的 terminal:true
 * 仅作兜底（MachineRuntime 优先用 stepResult.terminal）。
 *
 * Every context mutation goes through `sdk.context` ops so the contextId
 * lineage is traceable (M7).  Hard caps (maxModelCalls, tokenCeiling) are
 * enforced by the loop itself — not the strategy. MachineRuntime 另有
 * maxTurns（默认 100）预算守卫兜底。
 *
 * ## Usage aggregation
 *
 * Usage is aggregated across all model calls.  When any call's usage carries
 * `_source: "derived"` the aggregate output tags `_source: "mixed"` so
 * downstream consumers know the numbers are not purely observed.
 *
 * ## v1 单轮语义
 *
 * 旧 runManagedLoop 在首次模型调用后即终止（v1 无工具，模型首轮即出终态
 * 回复）。状态机保留该行为：δ 检查模型回复的 stopReason——缺失或为
 * "stop" → max_calls（单轮终止）；"tool_call"/"tool_use" → more（多轮
 * 钩子，v1 无工具不可达）。行为不变性：正常路径恰好 1 次模型调用。
 *
 * @module managed-loop
 */

import { contextTokenTotal } from "./context-metrics.ts";
import type { MachineDefinition } from "../workloop/machine.ts";
import type {
  WorkLoopSDK,
  WorkLoopResult,
  WorkContext,
  StandardAgentOutput,
} from "../workloop/contracts.ts";

// ── Config ──────────────────────────────────────────────────────────

export interface ManagedLoopConfig {
  /** Model id（透传；machine δ 经 sdk.model.complete 调用，策略经此选择 summary model）。 */
  model: string;
  /** Optional system prompt seeded into initialContext. */
  systemPrompt?: string;
  /** Maximum model calls before forced termination (default 8). */
  maxModelCalls?: number;
  /** Hard ceiling on context token count — if exceeded AND strategy
   *  cannot reduce, the loop terminates. */
  tokenCeiling?: number;
  /** 扩展配置透传（budgetTokens / maxSummaryCalls / summaryWindow / strategyId 等）。 */
  [key: string]: unknown;
}

// ── Strategy hook ───────────────────────────────────────────────────

/**
 * A pluggable context-management strategy.
 *
 * Called by the managed loop before each model call when the current
 * context exceeds the strategy's own budget threshold (or tokenCeiling
 * as fallback).  The strategy may transform (truncate, summarise,
 * select) the context and must report whether a transform occurred.
 *
 * If the strategy returns `{ transformed: false }` AND the context still
 * exceeds `tokenCeiling` (the hard guard), the loop terminates.
 */
export interface StrategyHook {
  /**
   * Optional: the token threshold at which the managed loop should
   * invoke this strategy.  When not provided the loop falls back to
   * the configured `tokenCeiling` so existing strategies that never
   * declared `budgetThreshold` still work.
   */
  budgetThreshold?: (config: Record<string, unknown>) => number;

  transform(
    context: WorkContext,
    config: Record<string, unknown>,
    sdk: WorkLoopSDK,
  ): Promise<{ context: WorkContext; transformed: boolean; summaryCalls?: number }>;
}

// ── Managed memory ──────────────────────────────────────────────────

/** usage 汇总（StandardAgentOutput["usage"] 去掉可选性——属性本身可选，但汇总对象字段必填）。 */
export type UsageTotals = NonNullable<StandardAgentOutput["usage"]>;

/** 记忆域：跨转移存活的决策输入与副作用（经 MachineRuntime checkpoint 落盘）。 */
export interface ManagedMemory {
  /** 已发生的模型调用次数（含策略 summary 调用）。 */
  calls: number;
  /** 全量 usage 汇总（input/output/cacheRead/cacheWrite/cost/toolCalls 累加）。 */
  totals: UsageTotals;
  /** 任一次调用 usage 带 _source:"derived" → 汇总标 _source:"mixed"。 */
  hasDerived: boolean;
  /** 内部：首次 step 时间戳（durationMs 汇总用）。 */
  startedAt?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0, durationMs: 0 };
}

function normalizeMemory(state: unknown): ManagedMemory {
  const s = (state ?? {}) as Partial<ManagedMemory>;
  return {
    calls: s.calls ?? 0,
    totals: s.totals ?? emptyUsage(),
    hasDerived: s.hasDerived ?? false,
    startedAt: s.startedAt ?? Date.now(),
  };
}

/** 累加一次模型调用的 usage（turns/durationMs 不进累加——终止时以 calls/墙钟覆盖）。 */
function aggregateUsage(
  acc: UsageTotals,
  usage: StandardAgentOutput["usage"],
): UsageTotals {
  if (!usage) return { ...acc };
  return {
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    cacheRead: acc.cacheRead + (usage.cacheRead ?? 0),
    cacheWrite: acc.cacheWrite + (usage.cacheWrite ?? 0),
    cost: acc.cost + usage.cost,
    turns: acc.turns,
    toolCalls: acc.toolCalls + (usage.toolCalls ?? 0),
    durationMs: acc.durationMs,
  };
}

function usageIsDerived(usage: StandardAgentOutput["usage"]): boolean {
  return (usage as Record<string, unknown> | undefined)?._source === "derived";
}

function lastMessageText(ctx: WorkContext): string | undefined {
  const last = ctx.messages[ctx.messages.length - 1];
  return last && typeof last.content === "string" ? last.content : undefined;
}

/** 构造终止结果：usage 汇总（turns=calls，durationMs=墙钟，derived→_source:"mixed"）+ 最后文本。 */
function buildTerminal(ctx: WorkContext, memory: ManagedMemory): WorkLoopResult {
  const usage: UsageTotals = {
    input: memory.totals.input,
    output: memory.totals.output,
    cacheRead: memory.totals.cacheRead,
    cacheWrite: memory.totals.cacheWrite,
    cost: memory.totals.cost,
    turns: memory.calls,
    toolCalls: memory.totals.toolCalls,
    durationMs: Date.now() - (memory.startedAt ?? Date.now()),
  };
  if (memory.hasDerived) {
    (usage as Record<string, unknown>)._source = "mixed";
  }
  return {
    status: "completed",
    output: { standard: { text: lastMessageText(ctx), usage } },
    context: ctx,
    state: memory,
  };
}

// ── Machine ─────────────────────────────────────────────────────────

/**
 * 构建 managed 五状态机（check / manage / call / append / done）。
 *
 * 事件流（δ 自驱动）：
 *   start|more →（预算检查）→ ctx_ok | over_budget
 *   ctx_ok|transformed → assistant_turn（进入 call 轮次）
 *   over_budget →（strategy.transform）→ transformed | untransformable
 *   assistant_turn →（model.complete + append + 汇总）→ more | max_calls
 *   max_calls|untransformable → terminal（含 usage 汇总 + 最后文本）
 */
export function managedMachine(
  config: ManagedLoopConfig,
  strategyHook: StrategyHook,
): MachineDefinition {
  const maxModelCalls = config.maxModelCalls ?? 8;
  const tokenCeiling = config.tokenCeiling ?? 32000;

  /** 预算检查：超过策略阈值（无则 tokenCeiling 兜底）→ over_budget。 */
  const budgetExceeded = (ctx: WorkContext): boolean => {
    const threshold = strategyHook.budgetThreshold
      ? strategyHook.budgetThreshold(config as unknown as Record<string, unknown>)
      : tokenCeiling;
    return contextTokenTotal(ctx) > threshold;
  };

  return {
    states: [
      { id: "check" },
      { id: "manage" },
      { id: "call" },
      { id: "append" },
      { id: "done", terminal: true },
    ],
    initial: "check",
    transitions: (state, event) => {
      switch (state) {
        case "check":
          // start：MachineRuntime 注入的初始事件（δ 做预算检查并自驱动决策事件）
          if (event.type === "start") return "check";
          if (event.type === "ctx_ok") return "call";
          if (event.type === "over_budget") return "manage";
          return undefined;
        case "manage":
          if (event.type === "transformed") return "call";
          if (event.type === "untransformable") return "done";
          return undefined;
        case "call":
          if (event.type === "assistant_turn") return "append";
          return undefined;
        case "append":
          if (event.type === "more") return "check";
          if (event.type === "max_calls") return "done";
          return undefined;
        default:
          return undefined;
      }
    },
    step: async (ctx, state, event, sdk) => {
      const memory = normalizeMemory(state);

      switch (event.type) {
        case "start":
        case "more": {
          // 预算检查：超过策略阈值 → manage；否则 → call
          return {
            context: ctx,
            state: memory,
            event: { type: budgetExceeded(ctx) ? "over_budget" : "ctx_ok" },
          };
        }

        case "ctx_ok":
        case "transformed": {
          // 进入 call 轮次：请求模型回复
          return { context: ctx, state: memory, event: { type: "assistant_turn" } };
        }

        case "over_budget": {
          const strategyResult = await strategyHook.transform(
            ctx,
            config as unknown as Record<string, unknown>,
            sdk,
          );
          // P6b: summary calls made by the strategy count toward maxModelCalls
          // so that a misbehaving summary model cannot cause unbounded spend.
          const calls = memory.calls + (strategyResult.summaryCalls ?? 0);
          const nextMemory = { ...memory, calls };
          if (calls >= maxModelCalls) {
            return { context: strategyResult.context, state: nextMemory, event: { type: "untransformable" } };
          }
          if (!strategyResult.transformed && contextTokenTotal(strategyResult.context) > tokenCeiling) {
            return { context: strategyResult.context, state: nextMemory, event: { type: "untransformable" } };
          }
          return { context: strategyResult.context, state: nextMemory, event: { type: "transformed" } };
        }

        case "assistant_turn": {
          // 本地式 δ 直接调 sdk.model（DSP 已由 runtime 包装）
          const result = await sdk.model.complete(ctx, { strategyId: config.strategyId });
          const newContextId = `ctx-${crypto.randomUUID()}`;
          const newCtx = sdk.context.append(ctx, [result.message], newContextId);
          const totals = aggregateUsage(memory.totals, result.usage);
          const calls = memory.calls + 1;
          const nextMemory: ManagedMemory = {
            ...memory,
            calls,
            totals,
            hasDerived: memory.hasDerived || usageIsDerived(result.usage),
          };
          // v1 无工具：模型首轮即 stop（stopReason 缺失视为 stop）→ 单轮终止；
          // tool_call/tool_use → more（多轮钩子，v1 不可达）
          const stopReason = (result.message as { stopReason?: string } | undefined)?.stopReason;
          const wantsMore = stopReason === "tool_call" || stopReason === "tool_use";
          return {
            context: newCtx,
            state: nextMemory,
            event: { type: calls >= maxModelCalls || !wantsMore ? "max_calls" : "more" },
          };
        }

        case "max_calls":
        case "untransformable": {
          // 终止：δ 直接返回 terminal（含 usage 汇总 + 最后文本）；done 的 terminal:true 兜底
          return { context: ctx, state: memory, terminal: buildTerminal(ctx, memory) };
        }

        default:
          return { context: ctx, state: memory };
      }
    },
  };
}
