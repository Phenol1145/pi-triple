/**
 * tui-lab/events — 调度事件流
 *
 * 数据源：per-tenant DB（lab_events 表）
 */
import React, { useMemo, useRef, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { getRecentEvents, getEventTypes } from "../lab-data/events.js";
import type { EventRow } from "../lab-data/events.js";
import { DataTable } from "../tui-shared/data-table.js";
import type { ColumnDef } from "../tui-shared/data-table.js";

interface Props {
  db: DatabaseSync | null;
  refreshKey: number;
}

const EVENT_COLS: ColumnDef[] = [
  { key: "time", label: "TIME", width: 12 },
  { key: "type", label: "TYPE", width: 24 },
  { key: "traceId", label: "TRACE", width: 14 },
  { key: "summary", label: "DETAILS", width: 50 },
];

export function EventsPage({ db, refreshKey }: Props) {
  const [paused, setPaused] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [showFilter, setShowFilter] = useState(false);
  const lastTypeCount = useRef(0);

  useInput((input, key) => {
    if (key.ctrl) return;
    if (input === "p") {
      setPaused((p) => !p);
    }
    if (input === "f") {
      setShowFilter((s) => !s);
      setTypeFilter(null);
    }
  });

  const events = useMemo(() => {
    if (!db || paused) return [];
    const result = typeFilter
      ? getRecentEvents(db, 200).filter((e) => e.eventType === typeFilter)
      : getRecentEvents(db, 200);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, db, typeFilter]);

  const eventTypes = useMemo(() => {
    if (!db) return [];
    const types = getEventTypes(db);
    lastTypeCount.current = types.length;
    return types;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, refreshKey]);

  // Auto-filter: select first type on first load
  useEffect(() => {
    if (eventTypes.length > 0 && lastTypeCount.current === eventTypes.length && lastTypeCount.current > 0) {
      // Optional: auto-select first type
    }
  }, [eventTypes.length]);

  if (!db) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Local DB not available — no events to display.</Text>
      </Box>
    );
  }

  const rows = events.map((e) => ({
    time: formatTime(e.ts),
    type: e.eventType,
    traceId: truncate(e.traceId, 14),
    summary: buildSummary(e),
  }));

  return (
    <Box flexDirection="column">
      {/* Status bar */}
      <Box gap={2} marginBottom={1}>
        <Text dimColor>{paused ? "⏸ PAUSED" : "▶ LIVE"}</Text>
        {typeFilter ? <Text color="cyan">filter: {typeFilter}</Text> : null}
        <Text dimColor>{rows.length} events</Text>
        {eventTypes.length > 0 && (
          <Text dimColor>{eventTypes.length} types</Text>
        )}
      </Box>

      {/* Filter UI */}
      {showFilter && (
        <Box flexDirection="column" marginBottom={1} borderStyle="single" borderColor="gray" padding={1}>
          <Text dimColor>Event Types (press number to filter):</Text>
          <Box gap={1} flexWrap="wrap">
            {eventTypes.map((t, i) => (
              <Box key={t}>
                <Text dimColor={t !== typeFilter} color={t === typeFilter ? "cyan" : undefined}>
                  [{i + 1}] {t}
                </Text>
              </Box>
            ))}
          </Box>
          <Box>
            <Text dimColor>[0] clear filter  [f] close</Text>
          </Box>
        </Box>
      )}

      {rows.length === 0 ? (
        <Text dimColor>No events recorded yet.</Text>
      ) : (
        <DataTable
          columns={EVENT_COLS}
          rows={rows}
          rowColor={(row) => {
            const t = String(row.type ?? "");
            if (t.includes("error") || t.includes("fail")) return "red";
            if (t.includes("settle") || t.includes("dispatch")) return "green";
            return undefined;
          }}
        />
      )}
    </Box>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

function buildSummary(event: EventRow): string {
  try {
    const identity = event.identityJson ? JSON.parse(event.identityJson) : {};
    const role = identity?.role ?? identity?.agent ?? "";
    const model = identity?.model ?? identity?.winner ?? "";
    const parts: string[] = [];
    if (role) parts.push(role as string);
    if (model) parts.push(model as string);
    return parts.join(" → ") || event.eventId.slice(0, 12);
  } catch {
    return event.eventId.slice(0, 12);
  }
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}
