// src/ptl/session-state.ts — 会话状态机：tmux 存活 + 注册表条目 → 运行态判定（纯逻辑）
export type SessionStatus = "running" | "empty" | "orphan";

export interface TmuxLive {
  exists: boolean;
  pid?: number | null;
  currentCommand?: string;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh"]);

/** kill(pid, 0) 探测进程存活；非法/非正 pid 一律 false */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 状态判定（纯函数）：
 * running = tmux 在 && pid 存活
 * empty   = tmux 在 && pi 已退出（pid 死；退化：pid 缺失时当前命令是 shell）
 * orphan  = tmux 无 && 注册表有
 * null    = absent（tmux 无 && 注册表无）
 */
export function classifySession(live: TmuxLive, entry: { pid?: number | null } | null): SessionStatus | null {
  if (live.exists) {
    if (isPidAlive(live.pid)) return "running";
    if (live.pid == null) {
      // 退化路径：pid 缺失 → 当前命令是 shell 判空壳
      return live.currentCommand && SHELLS.has(live.currentCommand) ? "empty" : null;
    }
    return "empty";
  }
  return entry ? "orphan" : null;
}
