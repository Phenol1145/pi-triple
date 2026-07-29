/**
 * tmux.ts — Pi-Triple tmux 操作共享模块
 *
 * 所有 tmux 会话管理函数集中于此，确保：
 * - 单一命名规则事实源（"pit-" 前缀）
 * - 统一环境变量注入（PI_*, AGENT_LAB_*）
 * - 精确匹配（=pit-<name>）vs 前缀匹配语义明确
 */
import { spawnSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────

export interface PitSession {
  name: string;
  windows: number;
  created: Date;
}

// ─── Helpers ─────────────────────────────────────────────────

/** 检查 tmux 是否已安装 */
export function hasTmux(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
}

/**
 * 配置 tmux server 全局选项（pi 官方推荐）：
 * extended-keys on + extended-keys-format csi-u（tmux ≥ 3.5）。
 * best-effort：旧版 tmux 不支持时静默跳过。
 */
export function configureTmuxServer(): void {
  const fmt = spawnSync("tmux", ["show", "-gv", "extended-keys-format"], { encoding: "utf-8" });
  if (fmt.status === 0 && fmt.stdout.trim() === "csi-u") return;
  spawnSync("tmux", ["set-option", "-g", "extended-keys", "on"], { encoding: "utf-8" });
  spawnSync("tmux", ["set-option", "-g", "extended-keys-format", "csi-u"], { encoding: "utf-8" });
}

/** 用户命名 → tmux 会话名（唯一前缀源） */
export function tmuxSessionName(name: string): string {
  return `pit-${name}`;
}

/** 年龄格式化（对应 sessions list/output） */
export function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

// ─── Session Listing / Query ─────────────────────────────────

/** 列出所有 pit-* 会话 */
export function listPitSessions(): PitSession[] {
  if (!hasTmux()) return [];
  const result = spawnSync(
    "tmux",
    ["list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_created}"],
    { encoding: "utf-8" },
  );
  return (result.stdout ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("pit-"))
    .map((l) => {
      const [full, win, created] = l.split(":");
      return {
        name: full.replace(/^pit-/, ""),
        windows: parseInt(win ?? "1", 10),
        created: new Date(parseInt(created ?? "0", 10) * 1000),
      };
    });
}

/** 按模板别名获取运行中会话列表（B3 修复：前缀匹配而非精确匹配） */
export function sessionsForTenant(templateAlias: string): string[] {
  if (!hasTmux()) return [];
  const prefix = `pit-${templateAlias}-`;
  const result = spawnSync(
    "tmux",
    ["list-sessions", "-F", "#{session_name}"],
    { encoding: "utf-8" },
  );
  return (result.stdout ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.startsWith(prefix));
}

/** 检查指定名称的会话是否存在（精确匹配 =pit-<name>） */
export function hasPitSession(name: string): boolean {
  if (!hasTmux()) return false;
  const r = spawnSync("tmux", ["has-session", "-t", `=${tmuxSessionName(name)}`], { encoding: "utf-8" });
  return r.status === 0;
}

/** 终止指定会话（精确匹配） */
export function killPitSession(name: string): boolean {
  if (!hasTmux()) return false;
  const r = spawnSync("tmux", ["kill-session", "-t", `=${tmuxSessionName(name)}`], { encoding: "utf-8" });
  return r.status === 0;
}

// ─── Session Launch ──────────────────────────────────────────

/**
 * 构建 tmux new-session 参数（-e 传 env + -- 分隔，避免 shell 注入）。
 * detach: true → -d 后台；false → 前台接入。
 */
export function buildTmuxSessionArgs(
  launch: { cmd: string; args: string[]; env: Record<string, string>; cwd: string },
  session: string,
  detach: boolean,
): string[] {
  const tmuxArgs = ["new-session"];
  if (detach) tmuxArgs.push("-d");
  tmuxArgs.push("-s", session, "-c", launch.cwd, "-x", "200", "-y", "50");
  for (const [k, v] of Object.entries(launch.env)) {
    if (k.startsWith("PI_") || k.startsWith("AGENT_LAB_")) {
      tmuxArgs.push("-e", `${k}=${v}`);
    }
  }
  tmuxArgs.push("--", launch.cmd, ...launch.args);
  return tmuxArgs;
}

/**
 * 统一启动入口：使用 buildPiLaunch 的返回值创建 tmux 会话。
 * 返回 spawnSync 结果（status 0 = 成功）。
 * 修复 B4：所有启动路径经由 buildTmuxSessionArgs，确保 PI_/AGENT_LAB_ env 注入一致。
 */
export function startPitSession(
  launch: { cmd: string; args: string[]; env: Record<string, string>; cwd: string },
  name: string,
  detach: boolean,
) {
  const session = tmuxSessionName(name);
  const args = buildTmuxSessionArgs(launch, session, detach);
  const result = spawnSync("tmux", args, { encoding: "utf-8" });
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    session,
  };
}
