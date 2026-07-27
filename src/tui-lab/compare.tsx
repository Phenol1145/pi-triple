/**
 * tui-lab/compare — 模型对比
 *
 * 数据源：共享 DB（runs 表），离线 SELECT DISTINCT model
 */
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { listModels, modelComparison } from "../lab-data/telemetry.js";
import { DataTable } from "../tui-shared/data-table.js";
import type { ColumnDef } from "../tui-shared/data-table.js";
import { SelectList } from "../tui-shared/select-list.js";

interface Props {
  db: DatabaseSync | null;
  tenantId: string | undefined;
  refreshKey: number;
}

const COMPARE_COLS: ColumnDef[] = [
  { key: "metric", label: "METRIC", width: 22 },
  { key: "modelA", label: "MODEL A", width: 18, align: "right" },
  { key: "modelB", label: "MODEL B", width: 18, align: "right" },
];

type Step = "select-a" | "select-b" | "compare";

export function ComparePage({ db, tenantId, refreshKey }: Props) {
  const [step, setStep] = useState<Step>("select-a");
  const [modelA, setModelA] = useState<string>("");
  const [modelB, setModelB] = useState<string>("");

  const models = useMemo(() => {
    if (!db) return [];
    return listModels(db);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, db]);

  const comparison = useMemo(() => {
    if (!db || !modelA || !modelB) return [];
    return modelComparison(db, modelA, modelB, tenantId, 7);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelA, modelB, refreshKey, db, tenantId]);

  useInput((input, key) => {
    if (key.escape && step !== "select-a") {
      setStep("select-a");
      setModelA("");
      setModelB("");
    }
  });

  if (!db) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Shared telemetry DB not available.</Text>
      </Box>
    );
  }

  if (models.length < 2) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Need at least 2 models with telemetry data to compare.</Text>
        <Text dimColor>Found: {models.length} model(s).</Text>
      </Box>
    );
  }

  if (step === "select-a") {
    return (
      <Box flexDirection="column">
        <Text bold>Select Model A</Text>
        <SelectList
          items={models.map((m) => ({ label: m, value: m }))}
          onSelect={(v) => {
            setModelA(v);
            setStep("select-b");
          }}
        />
      </Box>
    );
  }

  if (step === "select-b") {
    return (
      <Box flexDirection="column">
        <Text bold>Model A: {modelA}</Text>
        <Text bold>Select Model B</Text>
        <Text dimColor>Esc to go back</Text>
        <SelectList
          items={models
            .filter((m) => m !== modelA)
            .map((m) => ({ label: m, value: m }))}
          onSelect={(v) => {
            setModelB(v);
            setStep("compare");
          }}
        />
      </Box>
    );
  }

  // Compare view
  const rows = comparison.map((c) => ({
    metric: c.metric,
    modelA: c.modelA,
    modelB: c.modelB,
  }));

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} gap={1}>
        <Text color="cyan">Model A: {modelA}</Text>
        <Text dimColor>vs</Text>
        <Text color="magenta">Model B: {modelB}</Text>
      </Box>

      <Text dimColor>
        {tenantId ? "Filtered to current tenant · " : "Global · "}7-day window
      </Text>

      <Box marginTop={1} marginBottom={1}>
        <DataTable
          columns={COMPARE_COLS}
          rows={rows}
          rowColor={(row) => {
            const metric = String(row.metric ?? "");
            if (metric === "Success %" || metric === "Tool Success %") {
              const a = parseFloat(String(row.modelA ?? "").replace("%", "").replace("$", "")) || 0;
              const b = parseFloat(String(row.modelB ?? "").replace("%", "").replace("$", "")) || 0;
              if (Math.abs(a - b) > 3) return a > b ? "green" : "red";
            }
            return undefined;
          }}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Esc: back to selection  [r] refresh</Text>
      </Box>
    </Box>
  );
}
