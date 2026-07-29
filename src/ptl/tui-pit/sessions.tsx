import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import {
  DataTable,
  SelectList,
  ConfirmDialog,
} from "../tui-shared/index.js";
import type { ColumnDef, SelectItem } from "../tui-shared/index.js";
import {
  loadConfig,
  listTemplates,
  getTemplateAlias,
} from "../config.js";
import { buildPiLaunch } from "../launcher.js";
import {
  listPitSessions,
  formatAge,
  killPitSession,
  buildTmuxSessionArgs,
  startPitSession,
  type PitSession,
} from "../tmux.js";

interface SessionsPageProps {
  width: number;
  height: number;
  unmount?: () => void;
  enabled?: boolean;
}

export function handoffTerminal(cmd: string, args: string[], unmount?: () => void) {
  if (unmount) unmount();
  process.stdin.pause();
  const result = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" } });
  process.exit(result.status ?? 0);
}

export function SessionsPage({ width, height: _h, unmount, enabled = true }: SessionsPageProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<"list" | "start-template" | "delete-confirm">("list");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PitSession[]>([]);

  // Defer tmux I/O off the render path
  useEffect(() => { setSessions(listPitSessions()); }, []);
  const refreshSessions = () => setSessions(listPitSessions());

  const config = loadConfig();
  const templates = listTemplates(config);

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
        // tmux 内：switch-client 瞬移（ pit ui 保持运行）；tmux 外：attach（handoff）
        if (process.env.TMUX) {
          spawnSync("tmux", ["switch-client", "-t", `=pit-${sessions[selectedIdx].name}`]);
        } else {
          handoffTerminal("tmux", ["attach", "-t", `pit-${sessions[selectedIdx].name}`], unmount);
        }
        return;
      }
      if (input === "x" && sessions[selectedIdx]) {
        setDeleteTarget(sessions[selectedIdx].name);
        setMode("delete-confirm");
        return;
      }
      if (input === "s") { setMode("start-template"); return; }
      if (input === "r") { refreshSessions(); return; }
    }
    if (mode === "delete-confirm" && key.escape) {
      setMode("list");
      setDeleteTarget(null);
    }
    if (mode === "start-template" && key.escape) {
      setMode("list");
    }
  });

  if (mode === "delete-confirm" && deleteTarget) {
    return (
      <Box flexDirection="column" gap={1}>
        <ConfirmDialog
          message={`Stop session "${deleteTarget}"?`}
          onConfirm={() => {
            killPitSession(deleteTarget);
            refreshSessions();
            setMode("list");
            setDeleteTarget(null);
          }}
          onCancel={() => { setMode("list"); setDeleteTarget(null); }}
        />
      </Box>
    );
  }

  if (mode === "start-template") {
    const items: SelectItem[] = templates.map((t) => ({
      label: `${t.isDefault ? "★ " : "  "}${t.alias}`,
      value: t.id,
      hint: t.config.model || "",
    }));

    return (
      <Box flexDirection="column" gap={1}>
        <SelectList
          enabled={enabled}
          title="Select template to start session"
          items={items}
          onSelect={async (templateId) => {
            const alias = getTemplateAlias(templateId, config);
            const name = `${alias}-${Date.now().toString(36)}`;
            const launch = await buildPiLaunch(templateId, {});
            // B4 fix: use buildTmuxSessionArgs to inject PI_/AGENT_LAB_ env vars
            const session = `pit-${name}`;
            const args = buildTmuxSessionArgs(launch, session, false);
            handoffTerminal("tmux", args, unmount);
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
            <Text dimColor>↑↓ select · [a] attach/switch · [x] stop · [s] start new</Text>
          </Box>
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Hints:</Text>
        <Text dimColor>  - Inside tmux: [a] switches instantly (pit ui keeps running)</Text>
        <Text dimColor>  - Outside tmux: [a] attaches (pit ui exits) · pit detach 脱离</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[s] 启动 · [a] 接入 · [x] 停止 · / 命令模式</Text>
      </Box>
    </Box>
  );
}
