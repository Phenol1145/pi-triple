/**
 * tui-lab/app — 主组件
 *
 * 5 个 Tab：Telemetry / Arena / Events / Compare / Config
 */
import React, { useCallback, useMemo, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { openReadOnlyOrNull, sharedDbPath, localDbPath } from "../lab-data/index.js";
import { useTabs, useRefresh, Screen, useTerminalSize } from "../tui-shared/index.js";
import { CommandBar, type CmdNode } from "../tui-ptl/command-bar.js";
import { TelemetryPage } from "./telemetry.js";
import { EventsPage } from "./events.js";
import { ComparePage } from "./compare.js";
import { LabConfigPage } from "./lab-config.js";

interface Props {
  templateId: string;
  templateAlias: string;
  globalTelemetry: boolean;
}

const TABS = ["Telemetry", "Events", "Compare", "Config"];

/** lab 命令树（精简版） */
const LAB_COMMANDS: CmdNode[] = [
  { name: "refresh", desc: "立即刷新数据" },
  { name: "quit", desc: "退出 lab" },
  { name: "exit", desc: "退出 lab（同 quit）" },
];

export function LabApp({ templateId, templateAlias, globalTelemetry }: Props) {
  const { columns } = useTerminalSize();
  const [commandMode, setCommandMode] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  // 通知自动消失
  useEffect(() => {
    if (notification) {
      const t = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(t);
    }
  }, [notification]);

  const { activeTab, tabIndex } = useTabs(TABS, !commandMode);
  const [refreshKey, setRefreshKey] = useState(0);

  // Open DBs once via useMemo — avoids connection leak on re-renders
  const sharedDb: DatabaseSync | null = useMemo(() => {
    try {
      const p = sharedDbPath();
      return openReadOnlyOrNull(p);
    } catch {
      return null;
    }
  }, []);

  const localDb: DatabaseSync | null = useMemo(() => {
    try {
      const p = localDbPath(templateId);
      return openReadOnlyOrNull(p);
    } catch {
      return null;
    }
  }, [templateId]);

  // Close DBs on unmount
  useEffect(() => {
    return () => {
      sharedDb?.close();
      localDb?.close();
    };
  }, [sharedDb, localDb]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 2s auto-refresh
  useRefresh(2000, refresh);

  useInput((input, key) => {
    if (key.ctrl && input === "c") process.exit(130);

    // 命令模式：CommandBar 处理所有输入
    if (commandMode) return;

    if ((input === "/" || input === ":") && !key.ctrl && !key.meta) {
      setCommandMode(true);
      return;
    }

    // q 不再直接退出——统一 /quit
    if (input === "q" && !key.ctrl) {
      setNotification("按 q 已停用——输入 /quit 退出（Ctrl+C 也可）");
      return;
    }
    if (input === "r" && !key.ctrl) refresh();
  });

  const effectiveTenant = globalTelemetry ? undefined : templateId;

  return (
    <Screen
      title="Agent Lab Monitor"
      status={`tenant: ${templateAlias}${globalTelemetry ? " (global)" : ""} | DB: ${sharedDb ? "connected" : "offline"}`}
      tabs={TABS}
      activeTab={activeTab}
      hints={`[1-${TABS.length}] Tab  [r] Refresh  [/] Command  /quit 退出`}
    >
      {activeTab === "Telemetry" && (
        <TelemetryPage
          db={sharedDb}
          templateId={effectiveTenant}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "Events" && (
        <EventsPage db={localDb} refreshKey={refreshKey} />
      )}
      {activeTab === "Compare" && (
        <ComparePage db={sharedDb} templateId={effectiveTenant} refreshKey={refreshKey} />
      )}
      {activeTab === "Config" && (
        <LabConfigPage db={localDb} refreshKey={refreshKey} />
      )}

      {commandMode && (
        <CommandBar
          visible={commandMode}
          commands={LAB_COMMANDS}
          width={Math.max(50, Math.min(columns - 2, 120))}
          onSubmit={(s) => {
            setCommandMode(false);
            const cmd = s.trim().split(/\s+/)[0];
            if (cmd === "quit" || cmd === "exit") process.exit(0);
            if (cmd === "refresh") refresh();
          }}
          onCancel={() => setCommandMode(false)}
        />
      )}

      {notification && <Text>{notification}</Text>}
    </Screen>
  );
}
