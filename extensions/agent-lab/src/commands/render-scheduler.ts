import type { LabEvent } from "../core/contracts.ts";

// ── Scheduler render helpers (exported for testing) ──────────────────

export interface SchedulerStatusInput {
  instanceId: string;
  /** UUID identity (stable across renames; ADR-0002). */
  instanceUuid?: string;
  definitionId?: string;
  definitionVersion?: string;
  roundId?: string;
  agentCount?: number;
  enabled: boolean;
  runtimeAvailable: boolean;
  effectiveRouting?: string;
}

export function renderSchedulerStatus(input: SchedulerStatusInput): string {
  const lines: string[] = [];
  lines.push("Scheduler Status");
  lines.push(`  Enabled: ${input.enabled ? "yes" : "no"}`);

  if (input.instanceUuid) {
    lines.push(`  ID: ${input.instanceUuid}`);
  }

  if (input.effectiveRouting) {
    lines.push(`  Routing: ${input.effectiveRouting}`);
  } else {
    lines.push(`  Instance: ${input.instanceId}`);
  }

  if (!input.runtimeAvailable) {
    lines.push("  Runtime: unavailable — scheduler bridge not initialized");
    lines.push("  (check config: /lab config scheduler.enabled true)");
    return lines.join("\n");
  }

  if (input.definitionId && input.definitionVersion) {
    lines.push(`  Definition: ${input.definitionId}@${input.definitionVersion}`);
  }
  if (input.roundId) {
    lines.push(`  Round: ${input.roundId}`);
  }
  if (input.agentCount !== undefined) {
    lines.push(`  Agents: ${input.agentCount}`);
  }
  return lines.join("\n");
}

export interface SchedulerSelectResultLike {
  status: "completed" | "abstained" | "failed" | "fallback";
  model?: string;
  score?: number;
  reason?: string;
  errorMessage?: string;
}

export function renderSchedulerSelect(
  result: SchedulerSelectResultLike,
  legacyRecs: Array<{ model: { id: string }; score: number; reason: string }>,
  role: string,
): string {
  const lines: string[] = [];
  lines.push(`Scheduler selection for ${role}:`);

  if (result.status === "completed" && result.model) {
    lines.push(`  Selected: ${result.model}${result.score !== undefined ? ` (score=${result.score.toFixed(3)})` : ""}`);
    if (result.reason) lines.push(`  Reason: ${result.reason}`);
  } else if (result.status === "abstained") {
    lines.push(`  Scheduler abstained${result.reason ? `: ${result.reason}` : ""}`);
  } else if (result.status === "failed") {
    lines.push(`  Scheduler failed${result.errorMessage ? `: ${result.errorMessage}` : ""}`);
  } else if (result.status === "fallback") {
    lines.push(`  Scheduler fell back to original request`);
  } else {
    lines.push(`  No model selected`);
  }

  lines.push("");
  lines.push(`Legacy recommendation for ${role}:`);
  if (legacyRecs.length === 0) {
    lines.push("  (no candidates)");
  } else {
    for (let i = 0; i < legacyRecs.length; i++) {
      const r = legacyRecs[i];
      lines.push(`  ${i + 1}. ${r.model.id}  score=${r.score.toFixed(3)}  ${r.reason}`);
    }
  }

  if (result.status === "completed" && result.model && legacyRecs.length > 0) {
    const match = legacyRecs[0]?.model.id === result.model ? "MATCH" : "MISMATCH";
    lines.push("");
    lines.push(`Dual-run: ${match}`);
  }

  return lines.join("\n");
}

export function renderSchedulerSync(addedCount: number): string {
  if (addedCount === 0) {
    return "Scheduler sync: agent population is up to date (0 new agents).";
  }
  return `Scheduler sync: added ${addedCount} new agent(s) to the population.`;
}

export interface SchedulerDispatchResultLike {
  status: "completed" | "abstained" | "fallback" | "failed";
  selectedAgentId?: string;
  model?: string;
  reason?: string;
  error?: { code?: string; message?: string; retryable?: boolean };
  target?: { type?: string; id?: string; errorCode?: string };
}

/** 简单文本：status + selectedAgentId + reason/error（/lab scheduler dispatch 输出） */
export function renderSchedulerDispatch(result: SchedulerDispatchResultLike): string {
  const lines: string[] = [`Scheduler dispatch: ${result.status}`];
  if (result.status === "completed") {
    if (result.selectedAgentId) lines.push(`  Agent: ${result.selectedAgentId}`);
    if (result.model) lines.push(`  Model: ${result.model}`);
    if (result.reason) lines.push(`  Reason: ${result.reason}`);
  } else if (result.status === "abstained") {
    lines.push(`  Reason: ${result.reason ?? "no candidates"}`);
  } else if (result.status === "fallback") {
    const target = result.target?.type ?? "unknown";
    lines.push(`  Fallback target: ${target}${result.target?.id ? ` (${result.target.id})` : ""}`);
  } else if (result.status === "failed") {
    lines.push(`  Error: ${result.error?.message ?? result.error?.code ?? "unknown error"}`);
  }
  return lines.join("\n");
}

export function renderSchedulerEvents(events: LabEvent[], limit: number): string {
  if (events.length === 0) {
    return `No scheduler events found (limit=${limit}).`;
  }

  const lines: string[] = [];
  lines.push(`Last ${Math.min(events.length, limit)} scheduler events:`);

  const truncated = events.slice(-Math.min(events.length, limit));

  for (const e of truncated) {
    const ts = new Date(e.timestamp).toISOString();
    const identity = [
      e.identity.traceId ? `trace=${e.identity.traceId.slice(0, 12)}` : "",
      e.identity.schedulerInstanceId ? `instance=${e.identity.schedulerInstanceId}` : "",
      e.identity.dispatchId ? `dispatch=${e.identity.dispatchId.slice(0, 12)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const payload = e.payload && typeof e.payload === "object" && Object.keys(e.payload as Record<string, unknown>).length > 0
      ? ` ${JSON.stringify(e.payload)}`
      : "";
    lines.push(`  ${ts} ${e.eventType}${identity ? ` [${identity}]` : ""}${payload}`);
  }

  return lines.join("\n");
}
