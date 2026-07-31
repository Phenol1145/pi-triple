/**
 * pit/mode — mode resolution + JSON routing + print dispatch
 */

import { emitJson, emitJsonError } from "../output.js";
import {
  execTemplateLs, execTemplateNew, execTemplateRm,
  execStatus, execLs, execStop, execSharedStatus,
} from "../commands.js";
import { FlowStore } from "../flow/store.js";
import { printBanner } from "./main.js";
import { cmdAgentRun, cmdAgentClean } from "./agent.js";
import { PthClient } from "../bridge/client.js";

type PitMode = "print" | "json" | "fatal";

export function resolveMode(command: string, flags: Record<string, string>): PitMode {
  if (flags.json === "true") return "json";
  return "print";
}

/** 表驱动 JSON 路由 */
const JSON_ROUTERS: Record<string, (sub: string | undefined, passthrough: string[]) => Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }>> = {
  template: async (sub, passthrough) => {
    if (sub === "ls" || sub === "list") return await execTemplateLs();
    if (sub === "new") return await execTemplateNew(passthrough[0]);
    if (sub === "rm") return await execTemplateRm(passthrough[0] || "");
    return await execTemplateLs();
  },
  status: async () => await execStatus(),
  doctor: async () => await execStatus(),
  ls: async () => await execLs(),
  stop: async (sub, passthrough) => await execStop(sub || passthrough[0] || ""),
  shared: async (sub) => {
    if (sub === "status") return await execSharedStatus();
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "共享层子命令不支持 --json" } };
  },
  flow: async (sub) => {
    if (sub === "ls") {
      const s = new FlowStore();
      const runs = s.listRuns();
      return { ok: true, data: { runs: runs.map((r) => ({ runId: r.runId, name: r.name, status: r.status, stepCount: r.stepCount, createdAt: r.createdAt })) } };
    }
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "flow 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
  agent: async (sub, passthrough) => {
    if (sub === "run") { await cmdAgentRun({}, passthrough); return { ok: true }; }
    if (sub === "clean") { cmdAgentClean({}, passthrough); return { ok: true }; }
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "agent 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
  hub: async (sub) => {
    if (sub === "programs") {
      const client = PthClient.fromConfig();
      if (!client) return { ok: false, error: { code: "NOT_CONFIGURED", message: "未配置 PTH 连接（pit config set pth.url/pth.token）" } };
      try {
        const programs = await client.list();
        return { ok: true, data: { programs } };
      } catch (err: any) {
        return { ok: false, error: { code: "PTH_UNREACHABLE", message: err?.message ?? String(err) } };
      }
    }
    return { ok: false, error: { code: "UNSUPPORTED_JSON", message: "hub 子命令 " + (sub ?? "(无)") + " 不支持 --json" } };
  },
};

export async function routeJsonCommand(command: string, subcommand: string | undefined, _flags: Record<string, string>, passthrough: string[]): Promise<boolean> {
  const router = JSON_ROUTERS[command];
  if (!router) return false;

  const result = await router(subcommand, passthrough);

  if (result.ok) {
    emitJson(result.data ?? {});
  } else {
    emitJsonError(result.error?.code ?? "UNKNOWN", result.error?.message ?? "Unknown error");
    process.exit(1);
  }
  return true;
}

export function doPrintCommand(result: Awaited<ReturnType<typeof execTemplateLs>>): void {
  printBanner();
  if (result.ok) {
    console.log(result.message);
  } else {
    console.log(`  \x1b[31m❌ ${result.error?.message ?? "Unknown error"}\x1b[0m`);
  }
  console.log("");
  if (!result.ok) process.exit(1);
}
