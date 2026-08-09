/**
 * ptl/commands/session — ptl session 命令族（纸带操作，CLI/TUI 共享）
 *
 * 读侧（ls/show/tree/resume）直接读 session-store / pi-scan / pi-tree；
 * 写侧（fork/clone/transfer/branch）委托 operateSession → provider 能力分发。
 * 均为纯函数返回 CommandResult，由调用方决定渲染（print/json/TUI）。
 */
import type { CommandResult } from "../commands.js";
import { execStop } from "../commands.js";
import type { SessionRecord } from "../session/session-provider.js";
import {
  listAllSessions, resolveSession, operateSession,
} from "../session/session-store.js";
import { scanSessionFiles, listNodes } from "../session/pi-scan.js";
import { buildSessionTree } from "../session/pi-tree.js";
import { loadConfig, getTemplateAlias } from "@pi-triple/shared";

/** 解析 args 中的 --flag 与位置参数（--flag value；无值 → "true"） */
export function parseFlags(args: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; } else { flags[key] = "true"; }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

// ─── ls ─────────────────────────────────────────────────────

export async function execSessionLs(args: string[]): Promise<CommandResult> {
  const { flags } = parseFlags(args);
  const sessions = await listAllSessions();
  const filtered = sessions.filter((s) =>
    (!flags.template || s.templateAlias === flags.template || s.templateId === flags.template) &&
    (!flags.workloop || s.workloop === flags.workloop));
  if (flags.json === "true") {
    return { ok: true, message: "", data: { sessions: filtered } };
  }
  if (filtered.length === 0) {
    return { ok: true, message: "  无会话（纸带）。启动: ptl start --bg --name <name>", data: { sessions: filtered } };
  }
  const lines = filtered.map((s) =>
    `  ${s.status === "running" ? "●" : "○"} [${s.workloop}] ${s.id.slice(0, 8)}…  ${s.templateAlias}  ${s.summary}`);
  return { ok: true, message: lines.join("\n"), data: { sessions: filtered } };
}

// ─── show ───────────────────────────────────────────────────

export async function execSessionShow(id: string): Promise<CommandResult> {
  const r = await resolveSession(id);
  if (!r.ok) {
    return { ok: false, message: "", error: { code: r.reason === "ambiguous" ? "AMBIGUOUS" : "SESSION_NOT_FOUND", message: r.reason === "ambiguous" ? `会话 "${id}" 有多个匹配，请使用完整 UUID` : `会话 "${id}" 不存在（ptl session ls 查看）` } };
  }
  const rec = r.record;
  const detail = Object.entries(rec.detail).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return { ok: true, message: `  会话 ${rec.id}\n  状态: ${rec.summary}\n${detail}` };
}

// ─── fork / clone / transfer（委托 operateSession）────────────

export async function execSessionFork(id: string, args: string[]): Promise<CommandResult> {
  const { flags } = parseFlags(args);
  return operateSession("fork", id, { templateId: flags.template });
}

export async function execSessionClone(id: string, args: string[]): Promise<CommandResult> {
  const { flags } = parseFlags(args);
  return operateSession("clone", id, { templateId: flags.template });
}

export async function execSessionTransfer(id: string, args: string[]): Promise<CommandResult> {
  const { flags } = parseFlags(args);
  if (!flags.template) return { ok: false, message: "", error: { code: "USAGE", message: "用法: ptl session transfer <id> --template <tpl>" } };
  return operateSession("transfer", id, { templateId: flags.template });
}

// ─── branch（--at 必填；--list-nodes 列出可选节点）────────────

function listNodesFor(id: string): string | null {
  const cfg = loadConfig();
  const f = scanSessionFiles(cfg).find((x) => x.id === id);
  return f ? f.file : null;
}

export async function execSessionBranch(id: string, args: string[]): Promise<CommandResult> {
  const { flags } = parseFlags(args);
  if (!flags.at && flags["list-nodes"] !== "true") {
    return { ok: false, message: "", error: { code: "USAGE", message: "用法: ptl session branch <id> --at <nodeId> [--template <tpl>]\n  列出节点: ptl session branch <id> --list-nodes" } };
  }
  const r = await resolveSession(id);
  if (!r.ok) {
    return { ok: false, message: "", error: { code: r.reason === "ambiguous" ? "AMBIGUOUS" : "SESSION_NOT_FOUND", message: r.reason === "ambiguous" ? `会话 "${id}" 有多个匹配，请使用完整 UUID` : `会话 "${id}" 不存在` } };
  }
  const record = r.record;
  if (flags["list-nodes"] === "true") {
    const file = listNodesFor(record.id);
    if (!file) return { ok: false, message: "", error: { code: "NODE_NOT_FOUND", message: "无法读取会话节点" } };
    const nodes = listNodes(file);
    return { ok: true, message: nodes.map((n) => `  ${n.id}  ${n.summary}`).join("\n"), data: { nodes } };
  }
  return operateSession("branch", id, { at: flags.at, templateId: flags.template });
}

// ─── tree（谱系森林，按模板过滤）──────────────────────────────

export async function execSessionTree(args: string[]): Promise<CommandResult> {
  const { flags } = parseFlags(args);
  const cfg = loadConfig();
  let files = scanSessionFiles(cfg);
  if (flags.template) {
    files = files.filter((f) =>
      f.templateId === flags.template || getTemplateAlias(f.templateId, cfg) === flags.template);
  }
  if (files.length === 0) return { ok: true, message: "  无会话谱系（先 fork 产生分支）" };
  return { ok: true, message: buildSessionTree(files) };
}

// ─── resume（仅 pi 纸带会话可恢复）────────────────────────────

/** resume 前置校验（纯函数，可测）：非 pi → NOT_SUPPORTED；运行中 → ALREADY_RUNNING（防双写者） */
export function assertResumable(r: SessionRecord): CommandResult | null {
  if (r.workloop !== "pi") {
    return { ok: false, message: "", error: { code: "NOT_SUPPORTED", message: `会话类型（${r.workloop}）不支持 resume——只有纸带（pi 会话）可恢复` } };
  }
  if (r.status === "running") {
    return { ok: false, message: "", error: { code: "ALREADY_RUNNING", message: `会话 ${r.id.slice(0, 8)}… 正在运行，请直接接入：ptl attach <name>` } };
  }
  return null;
}

export async function execSessionResume(id: string, args: string[]): Promise<CommandResult> {
  const { flags } = parseFlags(args);
  const r = await resolveSession(id);
  if (!r.ok) {
    return { ok: false, message: "", error: { code: r.reason === "ambiguous" ? "AMBIGUOUS" : "SESSION_NOT_FOUND", message: r.reason === "ambiguous" ? `会话 "${id}" 有多个匹配，请使用完整 UUID` : `会话 "${id}" 不存在` } };
  }
  const rec = r.record;
  const guard = assertResumable(rec);
  if (guard) return guard;
  const cfg = loadConfig();
  const tpl = cfg.templates[rec.templateId] ?? {};
  const { buildPiLaunch } = await import("../launcher.js");
  // 会话 cwd 跟随纸带原 cwd（避免 pi 将纸带判为跨项目会话而弹 fork 询问）
  const { parseSessionHeader, scanSessionFiles } = await import("../session/pi-scan.js");
  let workspaceCwd: string | undefined;
  try {
    const f = scanSessionFiles(cfg).find((x) => x.id === rec.id);
    if (f) {
      const first = (await (await import("node:fs/promises")).readFile(f.file, "utf-8")).split("\n", 1)[0] ?? "";
      const h = parseSessionHeader(first);
      if (h?.cwd) workspaceCwd = h.cwd;
    }
  } catch { /* 读不到则用模板 workspace 兜底 */ }
  const launch = await buildPiLaunch(rec.templateId, {
    provider: tpl.provider, model: tpl.model, thinking: tpl.thinking, tools: tpl.tools, excludeTools: tpl.excludeTools,
    resumeSession: rec.id,
    ...(workspaceCwd ? { workspaceCwd } : {}),
  });
  const name = flags.name || `${getTemplateAlias(rec.templateId, cfg)}-${Date.now().toString(36)}`;
  const { startPtlSession, getPanePid } = await import("@pi-triple/shared");
  const { markStarted } = await import("@pi-triple/shared");
  const { resolveDataDir } = await import("@pi-triple/shared");
  const result = startPtlSession(launch, name, true);
  if (result.status === 0) {
    markStarted({
      name,
      templateId: rec.templateId,
      model: tpl.model, provider: tpl.provider, thinking: tpl.thinking,
      extraArgs: [],
      startedAt: Date.now(),
      pid: getPanePid(result.session),
      sessionId: rec.id, // 记录纸带 → restore 可精确恢复
    }, resolveDataDir(cfg));
    return { ok: true, message: `✅ 已后台恢复会话 ${rec.id.slice(0, 8)}…\n接入: ptl attach ${name}`, data: { name } };
  }
  return { ok: false, message: "", error: { code: "START_FAILED", message: `启动失败: ${result.stderr}` } };
}

// ─── attach / stop（委托共享命令层）────────────────────────────

export function execSessionAttach(name: string): CommandResult {
  if (!name) return { ok: false, message: "", error: { code: "USAGE", message: "用法: ptl session attach <name>" } };
  return { ok: true, message: "", handoff: { cmd: "ptl", args: ["attach", name] } };
}

export async function execSessionStop(idOrName: string): Promise<CommandResult> {
  if (!idOrName) return { ok: false, message: "", error: { code: "USAGE", message: "用法: ptl session stop <id|name>" } };
  // 会话名（ptl-<name>）或会话 id → 转 execStop
  return execStop(idOrName);
}
