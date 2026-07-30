import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "@earendil-works/pi-coding-agent/dist/core/event-bus.ts";
import { SqliteStore } from "./src/store/store.ts";
import type { Store } from "./src/store/store.ts";
import { CatalogService } from "./src/catalog/catalog.ts";
import { loadConfig, ensureDataDir, sharedDbPath, localConfigDir, saveConfig } from "./src/config-io.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerTelemetry, createSettleDispatch } from "./src/telemetry/register.ts";
import { registerInterceptor } from "./src/interceptor/register.ts";
import { registerCommands } from "./src/commands/register.ts";
import { findOrCreateAgentByModel, ensureSessionAgent } from "./src/arena/agent-id.ts";
import { SqliteLedger } from "./src/arena/ledger.ts";
import { EndowmentPolicyV1 } from "./src/arena/policies.ts";
import { getBidBoard } from "./src/arena/bid-board.ts";
import type { SchedulerRuntimeLike } from "./src/interceptor/scheduler-bridge.ts";
import { createSchedulerRuntime } from "./src/runtime/create-scheduler-runtime.ts";
import { ensureWeightedScorerInstance, syncWeightedScorerAgents, ensureArenaInstance, syncArenaAgents, migrateDerivedAgentIds } from "./src/schedulers/bootstrap.ts";
import type { LabCore } from "./src/core/create-core.ts";
import type { ModelCaller } from "./src/arena/types.ts";
import { createModelCaller } from "./src/arena/model-caller.ts";
import { matchEligibility } from "./src/schedulers/arena-definition.ts";
import type { ArenaSchedulerParameters } from "./src/schedulers/arena-definition.ts";
import type { SettleOutcome } from "./src/scheduler/contracts.ts";
import { runBench, type BenchPorts } from "./src/bench/run.ts";
import { loadHumanEval } from "./src/bench/humaneval.ts";
import { renderBenchReport, writeBenchJson } from "./src/bench/report.ts";
import { OptimizerRegistry } from "./src/optimizer/registry.ts";
import { weightedTunerDefinition } from "./src/optimizers/weighted-tuner.ts";
import "./src/optimizers/ws-projector.ts";
import { buildOptimizerFacade } from "./src/optimizer/facade.ts";
import type { OptimizerFacade } from "./src/commands/register.ts";
import { buildExperimentFacade } from "./src/experiment/facade.ts";
import type { ExperimentFacade } from "./src/commands/register.ts";
import { runP7Migration, runP7DryRun } from "./src/migrate.ts";
import { createAutoTrigger, type AutoTrigger } from "./src/optimizer/auto-trigger.ts";
import { createAutoFlow } from "./src/optimizer/auto-flow.ts";
import { evaluateShadow } from "./src/optimizer/shadow.ts";
import { evaluateCanary, decideCanaryAction } from "./src/optimizer/canary-eval.ts";

const DIRECT_PREFIXES = ["deepseek", "moonshotai", "z-ai", "qwen"];

export default async function (pi: ExtensionAPI) {
  ensureDataDir();
  const cfg = loadConfig();

  // Dual store: shared telemetry (runs) + per-template config/pin/arena/workloop
  const sharedStore = new SqliteStore(sharedDbPath());
  const localDir = localConfigDir();
  mkdirSync(localDir, { recursive: true });
  const localStore = new SqliteStore(join(localDir, "agent-lab.db"));

  // Composite store: delegates telemetry ops to sharedStore, config/pin to localStore
  const store: Store = {
    appendRun: (r) => sharedStore.appendRun(r),
    aggregateByRole: (role, templateId?) => sharedStore.aggregateByRole(role, templateId),
    listRoles: (templateId?) => sharedStore.listRoles(templateId),
    getPin: (role) => localStore.getPin(role),
    setPin: (role, model) => localStore.setPin(role, model),
    clearPin: (role) => localStore.clearPin(role),
    getConfig: () => localStore.getConfig(),
    setConfig: (k, v) => localStore.setConfig(k, v),
    close: () => { sharedStore.close(); localStore.close(); },
  };
  const catalog = new CatalogService({ directPrefixes: DIRECT_PREFIXES, ttlMs: cfg.catalogTtlMs });
  await catalog.refresh().catch((e: Error) => console.error("[agent-lab] initial catalog refresh failed:", e?.message ?? e));

  const endowment = new EndowmentPolicyV1(cfg.arena);
  const ledger = new SqliteLedger(sharedStore.raw, endowment);

  let schedulerCore: LabCore | undefined;
  let optimizerRegistry: OptimizerRegistry | undefined;
  let autoTrigger: AutoTrigger | undefined;
  let autoFlow: ReturnType<typeof createAutoFlow> | undefined;

  for (const t of ledger.staleTasks(cfg.arena.market.staleTaskTimeoutMs)) {
    ledger.recoverStaleTask(t.taskId);
  }

  // Reconcile frozen residue from pre-P4a era (frozen>0, no freeze row).
  // Per-agent: return frozen to balance, zero frozen column, compensating credit_tx.
  const reconciled = ledger.reconcileFrozenResidue();
  for (const { agent, frozenBefore } of reconciled) {
    const event = {
      eventId: `migration-reconciled-${agent}-${Date.now()}`,
      eventType: "migration.reconciled",
      schemaVersion: "1.0",
      timestamp: Date.now(),
      identity: { traceId: `migration-reconcile-${Date.now()}` },
      payload: { agent, frozenBefore, frozenAfter: 0, balanceChange: frozenBefore },
    };
    try {
      if (schedulerCore) {
        schedulerCore.events.append(event);
      } else {
        console.error("[agent-lab] migration.reconciled event unavailable (schedulerCore not ready):", JSON.stringify(event));
      }
    } catch (e) {
      console.error("[agent-lab] failed to emit migration.reconciled event:", e);
    }
  }
  // Audit-only migration.ledger-baseline snapshot (no state change).
  {
    const creditsCount = (sharedStore.raw.prepare("SELECT COUNT(*) AS c FROM credits").get() as { c: number }).c;
    const tasksCount = (sharedStore.raw.prepare("SELECT COUNT(*) AS c FROM market_tasks").get() as { c: number }).c;
    const baselineEvent = {
      eventId: `migration-ledger-baseline-${Date.now()}`,
      eventType: "migration.ledger-baseline",
      schemaVersion: "1.0",
      timestamp: Date.now(),
      identity: { traceId: `migration-baseline-${Date.now()}` },
      payload: { creditsCount, tasksCount },
    };
    try {
      if (schedulerCore) {
        schedulerCore.events.append(baselineEvent);
      } else {
        console.error("[agent-lab] migration.ledger-baseline event unavailable (schedulerCore not ready):", JSON.stringify(baselineEvent));
      }
    } catch (e) {
      console.error("[agent-lab] failed to emit migration.ledger-baseline event:", e);
    }
  }

  // Lazy scheduler runtime factory — select-mode sidecar (no Delegation V2 bus).
  // Construction failures are caught and the bridge falls through to legacy classic.
  let schedulerRuntime: SchedulerRuntimeLike | undefined;
  let runtimeInitAttempted = false;
  let bootstrapPromise: Promise<void> | undefined;
  // Lazy arena model caller: populated from interceptor ctx on first tool_call.
  let arenaModelCaller: ModelCaller | undefined;
  // Lazy delegation event bus: captured from ctx.events on first tool_call (Q1 verified).
  let delegationBus: EventBus | undefined;
  const schedulerRuntimeFactory = (): SchedulerRuntimeLike | undefined => {
    if (!runtimeInitAttempted) {
      runtimeInitAttempted = true;
      try {
        const ports = {
          candidates: () => catalog.candidates(),
          aggregates: (role: string) => new Map(store.aggregateByRole(role).map((a) => [a.model, a])),
          pinLookup: (role: string) => store.getPin(role),
        };
        const rt = createSchedulerRuntime(sharedStore.raw, delegationBus ? {
          eventBus: delegationBus,
          // pi-default-loop delegates via eventBus; stub ports satisfy the constructor.
          model: { async complete() { throw new Error("stub: pi-default-loop uses eventBus delegation"); } },
          tools: { async execute() { throw new Error("stub: tools not available in managed loop v1"); } },
          artifacts: {
            async put() { return crypto.randomUUID(); },
            async get() { return undefined; },
          },
        } : {});
        schedulerCore = rt.core;
        optimizerRegistry = new OptimizerRegistry(rt.core.definitions, rt.core.repository, rt.core.events);

        // ── Startup guard: clean smoke-round residue from prior crash ──
        {
          const arenaRecord = schedulerCore.repository.getInstance("default-arena");
          if (arenaRecord && arenaRecord.currentRoundId.startsWith("smoke-round-")) {
            const seq0 = sharedStore.raw.prepare(
              "SELECT id FROM lab_optimization_rounds WHERE scheduler_instance_id = ? AND sequence = 0 LIMIT 1"
            ).get("default-arena") as { id: string } | undefined;
            if (seq0) {
              sharedStore.raw.prepare(
                "UPDATE lab_scheduler_instances SET current_round_id = ? WHERE id = ?"
              ).run(seq0.id, "default-arena");
            }
            sharedStore.raw.prepare(
              "DELETE FROM lab_optimization_rounds WHERE scheduler_instance_id = ? AND id LIKE 'smoke-round-%'"
            ).run("default-arena");
            console.error("[agent-lab] startup guard: cleaned smoke-round residue for default-arena");
          }
        }

        // Sequential bootstrap: weighted-scorer MUST be active before arena
        // (arena fallbackChain points to weighted-scorer, validated by ControlPlane).
        // Wrapped in a single void promise with per-step fail-open catches.
        bootstrapPromise = (async () => {
          // derived→UUID agent id 迁移（旧 agent-arena-* / agent-* → UUID + model 列）。
          // 必须在 ensure*Instance 的 findOrCreateAgentByModel 之前跑，避免重复。
          try {
            migrateDerivedAgentIds(rt.core, "default-weighted-scorer", sharedStore.raw);
            migrateDerivedAgentIds(rt.core, "default-arena", sharedStore.raw);
          } catch (err) {
            console.error("[agent-lab] derived→UUID agent migration failed (fail-open):", err);
          }

          const wsResult = await ensureWeightedScorerInstance(
            rt.core,
            rt.schedulers,
            ports,
            { instanceId: cfg.scheduler?.instanceId },
          ).catch((err) => {
            console.error("[agent-lab] weighted-scorer bootstrap failed (fail-open):", err);
            return null;
          });

          if (wsResult) {
            // Arena ports: ledger, candidates, lazy modelCaller
            const arenaCaller: ModelCaller = {
              complete: async (modelId: string, prompt: string, timeoutMs: number) => {
                if (!arenaModelCaller) {
                  throw new Error("Arena model caller not yet initialized — interceptor must fire first");
                }
                return arenaModelCaller.complete(modelId, prompt, timeoutMs);
              },
            };

            const arenaPorts = {
              ledger,
              candidates: () => catalog.candidates(),
              modelCaller: arenaCaller,
              resolveAgent: (m: ModelInfo) => findOrCreateAgentByModel(rt.core, "default-arena", m, process.env.PI_TEMPLATE),
              resolveTemplate: (agentId: string) => {
                const agents = rt.core.repository.listAgents("default-arena");
                return agents.find((a) => a.id === agentId)?.sourceTemplateId;
              },
              bidBoard: getBidBoard(),
            };

            // Arena is always bootstrapped (registered/activated, addressable by
            // explicit instance id). The catch-all routing binding is only added
            // in market mode — static per boot; switching /lab mode needs restart.
            await ensureArenaInstance(rt.core, rt.schedulers, arenaPorts, {
              wsInstanceId: wsResult.instanceId,
              ...(cfg.mode === "market"
                ? { routingBindings: [{ id: "arena-default", priority: 10, match: {} }] }
                : {}),
            }).catch((err) => {
              console.error("[agent-lab] arena bootstrap failed (fail-open):", err);
            });

            // ── Ledger key migration: model id → agent UUID ──────────
            // Migrate credits/credit_tx/market_tasks/arena_freezes agent keys
            // from raw model ids (legacy) to UUIDs. Uses lab_agent_instances
            // model→UUID mapping populated by ensureArenaInstance above.
            // Idempotent: already-migrated UUIDs skip (resolveAgentId returns undefined).
            try {
              const agents = rt.core.repository.listAgents("default-arena");
              const modelToUuid = new Map(agents.filter(a => a.model).map(a => [a.model!, a.id]));
              if (modelToUuid.size > 0) ledger.migrateAgentKeys((v: string) => modelToUuid.get(v));
            } catch (err) {
              console.error("[agent-lab] ledger key migration failed (fail-open):", err);
            }

            // ── Optimizer bootstrap (fail-open) ──────────────────────────
            try {
              optimizerRegistry!.registerOptimizer(weightedTunerDefinition);
              const wsRec = rt.core.repository.getInstance(wsResult.instanceId);
              if (wsRec) {
                try {
                  optimizerRegistry!.createOptimizerInstance(
                    { kind: "optimizer", id: "weighted-tuner", version: "1.0.0" },
                    {
                      instanceId: "default-weighted-tuner",
                      config: {},
                      targetSchedulers: [wsResult.instanceId],
                    },
                  );
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  if (!msg.includes("UNIQUE constraint") && !msg.includes("already exists")) {
                    console.error("[agent-lab] default-weighted-tuner bootstrap failed (fail-open):", err);
                  }
                }
              }
            } catch (err) {
              console.error("[agent-lab] optimizer bootstrap failed (fail-open):", err);
            }

            // ── Auto-trigger + auto-flow bootstrap (fail-open) ──────────
            try {
              const optimizerCfg = cfg.optimizer;
              if (optimizerCfg?.autoTrigger?.enabled || optimizerCfg?.shadow?.enabled ||
                  (optimizerCfg?.canaryPercent ?? 0) > 0 || optimizerCfg?.autoPromote?.enabled ||
                  optimizerCfg?.autoRollback?.enabled) {
                const wsInstanceId = wsResult.instanceId;

                // Auto-trigger: throttled fire-and-forget on run recorded
                autoTrigger = createAutoTrigger({
                  config: optimizerCfg.autoTrigger,
                  run: (id: string) => optimizerFacade!.run(id).catch(() => {}),
                });

                // Auto-flow: orchestration tick
                autoFlow = createAutoFlow({
                  repository: rt.core.repository,
                  events: rt.core.events,
                  controlPlane: rt.core.controlPlane,
                  config: optimizerCfg,
                  evaluateShadow: (proposalId: string) => evaluateShadow({
                    repository: rt.core.repository,
                    events: rt.core.events,
                    db: sharedStore.raw,
                    getCatalogSnapshot: () => catalog.candidates(),
                    optimizerInstanceId: "default-weighted-tuner",
                    schedulerInstanceId: wsInstanceId,
                  }, proposalId),
                  evaluateCanary: (sid: string) => evaluateCanary({
                    repository: rt.core.repository,
                    events: rt.core.events,
                    db: sharedStore.raw,
                  }, sid),
                  decideCanaryAction,
                });
              }
            } catch (err) {
              console.error("[agent-lab] auto-trigger/auto-flow bootstrap failed (fail-open):", err);
            }
          }
        })();

        schedulerRuntime = rt.schedulerRunner;
      } catch (err) {
        // fail-open: runtime construction errors leave bridge unavailable
        console.error("[agent-lab] scheduler runtime init failed (fail-open):", err);
      }
    }
    return schedulerRuntime;
  };

  const settleDispatch = createSettleDispatch(() => schedulerRuntime);
  // Lazy auto-trigger hook: captures autoTrigger ref (set during bootstrap).
  // Fail-open by design: never throws into telemetry handler (L7/I7).
  registerTelemetry(pi, store, cfg, settleDispatch, () => {
    try { autoTrigger?.maybeTrigger("default-weighted-tuner"); } catch { /* swallow */ }
  });
  // Populate arena model caller from interceptor ctx (needed by arena scheduler bidding).
  // This runs before the main interceptor so arenaModelCaller is available on first dispatch.
  pi.on("tool_call", async (_event, ctx) => {
    if (!arenaModelCaller) {
      try {
        arenaModelCaller = createModelCaller(ctx);
      } catch {
        // fail-open: arena bidding will error on first use
      }
    }
    if (!delegationBus && ctx.events) {
      delegationBus = ctx.events;
    }
  });

  registerInterceptor(pi, cfg, schedulerRuntimeFactory);

  // ── 会话启动时建 agent 实例（C2：pit 设 PI_AGENT_INSTANCE_ID，agent-lab 拥有表）─────
  pi.on("session_start", async () => {
    const agentInstanceId = process.env.PI_AGENT_INSTANCE_ID;
    if (!agentInstanceId) return;   // 非 pit agent run 起的会话
    try {
      if (bootstrapPromise) { try { await bootstrapPromise; } catch { /* fail-open */ } }
      if (!schedulerCore) return;
      const model = catalog.candidates()[0];   // 阶段 2 简化：用首个候选 model
      if (!model) return;
      ensureSessionAgent(schedulerCore, agentInstanceId, "default-arena", model, process.env.PI_TEMPLATE);
    } catch (err) {
      console.error("[agent-lab] session agent creation failed (fail-open):", err);
    }
  });

  // ── Arena smoke: real-bidding verification ───────────────────────
  const arenaSmoke = async (role: string, cmdCtx: ExtensionContext, engine?: "model-caller" | "workloop"): Promise<string> => {
    const evidence: string[] = [];
    const errors: string[] = [];
    const traceId = `smoke-${Date.now()}`;
    const settlementRef = `${traceId}-settlement`;

    function stage(name: string, ...items: string[]) {
      evidence.push(`\n── ${name} ──`);
      for (const item of items) evidence.push(item);
    }

    function failStage(name: string, err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      evidence.push(`\n── ${name} (FAILED: ${msg}) ──`);
    }

    const header = [
      `Arena Smoke: ${role}`,
      `traceId: ${traceId}`,
      `注: 真实执行与遥测结算不在本命令范围内`,
    ];

    // ── Precondition 1: scheduler enabled ──────────────────────────
    if (!cfg.scheduler?.enabled) {
      return "预检失败: Scheduler not enabled. Enable with /lab config scheduler.enabled true";
    }

    // ── Initialize runtime + await bootstrap (mirror execute/bench) ──
    // bootstrap 是 fire-and-forget 异步；新会话不先初始化则 arena 实现未注册、schedulerCore 为空。
    schedulerRuntimeFactory();
    if (bootstrapPromise) { try { await bootstrapPromise; } catch { /* fail-open */ } }

    // ── Precondition 2: arena instance active ──────────────────────
    if (!schedulerCore) {
      return "预检失败: Scheduler core not initialized. Check /lab scheduler status";
    }
    const arena = schedulerCore.repository.getInstance("default-arena");
    if (!arena || arena.status !== "active") {
      return "预检失败: Arena instance not active. Check /lab scheduler status";
    }

    // ── Precondition 3: >= 2 catalog candidates ────────────────────
    const candidates = catalog.candidates();
    if (candidates.length < 2) {
      return `预检失败: Need >= 2 catalog candidates, got ${candidates.length}. Try /lab models --refresh`;
    }

    // ── Precondition 4: modelCaller available ──────────────────────
    let freshCaller = false;
    const prevCaller = arenaModelCaller;
    try {
      arenaModelCaller = createModelCaller(cmdCtx);
      freshCaller = true;
    } catch {
      if (!arenaModelCaller) {
        return "预检失败: Model caller not available. Initiate a subagent call first to initialize the model registry connection";
      }
      // use existing lazy caller
    }

    const restoreCaller = () => {
      if (freshCaller) arenaModelCaller = prevCaller;
    };

    try {
      // ── Guard-rail setup: temp round with maxBidders=2, maxCallsPerDispatch=2 ──
      const currentRound = schedulerCore.repository.getRound(arena.currentRoundId);
      if (!currentRound) {
        restoreCaller();
        return "预检失败: Current round not found for arena instance";
      }

      const params = currentRound.parameters as ArenaSchedulerParameters;
      const smokeParams: ArenaSchedulerParameters = {
        ...params,
        market: { ...params.market, maxBidders: 2 },
        bidding: { ...params.bidding, maxCallsPerDispatch: 2, ...(engine ? { engine } : {}) },
      };

      stage("Guard Rails", `maxBidders: 2 (overridden from ${params.market.maxBidders})`, `maxCallsPerDispatch: 2 (overridden from ${params.bidding.maxCallsPerDispatch})${engine ? ` · engine: ${engine} (overridden from ${params.bidding.engine})` : ""}`);

      const tempRoundId = `smoke-round-${traceId}`;
      schedulerCore.repository.insertRound({
        id: tempRoundId,
        schedulerInstanceId: "default-arena",
        sequence: 9999,
        parentRoundId: currentRound.id,
        parameters: smokeParams,
        optimizer: undefined,
        proposalId: undefined,
        status: "active",
        createdAt: Date.now(),
        activatedAt: Date.now(),
      });

      sharedStore.raw.prepare(
        "UPDATE lab_scheduler_instances SET current_round_id = ? WHERE id = ?"
      ).run(tempRoundId, "default-arena");

      const restoreRound = () => {
        sharedStore.raw.prepare(
          "UPDATE lab_scheduler_instances SET current_round_id = ? WHERE id = ?"
        ).run(currentRound.id, "default-arena");
        sharedStore.raw.prepare(
          "DELETE FROM lab_optimization_rounds WHERE id = ?"
        ).run(tempRoundId);
      };

      try {
        // ── Bidders ──
        const eligible = candidates.filter((c) =>
          matchEligibility(params.market.eligibility, c.id)
        );
        stage("Bidders",
          `Catalog candidates: ${candidates.length}, eligible: ${eligible.length}`,
          ...eligible.map((c) => `  ${c.id} [${c.accessRoute}]`)
        );

        // ── Pre-dispatch balance snapshot ──
        const preBalances = new Map<string, number>();
        for (const c of eligible) {
          preBalances.set(c.id, ledger.balance(c.id));
        }
        stage("Pre-Dispatch Balances",
          ...eligible.map((c) => `  ${c.id}: ${preBalances.get(c.id)}`)
        );

        // ── Dispatch ──
        const rt = schedulerRuntimeFactory();
        if (!rt) {
          restoreRound();
          restoreCaller();
          return "预检失败: Scheduler runtime unavailable";
        }

        let dispatchResult;
        try {
          dispatchResult = await rt.dispatch({
            traceId,
            role,
            task: `smoke test for ${role}`,
            mode: "select",
            settlementRef,
          });
        } catch (err) {
          restoreRound();
          failStage("Dispatch", err);
          return [...header, ...evidence, `\nFAILED with partial evidence`].join("\n");
        }

        stage("Dispatch Result",
          `status: ${dispatchResult.status}`,
          ...(dispatchResult.status === "completed"
            ? [
                `model: ${dispatchResult.model ?? "N/A"}`,
                `reason: ${dispatchResult.reason ?? "N/A"}`,
                `settlementRef: ${dispatchResult.settlementRef ?? "N/A"}`,
                `roundId: ${dispatchResult.roundId}`,
                `attempts: ${dispatchResult.attempts.length}`,
              ]
            : [
                `reason/error: ${JSON.stringify(
                  dispatchResult.status === "abstained"
                    ? dispatchResult.reason
                    : dispatchResult.status === "failed"
                      ? dispatchResult.error
                      : dispatchResult.target
                )}`,
              ])
        );

        // ── Post-dispatch balance snapshot ──
        stage("Post-Dispatch Balances",
          ...eligible.map((c) => {
            const bal = ledger.balance(c.id);
            const pre = preBalances.get(c.id) ?? 0;
            const delta = bal - pre;
            return `  ${c.id}: ${bal} (delta=${delta >= 0 ? "+" : ""}${delta})`;
          })
        );

        // ── Parse attempt-level bid telemetry from events ──
        if (schedulerCore && dispatchResult.status === "completed") {
          const events = schedulerCore.events.query({ traceId, limit: 500 });

          const bidCalls = events.filter((e) => e.eventType === "scheduler.arena.bid_call");
          const stakes = events.filter((e) => e.eventType === "scheduler.arena.stake");
          const balanceBefores = events.filter((e) => e.eventType === "scheduler.arena.balance_before");
          const balanceAfters = events.filter((e) => e.eventType === "scheduler.arena.balance_after");

          if (bidCalls.length > 0) {
            stage("Bid Calls",
              ...bidCalls.map((e) => {
                const p = e.payload as { agent?: string };
                return `  agent=${p.agent ?? "?"} estimated_tokens=${e.metrics?.estimated_tokens ?? "?"} cost=${e.metrics?.estimated_cost_usd ?? "?"}`;
              })
            );
          }

          if (stakes.length > 0) {
            stage("Parsed Stakes",
              ...stakes.map((e) => {
                const p = e.payload as { agent?: string };
                return `  agent=${p.agent ?? "?"} stake=${e.metrics?.stake ?? "?"}`;
              })
            );
          }

          if (balanceBefores.length > 0) {
            stage("Balances Before Freeze",
              ...balanceBefores.map((e) => {
                const p = e.payload as { agent?: string };
                return `  agent=${p.agent ?? "?"} balance=${e.metrics?.balance ?? "?"}`;
              })
            );
          }

          if (balanceAfters.length > 0) {
            stage("Balances After Freeze",
              ...balanceAfters.map((e) => {
                const p = e.payload as { agent?: string };
                return `  agent=${p.agent ?? "?"} balance=${e.metrics?.balance ?? "?"}`;
              })
            );
          }

          // ── Synthetic settle ──
          if (dispatchResult.settlementRef && rt.settle) {
            const syntheticOutcome: SettleOutcome = {
              completion: 1,
              majorError: false,
              tokensIn: 0,
              tokensOut: 0,
              cost: 0,
              toolCalls: [],
              inferenceLatencyMs: 0,
            };

            try {
              const settled = await rt.settle(dispatchResult.settlementRef, syntheticOutcome);
              stage("Synthetic Settle",
                `status: ${settled ? "settled" : "not settled (may already be settled or task not found)"}`,
                `outcome: completion=1 majorError=false (synthetic)`
              );

              // Post-settle balances
              const postSettle = eligible.map((c) => {
                const bal = ledger.balance(c.id);
                const pre = preBalances.get(c.id) ?? 0;
                const delta = bal - pre;
                return `  ${c.id}: ${bal} (delta=${delta >= 0 ? "+" : ""}${delta})`;
              });
              stage("Balances After Settle", ...postSettle);
            } catch (err) {
              failStage("Synthetic Settle", err);
            }
          }

          // ── Event trace ──
          if (events.length > 0) {
            const traceLines = events.map((e) => {
              const ts = new Date(e.timestamp).toISOString();
              const p = e.payload && typeof e.payload === "object" && Object.keys(e.payload as Record<string, unknown>).length > 0
                ? ` ${JSON.stringify(e.payload)}`
                : "";
              return `  ${ts} ${e.eventType}${p}`;
            });
            stage(`Event Trace (${events.length} events)`, ...traceLines.slice(0, 40));
            if (traceLines.length > 40) {
              evidence.push(`  ... and ${traceLines.length - 40} more events`);
            }
          }
        }

        restoreRound();
      } catch (err) {
        restoreRound();
        throw err;
      }
    } finally {
      restoreCaller();
    }

    return [...header, ...evidence].join("\n");
  };

  // ── bench (arena × HumanEval closed loop) ─────────────────────
  const bench = async (cmdCtx: ExtensionContext, n: number): Promise<string> => {
    if (!cfg.scheduler?.enabled) return "预检失败: Scheduler not enabled. /lab config scheduler.enabled true";
    // 先初始化 runtime 并等 bootstrap 完成（注册 arena 实现），再做依赖 schedulerCore 的预检。
    // （bootstrap 是 fire-and-forget 异步；新会话不 await 则 arena 实现未注册、schedulerCore 为空。）
    const rt = schedulerRuntimeFactory();
    if (bootstrapPromise) { try { await bootstrapPromise; } catch { /* fail-open */ } }
    if (!rt || !schedulerCore) return "预检失败: Scheduler runtime unavailable. /lab scheduler status";
    const arena = schedulerCore.repository.getInstance("default-arena");
    if (!arena || arena.status !== "active") return "预检失败: Arena instance not active. /lab scheduler status";
    if (catalog.candidates().length < 2) return "预检失败: Need >= 2 catalog candidates. /lab models --refresh";

    const prevCaller = arenaModelCaller;
    let fresh = false;
    try { arenaModelCaller = createModelCaller(cmdCtx); fresh = true; } catch { if (!arenaModelCaller) return "预检失败: Model caller unavailable — initiate a subagent call first"; }
    const restore = () => { if (fresh) arenaModelCaller = prevCaller; };

    try {
      const tasks = await loadHumanEval(n);
      if (tasks.length === 0) return "预检失败: 无 HumanEval 任务（下载/缓存失败）";
      const round = schedulerCore.repository.getRound(arena.currentRoundId);
      const eligibility = (round?.parameters as { market?: { eligibility?: string } })?.market?.eligibility ?? "all";
      const ports: BenchPorts = {
        dispatch: (req) => rt.dispatch(req),
        settle: (ref, o) => rt.settle(ref, o),
        balance: (a) => ledger.balance(a),
        getTask: (id) => ledger.getTask(id),
        candidates: () => catalog.candidates(),
        eligibility,
        matchEligibility: (p, id) => matchEligibility(p, id),
        executeModel: (m, p) => arenaModelCaller!.complete(m, p, 60000),
        genTimeoutMs: 60000, judgeTimeoutMs: 10000,
      };
      const report = await runBench(ports, tasks);
      const file = writeBenchJson(localConfigDir(), report);
      return renderBenchReport(report) + `\n\n报告已写入: ${file}`;
    } finally { restore(); }
  };

  // ── /lab execute: execute-mode dispatch (arena竞价 → WorkLoop执行) ──
  const executeDispatch = async (role: string, task: string): Promise<string> => {
    if (!cfg.scheduler?.enabled) return "预检失败: Scheduler not enabled. /lab config scheduler.enabled true";
    const rt = schedulerRuntimeFactory();
    if (bootstrapPromise) { try { await bootstrapPromise; } catch { /* fail-open */ } }
    if (!rt || !schedulerCore) return "预检失败: Scheduler runtime unavailable. /lab scheduler status";
    const arena = schedulerCore.repository.getInstance("default-arena");
    if (!arena || arena.status !== "active") return "预检失败: Arena instance not active. /lab scheduler status";
    if (!delegationBus) return "预检失败: Delegation bus unavailable — initiate a subagent call first to capture ctx.events";

    const traceId = `exec-${Date.now()}`;
    const settlementRef = `${traceId}-settlement`;
    try {
      const result = await rt.dispatch({
        traceId,
        role,
        task,
        mode: "execute",
        settlementRef,
      });
      if (result.status === "completed") {
        const out = result.output as { text?: string } | undefined;
        const lines = [
          `Execute: ${role} → ${result.model ?? result.selectedAgentId ?? "?"} (completed)`,
          `reason: ${result.reason ?? "-"}`,
        ];
        if (out?.text) lines.push("", out.text);
        return lines.join("\n");
      }
      if (result.status === "abstained") return `Execute: abstained — ${result.reason}`;
      if (result.status === "fallback") return `Execute: fallback — ${result.target.type}`;
      return `Execute: failed — ${result.error.code}: ${result.error.message}`;
    } catch (err) {
      return `Execute: error — ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // ── Optimizer facade (lazy: resolves schedulerCore/optimizerRegistry at call time) ──
  const optimizerFacade: OptimizerFacade = buildOptimizerFacade({
    getCore: () => schedulerCore,
    getRegistry: () => optimizerRegistry,
    getDb: () => sharedStore.raw,
    getCatalog: () => catalog.candidates(),
    getOptimizerConfig: () => cfg.optimizer,
    getAutoTriggerStatus: () => autoTrigger?.status(),
    onRunTick: (sid: string) => { autoFlow?.tick(sid).catch(() => {}); },
  });

  // ── Experiment facade (lazy: resolves DB at call time) ──────────
  const experimentFacade: ExperimentFacade = buildExperimentFacade({
    getDb: () => sharedStore.raw,
  });

  registerCommands(pi, {
    store, catalog, cfg, ledger, saveConfig,
    optimizerFacade,
    experimentFacade,
    schedulerRuntime: schedulerRuntimeFactory,
    getSchedulerEvents: (limit: number) => {
      if (!schedulerCore) return [];
      return schedulerCore.events.query({ limit });
    },
    syncSchedulerAgents: () => {
      if (!schedulerCore) return 0;
      const wsInstanceId = cfg.scheduler?.instanceId ?? "default-weighted-scorer";
      let added = syncWeightedScorerAgents(schedulerCore, wsInstanceId, catalog.candidates());
      if (cfg.mode === "market") {
        try {
          added += syncArenaAgents(schedulerCore, "default-arena", catalog.candidates());
        } catch {
          // arena may not be bootstrapped yet — ignore
        }
      }
      return added;
    },
    getEffectiveRouting: () => {
      if (!schedulerCore) return "bootstrap pending";
      if (cfg.scheduler?.instanceId) {
        return `explicit → ${cfg.scheduler.instanceId} (bypasses catch-all)`;
      }
      const bindings = schedulerCore.repository.listRoutingBindings();
      const arenaBinding = bindings.find((b) => b.id === "arena-default" && b.schedulerInstanceId === "default-arena");
      if (arenaBinding) {
        return "catch-all → default-arena (market)";
      }
      return "catch-all → default-arena (classic — no binding)";
    },
    arenaSmoke,
    bench,
    executeDispatch,
    runMigration: (dryRun: boolean) => {
      const ensureArenaBinding = () => {
        // Force the lazy bootstrap before checking — running /lab migrate
        // before any dispatch must not strand the binding step.
        schedulerRuntimeFactory();
        if (!schedulerCore) return { ok: false, reason: "bootstrap-pending" };
        const arena = schedulerCore.repository.getInstance("default-arena");
        if (!arena || arena.status !== "active") {
          return { ok: false, reason: "arena-bootstrap-pending (async; retry shortly or after any dispatch)" };
        }
        try {
          schedulerCore.controlPlane.setCatchAllBinding("default-arena", true);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: (err as Error).message };
        }
      };
      return dryRun
        ? runP7DryRun({
            cfg,
            store,
            ensureArenaBinding,
            dbPath: sharedDbPath(),
          })
        : runP7Migration({
            cfg,
            store,
            ensureArenaBinding,
            dbPath: sharedDbPath(),
          });
    },
  });

  pi.on("session_shutdown", async () => { try { store.close(); } catch { /* ignore */ } });
}
