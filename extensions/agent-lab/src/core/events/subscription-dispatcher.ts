import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { CORE_SCHEMA } from "../storage/schema.ts";
import type { LabEvent } from "../contracts.ts";
import type { DispatchRequest } from "../../scheduler/runner.ts";

// ── Types ─────────────────────────────────────────────────────────────

export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface EventPattern {
  /** 匹配的 eventType（精确匹配）。 */
  eventType: string;
  /** 过滤条件 json——键值对与事件 payload 深比较（全部命中才匹配）。 */
  filter?: Record<string, unknown>;
}

export interface EventSubscription {
  id: string;
  tenantId: string;
  eventPattern: EventPattern;
  taskType: string;
  payload: unknown;
  status: SubscriptionStatus;
  createdBy: string;
}

export interface NewEventSubscription {
  id: string;
  tenantId: string;
  eventPattern: EventPattern;
  taskType: string;
  payload: unknown;
  status: SubscriptionStatus;
  createdBy: string;
}

// ── 匹配 ─────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  if (a && typeof a === "object" && b && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** 订阅匹配：eventType 精确 + filter 键值全部命中事件 payload。 */
export function matchesPattern(pattern: EventPattern, event: LabEvent): boolean {
  if (pattern.eventType !== event.eventType) return false;
  const filter = pattern.filter;
  if (!filter || Object.keys(filter).length === 0) return true;
  const target = event.payload;
  if (typeof target !== "object" || target === null) return false;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = (target as Record<string, unknown>)[key];
    if (!deepEqual(expected, actual)) return false;
  }
  return true;
}

// ── SubscriptionStore（event_subscriptions 表 CRUD） ──────────────────

interface EventSubscriptionRow {
  id: string;
  tenant_id: string;
  event_pattern_json: string;
  task_type: string;
  payload_json: string;
  status: SubscriptionStatus;
  created_by: string;
}

function rowToSubscription(row: EventSubscriptionRow): EventSubscription {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventPattern: JSON.parse(row.event_pattern_json) as EventPattern,
    taskType: row.task_type,
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    createdBy: row.created_by,
  };
}

const SUBSCRIPTION_COLUMNS = `id, tenant_id, event_pattern_json, task_type, payload_json, status, created_by`;

export class SubscriptionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CORE_SCHEMA);
  }

  create(sub: NewEventSubscription): EventSubscription {
    if (!sub.id || !sub.tenantId || !sub.taskType || !sub.createdBy) {
      throw new Error("event subscription requires id, tenantId, taskType, createdBy");
    }
    if (!sub.eventPattern || typeof sub.eventPattern.eventType !== "string" || !sub.eventPattern.eventType) {
      throw new Error("eventPattern.eventType is required");
    }
    if (sub.eventPattern.filter !== undefined) {
      if (typeof sub.eventPattern.filter !== "object" || sub.eventPattern.filter === null || Array.isArray(sub.eventPattern.filter)) {
        throw new Error("eventPattern.filter must be an object");
      }
    }
    const statuses: SubscriptionStatus[] = ["active", "paused", "cancelled"];
    if (!statuses.includes(sub.status)) {
      throw new Error(`invalid subscription status: ${sub.status}`);
    }
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO event_subscriptions
       (id, tenant_id, event_pattern_json, task_type, payload_json, status, created_by, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sub.id,
      sub.tenantId,
      JSON.stringify(sub.eventPattern),
      sub.taskType,
      JSON.stringify(sub.payload ?? null),
      sub.status,
      sub.createdBy,
      now,
      now,
    );
    return this.get(sub.id)!;
  }

  get(id: string): EventSubscription | undefined {
    const row = this.db.prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM event_subscriptions WHERE id = ?`,
    ).get(id) as EventSubscriptionRow | undefined;
    return row ? rowToSubscription(row) : undefined;
  }

  list(filter?: { tenantId?: string; status?: SubscriptionStatus }): EventSubscription[] {
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
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM event_subscriptions ${where} ORDER BY id ASC`,
    ).all(...params) as unknown as EventSubscriptionRow[];
    return rows.map(rowToSubscription);
  }

  /** 生效订阅（status=active）——派发器匹配用。 */
  listActive(): EventSubscription[] {
    const rows = this.db.prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM event_subscriptions WHERE status = 'active' ORDER BY id ASC`,
    ).all() as unknown as EventSubscriptionRow[];
    return rows.map(rowToSubscription);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM event_subscriptions WHERE id = ?").run(id);
  }
}

// ── DispatchRequest 构造 ──────────────────────────────────────────────
//
// 设计裁决（与 Task 25 一致）: DispatchRequest 无结构化 payload 槽位，
// payload 模板 + 触发事件数据合并后经 task JSON 透传；tenantId 走 labels。

function subscriptionTask(sub: EventSubscription, event: LabEvent): string {
  if (typeof sub.payload === "string") return sub.payload;
  const template =
    sub.payload && typeof sub.payload === "object" && !Array.isArray(sub.payload)
      ? { ...(sub.payload as Record<string, unknown>) }
      : {};
  return JSON.stringify({
    ...template,
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      payload: event.payload,
      traceId: event.identity.traceId,
    },
  });
}

export function buildSubscriptionDispatchRequest(
  sub: EventSubscription,
  event: LabEvent,
): DispatchRequest {
  return {
    traceId: `event:${event.eventId}`,
    role: sub.taskType,
    task: subscriptionTask(sub, event),
    taskCategory: "event",
    labels: {
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      sourceEventType: event.eventType,
    },
    caller: "subscription-dispatcher",
  };
}

// ── SubscriptionDispatcher ────────────────────────────────────────────
//
// 订阅派发器（F/WP5 §6.2）: 表驱动订阅 + 内存回调注册表；EventLog append
// 后经 onAppended 钩子同步通知本派发器 → 匹配 → 构造 DispatchRequest → dispatch。
// 失败语义（评审 I4）: 匹配/构造/dispatch 异常仅记日志+审计，不阻断
// EventLog append 主路径。级联派发有最大深度保护（防止事件→派发→审计→
// 再匹配的循环风暴）。

export interface SubscriptionDispatcherOptions {
  store: SubscriptionStore;
  /** 派发入口——生产接线为 SchedulerRunner.dispatch（Task 28 接线）。 */
  dispatch: (request: DispatchRequest) => Promise<unknown>;
  /** 审计事件入口——生产接线为 core.events.append。 */
  appendEvent: (event: LabEvent) => "inserted" | "duplicate";
  now?: () => number;
  maxDispatchDepth?: number;
}

const MAX_EVENT_DEPTH = 32;

export class SubscriptionDispatcher {
  readonly store: SubscriptionStore;
  private readonly dispatch: (request: DispatchRequest) => Promise<unknown>;
  private readonly appendEvent: (event: LabEvent) => "inserted" | "duplicate";
  private readonly nowFn: () => number;
  private readonly maxDispatchDepth: number;
  private readonly callbacks = new Set<(event: LabEvent) => void>();
  private activeDepth = 0;

  constructor(opts: SubscriptionDispatcherOptions) {
    this.store = opts.store;
    this.dispatch = opts.dispatch;
    this.appendEvent = opts.appendEvent;
    this.nowFn = opts.now ?? Date.now;
    this.maxDispatchDepth = opts.maxDispatchDepth ?? MAX_EVENT_DEPTH;
  }

  /** 内存回调注册表（框架内部钩子用）。返回注销函数。 */
  subscribeCallback(cb: (event: LabEvent) => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  /**
   * 处理一个新落库事件：匹配生效订阅 → 逐条 dispatch；通知内存回调。
   * 永不 reject（内部全部兜底）。可安全 fire-and-forget（EventLog 旁路）。
   */
  async handleEvent(event: LabEvent): Promise<void> {
    if (this.activeDepth >= this.maxDispatchDepth) {
      this.logFailure(event, "depth", `max dispatch depth ${this.maxDispatchDepth} exceeded`);
      return;
    }
    this.activeDepth++;
    try {
      const matches = this.store.listActive().filter((sub) => matchesPattern(sub.eventPattern, event));

      for (const cb of [...this.callbacks]) {
        try {
          cb(event);
        } catch (err) {
          this.logFailure(event, "callback", err);
        }
      }

      for (const sub of matches) {
        try {
          const request = buildSubscriptionDispatchRequest(sub, event);
          const result = await this.dispatch(request);
          this.audit(event, sub, "subscription.dispatched", {
            subscriptionId: sub.id,
            tenantId: sub.tenantId,
            taskType: sub.taskType,
            dispatchStatus: String(result),
          });
        } catch (err) {
          this.logFailure(event, "dispatch", err, sub);
        }
      }
    } finally {
      this.activeDepth--;
    }
  }

  private logFailure(
    event: LabEvent,
    phase: "callback" | "dispatch" | "depth",
    err: unknown,
    sub?: EventSubscription,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `subscription-dispatcher: ${phase} failed (event=${event.eventId}): ${message}`,
    );
    try {
      this.appendEvent({
        eventId: `subscription.dispatch.failed:${event.eventId}:${randomUUID().slice(0, 8)}`,
        eventType: "subscription.dispatch.failed",
        schemaVersion: "1",
        timestamp: this.nowFn(),
        identity: {
        traceId: event.identity.traceId,
        // 评审 WP5-R2 I-1：订阅派发审计带租户归属（继承来源事件/subscription）
        ...(event.identity.tenantId ?? sub?.tenantId ? { tenantId: event.identity.tenantId ?? sub?.tenantId } : {}),
      },
        payload: {
          eventId: event.eventId,
          subscriptionId: sub?.id,
          phase,
          error: message,
        },
      });
    } catch {
      // 审计失败忽略——主路径不变量优先
    }
  }

  private audit(
    event: LabEvent,
    sub: EventSubscription,
    eventType: string,
    payload: unknown,
  ): void {
    try {
      this.appendEvent({
        eventId: `${eventType}:${event.eventId}:${sub.id}:${randomUUID().slice(0, 8)}`,
        eventType,
        schemaVersion: "1",
        timestamp: this.nowFn(),
        identity: {
        traceId: event.identity.traceId,
        // 评审 WP5-R2 I-1：订阅派发审计带租户归属（继承来源事件/subscription）
        ...(event.identity.tenantId ?? sub?.tenantId ? { tenantId: event.identity.tenantId ?? sub?.tenantId } : {}),
      },
        payload,
      });
    } catch {
      // 审计失败忽略
    }
  }
}
