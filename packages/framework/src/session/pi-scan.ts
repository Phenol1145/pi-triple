// pi-scan.ts — Pi 纸带会话读侧：扫描 JSONL 会话文件 + 合并 tmux 运行态
import fs from "node:fs";
import path from "node:path";
import type { SessionRecord } from "./session-provider.js";
import { getSessionBackend, formatAge, type PtlSession, type PtlPaneInfo } from "@away_from/shared";
import { classifySession } from "@away_from/shared";
import { pitHome, loadConfig } from "@away_from/shared";

export interface PiSessionFile {
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  file: string;
  templateId: string;
  lineCount: number;
  modified: number;
}

export function parseSessionHeader(line: string): { id: string; timestamp: string; cwd: string; parentSession?: string } | null {
  try {
    const h = JSON.parse(line) as { type?: string; id?: unknown; timestamp?: unknown; cwd?: unknown; parentSession?: unknown };
    if (h.type !== "session" || typeof h.id !== "string" || typeof h.timestamp !== "string" || typeof h.cwd !== "string") return null;
    return { id: h.id, timestamp: h.timestamp, cwd: h.cwd, parentSession: typeof h.parentSession === "string" ? h.parentSession : undefined };
  } catch {
    return null;
  }
}

export function scanSessionFiles(dataDirOrConfig: string | { dataDir: string }): PiSessionFile[] {
  const dataDir = typeof dataDirOrConfig === "string" ? dataDirOrConfig : dataDirOrConfig.dataDir;
  const sessionsRoot = path.join(dataDir, "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];
  const out: PiSessionFile[] = [];
  for (const templateId of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!templateId.isDirectory()) continue;
    const dir = path.join(sessionsRoot, templateId.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      try {
        const stat = fs.statSync(file);
        const first = fs.readFileSync(file, "utf-8").split("\n", 1)[0] ?? "";
        const h = parseSessionHeader(first);
        if (!h) continue;
        let lineCount = 1;
        try { lineCount = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).length; } catch { /* ignore */ }
        out.push({ id: h.id, timestamp: h.timestamp, cwd: h.cwd, parentSession: h.parentSession, file, templateId: templateId.name, lineCount, modified: stat.mtimeMs });
      } catch {
        continue; // 坏文件跳过（容忍）
      }
    }
  }
  return out;
}

/** 合并终端复用器运行态 → SessionRecord 列表（backend 收敛——前缀进实现） */
export async function toSessionRecords(files: PiSessionFile[]): Promise<SessionRecord[]> {
  const backend = await getSessionBackend();
  const running = new Map(backend.list().map((s) => [backend.sessionName(s.name), s]));
  const panes = backend.available() ? backend.panesDetailed() : new Map<string, PtlPaneInfo>();
  const sessName = (id: string): string => backend.sessionName(id.slice(0, 8));
  const aliases: Record<string, string> = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(pitHome(), "pi-triple.json"), "utf-8"));
    for (const [id, t] of Object.entries(cfg.templates ?? {})) aliases[id] = (t as any).alias ?? id;
  } catch { /* 无配置时用 templateId 兜底 */ }

  return files.map((f) => {
    const tmuxName = [...panes.keys()].find((n) => n === sessName(f.id) || panes.get(n)?.currentCommand?.includes(f.id));
    const sess = tmuxName ? running.get(tmuxName) : undefined;
    const pane = tmuxName ? panes.get(tmuxName) : undefined;
    // 纸带视图无注册表参与：running 仅当 tmux 在且 pane pid 存活（空壳 → 停止）
    const live = sess
      ? { exists: true, pid: pane?.pid ?? undefined, currentCommand: pane?.currentCommand }
      : { exists: false };
    const cls = classifySession(live, null);
    const status: "running" | "stopped" = cls === "running" ? "running" : "stopped";
    const detail: Record<string, string> = {
      "模板": aliases[f.templateId] ?? f.templateId,
      "创建": f.timestamp,
      "cwd": f.cwd,
      "事件数": String(f.lineCount - 1),
      "谱系": f.parentSession ? f.parentSession : "(root)",
    };
    if (sess) {
      detail["前端占用"] = String(sess.attached ?? 0);
      detail["空闲"] = sess.activityAgeMs != null ? formatAge(sess.activityAgeMs) : "n/a";
      detail["运行命令"] = (pane?.currentCommand ?? "").slice(0, 120) || "n/a";
    }
    const summary = `${status === "running" ? "● 运行中" : "○ 停止"} · ${f.lineCount - 1} 事件${sess?.attached ? ` · 前端${sess.attached}` : ""}`;
    return {
      id: f.id,
      kind: "session" as const,
      workloop: "pi",
      templateId: f.templateId,
      templateAlias: aliases[f.templateId] ?? f.templateId,
      status,
      timestamp: f.timestamp,
      summary,
      detail,
    };
  });
}

/** 纸带 id 是否正被运行中的 pi 写入（复用器会话名含 id8 或当前命令含完整 id） */
export async function isTapeLive(id: string, panes?: Map<string, PtlPaneInfo>): Promise<boolean> {
  const backend = await getSessionBackend();
  const paneMap = panes ?? (backend.available() ? backend.panesDetailed() : new Map<string, PtlPaneInfo>());
  return [...paneMap.keys()].some((n) => n === backend.sessionName(id.slice(0, 8)) || paneMap.get(n)?.currentCommand?.includes(id));
}

/** 模板内 sinceMs 之后修改过的最新纸带 id（fresh 启动后探测本会话的 tape） */
export function newestTapeId(templateId: string, sinceMs: number, files: PiSessionFile[] = scanSessionFiles(loadConfig())): string | undefined {
  return files
    .filter((f) => f.templateId === templateId && f.modified >= sinceMs)
    .sort((a, b) => b.modified - a.modified)[0]?.id;
}

/** restore 纸带选择：注册表 sessionId 优先（存在且未被占用）→ 模板最新 → 无 */
export async function pickRestoreTape(
  files: PiSessionFile[],
  entry: { templateId: string; sessionId?: string },
  isLive: (id: string) => boolean | Promise<boolean>,
): Promise<{ resumeSession?: string; warning?: string }> {
  const tplFiles = files.filter((f) => f.templateId === entry.templateId);
  if (entry.sessionId) {
    if (tplFiles.some((f) => f.id === entry.sessionId)) {
      if (await isLive(entry.sessionId)) {
        return { warning: `纸带 ${entry.sessionId.slice(0, 8)}… 正在其他会话运行，本次全新启动` };
      }
      return { resumeSession: entry.sessionId };
    }
  }
  const latest = [...tplFiles].sort((a, b) => b.modified - a.modified)[0];
  if (!latest) return {};
  if (isLive(latest.id)) return { warning: `模板最新纸带 ${latest.id.slice(0, 8)}… 正在运行，本次全新启动` };
  return { resumeSession: latest.id };
}

/** 事件节点列表（branch 选择用） */
export function listNodes(file: string): { id: string; summary: string }[] {
  try {
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").slice(1);
    const nodes: { id: string; summary: string }[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { type?: string; id?: unknown; parentId?: unknown; timestamp?: string; message?: { role?: string; content?: unknown }; provider?: string; modelId?: string };
        if (typeof e.id !== "string" || e.type === "label" || e.type === "custom") continue;
        const ts = (e.timestamp ?? "").slice(11, 19);
        let summary = e.type ?? "";
        if (e.type === "message") {
          const role = e.message?.role ?? "?";
          let text = "";
          const c = e.message?.content;
          if (typeof c === "string") text = c;
          else if (Array.isArray(c)) text = c.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join(" ").trim();
          summary = `${role}: ${text.slice(0, 40)}`;
        } else if (e.type === "model_change") {
          summary = `model → ${e.provider ?? ""}/${e.modelId ?? ""}`;
        } else if (e.type === "compaction") {
          summary = "compaction";
        } else if (e.type === "branch_summary") {
          summary = "branch summary";
        } else if (e.type === "session_info") {
          summary = "session name";
        }
        nodes.push({ id: e.id, summary: `${ts} ${summary}` });
      } catch { /* 坏行跳过 */ }
    }
    return nodes;
  } catch {
    return [];
  }
}
