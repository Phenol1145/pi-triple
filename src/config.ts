/**
 * Pi-Triple 中心配置 — pi-triple.json
 *
 * 租户使用 UUID 作为唯一标识，用户提供别名（alias）。
 * 所有目录路径使用 UUID，用户交互使用别名。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────

export interface TenantConfig {
  alias: string;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string;
  excludeTools?: string;
}

export interface PiTripleConfig {
  version: 2;
  defaultTenant: string;  // UUID
  dataDir: string;
  sharedDir: string;
  redis: string;
  gateway: { port: number };
  tenants: Record<string, TenantConfig>;  // key = UUID
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultConfig(): PiTripleConfig {
  const localId = randomUUID();
  return {
    version: 2,
    defaultTenant: localId,
    dataDir: "./.pi-platform-data",
    sharedDir: "./.pi-platform-data/shared",
    redis: "redis://localhost:6379",
    gateway: { port: 3000 },
    tenants: {
      [localId]: { alias: "local" },
    },
  };
}

// ─── Load / Save ─────────────────────────────────────────────

function configPath(): string {
  return path.resolve(process.cwd(), "pi-triple.json");
}

export function loadConfig(): PiTripleConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return defaultConfig();
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    console.error(`\x1b[31m❌ pi-triple.json 解析失败: ${err}\x1b[0m`);
    console.error("  请检查配置文件，或从 pi-triple.json.v1.bak 恢复");
    process.exit(1);
  }
  if (!raw.version || raw.version < 2) {
    return migrateV1toV2(raw);
  }
  return { ...defaultConfig(), ...raw };
}

export function saveConfig(config: PiTripleConfig): void {
  const p = configPath();
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

// ─── V1 → V2 迁移 ───────────────────────────────────────────

function migrateV1toV2(raw: Record<string, any>): PiTripleConfig {
  // 备份 v1
  const p = configPath();
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".v1.bak");

  const config = defaultConfig();
  config.tenants = {};

  const oldTenants: Record<string, any> = raw.tenants ?? {};
  const oldDefault: string = raw.defaultTenant ?? "local";
  let newDefaultId = config.defaultTenant;
  const renames: Array<{ alias: string; uuid: string }> = [];

  for (const [name, tenantCfg] of Object.entries(oldTenants)) {
    if (UUID_RE.test(name)) {
      config.tenants[name] = { alias: (tenantCfg as any)?.alias ?? name, ...(tenantCfg as any) };
      if (name === oldDefault) newDefaultId = name;
    } else {
      const id = randomUUID();
      config.tenants[id] = { alias: name, ...(tenantCfg as any) };
      renames.push({ alias: name, uuid: id });
      if (name === oldDefault) newDefaultId = id;
    }
  }

  if (Object.keys(config.tenants).length === 0) {
    config.tenants[config.defaultTenant] = { alias: "local" };
  }

  config.defaultTenant = newDefaultId;
  if (raw.dataDir) config.dataDir = raw.dataDir;
  if (raw.sharedDir) config.sharedDir = raw.sharedDir;
  if (raw.redis) config.redis = raw.redis;
  if (raw.gateway) config.gateway = raw.gateway;

  // 先迁移目录，再保存配置（崩溃可重试，不会 split-brain）
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? config.dataDir);
  for (const { alias, uuid } of renames) {
    for (const subdir of ["pi-config", "sessions", "workspaces", "mailbox"]) {
      const oldPath = path.join(dataDir, subdir, alias);
      const newPath = path.join(dataDir, subdir, uuid);
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        try {
          fs.renameSync(oldPath, newPath);
        } catch (err: any) {
          if (err.code === "EXDEV") {
            fs.cpSync(oldPath, newPath, { recursive: true });
            fs.rmSync(oldPath, { recursive: true, force: true });
          } else throw err;
        }
      }
    }
  }

  saveConfig(config);
  return config;
}

// ─── 解析 ────────────────────────────────────────────────────

/**
 * 将用户输入的别名或 UUID 解析为租户 UUID。
 * 支持前缀匹配 UUID。
 */
export function resolveTenantId(input: string, config?: PiTripleConfig): string | null {
  const cfg = config ?? loadConfig();

  // 精确 UUID
  if (cfg.tenants[input]) return input;

  // 别名匹配
  for (const [id, tenant] of Object.entries(cfg.tenants)) {
    if (tenant.alias === input) return id;
  }

  // UUID 前缀匹配
  if (input.length >= 4) {
    const matches = Object.keys(cfg.tenants).filter((id) => id.startsWith(input));
    if (matches.length === 1) return matches[0];
  }

  return null;
}

/** 获取租户别名 */
export function getTenantAlias(tenantId: string, config?: PiTripleConfig): string {
  const cfg = config ?? loadConfig();
  return cfg.tenants[tenantId]?.alias ?? tenantId.slice(0, 8);
}

/** 获取默认租户 UUID */
export function getDefaultTenantId(config?: PiTripleConfig): string {
  const cfg = config ?? loadConfig();
  return cfg.defaultTenant;
}

/** 列出所有租户 */
export function listTenants(config?: PiTripleConfig): Array<{ id: string; alias: string; isDefault: boolean; config: TenantConfig }> {
  const cfg = config ?? loadConfig();
  return Object.entries(cfg.tenants).map(([id, tenant]) => ({
    id,
    alias: tenant.alias,
    isDefault: id === cfg.defaultTenant,
    config: tenant,
  }));
}

/** 创建新租户，返回 UUID */
export function createTenant(alias: string, tenantConfig?: Partial<TenantConfig>, config?: PiTripleConfig): string {
  const cfg = config ?? loadConfig();
  const id = randomUUID();
  cfg.tenants[id] = { alias, ...tenantConfig };
  saveConfig(cfg);
  return id;
}

/** 删除租户 */
export function removeTenant(tenantId: string, config?: PiTripleConfig): boolean {
  const cfg = config ?? loadConfig();
  if (!cfg.tenants[tenantId]) return false;
  delete cfg.tenants[tenantId];
  if (cfg.defaultTenant === tenantId) {
    const remaining = Object.keys(cfg.tenants);
    cfg.defaultTenant = remaining[0] ?? randomUUID();
    if (remaining.length === 0) {
      cfg.tenants[cfg.defaultTenant] = { alias: "local" };
    }
  }
  saveConfig(cfg);
  return true;
}

// ─── 路径 ────────────────────────────────────────────────────

export function resolveDataDir(config?: PiTripleConfig): string {
  const cfg = config ?? loadConfig();
  return path.resolve(process.cwd(), process.env.DATA_DIR ?? cfg.dataDir);
}

/**
 * 迁移目录名：alias → UUID。
 * 在 loadConfig v1→v2 迁移后调用。
 */
export function migrateDirectoryNames(config: PiTripleConfig): string[] {
  const dataDir = resolveDataDir(config);
  const migrated: string[] = [];

  for (const [id, tenant] of Object.entries(config.tenants)) {
    for (const subdir of ["pi-config", "sessions", "workspaces", "mailbox"]) {
      const basePath = path.join(dataDir, subdir);
      const oldPath = path.join(basePath, tenant.alias);
      const newPath = path.join(basePath, id);

      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
        migrated.push(`${subdir}/${tenant.alias} → ${id.slice(0, 8)}…`);
      }
    }
  }

  return migrated;
}
