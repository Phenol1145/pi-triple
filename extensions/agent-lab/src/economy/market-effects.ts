// 市场 effect fns（plan Task 4 / spec §5.1 图的后半——副作用原子层）。
// 注册到 EffectRegistry（本地最小接口）。遵守 D1 effect 契约：fn 按业务键幂等（taskId）+ args 只含稳定业务键。
// 事务模型（协调者裁决）：整体单事务 = SqliteLedger.transaction（复用版——内部 buy/burn/freeze 等
// 经 withSharedTransaction 复用同一事务）。
import type { SqliteLedger } from "../arena/ledger.ts";
import type { VoucherPort, BurnCause } from "./voucher-port.ts";
import type { MarketStore, MarketTask } from "./market-store.ts";
import { escrowMax, escrowActual, freezeEscrowMax, adjustEscrow, releaseBid, type EscrowParams } from "./escrow.ts";
import { poolCredit, CENTRAL_POOL_ID } from "./central-pool.ts";
import type { EconomyEventBus } from "./economy-events.ts";
import type { SettlementPlan } from "./settlement.ts";
import type { CoreRepository } from "../core/storage/repository.ts";

/** 本地 EffectFn（与 PTL effect-registry.ts 同形）。 */
export interface EffectFnContext {
  state: Readonly<Record<string, unknown>>;
  runId: string;
  nodeId: string;
  log: (msg: string) => void;
}

export type EffectFn = (args: Record<string, unknown>, ctx: EffectFnContext) => unknown | Promise<unknown>;

export interface EffectRegistry {
  register(name: string, fn: EffectFn): void;
}

export interface MarketEffectsDeps {
  store: MarketStore;
  ledger: SqliteLedger;
  voucher: VoucherPort;
  events: EconomyEventBus;
  /** elo 持久化（lab_agent_instances elo 列双写——spec §3.2）。可为空（纯计算测试用）。 */
  repository?: CoreRepository;
  /** 结算税率先读参数（默认 0.05——spec 可调）。 */
  taxRate?: number;
}

/** 从 MarketTask 读取 escrow 参数。 */
function escrowParamsOf(task: MarketTask): EscrowParams {
  return {
    maxStake: task.maxStake,
    odds: task.odds,
    reviewerCount: task.reviewerCount,
    stakeR: task.stakeR,
    oddsR: task.oddsR,
    voucherAllowance: task.voucherAllowance,
  };
}

function taskOf(store: MarketStore, taskId: string): MarketTask {
  const task = store.getTask(taskId);
  if (!task) {
    throw new Error(`market effect: task not found: ${taskId}`);
  }
  return task;
}

function isCalibrationOf(task: MarketTask): boolean {
  return task.isCalibration === true;
}

export function registerMarketEffectFns(registry: EffectRegistry, deps: MarketEffectsDeps): void {
  registry.register("market.persist_task", (args) => persistTask(deps, args));
  registry.register("market.adjust_escrow", (args) => adjustEscrowEffect(deps, args));
  registry.register("market.apply_settlement", (args) => applySettlement(deps, args));
}

// ── persist_task：任务落库 + escrow_max 冻结（幂等 taskId）──
function persistTask(deps: MarketEffectsDeps, args: Record<string, unknown>): { ok: boolean; skipped: boolean } {
  const spec = (args.taskSpec ?? {}) as Record<string, unknown>;
  const taskId = String(args.taskId ?? spec.taskId ?? "");
  if (!taskId) throw new Error("market.persist_task: taskId required");
  const publisherId = String(args.publisherId ?? spec.publisherId ?? "");
  if (!publisherId) throw new Error("market.persist_task: publisherId required");

  const task: MarketTask = {
    taskId,
    typeId: String(args.typeId ?? spec.typeId ?? ""),
    publisherId,
    maxStake: Number(args.maxStake ?? spec.maxStake ?? 0),
    odds: Number(args.odds ?? spec.odds ?? 1),
    reviewerCount: Number(args.reviewerCount ?? spec.reviewerCount ?? 5),
    stakeR: Number(args.stakeR ?? spec.stakeR ?? 10),
    oddsR: Number(args.oddsR ?? spec.oddsR ?? 2),
    voucherAllowance: Number(args.voucherAllowance ?? spec.voucherAllowance ?? 6),
    brief: String(args.brief ?? spec.brief ?? ""),
    status: "open",
    createdAt: Date.now(),
    isCalibration: Boolean(args.isCalibration ?? spec.isCalibration ?? false),
  };
  if (args.groundTruth !== undefined) task.groundTruth = String(args.groundTruth);

  // 幂等：任务已存在 → skip（不重复冻结 escrow）。
  // 原子性：createTask + freezeEscrowMax 整体事务（余额不足抛错 → 任务行回滚不落库）。
  const frozen = deps.ledger.transaction(() => {
    if (!deps.store.createTask(task)) {
      return true; // 已存在 → skip
    }
    // 发布托管：escrow_max 冻结（余额不足抛错——整体回滚，任务行不落库）。
    freezeEscrowMax(deps.ledger, publisherId, taskId, escrowParamsOf(task));
    return false;
  });
  if (frozen) {
    return { ok: true, skipped: true };
  }
  deps.events.emit({
    kind: "economy.escrow_freeze",
    data: { taskId, publisherId, amount: escrowMax(escrowParamsOf(task)) },
    isCalibration: isCalibrationOf(task),
  });
  return { ok: true, skipped: false };
}

// ── adjust_escrow：调减解冻差额 + 未中标者 bid 解冻（幂等 taskId）──
function adjustEscrowEffect(deps: MarketEffectsDeps, args: Record<string, unknown>): { ok: boolean } {
  const taskId = String(args.taskId ?? "");
  if (!taskId) throw new Error("market.adjust_escrow: taskId required");
  const task = taskOf(deps.store, taskId);
  if (task.status !== "open") {
    return { ok: true }; // 幂等：已推进 → skip
  }

  const winnerStake = Number(args.winnerStake ?? task.winnerStake ?? 0);
  const winnerId = String(args.winnerId ?? task.winnerId ?? "");
  const bids = (args.bids ?? []) as Array<{ bidderId: string; stake: number }>;

  deps.ledger.transaction(() => {
    // 调减：escrowMax → escrowActual(winnerStake)，解冻差额回 publisher。
    adjustEscrow(deps.ledger, task.publisherId, taskId, escrowParamsOf(task), winnerStake);
    // 未中标者 bid 解冻（各回各账）；中标者冻结保留至结算。
    for (const bid of bids) {
      if (bid.bidderId !== winnerId) {
        releaseBid(deps.ledger, bid.bidderId, taskId);
      }
    }
  });

  deps.events.emit({
    kind: "economy.escrow_adjust",
    data: {
      taskId,
      from: escrowMax(escrowParamsOf(task)),
      to: escrowActual(escrowParamsOf(task), winnerStake),
    },
    isCalibration: isCalibrationOf(task),
  });
  for (const bid of bids) {
    if (bid.bidderId !== winnerId) {
      deps.events.emit({
        kind: "economy.bid_release",
        data: { taskId, bidderId: bid.bidderId, stake: bid.stake },
        isCalibration: isCalibrationOf(task),
      });
    }
  }
  deps.store.updateTask(taskId, { status: "awarded", winnerId, winnerStake });
  return { ok: true };
}

// ── apply_settlement：escrow 划付/负流直付/税/elo 双写/事件（幂等 taskId，单事务）──
//
// 资金语义（协调者裁决——资金守恒）：
//   - 发布方 escrow（escrowActual 冻结额）**全额解冻回 publisher**——它本就是 publisher 预押资金。
//   - publisher 从解冻资金**支付 gross**：执行者 gross=settle（≥0 时）、评审者 gross_i=settle_i（>0 时）。
//   - 收款人实收 **net = gross − tax_i**（税从 gross 内扣减，I-R4-1）；tax_i 入池。
//   - 执行者负 settle：**不经 escrow**——从执行者冻结直付 publisher（C-2）。
//   - 评审者负 settle_i：从评审者冻结扣 → **入池**（C-R4-1 公共性罚没社会化）。
//   - 剩余（voucherAllowance + 未动用部分）自然留在 publisher。
function applySettlement(deps: MarketEffectsDeps, args: Record<string, unknown>): { ok: boolean } {
  const taskId = String(args.taskId ?? "");
  if (!taskId) throw new Error("market.apply_settlement: taskId required");
  const task = taskOf(deps.store, taskId);
  if (task.status === "settled") {
    return { ok: true }; // 幂等 skip
  }

  const plan = (args.plan ?? {}) as SettlementPlan;
  const winnerId = String(args.winnerId ?? task.winnerId ?? "");
  const rate = Number(args.taxRate ?? deps.taxRate ?? 0.05);
  const escrow = escrowParamsOf(task);

  deps.ledger.transaction(() => {
    // 0) publisher escrow 全额解冻（预押资金回账——后续支付从其中扣减）。
    releaseBid(deps.ledger, task.publisherId, taskId);

    // 1) 执行者结算：
    if (plan.executorSettle >= 0) {
      // 正向：冻结返还 + publisher 付 gross，执行者收 net，税入池。
      releaseBid(deps.ledger, winnerId, taskId); // 执行者冻结返还（bid 冻结 = stake×(O−1)）
      const gross = plan.executorSettle;
      const tax = gross * rate;
      deps.ledger.debit(task.publisherId, gross, `executor-gross ${taskId}`);
      const net = gross - tax;
      if (net > 0) deps.ledger.credit(winnerId, net, `executor-settle ${taskId}`);
      if (tax > 0) poolCredit(deps.ledger, tax, `tax ${taskId}`);
      deps.events.emit({
        kind: "economy.settle",
        data: { taskId, role: "executor", agentId: winnerId, settle: net, gross, tax },
        isCalibration: isCalibrationOf(task),
      });
      if (tax > 0) {
        deps.events.emit({ kind: "currency.tax", data: { taskId, amount: tax, payer: task.publisherId }, isCalibration: isCalibrationOf(task) });
      }
    } else {
      // 负 settle（majorError 或低完成度）：从执行者冻结直付 publisher（C-2 不经 escrow）。
      // 语义：冻结全额返还 → 执行者余额扣回 |settle| → 等额 credit publisher。
      const loss = -plan.executorSettle;
      releaseBid(deps.ledger, winnerId, taskId);
      deps.ledger.debit(winnerId, loss, `executor-negative ${taskId}`);
      deps.ledger.credit(task.publisherId, loss, `executor-negative ${taskId}`);
      deps.events.emit({
        kind: "economy.settle",
        data: { taskId, role: "executor", agentId: winnerId, settle: plan.executorSettle, to: task.publisherId },
        isCalibration: isCalibrationOf(task),
      });
    }

    // 2) 评审者结算（正 → publisher 付；负 → 评审者冻结扣入池）。
    for (const [reviewerId, settleI] of plan.reviewerSettles ?? new Map<string, number>()) {
      if (settleI > 0) {
        // 冻结返还 + publisher 付 gross，评审者收 net，税入池。
        releaseBid(deps.ledger, reviewerId, taskId);
        const tax = settleI * rate;
        deps.ledger.debit(task.publisherId, settleI, `reviewer-gross ${taskId}`);
        const net = settleI - tax;
        deps.ledger.credit(reviewerId, net, `reviewer-settle ${taskId}`);
        if (tax > 0) poolCredit(deps.ledger, tax, `tax ${taskId}`);
        deps.events.emit({
          kind: "economy.settle",
          data: { taskId, role: "reviewer", agentId: reviewerId, settle: net, gross: settleI, tax },
          isCalibration: isCalibrationOf(task),
        });
        if (tax > 0) {
          deps.events.emit({ kind: "currency.tax", data: { taskId, amount: tax, payer: task.publisherId }, isCalibration: isCalibrationOf(task) });
        }
      } else if (settleI < 0) {
        // 从评审者冻结扣 |settle_i| → 入池（C-R4-1 公共性罚没社会化）：
        // 冻结全额返还 → 评审者余额扣回 |settle_i| → 等额 credit 池。
        releaseBid(deps.ledger, reviewerId, taskId);
        deps.ledger.debit(reviewerId, -settleI, `reviewer-negative ${taskId}`);
        poolCredit(deps.ledger, -settleI, `reviewer-negative ${taskId}`);
        deps.events.emit({
          kind: "economy.settle",
          data: { taskId, role: "reviewer", agentId: reviewerId, settle: settleI, to: CENTRAL_POOL_ID },
          isCalibration: isCalibrationOf(task),
        });
      }
    }

    // 3) elo 双写（repository 可用时——global + byDomain 当前近似 global；域由 D2 完整化）。
    if (deps.repository && plan.executorEloDelta) {
      applyElo(deps, winnerId, plan.executorEloDelta.global);
      for (const [reviewerId, delta] of plan.reviewerEloDeltas ?? new Map()) {
        applyElo(deps, reviewerId, delta.global);
      }
    }
  });

  deps.store.updateTask(taskId, { status: "settled", settledAt: Date.now() });
  return { ok: true };
}

/** 持久化 elo 增量（当前值 + delta → updateElo）。无 repository 或 agent 不存在时 no-op。 */
function applyElo(deps: MarketEffectsDeps, agentId: string, deltaGlobal: number): void {
  const repo = deps.repository;
  if (!repo) return;
  const cur = repo.getAgent(agentId);
  if (!cur) return;
  const curGlobal = cur.eloGlobal ?? 1500;
  const next = { global: curGlobal + deltaGlobal, byDomain: { ...(cur.eloByDomain ?? {}) } };
  repo.updateElo(agentId, next);
  deps.events.emit({
    kind: "economy.elo_update",
    data: { agentId, deltaGlobal },
  });
}

/** 便捷：凭证燃烧（执行/评审阶段的消耗由 workloop 自身发生——此处为事件化入口）。 */
export function emitBurn(deps: { events: EconomyEventBus; voucher: VoucherPort }, agentId: string, kind: "llm" | "time" | "compute", units: number, cause: BurnCause): void {
  deps.voucher.burn(agentId, kind, units, cause);
  deps.events.emit({ kind: "currency.burn", data: { agentId, kind, units } });
}
