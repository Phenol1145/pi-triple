import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LabConfig } from "./types.ts";
import { mergeConfig } from "./config.ts";

/** pitHome 解析（与 pit 经 env 契约一致，扩展自含，不 import pit 代码） */
function pitHome(): string {
  return process.env.PI_TRIPLE_HOME ?? join(homedir(), ".pi-triple");
}

/** per-tenant 配置目录（config.json / role_pin / arena / workloop） */
export function localConfigDir(): string {
  if (process.env.AGENT_LAB_CONFIG_DIR) return process.env.AGENT_LAB_CONFIG_DIR;
  const tenant = process.env.PI_TENANT;
  if (tenant) return join(pitHome(), "data", "pi-config", tenant, "agent-lab");
  return join(homedir(), ".pi", "agent", "agent-lab");
}

/** 共享遥测 DB 路径（runs 表） */
export function sharedDbPath(): string {
  if (process.env.AGENT_LAB_DB_PATH) return process.env.AGENT_LAB_DB_PATH;
  if (process.env.PI_TENANT) return join(pitHome(), "data", "shared", "agent-lab", "agent-lab.db");
  return join(localConfigDir(), "agent-lab.db");
}

// 向后兼容别名
export function dataDir(): string { return localConfigDir(); }
export function dbPath(): string { return sharedDbPath(); }

export function configPath(): string { return join(localConfigDir(), "config.json"); }

export function ensureDataDir(): void { mkdirSync(dataDir(), { recursive: true }); }

export function loadConfig(): LabConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    return mergeConfig(JSON.parse(raw));
  } catch {
    return mergeConfig(undefined);
  }
}

export function saveConfig(cfg: LabConfig): void {
  ensureDataDir();
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
