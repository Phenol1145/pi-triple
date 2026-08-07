/**
 * Pi-Triple Intercom — Watcher
 *
 * fs.watch 监听 pending/ 目录（零外部依赖），检测新消息即触发 Delivery.process()。
 * 原子发布（tmp + rename）保证文件出现时内容完整；15s 轮询兜底丢事件场景。
 * 去重由 Delivery.processedIds 保证，重复 dispatch 安全。
 */
import fs from "node:fs";
import path from "node:path";
import type { Mailbox } from "./mailbox.js";
import type { Delivery } from "./delivery.js";
import { validateMessage } from "./protocol.js";

/**
 * Delivery 决策的副作用执行器。
 * index.ts 注入具体实现（调用 api.sendMessage / ctx.ui.notify / mailbox.accept/reject）。
 */
export interface WatcherSideEffects {
  onNotify(text: string): void;
  onAccept(msgId: string): void;
  onReject(msgId: string): void;
  onInjectNextTurn(content: string, display: string, msgId: string): void;
  onInjectSteerAndNotify(content: string, notifyText: string, msgId: string): void;
  onAcceptAndInject(content: string, msgId: string): void;
}

const POLL_INTERVAL_MS = 15000;

export class Watcher {
  private fsWatcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sideEffects: WatcherSideEffects | null = null;

  constructor(
    private mailbox: Mailbox,
    private delivery: Delivery,
  ) {}

  setSideEffects(effects: WatcherSideEffects): void {
    this.sideEffects = effects;
  }

  start(): void {
    // fs.watch：rename 事件捕获原子发布（tmp → msg-*.json）
    try {
      this.fsWatcher = fs.watch(this.mailbox.pendingDir, (eventType, filename) => {
        if (eventType !== "rename" || !filename) return;
        if (!filename.startsWith("msg-") || !filename.endsWith(".json")) return;
        // 原子 rename 后文件已完整，微小延迟避免极端竞态
        const filePath = path.join(this.mailbox.pendingDir, filename);
        setTimeout(() => this.handleFile(filePath), 50);
      });
      this.fsWatcher.on("error", (err) => {
        // 静默处理（避免未捕获错误导致扩展崩溃）
        process.stderr.write(`[mailbox watcher] ${err.message}\n`);
      });
    } catch (err: any) {
      process.stderr.write(`[mailbox watcher] fs.watch 不可用，仅轮询: ${err.message}\n`);
    }

    // 轮询兜底：fs.watch 在某些场景（网络盘/高负载）会丢事件
    this.pollTimer = setInterval(() => this.scanAll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();

    // 启动时处理已有 pending
    this.scanAll();
  }

  stop(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 全量扫描 pending（启动时 + 轮询兜底） */
  private scanAll(): void {
    for (const msg of this.mailbox.readPending()) {
      this.dispatch(msg);
    }
  }

  private handleFile(filePath: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const msg = validateMessage(raw);
      if (msg) this.dispatch(msg);
    } catch {
      // 文件已被处理/移走，或读取竞态——轮询会兜底
    }
  }

  /** 执行 Delivery 决策的副作用 */
  private dispatch(msg: import("./protocol.js").PitMessage): void {
    const decision = this.delivery.process(msg);
    const fx = this.sideEffects;
    if (!fx) return;

    switch (decision.action) {
      case "skip":
        break;
      case "notify":
        fx.onNotify(decision.notifyText);
        break;
      case "accept":
        fx.onAccept(decision.msgId);
        if (decision.notifyText) fx.onNotify(decision.notifyText);
        break;
      case "reject":
        fx.onReject(decision.msgId);
        break;
      case "inject-next-turn":
        fx.onInjectNextTurn(decision.content, decision.display, decision.msgId);
        if (decision.notifyText) fx.onNotify(decision.notifyText);
        break;
      case "inject-steer-and-notify":
        fx.onInjectSteerAndNotify(decision.content, decision.notifyText, decision.msgId);
        break;
      case "accept-and-inject":
        fx.onAcceptAndInject(decision.content, decision.msgId);
        break;
      default:
        break;
    }
  }
}
