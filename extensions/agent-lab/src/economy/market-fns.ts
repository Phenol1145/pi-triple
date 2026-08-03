// 市场 code fns 前半（plan Task 2 / spec §5.1）。
// 注册到 CodeRegistry：market.announce / market.shortlist / market.select。
// 注意：本模块位于 agent-lab，无法直接导入 PTL 的 code-registry.ts；因此本地定义最小
// CodeRegistry / CodeFn 接口，注册时接受任意实现了 register(name, fn) 的对象。
import type { Ledger } from "../arena/types.ts";
import type { VoucherPort } from "./voucher-port.ts";
import type { MarketStore, MarketTask } from "./market-store.ts";
import { EloFormulaRegistry, SelectionFormulaRegistry, ELO_DEFAULTS } from "./elo.ts";
import type { TaskTypeRegistry } from "./task-types.ts";
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

/** 校准任务池占位（Task 6 替换为真实 CalibrationPool）。 */
export interface CalibrationPlaceholder {
  draw(rng: () => number): { taskId: string; brief: string; groundTruth: string; groundTruthScore: number } | undefined;
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
  calibration?: CalibrationPlaceholder;
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

  let cal: { taskId: string; brief: string; groundTruth: string; groundTruthScore: number } | undefined;
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
    groundTruth: cal?.groundTruth,
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
