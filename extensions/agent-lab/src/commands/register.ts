import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import type { CatalogService } from "../catalog/catalog.ts";
import { recommend } from "../scorer/scorer.ts";
import type { Ledger } from "../arena/types.ts";
import { renderLeaderboard, renderHistory } from "./arena-display.ts";
import type { SchedulerRuntimeLike } from "../interceptor/scheduler-bridge.ts";
import type { LabEvent } from "../core/contracts.ts";
import type { MigrationReport } from "../migrate.ts";
import { renderMigrationReport } from "../migrate.ts";

interface Deps {
  store: Store;
  catalog: CatalogService;
  cfg: LabConfig;
  ledger: Ledger;
  saveConfig: (cfg: LabConfig) => void;
  schedulerRuntime?: () => SchedulerRuntimeLike | undefined;
  getSchedulerEvents?: (limit: number) => LabEvent[];
  syncSchedulerAgents?: () => number;
  getEffectiveRouting?: () => string;
  arenaSmoke?: (role: string, cmdCtx: ExtensionContext, engine?: "model-caller" | "workloop") => Promise<string>;
  bench?: (cmdCtx: ExtensionContext, n?: number) => Promise<string>;
  captureCommandContext?: (ctx: ExtensionContext) => void;
  executeDispatch?: (role: string, task: string) => Promise<string>;
  optimizerFacade?: OptimizerFacade;
  experimentFacade?: ExperimentFacade;
  runMigration?: (dryRun: boolean) => MigrationReport;
}

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

// ── Scheduler render helpers (exported for testing) ──────────────────

export interface SchedulerStatusInput {
  instanceId: string;
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

// ── Command registration ────────────────────────────────────────────

export function registerCommands(pi: ExtensionAPI, deps: Deps): void {
  const { store, catalog, cfg, ledger, saveConfig, schedulerRuntime, getSchedulerEvents, syncSchedulerAgents, getEffectiveRouting, arenaSmoke, bench, captureCommandContext, executeDispatch, optimizerFacade, experimentFacade, runMigration } = deps;

  const aggsFor = (role: string) => new Map(store.aggregateByRole(role).map((a) => [a.model, a]));

  function renderRecommend(role: string, topN: number): string {
    const recs = recommend(catalog.candidates(), aggsFor(role), cfg, topN);
    if (recs.length === 0) return `角色 ${role}: 无候选模型（目录为空？试 /lab models --refresh）`;
    return `角色 ${role} 推荐:\n` + recs.map((s, i) => `${i + 1}. ${s.model.id}  score=${s.score.toFixed(3)}  ${s.reason}`).join("\n");
  }

  function renderStats(role?: string, tenantId?: string): string {
    const roles = role ? [role] : store.listRoles(tenantId);
    if (roles.length === 0) return tenantId ? `暂无遥测数据（租户过滤激活）。` : "暂无遥测数据。";
    const out: string[] = [];
    for (const r of roles) {
      out.push(`# ${r}`);
      for (const a of store.aggregateByRole(r, tenantId)) {
        out.push(`  ${a.model}: runs=${a.runs} avgCompletion=${a.avgCompletion.toFixed(2)} avgCost=${a.avgCost.toFixed(4)} success=${a.successRate.toFixed(2)}`);
      }
    }
    return out.join("\n");
  }

  // Dead keys (mode, autoApply, arena.*) — rejected with migration guidance.
  // Accept only the config keys that the current architecture uses.
  const ARENA_DEAD_PREFIXES = ["endowment.", "odds.", "settlement.", "cost.", "bidding.", "market.", "arena.", "risk."];
  const DEAD_KEYS = new Set(["mode", "autoApply"]);

  function applyConfig(key: string, val: string): true | string {
    if (DEAD_KEYS.has(key) || ARENA_DEAD_PREFIXES.some((p) => key.startsWith(p))) {
      return `配置键 "${key}" 已废弃 — 请运行 /lab migrate 完成迁移`;
    }
    if (key.startsWith("weights.")) {
      const k = key.slice("weights.".length) as keyof LabConfig["weights"];
      if (k in cfg.weights) { cfg.weights[k] = Number(val); return true; }
      return false;
    } else if (key === "scheduler.enabled") {
      if (!cfg.scheduler) cfg.scheduler = {};
      cfg.scheduler.enabled = val === "true"; return true;
    } else if (key === "scheduler.instanceId") {
      if (!cfg.scheduler) cfg.scheduler = {};
      cfg.scheduler.instanceId = val; return true;
    } else if (key === "topN") { cfg.topN = Number(val); return true; }
    else if (key === "interruptedPenalty") { cfg.interruptedPenalty = Number(val); return true; }
    else if (key === "toolFailPenalty") { cfg.toolFailPenalty = Number(val); return true; }
    else if (key === "catalogTtlMs") { cfg.catalogTtlMs = Number(val); return true; }
    return false;
  }

  pi.registerCommand("lab", {
    description: "Agent Lab: recommend/stats/models/log/pin/unpin/config/doctor/scheduler",
    handler: async (args, ctx) => {
      captureCommandContext?.(ctx);
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = argv[0];
      if (cmd === "recommend") {
        ctx.ui.notify("推荐功能已废弃 — 请使用 /lab scheduler status 查看调度器状态，或 /lab optimizer run 触发优化", "warning");
      } else if (cmd === "stats") {
        const isGlobal = argv.includes("--global");
        const tenantIdx = argv.indexOf("--tenant");
        const tenantArg = tenantIdx >= 0 ? argv[tenantIdx + 1] : undefined;
        // 默认：本租户（从 env），除非显式 --global
        const effectiveTenantId = isGlobal ? undefined
          : tenantArg ?? process.env.PI_TEMPLATE ?? undefined;
        const role = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
        const label = isGlobal ? " (global)" : effectiveTenantId ? ` (tenant: ${effectiveTenantId.slice(0, 8)}…)` : "";
        ctx.ui.notify(`Stats${label}:\n${renderStats(role, effectiveTenantId)}`, "info");
      } else if (cmd === "models") {
        if (argv.includes("--refresh")) await catalog.refresh().catch((e: Error) => ctx.ui.notify(`刷新失败: ${e.message}`, "error"));
        const ms = catalog.candidates();
        const lines = ms.slice(0, 50).map((m) => `${m.id} [${m.accessRoute}] in=$${m.pricing?.in ?? "?"}/M out=$${m.pricing?.out ?? "?"}/M ctx=${m.contextWindow ?? "?"}`);
        ctx.ui.notify(`候选模型 ${ms.length} 个:\n` + lines.join("\n"), "info");
      } else if (cmd === "log") {
        const role = argv[1]; const model = argv[2];
        if (!role || !model) { ctx.ui.notify("用法: /lab log <role> <model> [--rating N] [--task CAT]", "error"); return; }
        const ratingIdx = argv.indexOf("--rating");
        const taskIdx = argv.indexOf("--task");
        const rating = ratingIdx >= 0 ? Number(argv[ratingIdx + 1]) : undefined;
        const task = taskIdx >= 0 ? argv[taskIdx + 1] : undefined;
        const manual = rating != null && !Number.isNaN(rating) ? Math.max(0, Math.min(1, rating > 1 ? rating / 5 : rating)) : undefined;
        store.appendRun({
          ts: Date.now(), role, model, taskCategory: task,
          acceptance: manual != null ? "manual" : "auto",
          completion: manual ?? 0.5, toolSuccess: 1, interrupted: 0,
          signals: { manual }, source: "manual",
        });
        ctx.ui.notify(`已记录 ${role}/${model}${manual != null ? ` rating=${manual.toFixed(2)}` : ""}`, "info");
      } else if (cmd === "pin") {
        const role = argv[1]; const model = argv[2];
        if (role && model) { store.setPin(role, model); ctx.ui.notify(`已固定 ${role} → ${model}`, "info"); }
        else ctx.ui.notify("用法: /lab pin <role> <model>", "error");
      } else if (cmd === "unpin") {
        const role = argv[1];
        if (role) { store.clearPin(role); ctx.ui.notify(`已取消固定 ${role}`, "info"); }
        else ctx.ui.notify("用法: /lab unpin <role>", "error");
      } else if (cmd === "config") {
        if (argv.length >= 3) {
          const applied = applyConfig(argv[1], argv[2]);
          if (applied === false) {
            ctx.ui.notify(`未知配置键: ${argv[1]}`, "error");
          } else if (typeof applied === "string") {
            ctx.ui.notify(applied, "error");
          } else {
            try {
              saveConfig(cfg);
              ctx.ui.notify(`已设置 ${argv[1]} = ${argv[2]}`, "info");
            } catch (e) {
              ctx.ui.notify(`设置失败: ${(e as Error).message}`, "error");
            }
          }
        } else {
          ctx.ui.notify(JSON.stringify(cfg, null, 2), "info");
        }
      } else if (cmd === "mode") {
        ctx.ui.notify("模式切换已废弃 — 请使用 /lab migrate 完成迁移，然后通过 scheduler binding 控制路由", "warning");
      } else if (cmd === "arena") {
        const sub = argv[1];
        if (sub === "credits" || sub === "leaderboard") ctx.ui.notify(renderLeaderboard(ledger), "info");
        else if (sub === "history") {
          const limitIdx = argv.indexOf("--limit");
          const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) || 20 : 20;
          const agent = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
          ctx.ui.notify(renderHistory(ledger, agent, limit), "info");
        } else if (sub === "task") {
          const id = argv[2];
          if (id) {
            const staleIds = new Set(ledger.staleTasks(cfg.arena.market.staleTaskTimeoutMs).map((t) => t.taskId));
            if (staleIds.has(id)) ledger.recoverStaleTask(id);
          }
          const t = id ? ledger.getTask(id) : undefined;
          ctx.ui.notify(t ? JSON.stringify(t, null, 2) : "未找到任务", "info");
        } else if (sub === "doctor") {
          ctx.ui.notify(`Arena: round=${ledger.currentRound()} agents=${ledger.leaderboard().length}`, "info");
        } else if (sub === "post") {
          ctx.ui.notify("Arena post 已废弃 — 调度器现已通过 catch-all binding 自动接管模型选择，无需手动派发", "warning");
        } else if (sub === "smoke") {
          const role = argv[2];
          if (!role || role.startsWith("--")) { ctx.ui.notify("用法: /lab arena smoke <role> [--engine model-caller|workloop]", "error"); return; }
          if (!arenaSmoke) {
            ctx.ui.notify("Arena smoke unavailable — arena not bootstrapped. Check /lab scheduler status", "error");
            return;
          }
          const engineIdx = argv.indexOf("--engine");
          const engineArg = engineIdx >= 0 ? argv[engineIdx + 1] : undefined;
          if (engineArg !== undefined && engineArg !== "model-caller" && engineArg !== "workloop") {
            ctx.ui.notify("--engine 必须是 model-caller 或 workloop", "error");
            return;
          }
          try {
            const output = await arenaSmoke(role, ctx, engineArg as "model-caller" | "workloop" | undefined);
            ctx.ui.notify(output, "info");
          } catch (err) {
            ctx.ui.notify(`Smoke failed: ${(err as Error).message}`, "error");
          }
        } else {
          ctx.ui.notify("用法: /lab arena <credits|history|task|doctor|post|smoke> ...", "info");
        }
      } else if (cmd === "bench") {
        if (!bench) { ctx.ui.notify("bench unavailable — enable scheduler first", "error"); return; }
        const n = argv[1] ? Number(argv[1]) : 8;
        try {
          const output = await bench(ctx, Number.isFinite(n) && n > 0 ? n : 8);
          ctx.ui.notify(output, "info");
        } catch (err) { ctx.ui.notify(`bench failed: ${(err as Error).message}`, "error"); }
      } else if (cmd === "execute") {
        const role = argv[1];
        const task = argv.slice(2).join(" ");
        if (!role || !task) { ctx.ui.notify("用法: /lab execute <role> <task>", "error"); return; }
        if (!executeDispatch) { ctx.ui.notify("execute unavailable — enable scheduler first", "error"); return; }
        try {
          const output = await executeDispatch(role, task);
          ctx.ui.notify(output, "info");
        } catch (err) { ctx.ui.notify(`execute failed: ${(err as Error).message}`, "error"); }
      } else if (cmd === "scheduler") {
        const sub = argv[1];
        if (sub === "status") {
          const instanceId = cfg.scheduler?.instanceId ?? "default-weighted-scorer";
          const enabled = cfg.scheduler?.enabled === true;
          const effectiveRouting = getEffectiveRouting?.();
          const rt = schedulerRuntime?.();
          if (!rt) {
            ctx.ui.notify(renderSchedulerStatus({
              instanceId, enabled, runtimeAvailable: false, effectiveRouting,
            }), "info");
          } else {
            // Runtime available: we have the dispatch interface but not direct
            // repository access. Show what we know from config + runtime presence.
            ctx.ui.notify(renderSchedulerStatus({
              instanceId, enabled, runtimeAvailable: true, effectiveRouting,
            }), "info");
          }
        } else if (sub === "select") {
          const role = argv[2];
          if (!role) { ctx.ui.notify("用法: /lab scheduler select <role>", "error"); return; }
          const rt = schedulerRuntime?.();
          if (!rt) { ctx.ui.notify("Scheduler runtime unavailable — enable with /lab config scheduler.enabled true", "error"); return; }
          try {
            const dispatchResult = await rt.dispatch({
              traceId: `cmd-select-${Date.now()}`,
              schedulerInstanceId: cfg.scheduler?.instanceId,
              role,
              task: "scheduler select command",
              mode: "select",
            });
            const legacyRecs = recommend(catalog.candidates(), aggsFor(role), cfg, cfg.topN);
            let selectResult: {
              status: "completed" | "abstained" | "failed" | "fallback";
              model?: string;
              score?: number;
              reason?: string;
              errorMessage?: string;
            };
            if (dispatchResult.status === "completed") {
              selectResult = {
                status: "completed",
                model: dispatchResult.model,
                reason: dispatchResult.reason,
              };
            } else if (dispatchResult.status === "abstained") {
              selectResult = { status: "abstained", reason: dispatchResult.reason };
            } else if (dispatchResult.status === "fallback") {
              selectResult = { status: "fallback" };
            } else {
              selectResult = {
                status: "failed",
                errorMessage: dispatchResult.error?.message ?? "unknown error",
              };
            }
            ctx.ui.notify(renderSchedulerSelect(selectResult, legacyRecs, role), "info");
          } catch (err) {
            ctx.ui.notify(`Scheduler select failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "sync") {
          if (!syncSchedulerAgents) {
            ctx.ui.notify("Scheduler sync unavailable — enable scheduler first with /lab config scheduler.enabled true", "error");
            return;
          }
          try {
            const added = syncSchedulerAgents();
            ctx.ui.notify(renderSchedulerSync(added), "info");
          } catch (err) {
            ctx.ui.notify(`Scheduler sync failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "events") {
          const limitIdx = argv.indexOf("--limit");
          const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) || 50 : 50;
          if (!getSchedulerEvents) {
            ctx.ui.notify("Event log unavailable — enable scheduler first with /lab config scheduler.enabled true", "error");
            return;
          }
          try {
            const allEvents = getSchedulerEvents(limit * 5); // over-fetch to filter
            const prefixes = ["scheduling.", "scheduler.", "routing.", "fallback."];
            const filtered = allEvents.filter((e) => prefixes.some((p) => e.eventType.startsWith(p)));
            ctx.ui.notify(renderSchedulerEvents(filtered, limit), "info");
          } catch (err) {
            ctx.ui.notify(`Scheduler events query failed: ${(err as Error).message}`, "error");
          }
        } else {
          ctx.ui.notify("用法: /lab scheduler <status|select|sync|events> [args]", "info");
        }
      } else if (cmd === "optimizer") {
        const sub = argv[1];
        if (!optimizerFacade) {
          ctx.ui.notify("Optimizer unavailable (bootstrap pending)", "error");
          return;
        }
        if (sub === "list") {
          try {
            const instances = optimizerFacade.list();
            ctx.ui.notify(renderOptimizerList(instances), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer list failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "run") {
          const id = argv[2];
          if (!id) { ctx.ui.notify("用法: /lab optimizer run <instanceId>", "error"); return; }
          try {
            const result = await optimizerFacade.run(id);
            ctx.ui.notify(renderOptimizerRun(result), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer run failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "proposals") {
          const sid = argv[2]; // optional filter
          try {
            const proposals = optimizerFacade.proposals(sid || undefined);
            ctx.ui.notify(renderOptimizerProposals(proposals), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer proposals failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "diff") {
          const proposalId = argv[2];
          if (!proposalId) { ctx.ui.notify("用法: /lab optimizer diff <proposalId>", "error"); return; }
          try {
            const diff = optimizerFacade.diff(proposalId);
            ctx.ui.notify(renderOptimizerDiff(diff), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer diff failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "promote") {
          const roundId = argv[2];
          if (!roundId) { ctx.ui.notify("用法: /lab optimizer promote <roundId>", "error"); return; }
          try {
            const result = optimizerFacade.promote(roundId);
            ctx.ui.notify(renderOptimizerPromote(result), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer promote failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "rollback") {
          const sid = argv[2];
          const targetRoundId = argv[3];
          if (!sid || !targetRoundId) { ctx.ui.notify("用法: /lab optimizer rollback <schedulerInstanceId> <targetRoundId>", "error"); return; }
          try {
            const result = optimizerFacade.rollback(sid, targetRoundId);
            ctx.ui.notify(renderOptimizerRollback(result), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer rollback failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "validate") {
          const proposalId = argv[2];
          if (!proposalId) { ctx.ui.notify("用法: /lab optimizer validate <proposalId>", "error"); return; }
          try {
            const result = await optimizerFacade.validate(proposalId);
            ctx.ui.notify(renderOptimizerValidate(result), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer validate failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "canary") {
          const action = argv[2];
          if (action === "start") {
            const roundId = argv[3];
            if (!roundId) { ctx.ui.notify("用法: /lab optimizer canary start <roundId> [percent]", "error"); return; }
            const percent = argv[4] !== undefined ? Number(argv[4]) : undefined;
            if (percent !== undefined && (Number.isNaN(percent) || percent <= 0 || percent > 100)) {
              ctx.ui.notify("percent 须为 1-100 的数字", "error");
              return;
            }
            try {
              const result = optimizerFacade.canaryStart(roundId, percent);
              ctx.ui.notify(renderOptimizerCanaryStart({ ...result, percent }), result.ok ? "info" : "error");
            } catch (err) {
              ctx.ui.notify(`Canary start failed: ${(err as Error).message}`, "error");
            }
          } else if (action === "stop") {
            const sid = argv[3];
            if (!sid) { ctx.ui.notify("用法: /lab optimizer canary stop <schedulerInstanceId>", "error"); return; }
            try {
              const result = optimizerFacade.canaryStop(sid);
              ctx.ui.notify(renderOptimizerCanaryStop(result), result.ok ? "info" : "error");
            } catch (err) {
              ctx.ui.notify(`Canary stop failed: ${(err as Error).message}`, "error");
            }
          } else if (action === "status") {
            try {
              const result = optimizerFacade.canaryStatus();
              ctx.ui.notify(renderOptimizerCanaryStatus(result), "info");
            } catch (err) {
              ctx.ui.notify(`Canary status failed: ${(err as Error).message}`, "error");
            }
          } else {
            ctx.ui.notify("用法: /lab optimizer canary <start|stop|status> [args]", "info");
          }
        } else if (sub === "auto") {
          try {
            const result = optimizerFacade.autoStatus();
            ctx.ui.notify(renderOptimizerAutoStatus(result), "info");
          } catch (err) {
            ctx.ui.notify(`Optimizer auto status failed: ${(err as Error).message}`, "error");
          }
        } else {
          ctx.ui.notify("用法: /lab optimizer <list|run|proposals|diff|promote|rollback|validate|canary|auto> [args]", "info");
        }
      } else if (cmd === "experiment") {
        const sub = argv[1];
        if (!experimentFacade) {
          ctx.ui.notify("Experiment unavailable (bootstrap pending)", "error");
          return;
        }
        if (sub === "create") {
          const model = argv[2];
          const strategy = argv[3];
          if (!model || !strategy) {
            ctx.ui.notify("用法: /lab experiment create <model> <strategy> [strategy2] [strategy3] ...", "error");
            return;
          }
          const strategies = argv.slice(3).filter((s) => ["default", "budgeted-history", "selective-summary"].includes(s));
          if (strategies.length === 0) {
            ctx.ui.notify(`未知策略: ${argv.slice(3).join(", ")}。有效策略: default, budgeted-history, selective-summary`, "error");
            return;
          }
          const assignments = strategies.map((s) => ({ model, strategy: s }));
          try {
            const result = await experimentFacade.create(assignments);
            ctx.ui.notify(renderExperimentCreate(result), "info");
          } catch (err) {
            ctx.ui.notify(`Experiment create failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "run") {
          const instanceId = argv[2];

          // Parse flag tokens first; task is the remaining tokens after instanceId
          const strategyIdx = argv.indexOf("--strategy");
          const indexIdx = argv.indexOf("--index");
          const labels: { strategy?: string; assignmentIndex?: number } = {};
          if (strategyIdx >= 0 && argv[strategyIdx + 1]) labels.strategy = argv[strategyIdx + 1];
          if (indexIdx >= 0 && argv[indexIdx + 1]) labels.assignmentIndex = Number(argv[indexIdx + 1]);

          const skip = new Set<number>();
          if (strategyIdx >= 0) { skip.add(strategyIdx); skip.add(strategyIdx + 1); }
          if (indexIdx >= 0) { skip.add(indexIdx); skip.add(indexIdx + 1); }
          const task = argv.slice(3).filter((_, i) => !skip.has(i + 3)).join(" ");

          if (!instanceId) { ctx.ui.notify("用法: /lab experiment run <instanceId> <task> [--strategy S] [--index N]", "error"); return; }
          if (!task) { ctx.ui.notify("用法: /lab experiment run <instanceId> <task> [--strategy S] [--index N]", "error"); return; }

          try {
            const result = await experimentFacade.run(instanceId, task, ctx, labels);
            ctx.ui.notify(renderExperimentRun(result), result.status === "failed" ? "error" : "info");
          } catch (err) {
            ctx.ui.notify(`Experiment run failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "status") {
          const instanceId = argv[2];
          if (!instanceId) { ctx.ui.notify("用法: /lab experiment status <instanceId>", "error"); return; }
          try {
            const result = experimentFacade.status(instanceId);
            ctx.ui.notify(renderExperimentStatus(result), "info");
          } catch (err) {
            ctx.ui.notify(`Experiment status failed: ${(err as Error).message}`, "error");
          }
        } else if (sub === "compare") {
          const instanceId = argv[2];
          if (!instanceId) { ctx.ui.notify("用法: /lab experiment compare <instanceId> [--round <roundId>] [--rounds]", "error"); return; }
          const roundIdx = argv.indexOf("--round");
          const roundsFlag = argv.includes("--rounds");
          const roundId = roundIdx >= 0 && argv[roundIdx + 1] && !argv[roundIdx + 1].startsWith("--")
            ? argv[roundIdx + 1]
            : undefined;
          try {
            const result = experimentFacade.compare(instanceId, {
              roundId,
              byRound: roundsFlag,
            });
            ctx.ui.notify(renderExperimentCompare(result), result.available ? "info" : "warning");
          } catch (err) {
            ctx.ui.notify(`Experiment compare failed: ${(err as Error).message}`, "error");
          }
        } else {
          ctx.ui.notify("用法: /lab experiment <create|run|status|compare> [args]\n  compare <instanceId> [--round <roundId>] [--rounds]", "info");
        }
      } else if (cmd === "migrate") {
        const dryRun = argv.includes("--dry-run");
        if (!runMigration) {
          ctx.ui.notify("Migration unavailable — bootstrap pending", "error");
          return;
        }
        try {
          const report = runMigration(dryRun);
          ctx.ui.notify(renderMigrationReport(report), report.alreadyMigrated ? "info" : "info");
        } catch (err) {
          ctx.ui.notify(`Migration failed: ${(err as Error).message}`, "error");
        }
      } else if (cmd === "doctor") {
        ctx.ui.notify(`Agent Lab 状态:\n候选模型: ${catalog.candidates().length}\n目录新鲜: ${catalog.isFresh}\n角色数: ${store.listRoles().length}\nautoApply: ${cfg.autoApply}`, "info");
      } else {
        ctx.ui.notify("用法: /lab <recommend|stats|models|log|pin|unpin|config|mode|migrate|arena|scheduler|optimizer|experiment|doctor> ...\n  stats [role] [--global] [--tenant <alias|uuid>]", "info");
      }
    },
  });

  pi.registerTool({
    name: "agent_lab",
    label: "Agent Lab",
    description: "Query Agent Lab model recommendations, telemetry stats, and candidate models for a role.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("recommend"), Type.Literal("stats"), Type.Literal("models")]),
      role: Type.Optional(Type.String()),
      top: Type.Optional(Type.Number()),
    }),
    async execute(_id, params: { action: "recommend" | "stats" | "models"; role?: string; top?: number }) {
      if (params.action === "recommend") {
        if (!params.role) return { content: [{ type: "text", text: "role required for recommend" }], details: {} };
        return { content: [{ type: "text", text: renderRecommend(params.role, params.top ?? cfg.topN) }], details: {} };
      }
      if (params.action === "stats") return { content: [{ type: "text", text: renderStats(params.role) }], details: {} };
      const ms = catalog.candidates();
      return { content: [{ type: "text", text: `候选模型 ${ms.length} 个:\n` + ms.map((m) => `${m.id} [${m.accessRoute}] $${m.pricing?.in ?? "?"}/$${m.pricing?.out ?? "?"}/M`).join("\n") }], details: {} };
    },
  });
}
