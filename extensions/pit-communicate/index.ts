/**
 * Pi-Triple Intercom — pit-communicate extension
 *
 * 注册 /pit 命令，提供跨会话通信：
 *   send/ask/share/broadcast  — 发送
 *   inbox/accept/reject       — 收件
 *   ps/mode/name/status       — 管理
 *
 * 人始终是网关：默认 manual 模式只通知人；auto 模式自动注入 LLM。
 */

import fs from "node:fs";
import path from "node:path";
import { Mailbox } from "./mailbox.js";
import { Presence } from "../_shared/presence.js";
import type { SessionState } from "../_shared/presence.js";
import { Registry } from "../_shared/registry.js";
import type { RegistryEntry } from "../_shared/registry.js";
import { Delivery } from "./delivery.js";
import type { IntercomConfig, ReviewMode } from "./delivery.js";
import { Watcher } from "./watcher.js";
import type { WatcherSideEffects } from "./watcher.js";
import { Audit } from "./audit.js";
import { createMessage } from "./protocol.js";
import type { PitMessage } from "./protocol.js";
import { resolveMailboxRoot, resolveTenantId } from "../_shared/paths.js";

// ── Helpers ──────────────────────────────────────────────────

function loadIntercomConfig(): IntercomConfig {
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

function formatTimeAgo(timestamp: string): string {
  const delta = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function formatPendingMessages(msgs: PitMessage[]): string[] {
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
  lines.push(`  /pit accept N · /pit reject N`);
  return lines;
}

function formatSessionList(
  entries: RegistryEntry[],
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

// ── Extension Factory ────────────────────────────────────────

export default function pitMail(api: any /* ExtensionAPI */) {
  const tenantId = resolveTenantId();
  const sessionId = process.env.PI_SESSION_ID ?? `pit-${process.pid}`;
  const mailboxRoot = resolveMailboxRoot();
  const intercomConfig = loadIntercomConfig();

  // ── Modules ──────────────────────────────────────────────
  const mailbox = new Mailbox(mailboxRoot, tenantId, sessionId);
  const registry = new Registry(mailboxRoot, tenantId);
  const audit = new Audit(mailboxRoot);
  const delivery = new Delivery(intercomConfig);
  const watcher = new Watcher(mailbox, delivery);

  const existingEntry = registry.get(sessionId);
  let sessionName = process.env.PI_SESSION_NAME ?? existingEntry?.name ?? `session-${sessionId.slice(0, 6)}`;
  let cachedCtx: any = null;

  const presence = new Presence(mailbox.baseDir, {
    pid: process.pid,
    status: "idle",
    name: sessionName,
    model: "",
    mode: intercomConfig.defaultMode,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  });

  registry.register({
    sessionId,
    tenantId,
    name: sessionName,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  presence.start();

  // ── Watcher side effects (one-time setup) ────────────────
  watcher.setSideEffects({
    onNotify: (text: string) => {
      try { cachedCtx?.ui.notify(text); } catch { /* ok */ }
    },
    onAccept: (msgId: string) => { mailbox.accept(msgId); },
    onReject: (msgId: string) => { mailbox.reject(msgId); },
    onInjectNextTurn: (content: string, display: string, msgId: string) => {
      try {
        api.sendMessage(
          { customType: "pit-mail", content, display },
          { deliverAs: "nextTurn", triggerTurn: true },
        );
      } catch { /* ok */ }
      mailbox.accept(msgId);
    },
    onInjectSteerAndNotify: (content: string, notifyText: string, msgId: string) => {
      try { api.sendUserMessage(content, { deliverAs: "steer" }); } catch { /* ok */ }
      try { cachedCtx?.ui.notify(notifyText); } catch { /* ok */ }
      mailbox.accept(msgId);
    },
    onAcceptAndInject: (content: string, msgId: string) => {
      try {
        api.sendUserMessage(content, { deliverAs: "followUp" });
      } catch { /* ok */ }
      mailbox.accept(msgId);
    },
  });

  // Start watcher (processes existing pending + watches for new)
  watcher.start();

  // ── ctx 缓存 ─────────────────────────────────────────────
  api.on("session_start", (_event: any, ctx: any) => {
    cachedCtx = ctx;

    // 会话内更新提示（fire-and-forget，缓存兜底，异常静默）
    void import("./update-hint.js").then(({ maybeShowUpdateHint }) => maybeShowUpdateHint(ctx));

    delivery.setActions({
      notify: (text: string) => {
        try { ctx.ui.notify(text); } catch { /* ok */ }
      },
      injectNextTurn: (content: string, display: string) => {
        try {
          api.sendMessage(
            { customType: "pit-mail", content, display },
            { deliverAs: "nextTurn", triggerTurn: true },
          );
        } catch { /* ok */ }
      },
      injectFollowUp: (content: string) => {
        try { api.sendUserMessage(content, { deliverAs: "followUp" }); } catch { /* ok */ }
      },
      injectSteer: (content: string) => {
        try { api.sendUserMessage(content, { deliverAs: "steer" }); } catch { /* ok */ }
      },
    });
  });

  // GC timer
  const gcTimer = setInterval(() => mailbox.gc(), 3600_000);
  gcTimer.unref();

  // ── Register /pit command ────────────────────────────────
  api.registerCommand("pit", {
    description: "Pi-Triple Intercom — cross-session communication",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trim().split(/\s+/);
      const subCmds = [
        { value: "send", label: "send <name> <msg>", description: "发送消息" },
        { value: "ask", label: "ask <name> <q>", description: "提问并等待回复" },
        { value: "share", label: "share <name> <file>", description: "分享文件" },
        { value: "broadcast", label: "broadcast <msg>", description: "广播消息" },
        { value: "inbox", label: "inbox", description: "查看待处理消息" },
        { value: "accept", label: "accept <#>", description: "接收消息" },
        { value: "reject", label: "reject <#>", description: "拒绝消息" },
        { value: "ps", label: "ps", description: "列出注册会话" },
        { value: "mode", label: "mode <manual|auto|hybrid>", description: "设置审核模式" },
        { value: "name", label: "name <name>", description: "设置会话名称" },
        { value: "status", label: "status", description: "通信状态" },
        { value: "help", label: "help", description: "帮助" },
      ];

      // 第一级：子命令补全
      if (parts.length <= 1) {
        const p = parts[0] ?? "";
        const filtered = subCmds.filter((c) => c.value.startsWith(p));
        return filtered.length > 0 ? filtered : null;
      }

      // 第二级：会话名补全（send/ask/share）
      const cmd2 = parts[0];
      if (["send", "ask", "share"].includes(cmd2) && parts.length === 2) {
        const entries = registry.list();
        const names = entries.map((e: any) => e.name).filter(Boolean);
        const p2 = parts[1] ?? "";
        const filtered = names.filter((n: string) => n.startsWith(p2));
        return filtered.length > 0 ? filtered.map((n: string) => ({ value: n, label: n })) : null;
      }

      // mode 参数补全
      if (cmd2 === "mode" && parts.length === 2) {
        const modes = ["manual", "auto", "hybrid"];
        const p3 = parts[1] ?? "";
        const filtered = modes.filter((m) => m.startsWith(p3));
        return filtered.length > 0 ? filtered.map((m) => ({ value: m, label: m })) : null;
      }

      return null;
    },
    handler: async (args: string, ctx: any /* ExtensionCommandContext */) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const argStr = rest.join(" ");

      // ── SEND / ASK ───────────────────────────────────────
      if (cmd === "send" || cmd === "ask") {
        const parts = argStr.split(/\s+/);
        const targetName = parts[0];
        const message = parts.slice(1).join(" ");
        if (!targetName || !message) {
          ctx.ui.notify(`Usage: /pit ${cmd} <session-name> <message>`, "warning");
          return;
        }
        const entries = registry.list();
        const target = entries.find((e: RegistryEntry) => e.name === targetName);
        if (!target) {
          ctx.ui.notify(`Session "${targetName}" not found. Use /pit ps.`, "warning");
          return;
        }
        const msg = createMessage({
          from: { sessionId, tenantId, name: sessionName },
          to: { sessionId: target.sessionId, tenantId },
          type: cmd === "ask" ? "ask" : "text",
          content: message,
        });
        const targetMailbox = new Mailbox(mailboxRoot, tenantId, target.sessionId);
        targetMailbox.send(msg);
        audit.log({ action: cmd === "ask" ? "ask" : "send", from: sessionName, to: targetName, msgId: msg.id, detail: message.slice(0, 80) });
        const verb = cmd === "ask" ? "Asked" : "Sent to";
        ctx.ui.notify(`\x1b[32m✅ ${verb} ${targetName}\x1b[0m: ${message.slice(0, 60)}`);
        if (cmd === "ask") {
          ctx.ui.notify(`\x1b[33m⏳ Waiting for reply (${(intercomConfig.askTimeout?.manual ?? 300_000) / 1000}s timeout)\x1b[0m`);
        }
        return;
      }

      // ── SHARE ────────────────────────────────────────────
      if (cmd === "share") {
        const parts = argStr.split(/\s+/);
        const targetName = parts[0];
        const fileArg = parts[1];
        const noteIdx = parts.indexOf("--note");
        const note = noteIdx >= 0 ? parts.slice(noteIdx + 1).join(" ") : "";
        const filePath = noteIdx >= 0 ? parts.slice(1, noteIdx).join(" ") : fileArg;
        if (!targetName || !filePath) {
          ctx.ui.notify("Usage: /pit share <session-name> <file> [--note ...]", "warning");
          return;
        }
        const absFile = path.resolve(ctx.cwd, filePath);
        if (!fs.existsSync(absFile)) {
          ctx.ui.notify(`File not found: ${absFile}`, "error");
          return;
        }
        const fileStat = fs.statSync(absFile);
        const target = registry.list().find((e: RegistryEntry) => e.name === targetName);
        if (!target) {
          ctx.ui.notify(`Session "${targetName}" not found.`, "warning");
          return;
        }
        const msg = createMessage({
          from: { sessionId, tenantId, name: sessionName },
          to: { sessionId: target.sessionId, tenantId },
          type: "file",
          content: note || path.basename(absFile),
          filePath: absFile,
          fileSize: fileStat.size,
        });
        const targetMailbox = new Mailbox(mailboxRoot, tenantId, target.sessionId);
        targetMailbox.sendFile(msg, absFile);
        audit.log({ action: "share", from: sessionName, to: targetName, msgId: msg.id, detail: `${path.basename(absFile)} (${(fileStat.size / 1024).toFixed(1)}KB)` });
        ctx.ui.notify(`\x1b[32m📦 Shared with ${targetName}\x1b[0m: ${path.basename(absFile)} (${(fileStat.size / 1024).toFixed(1)}KB)`);
        return;
      }

      // ── BROADCAST ─────────────────────────────────────────
      if (cmd === "broadcast") {
        const message = argStr;
        if (!message) {
          ctx.ui.notify("Usage: /pit broadcast <message>", "warning");
          return;
        }
        const entries = registry.list().filter((e: RegistryEntry) => e.sessionId !== sessionId);
        for (const target of entries) {
          const msg = createMessage({
            from: { sessionId, tenantId, name: sessionName },
            to: { sessionId: target.sessionId, tenantId },
            type: "broadcast",
            content: message,
          });
          const targetMailbox = new Mailbox(mailboxRoot, tenantId, target.sessionId);
          targetMailbox.send(msg);
        }
        audit.log({ action: "broadcast", from: sessionName, detail: `${entries.length} recipients: ${message.slice(0, 60)}` });
        ctx.ui.notify(`\x1b[32m📢 Broadcast to ${entries.length} sessions\x1b[0m`);
        return;
      }

      // ── INBOX ─────────────────────────────────────────────
      if (cmd === "inbox") {
        const msgs = mailbox.readPending();
        const lines = [`\x1b[1m📬 Inbox (${msgs.length} pending)\x1b[0m`];
        lines.push(...formatPendingMessages(msgs));
        ctx.ui.notify(lines.join("\n"));
        if (msgs.length > 0) {
        }
        return;
      }

      // ── ACCEPT ────────────────────────────────────────────
      if (cmd === "accept") {
        const idx = parseInt(rest[0], 10);
        const msgs = mailbox.readPending();
        const msg = (idx > 0 && idx <= msgs.length) ? msgs[idx - 1] : null;
        if (!msg) {
          ctx.ui.notify("Invalid message #. Use /pit inbox to see IDs.", "warning");
          return;
        }
        if (msg.type === "file") {
          const fileDir = path.join(mailbox.pendingDir, `file-${msg.id}`);
          if (fs.existsSync(fileDir)) {
            const files = fs.readdirSync(fileDir).filter((f: string) => f !== "meta.json");
            for (const f of files) {
              const src = path.join(fileDir, f);
              const dst = path.join(ctx.cwd, f);
              fs.copyFileSync(src, dst);
              ctx.ui.notify(`📦 File copied: ${f}`);
            }
          }
          mailbox.accept(msg.id);
          audit.log({ action: "accept", msgId: msg.id, from: msg.from.name });
        } else {
          // Mark as processed + inject into LLM
          delivery.acceptAndInject(msg);
          try {
            api.sendUserMessage(
              `[来自 ${msg.from.name} 的消息] ${msg.content}`,
              { deliverAs: "followUp" },
            );
          } catch { /* ok */ }
          ctx.ui.notify(`\x1b[32m📬 Accepted from ${msg.from.name}\x1b[0m: ${msg.content.slice(0, 60)}`);
          audit.log({ action: "accept", msgId: msg.id, from: msg.from.name });
        }
        return;
      }

      // ── REJECT ────────────────────────────────────────────
      if (cmd === "reject") {
        const idx = parseInt(rest[0], 10);
        const msgs = mailbox.readPending();
        const msg = (idx > 0 && idx <= msgs.length) ? msgs[idx - 1] : null;
        if (!msg) {
          ctx.ui.notify("Invalid message #.", "warning");
          return;
        }
        mailbox.reject(msg.id);
        audit.log({ action: "reject", msgId: msg.id, from: msg.from.name });
        ctx.ui.notify(`\x1b[2mRejected from ${msg.from.name}\x1b[0m`);
        return;
      }

      // ── PS ────────────────────────────────────────────────
      if (cmd === "ps") {
        const entries = registry.list();
        const lines = [`\x1b[1mSessions (tenant: ${tenantId})\x1b[0m`];
        lines.push(...formatSessionList(entries, mailboxRoot, tenantId));
        ctx.ui.notify(lines.join("\n"));
        return;
      }

      // ── MODE ──────────────────────────────────────────────
      if (cmd === "mode") {
        const mode = rest[0] as ReviewMode;
        if (mode !== "manual" && mode !== "auto" && mode !== "hybrid") {
          ctx.ui.notify("Usage: /pit mode <manual|auto|hybrid>", "warning");
          return;
        }
        delivery.config.sessionMode = mode;
        presence.setMode(mode);
        ctx.ui.notify(`\x1b[32mMode set to ${mode}\x1b[0m`);
        return;
      }

      // ── NAME ──────────────────────────────────────────────
      if (cmd === "name") {
        const name = argStr.trim();
        if (!name) {
          ctx.ui.notify("Usage: /pit name <display-name>", "warning");
          return;
        }
        sessionName = name;
        try { api.setSessionName(name); } catch { /* ok */ }
        presence.updateState({ name });
        registry.register({ sessionId, tenantId, name, pid: process.pid, startedAt: new Date().toISOString() });
        ctx.ui.notify(`\x1b[32mSession name: ${name}\x1b[0m`);
        return;
      }

      // ── STATUS ────────────────────────────────────────────
      if (cmd === "status") {
        const mode = delivery.config.sessionMode ?? intercomConfig.tenantMode ?? intercomConfig.defaultMode;
        const lines = [`\x1b[1mIntercom Status\x1b[0m`,
          `  name:    ${sessionName}`,
          `  session: ${sessionId.slice(0, 8)}`,
          `  tenant:  ${tenantId}`,
          `  mode:    ${mode}`,
          `  mailbox: ${mailboxRoot}`,
          `  pending: ${mailbox.readPending().length} message(s)`];
        ctx.ui.notify(lines.join("\n"));
        return;
      }

      // ── HELP ──────────────────────────────────────────────
      ctx.ui.notify(
        "Commands:\n" +
        "  /pit send <name> <msg>   Send message\n" +
        "  /pit ask <name> <q>       Ask question\n" +
        "  /pit share <name> <file>  Share file\n" +
        "  /pit broadcast <msg>      Broadcast\n" +
        "  /pit inbox                View pending\n" +
        "  /pit accept <#>           Accept message\n" +
        "  /pit reject <#>           Reject message\n" +
        "  /pit ps                   List registered sessions\n" +
        "  /pit mode <m|a|h>         Set review mode\n" +
        "  /pit name <name>          Set display name\n" +
        "  /pit status               Intercom status\n" +
        "\nSession management: /control start|stop|ls (pit-control)\n" +
        "\nSwitch sessions: Ctrl+B s (tmux)",
      );
    },
  });

  // ── Cleanup ──────────────────────────────────────────────
  api.on("session_shutdown", ({ reason }: { reason: string }) => {
    watcher.stop();
    clearInterval(gcTimer);
    registry.unregister(sessionId);
    if (reason !== "reload") {
      presence.cleanup();
    }
  });
}
