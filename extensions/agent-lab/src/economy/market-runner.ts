// 市场闭环运行器（plan Task 11 / spec §5.1 全图 + §12 端到端）。
//
// 引擎裁决（Task 2 前例）：agent-lab 无法 import PTL 的 code-registry / flow 引擎
// （依赖隔离——agent-lab 测试运行时不链接 src/ptl）；故 runner 以**本地编排器**形态实现：
//   - 构造时注册全部 code fns + effect fns（同时落入调用方提供的 codes/effects registry）；
//   - runMarket 顺序执行 §5.1 图：announce → persist_task → shortlist → collect_bids(fanout)
//     → select → adjust_escrow → execute → review(fanout) → consensus → settle → apply_settlement；
//   - fanout = Promise.all 并行（v1 mock 策略；真实 LLM workloop 冒烟见报告 runbook）；
//   - resume = 从 store 重建 checkpoint（economy_bids 快照 + task.status 相位）继续执行。
//
// 集成适配说明（Task 11 发现——报告记录）：
//   1. announce（Task 2）自带 createTask 预建任务行 → persist_task（Task 4）幂等 skip 会漏冻结
//      escrow。修复落在 market-effects.ts persist_task：行存在但冻结缺失时补冻结
//      （ledger.freeze 本身幂等——INSERT OR IGNORE，不重复扣款）。
//   2. economy.review_consensus 常规轮无发射点（effect 仅 operator 兜底发射）——runner 补齐
//      发射（投影 reviewerAccuracy 基源）。
//   3. CalibrationPool 新增只读 find(taskId)——announce 只返回 taskId/isCalibration，
//      groundTruthScore 需按 taskId 回查。
//   4. 未接单评审者的对称托管冻结：review_refund 只释放"已接单"者（I5 注释语义）——
//      runner 在评审轮收尾时释放从未交付的评审者冻结（不 stranded）。
//   5. ledger 类型窄化：MarketFnsDeps.ledger 为 Ledger 接口，effect 层要求共享同一
//      DatabaseSync 的 SqliteLedger（T4 裁决）——构造 effect deps 时窄化（测试注入真实实现）。
//
// v1 已知简化（报告记录）：resume 在 execute/review 相位会重放 mock 执行/凭证燃烧（真实引擎由
// checkpoint 快照跳过已激活节点——D1）；runner 只保证 effect 幂等与资金侧不重复。
import { randomUUID } from "node:crypto";
import type { SqliteLedger } from "../arena/ledger.ts";
import type { CoreRepository } from "../core/storage/repository.ts";
import {
  registerMarketCodeFns,
  type AgentLookup,
  type CodeFn,
  type CodeRegistry,
  type MarketFnsDeps,
} from "./market-fns.ts";
import { emitBurn, registerMarketEffectFns, type EffectFn, type EffectRegistry } from "./market-effects.ts";
import type { MarketTask } from "./market-store.ts";
import { freezeBid, releaseBid } from "./escrow.ts";
import { CALIBRATION_EXECUTOR_ID, calibrationExecutorRun, type CalibrationPool } from "./calibration.ts";
import { escrowMax } from "./escrow.ts";
import type { EconomyEventBus } from "./economy-events.ts";
import type { OrgMembership } from "./org.ts";
import type { SettlementPlan, ReviewInput } from "./settlement.ts";
import { experiencesFromSettlement, sedimentExperiences, type ExperienceWrite } from "./experience.ts";
import { taskRatingFromOdds } from "./elo.ts";
import type { BurnCause } from "./voucher-port.ts";

/** §5.1 图相位（resume/stopAfter 用）。 */
export type MarketPhase =
  | "announce"
  | "persist"
  | "shortlist"
  | "collect_bids"
  | "select"
  | "adjust_escrow"
  | "execute"
  | "review"
  | "consensus"
  | "settle"
  | "apply_settlement";

/** runMarket 选项：stopAfter 供故障注入/集成测试（相位持久化后可 resume）。 */
export interface MarketRunOptions {
  stopAfter?: MarketPhase;
}

/** 运行器依赖（plan Task 11 Interfaces 块逐字 + v1 编排扩展——可选字段缺省可用）。 */
export interface MarketRunnerDeps extends MarketFnsDeps {
  effects: EffectRegistry;
  codes: CodeRegistry;
  events: EconomyEventBus;
  orgMembers: OrgMembership;
  calibration: CalibrationPool;
  spawnBidder?: (agentId: string, brief: string) => Promise<{ stake: number }>; // v1 mock 策略/生产 spawnAgent
  spawnReviewer?: (reviewerId: string, deliverable: string) => Promise<{ score: number }>;
  // ── v1 编排器扩展（可选；缺省见各字段注释）──
  /** 市场候选池枚举（agentId[]——accepts 过滤由 shortlist 完成）。缺省空 → 流标。 */
  candidates?: (typeId: string) => string[];
  /** 执行者 mock（v1 无 AgentRuntime）。缺省：mock 交付（majorError=false）。 */
  spawnExecutor?: (winnerId: string, task: MarketTask) => Promise<{ output: string; majorError?: boolean }>;
  /** elo 双写落库（apply_settlement effect 消费）。缺省：elo 仅事件可见。 */
  repository?: CoreRepository;
  /** 结算税率（默认 0.05——spec 可调）。 */
  taxRate?: number;
  /** v1 凭证燃烧模拟（execute/review 相位）。缺省：不燃烧。 */
  burnUnits?: { execute?: number; review?: number };
  /** 经验沉淀管道（settle 后写 execution/bidding/review 经验）。缺省：不沉淀。 */
  experienceSink?: { write: ExperienceWrite };
}

interface MarketCheckpoint {
  phase: MarketPhase; // 下一个要执行的相位
  taskId: string;
  shortlist: string[];
  bids: { bidderId: string; stake: number }[];
  winnerId: string;
  winnerStake: number;
  reviewers: string[];
  reviews: ReviewInput[];
  majorError: boolean;
  deliverable: string;
  plan?: SettlementPlan;
}

const REVIEWER_COUNT = 5; // N
const MIN_REVIEWERS = 3; // N_min（与 review_refund effect 一致）
const STAKE_R = 10;
const ODDS_R = 2;
const VOUCHER_ALLOWANCE = 6;
const OPERATOR_ID = "operator";

function makeCtx(taskId: string): { state: Record<string, unknown>; runId: string; nodeId: string; log: (m: string) => void } {
  return { state: {}, runId: `market-run-${taskId}`, nodeId: "market-runner", log: () => {} };
}

/**
 * 市场闭环运行器（v1 本地编排器——见文件头裁决）。
 * 构造：注册全部 fns（内部 map + 外部 registry 双落）；runMarket 执行全图；
 * resumeMarket 从中断点续跑（checkpoint 恢复——fanout 快照 + effect 幂等）。
 */
export class MarketRunner {
  private readonly deps: MarketRunnerDeps;
  private readonly codeFns = new Map<string, CodeFn>();
  private readonly effectFns = new Map<string, EffectFn>();
  private readonly checkpoints = new Map<string, MarketCheckpoint>();

  constructor(deps: MarketRunnerDeps) {
    // agentLookup 缺省 → repository 回退（elo 跨轮演进依赖：apply_settlement 写 repo，
    // 后续 shortlist/select/settle 读 repo）。
    this.deps = { ...deps, agentLookup: deps.agentLookup ?? this.repoLookup(deps) };
    const codes: CodeRegistry = {
      register: (name: string, fn: CodeFn) => {
        this.codeFns.set(name, fn);
        deps.codes.register(name, fn);
      },
    };
    const effects: EffectRegistry = {
      register: (name: string, fn: EffectFn) => {
        this.effectFns.set(name, fn);
        deps.effects.register(name, fn);
      },
    };
    registerMarketCodeFns(codes, this.deps);
    registerMarketEffectFns(effects, {
      store: deps.store,
      ledger: deps.ledger as unknown as SqliteLedger, // T4 裁决：共享 DatabaseSync 的真实 ledger
      voucher: deps.voucher,
      events: deps.events,
      repository: deps.repository,
      taxRate: deps.taxRate ?? 0.05,
    });
  }

  private repoLookup(deps: MarketRunnerDeps): AgentLookup {
    return (agentId) => {
      const rec = deps.repository?.getAgent(agentId);
      if (!rec) return undefined;
      return { accepts: rec.accepts, eloGlobal: rec.eloGlobal, eloByDomain: rec.eloByDomain };
    };
  }

  private async callCode(name: string, args: Record<string, unknown>, taskId: string): Promise<Record<string, unknown>> {
    const fn = this.codeFns.get(name);
    if (!fn) throw new Error(`market runner: code fn not registered: ${name}`);
    const ctx = makeCtx(taskId);
    ctx.nodeId = name;
    return (await fn(args, ctx)) as Record<string, unknown>;
  }

  private async callEffect(name: string, args: Record<string, unknown>, taskId: string): Promise<Record<string, unknown>> {
    const fn = this.effectFns.get(name);
    if (!fn) throw new Error(`market runner: effect fn not registered: ${name}`);
    const ctx = makeCtx(taskId);
    ctx.nodeId = name;
    return (await fn(args, ctx)) as Record<string, unknown>;
  }

  /** 执行完整市场闭环（§5.1 图）。stopAfter 注入崩溃点（相位持久化，可 resume）。 */
  async runMarket(
    taskSpec: { typeId: string; publisherId: string; maxStake: number; odds: number; brief: string },
    opts: MarketRunOptions = {}
  ): Promise<{ taskId: string; status: string }> {
    // 1. announce（code——calibrationRate 概率替换 + taskId 生成 + 任务行预建）
    const spec = {
      typeId: taskSpec.typeId,
      publisherId: taskSpec.publisherId,
      maxStake: taskSpec.maxStake,
      odds: taskSpec.odds,
      reviewerCount: REVIEWER_COUNT,
      stakeR: STAKE_R,
      oddsR: ODDS_R,
      voucherAllowance: VOUCHER_ALLOWANCE,
      brief: taskSpec.brief,
    };
    const ann = await this.callCode("market.announce", { ...spec }, "pending");
    const taskId = String(ann.taskId);
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`market runner: announce produced no task: ${taskId}`);
    this.checkpoints.set(taskId, this.emptyCheckpoint(taskId));
    if (opts.stopAfter === "announce") return { taskId, status: task.status };
    // freshAnnounce=true：announce 预建任务行 → persist_task 幂等 skip（不发射 escrow_freeze）——
    // runner 在 persist 成功后补发射该事件（重试/resume 路径不补——freshOnly）。
    return this.runFrom("persist", this.checkpoints.get(taskId)!, opts, true);
  }

  /**
   * resume：市场流程中途重启 → checkpoint 恢复。
   * - 内存 checkpoint（同实例）→ 直接续跑；
   * - 新实例 → 从 store 重建（task.status 相位 + economy_bids fanout 快照）；
   * - 已结算 → 幂等 no-op。
   */
  async resumeMarket(taskId: string): Promise<{ taskId: string; status: string }> {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new Error(`market runner: resume unknown task: ${taskId}`);
    if (task.status === "settled") return { taskId, status: "settled" };
    const cp = this.checkpoints.get(taskId) ?? this.reconstructCheckpoint(task);
    return this.runFrom(cp.phase, cp, {});
  }

  private emptyCheckpoint(taskId: string): MarketCheckpoint {
    return {
      phase: "persist",
      taskId,
      shortlist: [],
      bids: [],
      winnerId: "",
      winnerStake: 0,
      reviewers: [],
      reviews: [],
      majorError: false,
      deliverable: "",
    };
  }

  /** 崩溃恢复：从 store 重建 checkpoint（status 持久化相位 + 快照从 economy_bids 读）。 */
  private reconstructCheckpoint(task: MarketTask): MarketCheckpoint {
    const cp = this.emptyCheckpoint(task.taskId);
    cp.bids = this.deps.store.getBids(task.taskId).map((b) => ({ bidderId: b.bidderId, stake: b.stake }));
    // 相位映射：open → persist（persist/collect_bids 幂等重放安全）；
    // awarded → execute；executing → review（status 在 execute 完成后置位）；reviewing → consensus。
    cp.phase = task.status === "awarded" ? "execute" : task.status === "executing" ? "review" : task.status === "reviewing" ? "consensus" : "persist";
    if (task.isCalibration === true) {
      cp.winnerId = CALIBRATION_EXECUTOR_ID;
      cp.winnerStake = 0;
    }
    return cp;
  }

  private specOf(task: MarketTask): Record<string, unknown> {
    return {
      typeId: task.typeId,
      publisherId: task.publisherId,
      maxStake: task.maxStake,
      odds: task.odds,
      reviewerCount: task.reviewerCount,
      stakeR: task.stakeR,
      oddsR: task.oddsR,
      voucherAllowance: task.voucherAllowance,
      brief: task.brief,
    };
  }

  /** 从 start 相位续跑到 apply_settlement（各相位完成即存 checkpoint——stopAfter 可截断）。 */
  private async runFrom(start: MarketPhase, cp0: MarketCheckpoint, opts: MarketRunOptions, freshAnnounce = false): Promise<{ taskId: string; status: string }> {
    const cp = { ...cp0 };
    const taskId = cp.taskId;
    const store = this.deps.store;
    const t = (): MarketTask => store.getTask(taskId)!;
    let startPhase = start;

    // ── persist_task（effect——幂等：任务已存在 → 补冻结（见 market-effects 适配）或 skip）──
    if (startPhase === "persist") {
      const task = t();
      const persistRes = await this.callEffect(
        "market.persist_task",
        {
          taskSpec: this.specOf(task),
          taskId,
          isCalibration: task.isCalibration === true,
          ...(task.groundTruth !== undefined ? { groundTruth: task.groundTruth } : {}),
        },
        taskId
      );
      if (freshAnnounce && persistRes.skipped === true) {
        // 适配说明：announce 预建行 → persist 补冻结但按契约不发射事件（created 语义）；
        // runner 按 announce 路径补偿发射（金额口径与 effect 一致——校准 stake_cal=0）。
        const p = {
          maxStake: task.isCalibration === true ? 0 : task.maxStake,
          odds: task.odds,
          reviewerCount: task.reviewerCount,
          stakeR: task.stakeR,
          oddsR: task.oddsR,
          voucherAllowance: task.voucherAllowance,
        };
        this.deps.events.emit({
          kind: "economy.escrow_freeze",
          data: { taskId, publisherId: task.publisherId, amount: escrowMax(p) },
          isCalibration: task.isCalibration === true,
        });
      }
      cp.phase = "shortlist";
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "persist") return { taskId, status: t().status };
      startPhase = "shortlist";
    }

    const isCal = t().isCalibration === true;

    // ── shortlist（code）+ collect_bids（fanout——v1 Promise.all；快照恢复：已录 bid 不重放）──
    if (startPhase === "shortlist" || startPhase === "collect_bids") {
      if (isCal) {
        // 校准任务（M-R5 stake_cal=0）：无外部竞价——跳过 shortlist/collect_bids/select。
        cp.winnerId = CALIBRATION_EXECUTOR_ID;
        cp.winnerStake = 0;
        cp.phase = "adjust_escrow";
        this.checkpoints.set(taskId, { ...cp });
        if (opts.stopAfter === "shortlist" || opts.stopAfter === "collect_bids" || opts.stopAfter === "select") {
          return { taskId, status: t().status };
        }
        startPhase = "adjust_escrow";
      } else {
        if (startPhase === "shortlist") {
          if (cp.shortlist.length === 0) {
            const candidates = this.deps.candidates?.(t().typeId) ?? [];
            const res = await this.callCode("market.shortlist", { typeId: t().typeId, candidates, maxFanout: REVIEWER_COUNT }, taskId);
            cp.shortlist = (res.shortlist as string[]) ?? [];
          }
          cp.phase = "collect_bids";
          this.checkpoints.set(taskId, { ...cp });
          if (opts.stopAfter === "shortlist") return { taskId, status: t().status };
          startPhase = "collect_bids";
        }
        // collect_bids（fanout——快照：已录竞标不重放、不重复冻结）
        if (startPhase === "collect_bids") {
          const recorded = new Map(store.getBids(taskId).map((b) => [b.bidderId, b.stake]));
          cp.bids = [...recorded.entries()].map(([bidderId, stake]) => ({ bidderId, stake }));
          const fresh = cp.shortlist.filter((agentId) => !recorded.has(agentId));
          await Promise.all(
            fresh.map(async (agentId) => {
              const r = (await this.deps.spawnBidder?.(agentId, t().brief)) ?? { stake: 0 };
              const stake = Math.max(0, Math.min(t().maxStake, Number(r.stake) || 0));
              if (stake <= 0) return;
              try {
                freezeBid(this.deps.ledger as unknown as SqliteLedger, agentId, taskId, stake, t().odds);
              } catch {
                return; // 余额不足 → 出局（不参与本轮）
              }
              store.recordBid(taskId, agentId, stake);
              this.deps.events.emit({ kind: "economy.bid_freeze", data: { taskId, bidderId: agentId, stake } });
              cp.bids.push({ bidderId: agentId, stake });
            })
          );
          cp.phase = "select";
          this.checkpoints.set(taskId, { ...cp });
          if (opts.stopAfter === "collect_bids") return { taskId, status: t().status };
          startPhase = "select";
        }
      }
    }

    // ── select（code——stake-elo-power；校准已在上方短路）──
    if (startPhase === "select") {
      // 形状适配：runner 内部 bids 用 MarketStore 口径 { bidderId, stake }（adjust_escrow/
      // 经验沉淀消费）；select code fn（Task 2 接口）消费 { agentId, stake }。
      const res = await this.callCode(
        "market.select",
        {
          shortlist: cp.shortlist,
          bids: cp.bids.map((b) => ({ agentId: b.bidderId, stake: b.stake })),
          typeId: t().typeId,
          odds: t().odds,
        },
        taskId
      );
      cp.winnerId = String(res.winnerId);
      cp.winnerStake = Number(res.winnerStake);
      cp.phase = "adjust_escrow";
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "select") return { taskId, status: t().status };
      startPhase = "adjust_escrow";
    }

    // ── adjust_escrow（effect——调减解冻 + 未中标 bid 解冻；幂等：status≠open skip）──
    if (startPhase === "adjust_escrow") {
      await this.callEffect(
        "market.adjust_escrow",
        { taskId, winnerStake: cp.winnerStake, winnerId: cp.winnerId, bids: cp.bids },
        taskId
      );
      cp.phase = "execute";
      cp.majorError = false;
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "adjust_escrow") return { taskId, status: t().status };
      startPhase = "execute";
    }

    // ── execute（winner 执行——v1 mock 交付/校准合成短路 + 凭证燃烧）──
    if (startPhase === "execute") {
      if (isCal) {
        const cal = this.deps.calibration.find(taskId);
        cp.deliverable = cal ? calibrationExecutorRun(cal).output : `task:${taskId};winner:${cp.winnerId}`;
        // 合成执行者不耗凭证（M-R5——短路产出预制交付物）
      } else {
        const exec = (await this.deps.spawnExecutor?.(cp.winnerId, t())) ?? { output: `task:${taskId};winner:${cp.winnerId};brief:${t().brief}` };
        cp.deliverable = exec.output || `task:${taskId};winner:${cp.winnerId}`;
        cp.majorError = exec.majorError === true;
        const burnUnits = this.deps.burnUnits?.execute ?? 0;
        if (burnUnits > 0) {
          try {
            const cause: BurnCause = { traceId: taskId, transitionSeq: 1 };
            emitBurn({ events: this.deps.events, voucher: this.deps.voucher }, cp.winnerId, "llm", burnUnits, cause);
          } catch {
            // 凭证不足 → 燃烧失败不阻断市场（v1）
          }
        }
      }
      store.updateTask(taskId, { status: "executing" });
      cp.phase = "review";
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "execute") return { taskId, status: t().status };
      startPhase = "review";
    }

    // ── review（fanout——评审者选择 + 流标阶梯 I12：N_min=3，重试 2 次 → operator 兜底）──
    if (startPhase === "review") {
      // 互斥预过滤：执行者 + 其同组织成员（review_shortlist code fn 内部 orgMembers 为空——
      // runner 层预过滤，见文件头适配说明）
      const orgMembers = this.deps.orgMembers;
      const executorOrg = orgMembers.orgOf(cp.winnerId);
      const excluded = new Set<string>([cp.winnerId]);
      if (executorOrg) for (const m of orgMembers.membersOf(executorOrg)) excluded.add(m);
      const pool = (this.deps.candidates?.(t().typeId) ?? []).filter((id) => !excluded.has(id));

      const res = await this.callCode(
        "market.review_shortlist",
        { taskId, winnerId: cp.winnerId, reviewerPool: pool, stakeR: t().stakeR, oddsR: t().oddsR },
        taskId
      );
      const reviewers = (res.reviewers as string[]) ?? [];
      cp.reviewers = reviewers;

      const delivered = new Set<string>();
      const allReviews: ReviewInput[] = [];
      for (let round = 1; round <= 3; round++) {
        const invitees = reviewers.filter((r) => !delivered.has(r));
        if (invitees.length === 0) break;
        const results = await Promise.all(
          invitees.map(async (reviewerId) => {
            try {
              const s = await this.deps.spawnReviewer?.(reviewerId, cp.deliverable);
              const score = s === undefined ? Number.NaN : Number(s.score);
              return { reviewerId, score };
            } catch {
              return { reviewerId, score: Number.NaN };
            }
          })
        );
        const activated = results.filter((x) => Number.isFinite(x.score) && x.score >= 0 && x.score <= 1);
        for (const a of activated) {
          delivered.add(a.reviewerId);
          allReviews.push({ reviewerId: a.reviewerId, score: a.score });
        }
        if (allReviews.length >= MIN_REVIEWERS) break;
        // 流标 → review_refund（幂等 taskId+round；第 3 轮 operator 兜底）
        await this.callEffect(
          "market.review_refund",
          {
            taskId,
            round,
            activatedReviews: activated.map(({ reviewerId, score }) => ({ reviewerId, score })),
            stakeR: t().stakeR,
            oddsR: t().oddsR,
            voucherAllowance: t().voucherAllowance,
          },
          taskId
        );
      }

      if (allReviews.length < MIN_REVIEWERS) {
        // 三轮仍流标 → operator 兜底（R=operator 评价，单评审）；
        // 未接单评审者冻结全量回收（I5 不 stranded——refund 只释放已接单者）
        for (const r of reviewers) {
          if (!delivered.has(r)) releaseBid(this.deps.ledger as unknown as SqliteLedger, r, taskId);
        }
        allReviews.length = 0;
        allReviews.push({ reviewerId: OPERATOR_ID, score: 0.5 });
      } else {
        // 评审轮成功：从未交付评审者的冻结同样回收（不参与结算）
        for (const r of reviewers) {
          if (!delivered.has(r)) releaseBid(this.deps.ledger as unknown as SqliteLedger, r, taskId);
        }
      }
      cp.reviews = allReviews;
      store.updateTask(taskId, { status: "reviewing" });
      cp.phase = "consensus";
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "review") return { taskId, status: t().status };
      startPhase = "consensus";
    }

    // ── consensus（code——中位数共识；runner 补齐发射常规轮事件——投影基源）──
    if (startPhase === "consensus") {
      const cons = await this.callCode("market.consensus", { reviews: cp.reviews }, taskId);
      const gtScore = isCal ? this.deps.calibration.find(taskId)?.groundTruthScore : undefined;
      this.deps.events.emit({
        kind: "economy.review_consensus",
        data: {
          taskId,
          R: cons.R,
          ...(gtScore !== undefined ? { groundTruthScore: gtScore } : {}),
          reviews: cp.reviews,
        },
        isCalibration: isCal,
      });
      cp.phase = "settle";
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "consensus") return { taskId, status: t().status };
      startPhase = "settle";
    }

    // ── settle（code——纯计算：结算数值 + elo 增量）──
    if (startPhase === "settle") {
      const gtScore = isCal ? this.deps.calibration.find(taskId)?.groundTruthScore : undefined;
      const plan = await this.callCode(
        "market.settle",
        {
          taskId,
          winnerId: cp.winnerId,
          winnerStake: cp.winnerStake,
          reviews: cp.reviews,
          majorError: cp.majorError === true,
          ...(gtScore !== undefined ? { groundTruthScore: gtScore } : {}),
          taxRate: this.deps.taxRate ?? 0.05,
          eloFormulaId: "simple-elo",
          taskRating: taskRatingFromOdds(t().odds),
          executorElo: this.deps.agentLookup!(cp.winnerId),
          reviewerElos: Object.fromEntries(
            cp.reviews.map((r) => [r.reviewerId, this.deps.agentLookup!(r.reviewerId) ?? { global: 1500, byDomain: {} }])
          ),
        },
        taskId
      );
      cp.plan = plan as unknown as SettlementPlan;
      cp.phase = "apply_settlement";
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "settle") return { taskId, status: t().status };
      startPhase = "apply_settlement";
    }

    // ── apply_settlement（effect——escrow 划付/负流直付/税/elo 双写；幂等 taskId）──
    if (startPhase === "apply_settlement") {
      await this.callEffect(
        "market.apply_settlement",
        { taskId, plan: cp.plan, winnerId: cp.winnerId, taxRate: this.deps.taxRate ?? 0.05 },
        taskId
      );
      // 经验沉淀（settle 侧三类：execution/bidding/review——org_default 由事件驱动，v1 不在 runner 内）
      if (this.deps.experienceSink) {
        const task = t();
        const exps = experiencesFromSettlement(cp.plan!, task, cp.bids);
        sedimentExperiences(this.deps.experienceSink, { taskId, experiences: exps });
      }
      cp.phase = "apply_settlement";
      this.checkpoints.set(taskId, { ...cp });
      if (opts.stopAfter === "apply_settlement") return { taskId, status: t().status };
    }

    return { taskId, status: t().status };
  }
}
