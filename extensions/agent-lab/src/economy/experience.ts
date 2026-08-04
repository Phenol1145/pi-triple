// 结算事件驱动记忆沉淀（plan Task 9 / spec §9）——对接记忆域沉淀管道。
//
// 两个纯函数入口 + 一个沉淀入口：
//   1. experiencesFromSettlement(plan, task, bids)：settle plan → 四类经验
//      （execution / bidding / review —— 全部来自结算纯计算输出，含未中标竞价经验）；
//   2. orgDefaultExperiences({orgId, members, scene})：org_default 事件 → 成员视角
//      经验（orgId 关联）——违约事件由 executeOrgPayout 发出（org.ts），本函数是
//      事件消费侧的纯变换（成员列表 = OrgMembership.membersOf(orgId)，由调用方提供）；
//   3. sedimentExperiences(sink, {taskId, experiences})：经验 → 记忆域沉淀管道
//      （MemoryPipeline.write 同形注入；v1 接线 = MemoryHost.pipeline.write 逐条）。
//
// 沉淀语义（v1）：
//   - 每条经验写为 kind:"experience" 的记忆条目：content = 行式管道格式
//     （`${kind}|${scene}|${agentId}|${action}|${outcome}|${reward}|${evaluationMode ?? "-"}`——
//     对齐 validateAgainstGrammar 行式语义，非 JSON），anchors = [taskId, scene, agentId]
//     （多锚点检索）；
//   - ruleRef = "rule:experience"（对齐公域种子 public-bootstrap——落正式区的前提是
//     公域 grammar 接受行式 content；现状缺口：种子 "experience = word ;" 的 word 原子
//     恰消费一字段，多字段行报 "第 N 项多余"——grammar 扩展属公域侧任务，见报告疑虑）
//   - idempotencyKey = `${kind}:${taskId}:${agentId}`（防重——重放不重复；同一
//     (kind, taskId, agentId) 至多一条）；
//   - 规则化闭环（L3 语义记忆规则化 → 发轫 → 审核链 → write-back）由记忆系统既有
//     管道消费——v1 只负责把经验送入管道（ruleRef 已对齐公域 rule:experience 种子）。
//
// 数值语义（与 market-effects 划付一致）：
//   - execution.reward = settle 税后 = settle − max(0, settle)×taxRate（负收益不课）；
//     outcome = c（校准 = groundTruthScore ?? 共识 R）；majorError → outcome=0
//     （与 elo outcome=0 裁决一致——崩溃/交付无效的质量信号为 0）。
//   - review.outcome = c（评审者观测到的任务质量锚点）；accuracy = a_i（校准按 ground
//     truth 锚定）；reward = settle_i 税后；evaluationMode = "ground-truth"（校准）/
//     "consensus"（常规）——M-R5-6 mode 标记。
//   - bidding.action = `bid:${stake}`；review.action = `review:${stakeR}`（对标
//     bid 冻结金额语义——评审承诺额 = stakeR）。
import type { MemoryEntry } from "../memory/entry.ts";
import type { MemoryPipeline } from "../memory/pipeline.ts";
import type { MarketTask } from "./market-store.ts";
import type { SettlementPlan } from "./settlement.ts";

/** 结算经验（plan Task 9 Interfaces 块逐字）。 */
export type SettlementExperience =
  | { kind: "execution"; agentId: string; scene: string; action: "execute"; outcome: number; reward: number }        // c=R, 税后 settle
  | { kind: "bidding"; agentId: string; scene: string; action: `bid:${number}`; outcome: "won" | "lost"; meta: { winnerId: string; winnerStake: number } }
  | { kind: "review"; agentId: string; scene: string; action: `review:${number}`; outcome: number; accuracy: number; reward: number; evaluationMode: "consensus" | "ground-truth" }  // 校准写 ground truth + mode 标记（M-R5-6）
  | { kind: "org_default"; agentId: string; scene: string; orgId: string };                                        // 成员视角组织违约

/** 沉淀管道写入接口（MemoryPipeline.write 同形——mock 或真实管道注入）。 */
export type ExperienceWrite = (entry: { idempotencyKey: string } & Partial<MemoryEntry>) => ReturnType<MemoryPipeline["write"]>;

/**
 * 纯函数：settle plan → 四类经验中的结算侧三类（execution / bidding / review）。
 * - execution：执行者视角（agentId = winner；outcome = c；reward = 税后 settle）；
 * - bidding：全体 bidder（won×1 + lost×N——含未中标竞价经验）；winner 不在 bids
 *   数组时补 won 经验（调用方漏传兜底——保证中标经验必存在）；
 * - review：全体评审者（accuracy / 税后 reward / evaluationMode 校准标记）。
 * org_default 经验不经本函数（事件驱动——见 orgDefaultExperiences）。
 */
export function experiencesFromSettlement(plan: SettlementPlan, task: MarketTask, bids: { bidderId: string; stake: number }[]): SettlementExperience[] {
  const out: SettlementExperience[] = [];
  const scene = task.typeId;
  const isCalibration = plan.groundTruthScore !== undefined;
  const c = plan.groundTruthScore ?? plan.R; // 质量锚点：校准 ground truth ?? 共识 R
  const rate = plan.taxRate;

  // 1) 执行经验（执行者视角；majorError → outcome=0，与 elo outcome=0 裁决一致）
  if (task.winnerId !== undefined) {
    const settle = plan.executorSettle;
    out.push({
      kind: "execution",
      agentId: task.winnerId,
      scene,
      action: "execute",
      outcome: plan.majorError ? 0 : c,
      reward: settle > 0 ? settle * (1 - rate) : settle, // 税后（负收益不课税）
    });
  }

  // 2) 竞价经验（全体 bidder）
  const seen = new Set<string>();
  for (const bid of bids) {
    seen.add(bid.bidderId);
    out.push({
      kind: "bidding",
      agentId: bid.bidderId,
      scene,
      action: `bid:${bid.stake}`,
      outcome: bid.bidderId === task.winnerId ? "won" : "lost",
      meta: { winnerId: task.winnerId ?? "", winnerStake: task.winnerStake ?? 0 },
    });
  }
  if (task.winnerId !== undefined && !seen.has(task.winnerId)) {
    // winner 漏传兜底：补 won 经验（action 用 task.winnerStake）
    out.push({
      kind: "bidding",
      agentId: task.winnerId,
      scene,
      action: `bid:${task.winnerStake ?? 0}`,
      outcome: "won",
      meta: { winnerId: task.winnerId, winnerStake: task.winnerStake ?? 0 },
    });
  }

  // 3) 评审经验（全体评审者——accuracy / 税后 reward / mode 标记）
  for (const [reviewerId, settleI] of plan.reviewerSettles) {
    out.push({
      kind: "review",
      agentId: reviewerId,
      scene,
      action: `review:${task.stakeR}`,
      outcome: c,
      accuracy: plan.accuracies.get(reviewerId) ?? 0,
      reward: settleI > 0 ? settleI * (1 - rate) : settleI,
      evaluationMode: isCalibration ? "ground-truth" : "consensus",
    });
  }

  return out;
}

/**
 * org_default 事件 → 成员视角经验（orgId 关联）。纯变换：每位成员一条
 * { kind: "org_default", agentId, scene, orgId }。调用方（事件消费侧）提供
 * 成员列表（OrgMembership.membersOf(orgId)）与场景（违约任务 typeId）。
 */
export function orgDefaultExperiences(args: { orgId: string; members: string[]; scene: string }): SettlementExperience[] {
  return args.members.map((agentId) => ({ kind: "org_default", agentId, scene: args.scene, orgId: args.orgId }));
}

/**
 * 沉淀入口：经验 → 记忆域沉淀管道（MemoryPipeline.write 同形 sink 注入——
 * v1 接线 = MemoryHost.pipeline）。逐条写入：
 *   kind: "experience"；content = 行式管道格式（对齐公域 rule:experience 行式语义）；
 *   ruleRef = "rule:experience"（对齐公域种子；注意：公域 grammar 现为单字段 word，
 *   多字段行式需公域侧扩展后才会过 pipeline 校验——现状缺口见报告疑虑）；
 *   anchors = [taskId, scene, agentId]；idempotencyKey = `${kind}:${taskId}:${agentId}`（防重）。
 */
export function sedimentExperiences(
  sink: { write: ExperienceWrite },
  args: { taskId: string; experiences: SettlementExperience[] }
): void {
  for (const exp of args.experiences) {
    sink.write({
      idempotencyKey: `${exp.kind}:${args.taskId}:${exp.agentId}`,
      kind: "experience",
      ruleRef: "rule:experience", // ← 对齐公域 rule:experience 种子（public-bootstrap）——落正式区需公域 grammar 接受行式（现状缺口见报告）
      content: experienceToLine(exp), // ← 行式管道格式（validateAgainstGrammar 行式语义——非 JSON）
      anchors: [args.taskId, exp.scene, exp.agentId],
    });
  }
}

/**
 * 经验 → 行式管道格式单行（对齐公域 rule:experience 行式语义；字段以 "|" 分隔）：
 * `${kind}|${scene}|${agentId}|${action}|${outcome}|${reward}|${evaluationMode ?? "-"}`
 * 各字段本身不含 "|"（kind/action 字面量、scene/agentId 系统生成 id——裁决：断言不含）；
 * 字段缺省（bidding 无 reward、org_default 无 action/outcome/reward、evaluationMode）→ "-" 占位。
 */
function experienceToLine(exp: SettlementExperience): string {
  const e = exp as SettlementExperience & { action?: string; outcome?: string | number; reward?: number; evaluationMode?: string };
  const parts = [
    exp.kind,
    exp.scene,
    exp.agentId,
    e.action ?? "-",
    e.outcome === undefined ? "-" : String(e.outcome),
    e.reward === undefined ? "-" : String(e.reward),
    e.evaluationMode ?? "-",
  ];
  return parts.join("|");
}
