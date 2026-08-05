import type { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA } from "../core/storage/schema.ts";
import type { LabEvent } from "../core/contracts.ts";
import type { DispatchRequest, DispatchResult } from "./runner.ts";

// ── Types ─────────────────────────────────────────────────────────────

export type ScheduleKind = "cron" | "at" | "interval";
export type ScheduledJobStatus = "active" | "paused" | "done" | "cancelled";

export interface ScheduledJob {
  id: string;
  tenantId: string;
  taskType: string;
  scheduleKind: ScheduleKind;
  scheduleSpec: string;
  payload: unknown;
  status: ScheduledJobStatus;
  nextFireAt: number;
  lastFireAt: number | null;
  fireCount: number;
  createdBy: string;
  legalRef?: string;
}

export interface NewScheduledJob {
  id: string;
  tenantId: string;
  taskType: string;
  scheduleKind: ScheduleKind;
  scheduleSpec: string;
  payload: unknown;
  status: ScheduledJobStatus;
  nextFireAt: number;
  createdBy: string;
  legalRef?: string;
}

// ── Minimal cron (零新增依赖——手写最小 cron 解析) ────────────────────
//
// 5 段: 分 时 日 月 周 (minute hour day-of-month month day-of-week)。
// 每段支持: `*`、`*/n`、`a-b`、`a-b/n`、`a,b,c`、单值。dow 0-7 (0/7 均为周日)。
// 时区: 本机 local time（与 scheduleSpec 的 "at" ISO 语义一致，documented 决策）。
// 语义: dom/dow 均受限时按标准 OR 语义匹配。

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

function parseCronField(part: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const piece of part.split(",")) {
    if (piece === "") throw new Error(`invalid cron field: ${part}`);
    if (piece === "*") {
      for (let v = min; v <= max; v++) values.add(v);
      continue;
    }
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(piece);
    if (!m) throw new Error(`invalid cron field segment: ${piece}`);
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step in: ${piece}`);
    }
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      const range = m[1].split("-");
      lo = Number(range[0]);
      hi = range.length === 2 ? Number(range[1]) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`cron field out of range [${min}-${max}]: ${piece}`);
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`cron field selects nothing: ${part}`);
  return values;
}

export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron must have 5 fields (min hour dom month dow), got ${fields.length}: ${expr}`);
  }
  const [minField, hourField, domField, monthField, dowField] = fields;
  const minutes = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const daysOfMonth = parseCronField(domField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const dowRaw = parseCronField(dowField, 0, 7);
  if (dowRaw.has(7)) {
    dowRaw.delete(7);
    dowRaw.add(0); // 7 == 0 (Sunday)
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: dowRaw,
    domWildcard: domField === "*",
    dowWildcard: dowField === "*",
  };
}

/**
 * 下一个匹配时刻（严格晚于 fromMs，local time）。5 年内找不到则抛错。
 */
export function nextCronFire(expr: string, fromMs: number): number {
  const cron = parseCron(expr);
  const MAX_SCAN_DAYS = 366 * 5;
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setTime(d.getTime() + 60_000); // start at the next minute boundary

  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (!cron.months.has(d.getMonth() + 1)) {
      d.setTime(new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime());
      continue;
    }
    const domMatch = cron.domWildcard || cron.daysOfMonth.has(d.getDate());
    const dowMatch = cron.dowWildcard || cron.daysOfWeek.has(d.getDay());
    const dayOk =
      cron.domWildcard && cron.dowWildcard
        ? true
        : cron.domWildcard
          ? dowMatch
          : cron.dowWildcard
            ? domMatch
            : domMatch || dowMatch; // 标准 OR 语义
    if (!dayOk) {
      d.setTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime());
      continue;
    }
    for (let h = d.getHours(); h < 24; h++) {
      if (!cron.hours.has(h)) continue;
      const startMin = h === d.getHours() ? d.getMinutes() : 0;
      for (let m = startMin; m < 60; m++) {
        if (cron.minutes.has(m)) {
          return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
        }
      }
    }
    d.setTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime());
  }
  throw new Error(`no cron fire time within 5 years: ${expr}`);
}

/**
 * 计算给定 schedule 的下一次触发时刻。
 * - at:      scheduleSpec 为 ISO 8601 时刻
 * - interval: scheduleSpec 为毫秒数（正整数）
 * - cron:     scheduleSpec 为 5 段 cron 表达式
 */
export function computeNextFireAt(
  scheduleKind: ScheduleKind,
  scheduleSpec: string,
  fromMs: number,
): number {
  switch (scheduleKind) {
    case "at": {
      const t = Date.parse(scheduleSpec);
      if (!Number.isFinite(t)) throw new Error(`invalid "at" schedule spec: ${scheduleSpec}`);
      return t;
    }
    case "interval": {
      const period = Number(scheduleSpec);
      if (!Number.isInteger(period) || period <= 0) {
        throw new Error(`invalid interval schedule spec (expected positive integer ms): ${scheduleSpec}`);
      }
      return fromMs + period;
    }
    case "cron":
      return nextCronFire(scheduleSpec, fromMs);
  }
}

function validateScheduleSpec(scheduleKind: ScheduleKind, scheduleSpec: string): void {
  // 只验证可解析性；实际 next 时刻由 computeNextFireAt 计算。
  switch (scheduleKind) {
    case "at": {
      const t = Date.parse(scheduleSpec);
      if (!Number.isFinite(t)) throw new Error(`invalid "at" schedule spec: ${scheduleSpec}`);
      return;
    }
    case "interval": {
      const period = Number(scheduleSpec);
      if (!Number.isInteger(period) || period <= 0) {
        throw new Error(`invalid interval schedule spec (expected positive integer ms): ${scheduleSpec}`);
      }
      return;
    }
    case "cron":
      parseCron(scheduleSpec); // throws on malformed
      return;
  }
}

// ── ScheduledJobsStore（scheduled_jobs 表 CRUD） ───────────────────────

interface ScheduledJobRow {
  id: string;
  tenant_id: string;
  task_type: string;
  schedule_kind: ScheduleKind;
  schedule_spec: string;
  payload_json: string;
  status: ScheduledJobStatus;
  next_fire_at: number;
  last_fire_at: number | null;
  fire_count: number;
  created_by: string;
  legal_ref: string | null;
}

function rowToJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskType: row.task_type,
    scheduleKind: row.schedule_kind,
    scheduleSpec: row.schedule_spec,
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
    fireCount: row.fire_count,
    createdBy: row.created_by,
    legalRef: row.legal_ref ?? undefined,
  };
}

export class ScheduledJobsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CORE_SCHEMA);
  }

  create(job: NewScheduledJob): ScheduledJob {
    if (!job.id || !job.tenantId || !job.taskType || !job.createdBy) {
      throw new Error("scheduled job requires id, tenantId, taskType, createdBy");
    }
    validateScheduleSpec(job.scheduleKind, job.scheduleSpec);
    if (!Number.isFinite(job.nextFireAt)) {
      throw new Error("scheduled job nextFireAt must be a finite timestamp");
    }
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO scheduled_jobs
       (id, tenant_id, task_type, schedule_kind, schedule_spec, payload_json, status,
        next_fire_at, last_fire_at, fire_count, created_by, legal_ref, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.tenantId,
      job.taskType,
      job.scheduleKind,
      job.scheduleSpec,
      JSON.stringify(job.payload ?? null),
      job.status,
      job.nextFireAt,
      null,
      0,
      job.createdBy,
      job.legalRef ?? null,
      now,
      now,
    );
    return this.get(job.id)!;
  }

  get(id: string): ScheduledJob | undefined {
    const row = this.db.prepare(
      `SELECT id, tenant_id, task_type, schedule_kind, schedule_spec, payload_json, status,
              next_fire_at, last_fire_at, fire_count, created_by, legal_ref
       FROM scheduled_jobs WHERE id = ?`,
    ).get(id) as ScheduledJobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  list(filter?: { tenantId?: string; status?: ScheduledJobStatus }): ScheduledJob[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.tenantId) {
      conditions.push("tenant_id = ?");
      params.push(filter.tenantId);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT id, tenant_id, task_type, schedule_kind, schedule_spec, payload_json, status,
              next_fire_at, last_fire_at, fire_count, created_by, legal_ref
       FROM scheduled_jobs ${where} ORDER BY next_fire_at ASC, id ASC`,
    ).all(...params) as unknown as ScheduledJobRow[];
    return rows.map(rowToJob);
  }

  /** 到期任务（status=active 且 next_fire_at <= now）——定时触发器扫描用。 */
  listDue(now: number): ScheduledJob[] {
    const rows = this.db.prepare(
      `SELECT id, tenant_id, task_type, schedule_kind, schedule_spec, payload_json, status,
              next_fire_at, last_fire_at, fire_count, created_by, legal_ref
       FROM scheduled_jobs WHERE status = 'active' AND next_fire_at <= ?
       ORDER BY next_fire_at ASC, id ASC`,
    ).all(now) as unknown as ScheduledJobRow[];
    return rows.map(rowToJob);
  }

  update(
    id: string,
    patch: Partial<{
      taskType: string;
      scheduleSpec: string;
      payload: unknown;
      status: ScheduledJobStatus;
      nextFireAt: number;
      lastFireAt: number;
      fireCount: number;
      legalRef?: string;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (patch.taskType !== undefined) {
      sets.push("task_type = ?");
      params.push(patch.taskType);
    }
    if (patch.scheduleSpec !== undefined) {
      sets.push("schedule_spec = ?");
      params.push(patch.scheduleSpec);
    }
    if (patch.payload !== undefined) {
      sets.push("payload_json = ?");
      params.push(JSON.stringify(patch.payload));
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.nextFireAt !== undefined) {
      sets.push("next_fire_at = ?");
      params.push(patch.nextFireAt);
    }
    if (patch.lastFireAt !== undefined) {
      sets.push("last_fire_at = ?");
      params.push(patch.lastFireAt);
    }
    if (patch.fireCount !== undefined) {
      sets.push("fire_count = ?");
      params.push(patch.fireCount);
    }
    if (patch.legalRef !== undefined) {
      sets.push("legal_ref = ?");
      params.push(patch.legalRef);
    }
    if (sets.length === 0) return;
    sets.push("updated_ts = ?");
    params.push(Date.now());
    params.push(id);
    this.db.prepare(`UPDATE scheduled_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id);
  }
}

// ── DispatchRequest 构造 ──────────────────────────────────────────────
//
// 设计裁决: DispatchRequest 无结构化 payload 槽位（spec §6.5 小 spike——
// 核实结果: 无 checkpointId 字段），故:
//   role         = taskType（任务类型即派发路由角色）
//   task         = payload 的 JSON 序列化（字符串 payload 原样）
//   labels       = 携带 tenantId / scheduledJobId / scheduleKind（租户隔离透传）
//   caller       = "timed-trigger"

export function buildDispatchRequest(job: ScheduledJob, fireCount: number): DispatchRequest {
  const payload = job.payload;
  const task =
    typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return {
    traceId: `scheduled:${job.id}:${fireCount}`,
    role: job.taskType,
    task,
    taskCategory: "scheduled",
    labels: {
      tenantId: job.tenantId,
      scheduledJobId: job.id,
      scheduleKind: job.scheduleKind,
    },
    caller: "timed-trigger",
  };
}

// ── TimedTrigger ──────────────────────────────────────────────────────
//
// 常驻会话进程内 unref 定时器周期扫描到期 job → dispatch → 更新 nextFireAt/状态。
// missed-fire 策略: 重启恢复时到期 job 在首次扫描补火一次，然后按当前时刻
// 重新调度（interval/cron 从 now 起算；at 转 done）。

export interface TimedTriggerOptions {
  store: ScheduledJobsStore;
  /** 派发入口——生产接线为 SchedulerRunner.dispatch（Task 28 接线）。 */
  dispatch: (request: DispatchRequest) => Promise<DispatchResult>;
  /** 审计事件入口——生产接线为 core.events.append。 */
  appendEvent: (event: LabEvent) => "inserted" | "duplicate";
  pollIntervalMs?: number;
  now?: () => number;
}

export class TimedTrigger {
  private readonly store: ScheduledJobsStore;
  private readonly dispatch: (request: DispatchRequest) => Promise<DispatchResult>;
  private readonly appendEvent: (event: LabEvent) => "inserted" | "duplicate";
  private readonly pollIntervalMs: number;
  private readonly nowFn: () => number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private scanning = false;

  constructor(opts: TimedTriggerOptions) {
    this.store = opts.store;
    this.dispatch = opts.dispatch;
    this.appendEvent = opts.appendEvent;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    this.nowFn = opts.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const timer = setInterval(() => {
      void this.scanDue();
    }, this.pollIntervalMs);
    timer.unref(); // 不阻止进程退出
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 扫描并触发全部到期 job。返回触发数。可重入安全（并发扫描直接跳过）。 */
  async scanDue(): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      const now = this.nowFn();
      const due = this.store.listDue(now);
      let fired = 0;
      for (const job of due) {
        try {
          await this.fire(job, now);
          fired++;
        } catch (err) {
          // fire() 内部已吞掉 dispatch/reschedule 错误；此处为防御性兜底。
          this.audit(job, now, "scheduled.error", {
            phase: "scan",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return fired;
    } finally {
      this.scanning = false;
    }
  }

  private async fire(job: ScheduledJob, now: number): Promise<void> {
    const fireCount = job.fireCount + 1;
    const request = buildDispatchRequest(job, fireCount);

    let dispatchStatus: string;
    try {
      const result = await this.dispatch(request);
      dispatchStatus = result.status;
    } catch (err) {
      dispatchStatus = "dispatch-threw";
      this.audit(job, now, "scheduled.error", {
        phase: "dispatch",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let nextStatus: ScheduledJobStatus = job.status;
    let nextFireAt = now;
    try {
      if (job.scheduleKind === "at") {
        nextStatus = "done"; // 单次触发
      } else {
        nextFireAt = computeNextFireAt(job.scheduleKind, job.scheduleSpec, now);
      }
    } catch (err) {
      nextStatus = "paused"; // 无法重排 → 暂停待人工介入
      this.audit(job, now, "scheduled.error", {
        phase: "reschedule",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.store.update(job.id, {
      status: nextStatus,
      nextFireAt,
      lastFireAt: now,
      fireCount,
    });
    this.audit(job, now, "scheduled.fire", {
      jobId: job.id,
      tenantId: job.tenantId,
      taskType: job.taskType,
      scheduleKind: job.scheduleKind,
      dispatchStatus,
      status: nextStatus,
      nextFireAt,
    });
  }

  private audit(job: ScheduledJob, now: number, eventType: string, payload: unknown): void {
    try {
      this.appendEvent({
        eventId: `${eventType}:${job.id}:${job.fireCount + 1}:${crypto.randomUUID().slice(0, 8)}`,
        eventType,
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `scheduled:${job.id}:${job.fireCount + 1}`,
          // 评审 WP5-R2 I-1：定时事件带租户归属（job.tenantId）
          ...(job.tenantId ? { tenantId: job.tenantId } : {}),
        },
        payload,
      });
    } catch {
      // 审计失败不阻断主路径
    }
  }
}
