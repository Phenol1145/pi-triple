import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import {
  DataTable,
  SelectList,
  ConfirmDialog,
  theme,
} from "../tui-shared/index.js";
import type { ColumnDef, SelectItem } from "../tui-shared/index.js";
import {
  loadConfig,
  listTenants,
  resolveTenantId,
  getTenantAlias,
} from "../config.js";
import { buildPiLaunch } from "../launcher.js";

interface SessionsPageProps {
  width: number;
  height: number;
  unmount?: () => void;
  enabled?: boolean;
}

interface TmuxSession {
  name: string;
  windows: number;
  created: Date;
}

function hasTmux(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
}

function listTmuxSessions(): TmuxSession[] {
  if (!hasTmux()) return [];
  const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_created}"], { encoding: "utf-8" });
  return (result.stdout ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("pit-"))
    .map((l) => {
      const [full, win, created] = l.split(":");
      return {
        name: full.replace(/^pit-/, ""),
        windows: parseInt(win ?? "1", 10),
        created: new Date(parseInt(created ?? "0", 10) * 1000),
      };
    });
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

export function handoffTerminal(cmd: string, args: string[], unmount?: () => void) {
  if (unmount) unmount();
  process.stdin.pause();
  const result = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" } });
  process.exit(result.status ?? 0);
}

export function SessionsPage({ width, height: _h, unmount, enabled = true }: SessionsPageProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<"list" | "start-tenant" | "delete-confirm">("list");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);

  // Defer tmux I/O off the render path
  useEffect(() => { setSessions(listTmuxSessions()); }, []);
  const refreshSessions = () => setSessions(listTmuxSessions());

  const config = loadConfig();
  const tenants = listTenants(config);

  const sessionCols: ColumnDef[] = [
    { key: "name", label: "NAME", width: 18 },
    { key: "windows", label: "WIN", width: 5 },
    { key: "age", label: "CREATED", width: 12 },
  ];

  const sessionRows = sessions.map((s) => ({
    name: s.name,
    windows: String(s.windows),
    age: formatAge(Date.now() - s.created.getTime()),
  }));

  useInput((input, key) => {
    if (!enabled) return;
    if (mode === "list") {
      if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSelectedIdx((i) => Math.min(sessions.length - 1, i + 1)); return; }
      if (input === "a" && sessions[selectedIdx]) {
        handoffTerminal("tmux", ["attach", "-t", `pit-${sessions[selectedIdx].name}`], unmount);
        return;
      }
      if (input === "x" && sessions[selectedIdx]) {
        setDeleteTarget(sessions[selectedIdx].name);
        setMode("delete-confirm");
        return;
      }
      if (input === "s") { setMode("start-tenant"); return; }
      if (input === "r") { refreshSessions(); return; }
    }
    if (mode === "delete-confirm" && key.escape) {
      setMode("list");
      setDeleteTarget(null);
    }
    if (mode === "start-tenant" && key.escape) {
      setMode("list");
    }
  });

  if (mode === "delete-confirm" && deleteTarget) {
    return (
      <Box flexDirection="column" gap={1}>
        <ConfirmDialog
          message={`Stop session "${deleteTarget}"?`}
          onConfirm={() => {
            spawnSync("tmux", ["kill-session", "-t", `pit-${deleteTarget}`]);
            refreshSessions();
            setMode("list");
            setDeleteTarget(null);
          }}
          onCancel={() => { setMode("list"); setDeleteTarget(null); }}
        />
      </Box>
    );
  }

  if (mode === "start-tenant") {
    const items: SelectItem[] = tenants.map((t) => ({
      label: `${t.isDefault ? "★ " : "  "}${t.alias}`,
      value: t.id,
      hint: t.config.model || "",
    }));

    return (
      <Box flexDirection="column" gap={1}>
        <SelectList
          enabled={enabled}
          title="Select tenant to start session"
          items={items}
          onSelect={async (tenantId) => {
            const launch = await buildPiLaunch(tenantId, {});
            handoffTerminal(
              "tmux",
              [
                "new-session",
                "-s",
                `pit-${getTenantAlias(tenantId, config)}-${Date.now().toString(36)}`,
                "-c",
                launch.cwd,
                "-x", "200", "-y", "50",
                "--",
                launch.cmd,
                ...launch.args,
              ],
              unmount,
            );
          }}
          onCancel={() => setMode("list")}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold underline>Background Sessions ({sessions.length})</Text>
        <Text dimColor>[s] start  [a] attach  [x] stop  [r] refresh</Text>
      </Box>

      {sessions.length === 0 ? (
        <Text dimColor>  No background sessions. Press [s] to start one.</Text>
      ) : (
        <>
          <DataTable columns={sessionCols} rows={sessionRows} />

          <Box marginTop={1}>
            <Text dimColor>↑↓ select · [a] attach · [x] stop · [s] start new</Text>
          </Box>
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Hints:</Text>
        <Text dimColor>  - Attaching hands off terminal (pit TUI exits)</Text>
        <Text dimColor>  - Inside tmux: Ctrl+B s to switch sessions, Ctrl+B d to detach</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[s] 启动 · [a] 接入 · [x] 停止 · / 命令模式</Text>
      </Box>
    </Box>
  );
}
