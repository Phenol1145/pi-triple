// 审核链（spec §6 / plan Task 9）：组合矩阵 / quorum / 超时 / 聚合 / operator 否决 / 审计事件表。
//
// 语义（spec 逐字 + 第四/五轮裁决，钉死）：
// - 合成规则（串联）：agent 侧先审 → operator 侧策略生效 → 任一否决 = 拒绝；
//   operator 是最终否决权（可推翻 agent 通过）
// - 组合矩阵：
//   all-vote      基数 = 活跃数快照（提交时在线快照；未 submit 直接 approve → 裁决时快照）；
//                 弃权计入分母；默认需过半赞成（quorumRatio 0.5 → floor(base*0.5)+1 = 严格过半）；
//                 平局（赞成 === 反对 > 0 且均未达 quorum）→ operator
//   veto          基数 = 全部相关 agent（含离线）；离线 = 弃权（不否决）；无 veto = 通过
//                 （不需赞成票过半）
//   representative 被选代表数默认 2（delegateTo?.() ?? active() 取前 repCount）；
//                 代表弃权 → 换选补充（依 active() 序，补充者再弃权 → 继续换选）；
//                 分歧（赞成 === 反对 > 0 且均未达 quorum）→ operator
// - operator 侧：delegate（平局无决议 → 不通过）/ auto-approve（平局 → 通过）/
//   manual（operator 经 veto() 表达否决；未否决 = 通过）；veto()=true 一票否决（全部策略）
// - 超时默认 5 分钟（timeoutMs）/ 聚合窗口默认 1 分钟（windowMs）或 10 条（windowMax）：
//   v1 预留（Task 10 comms 异步生命周期：veto 制窗口关闭 = 在线全部已投或超时；
//   all-vote/representative = 时间或数量硬截止）；v1 的 closeWindow 为显式硬截止，
//   窗口关闭后 vote 不再计入
// - 审核结果仅落审计事件表：recordEvent → dir/audit-events.jsonl（append-only，不落 L3）
// - 不可回写标记：markNotWriteBack → dir/not-write-back.jsonl（幂等追加；
//   写校验链拒绝入口，Task 8 消费：promote/merge 走校验链拒绝、fork 拷贝保留、resume 不触发写）
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AgentSideStrategy = "all-vote" | "veto" | "representative";
export type OperatorSideStrategy = "delegate" | "auto-approve" | "manual";

export interface AuditConfig {
  agentSide: AgentSideStrategy;
  operatorSide: OperatorSideStrategy;
  quorumRatio?: number;        // 默认 0.5（过半活跃）
  timeoutMs?: number;          // 默认 300_000（5 分钟；v1 预留）
  repCount?: number;           // 默认 2（评审代表）
  windowMs?: number;           // 默认 60_000（聚合窗口；v1 预留）
  windowMax?: number;          // 默认 10（聚合条数；v1 预留）
}

export interface AuditRequest {
  id: string;
  delta: { entryId: string; kind: string };
  domain: "team" | "global";
}

export interface AuditVote {
  requestId: string;
  voter: string;
  decision: "approve" | "reject" | "veto";
  at: number;
}

/** agent 注册表（brief 逐字：active()/isActive()/delegateTo?()）。 */
export interface AuditAgentRegistry {
  active(): string[];
  isActive(id: string): boolean;
  delegateTo?(): string[];
}

/** operator 通道（brief 逐字：notify()/veto?()）。 */
export interface AuditOperator {
  notify(req: AuditRequest): void;
  veto?(): boolean;
}

interface RequestState {
  req: AuditRequest;
  /** all-vote 基数：提交时在线快照。 */
  snapshot: string[];
  submittedAt: number;
  /** 窗口显式关闭时间（硬截止）。 */
  closedAt?: number;
}

type AgentVerdict = "pass" | "fail" | "tie";

export class AuditChain {
  /** 投票记录（v1 内存 Map；持久化留后续）。 */
  private votes = new Map<string, AuditVote[]>();
  private requests = new Map<string, RequestState>();
  /** 窗口显式关闭时间（requestId → closedAt，硬截止；独立于 submit 记录）。 */
  private closedAt = new Map<string, number>();
  private config: AuditConfig;
  private agentRegistry: AuditAgentRegistry;
  private operator: AuditOperator;
  /** 记忆库目录（recordEvent/markNotWriteBack 落盘处；默认 cwd/dir）。 */
  private dir: string;

  constructor(config: AuditConfig, agentRegistry: AuditAgentRegistry, operator: AuditOperator, dir: string = join(process.cwd(), "dir")) {
    this.config = config;
    this.agentRegistry = agentRegistry;
    this.operator = operator;
    this.dir = dir;
  }

  private auditEventsPath(): string {
    return join(this.dir, "audit-events.jsonl");
  }

  private notWriteBackPath(): string {
    return join(this.dir, "not-write-back.jsonl");
  }

  private appendJsonl(filePath: string, rec: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(filePath, JSON.stringify(rec) + "\n");
  }

  /**
   * 提交审核请求：记录 all-vote 基数快照（提交时在线快照）+ 通知 operator。
   * v1 同步简化（brief：submit/closeWindow 为异步生命周期，v1 可实现为同步）。
   */
  submit(req: AuditRequest): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
    if (this.requests.has(req.id)) {
      return Promise.resolve({ ok: false, reason: "duplicate-request" });
    }
    this.requests.set(req.id, { req, snapshot: this.agentRegistry.active(), submittedAt: Date.now() });
    this.operator.notify(req);
    return Promise.resolve({ ok: true, requestId: req.id });
  }

  /** 记录一票。窗口关闭后（显式硬截止）不再计入。 */
  vote(v: AuditVote): void {
    if (this.closedAt.has(v.requestId) || this.requests.get(v.requestId)?.closedAt !== undefined) return;
    const list = this.votes.get(v.requestId) ?? [];
    list.push(v);
    this.votes.set(v.requestId, list);
  }

  /** 显式关闭聚合窗口（硬截止；自动关闭条件——时间/数量、veto 制全部在线已投——留 Task 10 异步生命周期）。 */
  closeWindow(requestId: string): void {
    if (this.closedAt.has(requestId)) return;
    const rec = this.requests.get(requestId);
    if (rec) rec.closedAt = Date.now();
    this.closedAt.set(requestId, Date.now());
  }

  /**
   * 组合矩阵裁决（同步入口）：agent 侧先审 → operator 侧策略生效 → 任一否决 = 拒绝。
   */
  approve(req: AuditRequest): boolean {
    // operator 是最终否决权（任一否决 = 拒绝，可推翻 agent 通过）
    if (this.operator.veto?.() === true) return false;
    const votes = this.votes.get(req.id) ?? [];
    const verdict = this.agentVerdict(req, votes);
    if (verdict === "fail") return false;
    if (verdict === "pass") return true;
    // 平局/分歧 → operator 裁决（operator 侧策略生效）
    return this.operatorSide(verdict);
  }

  private operatorSide(_verdict: "tie"): boolean {
    switch (this.config.operatorSide) {
      case "delegate":     return false; // operator 委托回 agent 侧，无决议 → 不通过
      case "auto-approve": return true;  // operator 自动批准
      case "manual":       return true;  // v1：operator 仅经 veto() 表达否决；未否决 = 通过
    }
  }

  private agentVerdict(req: AuditRequest, votes: AuditVote[]): AgentVerdict {
    switch (this.config.agentSide) {
      case "veto": {
        // 基数 = 全部相关 agent（含离线）；离线 = 弃权（不否决）；无 veto = 通过
        const vetoes = votes.filter((v) => v.decision === "veto" && this.agentRegistry.isActive(v.voter));
        return vetoes.length > 0 ? "fail" : "pass";
      }
      case "all-vote": {
        // 基数 = 活跃数快照（提交时在线快照；未 submit 直接 approve → 裁决时活跃数）
        const base = this.requests.get(req.id)?.snapshot.length ?? this.agentRegistry.active().length;
        const ratio = this.config.quorumRatio ?? 0.5;
        const required = Math.floor(base * ratio) + 1; // 默认 0.5 → 严格过半
        const approves = votes.filter((v) => v.decision === "approve").length;
        const rejects = votes.filter((v) => v.decision === "reject").length;
        if (approves >= required) return "pass";
        if (rejects >= required) return "fail";
        // 平局（赞成 === 反对 > 0，均未达 quorum）→ operator；票数不足（弃权计入分母）→ 不通过
        return approves > 0 && approves === rejects ? "tie" : "fail";
      }
      case "representative": {
        const repCount = this.config.repCount ?? 2;
        const preferred = this.agentRegistry.delegateTo?.() ?? this.agentRegistry.active();
        const reps = preferred.slice(0, repCount);
        const required = Math.floor(reps.length / 2) + 1;
        // 代表弃权 → 换选补充（依 active() 序，排除已选；补充者再弃权 → 继续换选）
        const used = new Set<string>(reps);
        const chosen: Array<string | undefined> = [];
        for (const rep of reps) {
          let id: string | undefined = rep;
          if (!votes.some((v) => v.voter === id)) {
            id = this.agentRegistry.active().find((a) => !used.has(a));
            while (id !== undefined && !votes.some((v) => v.voter === id)) {
              used.add(id);
              id = this.agentRegistry.active().find((a) => !used.has(a));
            }
          }
          if (id !== undefined) used.add(id);
          chosen.push(id); // undefined = 活跃耗尽无可补充 → 该席位按弃权计
        }
        const approveCount = chosen.filter(
          (id) => id !== undefined && votes.some((v) => v.voter === id && v.decision === "approve"),
        ).length;
        const rejectCount = chosen.filter(
          (id) => id !== undefined && votes.some((v) => v.voter === id && v.decision === "reject"),
        ).length;
        if (approveCount >= required) return "pass";
        if (rejectCount >= required) return "fail";
        // 分歧（赞成 === 反对 > 0，均未达 quorum）→ operator；票数不足 → 不通过
        return approveCount > 0 && approveCount === rejectCount ? "tie" : "fail";
      }
    }
  }

  /** 审核结果仅落审计事件表（dir/audit-events.jsonl，append-only；不落 L3）。 */
  recordEvent(ev: unknown): void {
    this.appendJsonl(this.auditEventsPath(), ev);
  }

  /**
   * 不可回写标记（dir/not-write-back.jsonl，幂等追加）。
   * 写校验链拒绝入口（Task 8 消费）：promote/merge 走校验链拒绝、fork 拷贝保留、resume 不触发写。
   */
  markNotWriteBack(entryId: string): void {
    const p = this.notWriteBackPath();
    if (existsSync(p)) {
      const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
      const marked = lines.some((l) => {
        try {
          return (JSON.parse(l) as { entryId?: string }).entryId === entryId;
        } catch {
          return false;
        }
      });
      if (marked) return; // 已标记 → 幂等
    }
    this.appendJsonl(p, { entryId, at: Date.now() });
  }
}
