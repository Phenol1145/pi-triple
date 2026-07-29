import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface FlowMeta {
  runId: string;
  name: string;
  status: string;
  createdAt: number;
  stepCount?: number;
}

const SCAN_INTERVAL_MS = 10_000;

export class GateWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private notified: Set<string> = new Set();
  private onNotify: ((runId: string, name: string, message: string) => void) | null =
    null;

  /** 注册通知回调（ctx.ui.notify 等） */
  setNotify(fn: (runId: string, name: string, message: string) => void): void {
    this.onNotify = fn;
  }

  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 只读 flows 目录：不修改任何文件（单向同步） */
  private scan(): void {
    const flowsDir = this.flowsRoot();
    if (!fs.existsSync(flowsDir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(flowsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(flowsDir, entry.name, "meta.json");
      try {
        const raw = fs.readFileSync(metaPath, "utf-8");
        const meta = JSON.parse(raw) as FlowMeta;
        const runId = meta.runId ?? entry.name;

        if (meta.status === "waiting_human" && !this.notified.has(runId)) {
          this.notified.add(runId);
          // 读 pending.json 获取消息摘要
          let message = `工作流 ${meta.name} 等待审批 — /flow approve ${runId.slice(0, 8)}`;
          try {
            const pendingPath = path.join(flowsDir, entry.name, "pending.json");
            const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
            if (pending.message) {
              const shortMsg = pending.message.slice(0, 120);
              message = `⏳ ${meta.name}: ${shortMsg} — /flow approve ${runId.slice(0, 8)}`;
            }
          } catch {
            // pending.json 不存在或不可读 → 用默认消息
          }
          this.onNotify?.(runId, meta.name, message);
        }

        // 脱离 waiting → 从集合移除（下次再进 gate 可再通知——多轮打回）
        if (meta.status !== "waiting_human" && this.notified.has(runId)) {
          this.notified.delete(runId);
        }
      } catch {
        // 目录无 meta.json 或解析失败 → 跳过
      }
    }
  }

  /** flows 根目录 */
  static flowsRoot(): string {
    return path.join(
      process.env.PI_TRIPLE_HOME ?? path.join(os.homedir(), ".pi-triple"),
      "data",
      "flows",
    );
  }

  /** 供测试注入 */
  private flowsRoot(): string {
    return GateWatcher.flowsRoot();
  }
}
