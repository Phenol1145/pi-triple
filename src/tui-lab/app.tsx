/**
 * tui-lab/app — 主组件
 *
 * 5 个 Tab：Telemetry / Arena / Events / Compare / Config
 */
import React, { useCallback, useMemo, useEffect, useState } from "react";
import { Box, useInput } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { openReadOnlyOrNull, sharedDbPath, localDbPath } from "../lab-data/index.js";
import { useTabs, useRefresh, Screen } from "../tui-shared/index.js";
import { TelemetryPage } from "./telemetry.js";
import { ArenaPage } from "./arena.js";
import { EventsPage } from "./events.js";
import { ComparePage } from "./compare.js";
import { LabConfigPage } from "./lab-config.js";

interface Props {
  tenantId: string;
  tenantAlias: string;
  globalTelemetry: boolean;
}

const TABS = ["Telemetry", "Arena", "Events", "Compare", "Config"];

export function LabApp({ tenantId, tenantAlias, globalTelemetry }: Props) {
  const { activeTab, tabIndex } = useTabs(TABS);
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
      const p = localDbPath(tenantId);
      return openReadOnlyOrNull(p);
    } catch {
      return null;
    }
  }, [tenantId]);

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
    if (input === "q" && !key.ctrl) process.exit(0);
    if (input === "r" && !key.ctrl) refresh();
  });

  const effectiveTenant = globalTelemetry ? undefined : tenantId;

  return (
    <Screen
      title="Agent Lab Monitor"
      status={`tenant: ${tenantAlias}${globalTelemetry ? " (global)" : ""} | DB: ${sharedDb ? "connected" : "offline"}`}
      tabs={TABS}
      activeTab={activeTab}
      hints={`[1-${TABS.length}] Tab  [r] Refresh  [q] Quit`}
    >
      {activeTab === "Telemetry" && (
        <TelemetryPage
          db={sharedDb}
          tenantId={effectiveTenant}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "Arena" && (
        <ArenaPage db={localDb} refreshKey={refreshKey} tenantAlias={tenantAlias} />
      )}
      {activeTab === "Events" && (
        <EventsPage db={localDb} refreshKey={refreshKey} />
      )}
      {activeTab === "Compare" && (
        <ComparePage db={sharedDb} tenantId={effectiveTenant} refreshKey={refreshKey} />
      )}
      {activeTab === "Config" && (
        <LabConfigPage db={localDb} refreshKey={refreshKey} />
      )}
    </Screen>
  );
}
