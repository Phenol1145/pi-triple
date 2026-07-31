#!/usr/bin/env node
/**
 * pit — Pi-Triple 统一 CLI (PTL)
 *
 * 模板使用 UUID + alias 模式。
 * 所有路径用 UUID，用户交互用 alias。
 */

import { parseArgs } from "./pit/args.js";
import { printHelp, printBanner, printGettingStarted, printCommandHelp } from "./pit/main.js";
import { cmdOnboard } from "./pit/onboard.js";
import { cmdPi, cmdStart, cmdAttach, cmdSwitch, cmdDetach } from "./pit/sessions.js";
import { cmdConfig } from "./pit/config-cmd.js";
import { resolveMode, routeJsonCommand, doPrintCommand } from "./pit/mode.js";
import { cmdMigrate, handleUpdate, handleInstallRemove, handleShared } from "./pit/admin.js";
import { cmdTui, cmdHub, getDeprecatedMigration } from "./pit/route.js";
import {
  cmdFlowRun, cmdFlowStatus, cmdFlowShow, cmdFlowLs,
  cmdFlowApprove, cmdFlowReject, cmdFlowResume,
  cmdFlowPropose, cmdFlowDiscard,
  cmdFlowEdit, cmdFlowSet, cmdFlowGraph, cmdFlowRm, cmdFlowValidate,
} from "./flow/commands.js";
import { cmdAgentRun, cmdAgentClean } from "./pit/agent.js";
import { emitJsonError } from "./output.js";
import { dispatchCommand } from "./commands/dispatch.js";

// Re-export for test compatibility
export { parseArgs };
export { printBanner, printHelp, getVersion } from "./pit/main.js";
export { resolveOrFail } from "./pit/onboard.js";

// ─── Flow 路由 ────────────────────────────────────────────────

async function routeFlowCommand(subcmd: string | undefined, args: string[], flags: Record<string, string>): Promise<void> {
  switch (subcmd) {
    case "run":
      await cmdFlowRun(args[0] ?? "", args.slice(1));
      break;
    case "status":
      await cmdFlowStatus(args[0] ?? "");
      break;
    case "show":
      await cmdFlowShow(args[0] ?? "");
      break;
    case "ls":
      await cmdFlowLs(flags.json === "true");
      break;
    case "approve":
      await cmdFlowApprove(args[0] ?? "", args.slice(1).join(" "));
      break;
    case "reject":
      await cmdFlowReject(args[0] ?? "", args.slice(1).join(" "));
      break;
    case "resume":
      await cmdFlowResume(args[0] ?? "");
      break;
    case "edit":
      await cmdFlowEdit(args[0] ?? "");
      break;
    case "set":
      await cmdFlowSet(args[0] ?? "", args[1] ?? "", args[2] ?? "");
      break;
    case "graph":
      cmdFlowGraph(args[0] ?? "");
      break;
    case "rm":
      cmdFlowRm(args[0] ?? "");
      break;
    case "validate":
      cmdFlowValidate(args[0] ?? "");
      break;
    case "propose":
      await cmdFlowPropose(args[0] ?? "");
      break;
    case "discard":
      await cmdFlowDiscard(args[0] ?? "");
      break;
    default:
      console.log("");
      console.log("  \x1b[36m\x1b[1mpit flow\x1b[0m  \x1b[2m— PTL Agents Workflow\x1b[0m");
      console.log("");
      console.log("  命令:");
      console.log("    flow run <flow.json> [k=v...]      启动工作流");
      console.log("    flow status <runId>                运行状态");
      console.log("    flow show <runId>                  完整输出 + state");
      console.log("    flow ls [--json]                    列出全部");
      console.log("    flow approve <runId> [备注]        人工审批通过");
      console.log("    flow reject <runId> [备注]          人工驳回");
      console.log("    flow resume <runId>                继续暂停/失败的任务");
      console.log("    flow propose <runId>              申请热修改（停波）");
      console.log("    flow discard <runId>              放弃修改申请");
      console.log("    flow edit <runId>                  编辑图定义");
      console.log("    flow set <runId> <path> <value>    修改图/状态");
      console.log("    flow graph <runId>                 查看图 + 修改历史");
      console.log("    flow rm <runId>                    删除");
      console.log("    flow validate <flow.json>           校验定义");
      console.log("");
      break;
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
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

  // --help 全局处理：pit --help → 全量；pit <cmd> --help → 单命令
  if (flags.help === "true") {
    if (command) printCommandHelp(command);
    else printHelp();
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
      const sr = await dispatchCommand("stop", [subcommand || passthrough[0] || ""]);
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
      await (await import("./doctor.js")).runDoctor("full");
      break;
    case "template": {
      const tr = await dispatchCommand("template", subcommand ? [subcommand, ...passthrough] : passthrough);
      doPrintCommand(tr);
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
      console.log(`  \x1b[33m⚠️  pit ${command} ${msg}\x1b[0m`);
      process.exit(1);
    }
    case "flow":
      await routeFlowCommand(subcommand, passthrough, flags);
      break;
    case "agent":
      if (subcommand === "run") await cmdAgentRun(flags, passthrough);
      else if (subcommand === "clean") cmdAgentClean(flags, passthrough);
      else { console.log("  用法: pit agent run|clean ..."); console.log("  pit agent run <template> <task> [--workspace temp|main]"); console.log("  pit agent clean <agentId>"); }
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
      console.log(`pit v0.1.0`);
      break;
    default:
      console.log(`  未知命令: ${command}`);
      console.log("  运行 pit help 查看帮助");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
