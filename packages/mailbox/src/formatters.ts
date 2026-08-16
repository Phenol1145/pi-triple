/**
 * mailbox/formatters.ts —— 通知格式化（模块专项 ② 大文件拆分：自 index.ts 抽出）。
 */
import fs from "node:fs";
import path from "node:path";
import { Presence } from "@away_from/shared";
import type { MailboxRegistryEntry } from "@away_from/shared";
import type { IntercomConfig } from "./delivery.js";
import type { PitMessage } from "./protocol.js";

// ── Helpers ──────────────────────────────────────────────────

export function loadIntercomConfig(): IntercomConfig {
  const config: IntercomConfig = { defaultMode: "manual" };
  const envConfigPath = process.env.PI_INTERCOM_CONFIG;
  if (envConfigPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(envConfigPath, "utf-8"));
      if (raw.intercom) Object.assign(config, raw.intercom);
    } catch { /* ignore */ }
    return config;
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (agentDir) {
    const searchPaths = [
      path.resolve(agentDir, "..", "..", "..", "pi-triple.json"),
      path.resolve(agentDir, "..", "..", "pi-triple.json"),
      path.resolve(agentDir, "..", "..", "..", "..", "pi-triple.json"),
      path.resolve("pi-triple.json"),
    ];
    for (const p of searchPaths) {
      try {
        if (fs.existsSync(p)) {
          const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (raw.intercom) Object.assign(config, raw.intercom);
          break;
        }
      } catch { /* try next */ }
    }
  }
  return config;
}

export function formatTimeAgo(timestamp: string): string {
  const delta = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function formatPendingMessages(msgs: PitMessage[]): string[] {
  if (msgs.length === 0) return ["  (inbox is empty)"];
  const lines: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const icon = m.type === "file" ? "📦" : m.priority === "urgent" ? "⚡" : "📨";
    const id = `#${i + 1}`;
    const preview = m.content.slice(0, 60) + (m.content.length > 60 ? "…" : "");
    const ago = formatTimeAgo(m.timestamp);
    const priority = m.priority !== "normal" ? ` \x1b[2m${m.priority}\x1b[0m` : "";
    lines.push(
      `  ${id}  ${icon} \x1b[1m${m.from.name}\x1b[0m  "${preview}"  ${ago}${priority}`,
    );
  }
  lines.push(`  /mail accept N · /mail reject N`);
  return lines;
}

export function formatSessionList(
  entries: MailboxRegistryEntry[],
  mailboxRoot: string,
  tenantId: string,
): string[] {
  if (entries.length === 0) return ["  (no sessions)"];
  const lines: string[] = [];
  for (const e of entries) {
    const statePath = path.join(mailboxRoot, tenantId, e.sessionId, "state.json");
    const state = Presence.read(statePath);
    const online = Presence.isOnline(statePath);
    const status = online ? (state?.status ?? "?") : "offline";
    const statusIcon = status === "busy" ? "\x1b[33m◐\x1b[0m" : status === "idle" ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
    const mode = state?.mode ?? "?";
    const model = state?.model ?? "?";
    const uptime = state ? formatTimeAgo(state.startedAt) : "-";
    const sessionId6 = e.sessionId.slice(0, 6);
    lines.push(
      `  ${statusIcon} \x1b[1m${e.name}\x1b[0m  pid:${e.pid}  ${mode}  ${model}  ${uptime}  ${sessionId6}`,
    );
  }
  return lines;
}

