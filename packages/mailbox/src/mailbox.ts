/**
 * Pi-Triple Intercom — Mailbox
 *
 * 文件系统中转站：消息的发送(readPending)、接收(accept/reject)、文件暂存(sendFile)。
 * 所有写入通过 tmp + rename 保证原子性。
 */
import fs from "node:fs";
import path from "node:path";
import type { PitMessage } from "./protocol.js";
import { validateMessage } from "./protocol.js";

export class Mailbox {
  readonly baseDir: string;
  readonly pendingDir: string;
  readonly acceptedDir: string;
  readonly rejectedDir: string;

  /**
   * @param mailboxRoot  abs(DATA_DIR)/mailbox/
   * @param tenantId     租户 ID
   * @param sessionId    会话 ID
   */
  constructor(mailboxRoot: string, tenantId: string, sessionId: string) {
    this.baseDir = path.join(mailboxRoot, tenantId, sessionId);
    this.pendingDir = path.join(this.baseDir, "pending");
    this.acceptedDir = path.join(this.baseDir, "accepted");
    this.rejectedDir = path.join(this.baseDir, "rejected");
    for (const d of [this.pendingDir, this.acceptedDir, this.rejectedDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  // ── 发送 ──────────────────────────────────────────────────

  /** 原子写入消息到 pending（tmp → rename） */
  send(msg: PitMessage): void {
    const tmpPath = path.join(this.pendingDir, `.tmp-msg-${msg.id}-${process.pid}`);
    const finalPath = path.join(this.pendingDir, `msg-${msg.id}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(msg, null, 2));
    fs.renameSync(tmpPath, finalPath);
  }

  /**
   * 即时复制文件到 pending（store-and-forward）。
   * 同时写入 meta.json 包含消息元数据。
   */
  sendFile(msg: PitMessage, sourcePath: string): void {
    const fileDir = path.join(this.pendingDir, `file-${msg.id}`);
    fs.mkdirSync(fileDir, { recursive: true });

    // 复制文件
    const destFile = path.join(fileDir, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, destFile);

    // 写入 meta.json（tmp + rename）
    const tmpMeta = path.join(fileDir, `.tmp-meta-${process.pid}`);
    const finalMeta = path.join(fileDir, "meta.json");
    fs.writeFileSync(tmpMeta, JSON.stringify(msg, null, 2));
    fs.renameSync(tmpMeta, finalMeta);
  }

  // ── 读取 ──────────────────────────────────────────────────

  /** 读取所有 pending 消息（按时间排序） */
  readPending(): PitMessage[] {
    const msgs: PitMessage[] = [];
    try {
      for (const entry of fs.readdirSync(this.pendingDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // 文件消息（sendFile 写入的 file-<id>/ 目录）：读 meta.json 恢复消息
          // （e2e 暴露的集成缺口：旧实现跳过目录 → 文件消息无读回路径，
          //   accept 的 file 分支成为死代码）
          if (!entry.name.startsWith("file-")) continue;
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(this.pendingDir, entry.name, "meta.json"), "utf-8"));
            const msg = validateMessage(raw);
            if (msg) msgs.push(msg);
          } catch {
            // 部分写入或损坏，跳过
          }
          continue;
        }
        if (!entry.name.startsWith("msg-") || !entry.name.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(this.pendingDir, entry.name), "utf-8"));
          const msg = validateMessage(raw);
          if (msg) msgs.push(msg);
        } catch {
          // 部分写入或损坏，跳过
        }
      }
    } catch {
      // pending 目录不存在，返回空
    }
    return msgs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /** 按 id 查找单条消息 */
  getMessage(msgId: string): PitMessage | null {
    const msgPath = path.join(this.pendingDir, `msg-${msgId}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(msgPath, "utf-8"));
      return validateMessage(raw);
    } catch {
      return null;
    }
  }

  // ── 处理 ──────────────────────────────────────────────────

  /** accept：rename 到 accepted/ */
  accept(msgId: string): boolean {
    return this.moveMsg(msgId, this.acceptedDir);
  }

  /** reject：rename 到 rejected/ */
  reject(msgId: string): boolean {
    return this.moveMsg(msgId, this.rejectedDir);
  }

  private moveMsg(msgId: string, targetDir: string): boolean {
    const src = path.join(this.pendingDir, `msg-${msgId}.json`);
    const dst = path.join(targetDir, `msg-${msgId}.json`);
    try {
      fs.renameSync(src, dst);
      return true;
    } catch {
      // 文件消息（sendFile 写入的 file-<id>/ 目录）：整目录移动
      // （与 gc() 对 accepted/rejected 中 file-* 目录的清理设计一致；
      //   e2e 暴露的集成缺口：旧实现只移 msg-<id>.json，文件消息无此文件）
      const fileSrc = path.join(this.pendingDir, `file-${msgId}`);
      const fileDst = path.join(targetDir, `file-${msgId}`);
      try {
        fs.renameSync(fileSrc, fileDst);
        return true;
      } catch {
        return false;
      }
    }
  }

  // ── GC ────────────────────────────────────────────────────

  /**
   * 清理过期消息（accepted/rejected 保留 > maxAgeMs 的）。
   * @returns 清理数量
   */
  gc(maxAgeMs = 24 * 3600 * 1000): number {
    let cleaned = 0;
    const now = Date.now();
    for (const dir of [this.acceptedDir, this.rejectedDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // file-xxx/ 目录：清理整个目录
          const dirPath = path.join(dir, entry.name);
          try {
            if (entry.name.startsWith("file-") && now - fs.statSync(dirPath).mtimeMs > maxAgeMs) {
              fs.rmSync(dirPath, { recursive: true, force: true });
              cleaned++;
            }
          } catch { /* skip */ }
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        const fp = path.join(dir, entry.name);
        try {
          if (now - fs.statSync(fp).mtimeMs > maxAgeMs) {
            fs.unlinkSync(fp);
            cleaned++;
          }
        } catch { /* skip */ }
      }
    }
    return cleaned;
  }
}
