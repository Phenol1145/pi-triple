import React from "react";
import { Box, Text } from "ink";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveDataDir, getTenantAlias } from "../config.js";

interface ConfigPageProps {
  width: number;
  height: number;
}

export function ConfigPage({ width, height: _h }: ConfigPageProps) {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const configPath = path.resolve(process.cwd(), "pi-triple.json");

  // Format tenants compactly
  const tenantLines = Object.entries(config.tenants).map(([id, t]) =>
    `  ${t.alias.padEnd(16)} ${id.slice(0, 8)}…  model: ${t.model ?? "(default)"}${id === config.defaultTenant ? " ★" : ""}`,
  );

  // Env var status
  const envVars = [
    { name: "DATA_DIR", value: dataDir },
    { name: "REDIS_URL", value: config.redis },
    { name: "PI_CODING_AGENT_DIR", value: path.join(dataDir, "pi-config", config.defaultTenant) },
    { name: "PI_BIN", value: process.env.PI_BIN ?? "pi" },
    { name: "AGENT_LAB_DB_PATH", value: path.join(dataDir, "shared", "agent-lab", "agent-lab.db") },
  ];

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold underline>
        Configuration
      </Text>

      {/* Main config */}
      <Box flexDirection="column">
        <Text dimColor>Config file: {configPath}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>version:       {config.version}</Text>
          <Text>defaultTenant: {config.defaultTenant.slice(0, 8)}… ({getTenantAlias(config.defaultTenant, config)})</Text>
          <Text>dataDir:       {config.dataDir}</Text>
          <Text>sharedDir:     {config.sharedDir}</Text>
          <Text>redis:         {config.redis}</Text>
          <Text>gateway:       port {config.gateway.port}</Text>
        </Box>
      </Box>

      {/* Tenants */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Tenants ({Object.keys(config.tenants).length})</Text>
        {tenantLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>

      {/* Environment */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Environment</Text>
        {envVars.map((e) => (
          <Box key={e.name}>
            <Text dimColor>{e.name.padEnd(22)}</Text>
            <Text>{e.value}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Edit: pit config   |   View raw: cat pi-triple.json
        </Text>
      </Box>
    </Box>
  );
}
