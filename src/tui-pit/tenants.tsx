import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import fs from "node:fs";
import path from "node:path";
import {
  DataTable,
  SelectList,
  ConfirmDialog,
  theme,
} from "../tui-shared/index.js";
import type { ColumnDef, SelectItem } from "../tui-shared/index.js";
import {
  loadConfig,
  listTenants,
  createTenant,
  removeTenant,
  saveConfig,
  resolveTenantId,
  getTenantAlias,
  resolveDataDir,
} from "../config.js";

interface TenantsPageProps {
  width: number;
  height: number;
}

type Mode = "list" | "new-alias" | "delete-confirm";

export function TenantsPage({ width, height: _h }: TenantsPageProps) {
  const [mode, setMode] = useState<Mode>("list");
  const [aliasInput, setAliasInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteAlias, setDeleteAlias] = useState("");
  const config = loadConfig();
  const tenants = listTenants(config);

  useInput((input, key) => {
    if (mode === "list") {
      if (input === "n") { setMode("new-alias"); setAliasInput(""); return; }
      if (input === "d") return; // handled per-row via select
      if (input === "s") return; // handled per-row via select
      if (key.escape && mode === "list") return; // parent handles quit
    }
    if (mode === "new-alias") {
      if (key.return) {
        if (aliasInput.trim()) {
          const id = createTenant(aliasInput.trim(), {}, config);
          const dir = path.join(resolveDataDir(config), "pi-config", id);
          fs.mkdirSync(dir, { recursive: true });
          setMode("list");
          setAliasInput("");
        }
        return;
      }
      if (key.escape) { setMode("list"); setAliasInput(""); return; }
      if (key.backspace) { setAliasInput((s) => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setAliasInput((s) => s + input); return; }
    }
  });

  const tenantCols: ColumnDef[] = [
    { key: "alias", label: "ALIAS", width: 16 },
    { key: "id", label: "ID" },
    { key: "model", label: "MODEL", width: 22 },
    { key: "default", label: "DEF", width: 5 },
  ];

  const tenantRows = tenants.map((t) => ({
    alias: t.alias,
    id: t.id.slice(0, 8) + "…",
    model: t.config.model ?? "(default)",
    default: t.isDefault ? "★" : "",
  }));

  // Convert to SelectList items
  const selectItems: SelectItem[] = tenants.map((t) => ({
    label: `${t.isDefault ? "★ " : "  "}${t.alias.padEnd(16)} ${t.id.slice(0, 8)}…`,
    value: t.id,
    hint: t.config.model || "",
  }));

  const handleSetDefault = (tenantId: string) => {
    const cfg = loadConfig();
    cfg.defaultTenant = tenantId;
    saveConfig(cfg);
    setMode("list");
  };

  if (mode === "new-alias") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>New Tenant</Text>
        <Box>
          <Text color={theme.primary}>Alias: </Text>
          <Text>{aliasInput}</Text>
          <Text dimColor>█</Text>
        </Box>
        <Text dimColor>Enter to confirm, Esc to cancel</Text>
      </Box>
    );
  }

  if (mode === "delete-confirm" && deleteTarget) {
    return (
      <Box flexDirection="column" gap={1}>
        <ConfirmDialog
          message={`Delete tenant "${deleteAlias}" and all its data?`}
          onConfirm={() => {
            const cfg = loadConfig();
            removeTenant(deleteTarget, cfg);
            // cascade rm directories
            const dataDir = resolveDataDir(cfg);
            for (const sub of ["pi-config", "sessions", "workspaces", "mailbox"]) {
              const p = path.join(dataDir, sub, deleteTarget);
              try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ok */ }
            }
            setMode("list");
            setDeleteTarget(null);
          }}
          onCancel={() => { setMode("list"); setDeleteTarget(null); }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold underline>Tenants ({tenants.length})</Text>
        <Text dimColor>[n] new</Text>
      </Box>

      <DataTable columns={tenantCols} rows={tenantRows} />

      <Box marginTop={1} flexDirection="column">
        <Text bold>Select tenant to manage:</Text>
        <SelectList
          items={selectItems}
          onSelect={(id) => {
            setDeleteTarget(id);
            setDeleteAlias(getTenantAlias(id, config));
            setMode("delete-confirm");
          }}
          title="Select tenant to delete or [s] to set default"
        />
        <Text dimColor>
          [Enter] select to delete · Press 's' on the select screen to set as default · [n] new
        </Text>
      </Box>
    </Box>
  );
}
