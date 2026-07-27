import React from "react";
import { Box, Text } from "ink";
import fs from "node:fs";
import path from "node:path";
import { DataTable, theme } from "../tui-shared/index.js";
import type { ColumnDef } from "../tui-shared/index.js";
import { loadConfig, resolveDataDir } from "../config.js";
import { sharedStatus } from "../shared-layer.js";

interface ExtensionsPageProps {
  width: number;
  height: number;
}

export function ExtensionsPage({ width, height: _h }: ExtensionsPageProps) {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const sharedDir = path.join(dataDir, "shared");
  const status = sharedStatus(sharedDir);

  // Per-tenant extension counts
  const tenantExtCounts = Object.entries(config.tenants).map(([id, tenant]) => {
    const extDir = path.join(dataDir, "pi-config", id, "extensions");
    let count = 0;
    let hasShared = false;
    if (fs.existsSync(extDir)) {
      const entries = fs.readdirSync(extDir, { withFileTypes: true });
      count = entries.filter((e) => !e.name.startsWith(".") && e.name !== "_shared").length;
      hasShared = entries.some((e) => e.name === "_shared");
    }
    return { alias: tenant.alias, count, hasShared, id };
  });

  // Shared layer extensions list
  const sharedExtDir = path.join(sharedDir, "extensions");
  const sharedExts: string[] = [];
  if (fs.existsSync(sharedExtDir)) {
    sharedExts.push(
      ...fs.readdirSync(sharedExtDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name),
    );
  }

  const sharedCols: ColumnDef[] = [
    { key: "name", label: "SHARED EXTENSION" },
  ];

  const tenantCols: ColumnDef[] = [
    { key: "alias", label: "TENANT", width: 16 },
    { key: "count", label: "EXT", width: 5 },
    { key: "shared", label: "LINKED", width: 8 },
  ];

  return (
    <Box flexDirection="column" gap={1}>
      {/* Shared Layer */}
      <Box flexDirection="column">
        <Text bold underline>
          Shared Layer ({status.exists ? "active" : "not initialized"})
        </Text>
        <Box gap={3} marginY={1}>
          <Text>Extensions: {status.extensions}</Text>
          <Text>Skills: {status.skills}</Text>
          <Text>Packages: {status.packages}</Text>
        </Box>

        {sharedExts.length > 0 ? (
          <>
            <Text dimColor>Shared extensions:</Text>
            <DataTable
              columns={sharedCols}
              rows={sharedExts.map((n) => ({ name: n }))}
            />
          </>
        ) : (
          <Text dimColor>  Run pit shared init to populate</Text>
        )}
      </Box>

      {/* Per-tenant */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>Per-Tenant Extensions</Text>

        <DataTable
          columns={tenantCols}
          rows={tenantExtCounts.map((t) => ({
            alias: t.alias,
            count: String(t.count),
            shared: t.hasShared ? "✅" : "❌",
          }))}
          rowColor={(row) => {
            if (row.shared === "❌") return theme.warning;
            return undefined;
          }}
        />

        <Box marginTop={1}>
          <Text dimColor>
            Install/remove extensions via: pit install &lt;source&gt; [--shared]
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
