import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Screen, useTabs, useTerminalSize } from "../tui-shared/index.js";
import { DashboardPage } from "./dashboard.js";
import { TenantsPage } from "./tenants.js";
import { SessionsPage } from "./sessions.js";
import { ExtensionsPage } from "./extensions.js";
import { ConfigPage } from "./config-page.js";
import { CommandBar } from "./command-bar.js";
import { OutputPanel } from "./output-panel.js";
import type { CommandResult } from "../commands.js";
import { loadConfig, listTenants } from "../config.js";
import { spawnSync } from "node:child_process";

const TABS = ["Dashboard", "Tenants", "Sessions", "Extensions", "Config"];

const DESTRUCTIVE_CMDS = ["tenant rm", "stop", "stop --all"];

/** TUI-wired bg session start — 与 CLI 同一构建路径 */
async function execStartBgInTui(name: string, tenantInput: string): Promise<CommandResult> {
  const cfg = loadConfig();
  const { resolveTenantId: rt, getDefaultTenantId: gd, getTenantAlias: ga } = await import("../config.js");
  const resolved = tenantInput ? rt(tenantInput, cfg) : { ok: true as const, id: gd(cfg) };
  if (!resolved.ok) {
    return { ok: false, message: "", error: { code: "TENANT_NOT_FOUND", message: `租户 "${tenantInput}" 不存在` } };
  }
  const tenantId = resolved.id;
  const sessionName = name || `${ga(tenantId, cfg)}-${Date.now().toString(36)}`;
  const tmuxName = `pit-${sessionName}`;
  const check = spawnSync("tmux", ["has-session", "-t", `=${tmuxName}`], { encoding: "utf-8" });
  if (check.status === 0) {
    return { ok: false, message: "", error: { code: "SESSION_EXISTS", message: `会话 "${sessionName}" 已在运行。接入: pit attach ${sessionName}` } };
  }
  const { buildPiLaunch } = await import("../launcher.js");
  const tenantConfig = cfg.tenants[tenantId] ?? {};
  const launch = await buildPiLaunch(tenantId, {
    provider: tenantConfig.provider,
    model: tenantConfig.model,
    thinking: tenantConfig.thinking,
    tools: tenantConfig.tools,
    excludeTools: tenantConfig.excludeTools,
  });
  const tmuxArgs = ["new-session", "-d", "-s", tmuxName, "-c", launch.cwd, "-x", "200", "-y", "50"];
  for (const [k, v] of Object.entries(launch.env)) {
    if (k.startsWith("PI_") || k.startsWith("AGENT_LAB_")) tmuxArgs.push("-e", `${k}=${v}`);
  }
  tmuxArgs.push("--", launch.cmd, ...launch.args);
  const r = spawnSync("tmux", tmuxArgs, { encoding: "utf-8" });
  if (r.status === 0) {
    return { ok: true, message: `✅ 后台会话 "${sessionName}" 已启动\n接入: pit attach ${sessionName}` };
  }
  return { ok: false, message: "", error: { code: "TMUX_ERROR", message: `启动失败: ${r.stderr}` } };
}

export function PitApp() {
  const { columns, rows } = useTerminalSize();
  const { exit: unmountInk } = useApp();
  const [notification, setNotification] = useState<string | null>(null);
  const [commandMode, setCommandMode] = useState(false);
  const [outputLines, setOutputLines] = useState<string[] | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);

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
    const tenantAliases = listTenants(cfg).map((t) => t.alias);
    let sessions: string[] = [];
    try {
      const out = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf-8" });
      sessions = (out.stdout ?? "").trim().split("\n")
        .filter((s) => s.startsWith("pit-"))
        .map((s) => s.replace(/^pit-/, ""));
    } catch { /* tmux not available */ }
    return {
      pi: ["--tenant", ...tenantAliases],
      attach: sessions,
      switch: sessions,
      stop: [...sessions, "--all"],
      "tenant rm": tenantAliases,
      "tenant rename": tenantAliases,
    };
  }, [commandMode]); // refresh when command bar opens

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

  async function doExecuteCommand(cmd: string, args: string[], cmdStr: string): Promise<void> {
    let result: CommandResult;

    try {
    // Route to commands.ts functions
    const { execTenantLs, execTenantNew, execTenantRm, execStatus, execLs, execStop, execSharedStatus } = await import("../commands.js");

    switch (cmd) {
      case "tenant":
        if (args[0] === "ls" || args[0] === "list") result = await execTenantLs();
        else if (args[0] === "new") result = await execTenantNew(args[1]);
        else if (args[0] === "rm") result = await execTenantRm(args[1]);
        else if (args[0] === "rename") {
          const { loadConfig: lc, resolveTenantId: rt, renameTenant: rn } = await import("../config.js");
          const cfg = lc();
          const resolved = rt(args[1] ?? "", cfg);
          if (!resolved.ok) result = { ok: false, message: "", error: { code: "TENANT_NOT_FOUND", message: `租户 "${args[1]}" 不存在` } };
          else if (!args[2]) result = { ok: false, message: "", error: { code: "INVALID_ARGS", message: "用法: tenant rename <旧别名> <新别名>" } };
          else {
            const ok = rn(resolved.id, args[2], cfg);
            result = ok
              ? { ok: true, message: `✅ 租户别名: ${args[1]} → ${args[2]}` }
              : { ok: false, message: "", error: { code: "RENAME_FAILED", message: "重命名失败（别名重复或无效）" } };
          }
        }
        else result = await execTenantLs();
        break;
      case "pi":
        result = { ok: true, message: "", handoff: { cmd: "pit", args: ["pi", ...args] } };
        break;
      case "start":
        result = await execStartBgInTui(args[0] || "", args[1] || "");
        break;
      case "quit":
      case "exit":
        process.exit(0);
        break;
      case "help":
        result = {
          ok: true,
          message: [
            "Available commands:",
            "  pi [args]                 原生前台启动 pi（无 tmux）",
            "  start <bg-name> <tenant>   启动后台会话",
            "  attach <name>             接入后台会话",
            "  stop <name>               停止会话",
            "  ls                        列出后台会话",
            "  status                    健康检查",
            "  tenant ls                 列出租户",
            "  tenant new <alias>        新建租户",
            "  tenant rm <alias>         删除租户",
            "  shared status             共享层状态",
            "  help                      此帮助",
            "  quit                      退出 pit ui",
            "  switch <name>             切换会话（tmux 内）",
            "  detach                    脱离当前会话",
          ].join("\n"),
        };
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
        result = { ok: true, message: "", handoff: { cmd: "pit", args: ["attach", ...args] } };
        break;
      case "switch":
        result = { ok: true, message: "", handoff: { cmd: "pit", args: ["switch", ...args] } };
        break;
      case "detach": {
        const r2 = spawnSync("tmux", ["detach-client"], { encoding: "utf-8" });
        result = r2.status === 0
          ? { ok: true, message: "已脱离当前会话" }
          : { ok: false, message: "", error: { code: "NOT_IN_TMUX", message: "不在 tmux 会话中" } };
        break;
      }
      default:
        result = { ok: false, message: "", error: { code: "UNKNOWN_COMMAND", message: `未知命令: ${cmd}。支持: start, status, ls, stop, tenant, shared, attach, help` } };
    }

    } catch (err: any) {
      setNotification(`\x1b[31m❌ 命令执行错误: ${err?.message ?? err}\x1b[0m`);
      return;
    }

    if (result.handoff) {
      try { process.stdin.setRawMode(false); } catch { /* not a TTY */ }
      unmountInk();
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
      setOutputLines(lines);
    }
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
          {tabIndex === 1 && <TenantsPage {...sharedProps} enabled={false} />}
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
        {tabIndex === 1 && <TenantsPage {...sharedProps} enabled={gated} />}
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
