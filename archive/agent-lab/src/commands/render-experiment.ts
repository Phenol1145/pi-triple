// ── Experiment facade (injected by index.ts bootstrap) ─────────────

export interface ExperimentFacade {
  create(assignments: Array<{ model: string; strategy: string; strategyConfig?: unknown }>): Promise<{
    instanceId: string;
    roundId: string;
    agentIds: string[];
  }>;
  run(
    instanceId: string,
    task: string,
    cmdCtx: { modelRegistry: unknown },
    labels?: { strategy?: string; assignmentIndex?: number },
  ): Promise<ExperimentRunResult>;
  status(instanceId: string): ExperimentStatusResult;
  compare(instanceId: string, opts?: { roundId?: string; byRound?: boolean }): ExperimentCompareResult;
}

export interface ExperimentRunResult {
  status: "completed" | "abstained" | "failed";
  model?: string;
  strategy?: string;
  agentId?: string;
  output?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
    durationMs: number;
    source: "observed" | "derived";
  };
  error?: string;
}

export interface ExperimentStatusResult {
  instanceId: string;
  status: string;
  definitionId: string;
  definitionVersion: string;
  roundId: string;
  agents: Array<{
    id: string;
    model: string;
    strategy: string;
    status: string;
  }>;
}

export interface ExperimentCompareResult {
  available: boolean;
  data?: unknown;
  reason?: string;
}

// ── Experiment render helpers ───────────────────────────────────────

export function renderExperimentCreate(result: {
  instanceId: string;
  roundId: string;
  agentIds: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Experiment instance created: ${result.instanceId}`);
  lines.push(`  round: ${result.roundId}`);
  lines.push(`  agents (${result.agentIds.length}):`);
  for (const id of result.agentIds) {
    lines.push(`    ${id}`);
  }
  return lines.join("\n");
}

export function renderExperimentRun(result: ExperimentRunResult): string {
  const lines: string[] = [];
  lines.push(`Experiment run: ${result.status}`);
  if (result.status === "completed") {
    lines.push(`  model: ${result.model ?? "?"}`);
    lines.push(`  strategy: ${result.strategy ?? "?"}`);
    if (result.agentId) lines.push(`  agent: ${result.agentId}`);
    if (result.output) {
      const preview = result.output.length > 200 ? result.output.slice(0, 200) + "..." : result.output;
      lines.push(`  output: ${preview}`);
    }
    if (result.usage) {
      lines.push(`  usage: input=${result.usage.input} output=${result.usage.output} cost=${result.usage.cost.toFixed(6)} source=${result.usage.source}`);
      lines.push(`    (cacheRead=${result.usage.cacheRead} cacheWrite=${result.usage.cacheWrite} turns=${result.usage.turns} durationMs=${result.usage.durationMs})`);
    }
  } else if (result.status === "abstained") {
    lines.push(`  reason: ${result.error ?? "no assignments"}`);
  } else if (result.status === "failed") {
    lines.push(`  error: ${result.error ?? "unknown error"}`);
  }
  return lines.join("\n");
}

export function renderExperimentStatus(result: ExperimentStatusResult): string {
  if (result.status === "not-found") {
    return `Experiment instance not found: ${result.instanceId}`;
  }
  const lines: string[] = [];
  lines.push(`Experiment: ${result.instanceId}`);
  lines.push(`  status: ${result.status}`);
  lines.push(`  definition: ${result.definitionId}@${result.definitionVersion}`);
  lines.push(`  round: ${result.roundId}`);
  lines.push(`  agents (${result.agents.length}):`);
  for (const a of result.agents) {
    lines.push(`    ${a.id}  model=${a.model}  strategy=${a.strategy}  status=${a.status}`);
  }
  return lines.join("\n");
}

export function renderExperimentCompare(result: ExperimentCompareResult): string {
  if (!result.available) {
    return `Experiment comparison unavailable: ${result.reason ?? "unknown"}`;
  }
  const data = result.data as Record<string, unknown> | undefined;
  if (data && data.mode === "byRound") {
    const rounds = data.rounds as Record<string, unknown>;
    const roundIds = Object.keys(rounds).sort();
    if (roundIds.length === 0) {
      return "Experiment comparison by round: (no rounds found)";
    }
    const lines: string[] = [`Experiment comparison by round (${roundIds.length} rounds):`];
    for (const roundId of roundIds) {
      lines.push(`\n## Round: ${roundId}`);
      lines.push(JSON.stringify(rounds[roundId], null, 2));
    }
    return lines.join("\n");
  }
  // Single-round view (with or without roundId filter)
  const projection = data && data.mode === "single" ? data.projection : data;
  return `Experiment comparison:\n${JSON.stringify(projection, null, 2)}`;
}
