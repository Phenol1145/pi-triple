/**
 * Pi-Triple 中心配置 — pi-triple.json
 * 参考 OpenClaw 的 openclaw.json 设计
 */

import fs from "node:fs";
import path from "node:path";

export interface PiTripleConfig {
  defaultTenant: string;
  dataDir: string;
  redis: string;
  gateway: { port: number };
  tenants: Record<string, TenantConfig>;
}

export interface TenantConfig {
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string;
  excludeTools?: string;
}

const DEFAULT_CONFIG: PiTripleConfig = {
  defaultTenant: "local",
  dataDir: "./.pi-platform-data",
  redis: "redis://localhost:6379",
  gateway: { port: 3000 },
  tenants: {},
};

function configPath(): string {
  return path.resolve(process.cwd(), "pi-triple.json");
}

export function loadConfig(): PiTripleConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: PiTripleConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
}

export function resolveDataDir(config?: PiTripleConfig): string {
  const cfg = config ?? loadConfig();
  return path.resolve(process.cwd(), process.env.DATA_DIR ?? cfg.dataDir);
}
