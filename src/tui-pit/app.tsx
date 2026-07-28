import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TopBar, TabBar, StatusBar, useTabs, useTerminalSize, ConfirmDialog } from "../tui-shared/index.js";
import { DashboardPage } from "./dashboard.js";
import { TenantsPage } from "./tenants.js";
import { SessionsPage } from "./sessions.js";
import { ExtensionsPage } from "./extensions.js";
import { ConfigPage } from "./config-page.js";
import { CommandBar } from "./command-bar.js";
import { OutputPanel } from "./output-panel.js";
import type { CommandResult } from "../commands.js";

const TABS = ["Dashboard", "Tenants", "Sessions", "Extensions", "Config"];

const DESTRUCTIVE_CMDS = ["tenant rm", "stop", "stop --all"];

export function PitApp() {
  const { activeTab, setActiveTab, tabIndex } = useTabs(TABS);
  const { columns, rows } = useTerminalSize();
  const [commandMode, setCommandMode] = useState(false);
  const [outputLines, setOutputLines] = useState<string[] | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Notification auto-dismiss
  React.useEffect(() => {
    if (notification) {
      const t = setTimeout(() => setNotification(null), 4000);
      return () => clearTimeout(t);
    }
  }, [notification]);

  // Global input handling
  useInput((input, key) => {
    if (key.ctrl && input === "c") process.exit(130);

    // Output panel open: only Esc to close
    if (outputLines) {
      if (key.escape) setOutputLines(null);
      return;
    }

    // Confirm dialog open: only y/n
    if (confirmAction) {
      if (input === "n" || key.escape) { setConfirmAction(null); return; }
      if (input === "y") {
        const cb = confirmAction.onConfirm;
        setConfirmAction(null);
        cb();
      }
      return;
    }

    // Command mode: commands.ts handles all input
    if (commandMode) return;

    // Normal mode: trigger command bar with / or :
    if ((input === "/" || input === ":") && !key.ctrl && !key.meta) {
      setCommandMode(true);
      return;
    }

    // Quit
    if (input === "q" && !key.ctrl) process.exit(0);
  });

  // Execute command from TUI
  async function executeCommand(cmdStr: string): Promise<void> {
    const parts = cmdStr.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    // Check for destructive commands
    const fullCmd = parts.join(" ");
    if (DESTRUCTIVE_CMDS.some((d) => fullCmd.startsWith(d))) {
      setConfirmAction({
        message: `确认执行: ${fullCmd}？`,
        onConfirm: () => doExecuteCommand(cmd, args, cmdStr),
      });
      return;
    }

    await doExecuteCommand(cmd, args, cmdStr);
  }

  async function doExecuteCommand(cmd: string, args: string[], cmdStr: string): Promise<void> {
    let result: CommandResult;

    // Route to commands.ts functions
    const { execTenantLs, execTenantNew, execTenantRm, execStatus, execLs, execStop, execSharedStatus } = await import("../commands.js");

    switch (cmd) {
      case "tenant":
        if (args[0] === "ls" || args[0] === "list") result = await execTenantLs();
        else if (args[0] === "new") result = await execTenantNew(args[1]);
        else if (args[0] === "rm") result = await execTenantRm(args[1]);
        else result = await execTenantLs();
        break;
      case "status":
        result = await execStatus();
        break;
      case "ls":
        result = await execLs();
        break;
      case "stop":
        result = await execStop(args[0] || "");
        break;
      case "shared":
        if (args[0] === "status") result = await execSharedStatus();
        else result = { ok: false, message: "", error: { code: "UNKNOWN_COMMAND", message: `共享层命令: pit shared status` } };
        break;
      case "attach":
        // Handoff: unmount TUI and let tmux take over
        setNotification("切换到 tmux 会话…");
        // Use the external handoff pattern
        result = {
          ok: true,
          message: "",
          handoff: { cmd: "pit", args: ["attach", ...args] },
        };
        break;
      default:
        result = { ok: false, message: "", error: { code: "UNKNOWN_COMMAND", message: `未知命令: ${cmd}。支持: tenant, status, ls, stop, shared, attach` } };
    }

    if (result.handoff) {
      // Handoff: release terminal to child process (like sessions.tsx handoffTerminal)
      process.stdin.pause();
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(result.handoff.cmd, result.handoff.args, {
        stdio: "inherit",
        env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
      });
      process.exit(r.status ?? 0);
      return;
    }

    const msg = result.ok ? result.message : (result.error ? `\x1b[31m❌ ${result.error.message}\x1b[0m` : "Unknown error");
    const lines = msg.split("\n");

    if (lines.length <= 3) {
      setNotification(msg);
    } else {
      setOutputLines(lines.filter((l) => l.trim().length > 0));
    }
  }

  // Input gating: pages disabled when command bar or output panel active
  const gated = !commandMode && !outputLines && !confirmAction;

  const sharedProps = { width: Math.min(columns, 120), height: rows - 7 };

  // Render layers
  let content: React.ReactNode;
  if (outputLines) {
    content = <OutputPanel lines={outputLines} onClose={() => setOutputLines(null)} />;
  } else if (commandMode) {
    content = (
      <Box flexDirection="column">
        <Box minHeight={rows - 12}>
          {/* Show current page dimmed in background — disabled to avoid input conflict */}
          {tabIndex === 0 && <DashboardPage {...sharedProps} />}
          {tabIndex === 1 && <TenantsPage {...sharedProps} enabled={false} />}
          {tabIndex === 2 && <SessionsPage {...sharedProps} enabled={false} />}
          {tabIndex === 3 && <ExtensionsPage {...sharedProps} />}
          {tabIndex === 4 && <ConfigPage {...sharedProps} />}
        </Box>
        <CommandBar
          visible={commandMode}
          onSubmit={(s) => { setCommandMode(false); executeCommand(s); }}
          onCancel={() => setCommandMode(false)}
        />
      </Box>
    );
  } else {
    content = (
      <Box flexDirection="column" minHeight={rows - 9}>
        {tabIndex === 0 && <DashboardPage {...sharedProps} />}
        {tabIndex === 1 && <TenantsPage {...sharedProps} enabled={gated} />}
        {tabIndex === 2 && <SessionsPage {...sharedProps} enabled={gated} />}
        {tabIndex === 3 && <ExtensionsPage {...sharedProps} />}
        {tabIndex === 4 && <ConfigPage {...sharedProps} />}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={Math.min(columns, 120)} padding={1}>
      <TopBar title="Pi-Triple Control" version="0.1.0" />

      {!outputLines && !commandMode && <TabBar tabs={TABS} activeTab={activeTab} onSelect={setActiveTab} />}

      {content}

      {/* Confirm dialog overlay */}
      {confirmAction && (
        <Box borderStyle="round" borderColor="yellow" padding={1} marginTop={1}>
          <Text bold>{confirmAction.message} (y/n)</Text>
        </Box>
      )}

      {/* Notification toast */}
      {notification && (
        <Box marginTop={1}>
          <Text>{notification}</Text>
        </Box>
      )}

      <StatusBar hints={`[1-5] Tab · [/] Command · [q] Quit${outputLines ? " · [Esc] Back" : ""}`} />
    </Box>
  );
}
