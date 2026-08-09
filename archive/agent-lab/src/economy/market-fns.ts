// 市场 code fns 前半（plan Task 2 / spec §5.1）。
// 注册到 CodeRegistry：market.announce / market.shortlist / market.select。
// 注意：本模块位于 agent-lab，无法直接导入 PTL 的 code-registry.ts；因此本地定义最小
// CodeRegistry / CodeFn 接口，注册时接受任意实现了 register(name, fn) 的对象。
import type { Ledger } from "../arena/types.ts";
import type { VoucherPort } from "./voucher-port.ts";
import type { MarketStore, MarketTask } from "./market-store.ts";
import { EloFormulaRegistry, SelectionFormulaRegistry, ELO_DEFAULTS, taskRatingFromOdds } from "./elo.ts";
import type { TaskTypeRegistry } from "./task-types.ts";
import { computeConsensus, planSettlement, DEFAULT_TAX_RATE, type ReviewInput } from "./settlement.ts";
import { selectReviewers, reviewShortlist, type ReviewRoundDeps } from "./review-round.ts";
import type { CalibrationPool, CalibrationTask } from "./calibration.ts";
import { randomUUID } from "node:crypto";

/** 本地 CodeFn 类型（与 PTL code-registry.ts 同形）。 */
export interface CodeFnContext {
  state: Readonly<Record<string, unknown>>;
  runId: string;
  nodeId: string;
  log: (msg: string) => void;
}

export type CodeFn = (args: Record<string, unknown>, ctx: CodeFnContext) => unknown | Promise<unknown>;

/** 本地 CodeRegistry 接口——PTL 侧仅有模块级 registerCodeFn(name, fn)，这里用对象封装。 */
export interface CodeRegistry {
  register(name: string, fn: CodeFn): void;
}

/** agent 信息查询——shortlist/select 需要从 agentId 解析 accepts 与 elo。 */
export interface AgentLookup {
  (agentId: string): { accepts?: string[]; eloGlobal?: number; eloByDomain?: Record<string, number> } | undefined;
}

export interface MarketFnsDeps {
  store: MarketStore;
  ledger: Ledger;
  voucher: VoucherPort;
  elo: EloFormulaRegistry;
  selection: SelectionFormulaRegistry;
  taskTypes: TaskTypeRegistry;
  calibrationRate: number;
  rng?: () => number;
  /** 校准任务池（Task 6：真实 CalibrationPool 替换 Task 2 占位——announce 校准分支 draw 取任务）。 */
  calibration?: CalibrationPool;
  agentLookup?: AgentLookup;
}

export interface TaskSpec {
  typeId: string;
  publisherId: string;
  maxStake: number;
  odds: number;
  reviewerCount: number;
  stakeR: number;
  oddsR: number;
  voucherAllowance: number;
  brief: string;
  taskId?: string;
}

function generateId(): string {
  // node 24+ 内置 crypto.randomUUID；无外部依赖。
  return randomUUID();
}

function readTaskSpec(state: Readonly<Record<string, unknown>>, args?: Record<string, unknown>): TaskSpec {
  const src = (state.taskSpec as Record<string, unknown> | undefined) ?? args ?? {};
  return {
    typeId: String(src.typeId),
    publisherId: String(src.publisherId),
    maxStake: Number(src.maxStake),
    odds: Number(src.odds),
    reviewerCount: Number(src.reviewerCount),
    stakeR: Number(src.stakeR),
    oddsR: Number(src.oddsR),
    voucherAllowance: Number(src.voucherAllowance),
    brief: String(src.brief),
    taskId: src.taskId !== undefined ? String(src.taskId) : undefined,
  };
}

function lookupAgent(
  deps: MarketFnsDeps,
  agentId: string
): { accepts?: string[]; eloGlobal?: number; eloByDomain?: Record<string, number> } {
  return deps.agentLookup?.(agentId) ?? {};
}

export function registerMarketCodeFns(registry: CodeRegistry, deps: MarketFnsDeps): void {
  registry.register("market.announce", (args, ctx) => announce(ctx.state, deps, args));
  registry.register("market.shortlist", (args, ctx) => shortlist(ctx.state, deps, args));
  registry.register("market.select", (args, ctx) => select(ctx.state, deps, args));
  registry.register("market.consensus", (args, ctx) => consensus(ctx.state, deps, args));
  registry.register("market.settle", (args, ctx) => settle(ctx.state, deps, args));
  // Task 5: 多评评审轮
  registry.register("market.review_shortlist", (args, ctx) => {
    const state = ctx.state;
    const task = deps.store.getTask(String(state.taskId ?? args.taskId));
    if (!task) throw new Error("market.review_shortlist: task not found");
    // 构造 ReviewRoundDeps（复用 MarketFnsDeps 中的可用字段）
    const roundDeps: ReviewRoundDeps = {
      store: deps.store,
      ledger: deps.ledger,
      orgMembers: {
        membersOf: () => [],
        orgOf: () => undefined,
        addMember: () => {},
        removeMember: () => {},
      },
      reviewerCount: task.reviewerCount,
      minReviewers: 3,
      eloLookup: deps.agentLookup ?? (() => undefined),
    };
    return reviewShortlist(roundDeps, task, {
      taskId: String(state.taskId ?? args.taskId),
      executorId: String(state.winnerId ?? args.winnerId ?? task.winnerId ?? ""),
      pool: (state.reviewerPool as string[] | undefined) ?? (args.reviewerPool as string[] | undefined) ?? [],
      stakeR: task.stakeR,
      oddsR: task.oddsR,
    });
  });
}

function announce(
  state: Readonly<Record<string, unknown>>,
  deps: MarketFnsDeps,
  args?: Record<string, unknown>
): { taskId: string; isCalibration: boolean } {
  const spec = readTaskSpec(state, args);
  const type = deps.taskTypes.get(spec.typeId);
  if (!type) {
    throw new Error(`market.announce: task type not registered: ${spec.typeId}`);
  }

  const rng = deps.rng ?? Math.random;
  const rngHitCalibration = rng() < deps.calibrationRate;

  let cal: CalibrationTask | undefined;
  if (rngHitCalibration) {
    cal = deps.calibration?.draw(rng);
  }

  // fix round 2：校准占位回退——rng 命中 calibrationRate 但 calibration 未提供 /
  // draw 返回 undefined 时不触发校准（落普通任务，isCalibration=false、groundTruth=undefined）。
  const isCalibration = rngHitCalibration && cal !== undefined;

  const taskId = cal?.taskId ?? spec.taskId ?? generateId();
  const task: MarketTask = {
    taskId,
    typeId: spec.typeId,
    publisherId: spec.publisherId,
    maxStake: spec.maxStake,
    odds: spec.odds,
    reviewerCount: spec.reviewerCount,
    stakeR: spec.stakeR,
    oddsR: spec.oddsR,
    voucherAllowance: spec.voucherAllowance,
    brief: cal?.brief ?? spec.brief,
    status: "open",
    createdAt: Date.now(),
    isCalibration,
    // CalibrationTask.groundTruthArtifact → MarketTask.groundTruth（锚定参考物引用）。
    groundTruth: cal?.groundTruthArtifact,
  };

  deps.store.createTask(task);
  return { taskId, isCalibration };
}

function shortlist(
  state: Readonly<Record<string, unknown>>,
  deps: MarketFnsDeps,
  args?: Record<string, unknown>
): { shortlist: string[] } {
  const typeId = String(state.typeId ?? args?.typeId ?? "");
  const maxFanout = Number(state.maxFanout ?? args?.maxFanout ?? Number.POSITIVE_INFINITY);
  const rawCandidates = (state.candidates as Array<string | { agentId: string; accepts?: string[]; eloGlobal?: number; eloByDomain?: Record<string, number> }> | undefined)
    ?? (args?.candidates as typeof state.candidates)
    ?? [];

  const scored = rawCandidates.map((c) => {
    const agentId = typeof c === "string" ? c : c.agentId;
    const explicit = typeof c === "string" ? {} : c;
    const info = deps.agentLookup?.(agentId) ?? explicit;
    const elo = info.eloByDomain?.[typeId] ?? info.eloGlobal ?? ELO_DEFAULTS.INITIAL;
    return { agentId, elo, accepts: info.accepts ?? explicit.accepts };
  });

  const filtered = scored.filter((s) => s.accepts !== undefined && s.accepts.includes(typeId));
  filtered.sort((a, b) => b.elo - a.elo || a.agentId.localeCompare(b.agentId));

  const shortlist = filtered.slice(0, maxFanout).map((s) => s.agentId);
  return { shortlist };
}

function select(
  state: Readonly<Record<string, unknown>>,
  deps: MarketFnsDeps,
  args?: Record<string, unknown>
): { winnerId: string; winnerStake: number } {
  const shortlist = (state.shortlist as string[] | undefined) ?? (args?.shortlist as string[] | undefined) ?? [];
  const bids = (state.bids as Array<{ agentId: string; stake: number }> | undefined)
    ?? (args?.bids as typeof state.bids)
    ?? [];
  const odds = Number(state.odds ?? args?.odds ?? (state.taskSpec as Record<string, unknown> | undefined)?.odds ?? 1);
  // fix round 2（Important 1）：select 用域 elo——byDomain[typeId] ?? global ?? INITIAL（与 shortlist/spec §3.2 一致）。
  const typeId = String(
    state.typeId ?? args?.typeId ?? (state.taskSpec as Record<string, unknown> | undefined)?.typeId ?? ""
  );
  const taskRating = 1500 + 200 * (odds - 1);

  const formula = deps.selection.get("stake-elo-power");
  const bidMap = new Map(bids.map((b) => [b.agentId, b.stake]));

  const candidates = shortlist.map((agentId) => {
    const info = lookupAgent(deps, agentId);
    const elo = info.eloByDomain?.[typeId] ?? info.eloGlobal ?? ELO_DEFAULTS.INITIAL;
    const stake = bidMap.get(agentId) ?? 0;
    const score = formula.score({ stake, elo }, { taskRating });
    return { agentId, stake, elo, score };
  });

  // fix round 2（Important 4）：同分裁决层 = score → stake → agentId 字典序（spec §3.3 字面，无 elo 层）。
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.stake !== a.stake) return b.stake - a.stake;
    return a.agentId.localeCompare(b.agentId);
  });

  const winner = candidates[0];
  if (!winner) {
    throw new Error("market.select: empty shortlist");
  }
  return { winnerId: winner.agentId, winnerStake: winner.stake };
}

// ── consensus / settle（plan Task 3 / spec §7/§7a）──
// 薄壳：从 flow state/args 读入，委托 settlement.ts 纯函数（无副作用）。

function readReviews(state: Readonly<Record<string, unknown>>, args?: Record<string, unknown>): ReviewInput[] {
  const raw = (state.reviews as ReviewInput[] | undefined) ?? (args?.reviews as ReviewInput[] | undefined) ?? [];
  return raw.map((r) => ({ reviewerId: String(r.reviewerId), score: Number(r.score) }));
}

function toElo(raw: unknown): { global: number; byDomain: Record<string, number> } {
  const e = raw as { global?: number; byDomain?: Record<string, number> } | undefined;
  return {
    global: Number(e?.global ?? ELO_DEFAULTS.INITIAL),
    byDomain: e?.byDomain ?? {},
  };
}

function toEloMap(raw: unknown): Map<string, { global: number; byDomain: Record<string, number> }> {
  const out = new Map<string, { global: number; byDomain: Record<string, number> }>();
  if (raw instanceof Map) {
    for (const [id, e] of raw) {
      out.set(String(id), toElo(e));
    }
  } else if (raw && typeof raw === "object") {
    for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
      out.set(id, toElo(e));
    }
  }
  return out;
}

function consensus(
  state: Readonly<Record<string, unknown>>,
  _deps: MarketFnsDeps,
  args?: Record<string, unknown>
): { R: number; accuracies: Map<string, number> } {
  return computeConsensus(readReviews(state, args));
}

function settle(
  state: Readonly<Record<string, unknown>>,
  deps: MarketFnsDeps,
  args?: Record<string, unknown>
): ReturnType<typeof planSettlement> {
  const taskId = String(state.taskId ?? args?.taskId ?? "");
  const task = deps.store.getTask(taskId);
  if (!task) {
    throw new Error(`market.settle: task not found: ${taskId}`);
  }

  const gtRaw = state.groundTruthScore ?? args?.groundTruthScore;
  const groundTruthScore = gtRaw !== undefined && gtRaw !== null ? Number(gtRaw) : undefined;
  const taskRating = Number(state.taskRating ?? args?.taskRating ?? taskRatingFromOdds(task.odds));
  const eloFn = deps.elo.get(String(state.eloFormulaId ?? args?.eloFormulaId ?? "simple-elo"));

  return planSettlement({
    task,
    winnerId: String(state.winnerId ?? args?.winnerId ?? task.winnerId ?? ""),
    winnerStake: Number(state.winnerStake ?? args?.winnerStake ?? task.winnerStake ?? 0),
    reviews: readReviews(state, args),
    majorError: Boolean(state.majorError ?? args?.majorError ?? false),
    groundTruthScore,
    eloFn,
    taxRate: Number(state.taxRate ?? args?.taxRate ?? DEFAULT_TAX_RATE),
    executorElo: toElo(state.executorElo ?? args?.executorElo),
    reviewerElos: toEloMap(state.reviewerElos ?? args?.reviewerElos),
    taskRating,
  });
}