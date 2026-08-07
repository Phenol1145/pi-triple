/**
 * Pi-Triple SDK Adapter — 隔离 pi SDK 版本变更的唯一边界
 *
 * 所有对 @earendil-works/pi-coding-agent 的 import 必须且只能出现在此文件。
 * 其余模块通过本文件导出的接口和常量访问 SDK 功能。
 *
 * 升级 SDK 时：只需修改本文件，跑测试，不动业务代码。
 */

// ─── SDK imports（唯一入口）───────────────────────────────────
import {
  createAgentSession as sdkCreateAgentSession,
  ModelRuntime as SdkModelRuntime,
  SessionManager as SdkSessionManager,
  DefaultResourceLoader as SdkDefaultResourceLoader,
  type AgentSession as SdkAgentSession,
} from "@earendil-works/pi-coding-agent";

// Re-export ResourceLoader + Skill for PTH program support
import type { ResourceLoader, Skill } from "@earendil-works/pi-coding-agent";
export type { ResourceLoader, Skill };
export type { InlineExtension } from "@earendil-works/pi-coding-agent";
export { SdkDefaultResourceLoader as DefaultResourceLoader };

// F/WP5 Task 27：常驻会话共享事件总线（pi.events 即此实例——见 agent-engine
// buildSystemSession 传入 DefaultResourceLoader options.eventBus）。pth 主进程
// emit、agent-lab（常驻会话内扩展）经 pi.events.on 订阅——零引用转发通道。
export { createEventBus, type EventBus, type EventBusController } from "@earendil-works/pi-coding-agent";

// ─── 事件类型常量 ─────────────────────────────────────────────
/** pi SDK 事件类型名。SDK 升级后若改名，只需改这里。 */
export const SDK_EVENTS = {
  AGENT_START: "agent_start",
  AGENT_END: "agent_end",
  TURN_START: "turn_start",
  MESSAGE_START: "message_start",
  MESSAGE_UPDATE: "message_update",
  MESSAGE_END: "message_end",
  TOOL_EXECUTION_START: "tool_execution_start",
  TOOL_EXECUTION_END: "tool_execution_end",
} as const;

export type SdkEventType = (typeof SDK_EVENTS)[keyof typeof SDK_EVENTS];

// ─── 会话接口 ─────────────────────────────────────────────────
/** 平台对 AgentSession 的最小依赖接口。SDK 升级后只需确保实现此接口。 */
export interface PlatformAgentSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(callback: (event: SdkEvent) => void): () => void;
  dispose(): void;
  /**
   * 绑定扩展运行时并 emit session_start（S3 缺口 2——agent-lab 的 pi.on(session_start) 依赖）。
   * 参考 print-mode 的 bindExtensions 调用：{ mode, commandContextActions, onError }。
   */
  bindExtensions(bindings?: PlatformExtensionBindings): Promise<void>;
  /**
   * 显式 emit session_shutdown 后 dispose（S3 缺口 3——agent-lab 的 pi.on(session_shutdown) 关 DB 防句柄泄漏）。
   * 实证：SDK AgentSession.dispose() 不发 session_shutdown（仅 reload() 路径发）——调用方必须显式触发。
   */
  shutdown(): Promise<void>;
}

/** 扩展绑定最小面（mode + onError；UI/命令动作留给 print 模式默认） */
export interface PlatformExtensionBindings {
  mode?: "tui" | "rpc" | "json" | "print";
  onError?: (error: unknown) => void;
}

/** SDK 事件的标准化视图 */
export interface SdkEvent {
  type: string;
  [key: string]: unknown;
}

// ─── 适配函数 ─────────────────────────────────────────────────
/**
 * 创建 agent 会话。接受 SDK 原生选项，返回 PlatformAgentSession 接口。
 * SDK 升级时只需调整此函数的参数映射。
 */
export async function createSession(
  options: Parameters<typeof sdkCreateAgentSession>[0],
): Promise<{ session: PlatformAgentSession }> {
  const { session } = await sdkCreateAgentSession(options);

  // 适配为平台接口（当前 SDK 接口已满足，直接透传）
  const adapted: PlatformAgentSession = {
    prompt: (text: string) => session.prompt(text),
    abort: () => session.abort(),
    subscribe: (cb: (event: SdkEvent) => void) => session.subscribe(cb as any),
    dispose: () => session.dispose(),
    bindExtensions: async (bindings) => {
      await session.bindExtensions({
        mode: bindings?.mode ?? "print",
        onError: bindings?.onError as any,
      });
    },
    shutdown: async () => {
      try {
        // S3 缺口 3：dispose 前显式 emit session_shutdown（agent-lab 关 DB）。
        // 无处理器/旧 SDK 缺方法时静默降级为仅 dispose。
        if (session.hasExtensionHandlers?.("session_shutdown")) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        session.dispose();
      }
    },
  };
  return { session: adapted };
}

// ─── ModelRuntime 透传 ────────────────────────────────────────
/** 模型运行时。当前直接透传 SDK 类型，未来可在此加缓存/降级。 */
export const ModelRuntime = SdkModelRuntime;
/** ModelRuntime 实例类型（SDK 构造器是 private，用 ReturnType 提取） */
export type ModelRuntimeInstance = Awaited<ReturnType<typeof SdkModelRuntime.create>>;

// ─── SessionManager 透传 ──────────────────────────────────────
export const SessionManager = SdkSessionManager;
/** SessionManager 实例类型（SDK 构造器 private，供类型标注用） */
export type SessionManager = SdkSessionManager;

// ─── 版本信息 ─────────────────────────────────────────────────
export const SDK_ADAPTER_VERSION = "1.0.0";

/**
 * 记录当前适配的 SDK 版本范围（与 package.json 保持一致）。
 *
 * SDK 升级检查清单：
 *   1. 适配层 API 变更 → 修本文件 + 跑测试（已知边界）
 *   2. 文档约定复检 → diff 新旧版 docs/skills.md "Locations" 段与
 *      docs/extensions.md "Extension Locations" 段；有变化则同步更新
 *      docs/ptl/authoring.md（技能/扩展放置规范）
 *   3. ptl doctor + ptl shared status 验证挂载链路
 */
export const SDK_COMPAT_RANGE = "^0.82.1";
