import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulingResult,
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
      // 1. Only select mode supported
      if (input.mode === "execute") {
        return {
          status: "failed",
          error: {
            code: "execute-unsupported",
            message: "Arena scheduler only supports select mode",
            retryable: false,
          },
        };
      }

      // 2. settlementRef required (freeze guard)
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
        ports.ledger.ensureEndowed(agentId, m);         // ledger 按 UUID 键控
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

      const bidPromises = bidders.map(
        async (
          st,
        ): Promise<{ agent: string; stake: number; balance: number }> => {
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

          // balance_before + odds
          sdk.telemetry.emit(
            "scheduler.arena.balance_before",
            { agent: st.agent },
            { balance: st.balance },
          );
          sdk.telemetry.emit(
            "scheduler.arena.odds",
            { agent: st.agent },
            { odds: task.odds },
          );

          // Aborted signal → skip remaining calls
          if (input.signal?.aborted) {
            sdk.telemetry.emit(
              "scheduler.arena.stake",
              { agent: st.agent },
              { stake: 0 },
            );
            return { agent: st.agent, stake: 0, balance: st.balance };
          }

          try {
            const reply = await ports.modelCaller.complete(
              st.model.id,           // C1: 传 model id（非 agent UUID）
              prompt,
              params.bidding.timeoutMs,
            );

            const rawBid = parseBidResponse(reply, st.balance);

            // Stake clamp: min(bid, balance, floor(balance * maxStakeRatio))
            const maxByRatio = Math.floor(
              st.balance * params.risk.maxStakeRatio,
            );
            const stake = Math.min(rawBid, st.balance, maxByRatio);

            sdk.telemetry.emit(
              "scheduler.arena.stake",
              { agent: st.agent },
              { stake },
            );
            return { agent: st.agent, stake, balance: st.balance };
          } catch {
            // fail-open: single call failure → stake 0
            sdk.telemetry.emit(
              "scheduler.arena.stake",
              { agent: st.agent },
              { stake: 0 },
            );
            return { agent: st.agent, stake: 0, balance: st.balance };
          }
        },
      );

      const bidResults = await Promise.all(bidPromises);

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
            );
          }
        }
      }

      // 10. No eligible bids → failed (triggers fallback, not abstain)
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

      // 13. Create task (winner UUID + modelId)
      const winnerModel = states.find(s => s.agent === winner.agent)!.model.id;
      const round = ports.ledger.nextRound();
      ports.ledger.createTask(task, winner.agent, winner.stake, round, winnerModel);

      // 14. Emit balance_after
      sdk.telemetry.emit(
        "scheduler.arena.balance_after",
        { agent: winner.agent },
        { balance: ports.ledger.balance(winner.agent) },
      );

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

      // Unfreeze the stake
      ports.ledger.unfreeze(row.winner, taskRef);

      const net = D - U;
      if (net >= 0) {
        ports.ledger.credit(row.winner, net, "settle", taskRef, row.round);
      } else {
        ports.ledger.debit(row.winner, -net, "settle", taskRef, row.round);
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
