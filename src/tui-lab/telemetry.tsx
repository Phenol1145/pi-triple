/**
 * tui-lab/telemetry — 遥测仪表盘
 *
 * 数据源：共享 DB（runs 表）
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { aggregateByRole } from "../lab-data/telemetry.js";
import { DataTable } from "../tui-shared/data-table.js";
import type { ColumnDef } from "../tui-shared/data-table.js";

interface Props {
  db: DatabaseSync | null;
  tenantId: string | undefined;
  refreshKey: number;
}

const COLUMNS: ColumnDef[] = [
  { key: "role", label: "ROLE", width: 14 },
  { key: "model", label: "MODEL", width: 28 },
  { key: "runs", label: "RUNS", width: 6, align: "right" },
  { key: "success", label: "SUCCESS%", width: 10, align: "right" },
  { key: "avgTokens", label: "AVG TOK", width: 8, align: "right" },
  { key: "avgCost", label: "COST/RUN", width: 10, align: "right" },
  { key: "trend", label: "TREND", width: 34 },
];

export function TelemetryPage({ db, tenantId, refreshKey }: Props) {
  const data = useMemo(() => {
    if (!db) return { rows: [], trendData: new Map<string, number[]>() };

    const agg = aggregateByRole(db, undefined, tenantId, 7);

    // Synthetic trend data: collect 7-day per-model success rates as SparkLine data points
    // We approximate by bucketing the aggregate data — refined in v2
    const trendMap = new Map<string, number[]>();
    for (const row of agg) {
      const key = `${row.role}:${row.model}`;
      // Show the avgSuccess as a single-point trend for now
      // In real implementation, we'd bucket by day
      trendMap.set(key, [row.avgSuccess * 100]);
    }

    const rows = agg.slice(0, 50).map((r) => ({
      role: r.role,
      model: r.model,
      runs: String(r.runs),
      success: (r.avgSuccess * 100).toFixed(1) + "%",
      avgTokens: r.runs > 0 ? String(Math.round((r.totalTokensIn + r.totalTokensOut) / r.runs)) : "0",
      avgCost: r.avgCost != null ? "$" + r.avgCost.toFixed(4) : "n/a",
      trend: trendMap.get(`${r.role}:${r.model}`) ?? [],
    }));

    return { rows, trendData: trendMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, tenantId, db]);

  if (!db) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Shared telemetry DB not available.</Text>
        <Text dimColor>Run pit onboard or ensure AGENT_LAB_DB_PATH is set.</Text>
      </Box>
    );
  }

  if (data.rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No telemetry data yet.</Text>
        <Text dimColor>Run agent-lab workloads to populate the runs table.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          {tenantId ? "Filtered to current tenant" : "Global — all tenants"} | 7-day window | {data.rows.length} entries
        </Text>
      </Box>

      <DataTable
        columns={COLUMNS}
        rows={data.rows.map((r) => ({
          ...r,
          trend: renderSpark(r.trend as number[]),
        }))}
        rowColor={(row) => {
          const pct = parseFloat(String(row.success ?? "0").replace("%", "")) || 0;
          if (pct >= 95) return "green";
          if (pct >= 85) return "yellow";
          return undefined;
        }}
      />
    </Box>
  );
}

/** Render a SparkLine inside a string slot for DataTable */
function renderSpark(data: number[]): string {
  if (data.length === 0) return "n/a";
  const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...data);
  const max = Math.max(...data);
  if (max - min < 0.01) return "n/a";
  let result = "";
  for (const val of data) {
    const pct = Math.max(0, Math.min(1, (val - min) / (max - min)));
    const idx = Math.round(pct * (SPARK.length - 1));
    result += SPARK[idx];
  }
  return result;
}
