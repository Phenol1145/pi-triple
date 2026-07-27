import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { spawnSync } from "node:child_process";
import { DataTable } from "../tui-shared/index.js";
import type { ColumnDef } from "../tui-shared/index.js";
import { loadConfig, listTenants, getTenantAlias, resolveDataDir } from "../config.js";

interface DashPageProps {
  width: number;
  height: number;
}

interface HealthItem {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

export function DashboardPage({ width, height: _h }: DashPageProps) {
  const [health, setHealth] = useState<HealthItem[]>([]);
  const config = loadConfig();
  const tenants = listTenants(config);

  useEffect(() => {
    // quick async health check
    runQuickHealth().then(setHealth);
  }, []);

  // tmux sessions
  const tmuxResult = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf-8" });
  const tmuxSessions = (tmuxResult.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("pit-"));

  const tenantCols: ColumnDef[] = [
    { key: "alias", label: "TENANT", width: 16 },
    { key: "id", label: "ID" },
    { key: "model", label: "MODEL", width: 20 },
    { key: "default", label: "DEFAULT", width: 8 },
  ];
  const tenantRows = tenants.map((t) => ({
    alias: t.alias,
    id: t.id.slice(0, 8) + "…",
    model: t.config.model ?? "(default)",
    default: t.isDefault ? "★" : "",
  }));

  return (
    <Box flexDirection="column" gap={1}>
      {/* Section: Health */}
      <Box flexDirection="column">
        <Text bold underline>Health</Text>
        {health.length === 0 ? (
          <Text dimColor>  checking…</Text>
        ) : (
          health.map((h, i) => (
            <Box key={i}>
              <Text>  {h.status === "ok" ? "✅" : h.status === "warn" ? "⚠️" : "❌"} </Text>
              <Text color={h.status === "ok" ? "green" : h.status === "warn" ? "yellow" : "red"}>
                {h.name}
              </Text>
              <Text dimColor> — {h.message}</Text>
            </Box>
          ))
        )}
      </Box>

      {/* Section: Tenants */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>Tenants ({tenants.length})</Text>
        <DataTable columns={tenantCols} rows={tenantRows} />
      </Box>

      {/* Section: Active Sessions */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>
          Active Sessions ({tmuxSessions.length})
        </Text>
        {tmuxSessions.length === 0 ? (
          <Text dimColor>  none. Start: pit start --bg --name &lt;name&gt;</Text>
        ) : (
          tmuxSessions.map((s) => (
            <Box key={s}>
              <Text color="cyan">  ▸ </Text>
              <Text>{s.replace(/^pit-/, "")}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

/** Quick health check (synchronous version for TUI) */
async function runQuickHealth(): Promise<HealthItem[]> {
  const items: HealthItem[] = [];

  // Node.js
  items.push({ name: "Node.js", status: "ok", message: process.version });

  // pi CLI
  try {
    const piVer = spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 5000 });
    items.push({
      name: "pi CLI",
      status: piVer.status === 0 ? "ok" : "fail",
      message: piVer.status === 0 ? `v${piVer.stdout.trim()}` : "not installed",
    });
  } catch {
    items.push({ name: "pi CLI", status: "fail", message: "not installed" });
  }

  // Redis
  const net = await import("node:net");
  const redisOk = await new Promise<boolean>((resolve) => {
    const s = net.createConnection({ host: "localhost", port: 6379, timeout: 3000 });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
  items.push({
    name: "Redis",
    status: redisOk ? "ok" : "fail",
    message: redisOk ? "connected" : "unreachable",
  });

  // Data dir
  try {
    const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const cfg = loadConfig();
    const dir = resolve(process.cwd(), process.env.DATA_DIR ?? cfg.dataDir);
    mkdirSync(dir, { recursive: true });
    const test = resolve(dir, ".tui-test");
    writeFileSync(test, "ok");
    unlinkSync(test);
    items.push({ name: "Data Dir", status: "ok", message: "writable" });
  } catch {
    items.push({ name: "Data Dir", status: "fail", message: "not writable" });
  }

  return items;
}
