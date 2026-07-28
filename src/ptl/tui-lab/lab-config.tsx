/**
 * tui-lab/lab-config — Lab 配置查看
 *
 * 数据源：per-tenant DB（config / role_pin 表）
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { DataTable } from "../tui-shared/data-table.js";
import type { ColumnDef } from "../tui-shared/data-table.js";

interface Props {
  db: DatabaseSync | null;
  refreshKey: number;
}

const PIN_COLS: ColumnDef[] = [
  { key: "role", label: "ROLE", width: 20 },
  { key: "model", label: "MODEL", width: 30 },
  { key: "updated", label: "UPDATED", width: 22 },
];

const CONFIG_COLS: ColumnDef[] = [
  { key: "key", label: "KEY", width: 28 },
  { key: "value", label: "VALUE", width: 50 },
];

export function LabConfigPage({ db, refreshKey }: Props) {
  const pins = useMemo(() => {
    if (!db) return [];
    try {
      const rows = db.prepare(`SELECT role, model, updated_ts FROM role_pin ORDER BY role`).all() as unknown as Array<{
        role: string;
        model: string;
        updated_ts: number;
      }>;
      return rows.map((r) => ({
        role: r.role,
        model: r.model,
        updated: r.updated_ts ? new Date(r.updated_ts).toLocaleString() : "unknown",
      }));
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, db]);

  const configEntries = useMemo(() => {
    if (!db) return [];
    try {
      const rows = db.prepare(`SELECT key, value FROM config ORDER BY key`).all() as unknown as Array<{
        key: string;
        value: string;
      }>;
      return rows.map((r) => ({
        key: r.key,
        value: truncate(r.value, 50),
      }));
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, db]);

  if (!db) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Local config DB not available.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Pins */}
      <Box marginBottom={1}>
        <Text bold>Role Pins</Text>
        <Text dimColor> — {pins.length} entries</Text>
      </Box>
      {pins.length === 0 ? (
        <Text dimColor>No role pins set. Use /lab pin &lt;role&gt; &lt;model&gt; to pin a model.</Text>
      ) : (
        <DataTable columns={PIN_COLS} rows={pins} />
      )}

      {/* Config */}
      <Box marginTop={1} marginBottom={1}>
        <Text bold>Config</Text>
        <Text dimColor> — {configEntries.length} entries</Text>
      </Box>
      {configEntries.length === 0 ? (
        <Text dimColor>No config entries found.</Text>
      ) : (
        <DataTable columns={CONFIG_COLS} rows={configEntries} />
      )}

      {/* Scheduler status from config */}
      <Box marginTop={1}>
        <Text dimColor>
          Scheduler: {configEntries.find((e) => e.key === "scheduler.enabled")?.value === "true" ? "✅ enabled" : "⏸ disabled"} · Arena: check /lab scheduler status in pi session
        </Text>
      </Box>
    </Box>
  );
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}
