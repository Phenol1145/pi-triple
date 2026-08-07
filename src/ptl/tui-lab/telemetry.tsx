/**
 * tui-lab/telemetry — 遥测仪表盘
 *
 * 数据源：共享 DB（runs 表）
 * TREND 列：真实 7 日成功率 sparkline（dailyTrend 按天分桶，本地日，空日补 0）。
 * 选择：DataTable 受控选择（无窗口切片 → 索引即绝对索引）；选中行底部渲染 LineChart。
 */
import React, { useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { aggregateByRole, dailyTrend } from "../lab-data/telemetry.js";
import { DataTable, LineChart, useTableSelection } from "../tui-shared/index.js";
import type { ColumnDef } from "../tui-shared/data-table.js";

interface Props {
  db: DatabaseSync | null;
  templateId: string | undefined;
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

export function TelemetryPage({ db, templateId, refreshKey }: Props) {
  const data = useMemo(() => {
    if (!db) return { rows: [], trend: [] as number[] };

    const agg = aggregateByRole(db, undefined, templateId, 7);

    // 真实 7 日趋势：runs 表按天分桶（接口无 role/model 维度 → 模板级单序列，空日补 0）
    const trend = dailyTrend(db, templateId, 7).map((t) => t.successRate);

    const rows = agg.slice(0, 50).map((r) => ({
      role: r.role,
      model: r.model,
      runs: String(r.runs),
      success: (r.avgSuccess * 100).toFixed(1) + "%",
      avgTokens: r.runs > 0 ? String(Math.round((r.totalTokensIn + r.totalTokensOut) / r.runs)) : "0",
      avgCost: r.avgCost != null ? "$" + r.avgCost.toFixed(4) : "n/a",
    }));

    return { rows, trend };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, templateId, db]);

  const sel = useTableSelection(data.rows.length);

  useInput((input, key) => {
    if (key.upArrow) {
      sel.move(-1);
      return;
    }
    if (key.downArrow) {
      sel.move(1);
      return;
    }
  });

  if (!db) {
    return (
      <Box flexDirection="column">
        <Text dimColor>共享遥测 DB 不可用 — 确保 AGENT_LAB_DB_PATH 已设置或运行 ptl onboard</Text>
      </Box>
    );
  }

  if (data.rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>暂无遥测数据 — 运行 ptl flow submit 生成数据</Text>
      </Box>
    );
  }

  const selected = data.rows[sel.index];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          {templateId ? "Filtered to current tenant" : "Global — all templates"} | 7-day window | {data.rows.length} entries
        </Text>
      </Box>

      <DataTable
        columns={COLUMNS}
        rows={data.rows.map((r) => ({
          ...r,
          trend: renderSpark(data.trend),
        }))}
        selectable
        selectedIndex={sel.index}
        onSelectionChange={sel.setIndex}
        rowColor={(row) => {
          const pct = parseFloat(String(row.success ?? "0").replace("%", "")) || 0;
          if (pct >= 95) return "green";
          if (pct >= 85) return "yellow";
          return undefined;
        }}
      />

      {selected ? (
        <Box marginTop={1} flexDirection="column">
          <LineChart
            points={data.trend}
            width={60}
            height={8}
            label={`7日成功率 · ${selected.role}/${selected.model}`}
          />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择行 · r 刷新 · / 命令 · /quit 退出</Text>
      </Box>
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
