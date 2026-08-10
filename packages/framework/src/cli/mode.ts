/**
 * ptl/mode — mode resolution + JSON routing + print dispatch
 */

import { emitJson, emitJsonError } from "@away_from/shared";
import {
  execTemplateLs, execTemplateNew, execTemplateRm,
  execStatus, execLs, execStop, execSharedStatus,
  type CommandResult,
} from "../commands.js";
import { printBanner } from "./main.js";
import { cmdAgentRun, cmdAgentClean } from "./agent.js";
import { PthClient } from "../bridge/client.js";
import { execSessionLs } from "../commands/session.js";
import { execTraceLs } from "../commands/trace.js";
import { execEnvCreate, execEnvList, execEnvShow, execEnvSet, execEnvRm, execEnvFork, parseEnvPatch } from "../env.js";
import { execExtensionCopy, execSkillCopy } from "../extension-copy.js";

type PtlMode = "print" | "json";

export function resolveMode(command: string, flags: Record<string, string>): PtlMode {
  if (flags.json === "true") return "json";
  return "print";
}

type JsonRouter = (sub: string | undefined, passthrough: string[], flags: Record<string, string>) => Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }>;

/** 表驱动 JSON 路由（router 只取自己需要的 flags） */
const JSON_ROUTERS: Record<string, JsonRouter> = {
  template: async (sub, passthrough) => {
    if (sub === "ls" || sub === "list") return await execTemplateLs();
    if (sub === "new") return await execTemplateNew(passthrough[0]);
    if (sub === "rm") return await execTemplateRm(passthrough[0] || "");
    return await execTemplateLs();
  },
  env: async (sub, passthrough, flags) => {
    if (sub === "ls" || sub === "list" || sub === "") return await execEnvList();
    if (sub === "create") return await execEnvCreate(passthrough[0] ?? "", {});
    // fork 两位置参数（新别名+源别名）都在 passthrough（parseArgs 不吞非 VALUED_FLAGS 位置参数）
    if (sub === "fork") return await execEnvFork(passthrough[0] ?? "", passthrough[1] ?? "");
    if (sub === "show") return await execEnvShow(passthrough[0] ?? "");
    if (sub === "set") return await execEnvSet(passthrough[0] ?? "", parseEnvPatch(passthrough.slice(1)));
    if (sub === "rm") return await execEnvRm(passthrough[0] ?? "");
    if (sub === "extension-copy") return await execExtensionCopy(passthrough[0] ?? "", { from: flags.from, mode: flags.mode });
    if (sub === "skill-copy") return await execSkillCopy(passthrough[0] ?? "", { from: flags.from, mode: flags.mode });
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "env 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
  status: async () => await execStatus(),
  doctor: async () => await execStatus(),
  ls: async () => await execLs(),
  stop: async (sub, passthrough, flags) => await execStop(sub || passthrough[0] || "", flags),
  shared: async (sub) => {
    if (sub === "status") return await execSharedStatus();
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "共享层子命令不支持 --json" } };
  },
  agent: async (sub, passthrough) => {
    if (sub === "run") { await cmdAgentRun({}, passthrough); return { ok: true }; }
    if (sub === "clean") { cmdAgentClean({}, passthrough); return { ok: true }; }
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "agent 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
  hub: async (sub) => {
    if (sub === "programs") {
      const client = PthClient.fromConfig();
      if (!client) return { ok: false, error: { code: "NOT_CONFIGURED", message: "未配置 PTH 连接（ptl config set pth.url/pth.token）" } };
      try {
        const programs = await client.list();
        return { ok: true, data: { programs } };
      } catch (err: any) {
        return { ok: false, error: { code: "PTH_UNREACHABLE", message: err?.message ?? String(err) } };
      }
    }
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "hub 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
  session: async (sub) => {
    if (sub === "ls" || sub === "") return execSessionLs(["--json"]);
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "session 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
  trace: async (sub) => {
    if (sub === "ls" || sub === "") return execTraceLs(["--json"]);
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "trace 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
};

export async function routeJsonCommand(command: string, subcommand: string | undefined, flags: Record<string, string>, passthrough: string[]): Promise<boolean> {
  const router = JSON_ROUTERS[command];
  if (!router) return false;

  const result = await router(subcommand, passthrough, flags);

  if (result.ok) {
    emitJson(result.data ?? {});
  } else {
    emitJsonError(result.error?.code ?? "UNKNOWN", result.error?.message ?? "Unknown error");
    process.exit(1);
  }
  return true;
}

export function doPrintCommand(result: CommandResult): void {
  printBanner();
  if (result.ok) {
    console.log(result.message);
  } else {
    console.log(`  \x1b[31m❌ ${result.error?.message ?? "Unknown error"}\x1b[0m`);
  }
  console.log("");
  if (!result.ok) process.exit(1);
}
