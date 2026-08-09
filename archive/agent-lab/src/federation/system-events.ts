/**
 * federation/system-events.ts — 常驻会话系统事件接线（F/WP5 Task 27/28）
 *
 * 消费 pth 主进程经共享 EventBus（pi.events === pth 持有的 systemEventBus，
 * 见 pth src/pth/core/system-event-bus.ts）投递的线协议消息：
 *
 *   EXTERNAL_EVENT_CHANNEL        "platform:external-event"            webhook 外部事件（Task 27）
 *   OBSERVE_EVENTS_REQUEST/...    "platform:observe-events:request"    观察 RPC 请求（Task 28b——pth→常驻会话→DB）
 *   OBSERVE_EVENTS_RESPONSE/...   "platform:observe-events:response"   观察 RPC 响应
 *   COMPONENT_BOUND_CHANNEL       "platform:component-bound"           scheduler/optimizer 空位绑定（Task 28c）
 *
 * 通道常量 = 线协议常量（与 pth 侧同名——协议字符串，非代码引用；两处各自声明文档互指）。
 *
 * 接线语义：
 *   - 外部事件 → 构造 LabEvent → core.events.append（append-only 不变量）→ onAppended
 *     旁路钩子 → SubscriptionDispatcher.handleEvent（Task 26 派发器）→ dispatch。
 *   - observe RPC：请求带 requestId 关联；core 未就绪时回 error（fail-open，不阻断）。
 *   - component-bound → ComponentBindingRegistry（框架层 registry——Task 18 接线子项落地）。
 *
 * 可测试性：本模块不依赖 ExtensionAPI 完整面（仅 pi.events）+ 惰性 accessors——
 * agent-lab 测试用真实 DB + mock 派发器直接驱动（见 test/scheduled-integration.test.ts）。
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabCore } from "../core/create-core.ts";
import type { LabEvent } from "../core/contracts.ts";
import type { SchedulerRuntimeLike } from "../interceptor/scheduler-bridge.ts";
import { ScheduledJobsStore, TimedTrigger } from "../scheduler/timed-trigger.ts";
import {
  SubscriptionStore,
  SubscriptionDispatcher,
} from "../core/events/subscription-dispatcher.ts";
import type { DispatchRequest, DispatchResult } from "../scheduler/runner.ts";

// ── 线协议通道常量（镜像 pth src/pth/core/system-event-bus.ts 同名常量）────────

export const EXTERNAL_EVENT_CHANNEL = "platform:external-event";
export const OBSERVE_EVENTS_REQUEST_CHANNEL = "platform:observe-events:request";
export const OBSERVE_EVENTS_RESPONSE_CHANNEL = "platform:observe-events:response";
export const COMPONENT_BOUND_CHANNEL = "platform:component-bound";

// ── ComponentBindingRegistry（框架层 registry——Task 18 registry 接线子项）─────

export interface ComponentBinding {
  slotId: string;
  type: string;
  name: string;
  version: number;
  tenantId: string;
  boundAt: number;
}

/**
 * 框架层构件绑定 registry：常驻会话内存注册表——scheduler/optimizer 空位绑定
 * 经 COMPONENT_BOUND_CHANNEL 注册后，常驻会话可按 slotId 加载/解析绑定的构件
 * （"bound component 可被常驻会话加载/调用"——冒烟级语义，Task 28c）。
 * 内存态：常驻会话 watchdog 重建后需 pth 重新通知（bindings 由 pth Redis 持久，
 * 重建会话可从 Redis 重放——演进项，见 runbook）。
 */
export class ComponentBindingRegistry {
  private readonly bindings = new Map<string, ComponentBinding>();

  register(binding: ComponentBinding): void {
    if (!binding?.slotId) return;
    this.bindings.set(binding.slotId, binding);
  }

  /** 按 slotId 加载/解析绑定（bound component 可被常驻会话加载/调用）。 */
  get(slotId: string): ComponentBinding | undefined {
    return this.bindings.get(slotId);
  }

  list(): ComponentBinding[] {
    return [...this.bindings.values()];
  }

  clear(): void {
    this.bindings.clear();
  }
}

// ── 系统事件接线 ──────────────────────────────────────────────────────────

export interface SystemEventsDeps {
  /** 仅需 pi.events（共享总线）。 */
  pi: Pick<ExtensionAPI, "events">;
  /**
   * 确保常驻会话运行时已初始化并返回 core（schedulerRuntimeFactory +
   * await bootstrapPromise）。core 未就绪返回 undefined（fail-open）。
   */
  ensureCore: () => Promise<LabCore | undefined>;
  /** 惰性取得 scheduler runner（可能 undefined——runtime init 失败）。 */
  getRunner: () => SchedulerRuntimeLike | undefined;
  db: DatabaseSync;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SystemEventsHandle {
  registry: ComponentBindingRegistry;
  dispatcher: SubscriptionDispatcher | undefined;
  trigger: TimedTrigger | undefined;
  /** 常驻会话就绪后调用：初始化派发器/定时器接线（core 未就绪时幂等等待）。 */
  start: () => Promise<void>;
  /** 供测试直接驱动外部事件处理（不经总线）。 */
  handleExternalEvent: (data: unknown) => Promise<void>;
  /** 供测试直接驱动 observe RPC 请求。 */
  handleObserveRequest: (data: unknown) => void;
  dispose: () => void;
}

export function wireSystemEvents(deps: SystemEventsDeps): SystemEventsHandle {
  const { pi, ensureCore, getRunner, db, now } = deps;
  const log = deps.log ?? ((msg: string) => console.error(`[agent-lab] system-events: ${msg}`));
  const nowFn = now ?? Date.now;
  const registry = new ComponentBindingRegistry();

  // 派发器/定时器惰性接线：core 就绪时创建一次（EventLog.onAppended → dispatcher）
  let dispatcher: SubscriptionDispatcher | undefined;
  let trigger: TimedTrigger | undefined;
  let wiredCore: LabCore | undefined;
  let wiringPromise: Promise<void> | undefined;

  const dispatchFn = (request: DispatchRequest): Promise<DispatchResult> => {
    const runner = getRunner();
    if (!runner) {
      return Promise.reject(new Error("scheduler runtime unavailable"));
    }
    // SchedulerRuntimeLike.dispatch 要求 mode 必填（runner-types 的 DispatchRequest mode 可选）——
    // 定时/事件派发缺省 execute 模式（与 subscription/timed-trigger 的构建裁决一致）。
    return runner.dispatch({
      ...request,
      mode: request.mode ?? "execute",
    }) as unknown as Promise<DispatchResult>;
  };

  async function ensureWired(): Promise<LabCore | undefined> {
    const core = await ensureCore();
    if (!core) return undefined;
    if (core === wiredCore) return core;
    if (!wiringPromise) {
      wiringPromise = (async () => {
        try {
          // Task 26 生产接线：EventLog.append 旁路 → 订阅派发器
          const subDispatcher = new SubscriptionDispatcher({
            store: new SubscriptionStore(db),
            dispatch: dispatchFn,
            appendEvent: (e) => core.events.append(e),
            now: nowFn,
          });
          core.events.onAppended((event) => {
            void subDispatcher.handleEvent(event).catch(() => {});
          });
          dispatcher = subDispatcher;

          // Task 25 生产接线：定时触发器（常驻会话进程内 unref 定时器）
          const timed = new TimedTrigger({
            store: new ScheduledJobsStore(db),
            dispatch: dispatchFn,
            appendEvent: (e) => core.events.append(e),
            now: nowFn,
          });
          timed.start();
          trigger = timed;
          wiredCore = core;
        } catch (err) {
          log(`wiring failed (fail-open): ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
    await wiringPromise;
    return wiredCore;
  }

  /** 外部事件 → LabEvent → core.events.append（→ 订阅派发器）。 */
  async function handleExternalEvent(data: unknown): Promise<void> {
    const raw = data as {
      eventId?: unknown;
      eventType?: unknown;
      payload?: unknown;
      source?: unknown;
      tenantId?: unknown;
      receivedAt?: unknown;
    } | null;
    if (!raw || typeof raw.eventType !== "string" || raw.eventType.length === 0) {
      log("ignoring malformed external event (missing eventType)");
      return;
    }
    const eventId = typeof raw.eventId === "string" ? raw.eventId : `external:${nowFn()}:${crypto.randomUUID().slice(0, 8)}`;
    const event: LabEvent = {
      eventId,
      eventType: raw.eventType,
      schemaVersion: "1",
      timestamp: typeof raw.receivedAt === "number" ? raw.receivedAt : nowFn(),
      identity: {
        traceId: `external:${eventId}`,
        // 评审 WP5-R2 I-1：外部事件带租户归属（webhook 层已绑定 req.auth.tenantId）
        ...(typeof raw.tenantId === "string" ? { tenantId: raw.tenantId } : {}),
      },
      payload: (raw.payload ?? {}) as Record<string, unknown>,
    };
    const core = await ensureWired();
    if (!core) {
      // fail-open：core 未就绪不阻断（pth 侧已落审计；事件不入 EventLog）
      log(`external event ${eventId} dropped (scheduler core not ready)`);
      return;
    }
    try {
      core.events.append(event);
    } catch (err) {
      log(`external event append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** observe RPC：查询 EventLog → 回响应通道（requestId 关联）。 */
  function handleObserveRequest(data: unknown): void {
    const raw = data as { requestId?: unknown; filter?: Record<string, unknown> } | null;
    const requestId = typeof raw?.requestId === "string" ? raw.requestId : undefined;
    const respond = (payload: { events?: LabEvent[]; error?: string }) => {
      if (requestId) {
        pi.events.emit(OBSERVE_EVENTS_RESPONSE_CHANNEL, { requestId, ...payload });
      }
    };
    void ensureWired().then((core) => {
      if (!core) {
        respond({ error: "scheduler core not ready" });
        return;
      }
      try {
        const filter = (raw?.filter ?? {}) as {
          eventType?: string;
          tenantId?: string;
          since?: number;
          until?: number;
          limit?: number;
        };
        respond({ events: core.events.query(filter) });
      } catch (err) {
        respond({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  const unsubExternal = pi.events.on(EXTERNAL_EVENT_CHANNEL, (data) => {
    void handleExternalEvent(data).catch(() => {});
  });
  const unsubObserve = pi.events.on(OBSERVE_EVENTS_REQUEST_CHANNEL, (data) => {
    handleObserveRequest(data);
  });
  const unsubComponent = pi.events.on(COMPONENT_BOUND_CHANNEL, (data) => {
    const b = data as Partial<ComponentBinding> | null;
    if (b?.slotId) {
      registry.register({
        slotId: b.slotId,
        type: typeof b.type === "string" ? b.type : "unknown",
        name: typeof b.name === "string" ? b.name : "unknown",
        version: typeof b.version === "number" ? b.version : 0,
        tenantId: typeof b.tenantId === "string" ? b.tenantId : "unknown",
        boundAt: typeof b.boundAt === "number" ? b.boundAt : nowFn(),
      });
    }
  });

  const handle: SystemEventsHandle = {
    get registry() {
      return registry;
    },
    get dispatcher() {
      return dispatcher;
    },
    get trigger() {
      return trigger;
    },
    start: () => ensureWired().then(() => undefined),
    handleExternalEvent,
    handleObserveRequest,
    dispose: () => {
      unsubExternal();
      unsubObserve();
      unsubComponent();
      trigger?.stop();
    },
  };
  return handle;
}
