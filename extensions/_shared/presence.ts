/**
 * Pi-Triple Intercom — Presence (heartbeat)
 *
 * 每个 pi 会话维护 state.json 心跳文件，
 * 供其他会话判断在线状态（idle/busy）和存活（TTL + pid 检查）。
 */
import fs from "node:fs";
import path from "node:path";

export interface SessionState {
  pid: number;
  status: "idle" | "busy";
  name: string;
  model: string;
  mode: "manual" | "auto" | "hybrid";
  startedAt: string;
  lastHeartbeat: string;
}

const HEARTBEAT_INTERVAL = 10_000; // 10s
const TTL = 30_000; // 心跳超时 30s

export class Presence {
  private timer: ReturnType<typeof setInterval> | null = null;
  private statePath: string;

  constructor(
    /** mailbox/{tenant}/{sessionId}/ */
    baseDir: string,
    private state: SessionState,
  ) {
    this.statePath = path.join(baseDir, "state.json");
  }

  /** 启动心跳：立即写一次，之后每 10s 更新 */
  start(): void {
    this.write();
    this.timer = setInterval(() => this.write(), HEARTBEAT_INTERVAL);
    this.timer.unref(); // 不阻止进程退出
  }

  /** 更新状态（idle ↔ busy） */
  setStatus(status: "idle" | "busy"): void {
    this.state.status = status;
    this.write();
  }

  /** 更新审核模式 */
  setMode(mode: "manual" | "auto" | "hybrid"): void {
    this.state.mode = mode;
    this.write();
  }

  /** 更新状态字段（不立即写磁盘，配合心跳批量） */
  updateState(partial: Partial<SessionState>): void {
    Object.assign(this.state, partial);
    this.write();
  }

  /**
   * 原子写：tmp → rename，防止读取方看到半截文件
   */
  private write(): void {
    this.state.lastHeartbeat = new Date().toISOString();
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.statePath);
    } catch (e: any) {
      // 并发或权限问题，静默失败；下一轮心跳重试
      if (e.code !== "ENOENT" && e.code !== "EACCES") {
        throw e;
      }
    }
  }

  /** 退出时清理：停心跳 + 删 state.json */
  cleanup(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      fs.unlinkSync(this.statePath);
    } catch {
      // 文件不存在或无法删除
    }
  }

  // ── 静态工具方法 ──────────────────────────────────────────

  /**
   * 一次性静态更新 state.json 的 name 字段（供 pit-control 使用，不启动心跳）。
   * 读-改-写原子（tmp + rename）；文件不存在或损坏返回 false。
   */
  static updateName(statePath: string, name: string): boolean {
    const state = Presence.read(statePath);
    if (!state) return false;
    state.name = name;
    state.lastHeartbeat = new Date().toISOString();
    const tmp = `${statePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, statePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查 state.json 指向的会话是否在线。
   * 条件：lastHeartbeat 在 TTL 内 + pid 存活。
   */
  static isOnline(statePath: string): boolean {
    try {
      const state = Presence.read(statePath);
      if (!state) return false;

      const age = Date.now() - new Date(state.lastHeartbeat).getTime();
      if (age > TTL) return false;

      // 检查 PID 是否仍在运行（防 stale 心跳）
      try {
        process.kill(state.pid, 0);
      } catch {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 读取并解析 state.json */
  static read(statePath: string): SessionState | null {
    try {
      const raw = fs.readFileSync(statePath, "utf-8");
      const state: SessionState = JSON.parse(raw);
      if (
        typeof state.pid === "number" &&
        typeof state.startedAt === "string" &&
        typeof state.lastHeartbeat === "string"
      ) {
        return state;
      }
      return null;
    } catch {
      return null;
    }
  }
}
