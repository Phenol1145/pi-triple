/**
 * pit/commands/dispatch — 共享命令执行层
 *
 * CLI（pit.ts）与 TUI（tui-pit/app.tsx）共用的单一命令分发：
 * - 命令映射、参数处理、exec 调用只存在此处
 * - 进程内不安全/复杂的命令 → handoff（spawn `pit <新命令名>` 子进程）
 */
import { spawnSync } from "node:child_process";
import {
  execTemplateLs, execTemplateNew, execTemplateRm,
  execStatus, execLs, execStop, execStartBg, execSharedStatus,
  type CommandResult,
} from "../commands.js";
import { loadConfig, resolveTemplateId, renameTemplate } from "../config.js";
import {
  execSessionLs, execSessionShow, execSessionFork, execSessionClone,
  execSessionTransfer, execSessionBranch, execSessionTree, execSessionResume,
  execSessionAttach, execSessionStop, parseFlags,
} from "./session.js";
import { execTraceLs, execTraceShow, execTraceTimeline } from "./trace.js";

// ─── 类型 ────────────────────────────────────────────────────

export type DispatchTarget =
  | { kind: "exec"; fn: () => CommandResult | Promise<CommandResult> }
  | { kind: "handoff"; cmd: string; args: string[] };

// ─── 纯映射（可测）───────────────────────────────────────────

const FLOW_SUBCOMMANDS = new Set(["run", "status", "show", "ls", "approve", "reject", "resume", "edit", "set", "graph", "rm", "validate"]);
const HUB_SUBCOMMANDS = new Set(["submit", "run", "programs", "dev"]);
const TUI_PANELS = new Set(["dashboard", "lab"]);

export function resolveDispatch(cmd: string, args: string[]): DispatchTarget | null {
  const [sub = "", ...rest] = args;
  switch (cmd) {
    case "template":
      if (sub === "ls" || sub === "list" || sub === "") return { kind: "exec", fn: () => execTemplateLs() };
      if (sub === "new") return { kind: "exec", fn: () => execTemplateNew(rest[0]) };
      if (sub === "rm") return { kind: "exec", fn: () => execTemplateRm(rest[0] ?? "") };
      if (sub === "rename") return { kind: "exec", fn: () => renameTemplateCommand(rest[0] ?? "", rest[1] ?? "") };
      return null;
    case "status":
      return { kind: "exec", fn: () => execStatus() };
    case "ls":
      return { kind: "exec", fn: () => execLs() };
    case "stop":
      return { kind: "exec", fn: () => execStop(args[0] ?? "", parseFlags(args).flags) };
    case "start":
      return { kind: "exec", fn: () => execStartBg(args[0] ?? "", args[1] ?? "") };
    case "shared":
      if (sub === "status") return { kind: "exec", fn: () => execSharedStatus() };
      return null;
    case "session":
      if (sub === "ls" || sub === "list" || sub === "") return { kind: "exec", fn: () => execSessionLs(rest) };
      if (sub === "show") return { kind: "exec", fn: () => execSessionShow(rest[0] ?? "") };
      if (sub === "fork") return { kind: "exec", fn: () => execSessionFork(rest[0] ?? "", rest.slice(1)) };
      if (sub === "clone") return { kind: "exec", fn: () => execSessionClone(rest[0] ?? "", rest.slice(1)) };
      if (sub === "transfer") return { kind: "exec", fn: () => execSessionTransfer(rest[0] ?? "", rest.slice(1)) };
      if (sub === "branch") return { kind: "exec", fn: () => execSessionBranch(rest[0] ?? "", rest.slice(1)) };
      if (sub === "tree") return { kind: "exec", fn: () => execSessionTree(rest) };
      if (sub === "resume") return { kind: "exec", fn: () => execSessionResume(rest[0] ?? "", rest.slice(1)) };
      if (sub === "attach") return { kind: "exec", fn: () => execSessionAttach(rest[0] ?? "") };
      if (sub === "stop") return { kind: "exec", fn: () => execSessionStop(rest[0] ?? "") };
      return null;
    case "trace":
      if (sub === "ls" || sub === "list" || sub === "") return { kind: "exec", fn: () => execTraceLs(rest) };
      if (sub === "show") return { kind: "exec", fn: () => execTraceShow(rest[0] ?? "") };
      if (sub === "timeline") return { kind: "exec", fn: () => execTraceTimeline(rest[0] ?? "") };
      return null;
    case "detach":
      return { kind: "exec", fn: detachCommand };
    case "help":
      return { kind: "exec", fn: helpCommand };
    case "pi":
      return { kind: "handoff", cmd: "pit", args: ["pi", ...args] };
    case "attach":
      return { kind: "handoff", cmd: "pit", args: ["attach", ...args] };
    case "switch":
      return { kind: "handoff", cmd: "pit", args: ["switch", ...args] };
    case "hub":
      if (HUB_SUBCOMMANDS.has(sub)) return { kind: "handoff", cmd: "pit", args: ["hub", sub, ...rest] };
      return null;
    case "tui":
      if (TUI_PANELS.has(sub)) return { kind: "handoff", cmd: "pit", args: ["tui", sub] };
      return null;
    case "flow":
      if (FLOW_SUBCOMMANDS.has(sub)) return { kind: "handoff", cmd: "pit", args: ["flow", sub, ...rest] };
      return null;
    default:
      return null;
  }
}

// ─── 内联命令实现（自 tui-pit/app.tsx 迁入，单一来源）────────

function renameTemplateCommand(oldName: string, newName: string): Promise<CommandResult> {
  const cfg = loadConfig();
  if (!oldName || !newName) {
    return Promise.resolve({ ok: false, message: "", error: { code: "INVALID_ARGS", message: "用法: template rename <旧别名> <新别名>" } });
  }
  const resolved = resolveTemplateId(oldName, cfg);
  if (!resolved.ok) {
    return Promise.resolve({ ok: false, message: "", error: { code: "TEMPLATE_NOT_FOUND", message: `模板 "${oldName}" 不存在` } });
  }
  const ok = renameTemplate(resolved.id, newName, cfg);
  return Promise.resolve(ok
    ? { ok: true, message: `✅ 模板别名: ${oldName} → ${newName}` }
    : { ok: false, message: "", error: { code: "RENAME_FAILED", message: "重命名失败（别名重复或无效）" } });
}

function detachCommand(): Promise<CommandResult> {
  // 防御：不在 tmux 内直接返回，避免 detach-client 误伤调用方所在 client
  //（历史事故：测试/脚本继承 TMUX env 时 detach-client 把真实 client detach 掉）
  if (!process.env.TMUX) {
    return Promise.resolve({ ok: false, message: "", error: { code: "NOT_IN_TMUX", message: "不在 tmux 会话中" } });
  }
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("tmux", ["detach-client"], { encoding: "utf-8" });
  } catch {
    return Promise.resolve({ ok: false, message: "", error: { code: "TMUX_NOT_INSTALLED", message: "tmux 未安装或不在 PATH 中（brew install tmux）" } });
  }
  return Promise.resolve(r.status === 0
    ? { ok: true, message: "已脱离当前会话" }
    : { ok: false, message: "", error: { code: "NOT_IN_TMUX", message: "不在 tmux 会话中" } });
}

function helpCommand(): Promise<CommandResult> {
  return Promise.resolve({
    ok: true,
    message: [
      "可用命令:",
      "  pi [args]                    原生前台启动 pi（无 tmux，离开 TUI）",
      "  start <bg-name> <template>   启动后台会话",
      "  attach <name>                接入后台会话",
      "  switch <name>                切换会话（tmux 内）",
      "  detach                       脱离当前会话",
      "  stop <name>                  停止会话",
      "  ls                           列出后台会话",
      "  status                       健康检查",
      "  template ls|new|rm|rename    模板管理",
      "  shared status                共享层状态",
      "  hub submit|programs|run|dev  PTH 程序",
      "  tui dashboard|lab            打开 TUI 面板",
      "  flow …                       工作流管理",
      "  help                         此帮助",
      "  quit                         退出",
    ].join("\n"),
  });
}

// ─── 分发执行 ────────────────────────────────────────────────

export async function dispatchCommand(cmd: string, args: string[]): Promise<CommandResult> {
  const target = resolveDispatch(cmd, args);
  if (!target) {
    return { ok: false, message: "", error: { code: "UNKNOWN_COMMAND", message: `未知命令: ${cmd}。运行 help 查看可用命令` } };
  }
  if (target.kind === "handoff") {
    return { ok: true, message: "", handoff: { cmd: target.cmd, args: target.args } };
  }
  return await target.fn();
}