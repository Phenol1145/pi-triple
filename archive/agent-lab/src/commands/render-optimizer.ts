// ── Optimizer facade (injected by index.ts bootstrap) ──────────────

export interface OptimizerFacade {
  list(): Array<{
    instanceId: string;
    definitionId: string;
    definitionVersion: string;
    status: string;
    targetSchedulers: string[];
  }>;
  run(instanceId: string): Promise<{
    kind: "proposal" | "skip" | "fail";
    eventId?: string;
    proposalId?: string;
    reason?: string;
    evaluation?: { summary: string; metrics: Record<string, number>; dataWindow: { since: number; until: number } };
    error?: string;
  }>;
  proposals(schedulerInstanceId?: string): Array<{
    proposalId: string;
    optimizerInstanceId: string;
    schedulerInstanceId: string;
    status: string;
    evaluation?: { summary: string };
    candidateRoundId?: string;
    createdAt: number;
  }>;
  diff(proposalId: string): {
    baseRoundId: string;
    candidateRoundId?: string;
    changedPaths: Array<{ path: string; tunable: boolean }>;
  };
  promote(roundId: string): {
    newRoundId: string;
    previousRoundId: string;
  };
  rollback(schedulerInstanceId: string, targetRoundId: string): {
    newRoundId: string;
    previousRoundId: string;
  };
  /** Manual shadow validation of a proposal. */
  validate(proposalId: string): Promise<{
    status: string;
    selectionChanged: boolean;
    currentTop: string[];
    candidateTop: string[];
    expectedCompletionDelta: number;
    expectedCostDelta: number;
    samples: number;
    error?: string;
  }>;
  /** Start canary on a validated round. */
  canaryStart(roundId: string, percent?: number): {
    ok: boolean;
    schedulerInstanceId?: string;
    reason?: string;
  };
  /** Stop (abort) active canary. */
  canaryStop(schedulerInstanceId: string): {
    ok: boolean;
    reason?: string;
  };
  /** Show current canary status across instances. */
  canaryStatus(): {
    hasCanary: boolean;
    canaryRoundId?: string;
    canaryPercent?: number;
    schedulerInstanceId?: string;
  };
  /** Show merged optimizer config + auto-trigger throttle status. */
  autoStatus(): {
    config: Record<string, unknown>;
    triggerStatus?: { runsSinceLast: number; lastFiredAt: number | null; fires: number };
  };
}

// ── Optimizer render helpers ────────────────────────────────────────

export interface OptimizerListInput {
  instanceId: string;
  definitionId: string;
  definitionVersion: string;
  status: string;
  targetSchedulers: string[];
}

export function renderOptimizerList(instances: OptimizerListInput[]): string {
  if (instances.length === 0) {
    return "No optimizer instances found.";
  }
  const lines: string[] = ["Optimizer Instances:"];
  for (const inst of instances) {
    lines.push(`  ${inst.instanceId} (${inst.definitionId}@${inst.definitionVersion})  status=${inst.status}`);
    lines.push(`    targets: ${inst.targetSchedulers.join(", ")}`);
  }
  return lines.join("\n");
}

export function renderOptimizerRun(result: {
  kind: "proposal" | "skip" | "fail";
  eventId?: string;
  proposalId?: string;
  reason?: string;
  evaluation?: { summary: string; metrics: Record<string, number>; dataWindow: { since: number; until: number } };
  error?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Optimizer run: ${result.kind}`);
  if (result.eventId) lines.push(`  event: ${result.eventId}`);
  if (result.kind === "proposal" && result.proposalId) {
    lines.push(`  proposal: ${result.proposalId}`);
    if (result.evaluation) {
      lines.push(`  evaluation: ${result.evaluation.summary}`);
      const metricLines = Object.entries(result.evaluation.metrics).map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(3) : v}`);
      lines.push(`    metrics: ${metricLines.join(", ")}`);
      lines.push(`    window: ${new Date(result.evaluation.dataWindow.since).toISOString()} → ${new Date(result.evaluation.dataWindow.until).toISOString()}`);
    }
  } else if (result.kind === "skip" && result.reason) {
    lines.push(`  reason: ${result.reason}`);
  } else if (result.kind === "fail" && result.error) {
    lines.push(`  error: ${result.error}`);
  }
  return lines.join("\n");
}

export function renderOptimizerProposals(
  proposals: Array<{
    proposalId: string;
    optimizerInstanceId: string;
    schedulerInstanceId: string;
    status: string;
    evaluation?: { summary: string };
    candidateRoundId?: string;
    createdAt: number;
  }>,
): string {
  if (proposals.length === 0) {
    return "No proposals found.";
  }
  const lines: string[] = [`Proposals (${proposals.length}):`];
  for (const p of proposals) {
    const ts = new Date(p.createdAt).toISOString();
    const evalPart = p.evaluation ? ` — ${p.evaluation.summary}` : "";
    lines.push(`  ${p.proposalId}  status=${p.status}  optimizer=${p.optimizerInstanceId}  scheduler=${p.schedulerInstanceId}`);
    lines.push(`    created: ${ts}${evalPart}`);
    if (p.candidateRoundId) lines.push(`    candidate: ${p.candidateRoundId}`);
  }
  return lines.join("\n");
}

export function renderOptimizerDiff(diff: {
  baseRoundId: string;
  candidateRoundId?: string;
  changedPaths: Array<{ path: string; tunable: boolean }>;
}): string {
  const lines: string[] = [];
  lines.push(`Diff: base=${diff.baseRoundId}`);
  if (diff.candidateRoundId) lines.push(`      candidate=${diff.candidateRoundId}`);
  if (diff.changedPaths.length === 0) {
    lines.push("  (no leaf-path changes)");
  } else {
    for (const cp of diff.changedPaths) {
      const mark = cp.tunable ? "✓" : "✗";
      lines.push(`  ${mark} ${cp.path}`);
    }
  }
  return lines.join("\n");
}

export function renderOptimizerPromote(result: { newRoundId: string; previousRoundId: string }): string {
  return [
    `Round promoted: ${result.previousRoundId} → ${result.newRoundId}`,
    `  previous: ${result.previousRoundId}`,
    `  new:      ${result.newRoundId}`,
  ].join("\n");
}

export function renderOptimizerRollback(result: { newRoundId: string; previousRoundId: string }): string {
  return [
    `Round rolled back: ${result.previousRoundId} → ${result.newRoundId}`,
    `  previous: ${result.previousRoundId}`,
    `  new:      ${result.newRoundId}`,
  ].join("\n");
}

export function renderOptimizerValidate(result: {
  status: string;
  selectionChanged: boolean;
  currentTop: string[];
  candidateTop: string[];
  expectedCompletionDelta: number;
  expectedCostDelta: number;
  samples: number;
  error?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Shadow validation: status=${result.status}`);
  lines.push(`  selectionChanged: ${result.selectionChanged}`);
  lines.push(`  samples: ${result.samples}`);
  lines.push(`  expectedCompletionDelta: ${result.expectedCompletionDelta.toFixed(4)}`);
  lines.push(`  expectedCostDelta: ${result.expectedCostDelta.toFixed(6)}`);
  if (result.currentTop.length > 0) {
    lines.push(`  current top: ${result.currentTop.join(", ")}`);
  }
  if (result.candidateTop.length > 0) {
    lines.push(`  candidate top: ${result.candidateTop.join(", ")}`);
  }
  if (result.error) lines.push(`  error: ${result.error}`);
  return lines.join("\n");
}

export function renderOptimizerCanaryStart(result: {
  ok: boolean;
  schedulerInstanceId?: string;
  reason?: string;
  percent?: number;
}): string {
  if (result.ok) {
    return [
      `Canary started`,
      `  instance: ${result.schedulerInstanceId ?? "?"}`,
      `  percent: ${result.percent ?? "?"}%`,
    ].join("\n");
  }
  return `Canary start failed: ${result.reason ?? "unknown error"}`;
}

export function renderOptimizerCanaryStop(result: {
  ok: boolean;
  reason?: string;
}): string {
  if (result.ok) return "Canary stopped (aborted).";
  return `Canary stop failed: ${result.reason ?? "unknown error"}`;
}

export function renderOptimizerCanaryStatus(status: {
  hasCanary: boolean;
  canaryRoundId?: string;
  canaryPercent?: number;
  schedulerInstanceId?: string;
}): string {
  if (!status.hasCanary) return "No active canary found.";
  return [
    `Active canary:`,
    `  instance: ${status.schedulerInstanceId ?? "?"}`,
    `  round: ${status.canaryRoundId ?? "?"}`,
    `  percent: ${status.canaryPercent ?? "?"}%`,
  ].join("\n");
}

export function renderOptimizerAutoStatus(result: {
  config: Record<string, unknown>;
  triggerStatus?: { runsSinceLast: number; lastFiredAt: number | null; fires: number };
}): string {
  const lines: string[] = [];
  lines.push("Optimizer auto config:");
  lines.push(`  ${JSON.stringify(result.config, null, 2).split("\n").join("\n  ")}`);
  if (result.triggerStatus) {
    const ts = result.triggerStatus;
    lines.push("Auto-trigger throttle:");
    lines.push(`  runsSinceLast: ${ts.runsSinceLast}`);
    lines.push(`  lastFiredAt: ${ts.lastFiredAt !== null ? new Date(ts.lastFiredAt).toISOString() : "never"}`);
    lines.push(`  fires: ${ts.fires}`);
  }
  return lines.join("\n");
}
