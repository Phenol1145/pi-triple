/**
 * Pi-Triple 共享 tmux 会话模块（_shared — 平台内部共享，非扩展，勿加 index.ts）
 *
 * 所有操作经可注入 runner（默认 spawnSync）执行，测试零真实 tmux 依赖。
 * 会话名统一为"去 pit- 前缀"的短名；tmux 实际名 = `pit-<name>`。
 */
import { spawnSync } from "node:child_process";

export interface TmuxResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface TmuxRunner {
  (args: string[], opts?: { encoding?: string }): TmuxResult;
}

export function createDefaultRunner(): TmuxRunner {
  return (args, opts) => {
    const r = spawnSync("tmux", args, { encoding: opts?.encoding ?? "utf-8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** tmux 会话名消毒：替换非法字符（禁 . 开头、禁 : 等），保留中文 */
const INVALID_RE = /[^a-zA-Z0-9_\-\u4e00-\u9fff]/g;

export class TmuxSession {
  constructor(private runner: TmuxRunner = createDefaultRunner()) {}

  hasTmux(): boolean {
    return this.runner(["-V"]).status === 0;
  }

  sanitizeName(name: string): string {
    const cleaned = name.replace(INVALID_RE, "-").replace(/^-+/, "");
    return cleaned.length === 0 ? "unnamed" : cleaned;
  }

  listPitSessions(): string[] {
    const r = this.runner(["list-sessions", "-F", "#{session_name}"]);
    return (r.stdout ?? "").trim().split("\n")
      .filter((l) => l.startsWith("pit-"))
      .map((l) => l.replace(/^pit-/, ""));
  }

  listSessionsDetail(): Array<{ name: string; windows: number; ageSec: number }> {
    const r = this.runner(["list-sessions", "-F", "#{session_name} #{session_windows} #{session_created}"]);
    const now = Math.floor(Date.now() / 1000);
    return (r.stdout ?? "").trim().split("\n")
      .filter((l) => l.startsWith("pit-"))
      .map((l) => {
        const [full, win, created] = l.split(" ");
        return {
          name: full.replace(/^pit-/, ""),
          windows: parseInt(win ?? "1", 10) || 1,
          ageSec: Math.max(0, now - parseInt(created ?? "0", 10)),
        };
      });
  }

  sessionExists(name: string): boolean {
    return this.runner(["has-session", "-t", `pit-${name}`]).status === 0;
  }

  /**
   * 启动后台 pi 会话。name 缺省时自动生成 auto-<6位base36>（唯一性重试 3 次）。
   * @returns {ok:false} 固定名已存在 / 自动名冲突耗尽
   */
  startSession(opts: { name?: string; env?: Record<string, string> }): { ok: boolean; name: string; error?: string } {
    const { name, env } = opts;
    if (name !== undefined) {
      if (this.sessionExists(name)) {
        return { ok: false, name, error: `Session "${name}" already running` };
      }
      return this.launch(name, env);
    }
    for (let i = 0; i < 3; i++) {
      const auto = `auto-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
      if (!this.sessionExists(auto)) return this.launch(auto, env);
    }
    return { ok: false, name: "", error: "auto name collision after 3 tries" };
  }

  private launch(name: string, env?: Record<string, string>): { ok: boolean; name: string; error?: string } {
    const args = ["new-session", "-d", "-s", `pit-${name}`, "-x", "200", "-y", "50"];
    for (const [k, v] of Object.entries(env ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    args.push("--", "pi");
    const r = this.runner(args);
    if (r.status === 0) return { ok: true, name, error: undefined };
    return { ok: false, name, error: r.stderr.trim() || "tmux new-session failed" };
  }

  stopSession(name: string): boolean {
    return this.runner(["kill-session", "-t", `=pit-${name}`]).status === 0;
  }

  switchTo(name: string): boolean {
    return this.runner(["switch-client", "-t", `=pit-${name}`]).status === 0;
  }

  detach(): boolean {
    return this.runner(["detach-client"]).status === 0;
  }

  /** 当前 tmux 会话名（原始名，含 pit- 前缀或任意其他会话）；非 tmux 内返回 null */
  currentSessionName(): string | null {
    const r = this.runner(["display-message", "-p", "#{session_name}"]);
    const out = (r.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  }

  setSessionEnv(name: string, key: string, value: string): boolean {
    return this.runner(["set-environment", "-t", `pit-${name}`, key, value]).status === 0;
  }

  getSessionEnv(name: string, key: string): string | null {
    const r = this.runner(["show-environment", "-t", `pit-${name}`, key]);
    if (r.status !== 0) return null;
    const line = (r.stdout ?? "").trim();
    if (!line.startsWith(`${key}=`)) return null;
    return line.slice(key.length + 1).replace(/^"(.*)"$/, "$1");
  }
}
