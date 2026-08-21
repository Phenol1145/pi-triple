/**
 * ptl/route — 命令路由决策（纯函数）+ tui 分发实现（依赖注入，便于测试）。
 *
 * PTH 交互已迁移到 pth CLI（packages/pth-console/src/commands），
 * 本文件不再承载 ptl hub 分发。
 */

import {
  loadConfig, resolveTemplateId, getTemplateAlias, getDefaultTemplateId,
} from "@away_from/shared";

// ─── TUI ───────────────────────────────────────────────────

export type TuiPanel = "dashboard" | "lab";
export const TUI_PANELS: readonly TuiPanel[] = ["dashboard", "lab"];

/** 解析 TUI 子命令 → 面板。无子命令默认 dashboard；未知抛错。 */
export function resolveTuiPanel(subcommand: string | undefined): TuiPanel {
  if (!subcommand) return "dashboard";
  if (subcommand === "dashboard" || subcommand === "lab") return subcommand;
  throw new Error(`未知 TUI 面板: "${subcommand}"（可用: dashboard | lab）`);
}

// ─── deprecated（clean break：旧命令仅提示迁移）────────────────

export const DEPRECATED_COMMANDS: Record<string, string> = {
  ui: "ptl tui dashboard",
  lab: "ptl tui lab",
  hub: "pth <submit|program|request|observe|debug|bench|job|console|lineage|trigger|kernel>（PTH 交互）与 ptl stack（容器运维）",
  submit: "pth program submit",
  run: "pth program run",
  programs: "pth program list",
  dev: "ptl program dev",
};

/** 旧命令 → 迁移提示文案；未废弃返回 null。 */
export function getDeprecatedMigration(command: string): string | null {
  if (!Object.hasOwn(DEPRECATED_COMMANDS, command)) return null;
  return `已迁移：请使用 ${DEPRECATED_COMMANDS[command]}`;
}

// ─── cmdTui 实现 ───────────────────────────────────────────

export type TuiLaunchOpts = { panel: TuiPanel; flags: Record<string, string> };
export type TuiLauncher = (opts: TuiLaunchOpts) => Promise<void>;

export const defaultTuiLauncher: TuiLauncher = async (opts) => {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log("  TUI 需要交互式终端");
    return;
  }
  const { render } = await import("ink");
  const React = (await import("react")).default;

  if (opts.panel === "dashboard") {
    const { PtlApp } = await import("../tui-ptl/app.js");
    render(React.createElement(PtlApp), { exitOnCtrlC: false });
    return;
  }

  const { LabApp } = await import("../tui-lab/app.js");
  const cfg = loadConfig();
  const flags = opts.flags;
  const resolved = flags.template ? resolveTemplateId(flags.template, cfg) : null;
  if (flags.template && (!resolved || !resolved.ok)) {
    if (resolved && !resolved.ok && resolved.reason === "ambiguous" && "candidates" in resolved) {
      const candidates = resolved.candidates.map((c) => `${getTemplateAlias(c, cfg)} (${c.slice(0, 8)}…)`).join(", ");
      console.log(`\x1b[31m❌ "${flags.template}" 匹配多个模板: ${candidates}\x1b[0m`);
    } else {
      console.log(`\x1b[31m❌ 未知模板: "${flags.template}"\x1b[0m`);
    }
    console.log("  运行 \x1b[36mptl template ls\x1b[0m 查看可用模板\n");
    process.exit(1);
  }
  const templateId = resolved?.ok ? resolved.id : getDefaultTemplateId(cfg);
  const templateAlias = getTemplateAlias(templateId, cfg);
  if (flags.global === "true") {
  } else {
  }
  render(React.createElement(LabApp, { templateId, templateAlias, globalTelemetry: flags.global === "true" }), { exitOnCtrlC: false });
};

/** ptl tui [dashboard|lab] — 决策 + 调用注入的 launcher。 */
export async function cmdTui(
  subcommand: string | undefined,
  flags: Record<string, string>,
  launch: TuiLauncher = defaultTuiLauncher,
): Promise<void> {
  const panel = resolveTuiPanel(subcommand);
  await launch({ panel, flags });
}
