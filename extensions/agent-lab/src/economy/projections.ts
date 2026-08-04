// 货币循环观测投影（plan Task 8 / spec §8——只读报表）。
//
// context-projector 模式：纯函数消费事件流（EconomyEvent[]），零副作用——
// 不触碰 ledger/voucher/任何状态（I7 观测只读）。投影重建基源 =
// EconomyEventBus.replayAll()（持久化重放）或 drain()（内存消费）。
//
// 事件 data 形状约定（投影读取面——与现有 emitter 一致，缺失字段防御性跳过）：
//   currency.mint:         { agentId, amount }                      池出（endowment）
//   currency.buy_voucher:  { agentId, kind, units, creditCost }  creditCost = 支付的 credit
//   currency.burn:         { agentId, kind, units, creditCost? }    creditCost 缺省 0（现有 emitBurn 未带——见报告残余风险）
//   currency.transfer:     { taskId?, from, to, amount }            流速累计
//   currency.tax:          { taskId, amount, payer }                入池
//   currency.rate_adjust:  （报表无字段——忽略）
//   economy.settle:        { taskId, role, agentId, settle, ..., to? }  to==="central-pool" → 评审者负 settle 入池
//   economy.elo_update:    { agentId, deltaGlobal }                 elo 重建 = 1500 + Σdelta（FLOOR 100 夹紧）
//   economy.review_consensus: { taskId, R?, groundTruthScore?, reviews: [{ reviewerId, score }] }
//                            校准任务（isCalibration:true）带 groundTruthScore → a_i/bias 按 ground truth
//   escrow_*/bid_*/org_default: 审计事件（报表无字段——忽略）
import type { EconomyEvent } from "./economy-events.ts";
import type { VoucherKind } from "./voucher-port.ts";
import { CENTRAL_POOL_ID } from "./central-pool.ts";
import { ELO_DEFAULTS } from "./elo.ts";

/** §8 投影报表（只读）。 */
export interface EconomyReport {
  minted: number; burned: number; poolBalance: number;           // 发行量/池
  voucherStock: Record<VoucherKind, number>; burnRate: Record<VoucherKind, number>;  // 凭证存量/燃烧速率
  creditVelocity: number;                                        // 流速（窗口内转账量/时间）
  physicalCreditReconciliation: { kind: VoucherKind; physicalUnits: number; creditValue: number }[];  // 双层对账=价格信号
  eloDistribution: { buckets: { range: string; count: number }[] };
  reviewerAccuracy: { reviewerId: string; avgAccuracy: number; n: number }[];  // 评审准确性分布
  calibrationBias: { reviewerId: string; bias: number }[];       // 校准偏差榜（isCalibration 事件）
}

const VOUCHER_KINDS: VoucherKind[] = ["llm", "time", "compute"];

/** 中位数（偶数取上中位——与 Task 3 settlement 口径一致）。 */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : sorted[n / 2]!;
}

function num(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0;
}

/** 报表精度：准确性/偏差舍入到 1e-6（消除浮点求和伪影——如 0.1−0.2=−0.05000000000000002）。 */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function parseReviews(raw: unknown): Array<{ reviewerId: string; score: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ reviewerId: string; score: number }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.reviewerId === undefined || o.score === undefined) continue;
    out.push({ reviewerId: String(o.reviewerId), score: Number(o.score) });
  }
  return out;
}

/**
 * 事件流 → 只读投影报表。
 *
 * 累计字段（minted/burned/poolBalance/voucherStock/reconciliation/elo 分布/准确性/偏差）全量重放；
 * windowMs 仅约束速率类字段（creditVelocity/burnRate）的窗口：
 * 窗口 = [maxTs − windowMs, maxTs]（未给 windowMs → 全事件跨度 maxTs−minTs）。
 * 速率单位：credit 或凭证 units 每毫秒。
 */
export function projectEconomy(events: EconomyEvent[], windowMs?: number): EconomyReport {
  let minted = 0;
  let burned = 0;
  let poolBalance = 0;
  const stock: Record<VoucherKind, number> = { llm: 0, time: 0, compute: 0 };
  const creditValue: Record<VoucherKind, number> = { llm: 0, time: 0, compute: 0 };
  // 速率类字段需要 ts——分别收集（累计字段不依赖 ts，流内乱序不敏感）
  const burnUnits: Array<{ kind: VoucherKind; units: number; ts: number }> = [];
  const transfers: Array<{ amount: number; ts: number }> = [];
  const elo = new Map<string, number>();
  const acc = new Map<string, { sum: number; n: number }>();
  const bias = new Map<string, { sum: number; n: number }>();
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const e of events) {
    const ts = Number(e.ts) || 0;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
    const d = e.data ?? {};

    switch (e.kind) {
      case "currency.mint": {
        // 池出（endowment）：minted 增、池余额减
        const amount = num(d, "amount");
        minted += amount;
        poolBalance -= amount;
        break;
      }
      case "currency.burn": {
        const kind = d.kind as VoucherKind;
        if (!VOUCHER_KINDS.includes(kind)) break;
        const units = num(d, "units");
        const cost = num(d, "creditCost"); // 现有 emitBurn 未带 creditCost → 0（见模块头注释）
        stock[kind] -= units;
        creditValue[kind] -= cost;
        burned += cost;
        burnUnits.push({ kind, units, ts });
        break;
      }
      case "currency.buy_voucher": {
        const kind = d.kind as VoucherKind;
        if (!VOUCHER_KINDS.includes(kind)) break;
        const units = num(d, "units");
        const cost = num(d, "creditCost"); // 单字段契约（plan Task 1 命名收敛）
        stock[kind] += units;
        creditValue[kind] += cost;
        poolBalance += cost; // 凭证销售收入入池
        break;
      }
      case "currency.tax": {
        poolBalance += num(d, "amount");
        break;
      }
      case "currency.transfer": {
        transfers.push({ amount: num(d, "amount"), ts });
        break;
      }
      case "currency.rate_adjust":
      case "economy.org_default":
      case "economy.escrow_freeze":
      case "economy.escrow_adjust":
      case "economy.escrow_release":
      case "economy.bid_freeze":
      case "economy.bid_release": {
        break; // 审计事件（报表无对应字段）
      }
      case "economy.settle": {
        // 评审者负 settle 直入池（C-R4-1）——池余额增 |settle|
        if (d.to === CENTRAL_POOL_ID) {
          poolBalance += Math.abs(num(d, "settle"));
        }
        break;
      }
      case "economy.elo_update": {
        const agentId = String(d.agentId ?? "");
        if (!agentId) break;
        const prev = elo.get(agentId) ?? ELO_DEFAULTS.INITIAL;
        elo.set(agentId, prev + num(d, "deltaGlobal"));
        break;
      }
      case "economy.review_consensus": {
        const reviews = parseReviews(d.reviews);
        if (reviews.length === 0) break; // operator 兜底形状（无 reviews）→ 跳过
        const gtRaw = d.groundTruthScore;
        const gt = gtRaw !== undefined && gtRaw !== null ? Number(gtRaw) : undefined;
        const R = d.R !== undefined && d.R !== null
          ? Number(d.R)
          : median(reviews.map((r) => r.score).sort((a, b) => a - b));
        const useGt = e.isCalibration === true && gt !== undefined;
        for (const r of reviews) {
          // a_i：校准任务按 ground truth（spec §7a.7），常规按共识（1−|r_i−R|）
          const a = useGt ? 1 - Math.abs(r.score - gt) : 1 - Math.abs(r.score - R);
          const entry = acc.get(r.reviewerId) ?? { sum: 0, n: 0 };
          entry.sum += a;
          entry.n += 1;
          acc.set(r.reviewerId, entry);
          // 校准偏差榜：仅校准事件（bias = r_i − groundTruth，有符号）
          if (useGt) {
            const b = bias.get(r.reviewerId) ?? { sum: 0, n: 0 };
            b.sum += r.score - gt;
            b.n += 1;
            bias.set(r.reviewerId, b);
          }
        }
        break;
      }
    }
  }

  // 速率窗口
  const spanMs = windowMs !== undefined ? windowMs : maxTs - minTs;
  const windowStart = windowMs !== undefined ? maxTs - windowMs : minTs;
  const span = spanMs > 0 ? spanMs : 0;
  const burnInWindow: Record<VoucherKind, number> = { llm: 0, time: 0, compute: 0 };
  for (const b of burnUnits) {
    if (b.ts >= windowStart) burnInWindow[b.kind] += b.units;
  }
  let transferTotal = 0;
  for (const t of transfers) {
    if (t.ts >= windowStart) transferTotal += t.amount;
  }
  const creditVelocity = span > 0 ? transferTotal / span : 0;
  const burnRate: Record<VoucherKind, number> = {
    llm: span > 0 ? burnInWindow.llm / span : 0,
    time: span > 0 ? burnInWindow.time / span : 0,
    compute: span > 0 ? burnInWindow.compute / span : 0,
  };

  // elo 分布分桶：[100+400k, 100+400(k+1))——与 ELO_FLOOR=100 对齐；夹紧 FLOOR（与 simpleElo 一致）
  const bucketCounts = new Map<string, number>();
  for (const rating of elo.values()) {
    const clamped = Math.max(ELO_DEFAULTS.FLOOR, rating);
    const k = Math.floor((clamped - ELO_DEFAULTS.FLOOR) / 400);
    const lo = ELO_DEFAULTS.FLOOR + 400 * k;
    const range = `[${lo},${lo + 400})`;
    bucketCounts.set(range, (bucketCounts.get(range) ?? 0) + 1);
  }
  const buckets = [...bucketCounts.entries()]
    .sort((a, b) => Number(a[0].slice(1, a[0].indexOf(","))) - Number(b[0].slice(1, b[0].indexOf(","))))
    .map(([range, count]) => ({ range, count }));

  // 评审准确性：avgAccuracy 降序（并列 reviewerId 升序——确定性报表）
  const reviewerAccuracy = [...acc.entries()]
    .map(([reviewerId, v]) => ({ reviewerId, avgAccuracy: round6(v.sum / v.n), n: v.n }))
    .sort((a, b) => b.avgAccuracy - a.avgAccuracy || (a.reviewerId < b.reviewerId ? -1 : 1));

  // 校准偏差榜：|bias| 降序（并列 reviewerId 升序）
  const calibrationBias = [...bias.entries()]
    .map(([reviewerId, v]) => ({ reviewerId, bias: round6(v.sum / v.n) }))
    .sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias) || (a.reviewerId < b.reviewerId ? -1 : 1));

  return {
    minted,
    burned,
    poolBalance,
    voucherStock: stock,
    burnRate,
    creditVelocity,
    physicalCreditReconciliation: VOUCHER_KINDS.map((kind) => ({
      kind,
      physicalUnits: stock[kind],
      creditValue: creditValue[kind],
    })),
    eloDistribution: { buckets },
    reviewerAccuracy,
    calibrationBias,
  };
}
