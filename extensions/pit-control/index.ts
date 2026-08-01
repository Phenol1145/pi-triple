/**
 * pit-control: Pi-Triple session control extension
 *
 * Commands:
 *   /control start [name]     Start a background pi session (tmux; auto-named if omitted)
 *   /control stop <name>      Kill a background session
 *   /control ls               List all pit-managed tmux sessions (with online status)
 *   /control switch <name>    Switch terminal to another session (in-tmux)
 *   /control attach <name>    Instructions to attach (cannot attach from within pi)
 *   /control detach           Detach current terminal (session keeps running)
 *   /control ui               Open pit UI in a new tmux window
 *   /control name <name>      Set current session display name (persisted)
 *   /control status           Show current session + tmux status
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { TmuxSession, createDefaultRunner } from "../_shared/tmux-session.js";
import { Registry } from "../_shared/registry.js";
import { Presence } from "../_shared/presence.js";
import { resolveMailboxRoot, resolveTenantId } from "../_shared/paths.js";

export default function pitControl(api: any) {
  const templateId: string = process.env.PI_TEMPLATE ?? "unknown";
  const agentDir: string = process.env.PI_CODING_AGENT_DIR ?? "";
  const sessionId: string = process.env.PI_SESSION_ID ?? randomUUID();
  const tenantId: string = resolveTenantId();
  const mailboxRoot: string = resolveMailboxRoot();

  const tmux = new TmuxSession();
  const registry = new Registry(mailboxRoot, tenantId);
  const statePath = path.join(mailboxRoot, tenantId, sessionId, "state.json");

  const existingEntry = registry.get(sessionId);
  let sessionName: string = existingEntry?.name ?? `session-${sessionId.slice(0, 8)}`;

  // ── 自注册：把 sessionId 写入当前 tmux 会话环境（供 /control ls 反查）──
  try {
    const cur = tmux.currentSessionName();
    if (cur?.startsWith("pit-")) {
      tmux.setSessionEnv(cur.slice(4), "PI_SESSION_ID", sessionId);
    }
  } catch { /* 非 tmux 环境，忽略 */ }

  // ── register /control ─────────────────────────────────────

  const subCmds = [
    { value: "start", label: "start [name]", description: "启动后台 pi 会话（缺省自动命名）" },
    { value: "stop", label: "stop <name>", description: "停止后台会话" },
    { value: "ls", label: "ls", description: "列出所有后台会话" },
    { value: "switch", label: "switch <name>", description: "切换到另一个会话（tmux 内瞬移）" },
    { value: "attach", label: "attach <name>", description: "接入后台会话" },
    { value: "detach", label: "detach", description: "脱离当前会话（保持运行）" },
    { value: "ui", label: "ui", description: "打开 pit 控制面板" },
    { value: "name", label: "name <name>", description: "设置会话名称" },
    { value: "status", label: "status", description: "会话状态" },
  ];

  api.registerCommand("control", {
    description: "Pi-Triple session control — manage background pi sessions",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trim().split(/\s+/);

      // first level: subcommand names
      if (parts.length <= 1) {
        const p = parts[0] ?? "";
        const filtered = subCmds.filter((c) => c.value.startsWith(p));
        return filtered.length > 0 ? filtered : null;
      }

      // second level: session name for start/stop/attach/switch
      if (["start", "stop", "attach", "switch"].includes(parts[0]!) && parts.length === 2) {
        if (!tmux.hasTmux()) return null;
        const p2 = parts[1] ?? "";
        const sessions = tmux.listPitSessions().filter((s) => s.startsWith(p2));
        return sessions.length > 0 ? sessions.map((s) => ({ value: s, label: s })) : null;
      }

      return null;
    },
    handler: async (args: string, ctx: any) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const argStr = rest.join(" ");

      if (!cmd) {
        ctx.ui.notify("Commands:\n" + subCmds.map((c) => `  /control ${c.label}`).join("\n"));
        return;
      }

      // ── start ────────────────────────────────
      if (cmd === "start") {
        const userProvided = rest.length > 0;
        const rawName = rest[0] ?? "";
        if (!tmux.hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }
        const name = userProvided ? tmux.sanitizeName(rawName) : undefined;

        const env: Record<string, string> = {};
        if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
        if (process.env.PI_TEMPLATE) env.PI_TEMPLATE = process.env.PI_TEMPLATE;
        if (process.env.PI_TEMPLATE_ALIAS) env.PI_TEMPLATE_ALIAS = process.env.PI_TEMPLATE_ALIAS;
        if (process.env.AGENT_LAB_DB_PATH) env.AGENT_LAB_DB_PATH = process.env.AGENT_LAB_DB_PATH;
        if (process.env.AGENT_LAB_CONFIG_DIR) env.AGENT_LAB_CONFIG_DIR = process.env.AGENT_LAB_CONFIG_DIR;
        if (name) env.PI_SESSION_NAME = name;

        const r = tmux.startSession({ name, env });
        if (r.ok) {
          const autoNote = userProvided ? "" : ` (auto-named)`;
          ctx.ui.notify(`\x1b[32m✅ Background session "${r.name}" started${autoNote}\x1b[0m`);
        } else {
          ctx.ui.notify(`Failed: ${r.error}`, "error");
        }
        return;
      }

      // ── stop ─────────────────────────────────
      if (cmd === "stop") {
        const name = rest[0];
        if (!name) { ctx.ui.notify("Usage: /control stop <name>", "warning"); return; }
        if (!tmux.hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }
        if (!tmux.sessionExists(name)) {
          ctx.ui.notify(`Session "${name}" not found`, "warning");
          return;
        }

        if (tmux.stopSession(name)) {
          ctx.ui.notify(`\x1b[32m✅ Stopped "${name}"\x1b[0m`);
        } else {
          ctx.ui.notify(`Failed to stop "${name}"`, "error");
        }
        return;
      }

      // ── switch ─────────────────────────────
      if (cmd === "switch") {
        const name = rest[0];
        if (!name) { ctx.ui.notify("Usage: /control switch <name>", "warning"); return; }
        if (!process.env.TMUX) { ctx.ui.notify("Not inside tmux — use: pit attach " + name, "warning"); return; }
        if (!tmux.sessionExists(name)) {
          ctx.ui.notify(`Session "${name}" not found`, "warning");
          return;
        }
        tmux.switchTo(name);
        return;
      }

      // ── detach ─────────────────────────────
      if (cmd === "detach") {
        if (!process.env.TMUX) { ctx.ui.notify("Not inside tmux — nothing to detach", "warning"); return; }
        tmux.detach();
        return;
      }

      // ── ls ───────────────────────────────────
      if (cmd === "ls") {
        if (!tmux.hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }
        const details = tmux.listSessionsDetail();
        if (details.length === 0) {
          ctx.ui.notify("No background sessions\nStart: /control start [name]");
          return;
        }
        const lines = ["\x1b[1mBackground Sessions\x1b[0m", ""];
        for (const d of details) {
          const sid = tmux.getSessionEnv(d.name, "PI_SESSION_ID");
          if (sid) {
            const sp = path.join(mailboxRoot, tenantId, sid, "state.json");
            const state = Presence.read(sp);
            const online = Presence.isOnline(sp);
            const displayName = registry.get(sid)?.name ?? d.name;
            const statusIcon = !online ? "\x1b[2m○\x1b[0m" : state?.status === "busy" ? "\x1b[33m◐\x1b[0m" : "\x1b[32m●\x1b[0m";
            const model = state?.model ?? "?";
            const mode = state?.mode ?? "?";
            const age = d.ageSec < 60 ? `${d.ageSec}s` : d.ageSec < 3600 ? `${Math.floor(d.ageSec / 60)}m` : `${Math.floor(d.ageSec / 3600)}h`;
            lines.push(`  ${statusIcon} \x1b[1m${displayName.padEnd(16)}\x1b[0m${d.windows}w  ${age}  ${mode}  ${model}`);
          } else {
            lines.push(`  \x1b[1m${d.name.padEnd(16)}\x1b[0m${d.windows}w  ${d.ageSec}s  (no presence)`);
          }
        }
        lines.push("\nSwitch: /control switch <name>  ·  Stop: /control stop <name>");
        ctx.ui.notify(lines.join("\n"));
        ctx.ui.setWidget("pit-sessions", lines, { placement: "aboveEditor" });
        return;
      }

      // ── attach ───────────────────────────────
      if (cmd === "attach") {
        const name = rest[0];
        if (!name) { ctx.ui.notify("Usage: /control attach <name>", "warning"); return; }

        ctx.ui.notify(
          `To attach session "${name}":\n\n` +
          "  \x1b[1mCtrl+B d\x1b[0m   — detach from current pi\n" +
          `  \x1b[1mpit attach ${name}\x1b[0m   — attach to "${name}"\n\n` +
          "Or while still in tmux:\n" +
          "  \x1b[1mCtrl+B s\x1b[0m   — session picker"
        );
        return;
      }

      // ── ui ───────────────────────────────────
      if (cmd === "ui") {
        if (!tmux.hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }

        // open pit ui in a new tmux window
        // (窗口级操作走共享模块的 runner：list-windows / new-window 不属于 TmuxSession 类 API)
        const run = createDefaultRunner();
        const windowName = "pit-ui";
        const check = run(["list-windows", "-F", "#{window_name}"]);
        if (check.stdout?.includes(windowName)) {
          ctx.ui.notify(`pit ui already open. Switch: \x1b[2mCtrl+B s\x1b[0m → ${windowName}`);
          return;
        }

        // Try new-window first (reuse current tmux session)
        const r = run(["new-window", "-n", windowName, "pit"]);
        if (r.status === 0) {
          ctx.ui.notify(`\x1b[32m✅ pit ui opened in new tmux window\x1b[0m\nSwitch: \x1b[2mCtrl+B s\x1b[0m → ${windowName}`);
        } else {
          // fallback: new detached session
          const r2 = run(["new-session", "-d", "-s", "pit-ui-session", "-n", "pi-triple", "pit"]);
          if (r2.status === 0) {
            ctx.ui.notify(`\x1b[32m✅ pit ui opened (detached session)\x1b[0m\nSwitch: \x1b[2mCtrl+B s\x1b[0m`);
          } else {
            ctx.ui.notify(`Failed: ${r2.stderr}`, "error");
          }
        }
        return;
      }

      // ── name ─────────────────────────────────
      if (cmd === "name") {
        const name = argStr.trim();
        if (!name) { ctx.ui.notify("Usage: /control name <display-name>", "warning"); return; }
        sessionName = name;
        const existing = registry.get(sessionId);
        registry.register({
          sessionId, tenantId, name,
          pid: existing?.pid ?? process.pid,
          startedAt: existing?.startedAt ?? new Date().toISOString(),
        });
        Presence.updateName(statePath, name);
        try { api.setSessionName?.(name); } catch { /* ok */ }
        ctx.ui.notify(`\x1b[32mSession name: ${name}\x1b[0m`);
        return;
      }

      // ── status ───────────────────────────────
      if (cmd === "status") {
        const existing = registry.get(sessionId);
        const cur = tmux.currentSessionName();
        const lines = [
          "\x1b[1mSession Status\x1b[0m",
          `  name:    ${existing?.name ?? sessionName}`,
          `  session: ${sessionId.slice(0, 8)}`,
          `  tmux:    ${cur ?? "(not in tmux)"}`,
          `  template:  ${templateId.slice(0, 8)}…`,
          `  tenant:  ${tenantId.slice(0, 8)}…`,
        ];
        if (tmux.hasTmux()) {
          const pits = tmux.listPitSessions();
          lines.push(`  running: ${pits.length} pit session(s)`);
          if (pits.length > 0) lines.push(`  sessions: ${pits.join(", ")}`);
        } else {
          lines.push("  tmux:    not installed");
        }
        ctx.ui.notify(lines.join("\n"));
        return;
      }

      // default help
      ctx.ui.notify(
        "Commands:\n" + subCmds.map((c) => `  /control ${c.label}  —  ${c.description}`).join("\n") +
        "\n\n" +
        "\x1b[2mCtrl+B s\x1b[0m — tmux session picker\n" +
        "\x1b[2mCtrl+B d\x1b[0m — detach (pi continues in background)"
      );
    },
  });
}
