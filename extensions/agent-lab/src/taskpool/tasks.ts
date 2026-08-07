import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LabEvent } from "../core/contracts.ts";

export type TaskStatus = "pending" | "claimed" | "submitted" | "completed" | "rejected" | "escalated";
export interface RejectRecord { agentId: string; reason: string; at: number }

export interface TaskRecord {
  id: string;
  templateId: string;
  labels: string[];
  text: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  claimedBy?: string;
  claimedAt?: number;
  claimsCount: number;
  rejects: RejectRecord[];
  createdBy: string;
  createdAt: number;
  completedAt?: number;
}

export interface TaskStoreDeps {
  db: DatabaseSync;
  appendEvent: (e: LabEvent) => "inserted" | "duplicate";
  traceId?: string;
}

type OpResult = string;

export class SqliteTaskStore {
  private readonly db: DatabaseSync;
  private readonly appendEvent: (e: LabEvent) => "inserted" | "duplicate";
  private readonly traceId: string;

  constructor(deps: TaskStoreDeps) {
    this.db = deps.db;
    this.appendEvent = deps.appendEvent;
    this.traceId = deps.traceId ?? "taskpool";
  }

  publish(input: { templateId: string; text: string; labels: string[]; params?: Record<string, unknown>; createdBy: string }): TaskRecord {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO tasks (id, template_id, labels, text, params, status, claims_count, rejects, created_by, created_at)
       VALUES (?,?,?,?,?,?,0,'[]',?,?)`,
    ).run(id, input.templateId, JSON.stringify(input.labels), input.text, JSON.stringify(input.params ?? {}), "pending", input.createdBy, now);
    this.emit("task.published", { taskId: id, templateId: input.templateId, labels: input.labels, createdBy: input.createdBy });
    return this.get(id)!;
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(filter: { status?: TaskStatus; claimedBy?: string } = {}): TaskRecord[] {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (filter.status) { conds.push("status = ?"); args.push(filter.status); }
    if (filter.claimedBy) { conds.push("claimed_by = ?"); args.push(filter.claimedBy); }
    const sql = conds.length > 0 ? `SELECT * FROM tasks WHERE ${conds.join(" AND ")} ORDER BY created_at` : `SELECT * FROM tasks ORDER BY created_at`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  claim(agentId: string, taskId: string): OpResult {
    const now = Date.now();
    // 适配说明（brief 内部不一致，详见报告）：brief 自带测试#5/#7 要求 claim 可从 rejected 源态认领
    // （agent 拒绝后由他人认领，claims_count 累积至≥3 触发 N1 阈值升级）——实现块只写 pending 导致测试红。
    // 保留 excludes（rejects[]）不清，与 requeue 清/reflow 留的区分一致。
    const r = this.db.prepare(
      `UPDATE tasks SET status='claimed', claimed_by=?, claimed_at=?, claims_count=claims_count+1
       WHERE id=? AND status IN ('pending','rejected')`,
    ).run(agentId, now, taskId);
    if (r.changes === 1) {
      this.emit("task.claimed", { taskId, agentId });
      return "claimed";
    }
    return this.get(taskId) ? "not-pending" : "not-found";
  }

  reject(agentId: string, taskId: string, reason: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "claimed" || t.claimedBy !== agentId) return "not-claimed-by-you";
    const rejects = [...t.rejects, { agentId, reason, at: Date.now() }];
    // 守卫入 SQL（裁决 I7 TOCTOU）：条件 UPDATE + changes()===1，防 precheck 与 UPDATE 之间被 reclaimStale 翻回 pending
    const r = this.db.prepare(`UPDATE tasks SET status='rejected', rejects=? WHERE id=? AND status='claimed' AND claimed_by=?`).run(JSON.stringify(rejects), taskId, agentId);
    if (r.changes !== 1) return "not-claimed-by-you";
    this.emit("task.rejected", { taskId, agentId, reason });
    return "rejected";
  }

  submit(agentId: string, taskId: string, outputRef: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "claimed" || t.claimedBy !== agentId) return "not-claimed-by-you";
    const now = Date.now();
    // 守卫入 SQL（裁决 I7 TOCTOU）
    const r = this.db.prepare(`UPDATE tasks SET status='completed', completed_at=? WHERE id=? AND status='claimed' AND claimed_by=?`).run(now, taskId, agentId);
    if (r.changes !== 1) return "not-claimed-by-you";
    this.emit("task.submitted", { taskId, agentId, outputRef });
    this.emit("task.completed", { taskId, agentId });
    return "submitted";
  }

  /** 人工 requeue：escalated/rejected → pending，清 rejects[] + claims_count=0（裁决 N2）。 */
  requeue(taskId: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "escalated" && t.status !== "rejected") return "not-requeueable";
    this.db.prepare(`UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL, claims_count=0, rejects='[]' WHERE id=? AND status IN ('escalated','rejected')`).run(taskId);
    this.emit("task.requeued", { taskId });
    return "requeued";
  }

  /** 自动 reflow：rejected → pending，保留 rejects[]（排除名单持续生效）。 */
  reflow(taskId: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "rejected") return "not-rejected";
    this.db.prepare(`UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL WHERE id=? AND status='rejected'`).run(taskId);
    this.emit("task.reflowed", { taskId });
    return "reflowed";
  }

  /** 升级：rejected/pending（从未认领）→ escalated。 */
  escalate(taskId: string, reason: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    // 源态：rejected / pending（无候选升级）/ claimed（claims_count≥3 阈值升级——裁决 N1，调用方保证派发已返回、非在途）
    if (t.status !== "rejected" && t.status !== "pending" && t.status !== "claimed") return "not-escalatable";
    this.db.prepare(`UPDATE tasks SET status='escalated', claimed_by=NULL, claimed_at=NULL WHERE id=? AND status IN ('rejected','pending','claimed')`).run(taskId);
    this.emit("task.escalated", { taskId, reason });
    return "escalated";
  }

  private emit(eventType: string, payload: unknown): void {
    this.appendEvent({
      eventId: randomUUID(),
      eventType,
      schemaVersion: "1",
      timestamp: Date.now(),
      identity: { traceId: this.traceId },
      payload,
    });
  }
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  const t: TaskRecord = {
    id: row.id as string,
    templateId: row.template_id as string,
    labels: JSON.parse(row.labels as string) as string[],
    text: row.text as string,
    params: JSON.parse(row.params as string) as Record<string, unknown>,
    status: row.status as TaskStatus,
    claimsCount: row.claims_count as number,
    rejects: JSON.parse(row.rejects as string) as RejectRecord[],
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
  };
  if (row.claimed_by) t.claimedBy = row.claimed_by as string;
  if (row.claimed_at) t.claimedAt = row.claimed_at as number;
  if (row.completed_at) t.completedAt = row.completed_at as number;
  return t;
}
