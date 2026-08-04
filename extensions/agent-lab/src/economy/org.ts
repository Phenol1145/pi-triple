// 组织（spec §6 / plan Task 7）——组织 = AgentInstance + org_members 成员表 + 垫付传导。
//
// 三个交付面：
//   1. SqliteOrgMembership：org_members 表（评审互斥过滤的真实实现——Task 5 空实现替换，
//      review-round.ts 的 OrgMembership 接口结构同形，本类可直接注入 ReviewRoundDeps）。
//   2. planPayouts：垫付纯计算（凭证成本优先 → 收益；partial = 先本后息）。
//   3. executeOrgPayout：垫付执行 effect（幂等 taskId）——payouts 划付 → 余额不足全垫付
//      → 违约链（economy.org_default + 组织 elo majorError + 成员 stake 退还 + 审计事件）。
//   附：voucherCostForTask（burnHistory traceId 精确折算，spec §6.2/I2）、
//       orgProfitAfterPayouts（组织利润 = settle_org − Σpayouts − 税，允许为负——观测项）。
//
// 双重冻结（spec §5.3 M-1——注释 + 装配指引）：组织对外中标后同时承担两笔冻结——
//   外部 bid 冻结：stake_org×(O−1)（组织作为外部市场执行者，freezeBid）；
//   内部 escrow_max 冻结：内部市场任务发布托管（escrowMax——成员 maxStake 项 + 评审项
//   + voucherAllowance，freezeEscrowMax）。
//   装配指引：组织启动资本需覆盖两者之和（capital ≥ Σ外部 bid 冻结 + Σ内部 escrow_max）；
//   余额耗尽 = 无法押注 = 自然出局（spec §6.5）。
// 成员侧（M-1 成员面）：内部任务 bid 冻结（stake_member×(O−1)）冻结在成员自身账户——
//   与外部市场对称托管同构（I10）；组织违约时全额解冻退还（见 executeOrgPayout 违约链）。
import type { DatabaseSync } from "node:sqlite";
import { ELO_DEFAULTS, simpleElo, type EloFormula } from "./elo.ts";
import type { CoreRepository } from "../core/storage/repository.ts";
import type { EconomyEventBus } from "./economy-events.ts";
import type { SqliteLedger } from "../arena/ledger.ts";
import type { VoucherPort, VoucherKind } from "./voucher-port.ts";

/** 组织成员接口（plan Task 7 Interfaces 块逐字——与 review-round.ts 同形）。 */
export interface OrgMembership {
  membersOf(orgId: string): string[]; // org_members 表查询
  orgOf(agentId: string): string | undefined;
  addMember(orgId: string, agentId: string): void;
  removeMember(orgId: string, agentId: string): void;
}

const ORG_SCHEMA = `
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, agent_id)
);
CREATE TABLE IF NOT EXISTS org_payouts (
  task_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** 建表（幂等 CREATE IF NOT EXISTS）——executeOrgPayout 自包含：不依赖调用方先构造 SqliteOrgMembership。 */
function ensureOrgTables(db: DatabaseSync): void {
  db.exec(ORG_SCHEMA);
}

/**
 * SqliteOrgMembership：org_members 表实现。
 * 约束：v1 单组织约束——一个成员同一时刻至多一个组织（orgOf 取最早入表记录）；
 * 跨组织移籍需先 removeMember 再 addMember（不隐式移籍）。
 */
export class SqliteOrgMembership implements OrgMembership {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(ORG_SCHEMA);
  }

  membersOf(orgId: string): string[] {
    const rows = this.db
      .prepare(`SELECT agent_id FROM org_members WHERE org_id = ? ORDER BY created_at ASC, agent_id ASC`)
      .all(orgId) as Array<{ agent_id: string }>;
    return rows.map((r) => r.agent_id);
  }

  orgOf(agentId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT org_id FROM org_members WHERE agent_id = ? ORDER BY created_at ASC`)
      .get(agentId) as { org_id: string } | undefined;
    return row?.org_id;
  }

  addMember(orgId: string, agentId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO org_members (org_id, agent_id, created_at) VALUES (?, ?, ?)`)
      .run(orgId, agentId, Date.now());
  }

  removeMember(orgId: string, agentId: string): void {
    this.db.prepare(`DELETE FROM org_members WHERE org_id = ? AND agent_id = ?`).run(orgId, agentId);
  }
}

/** 垫付计算（纯函数，plan Task 7 Interfaces 块逐字）。 */
export interface PayoutPlan {
  memberSettles: Map<string, number>;
  voucherCosts: Map<string, number>; // burnHistory(member, kind, {traceId}) FIFO 折算
  payouts: Map<string, number>; // 凭证成本优先，再付收益（仅含 > 0 条目）
  partial: boolean; // 余额只够部分 → 先本后息
}

/**
 * planPayouts：垫付纯计算（spec §6.2）。
 * - 阶段 1（本——凭证成本优先）：全部成员成本全额付清（FIFO 成员序），余额不足 → partial；
 * - 阶段 2（息——收益）：剩余余额按成员序摊付正 settle（先到先得）。
 * - 负 settle 不垫付（成员负结算由内部市场结算另行收取——本函数只垫付正收益）。
 * - 成本非负守卫（I1 钱 fail-fast）；负 settle 允许（成员亏损方）。
 */
export function planPayouts(args: {
  orgBalance: number;
  memberSettles: Map<string, number>;
  voucherCosts: Map<string, number>;
}): PayoutPlan {
  const { orgBalance, memberSettles, voucherCosts } = args;
  if (!(orgBalance >= 0)) {
    throw new Error(`planPayouts: orgBalance must be >= 0 (got ${orgBalance})`);
  }
  // 成员并集（插入序：memberSettles 键先，voucherCosts 独有键后）
  const members: string[] = [];
  const seen = new Set<string>();
  for (const m of memberSettles.keys()) {
    members.push(m);
    seen.add(m);
  }
  for (const m of voucherCosts.keys()) {
    if (!seen.has(m)) {
      members.push(m);
      seen.add(m);
    }
  }
  for (const m of members) {
    const cost = voucherCosts.get(m) ?? 0;
    if (!(cost >= 0)) {
      throw new Error(`planPayouts: voucherCost must be >= 0 for ${m} (got ${cost})`);
    }
  }

  const costPay = new Map<string, number>();
  const incomePay = new Map<string, number>();
  let remaining = orgBalance;
  let partial = false;

  // 阶段 1（本）：凭证成本优先
  for (const m of members) {
    const cost = voucherCosts.get(m) ?? 0;
    if (cost <= 0) {
      costPay.set(m, 0);
      continue;
    }
    if (remaining >= cost) {
      costPay.set(m, cost);
      remaining -= cost;
    } else {
      costPay.set(m, remaining);
      remaining = 0;
      partial = true;
    }
  }
  // 阶段 2（息）：剩余余额按成员序摊付正 settle（先本后息 FIFO）
  for (const m of members) {
    const settle = memberSettles.get(m) ?? 0;
    if (settle <= 0) continue;
    if (remaining >= settle) {
      incomePay.set(m, settle);
      remaining -= settle;
    } else if (remaining > 0) {
      incomePay.set(m, remaining);
      remaining = 0;
      partial = true;
    } else {
      partial = true; // 正收益未付清 → partial
    }
  }

  const payouts = new Map<string, number>();
  for (const m of members) {
    const amt = (costPay.get(m) ?? 0) + (incomePay.get(m) ?? 0);
    if (amt > 0) payouts.set(m, amt);
  }

  return {
    memberSettles: new Map(memberSettles),
    voucherCosts: new Map(voucherCosts),
    payouts,
    partial,
  };
}

const VOUCHER_KINDS: VoucherKind[] = ["llm", "time", "compute"];

/**
 * 本次任务凭证成本（spec §6.2/I2）：burnHistory(member, kind, {traceId}) 按 traceId
 * 精确取本次执行燃烧（多任务燃烧不混淆），FIFO 折算 creditCost 求和。
 * 供 runner（Task 11）在调用 executeOrgPayout 前折算 voucherCosts。
 */
export function voucherCostForTask(voucher: VoucherPort, agentId: string, traceId: string): number {
  let total = 0;
  for (const kind of VOUCHER_KINDS) {
    for (const rec of voucher.burnHistory(agentId, kind, { traceId })) {
      total += rec.creditCost;
    }
  }
  return total;
}

/** 垫付执行依赖。 */
export interface OrgPayoutDeps {
  /** 幂等表 org_payouts 所在 db——必须与 ledger 共享同一 DatabaseSync（C1 约定，同 SqliteVoucher）。 */
  db: DatabaseSync;
  ledger: SqliteLedger;
  events: EconomyEventBus;
  /** 组织 elo 持久化（违约 majorError 双写；可为空——纯资金测试用）。 */
  repository?: CoreRepository;
  /** 违约 elo 公式（默认 simpleElo——Task 3 ruling：majorError → elo outcome=0）。 */
  eloFn?: EloFormula;
}

/** 垫付执行结果。 */
export interface OrgPayoutResult {
  ok: boolean;
  skipped: boolean; // 幂等：taskId 已处理
  defaulted: boolean; // 垫付失败 → 违约链已触发
  plan: PayoutPlan;
  totalPayouts: number; // Σ payouts 实际划付
  refundedStakes: Map<string, number>; // 违约时退还的成员 stake（member → 金额）
  orgBalanceAfter: number;
  eloDelta?: number; // 违约 elo 增量（majorError outcome=0）
}

/**
 * executeOrgPayout：垫付执行 effect（spec §6.3，幂等 taskId——org_payouts 表主键）。
 * 流程（单事务，I8 effect 幂等+原子）：
 *   1. 幂等键 org_payouts(task_id) 插入——已存在 → skip；
 *   2. planPayouts(orgBalance, memberSettles, voucherCosts)；
 *   3. payouts 划付（debit org / credit member + currency.transfer 审计事件）——
 *      余额不足时按先本后息部分划付（已发生垫付不逆转，spec §11）；
 *   4. partial → 违约链：成员 stake 退还（成员账户冻结全额解冻——内部任务 bid 冻结同构，
 *      资金守恒不凭空造币）+ 组织 elo majorError（outcome=0）+ economy.org_default 事件
 *      （审计；成员私域经验沉淀由 Task 9 消费本事件触发）。
 */
export function executeOrgPayout(
  deps: OrgPayoutDeps,
  args: {
    taskId: string; // 幂等键（内部任务 id）
    orgId: string;
    memberSettles: Map<string, number>;
    voucherCosts: Map<string, number>;
    /** 违约链退还的成员 stake 簿记（内部任务 bid 冻结在成员账户——M-1 成员面）。 */
    memberStakes?: Map<string, number>;
  },
): OrgPayoutResult {
  const { taskId, orgId, memberSettles, voucherCosts } = args;
  const memberStakes = args.memberStakes ?? new Map<string, number>();
  if (!taskId) throw new Error("org.payout: taskId required");
  if (!orgId) throw new Error("org.payout: orgId required");
  const eloFn = deps.eloFn ?? simpleElo;
  ensureOrgTables(deps.db);

  let plan: PayoutPlan = { memberSettles: new Map(), voucherCosts: new Map(), payouts: new Map(), partial: false };
  const refundedStakes = new Map<string, number>();
  let totalPayouts = 0;
  let defaulted = false;
  let skipped = false;
  let eloDelta: number | undefined;

  deps.ledger.transaction(() => {
    // 幂等：org_payouts 表 task_id 主键——同 taskId 重复执行 skip（I8）
    const ins = deps.db
      .prepare(`INSERT OR IGNORE INTO org_payouts (task_id, org_id, created_at) VALUES (?, ?, ?)`)
      .run(taskId, orgId, Date.now());
    if ((ins.changes ?? 0) === 0) {
      skipped = true;
      return;
    }

    const orgBalanceBefore = deps.ledger.balance(orgId);
    plan = planPayouts({ orgBalance: orgBalanceBefore, memberSettles, voucherCosts });

    // 1) payouts 划付（全垫付或先本后息部分垫付）
    for (const [member, amount] of plan.payouts) {
      if (amount <= 0) continue;
      deps.ledger.debit(orgId, amount, `org-payout ${taskId}`);
      deps.ledger.credit(member, amount, `org-payout ${taskId}`);
      deps.events.emit({ kind: "currency.transfer", data: { taskId, from: orgId, to: member, amount } });
      totalPayouts += amount;
    }

    if (plan.partial) {
      // 2) 违约链（spec §6.3）：余额不足全垫付 → org_default + elo majorError + stake 退还
      defaulted = true;
      // 2a) 成员 stake 退还：内部任务 bid 冻结全额解冻（无冻结行 → unfreeze 幂等 no-op）
      for (const member of memberStakes.keys()) {
        const released = deps.ledger.unfreeze(member, taskId);
        if (released > 0) refundedStakes.set(member, released);
      }
      // 2b) 组织 elo 按 majorError（outcome=0——Task 3 ruling：K×(0−expected) 与 −stake 一致惩罚）
      eloDelta = applyOrgDefaultElo(deps, orgId, eloFn);
      // 2c) 违约事件（审计——成员私域经验由 Task 9 消费）
      deps.events.emit({
        kind: "economy.org_default",
        data: {
          taskId,
          orgId,
          totalPayouts,
          shortfall: payoutShortfall(plan, orgBalanceBefore),
          refundedStakes: Object.fromEntries(refundedStakes),
          eloDelta: eloDelta ?? null,
        },
      });
    }
  });

  return {
    ok: true,
    skipped,
    defaulted,
    plan,
    totalPayouts,
    refundedStakes,
    orgBalanceAfter: deps.ledger.balance(orgId),
    eloDelta,
  };
}

/** 垫付缺口 = Σ成本 + Σ正收益 − orgBalance（partial 时 ≥ 0——违约事件观测字段）。 */
function payoutShortfall(plan: PayoutPlan, orgBalance: number): number {
  let needed = 0;
  for (const c of plan.voucherCosts.values()) needed += Math.max(0, c);
  for (const s of plan.memberSettles.values()) needed += Math.max(0, s);
  return needed - orgBalance;
}

/** 违约 elo：组织当前分按 majorError（outcome=0）更新并持久化；无 repository/agent 时 no-op。 */
function applyOrgDefaultElo(deps: OrgPayoutDeps, orgId: string, eloFn: EloFormula): number | undefined {
  if (!deps.repository) return undefined;
  const org = deps.repository.getAgent(orgId);
  if (!org) return undefined;
  const curGlobal = org.eloGlobal ?? ELO_DEFAULTS.INITIAL;
  // majorError → elo outcome=0（Task 3 ruling——与 −stake 结算一致惩罚；taskRating 默认 1500）
  const nextGlobal = eloFn.update(curGlobal, { taskRating: ELO_DEFAULTS.INITIAL, outcome: 0 });
  deps.repository.updateElo(orgId, { global: nextGlobal, byDomain: { ...(org.eloByDomain ?? {}) } });
  return nextGlobal - curGlobal;
}

/** 组织利润 = settle_org − Σpayouts − 税（允许为负——观测项，spec §6.4）。 */
export function orgProfitAfterPayouts(args: { settleOrg: number; totalPayouts: number; tax: number }): number {
  return args.settleOrg - args.totalPayouts - args.tax;
}
