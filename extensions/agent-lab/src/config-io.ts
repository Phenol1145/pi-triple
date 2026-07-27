import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LabConfig } from "./types.ts";
import { mergeConfig } from "./config.ts";

export function dataDir(): string { return join(homedir(), ".pi", "agent", "agent-lab"); }
export function dbPath(): string { return join(dataDir(), "agent-lab.db"); }
export function configPath(): string { return join(dataDir(), "config.json"); }

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
