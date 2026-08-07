import type { DatabaseSync } from "node:sqlite";
import type { SqliteTaskStore, TaskRecord } from "./tasks.ts";

export interface SelectorRule { labelPatterns: string[]; textPattern?: string }

/** 匹配规则（spec §6.1）：labelPatterns OR 语义 + textPattern 可选；空 labelPatterns = 不设限。 */
export function matchesSelector(task: Pick<TaskRecord, "labels" | "text">, sel: SelectorRule): boolean {
  const labelsOk = sel.labelPatterns.length === 0 || sel.labelPatterns.some((re) => {
    let ok = false;
    try { ok = task.labels.some((l) => new RegExp(re).test(l)); } catch { ok = false; }
    return ok;
  });
  if (!labelsOk) return false;
  if (!sel.textPattern) return true;
  try { return new RegExp(sel.textPattern).test(task.text); } catch { return false; }
}

export interface ReflowThresholds { reflowAgeMs?: number; escalateAgeMs?: number }

export class SorterEngine {
  private readonly db: DatabaseSync;
  private readonly store: SqliteTaskStore;

  // node strip-types 不支持 parameter property → 显式字段赋值
  constructor(db: DatabaseSync, store: SqliteTaskStore) {
    this.db = db;
    this.store = store;
  }

  setSelector(agentId: string, sel: SelectorRule | null): void {
    if (sel === null) {
      this.db.prepare(`UPDATE lab_agent_instances SET selector_json = NULL WHERE id = ?`).run(agentId);
      return;
    }
    this.db.prepare(`UPDATE lab_agent_instances SET selector_json = ? WHERE id = ?`).run(JSON.stringify(sel), agentId);
  }

  getSelector(agentId: string): SelectorRule | undefined {
    const row = this.db.prepare(`SELECT selector_json FROM lab_agent_instances WHERE id = ?`).get(agentId) as { selector_json: string | null } | undefined;
    if (!row?.selector_json) return undefined;
    return JSON.parse(row.selector_json) as SelectorRule;
  }

  candidates(agentId: string): TaskRecord[] {
    const sel = this.getSelector(agentId);
    if (!sel) return [];
    return this.store.list({ status: "pending" })
      .filter((t) => !t.rejects.some((r) => r.agentId === agentId)) // 排除已拒（M5 按 agentId）
      .filter((t) => matchesSelector(t, sel));
  }

  claimTopN(agentId: string, n: number): TaskRecord[] {
    const claimed: TaskRecord[] = [];
    for (const t of this.candidates(agentId)) {
      if (claimed.length >= n) break;
      if (this.store.claim(agentId, t.id) === "claimed") claimed.push(this.store.get(t.id)!);
    }
    return claimed;
  }

  agentsWithSelector(): Array<{ agentId: string; selector: SelectorRule }> {
    const rows = this.db.prepare(`SELECT id, selector_json FROM lab_agent_instances WHERE selector_json IS NOT NULL`).all() as Array<{ id: string; selector_json: string }>;
    return rows.map((r) => ({ agentId: r.id, selector: JSON.parse(r.selector_json) as SelectorRule }));
  }

  /** 回流轮（spec §5.3 双触发；N3 统一判据）。reflowAgeMs 触发 rejected 回流；escalateAgeMs 触发 pending 无候选升级。 */
  reflowRound(now: number = Date.now(), thresholds: ReflowThresholds = {}): { reflowed: number; escalated: number } {
    const reflowAgeMs = thresholds.reflowAgeMs ?? 10 * 60_000;
    const escalateAgeMs = thresholds.escalateAgeMs ?? 30 * 60_000;
    const out = { reflowed: 0, escalated: 0 };

    // rejected：时间维触发（age = 自最后拒绝时刻）
    for (const t of this.store.list({ status: "rejected" })) {
      const lastRejectAt = t.rejects.length > 0 ? t.rejects[t.rejects.length - 1]!.at : t.createdAt;
      if (now - lastRejectAt < reflowAgeMs) continue;
      if (this.matchingNonExcludedCount(t) === 0) {
        if (this.store.escalate(t.id, "no-matching-agent") === "escalated") out.escalated++;
      } else {
        if (this.store.reflow(t.id) === "reflowed") out.reflowed++;
      }
    }

    // pending 从未认领（claims_count=0）：age > escalateAgeMs 且无匹配 → 升级
    for (const t of this.store.list({ status: "pending" })) {
      if (t.claimsCount !== 0) continue; // stale 产物走 claims_count 阈值路径
      if (now - t.createdAt < escalateAgeMs) continue;
      if (this.matchingNonExcludedCount(t) === 0) {
        if (this.store.escalate(t.id, "no-matching-agent") === "escalated") out.escalated++;
      }
    }
    return out;
  }

  /** claimed 超时 → pending（保留 claims_count——N3）。 */
  reclaimStale(staleMs: number, now: number = Date.now()): number {
    const rows = this.db.prepare(`SELECT id FROM tasks WHERE status='claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`).all(now - staleMs) as Array<{ id: string }>;
    let n = 0;
    for (const r of rows) {
      this.db.prepare(`UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL WHERE id=? AND status='claimed'`).run(r.id);
      n++;
    }
    return n;
  }

  /** 剩余"标签匹配且未排除"的 agent 数（升级判定核心）。 */
  private matchingNonExcludedCount(t: TaskRecord): number {
    return this.agentsWithSelector()
      .filter(({ agentId }) => !t.rejects.some((r) => r.agentId === agentId))
      .filter(({ selector }) => matchesSelector(t, selector))
      .length;
  }

  /** 自动拒绝（供 SorterCycle 派发失败时调用，裁决 I2）：内部走 store.reject 守卫，原因进排除名单。 */
  autoReject(agentId: string, taskId: string, reason: string): string {
    return this.store.reject(agentId, taskId, reason);
  }

  /** 取任务（cycle 判定用，裁决 B1）：委托 store.get。 */
  getTask(taskId: string): TaskRecord | undefined {
    return this.store.get(taskId);
  }

  /** 升级（cycle claims_count 阈值用，裁决 B1）：委托 store.escalate。 */
  escalate(taskId: string, reason: string): string {
    return this.store.escalate(taskId, reason);
  }
}
