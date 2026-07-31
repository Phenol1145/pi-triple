/**
 * pit/route — 命令路由决策（纯函数）+ tui/hub 分发实现（依赖注入，便于测试）
 *
 * 纯决策部分（resolveTuiPanel / getDeprecatedMigration / 常量表）无副作用；
 * cmdTui/cmdHub 通过注入 launcher/handlers 实现可测试。
 */

// ─── TUI ───────────────────────────────────────────────────

export type TuiPanel = "dashboard" | "lab";
export const TUI_PANELS: readonly TuiPanel[] = ["dashboard", "lab"];

/** 解析 TUI 子命令 → 面板。无子命令默认 dashboard；未知抛错。 */
export function resolveTuiPanel(subcommand: string | undefined): TuiPanel {
  if (!subcommand) return "dashboard";
  if (subcommand === "dashboard" || subcommand === "lab") return subcommand;
  throw new Error(`未知 TUI 面板: "${subcommand}"（可用: dashboard | lab）`);
}

// ─── hub ───────────────────────────────────────────────────

export const HUB_COMMANDS = ["submit", "run", "programs", "dev"] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

// ─── deprecated（clean break：旧命令仅提示迁移）────────────────

export const DEPRECATED_COMMANDS: Record<string, string> = {
  ui: "pit tui dashboard",
  lab: "pit tui lab",
  submit: "pit hub submit",
  run: "pit hub run",
  programs: "pit hub programs",
  dev: "pit hub dev",
};

/** 旧命令 → 迁移提示文案；未废弃返回 null。 */
export function getDeprecatedMigration(command: string): string | null {
  const target = DEPRECATED_COMMANDS[command];
  return target ? `已迁移：请使用 ${target}` : null;
}