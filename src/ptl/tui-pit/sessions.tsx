import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { spawnSync } from "node:child_process";
import {
  DataTable,
  SelectList,
  ConfirmDialog,
  useTableSelection,
  tableWindow,
} from "../tui-shared/index.js";
import type { ColumnDef, SelectItem } from "../tui-shared/index.js";
import {
  loadConfig,
  listTemplates,
  getTemplateAlias,
} from "../config.js";
import { buildPiLaunch } from "../launcher.js";
import { listAllSessions } from "../session/session-store.js";
import type { SessionRecord } from "../session/session-provider.js";
import { SessionMenuPanel, sessionTmuxName, bareTmuxName } from "./session-menu.js";
import {
  killPitSession,
  buildTmuxSessionArgs,
} from "../tmux.js";

interface SessionsPageProps {
  width: number;
  height: number;
  unmount?: () => void;
  enabled?: boolean;
  onNotify?: (msg: string) => void;
  onCommand?: (cmd: string, args: string[]) => void;
  onMenuChange?: (open: boolean) => void;
}

export function handoffTerminal(cmd: string, args: string[], unmount?: () => void) {
  if (unmount) unmount();
  process.stdin.pause();
  const result = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" } });
  process.exit(result.status ?? 0);
}

export function SessionsPage({
  width,
  height,
  unmount,
  enabled = true,
  onNotify,
  onCommand,
  onMenuChange,
}: SessionsPageProps) {
  const [mode, setMode] = useState<"list" | "start-template" | "delete-confirm">("list");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [menuRecord, setMenuRecord] = useState<SessionRecord | null>(null);

  // 数据源：listAllSessions()（含已停止会话 + 状态列）
  useEffect(() => { setSessions(listAllSessions()); }, [refreshKey]);
  const refreshSessions = () => setRefreshKey((k) => k + 1);

  const config = loadConfig();
  const templates = listTemplates(config);
  const sel = useTableSelection(sessions.length, enabled);

  const sessionCols: ColumnDef[] = [
    { key: "status", label: "", width: 2 },
    { key: "workloop", label: "LOOP", width: 8 },
    { key: "template", label: "TEMPLATE", width: 16 },
    { key: "id", label: "ID" },
    { key: "summary", label: "SUMMARY" },
  ];

  const cap = Math.max(3, Math.floor((height ?? 24) / 4));
  const win = tableWindow(sessions, sel.index, cap);
  const sessionRows = win.rows.map((s) => ({
    status: s.status === "running" ? "●" : "○",
    workloop: s.workloop,
    template: s.templateAlias,
    id: s.id.slice(0, 8) + "…",
    summary: s.summary,
  }));

  // attach：tmux 内 switch-client 瞬移；tmux 外 handoff（pit attach 接管终端）
  const attachSession = (rec: SessionRecord) => {
    const full = sessionTmuxName(rec);
    if (!full) { onNotify?.("会话未在运行（tmux 无匹配）"); return; }
    if (process.env.TMUX) {
      spawnSync("tmux", ["switch-client", "-t", `=${full}`]);
    } else if (onCommand) {
      onCommand("session", ["attach", bareTmuxName(full)]);
    } else {
      handoffTerminal("tmux", ["attach", "-t", full], unmount);
    }
  };

  useInput((input, key) => {
    if (!enabled) return;
    if (menuRecord) return; // 模态菜单独占输入
    if (mode === "list") {
      if (key.upArrow) { sel.move(-1); return; }
      if (key.downArrow) { sel.move(1); return; }
      if (key.return && sessions[sel.index]) {
        setMenuRecord(sessions[sel.index]!);
        return;
      }
      if (input === "a" && sessions[sel.index]) {
        attachSession(sessions[sel.index]!);
        return;
      }
      if (input === "x" && sessions[sel.index]) {
        const full = sessionTmuxName(sessions[sel.index]!);
        if (!full) { onNotify?.("会话未在运行"); return; }
        setDeleteTarget(bareTmuxName(full));
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

  // 模态菜单：打开时独占面板
  if (menuRecord) {
    return (
      <SessionMenuPanel
        record={menuRecord}
        onClose={() => setMenuRecord(null)}
        onNotify={onNotify}
        onRefresh={refreshSessions}
        onCommand={onCommand}
        onMenuChange={onMenuChange}
      />
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold underline>Sessions ({sessions.length})</Text>
        <Text dimColor>[s] start  [a] attach  [x] stop  [r] refresh</Text>
      </Box>

      {sessions.length === 0 ? (
        <Text dimColor>  无会话 — 启动: pit start --bg --name &lt;name&gt;</Text>
      ) : (
        <>
          <DataTable
            columns={sessionCols}
            rows={sessionRows}
            selectable
            selectedIndex={sel.index - win.offset}
            onSelectionChange={sel.setIndex}
            rowColor={(r) => (r.status === "●" ? "green" : undefined)}
          />

          <Box marginTop={1}>
            <Text dimColor>↑↓ select · Enter 菜单 · [a] attach/switch · [x] stop · [s] start new</Text>
          </Box>
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Hints:</Text>
        <Text dimColor>  - 列表含已停止会话（○）；仅运行中（●）可 attach/stop</Text>
        <Text dimColor>  - Inside tmux: [a] switches instantly (pit ui keeps running)</Text>
        <Text dimColor>  - Outside tmux: [a] attaches (pit ui exits) · pit detach 脱离</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[s] 启动 · [a] 接入 · [x] 停止 · [r] 刷新 · Enter 菜单 · / 命令</Text>
      </Box>
    </Box>
  );
}
