/**
 * ptl/route — 命令路由决策（纯函数）+ tui/hub 分发实现（依赖注入，便于测试）
 *
 * 纯决策部分（resolveTuiPanel / getDeprecatedMigration / 常量表）无副作用；
 * cmdTui/cmdHub 通过注入 launcher/handlers 实现可测试。
 */

import path from "node:path";
import {
  loadConfig, resolveTemplateId, getTemplateAlias, getDefaultTemplateId, pitHome,
} from "@pi-triple/shared";
import { cmdSubmit } from "../bridge/submit.js";
import { cmdRun } from "../bridge/run.js";
import { cmdPrograms } from "../bridge/programs.js";
import { cmdDev } from "../bridge/dev.js";
import { cmdHubRequest, cmdHubRequests } from "../bridge/request.js";
import { cmdHubRespond } from "../bridge/respond.js";
import { cmdHubObserve } from "../bridge/observe.js";
import { cmdHubDebug } from "../bridge/debug.js";
import { cmdKernelStatus, cmdKernelTasksAdd, cmdKernelTasksLs, cmdKernelBatchAdd, cmdKernelBatchRemove } from "../bridge/kernel.js";
import { printNamespaceHelp } from "./main.js";

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

export const HUB_COMMANDS = ["submit", "run", "programs", "dev", "request", "requests", "respond", "observe", "debug"] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

// ─── deprecated（clean break：旧命令仅提示迁移）────────────────

export const DEPRECATED_COMMANDS: Record<string, string> = {
  ui: "ptl tui dashboard",
  lab: "ptl tui lab",
  submit: "ptl hub submit",
  run: "ptl hub run",
  programs: "ptl hub programs",
  dev: "ptl hub dev",
};

/** 旧命令 → 迁移提示文案；未废弃返回 null。 */
export function getDeprecatedMigration(command: string): string | null {
  if (!Object.hasOwn(DEPRECATED_COMMANDS, command)) return null;
  return `已迁移：请使用 ${DEPRECATED_COMMANDS[command]}`;
}

// ─── cmdTui 实现 ───────────────────────────────────────────

export type TuiLaunchOpts = { panel: TuiPanel; flags: Record<string, string> };
export type TuiLauncher = (opts: TuiLaunchOpts) => Promise<void>;

/** 真实 TUI 启动（ink 渲染）。非 TTY 打印提示；lab 面板做模板解析 + AGENT_LAB_* env 注入。 */
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

  // lab 面板：解析模板 + 注入 per-tenant AGENT_LAB_* env（与 buildPiLaunch 一致）
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
  const home = pitHome();
  if (flags.global === "true") {
    process.env.AGENT_LAB_DB_PATH = path.join(home, "data", "shared", "agent-lab", "agent-lab.db");
  } else {
    process.env.AGENT_LAB_CONFIG_DIR = path.join(home, "data", "pi-config", templateId, "agent-lab");
    process.env.AGENT_LAB_DB_PATH = path.join(home, "data", "shared", "agent-lab", "agent-lab.db");
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

// ─── cmdHub 实现 ───────────────────────────────────────────

export type HubHandlers = {
  submit: (passthrough: string[], flags: Record<string, string>) => Promise<void>;
  run: (name: string, args: string[], flags: Record<string, string>) => Promise<void>;
  programs: (flags: Record<string, string>) => Promise<void>;
  dev: (dir: string, passthrough: string[], flags: Record<string, string>) => Promise<void>;
  request: (passthrough: string[], flags: Record<string, string>) => Promise<void>;
  requests: (flags: Record<string, string>) => Promise<void>;
  respond: (passthrough: string[], flags: Record<string, string>) => Promise<void>;
  observe: (passthrough: string[], flags: Record<string, string>) => Promise<void>;
  debug: (passthrough: string[], flags: Record<string, string>) => Promise<void>;
  kernel: (passthrough: string[], flags: Record<string, string>) => Promise<void>;
};

export const defaultHubHandlers: HubHandlers = {
  submit: cmdSubmit,
  run: cmdRun,
  programs: cmdPrograms,
  dev: cmdDev,
  request: cmdHubRequest,
  requests: cmdHubRequests,
  respond: cmdHubRespond,
  observe: cmdHubObserve,
  debug: cmdHubDebug,
  kernel: async (passthrough, flags) => {
    const [sub, ...rest] = passthrough;
    switch (sub) {
      case "tasks":
        if (rest[0] === "add") return cmdKernelTasksAdd(rest.slice(1), flags);
        if (rest[0] === "ls") return cmdKernelTasksLs(flags);
        console.log("  用法: ptl hub kernel tasks add \"<描述>\" [--tags a,b] | ls [--limit n]");
        return;
      case "batch":
        if (rest[0] === "add") return cmdKernelBatchAdd(rest.slice(1), flags);
        if (rest[0] === "remove") return cmdKernelBatchRemove(rest.slice(1), flags);
        console.log("  用法: ptl hub kernel batch add [n] | remove [n]");
        return;
      case "status":
        return cmdKernelStatus(rest, flags);
      default:
        console.log([
          "  ptl hub kernel tasks add \"<描述>\" [--tags a,b]   发布 PTH 任务",
          "  ptl hub kernel tasks ls [--limit n]              任务列表",
          "  ptl hub kernel batch add [n]                     启动 batch",
          "  ptl hub kernel batch remove [n]                  停止 batch",
          "  ptl hub kernel status                            运行状态全景",
        ].join("\n"));
    }
  },
};

/** ptl hub <submit|run|programs|dev> — 分发到 bridge 命令；无/未知子命令打印命名空间帮助。 */
export async function cmdHub(
  subcommand: string | undefined,
  passthrough: string[],
  flags: Record<string, string>,
  handlers: HubHandlers = defaultHubHandlers,
): Promise<void> {
  switch (subcommand) {
    case "submit":
      await handlers.submit(passthrough, flags);
      break;
    case "run":
      await handlers.run(passthrough[0] ?? "", passthrough.slice(1), flags);
      break;
    case "programs":
      await handlers.programs(flags);
      break;
    case "dev":
      await handlers.dev(passthrough[0] ?? "", passthrough.slice(1), flags);
      break;
    case "request":
      await handlers.request(passthrough, flags);
      break;
    case "requests":
      await handlers.requests(flags);
      break;
    case "respond":
      await handlers.respond(passthrough, flags);
      break;
    case "observe":
      await handlers.observe(passthrough, flags);
      break;
    case "debug":
      await handlers.debug(passthrough, flags);
      break;
    case "kernel":
      await handlers.kernel(passthrough, flags);
      break;
    default:
      printNamespaceHelp("hub");
  }
}
