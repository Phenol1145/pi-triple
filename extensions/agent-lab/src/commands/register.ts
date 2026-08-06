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
import { DEFAULT_WEIGHTED_SCORER_NAME } from "../schedulers/names.ts";
import type { SchedulingStrategy } from "../scheduler/strategy.ts";
import type { OptimizerFacade } from "./render-optimizer.ts";
import type { ExperimentFacade } from "./render-experiment.ts";
import {
  renderSchedulerStatus,
  renderSchedulerSelect,
  renderSchedulerSync,
  renderSchedulerEvents,
  renderSchedulerDispatch,
  type SchedulerStatusInput,
  type SchedulerSelectResultLike,
} from "./render-scheduler.ts";
import {
  renderScheduleList,
  renderScheduleJobCreated,
  renderScheduleAction,
  type ScheduledJobView,
} from "./render-schedule.ts";
import {
  renderOptimizerList,
  renderOptimizerRun,
  renderOptimizerProposals,
  renderOptimizerDiff,
  renderOptimizerPromote,
  renderOptimizerRollback,
  renderOptimizerValidate,
  renderOptimizerCanaryStart,
  renderOptimizerCanaryStop,
  renderOptimizerCanaryStatus,
  renderOptimizerAutoStatus,
  type OptimizerListInput,
} from "./render-optimizer.ts";
import {
  renderExperimentCreate,
  renderExperimentRun,
  renderExperimentStatus,
  renderExperimentCompare,
  type ExperimentRunResult,
  type ExperimentStatusResult,
  type ExperimentCompareResult,
} from "./render-experiment.ts";

// Re-export render helpers + facade types. Consumers (tests,
// optimizer/facade.ts, index.ts) import these from register.ts.
export {
  renderSchedulerStatus,
  renderSchedulerSelect,
  renderSchedulerSync,
  renderSchedulerEvents,
  renderSchedulerDispatch,
  type SchedulerStatusInput,
  type SchedulerSelectResultLike,
};
export {
  renderOptimizerList,
  renderOptimizerRun,
  renderOptimizerProposals,
  renderOptimizerDiff,
  renderOptimizerPromote,
  renderOptimizerRollback,
  renderOptimizerValidate,
  renderOptimizerCanaryStart,
  renderOptimizerCanaryStop,
  renderOptimizerCanaryStatus,
  renderOptimizerAutoStatus,
  type OptimizerFacade,
  type OptimizerListInput,
};
export {
  renderExperimentCreate,
  renderExperimentRun,
  renderExperimentStatus,
  renderExperimentCompare,
  type ExperimentFacade,
  type ExperimentRunResult,
  type ExperimentStatusResult,
  type ExperimentCompareResult,
};
export {
  renderScheduleList,
  renderScheduleJobCreated,
  renderScheduleAction,
  type ScheduledJobView,
} from "./render-schedule.ts";

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
  getSchedulerUuid?: () => string | undefined;
  arenaSmoke?: (role: string, cmdCtx: ExtensionContext, engine?: "model-caller" | "workloop") => Promise<string>;
  bench?: (cmdCtx: ExtensionContext, n?: number) => Promise<string>;
  captureCommandContext?: (ctx: ExtensionContext) => void;
  executeDispatch?: (role: string, task: string) => Promise<string>;
  optimizerFacade?: OptimizerFacade;
  experimentFacade?: ExperimentFacade;
  runMigration?: (dryRun: boolean) => MigrationReport;
  /** /lab schedule 管理面（F/WP5 Task 28a——常驻会话内扩展命令） */
  scheduledJobs?: () => import("../scheduler/timed-trigger.ts").ScheduledJobsStore | undefined;
}

// ── Command registration ────────────────────────────────────────────

// ── /lab scheduler dispatch 参数解析（纯函数，导出供测试） ─────────────

export interface DispatchArgs {
  role: string;
  task: string;
  strategy?: SchedulingStrategy;
  agentId?: string;
}

export type DispatchArgsParse =
  | { ok: true; args: DispatchArgs }
  | { ok: false; error: string };

/**
 * 解析 `scheduler dispatch <role> <task...> --strategy <s> [--agent <id>]`。
 * task 为 role 之后、第一个 `--` 参数之前的所有段以空格拼接（可含空格）。
 */
export function parseDispatchArgs(argv: string[]): DispatchArgsParse {
  const role = argv[2];
  const rest = argv.slice(3);
  const flagIdx = rest.findIndex((a) => a.startsWith("--"));
  const task = (flagIdx >= 0 ? rest.slice(0, flagIdx) : rest).join(" ").trim();
  if (!role || !task) {
    return { ok: false, error: "用法: /lab scheduler dispatch <role> <task...> --strategy direct|weighted|market [--agent <id>]" };
  }
  const strategyIdx = argv.indexOf("--strategy");
  const strategy = strategyIdx >= 0 ? argv[strategyIdx + 1] : undefined;
  const agentIdx = argv.indexOf("--agent");
  const agentId = agentIdx >= 0 ? argv[agentIdx + 1] : undefined;
  if (strategy === "direct" && !agentId) {
    return { ok: false, error: "strategy=direct 需要 --agent <id>" };
  }
  return { ok: true, args: { role, task, strategy: strategy as SchedulingStrategy | undefined, agentId } };
}

export function registerCommands(pi: ExtensionAPI, deps: Deps): void {
  const { store, catalog, cfg, ledger, saveConfig, schedulerRuntime, getSchedulerEvents, syncSchedulerAgents, getEffectiveRouting, getSchedulerUuid, arenaSmoke, bench, captureCommandContext, executeDispatch, optimizerFacade, experimentFacade, runMigration, scheduledJobs } = deps;

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
      } else if (cmd === "market") {
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
            const staleIds = new Set(ledger.staleTasks(cfg.market.market.staleTaskTimeoutMs).map((t) => t.taskId));
            if (staleIds.has(id)) ledger.recoverStaleTask(id);
          }
          const t = id ? ledger.getTask(id) : undefined;
          ctx.ui.notify(t ? JSON.stringify(t, null, 2) : "未找到任务", "info");
        } else if (sub === "doctor") {
          ctx.ui.notify(`Market: round=${ledger.currentRound()} agents=${ledger.leaderboard().length}`, "info");
        } else if (sub === "post") {
          ctx.ui.notify("Market post 已废弃 — 调度器现已通过 catch-all binding 自动接管模型选择，无需手动派发", "warning");
        } else if (sub === "smoke") {
          const role = argv[2];
          if (!role || role.startsWith("--")) { ctx.ui.notify("用法: /lab market smoke <role> [--engine model-caller|workloop]", "error"); return; }
          if (!arenaSmoke) {
            ctx.ui.notify("Market smoke unavailable — market not bootstrapped. Check /lab scheduler status", "error");
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
          ctx.ui.notify("用法: /lab market <credits|history|task|doctor|post|smoke> ...", "info");
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
          const instanceId = cfg.scheduler?.instanceId ?? DEFAULT_WEIGHTED_SCORER_NAME;
          const instanceUuid = getSchedulerUuid?.();
          const enabled = cfg.scheduler?.enabled === true;
          const effectiveRouting = getEffectiveRouting?.();
          const rt = schedulerRuntime?.();
          if (!rt) {
            ctx.ui.notify(renderSchedulerStatus({
              instanceId, instanceUuid, enabled, runtimeAvailable: false, effectiveRouting,
            }), "info");
          } else {
            // Runtime available: we have the dispatch interface but not direct
            // repository access. Show what we know from config + runtime presence.
            ctx.ui.notify(renderSchedulerStatus({
              instanceId, instanceUuid, enabled, runtimeAvailable: true, effectiveRouting,
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
        } else if (sub === "dispatch") {
          const parsed = parseDispatchArgs(argv);
          if (!parsed.ok) { ctx.ui.notify(parsed.error, "error"); return; }
          const rt = schedulerRuntime?.();
          if (!rt) { ctx.ui.notify("Scheduler runtime unavailable — enable with /lab config scheduler.enabled true", "error"); return; }
          try {
            const result = await rt.dispatch({
              traceId: `cmd-dispatch-${Date.now()}`,
              role: parsed.args.role,
              task: parsed.args.task,
              strategy: parsed.args.strategy,
              agentId: parsed.args.agentId,
              mode: "execute",
            });
            ctx.ui.notify(renderSchedulerDispatch(result), "info");
          } catch (err) {
            ctx.ui.notify(`Scheduler dispatch failed: ${(err as Error).message}`, "error");
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
          ctx.ui.notify("用法: /lab scheduler <status|select|dispatch|sync|events> [args]", "info");
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
      } else if (cmd === "schedule") {
        const sub = argv[1];
        const store0 = scheduledJobs?.();
        if (!store0) {
          ctx.ui.notify("定时任务管理不可用——常驻会话未接线 ScheduledJobsStore", "error");
          return;
        }
        // tenant 解析：--tenant <id>，缺省 = PI_TEMPLATE env（沿用 stats 惯例）
        const tenantIdx = argv.indexOf("--tenant");
        const tenantId = tenantIdx >= 0 ? argv[tenantIdx + 1] : process.env.PI_TEMPLATE ?? "system";
        const toView = (j: import("../scheduler/timed-trigger.ts").ScheduledJob): ScheduledJobView => ({
          id: j.id,
          tenantId: j.tenantId,
          taskType: j.taskType,
          scheduleKind: j.scheduleKind,
          scheduleSpec: j.scheduleSpec,
          status: j.status,
          nextFireAt: j.nextFireAt,
          lastFireAt: j.lastFireAt,
          fireCount: j.fireCount,
          createdBy: j.createdBy,
          legalRef: j.legalRef,
        });
        if (sub === "add") {
          const taskType = argv[2];
          const kind = argv[3];
          const spec = argv[4];
          if (!taskType || !kind || !spec) {
            ctx.ui.notify("用法: /lab schedule add <taskType> <interval|at|cron> <spec> [payloadJson] [--tenant <id>]", "error");
            return;
          }
          let payload: unknown = {};
          const payloadRaw = argv[5] && !argv[5].startsWith("--") ? argv[5] : undefined;
          if (payloadRaw) {
            try {
              payload = JSON.parse(payloadRaw);
            } catch {
              ctx.ui.notify("payload 必须是合法 JSON", "error");
              return;
            }
          }
          const { computeNextFireAt } = await import("../scheduler/timed-trigger.ts");
          let nextFireAt: number;
          try {
            nextFireAt = computeNextFireAt(kind as any, spec, Date.now());
          } catch (err) {
            ctx.ui.notify(`调度表达式无效: ${(err as Error).message}`, "error");
            return;
          }
          try {
            const job = store0.create({
              id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              tenantId,
              taskType,
              scheduleKind: kind as any,
              scheduleSpec: spec,
              payload,
              status: "active",
              nextFireAt,
              createdBy: "lab-schedule",
            });
            ctx.ui.notify(renderScheduleJobCreated(toView(job)), "info");
          } catch (err) {
            ctx.ui.notify(`创建失败: ${(err as Error).message}`, "error");
          }
        } else if (sub === "ls") {
          try {
            const jobs = store0.list({ tenantId });
            ctx.ui.notify(renderScheduleList(jobs.map(toView)), "info");
          } catch (err) {
            ctx.ui.notify(`查询失败: ${(err as Error).message}`, "error");
          }
        } else if (sub === "pause" || sub === "resume" || sub === "rm") {
          const id = argv[2];
          if (!id) {
            ctx.ui.notify(`用法: /lab schedule ${sub} <jobId>`, "error");
            return;
          }
          const job = store0.get(id);
          if (!job) {
            ctx.ui.notify(`未找到定时任务 ${id}`, "error");
            return;
          }
          if (sub === "rm") {
            store0.remove(id);
            ctx.ui.notify(renderScheduleAction("已删除", id), "info");
            return;
          }
          store0.update(id, { status: sub === "pause" ? "paused" : "active" });
          ctx.ui.notify(renderScheduleAction(sub === "pause" ? "已暂停" : "已恢复", id), "info");
        } else {
          ctx.ui.notify("用法: /lab schedule <add|ls|pause|resume|rm> [args] [--tenant <id>]", "info");
        }
      } else if (cmd === "doctor") {
        ctx.ui.notify(`Agent Lab 状态:\n候选模型: ${catalog.candidates().length}\n目录新鲜: ${catalog.isFresh}\n角色数: ${store.listRoles().length}\nautoApply: ${cfg.autoApply}`, "info");
      } else {
        ctx.ui.notify("用法: /lab <recommend|stats|models|log|pin|unpin|config|mode|migrate|market|scheduler|schedule|optimizer|experiment|doctor> ...\n  stats [role] [--global] [--tenant <alias|uuid>]", "info");
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
