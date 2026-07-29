#!/usr/bin/env node
/**
 * pit — Pi-Triple 统一 CLI (PTL)
 *
 * 租户使用 UUID + alias 模式。
 * 所有路径用 UUID，用户交互用 alias。
 */

import { parseArgs } from "./pit/args.js";
import { printHelp, printBanner } from "./pit/main.js";
import { cmdOnboard } from "./pit/onboard.js";
import { cmdPi, cmdStart, cmdAttach, cmdSwitch, cmdDetach } from "./pit/sessions.js";
import { cmdConfig } from "./pit/config-cmd.js";
import { resolveMode, routeJsonCommand, doPrintCommand } from "./pit/mode.js";
import { cmdMigrate, handleTenantRename, handleUpdate, handleInstallRemove, handleShared } from "./pit/admin.js";
import { cmdSubmit } from "./bridge/submit.js";
import { cmdRun } from "./bridge/run.js";
import { cmdPrograms } from "./bridge/programs.js";
import { cmdDev } from "./bridge/dev.js";
import {
  cmdFlowRun, cmdFlowStatus, cmdFlowShow, cmdFlowLs,
  cmdFlowApprove, cmdFlowReject, cmdFlowResume,
  cmdFlowPropose, cmdFlowDiscard,
  cmdFlowEdit, cmdFlowSet, cmdFlowGraph, cmdFlowRm, cmdFlowValidate,
} from "./flow/commands.js";
import { emitJsonError } from "./output.js";
import path from "node:path";
import {
  loadConfig, resolveTenantId, getTenantAlias, getDefaultTenantId, pitHome,
} from "./config.js";
import {
  execTenantLs, execTenantNew, execTenantRm,
  execStatus, execLs, execStop,
} from "./commands.js";

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

  const mode = resolveMode(command, flags);
  if (mode === "fatal") { process.exit(1); return; }

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
      const lr = await execLs();
      printBanner();
      console.log(lr.message);
      console.log("");
      break;
    }
    case "stop": {
      const sr = await execStop(subcommand || passthrough[0] || "");
      if (sr.ok) console.log(sr.message);
      else console.log(`  \x1b[31m❌ ${sr.error?.message}\x1b[0m`);
      if (!sr.ok) process.exit(1);
      break;
    }
    case "status": {
      const sr = await execStatus();
      printBanner();
      console.log(sr.message);
      console.log("");
      if (!sr.ok) process.exit(1);
      break;
    }
    case "doctor":
      await (await import("./doctor.js")).runDoctor("full");
      break;
    case "tenant": {
      let tr;
      if (subcommand === "ls" || subcommand === "list") tr = await execTenantLs();
      else if (subcommand === "new") tr = await execTenantNew(passthrough[0]);
      else if (subcommand === "rm") tr = await execTenantRm(passthrough[0] || "");
      else if (subcommand === "rename") { handleTenantRename(passthrough); break; }
      else tr = await execTenantLs();
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
      await handleShared(subcommand);
      break;
    case "migrate":
      await cmdMigrate(flags);
      break;
    case "config":
      cmdConfig(subcommand, passthrough);
      break;
    case "submit":
      await cmdSubmit(passthrough, flags);
      break;
    case "run":
      await cmdRun(subcommand || passthrough[0] || "", passthrough.slice(1), flags);
      break;
    case "programs":
      await cmdPrograms(flags);
      break;
    case "dev":
      await cmdDev(passthrough[0] || "", passthrough.slice(1), flags);
      break;
    case "flow":
      await routeFlowCommand(subcommand, passthrough, flags);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "":
    case "ui":
      if (process.stdout.isTTY && process.stdin.isTTY) {
        const { render } = await import("ink");
        const React = (await import("react")).default;
        const { PitApp } = await import("./tui-pit/app.js");
        render(React.createElement(PitApp), { exitOnCtrlC: false });
      } else {
        printHelp();
      }
      break;
    case "lab":
      if (process.stdout.isTTY && process.stdin.isTTY) {
        const { render } = await import("ink");
        const React = (await import("react")).default;
        const { LabApp } = await import("./tui-lab/app.js");
        const cfg = loadConfig();
        const labResolved = flags.tenant ? resolveTenantId(flags.tenant, cfg) : null;
        if (flags.tenant && (!labResolved || !labResolved.ok)) {
          const reason = labResolved && !labResolved.ok ? labResolved.reason : "not_found";
          if (reason === "ambiguous" && labResolved && !labResolved.ok && "candidates" in labResolved) {
            const candidates = labResolved.candidates.map((c) => `${getTenantAlias(c, cfg)} (${c.slice(0, 8)}…)`).join(", ");
            console.log(`\x1b[31m❌ "${flags.tenant}" 匹配多个租户: ${candidates}\x1b[0m`);
          } else {
            console.log(`\x1b[31m❌ 未知租户: "${flags.tenant}"\x1b[0m`);
          }
          console.log("  运行 \x1b[36mpit tenant ls\x1b[0m 查看可用租户\n");
          process.exit(1);
        }
        const labTenantId = labResolved?.ok ? labResolved.id : getDefaultTenantId(cfg);
        const labAlias = getTenantAlias(labTenantId, cfg);
        const labGlobal = flags.global === "true";
        // 注入 per-tenant AGENT_LAB_* env，确保 lab-data 解析到该租户数据（与 buildPiLaunch 一致）
        const labHome = pitHome();
        if (labGlobal) {
          // --global：只用共享遥测 DB
          process.env.AGENT_LAB_DB_PATH = path.join(labHome, "data", "shared", "agent-lab", "agent-lab.db");
        } else {
          process.env.AGENT_LAB_CONFIG_DIR = path.join(labHome, "data", "pi-config", labTenantId, "agent-lab");
          process.env.AGENT_LAB_DB_PATH = path.join(labHome, "data", "shared", "agent-lab", "agent-lab.db");
        }
        render(React.createElement(LabApp, { tenantId: labTenantId, tenantAlias: labAlias, globalTelemetry: labGlobal }), { exitOnCtrlC: false });
      } else {
        console.log("  lab TUI 需要交互式终端");
      }
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
