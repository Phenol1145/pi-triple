/**
 * Pi-Triple Intercom — Delivery
 *
 * 根据审核策略（manual/auto/hybrid）决定消息如何投递：
 * - manual:  只有 ui.notify 通知人，人执行 /mail accept 后才进 LLM
 * - auto:    自动注入 LLM（sendMessage nextTurn），人收到通知
 * - hybrid:  按 priority/type 分流
 *
 * Rules: first-match wins（接收方评估）。会话级 /mail mode 仅内存、不持久化。
 */
import type { PitMessage } from "./protocol.js";
import type { Mailbox } from "./mailbox.js";

export type ReviewMode = "manual" | "auto" | "hybrid";

/** 投递回路：由 extension index.ts 在 session_start 后注入 */
export interface DeliveryActions {
  notify: (text: string) => void;
  injectNextTurn: (content: string, display: string) => void;
  injectFollowUp: (content: string) => void;
  injectSteer: (content: string) => void;
}

export interface IntercomConfig {
  defaultMode: ReviewMode;
  tenantMode?: ReviewMode;
  /** /mail mode 设置，仅内存，不持久化 */
  sessionMode?: ReviewMode;
  /** first-match wins，接收方评估 */
  rules?: Array<{
    from?: string;
    to?: string;
    type?: string;
    mode: ReviewMode;
  }>;
  askTimeout?: { auto: number; manual: number };
}

export class Delivery {
  private processedIds = new Set<string>();
  private actions: DeliveryActions | null = null;
  readonly config: IntercomConfig;

  /**
   * 构造时传入 mailboxRoot（用于 Delivery 内部的 notify/log，不直接操作 mailbox）
   * 实际的 mailbox.accept/reject 由调用方在 Delivery 决定后执行。
   */
  constructor(config: IntercomConfig) {
    this.config = config;
  }

  /**
   * 由 index.ts 在拿到 ctx 后注入。
   * Delivery 不 import ExtensionContext，保持纯逻辑性。
   */
  setActions(actions: DeliveryActions): void {
    this.actions = actions;
  }

  /**
   * 处理一条入站消息。
   * @returns Decision 对象，告诉调用方应该执行哪些副作用（accept/reject/notify/inject）
   */
  process(msg: PitMessage): DeliveryDecision {
    // 去重
    if (this.processedIds.has(msg.id)) return { action: "skip" };

    // 过期
    if (msg.expiresAt && new Date(msg.expiresAt) < new Date()) {
      this.processedIds.add(msg.id);
      return { action: "reject", msgId: msg.id };
    }

    // broadcast 环路
    if (msg.hop >= 3) {
      this.processedIds.add(msg.id);
      return { action: "reject", msgId: msg.id };
    }

    this.processedIds.add(msg.id);

    const mode = this.resolveMode(msg);
    return this.decide(msg, mode);
  }

  /**
   * 人执行 /mail accept 后调用：注入 LLM + 标记 accept。
   */
  acceptAndInject(msg: PitMessage): DeliveryDecision {
    this.processedIds.add(msg.id);
    return { action: "accept-and-inject", msgId: msg.id, content: msg.content, fromName: msg.from.name };
  }

  /** 手动标记 accept（不注入，只移动文件） */
  accept(msgId: string): { action: "accept" } {
    return { action: "accept" };
  }

  /** 手动标记 reject */
  reject(msgId: string): { action: "reject" } {
    this.processedIds.add(msgId);
    return { action: "reject" };
  }

  // ── 内部 ──────────────────────────────────────────────────

  private decide(msg: PitMessage, mode: ReviewMode): DeliveryDecision {
    switch (mode) {
      case "manual":
        return { action: "notify", msgId: msg.id, notifyText: this.formatNotify(msg) };

      case "auto":
        if (msg.type === "file") {
          return { action: "notify", msgId: msg.id, notifyText: this.formatNotify(msg) };
        }
        if (msg.priority === "urgent") {
          return {
            action: "inject-steer-and-notify",
            msgId: msg.id,
            content: msg.content,
            notifyText: `⚡ 自动接收(urgent): ${msg.from.name}: ${msg.content.slice(0, 80)}`,
          };
        }
        if (msg.priority === "fyi") {
          return { action: "accept", msgId: msg.id, notifyText: this.formatNotify(msg) };
        }
        return {
          action: "inject-next-turn",
          msgId: msg.id,
          content: msg.content,
          display: `📬 ${msg.from.name}: ${msg.content}`,
          notifyText: `🤖 自动接收: ${msg.from.name}: ${msg.content.slice(0, 80)}`,
        };

      case "hybrid":
        if (msg.priority === "urgent") {
          return {
            action: "inject-steer-and-notify",
            msgId: msg.id,
            content: msg.content,
            notifyText: `⚡ 自动接收(urgent): ${msg.from.name}`,
          };
        }
        if (msg.priority === "fyi") {
          return { action: "accept", msgId: msg.id, notifyText: this.formatNotify(msg) };
        }
        return { action: "notify", msgId: msg.id, notifyText: this.formatNotify(msg) };

      default:
        return { action: "notify", msgId: msg.id, notifyText: this.formatNotify(msg) };
    }
  }

  private resolveMode(msg: PitMessage): ReviewMode {
    if (this.config.sessionMode) return this.config.sessionMode;
    if (this.config.rules) {
      for (const rule of this.config.rules) {
        if (rule.from && rule.from !== msg.from.name) continue;
        if (rule.type && rule.type !== msg.type) continue;
        // rule.to 在当前上下文总是匹配（接收方即当前会话）
        return rule.mode;
      }
    }
    if (this.config.tenantMode) return this.config.tenantMode;
    return this.config.defaultMode;
  }

  private formatNotify(msg: PitMessage): string {
    const icon = msg.type === "file" ? "📦" : msg.priority === "urgent" ? "⚡" : "📬";
    return `${icon} from ${msg.from.name}: ${msg.content.slice(0, 100)}`;
  }
}

/** Delivery.process() 返回值，调用方据此执行副作用 */
export type DeliveryDecision =
  | { action: "skip" }
  | { action: "notify"; msgId: string; notifyText: string }
  | { action: "accept"; msgId: string; notifyText?: string }
  | { action: "reject"; msgId: string }
  | { action: "inject-next-turn"; msgId: string; content: string; display: string; notifyText?: string }
  | { action: "inject-steer-and-notify"; msgId: string; content: string; notifyText: string }
  | { action: "accept-and-inject"; msgId: string; content: string; fromName: string };
