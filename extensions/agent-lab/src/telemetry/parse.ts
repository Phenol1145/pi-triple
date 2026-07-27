import type { LabConfig, RunRecord } from "../types.ts";
import { deriveCompletion } from "../scorer/completion.ts";

export interface SubagentCallLike {
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseSubagentRun(call: SubagentCallLike, cfg: LabConfig, now: number = Date.now(), toolCallId?: string): RunRecord | undefined {
  const role = typeof call.input.agent === "string" ? call.input.agent : undefined;
  if (!role) return undefined;
  const r = call.result ?? {};

  const acceptanceRaw = r.acceptance as unknown;
  const acceptance =
    typeof acceptanceRaw === "string"
      ? acceptanceRaw
      : acceptanceRaw && typeof acceptanceRaw === "object" && typeof (acceptanceRaw as { status?: unknown }).status === "string"
        ? (acceptanceRaw as { status: string }).status
        : undefined;

  const usage = (r.usage ?? {}) as Record<string, unknown>;
  const costObj = usage.cost as Record<string, unknown> | undefined;
  const tokensIn = num(usage.input) ?? num(usage.inputTokens);
  const tokensOut = num(usage.output) ?? num(usage.outputTokens);
  const cost = num(costObj?.total) ?? num(usage.cost) ?? num(usage.totalCost);

  const model =
    (typeof r.model === "string" && r.model) ||
    (typeof call.input.model === "string" && call.input.model) ||
    "unknown";

  const toolSuccess = num(r.toolSuccessRate) ?? 1;
  const turns = num(r.turns) ?? num(r.numTurns);
  const interrupted = r.interrupted === true || r.state === "stopped" || r.state === "interrupted" ? 1 : 0;

  const completion = deriveCompletion({
    acceptance, interrupted, toolSuccess,
    map: cfg.acceptanceScoreMap,
    interruptedPenalty: cfg.interruptedPenalty,
    toolFailPenalty: cfg.toolFailPenalty,
  });

  return {
    ts: now, role, model, acceptance, completion,
    tokensIn, tokensOut, cost, toolSuccess, turns, interrupted,
    signals: { acceptance, state: r.state },
    source: "auto",
    traceId: toolCallId || undefined,
  };
}
