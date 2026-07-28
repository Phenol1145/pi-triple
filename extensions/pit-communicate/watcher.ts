/**
 * Pi-Triple Intercom — Watcher
 *
 * chokidar 监听 pending/ 目录，检测新消息即触发 Delivery.process()。
 * 去重由 Delivery.processedIds 保证。启动时处理已有 pending。
 */
import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import type { Mailbox } from "./mailbox.js";
import type { Delivery, DeliveryDecision } from "./delivery.js";
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

export class Watcher {
  private fsWatcher: FSWatcher | null = null;
  private sideEffects: WatcherSideEffects | null = null;

  constructor(
    private mailbox: Mailbox,
    private delivery: Delivery,
  ) {}

  setSideEffects(effects: WatcherSideEffects): void {
    this.sideEffects = effects;
  }

  start(): void {
    this.fsWatcher = watch(this.mailbox.pendingDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      depth: 0,
      ignorePermissionErrors: true,
    });

    this.fsWatcher.on("add", (filePath) => this.handleFile(filePath));
    this.fsWatcher.on("error", (err) => {
      // 静默处理（避免未捕获错误导致扩展崩溃）
      process.stderr.write(`[pit-communicate watcher] ${err.message}\n`);
    });

    // 启动时处理已有 pending
    for (const msg of this.mailbox.readPending()) {
      this.dispatch(msg);
    }
  }

  stop(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  private handleFile(filePath: string): void {
    const base = path.basename(filePath);
    if (!base.startsWith("msg-") || !base.endsWith(".json")) return;

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const msg = validateMessage(raw);
      if (msg) this.dispatch(msg);
    } catch {
      // 原子写入的 tmp 阶段文件，等 rename 后的 add 事件
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
