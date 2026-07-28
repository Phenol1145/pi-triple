/**
 * Pi-Triple 中心配置 — pi-triple.json
 *
 * 租户使用 UUID 作为唯一标识，用户提供别名（alias）。
 * 所有目录路径使用 UUID，用户交互使用别名。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

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
const ALIAS_RE = /[^a-zA-Z0-9_\-\u4e00-\u9fff]/g;

// ─── Global paths ────────────────────────────────────────────

/** 全局配置目录：~/.pi-triple/（可由 PI_TRIPLE_HOME 环境变量覆盖） */
export function pitHome(): string {
  return process.env.PI_TRIPLE_HOME ?? path.join(homedir(), ".pi-triple");
}

function defaultConfig(): PiTripleConfig {
  const home = pitHome();
  const localId = randomUUID();
  return {
    version: 2,
    defaultTenant: localId,
    dataDir: path.join(home, "data"),
    sharedDir: path.join(home, "data", "shared"),
    redis: "redis://localhost:6379",
    gateway: { port: 3000 },
    tenants: {
      [localId]: { alias: "local" },
    },
  };
}

// ─── Load / Save ─────────────────────────────────────────────

function configPath(): string {
  // 全局配置优先（~/.pi-triple/pi-triple.json），cwd 作为 fallback
  const homeConfig = path.join(pitHome(), "pi-triple.json");
  if (fs.existsSync(homeConfig)) return homeConfig;
  const cwdConfig = path.resolve(process.cwd(), "pi-triple.json");
  if (fs.existsSync(cwdConfig)) return cwdConfig;
  return homeConfig;
}

export function loadConfig(): PiTripleConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    // 首次启动：检测是否有旧 cwd 配置，自动迁移
    const migrated = migrateCwdToHome();
    if (migrated) return loadConfig(); // 递归加载迁移后的配置
    return defaultConfig();
  }

  // 如果加载的是 cwd 配置但 ~/.pi-triple/ 不存在，迁移
  const homeConfig = path.join(pitHome(), "pi-triple.json");
  if (p !== homeConfig && !fs.existsSync(homeConfig)) {
    migrateCwdToHome();
  }
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
      const existingAlias = (tenantCfg as any)?.alias ?? name;
      config.tenants[name] = { ...(tenantCfg as any), alias: existingAlias };
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
  const configDir2 = path.dirname(configPath());
  const dataDir = path.resolve(configDir2, process.env.DATA_DIR ?? config.dataDir);
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

export type TenantResolution =
  | { ok: true; id: string }
  | { ok: false; reason: "not_found"; input: string }
  | { ok: false; reason: "ambiguous"; input: string; candidates: string[] };

/**
 * 将用户输入的别名或 UUID 解析为租户 UUID。
 * 支持前缀匹配 UUID（≥4 字符）。
 */
export function resolveTenantId(input: string, config?: PiTripleConfig): TenantResolution {
  const cfg = config ?? loadConfig();

  // 精确 UUID
  if (cfg.tenants[input]) return { ok: true, id: input };

  // 别名匹配
  for (const [id, tenant] of Object.entries(cfg.tenants)) {
    if (tenant.alias === input) return { ok: true, id };
  }

  // UUID 前缀匹配
  if (input.length >= 4) {
    const matches = Object.keys(cfg.tenants).filter((id) => id.startsWith(input));
    if (matches.length === 1) return { ok: true, id: matches[0] };
    if (matches.length > 1) return { ok: false, reason: "ambiguous", input, candidates: matches };
  }

  return { ok: false, reason: "not_found", input };
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

/**
 * 创建新租户，返回 UUID。
 * 别名强制唯一、消毒（仅保留字母数字/下划线/连字符/中文）。
 */
export function createTenant(alias: string, tenantConfig?: Partial<TenantConfig>, config?: PiTripleConfig): string {
  const cfg = config ?? loadConfig();

  // 别名消毒
  const sanitized = alias.replace(ALIAS_RE, "-");
  if (sanitized !== alias) {
    console.log(`  \x1b[33m别名已消毒: "${alias}" → "${sanitized}"\x1b[0m`);
  }
  if (sanitized.length === 0 || sanitized === "-") {
    throw new Error(`别名 "${alias}" 消毒后为空，请输入有效别名`);
  }

  // 强制唯一
  for (const [id, tenant] of Object.entries(cfg.tenants)) {
    if (tenant.alias === sanitized) {
      throw new Error(`别名 "${sanitized}" 已被租户 ${id.slice(0, 8)}… 使用`);
    }
  }

  const id = randomUUID();
  cfg.tenants[id] = { alias: sanitized, ...tenantConfig };
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

/** 重命名租户别名 */
export function renameTenant(tenantId: string, newAlias: string, config?: PiTripleConfig): boolean {
  const cfg = config ?? loadConfig();
  if (!cfg.tenants[tenantId]) return false;
  const sanitized = newAlias.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "-");
  if (!sanitized) return false;
  // 检查别名重复
  for (const [id, t] of Object.entries(cfg.tenants)) {
    if (id !== tenantId && t.alias === sanitized) return false;
  }
  cfg.tenants[tenantId].alias = sanitized;
  saveConfig(cfg);
  return true;
}

// ─── 配置键读写（pit config get/set/unset）─────────────────────

/** 租户可写字段 */
const TENANT_WRITABLE = new Set(["model", "provider", "thinking", "tools", "excludeTools"]);

export interface ConfigSetResult {
  ok: boolean;
  error?: string;
}

/** 读取配置键（点路径），返回字符串形式；不存在返回 undefined */
export function getConfigValue(key: string, config?: PiTripleConfig): string | undefined {
  const cfg = config ?? loadConfig();
  const parts = key.split(".");

  if (parts[0] === "tenants" && parts.length === 3) {
    const resolved = resolveTenantId(parts[1]!, cfg);
    if (!resolved.ok) return undefined;
    const val = (cfg.tenants[resolved.id] as any)?.[parts[2]!];
    return val === undefined ? undefined : String(val);
  }

  switch (key) {
    case "version": return String(cfg.version);
    case "defaultTenant": return cfg.defaultTenant;
    case "dataDir": return cfg.dataDir;
    case "sharedDir": return cfg.sharedDir;
    case "redis": return cfg.redis;
    case "gateway.port": return String(cfg.gateway.port);
    default: return undefined;
  }
}

/** 列出所有可读写键 */
export function listConfigKeys(config?: PiTripleConfig): string[] {
  return ["defaultTenant", "dataDir", "sharedDir", "redis", "gateway.port", "tenants.<alias>.model", "tenants.<alias>.provider", "tenants.<alias>.thinking", "tenants.<alias>.tools", "tenants.<alias>.excludeTools"];
}

/** 写入配置键 */
export function setConfigValue(key: string, value: string, config?: PiTripleConfig): ConfigSetResult {
  const cfg = config ?? loadConfig();
  const parts = key.split(".");

  if (parts[0] === "tenants" && parts.length === 3) {
    const resolved = resolveTenantId(parts[1]!, cfg);
    if (!resolved.ok) return { ok: false, error: `租户 "${parts[1]}" 不存在` };
    const field = parts[2]!;
    if (!TENANT_WRITABLE.has(field)) {
      return { ok: false, error: `租户字段只允许: ${[...TENANT_WRITABLE].join(", ")}` };
    }
    (cfg.tenants[resolved.id] as any)[field] = value;
    saveConfig(cfg);
    return { ok: true };
  }

  switch (key) {
    case "defaultTenant": {
      const resolved = resolveTenantId(value, cfg);
      if (!resolved.ok) return { ok: false, error: `租户 "${value}" 不存在` };
      cfg.defaultTenant = resolved.id;
      break;
    }
    case "redis":
      cfg.redis = value;
      break;
    case "gateway.port": {
      const port = parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value.trim()) {
        return { ok: false, error: "gateway.port 必须是 1-65535 的整数" };
      }
      cfg.gateway.port = port;
      break;
    }
    case "dataDir":
    case "sharedDir":
      // 允许修改但不迁移数据（调用方提示）
      (cfg as any)[key] = value;
      break;
    default:
      return { ok: false, error: `未知或只读配置键: ${key}（可用: ${listConfigKeys(cfg).join(", ")}）` };
  }
  saveConfig(cfg);
  return { ok: true };
}

/** 删除配置键（仅租户可选字段） */
export function unsetConfigValue(key: string, config?: PiTripleConfig): ConfigSetResult {
  const cfg = config ?? loadConfig();
  const parts = key.split(".");

  if (parts[0] === "tenants" && parts.length === 3) {
    const resolved = resolveTenantId(parts[1]!, cfg);
    if (!resolved.ok) return { ok: false, error: `租户 "${parts[1]}" 不存在` };
    const field = parts[2]!;
    if (!TENANT_WRITABLE.has(field)) {
      return { ok: false, error: `租户字段只允许: ${[...TENANT_WRITABLE].join(", ")}` };
    }
    delete (cfg.tenants[resolved.id] as any)[field];
    saveConfig(cfg);
    return { ok: true };
  }

  return { ok: false, error: `顶层键为必填，不可删除: ${key}` };
}

// ─── 路径 ────────────────────────────────────────────────────

export function resolveDataDir(config?: PiTripleConfig): string {
  const cfg = config ?? loadConfig();
  // 相对于配置文件所在目录解析
  const p = configPath();
  const configDir = path.dirname(p);
  return path.resolve(configDir, process.env.DATA_DIR ?? cfg.dataDir);
}

// ─── 一次性迁移：cwd → ~/.pi-triple/ ─────────────────────────

/**
 * 如果存在 ~/pi-platform/pi-triple.json（旧 cwd 配置）
 * 但 ~/.pi-triple/pi-triple.json 不存在，
 * 自动复制到 ~/.pi-triple/。
 */
function migrateCwdToHome(): boolean {
  const homeConfig = path.join(pitHome(), "pi-triple.json");
  if (fs.existsSync(homeConfig)) return false; // 已存在，跳过

  // 检测几个常见的旧配置位置
  const candidates = [
    path.join(homedir(), "pi-platform", "pi-triple.json"),
    path.join(homedir(), "pi-triple", "pi-triple.json"),
    path.join(homedir(), "pi-platform", "pi-triple.json"),
  ];

  for (const src of candidates) {
    if (!fs.existsSync(src)) continue;

    // 复制配置文件
    const homeDir = pitHome();
    fs.mkdirSync(homeDir, { recursive: true });
    fs.copyFileSync(src, homeConfig);

    // 如果旧 dataDir 是相对路径，更新为绝对路径
    try {
      const raw = JSON.parse(fs.readFileSync(homeConfig, "utf-8"));
      let changed = false;
      if (raw.dataDir && !path.isAbsolute(raw.dataDir) && !raw.dataDir.startsWith("~")) {
        const oldDataDir = path.resolve(path.dirname(src), raw.dataDir);
        const newDataDir = path.join(homeDir, "data");
        if (fs.existsSync(oldDataDir) && oldDataDir !== newDataDir) {
          // 复制数据目录
          fs.cpSync(oldDataDir, newDataDir, { recursive: true });
        }
        raw.dataDir = newDataDir;
        raw.sharedDir = path.join(newDataDir, "shared");
        changed = true;
      }
      if (changed) {
        const tmp = homeConfig + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
        fs.renameSync(tmp, homeConfig);
      }
    } catch { /* 解析失败，保留原样 */ }

    console.log(`  \x1b[32m✅ 配置已迁移: ${src} → ${homeConfig}\x1b[0m`);
    return true;
  }

  return false;
}

/** 迁移目录名：alias → UUID（已废弃，由 migrateV1toV2 内联处理） */
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
