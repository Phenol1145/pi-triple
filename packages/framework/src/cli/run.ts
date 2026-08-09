/**
 * ptl/run — ptl 主流程（由入口 ptl.ts 延迟加载：node:sqlite builtin 警告需先于
 * 本模块求值安装过滤，故主逻辑与入口分离）。
 */

import { parseArgs } from "./args.js";
import { printHelp, printBanner, getVersion, printGettingStarted, printCommandHelp, printNamespaceHelp } from "./main.js";
import { cmdOnboard } from "./onboard.js";
import { cmdPi, cmdStart, cmdAttach, cmdSwitch, cmdDetach, cmdRestore } from "./sessions.js";
import { cmdConfig } from "./config-cmd.js";
import { resolveMode, routeJsonCommand, doPrintCommand } from "./mode.js";
import { cmdMigrate, handleUpdate, handleInstallRemove, handleShared } from "./admin.js";
import { cmdTui, cmdHub, getDeprecatedMigration } from "./route.js";
import { cmdAgentRun, cmdAgentClean } from "./agent.js";
import { emitJsonError } from "@pi-triple/shared";
import { dispatchCommand } from "../commands/dispatch.js";
import { registerPiSessionProvider } from "../session/pi-provider.js";

// Re-export for test compatibility
export { parseArgs };
export { printBanner, printHelp, getVersion } from "./main.js";
export { resolveOrFail } from "./onboard.js";

// ─── Flow 路由 ────────────────────────────────────────────────


// ─── Session / Trace 路由（共享分发）──────────────────────────

/** 把 parseArgs 提取出的 flags 重新展平为 --flag [value] 参数（供 dispatch 的 parseFlags 消费） */
function flattenFlags(flags: Record<string, string>): string[] {
  return [
    ...Object.entries(flags).filter(([, v]) => v === "true" || v === "").map(([k]) => `--${k}`),
    ...Object.entries(flags).filter(([, v]) => v !== "true" && v !== "").flatMap(([k, v]) => [`--${k}`, v]),
  ];
}

async function routeSessionCommand(subcmd: string | undefined, args: string[], flags: Record<string, string>): Promise<void> {
  if (!subcmd && args.length === 0) {
    printNamespaceHelp("session");
    return;
  }
  const all = [subcmd ?? "ls", ...args, ...flattenFlags(flags)];
  const r = await dispatchCommand("session", all);
  doPrintCommand(r);
}

async function routeTraceCommand(subcmd: string | undefined, args: string[], flags: Record<string, string>): Promise<void> {
  if (!subcmd && args.length === 0) {
    printNamespaceHelp("trace");
    return;
  }
  const all = [subcmd ?? "ls", ...args, ...flattenFlags(flags)];
  const r = await dispatchCommand("trace", all);
  doPrintCommand(r);
}

// ─── Main ────────────────────────────────────────────────────

export async function main() {
  // 注册纸带/追踪 providers（CLI 启动；TUI 各自初始化时同样注册）
  registerPiSessionProvider();
    
  const args = process.argv.slice(2);
  let command: string;
  let subcommand: string | undefined;
  let flags: Record<string, string>;
  let passthrough: string[];

  try {
    const parsed = parseArgs(args);
    command = parsed.command;
    subcommand = parsed.subcommand;
    flags = parsed.flags;
    passthrough = parsed.passthrough;
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 参数错误: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  // 启动更新提示（只读缓存，零网络；仅交互启动类命令）
  if (command === "start" || command === "pi") {
    try { (await import("../version.js")).maybePrintUpdateHint(); } catch { /* 静默 */ }
  }

  // --help 全局处理：ptl --help → 全量；ptl <cmd> --help → 单命令
  if (flags.help === "true") {
    if (command) printCommandHelp(command);
    else printHelp();
    return;
  }

  // --version 全局处理：parseArgs 将 --version 解析为 flag（command 为空），在此提前输出版本号
  if (flags.version === "true") {
    console.log(`ptl v${getVersion()}`);
    return;
  }

  const mode = resolveMode(command, flags);

  if (mode === "json") {
    const routed = await routeJsonCommand(command, subcommand, flags, passthrough);
    if (routed) return;
    emitJsonError("UNSUPPORTED_JSON", `命令 "${command || "(无)"}" 不支持 --json`);
    process.exit(1);
  }

  switch (command) {
    case "onboard":
      await cmdOnboard(flags);
      break;
    case "pi":
      await cmdPi(flags, passthrough);
      break;
    case "start":
      await cmdStart(flags, passthrough);
      break;
    case "restore":
      await cmdRestore(flags, passthrough);
      break;
    case "attach":
      cmdAttach(subcommand || passthrough[0] || "");
      break;
    case "switch":
      cmdSwitch(passthrough[0] || "");
      break;
    case "detach":
      cmdDetach();
      break;
    case "ls": {
      const lr = await dispatchCommand("ls", []);
      printBanner();
      if (lr.ok) console.log(lr.message);
      else console.log(`  \x1b[31m❌ ${lr.error?.message ?? "Unknown error"}\x1b[0m`);
      console.log("");
      break;
    }
    case "stop": {
      const sr = await dispatchCommand("stop", [subcommand || passthrough[0] || "", ...flattenFlags(flags)]);
      if (sr.ok) console.log(sr.message);
      else console.log(`  \x1b[31m❌ ${sr.error?.message}\x1b[0m`);
      if (!sr.ok) process.exit(1);
      break;
    }
    case "status": {
      const sr = await dispatchCommand("status", []);
      printBanner();
      if (sr.ok) console.log(sr.message);
      else console.log(`  \x1b[31m❌ ${sr.error?.message ?? "Unknown error"}\x1b[0m`);
      console.log("");
      if (!sr.ok) process.exit(1);
      break;
    }
    case "doctor":
      await (await import("../doctor.js")).runDoctor("full");
      break;
    case "template": {
      const tr = await dispatchCommand("template", subcommand ? [subcommand, ...passthrough] : passthrough);
      doPrintCommand(tr);
      break;
    }
    case "env": {
      // 仅 extension-copy/skill-copy 需要把 VALUED_FLAGS（--from/--mode）展平回 dispatch 参数；
      // 其余 env 子命令不 flatten——否则被 VALUED_FLAGS 吞掉的 flag（--model 等）会被
      // 重新塞回 dispatch，parseEnvPatch 的"bare 两参"分支把 --model 当字段 → 绕过
      // execEnvSet 空 patch 防御，报误导性的 "不可写字段: --model"（Finding #1 回归）。
      const copySub = subcommand === "extension-copy" || subcommand === "skill-copy";
      const er = await dispatchCommand("env", subcommand ? [subcommand, ...passthrough, ...(copySub ? flattenFlags(flags) : [])] : passthrough);
      doPrintCommand(er);
      break;
    }
    case "update":
      await handleUpdate(flags);
      break;
    case "install":
    case "remove":
    case "uninstall":
      handleInstallRemove(command, flags, subcommand, passthrough);
      break;
    case "shared":
      if (subcommand === "status") {
        const sr = await dispatchCommand("shared", ["status"]);
        printBanner();
        if (sr.ok) console.log(sr.message);
        else console.log(`  \x1b[31m❌ ${sr.error?.message ?? "Unknown error"}\x1b[0m`);
        console.log("");
        if (!sr.ok) process.exit(1);
      } else {
        await handleShared(subcommand);
      }
      break;
    case "migrate":
      await cmdMigrate(flags);
      break;
    case "config":
      cmdConfig(subcommand, passthrough);
      break;
    case "hub":
      await cmdHub(subcommand, passthrough, flags);
      break;
    case "ui":
    case "lab":
    case "submit":
    case "run":
    case "programs":
    case "dev": {
      const msg = getDeprecatedMigration(command);
      console.log(`  \x1b[33m⚠️  ptl ${command} ${msg}\x1b[0m`);
      process.exit(1);
    }
    case "session":
      await routeSessionCommand(subcommand, passthrough, flags);
      break;
    case "trace":
      await routeTraceCommand(subcommand, passthrough, flags);
      break;
    case "agent":
      if (subcommand === "run") await cmdAgentRun(flags, passthrough);
      else if (subcommand === "clean") cmdAgentClean(flags, passthrough);
      else { console.log("  用法: ptl agent run|clean ..."); console.log("  ptl agent run <template> <task> [--workspace temp|main]"); console.log("  ptl agent clean <agentId>"); }
      break;
    case "help":
    case "-h":
      if (passthrough[0]) printCommandHelp(passthrough[0]);
      else printHelp();
      break;
    case "":
      printGettingStarted();
      break;
    case "tui":
      await cmdTui(subcommand, flags);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(`ptl v${getVersion()}`);
      break;
    default:
      console.log(`  未知命令: ${command}`);
      console.log("  运行 ptl help 查看帮助");
      process.exit(1);
  }
}

