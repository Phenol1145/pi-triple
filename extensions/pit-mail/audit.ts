/**
 * Pi-Triple Intercom — Audit
 *
 * 追加式审计日志。每条 < 4KB（POSIX PIPE_BUF 原子追加）。
 * 大内容审计走 share 通道的文件记录。
 */
import fs from "node:fs";
import path from "node:path";

export interface AuditEvent {
  action: string;
  from?: string;
  to?: string;
  msgId?: string;
  detail?: string;
  timestamp: string;
  pid: number;
}

export class Audit {
  private logPath: string;

  constructor(mailboxRoot: string) {
    this.logPath = path.join(mailboxRoot, "audit.jsonl");
  }

  log(event: Omit<AuditEvent, "timestamp" | "pid">): void {
    const entry: AuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    };
    fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
  }

  /** 返回日志文件路径（供 /pit audit 命令使用） */
  getPath(): string {
    return this.logPath;
  }
}
