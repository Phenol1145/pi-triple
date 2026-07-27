import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LabConfig } from "./types.ts";
import { mergeConfig } from "./config.ts";

/** per-tenant 配置目录（config.json / role_pin / arena / workloop） */
export function localConfigDir(): string {
  return process.env.AGENT_LAB_CONFIG_DIR
    ?? join(homedir(), ".pi", "agent", "agent-lab");
}

/** 共享遥测 DB 路径（runs 表） */
export function sharedDbPath(): string {
  return process.env.AGENT_LAB_DB_PATH
    ?? join(localConfigDir(), "agent-lab.db");
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
