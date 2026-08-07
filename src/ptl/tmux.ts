/**
 * tmux.ts — Pi-Triple tmux 操作共享模块
 *
 * 所有 tmux 会话管理函数集中于此，确保：
 * - 单一命名规则事实源（"ptl-" 前缀）
 * - 统一环境变量注入（PI_*, AGENT_LAB_*）
 * - 精确匹配（=ptl-<name>）vs 前缀匹配语义明确
 */
import { spawnSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────

export interface PtlSession {
  name: string;
  windows: number;
  created: Date;
  attached?: number;        // 前端占用数（新）
  activityAgeMs?: number;   // 最后活动距今 ms（新）
}

export interface PtlPanes {
  [sessionName: string]: string; // pane_start_command
}

export interface PtlPaneInfo {
  pid?: number;
  currentCommand?: string;
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
  return `ptl-${name}`;
}

/** 会话名消毒：合法 [A-Za-z0-9._-]；非法返回错误消息，合法返回 null */
export function validateSessionName(name: string): string | null {
  if (!name) return "会话名不能为空";
  if (/[^A-Za-z0-9._-]/.test(name)) return `会话名含非法字符（仅允许字母/数字/._-）: "${name}"`;
  return null;
}

/** 年龄格式化（对应 sessions list/output） */
export function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

// ─── Session Listing / Query ─────────────────────────────────

/** 列出所有 ptl-* 会话 */
export function listPtlSessions(): PtlSession[] {
  if (!hasTmux()) return [];
  const result = spawnSync(
    "tmux",
    ["list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_created}:#{session_attached}:#{session_activity}"],
    { encoding: "utf-8" },
  );
  const now = Date.now();
  return (result.stdout ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("ptl-"))
    .map((l) => {
      const [full, win, created, attached, activity] = l.split(":");
      return {
        name: full.replace(/^ptl-/, ""),
        windows: parseInt(win ?? "1", 10),
        created: new Date(parseInt(created ?? "0", 10) * 1000),
        attached: parseInt(attached ?? "0", 10),
        activityAgeMs: activity ? Math.max(0, now - parseInt(activity, 10) * 1000) : undefined,
      };
    });
}

/** 一次调用拿所有 ptl-* 会话 pane 启动命令（仅列 ptl- 前缀） */
export function listPtlPanes(): PtlPanes {
  if (!hasTmux()) return {};
  const r = spawnSync("tmux", ["list-panes", "-a", "-F", "#{session_name}|#{pane_start_command}"], { encoding: "utf-8" });
  const panes: PtlPanes = {};
  for (const line of (r.stdout ?? "").trim().split("\n")) {
    const [session, cmd] = line.split("|");
    if (session && session.startsWith("ptl-") && cmd) panes[session] = cmd;
  }
  return panes;
}

/** 一次调用拿所有 ptl-* 会话 pane 的 pid + 当前命令（additive：不动 listPtlPanes） */
export function listPtlPanesDetailed(): Map<string, PtlPaneInfo> {
  const out = new Map<string, PtlPaneInfo>();
  if (!hasTmux()) return out;
  const r = spawnSync("tmux", ["list-panes", "-a", "-F", "#{session_name}|#{pane_pid}|#{pane_current_command}"], { encoding: "utf-8" });
  for (const line of (r.stdout ?? "").trim().split("\n")) {
    const [session, pid, cmd] = line.split("|");
    if (!session || !session.startsWith("ptl-")) continue;
    out.set(session, { pid: pid ? parseInt(pid, 10) || undefined : undefined, currentCommand: cmd || undefined });
  }
  return out;
}

/** 按模板别名获取运行中会话列表（B3 修复：前缀匹配而非精确匹配） */
export function sessionsForTenant(templateAlias: string): string[] {
  if (!hasTmux()) return [];
  const prefix = `ptl-${templateAlias}-`;
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

/** 检查指定名称的会话是否存在（精确匹配 =ptl-<name>） */
export function hasPtlSession(name: string): boolean {
  if (!hasTmux()) return false;
  const r = spawnSync("tmux", ["has-session", "-t", `=${tmuxSessionName(name)}`], { encoding: "utf-8" });
  return r.status === 0;
}

/** 终止指定会话（精确匹配） */
export function killPtlSession(name: string): boolean {
  if (!hasTmux()) return false;
  const r = spawnSync("tmux", ["kill-session", "-t", `=${tmuxSessionName(name)}`], { encoding: "utf-8" });
  return r.status === 0;
}

/** 指定会话 pane 的主进程 pid（创建后调用）
 * 注：不用 `=` 精确前缀 — tmux 3.6b 的 display-message 对 `=name` 目标静默返回空；
 * 裸 `ptl-<name>` 先精确匹配，安全（会话名唯一 + 消毒后无歧义）。 */
export function getPanePid(sessionName: string): number | null {
  if (!hasTmux()) return null;
  const r = spawnSync("tmux", ["display-message", "-p", "-t", sessionName, "#{pane_pid}"], { encoding: "utf-8" });
  const pid = parseInt((r.stdout ?? "").trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
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
export function startPtlSession(
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
