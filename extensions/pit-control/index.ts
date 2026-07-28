/**
 * pit-control: Pi-Triple session control extension
 *
 * Commands:
 *   /control start <name>     Start a background pi session (tmux)
 *   /control stop <name>      Kill a background session
 *   /control ls               List all pit-managed tmux sessions
 *   /control switch <name>    Switch terminal to another session (in-tmux)
 *   /control attach <name>    Instructions to attach (cannot attach from within pi)
 *   /control detach           Detach current terminal (session keeps running)
 *   /control ui               Open pit UI in a new tmux window
 *   /control name <name>      Set current session display name
 *   /control status           Show current session + tmux status
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export default function pitControl(api: any) {
  const tenantId: string = process.env.PI_TENANT ?? "unknown";
  const agentDir: string = process.env.PI_CODING_AGENT_DIR ?? "";
  const sessionId: string = process.env.PI_SESSION_ID ?? randomUUID();

  let sessionName: string = `session-${sessionId.slice(0, 8)}`;

  // ── helpers ───────────────────────────────────────────────

  function hasTmux(): boolean {
    return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
  }

  function tmuxName(name: string): string {
    return `pit-${name}`;
  }

  function listPitSessions(): string[] {
    const r = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf-8" });
    return (r.stdout ?? "").trim().split("\n").filter((l: string) => l.startsWith("pit-")).map((l: string) => l.replace(/^pit-/, ""));
  }

  function sessionExists(name: string): boolean {
    const r = spawnSync("tmux", ["has-session", "-t", tmuxName(name)], { encoding: "utf-8" });
    return r.status === 0;
  }

  // ── register /control ─────────────────────────────────────

  const subCmds = [
    { value: "start", label: "start <name>", description: "启动后台 pi 会话" },
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
        if (!hasTmux()) return null;
        const p2 = parts[1] ?? "";
        const sessions = listPitSessions().filter((s) => s.startsWith(p2));
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
        const name = rest[0];
        if (!name) { ctx.ui.notify("Usage: /control start <name>", "warning"); return; }
        if (!hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }
        if (sessionExists(name)) {
          ctx.ui.notify(`Session "${name}" already running`, "warning");
          return;
        }

        const tmuxArgs = ["new-session", "-d", "-s", tmuxName(name), "-x", "200", "-y", "50"];
        if (agentDir) tmuxArgs.push("-e", `PI_CODING_AGENT_DIR=${agentDir}`);
        if (process.env.PI_TENANT) tmuxArgs.push("-e", `PI_TENANT=${process.env.PI_TENANT}`);
        if (process.env.PI_TENANT_ALIAS) tmuxArgs.push("-e", `PI_TENANT_ALIAS=${process.env.PI_TENANT_ALIAS}`);
        if (process.env.AGENT_LAB_DB_PATH) tmuxArgs.push("-e", `AGENT_LAB_DB_PATH=${process.env.AGENT_LAB_DB_PATH}`);
        if (process.env.AGENT_LAB_CONFIG_DIR) tmuxArgs.push("-e", `AGENT_LAB_CONFIG_DIR=${process.env.AGENT_LAB_CONFIG_DIR}`);
        tmuxArgs.push("--", "pi");

        const r = spawnSync("tmux", tmuxArgs, { encoding: "utf-8" });

        if (r.status === 0) {
          ctx.ui.notify(`\x1b[32m✅ Background session "${name}" started\x1b[0m`);
        } else {
          ctx.ui.notify(`Failed: ${r.stderr}`, "error");
        }
        return;
      }

      // ── stop ─────────────────────────────────
      if (cmd === "stop") {
        const name = rest[0];
        if (!name) { ctx.ui.notify("Usage: /control stop <name>", "warning"); return; }
        if (!hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }
        if (!sessionExists(name)) {
          ctx.ui.notify(`Session "${name}" not found`, "warning");
          return;
        }

        const r = spawnSync("tmux", ["kill-session", "-t", `=${tmuxName(name)}`], { encoding: "utf-8" });
        if (r.status === 0) {
          ctx.ui.notify(`\x1b[32m✅ Stopped "${name}"\x1b[0m`);
        } else {
          ctx.ui.notify(`Failed: ${r.stderr}`, "error");
        }
        return;
      }

      // ── switch ─────────────────────────────
      if (cmd === "switch") {
        const name = rest[0];
        if (!name) { ctx.ui.notify("Usage: /control switch <name>", "warning"); return; }
        if (!process.env.TMUX) { ctx.ui.notify("Not inside tmux — use: pit attach " + name, "warning"); return; }
        if (!sessionExists(name)) {
          ctx.ui.notify(`Session "${name}" not found`, "warning");
          return;
        }
        spawnSync("tmux", ["switch-client", "-t", `=${tmuxName(name)}`], { encoding: "utf-8" });
        return;
      }

      // ── detach ─────────────────────────────
      if (cmd === "detach") {
        if (!process.env.TMUX) { ctx.ui.notify("Not inside tmux — nothing to detach", "warning"); return; }
        spawnSync("tmux", ["detach-client"], { encoding: "utf-8" });
        return;
      }

      // ── ls ───────────────────────────────────
      if (cmd === "ls") {
        if (!hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }

        const r = spawnSync("tmux", [
          "list-sessions", "-F", "#{session_name} #{session_windows} #{session_created}",
        ], { encoding: "utf-8" });

        const pits = (r.stdout ?? "").trim().split("\n")
          .filter((l: string) => l.startsWith("pit-"))
          .map((l: string) => {
            const [full, win, created] = l.split(" ");
            const name = full.replace(/^pit-/, "");
            const ageSec = Math.floor(Date.now() / 1000 - parseInt(created ?? "0"));
            const age = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m` : `${Math.floor(ageSec / 3600)}h`;
            return { name, win: win ?? "1", age };
          });

        if (pits.length === 0) {
          ctx.ui.notify("No background sessions\nStart: /control start <name>");
        } else {
          const lines = ["\x1b[1mBackground Sessions\x1b[0m", ""];
          for (const s of pits) {
            lines.push(`  \x1b[1m${s.name.padEnd(16)}\x1b[0m${s.win}w  ${s.age} ago`);
          }
          lines.push("\nSwitch: /control switch <name>  (in-tmux instant jump)");
          lines.push("Detach: /control detach  ·  Attach: pit attach <name>");
          ctx.ui.notify(lines.join("\n"));
          ctx.ui.setWidget("pit-sessions", lines, { placement: "aboveEditor" });
        }
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
        if (!hasTmux()) { ctx.ui.notify("tmux not installed", "error"); return; }

        // open pit ui in a new tmux window
        const windowName = "pit-ui";
        const check = spawnSync("tmux", ["list-windows", "-F", "#{window_name}"], { encoding: "utf-8" });
        if (check.stdout?.includes(windowName)) {
          ctx.ui.notify(`pit ui already open. Switch: \x1b[2mCtrl+B s\x1b[0m → ${windowName}`);
          return;
        }

        // Try new-window first (reuse current tmux session)
        const r = spawnSync("tmux", ["new-window", "-n", windowName, "pit"], { encoding: "utf-8" });
        if (r.status === 0) {
          ctx.ui.notify(`\x1b[32m✅ pit ui opened in new tmux window\x1b[0m\nSwitch: \x1b[2mCtrl+B s\x1b[0m → ${windowName}`);
        } else {
          // fallback: new detached session
          const r2 = spawnSync("tmux", ["new-session", "-d", "-s", "pit-ui-session", "-n", "pi-triple", "pit"], { encoding: "utf-8" });
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
        try { api.setSessionName?.(name); } catch { /* ok */ }
        ctx.ui.notify(`\x1b[32mSession name: ${name}\x1b[0m`);
        return;
      }

      // ── status ───────────────────────────────
      if (cmd === "status") {
        const lines = [
          "\x1b[1mSession Status\x1b[0m",
          `  name:    ${sessionName}`,
          `  session: ${sessionId.slice(0, 8)}`,
          `  tenant:  ${tenantId.slice(0, 8)}…`,
          `  agent:   ${agentDir ? "custom dir" : "default (~/.pi/agent)"}`,
        ];
        if (hasTmux()) {
          const pits = listPitSessions();
          lines.push(`  tmux:    ${pits.length} pit session(s)`);
          if (pits.length > 0) lines.push(`  running: ${pits.join(", ")}`);
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
