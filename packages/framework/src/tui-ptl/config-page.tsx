import React from "react";
import { Box, Text } from "ink";
import path from "node:path";
import { loadConfig, resolveDataDir, getTemplateAlias } from "@pi-triple/shared";

interface ConfigPageProps {
  width: number;
  height: number;
}

export function ConfigPage({ width, height: _h }: ConfigPageProps) {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const configPath = path.resolve(process.cwd(), "pi-triple.json");

  // Format templates compactly
  const tenantLines = Object.entries(config.templates).map(([id, t]) =>
    `  ${t.alias.padEnd(16)} ${id.slice(0, 8)}…  model: ${t.model ?? "(default)"}${id === config.defaultTemplate ? " ★" : ""}`,
  );

  // Env var status
  const envVars = [
    { name: "DATA_DIR", value: dataDir },
    { name: "REDIS_URL", value: config.redis },
    { name: "PI_CODING_AGENT_DIR", value: path.join(dataDir, "pi-config", config.defaultTemplate) },
    { name: "PI_BIN", value: process.env.PI_BIN ?? "pi" },
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
          <Text>defaultTenant: {config.defaultTemplate.slice(0, 8)}… ({getTemplateAlias(config.defaultTemplate, config)})</Text>
          <Text>dataDir:       {config.dataDir}</Text>
          <Text>sharedDir:     {config.sharedDir}</Text>
          <Text>redis:         {config.redis}</Text>
          <Text>gateway:       port {config.gateway.port}</Text>
        </Box>
      </Box>

      {/* Templates */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Templates ({Object.keys(config.templates).length})</Text>
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
          Edit: ptl config   |   View raw: cat pi-triple.json
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>编辑 pi-triple.json 修改配置 · / 命令模式</Text>
      </Box>
    </Box>
  );
}
