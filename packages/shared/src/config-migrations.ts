/**
 * config-migrations.ts —— 配置 v1/v2/v3 迁移（模块专项 ② 大文件拆分：自 config.ts 抽出）。
 *
 * 为避免 config.ts ↔ 本文件成环：本文件只依赖 node 内置与 config-types；
 * 运行时帮助函数由 config.ts 调用时注入。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PiTripleConfig } from "./config-types.js";

export interface MigrationHelpers {
  configPath(): string;
  defaultConfig(): PiTripleConfig;
  saveConfig(config: PiTripleConfig): void;
  UUID_RE: RegExp;
  CURRENT_VERSION: number;
}

// ─── V1 → V2 迁移 ───────────────────────────────────────────

export function migrateV1toV2(raw: Record<string, any>, helpers: MigrationHelpers): PiTripleConfig {
  const { configPath, defaultConfig, saveConfig, UUID_RE, CURRENT_VERSION: _CURRENT_VERSION } = helpers;
  // 备份 v1
  const p = configPath();
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".v1.bak");

  const config = defaultConfig();
  config.templates = {};

  type OldRaw = Record<string, any>;
  const oldTemplates: OldRaw = raw.tenants ?? {};
  const oldDefault: string = raw.defaultTenant ?? "local";
  let newDefaultId = config.defaultTemplate;
  const renames: Array<{ alias: string; uuid: string }> = [];

  for (const [name, tplCfg] of Object.entries(oldTemplates)) {
    if (UUID_RE.test(name)) {
      const existingAlias = (tplCfg as any)?.alias ?? name;
      config.templates[name] = { ...(tplCfg as any), alias: existingAlias };
      if (name === oldDefault) newDefaultId = name;
    } else {
      const id = randomUUID();
      config.templates[id] = { alias: name, ...(tplCfg as any) };
      renames.push({ alias: name, uuid: id });
      if (name === oldDefault) newDefaultId = id;
    }
  }

  if (Object.keys(config.templates).length === 0) {
    config.templates[config.defaultTemplate] = { alias: "local" };
  }

  config.defaultTemplate = newDefaultId;
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

// ─── V2 → V3 迁移（tenants→templates key + 新字段）─────────────

export function migrateV2toV3(raw: Record<string, any>, helpers: MigrationHelpers): PiTripleConfig {
  const { configPath, defaultConfig, saveConfig, CURRENT_VERSION } = helpers;
  const p = configPath();
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".v2.bak");

  const config = defaultConfig();

  // 幂等：无 tenants key 时（用户手改或异常）只升 version + 补 defaultTemplate（N2）
  if (!raw.tenants) {
    config.defaultTemplate = raw.defaultTemplate ?? raw.defaultTenant ?? config.defaultTemplate;
    config.templates = raw.templates ?? { [config.defaultTemplate]: { alias: "local" } };
    config.version = CURRENT_VERSION;
    if (raw.dataDir) config.dataDir = raw.dataDir;
    if (raw.sharedDir) config.sharedDir = raw.sharedDir;
    if (raw.redis) config.redis = raw.redis;
    if (raw.gateway) config.gateway = raw.gateway;
    if (raw.pth) config.pth = raw.pth;
    saveConfig(config);
    return config;
  }

  // 迁移 tenants → templates
  config.templates = {};
  for (const [id, tplCfg] of Object.entries(raw.tenants ?? {})) {
    config.templates[id] = { ...(tplCfg as any) };
  }

  config.defaultTemplate = raw.defaultTenant ?? raw.defaultTemplate ?? config.defaultTemplate;
  config.version = CURRENT_VERSION;
  if (raw.dataDir) config.dataDir = raw.dataDir;
  if (raw.sharedDir) config.sharedDir = raw.sharedDir;
  if (raw.redis) config.redis = raw.redis;
  if (raw.gateway) config.gateway = raw.gateway;
  if (raw.pth) config.pth = raw.pth;

  saveConfig(config);
  return config;
}

