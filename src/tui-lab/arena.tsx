/**
 * tui-lab/arena — Arena 经济面板
 *
 * 数据源：per-tenant DB（credits / market_tasks / arena_freezes 表）
 */
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { DatabaseSync } from "node:sqlite";
import { getBalances, getRecentSettlements, getFrozenTasks } from "../lab-data/arena.js";
import { DataTable } from "../tui-shared/data-table.js";
import type { ColumnDef } from "../tui-shared/data-table.js";

interface Props {
  db: DatabaseSync | null;
  refreshKey: number;
  tenantAlias: string;
}

const BALANCE_COLS: ColumnDef[] = [
  { key: "agent", label: "AGENT", width: 24 },
  { key: "balance", label: "BALANCE", width: 10, align: "right" },
  { key: "frozen", label: "FROZEN", width: 10, align: "right" },
  { key: "wins", label: "WINS", width: 8, align: "right" },
  { key: "losses", label: "LOSSES", width: 8, align: "right" },
];

const SETTLE_COLS: ColumnDef[] = [
  { key: "taskId", label: "TASK ID", width: 16 },
  { key: "role", label: "ROLE", width: 12 },
  { key: "winner", label: "WINNER", width: 22 },
  { key: "stake", label: "STAKE", width: 8, align: "right" },
  { key: "status", label: "STATUS", width: 12 },
  { key: "created", label: "CREATED", width: 20 },
];

export function ArenaPage({ db, refreshKey, tenantAlias }: Props) {
  const balances = useMemo(() => {
    if (!db) return [];
    return getBalances(db);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, db]);

  const settlements = useMemo(() => {
    if (!db) return [];
    return getRecentSettlements(db, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, db]);

  const frozen = useMemo(() => {
    if (!db) return [];
    return getFrozenTasks(db);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, db]);

  if (!db) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Local Arena DB not available for tenant: {tenantAlias}</Text>
      </Box>
    );
  }

  if (balances.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Arena not initialized for tenant: {tenantAlias}</Text>
        <Text dimColor>Start agent-lab workloads to create agents and begin bidding.</Text>
      </Box>
    );
  }

  const balanceRows = balances.map((b) => ({
    agent: truncate(b.agent, 24),
    balance: String(Math.round(b.balance)),
    frozen: b.frozen > 0 ? String(Math.round(b.frozen)) : "0",
    wins: String(b.wins),
    losses: String(b.losses),
  }));

  const settleRows = settlements.map((s) => ({
    taskId: truncate(s.taskId, 16),
    role: s.role,
    winner: truncate(s.winner, 22),
    stake: String(s.stake),
    status: s.status,
    created: new Date(s.createdTs).toLocaleString(),
  }));

  const frozenRows = frozen.map((f) => ({
    taskId: truncate(f.taskId, 16),
    agent: truncate(f.agent, 24),
    amount: String(f.amount),
    created: new Date(f.createdTs).toLocaleString(),
  }));

  return (
    <Box flexDirection="column">
      {/* Balances */}
      <Box marginBottom={1}>
        <Text bold>Agent Balances</Text>
        <Text dimColor> — {balances.length} agents</Text>
      </Box>
      <DataTable
        columns={BALANCE_COLS}
        rows={balanceRows}
        rowColor={(row) => {
          const frozen = parseInt(String(row.frozen ?? "0")) || 0;
          if (frozen > 0) return "yellow";
          return undefined;
        }}
      />

      {/* Frozen */}
      {frozenRows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box marginBottom={1}>
            <Text bold>Frozen Stakes</Text>
            <Text dimColor> — {frozenRows.length} active</Text>
          </Box>
          <DataTable
            columns={[
              { key: "taskId", label: "TASK ID", width: 16 },
              { key: "agent", label: "AGENT", width: 24 },
              { key: "amount", label: "AMOUNT", width: 8, align: "right" },
              { key: "created", label: "CREATED", width: 20 },
            ]}
            rows={frozenRows}
          />
        </Box>
      )}

      {/* Settlements */}
      {settleRows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box marginBottom={1}>
            <Text bold>Recent Settlements</Text>
            <Text dimColor> — {settleRows.length} entries</Text>
          </Box>
          <DataTable
            columns={SETTLE_COLS}
            rows={settleRows}
            rowColor={(row) => {
              if (row.status === "settled") return "green";
              if (row.status === "failed") return "red";
              return undefined;
            }}
          />
        </Box>
      )}
    </Box>
  );
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}
