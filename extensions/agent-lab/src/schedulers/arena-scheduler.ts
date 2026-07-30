import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulingResult,
  SchedulerSDK,
  SettleContext,
  SettleOutcome,
} from "../scheduler/contracts.ts";
import type { Ledger, ModelCaller, AgentState, ArenaTask } from "../arena/types.ts";
import type { ModelInfo } from "../types.ts";
import type { ArenaSchedulerParameters } from "./arena-definition.ts";
import {
  matchEligibility,
  ARENA_DEFAULT_PARAMETERS,
  arenaParamsToArenaConfig,
} from "./arena-definition.ts";
import {
  TopBalanceSelector,
  RandomSelector,
  renderBidPrompt,
  parseBidResponse,
  SettlementPolicyV1,
  CostModelV1,
  OddsPolicyV1,
} from "../arena/policies.ts";

// ── Ports ─────────────────────────────────────────────────────────────

export interface ArenaSchedulerPorts {
  ledger: Ledger;
  candidates(): ModelInfo[];
  modelCaller: ModelCaller;
  resolveAgent: (model: ModelInfo) => string;
  /** Resolve agent UUID → templateId (from lab_agent_instances.source_template_id). */
  resolveTemplate?: (agentId: string) => string | undefined;
  /** WorkLoop 竞价（框架原生）：经 ModelPort 跑 arena-bid-loop 取 stake。缺失时 workloop 引擎回退 model-caller。 */
  workLoopBidder?: (
    model: ModelInfo,
    bidPrompt: string,
    opts: { agentId: string; balance: number; timeoutMs: number; traceId: string; roundId: string; dispatchId: string; signal?: AbortSignal },
  ) => Promise<{ stake: number; reasoning?: string } | undefined>;
}

// ── WorkLoop bidding helpers ────────────────────────────────────────

/** 受限并发 map：最多 limit 个 fn 同时跑，保持结果顺序。 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 按引擎取原始出价：workloop → workLoopBidder port；否则 model-caller。 */
async function solicitRawBid(
  st: { agent: string; model: ModelInfo; balance: number },
  prompt: string,
  params: ArenaSchedulerParameters,
  ports: ArenaSchedulerPorts,
  input: SchedulingInput,
  roundId: string,
): Promise<number> {
  const engine = params.bidding.engine ?? "model-caller";
  if (engine === "workloop" && ports.workLoopBidder) {
    try {
      const bid = await ports.workLoopBidder(st.model, prompt, {
        agentId: st.agent,
        balance: st.balance,
        timeoutMs: params.bidding.timeoutMs,
        traceId: input.traceId,
        roundId,
        dispatchId: input.dispatchId,
        signal: input.signal,
      });
      return bid?.stake ?? 0;
    } catch {
      return 0; // fail-open
    }
  }
  // model-caller 引擎（默认 / fallback）
  const reply = await ports.modelCaller.complete(st.model.id, prompt, params.bidding.timeoutMs);
  return parseBidResponse(reply, st.balance);
}

// ── Factory ───────────────────────────────────────────────────────────

export function createArenaSchedulerImplementation(
  ports: ArenaSchedulerPorts,
): SchedulerImplementation {
  return {
    id: "arena",
    version: "1.0.0",

    // ── schedule ──────────────────────────────────────────────────

    async schedule(
      input: SchedulingInput,
      parameters: Readonly<unknown>,
      sdk,
    ): Promise<SchedulingResult> {
      // 1. settlementRef required (freeze guard)
      if (!input.settlementRef) {
        return {
          status: "failed",
          error: {
            code: "no-stable-task-ref",
            message:
              "settlementRef is required for arena freeze accounting",
            retryable: false,
          },
        };
      }

      const params = parameters as ArenaSchedulerParameters;

      // 3. Get candidates
      const allCandidates = ports.candidates();
      if (allCandidates.length === 0) {
        return {
          status: "failed",
          error: {
            code: "no-candidates",
            message: "no model candidates available",
            retryable: false,
          },
        };
      }

      // 4. Filter by eligibility
      const eligible = allCandidates.filter((c) =>
        matchEligibility(params.market.eligibility, c.id),
      );
      if (eligible.length === 0) {
        return {
          status: "failed",
          error: {
            code: "no-eligible-bids",
            message: "no models match eligibility filter",
            retryable: false,
          },
        };
      }

      // 5. Endow + build AgentState（UUID 身份）
      const states: AgentState[] = eligible.map((m) => {
        const agentId = ports.resolveAgent(m);          // UUID（resolveAgent 注入）
        const templateId = ports.resolveTemplate?.(agentId);
        ports.ledger.ensureEndowed(agentId, m, templateId);         // ledger 按 UUID 键控
        return {
          agent: agentId,
          model: m,
          balance: ports.ledger.balance(agentId),
        };
      });

      // 6. Select via bidder selector
      const Selector =
        params.market.bidderSelector === "random"
          ? RandomSelector
          : TopBalanceSelector;
      const selector = new Selector();
      const selected = selector.select(states, params.market.maxBidders);

      // 7. Build ArenaTask, compute odds
      const task: ArenaTask = {
        id: input.settlementRef,
        role: input.role,
        prompt: input.task,
        difficulty: "medium",
        odds: 0,
        reward: 0,
      };
      const oddsPolicy = new OddsPolicyV1(arenaParamsToArenaConfig(params));
      task.odds = oddsPolicy.odds(task);

      // 8. Bid: concurrent calls capped at maxCallsPerDispatch
      const bidders = selected.slice(0, params.bidding.maxCallsPerDispatch);
      const round = ports.ledger.nextRound();

      const bidResults = await mapConcurrent(
        bidders,
        params.bidding.maxConcurrentBids ?? 3,
        async (st): Promise<{ agent: string; stake: number; balance: number }> => {
          const prompt = renderBidPrompt(
            params.bidding.promptTemplate,
            {
              prompt: task.prompt,
              role: task.role,
              difficulty: String(task.difficulty),
              odds: task.odds,
              balance: st.balance,
            },
          );

          // estimated bid cost metric
          const estimatedTokens = Math.ceil(prompt.length / 4);
          const priceIn = st.model.pricing?.in ?? 0;
          const estimatedCost = (estimatedTokens * priceIn) / 1_000_000;
          sdk.telemetry.emit(
            "scheduler.arena.bid_call",
            { agent: st.agent },
            {
              estimated_tokens: estimatedTokens,
              estimated_cost_usd: Math.round(estimatedCost * 1e6) / 1e6,
            },
          );

          sdk.telemetry.emit("scheduler.arena.balance_before", { agent: st.agent }, { balance: st.balance });
          sdk.telemetry.emit("scheduler.arena.odds", { agent: st.agent }, { odds: task.odds });

          if (input.signal?.aborted) {
            sdk.telemetry.emit("scheduler.arena.stake", { agent: st.agent }, { stake: 0 });
            return { agent: st.agent, stake: 0, balance: st.balance };
          }

          try {
            const rawBid = await solicitRawBid(st, prompt, params, ports, input, String(round));
            const maxByRatio = Math.floor(st.balance * params.risk.maxStakeRatio);
            const stake = Math.min(rawBid, st.balance, maxByRatio);
            sdk.telemetry.emit("scheduler.arena.stake", { agent: st.agent }, { stake });
            return { agent: st.agent, stake, balance: st.balance };
          } catch {
            // fail-open: single bid failure → stake 0
            sdk.telemetry.emit("scheduler.arena.stake", { agent: st.agent }, { stake: 0 });
            return { agent: st.agent, stake: 0, balance: st.balance };
          }
        },
      );

      // 9. Opt-out tax: tax bidders who bid 0 + selected-but-not-bid
      if (params.settlement.tax > 0) {
        const bidderSet = new Set(bidResults.map((b) => b.agent));

        for (const b of bidResults) {
          if (b.stake <= 0) {
            ports.ledger.debit(
              b.agent,
              params.settlement.tax,
              "opt-out-tax",
              task.id,
              undefined,
              ports.resolveTemplate?.(b.agent),
            );
          }
        }

        // Tax selected candidates that weren't in the bid set
        for (const s of selected) {
          if (!bidderSet.has(s.agent)) {
            ports.ledger.debit(
              s.agent,
              params.settlement.tax,
              "opt-out-tax",
              task.id,
              undefined,
              ports.resolveTemplate?.(s.agent),
            );
          }
        }
      }

      // 10. minStake floor: raise small positive bids to min(minStake, balance×maxStakeRatio) (N1 clamp)
      const minStake = params.bidding.minStake ?? 0;
      if (minStake > 0) {
        for (const b of bidResults) {
          if (b.stake > 0 && b.stake < minStake) {
            const cap = b.balance * params.risk.maxStakeRatio;
            b.stake = Math.min(minStake, cap);
          }
        }
      }

      // 11. No eligible bids → failed (triggers fallback, not abstain)
      const eligibleBids = bidResults.filter((b) => b.stake > 0);
      if (eligibleBids.length === 0) {
        return {
          status: "failed",
          error: {
            code: "no-eligible-bids",
            message: "no agent placed a positive stake",
            retryable: false,
          },
        };
      }

      // 11. Pick winner: sort by stake desc, balance desc, agent asc
      eligibleBids.sort(
        (a, b) =>
          b.stake - a.stake ||
          b.balance - a.balance ||
          (a.agent < b.agent ? -1 : 1),
      );
      const winner = eligibleBids[0];

      // 12. Freeze — check return for atomic-guard failure
      const frozen = ports.ledger.freeze(
        winner.agent,
        winner.stake,
        input.settlementRef,
      );
      if (!frozen) {
        return {
          status: "failed",
          error: {
            code: "freeze-rejected",
            message: `freeze rejected for ${winner.agent}: insufficient balance`,
            retryable: false,
          },
        };
      }

      // 13. Create task (winner UUID + modelId + templateId)
      const winnerModel = states.find(s => s.agent === winner.agent)!.model.id;
      const winnerTemplate = ports.resolveTemplate?.(winner.agent);
      ports.ledger.createTask(task, winner.agent, winner.stake, round, winnerModel, winnerTemplate);

      // 14. Emit balance_after
      sdk.telemetry.emit(
        "scheduler.arena.balance_after",
        { agent: winner.agent },
        { balance: ports.ledger.balance(winner.agent) },
      );

      // 15. Execute mode: run the task through the winner's WorkLoop
      if (input.mode === "execute") {
        try {
          const runResult = await sdk.agents.run(winner.agent, { task: input.task });
          if (runResult.status === "completed") {
            return {
              status: "completed",
              model: winner.agent,
              selectedAgentId: winner.agent,
              settlementRef: input.settlementRef,
              reason: `stake ${winner.stake} round ${round} (executed)`,
              output: runResult.output,
            };
          }
          return {
            status: "failed",
            error: runResult.error ?? {
              code: "workloop-failed",
              message: `agent run ${runResult.status}`,
              retryable: runResult.status === "cancelled",
            },
          };
        } catch (err) {
          return {
            status: "failed",
            error: {
              code: "workloop-error",
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
            },
          };
        }
      }

      // Select mode: return model selection only
      return {
        status: "completed",
        model: winner.agent,
        settlementRef: input.settlementRef,
        reason: `stake ${winner.stake} round ${round}`,
      };
    },

    // ── settle ────────────────────────────────────────────────────

    async settle(
      ctx: SettleContext,
      taskRef: string,
      outcome: SettleOutcome,
    ): Promise<void> {
      // Idempotent: check task status first
      const row = ports.ledger.getTask(taskRef);
      if (!row || row.status !== "pending") return;

      // Use round parameters when threaded from schedule-time, otherwise
      // fall back to default parameters for settlement computation.
      const params = arenaParamsToArenaConfig(
        ctx.parameters ?? ARENA_DEFAULT_PARAMETERS,
      );

      const settlementPolicy = new SettlementPolicyV1(params);
      const costModel = new CostModelV1(params);

      const arenaTask: ArenaTask = {
        id: row.taskId,
        role: row.role,
        prompt: row.prompt,
        difficulty: row.difficulty as ArenaTask["difficulty"],
        odds: row.odds,
        reward: row.reward,
      };

      // Find model info for cost calculation (C2: use winnerModel, not winner UUID)
      const candidates = ports.candidates();
      const model = row.winnerModel
        ? candidates.find((m) => m.id === row.winnerModel)
        : undefined;  // winnerModel NULL 兜底（旧数据迁移）

      // NULL winnerModel: U=0 + warn（旧 task 无 winner_model 列，N1）
      if (!row.winnerModel) {
        sdk.telemetry.emit("scheduler.arena.missing_winner_model", { taskId: taskRef });
      }

      const D = settlementPolicy.settle(arenaTask, row.stake, outcome);
      const U = model ? costModel.usageCost(outcome, model) : 0;

      // Diversity penalty: reduce reward for templates that already won many tasks.
      // reward × 1/(1 + N × diversityFactor) where N = prior settled wins for same template.
      const diversityFactor = (ctx.parameters as ArenaSchedulerParameters | undefined)?.market?.diversityFactor ?? 0;
      let net = D - U;
      if (diversityFactor > 0 && row.templateId) {
        const priorWins = ports.ledger.countSettledByTemplate(row.templateId, taskRef);
        if (priorWins > 0) {
          const penalty = 1 / (1 + priorWins * diversityFactor);
          net = net * penalty;
        }
      }

      // Unfreeze the stake
      ports.ledger.unfreeze(row.winner, taskRef);

      if (net >= 0) {
        ports.ledger.credit(row.winner, net, "settle", taskRef, row.round, row.templateId);
      } else {
        ports.ledger.debit(row.winner, -net, "settle", taskRef, row.round, row.templateId);
      }

      ports.ledger.setTaskStatus(taskRef, "settled");

      // Emit settled metric
      ctx.telemetry.emit(
        "scheduler.arena.settled",
        { taskRef, winner: row.winner },
        { delta: D, usageCost: U, net },
      );

      // Emit balance_after
      ctx.telemetry.emit(
        "scheduler.arena.balance_after",
        { agent: row.winner },
        { balance: ports.ledger.balance(row.winner) },
      );

      // Bankrupt check
      if (ports.ledger.balance(row.winner) <= 0) {
        ctx.telemetry.emit(
          "scheduler.arena.bankrupt",
          { agent: row.winner },
          { balance: 0 },
        );
      }
    },
  };
}
