import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Screen, useTabs, useTerminalSize } from "../tui-shared/index.js";
import { DashboardPage } from "./dashboard.js";
import { TemplatesPage } from "./templates.js";
import { SessionsPage } from "./sessions.js";
import { ExtensionsPage } from "./extensions.js";
import { ConfigPage } from "./config-page.js";
import { CommandBar } from "./command-bar.js";
import { OutputPanel } from "./output-panel.js";
import type { CommandResult } from "../commands.js";
import { dispatchCommand } from "../commands/dispatch.js";
import { loadConfig, listTemplates } from "../config.js";
import { listPitSessions, startPitSession } from "../tmux.js";

const TABS = ["Dashboard", "Templates", "Sessions", "Extensions", "Config"];

const DESTRUCTIVE_CMDS = ["template rm", "stop", "stop --all"];

/** TUI-wired bg session start — 与 CLI 同一构建路径 */
export function PitApp() {
  const { columns, rows } = useTerminalSize();
  const { exit: unmountInk } = useApp();
  const [notification, setNotification] = useState<string | null>(null);
  const [commandMode, setCommandMode] = useState(false);
  const [outputLines, setOutputLines] = useState<string[] | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [completionKey, setCompletionKey] = useState(0);

  // Input gating: pages and tab switching disabled when command bar / output panel / confirm active
  const gated = !commandMode && !outputLines && !confirmAction;

  // Tab navigation gated by focus state
  const { activeTab, setActiveTab, tabIndex } = useTabs(TABS, gated);

  // Notification auto-dismiss
  React.useEffect(() => {
    if (notification) {
      const t = setTimeout(() => setNotification(null), 4000);
      return () => clearTimeout(t);
    }
  }, [notification]);

  // Command completions for parameter autocomplete
  const completions = useMemo<Record<string, string[]>>(() => {
    const cfg = loadConfig();
    const templateAliases = listTemplates(cfg).map((t) => t.alias);
    const sessions = listPitSessions().map((s) => s.name);
    return {
      pi: ["--template", ...templateAliases],
      attach: sessions,
      switch: sessions,
      stop: [...sessions, "--all"],
      "template rm": templateAliases,
      "template rename": templateAliases,
    };
  }, [commandMode, completionKey]); // refresh when command bar opens

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

    // Quit：/quit 命令（避免误触）；Ctrl+C 始终可用
    if (input === "q" && !key.ctrl) {
      setNotification("按 q 已停用——输入 /quit 退出（Ctrl+C 也可）");
      return;
    }
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

  async function doExecuteCommand(cmd: string, args: string[], _cmdStr: string): Promise<void> {
    let result: CommandResult;

    try {
      if (cmd === "quit" || cmd === "exit") process.exit(0);
      result = await dispatchCommand(cmd, args);
    } catch (err: any) {
      setNotification(`\x1b[31m❌ 命令执行错误: ${err?.message ?? err}\x1b[0m`);
      return;
    }

    if (result.handoff) {
      try { process.stdin.setRawMode(false); } catch { /* not a TTY */ }
      unmountInk();
      process.stdin.pause();
      const { spawnSync } = await import("node:child_process");
      try {
        const r = spawnSync(result.handoff.cmd, result.handoff.args, {
          stdio: "inherit",
          env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
        });
        process.exit(r.status ?? 0);
      } catch (err: any) {
        console.error(`\x1b[31m❌ 无法启动 ${result.handoff.cmd}: ${err.message}\x1b[0m`);
        process.exit(1);
      }
      return;
    }

    const msg = result.ok ? result.message : (result.error ? `\x1b[31m❌ ${result.error.message}\x1b[0m` : "Unknown error");
    const lines = msg.split("\n");

    if (lines.length <= 3) {
      setNotification(msg);
    } else {
      setOutputLines(lines);
    }
    setCompletionKey((k) => k + 1);  // 命令执行后刷新补全（template rm 后别名不再出现）
  }

  const safeW = Math.max(40, Math.min(columns, 120));
  const safeH = Math.max(5, rows - 7);
  const sharedProps = { width: safeW, height: safeH };

  // ── Content 层 ─────────────────────────────────────────
  let content: React.ReactNode;
  if (outputLines) {
    content = <OutputPanel lines={outputLines} onClose={() => setOutputLines(null)} />;
  } else if (commandMode) {
    content = (
      <Box flexDirection="column">
        <Box minHeight={Math.max(5, rows - 12)}>
          {tabIndex === 0 && <DashboardPage {...sharedProps} />}
          {tabIndex === 1 && <TemplatesPage {...sharedProps} enabled={false} />}
          {tabIndex === 2 && <SessionsPage {...sharedProps} enabled={false} />}
          {tabIndex === 3 && <ExtensionsPage {...sharedProps} />}
          {tabIndex === 4 && <ConfigPage {...sharedProps} />}
        </Box>
        <CommandBar
          visible={commandMode}
          onSubmit={(s) => { setCommandMode(false); executeCommand(s); }}
          onCancel={() => setCommandMode(false)}
          completions={completions}
          width={Math.max(60, Math.min(columns - 2, 140))}
        />
      </Box>
    );
  } else {
    content = (
      <Box flexDirection="column" minHeight={Math.max(5, rows - 9)}>
        {tabIndex === 0 && <DashboardPage {...sharedProps} />}
        {tabIndex === 1 && <TemplatesPage {...sharedProps} enabled={gated} />}
        {tabIndex === 2 && <SessionsPage {...sharedProps} enabled={gated} />}
        {tabIndex === 3 && <ExtensionsPage {...sharedProps} />}
        {tabIndex === 4 && <ConfigPage {...sharedProps} />}
      </Box>
    );
  }

  // ── Tips 层：确认框 + 通知 + 快捷键提示 ─────────────────
  const tipsExtra = (
    <>
      {confirmAction && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold>{confirmAction.message} (y/n)</Text>
        </Box>
      )}
      {notification && <Text>{notification}</Text>}
    </>
  );

  return (
    <Screen
      title="Pi-Triple Control"
      version="0.1.0"
      tabs={outputLines || commandMode ? undefined : TABS}
      activeTab={activeTab}
      onTabSelect={setActiveTab}
      hints={`[1-5] Tab · [/] Command · /quit 退出${outputLines ? " · [Esc] Back" : ""}`}
    >
      <Box flexDirection="column" width={commandMode ? undefined : safeW} paddingX={1}>
        {content}
        {tipsExtra}
      </Box>
    </Screen>
  );
}
