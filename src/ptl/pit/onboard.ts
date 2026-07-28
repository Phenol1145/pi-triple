/**
 * pit/onboard — cmdOnboard, tenant resolution, first-run migration
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  loadConfig, saveConfig, resolveDataDir, type PiTripleConfig,
  resolveTenantId, getTenantAlias, getDefaultTenantId, migrateDirectoryNames,
} from "../config.js";
import { runDoctor } from "../doctor.js";
import { migrate } from "../migrate.js";
import { initSharedLayer, linkTenantToShared, installBundledExtensions } from "../shared-layer.js";
import { printBanner } from "./main.js";

/** 解析用户输入的 tenant flag（alias 或 UUID）→ 返回 UUID 或 null + 打印错误 */
export function resolveOrFail(input: string | undefined, config: PiTripleConfig): string | null {
  if (!input) return getDefaultTenantId(config);
  const result = resolveTenantId(input, config);
  if (result.ok) return result.id;
  if (result.reason === "ambiguous") {
    console.log(`  \x1b[31m❌ "${input}" 匹配多个租户:\x1b[0m`);
    for (const c of result.candidates) {
      const alias = getTenantAlias(c, config);
      console.log(`      ${alias} (${c})`);
    }
    console.log("  请使用更长的 UUID 前缀或别名");
  } else {
    console.log(`  \x1b[31m❌ 未知租户: "${input}"\x1b[0m`);
  }
  console.log("  运行 \x1b[36mpit tenant ls\x1b[0m 查看可用租户\n");
  return null;
}

export async function cmdOnboard(flags: Record<string, string>): Promise<void> {
  printBanner();
  console.log("  \x1b[1m欢迎使用 Pi-Triple！\x1b[0m 开始首次导引…");
  console.log("");

  console.log("  \x1b[1mStep 1/4\x1b[0m — 环境检查");
  console.log("  " + "─".repeat(40));
  await runDoctor("full");

  console.log("  \x1b[1mStep 2/4\x1b[0m — 初始化配置");
  console.log("  " + "─".repeat(40));
  const configPath2 = path.resolve("pi-triple.json");
  const config = loadConfig();
  if (!fs.existsSync(configPath2)) {
    saveConfig(config);
  }
  console.log("  ✅ pi-triple.json 已就绪 (v2, UUID+alias)");

  console.log("");
  console.log("  \x1b[1mStep 3/4\x1b[0m — 租户环境");
  console.log("  " + "─".repeat(40));
  const dataDir = resolveDataDir(config);
  const defaultId = getDefaultTenantId(config);
  const tenantDir = path.join(dataDir, "pi-config", defaultId);

  if (fs.existsSync(tenantDir) && fs.existsSync(path.join(tenantDir, "settings.json"))) {
    const alias = getTenantAlias(defaultId, config);
    console.log(`  ✅ 租户 "${alias}" (${defaultId.slice(0, 8)}…) 已存在`);
  } else {
    const alias = getTenantAlias(defaultId, config);
    console.log(`  创建租户 "${alias}" (${defaultId.slice(0, 8)}…)…`);
    await migrate({ tenantId: defaultId });
  }

  const sharedDirOnboard = path.resolve(path.join(dataDir, "shared"));
  initSharedLayer(sharedDirOnboard);
  const bundledOnboard = installBundledExtensions(sharedDirOnboard);
  if (bundledOnboard.length > 0) {
    console.log(`  ✅ 内置扩展: ${bundledOnboard.join(", ")}`);
  }
  linkTenantToShared(tenantDir, sharedDirOnboard);

  const renamed = migrateDirectoryNames(config);
  if (renamed.length > 0) {
    console.log(`  📁 目录迁移: ${renamed.join(", ")}`);
  }

  console.log("  \x1b[1mStep 4/4\x1b[0m — 验证");
  console.log("  " + "─".repeat(40));
  await runDoctor("quick");

  console.log("");
  console.log("  \x1b[32m\x1b[1m🎉 Pi-Triple 准备就绪！\x1b[0m");
  console.log("");
  console.log("  启动: pit start");
  console.log("  租户: pit tenant ls");
  console.log("  帮助: pit help");
  console.log("");
}

/** 解析租户（含位置参数）+ 首次启动自动迁移 */
export async function resolveTenantAndMigrate(flags: Record<string, string>, passthrough: string[]): Promise<{ tenantId: string; piPassthrough: string[] } | null> {
  const config = loadConfig();

  let tenantInput = flags.tenant;
  const piPassthrough = [...passthrough];
  if (!tenantInput && piPassthrough.length > 0) {
    const resolved = resolveTenantId(piPassthrough[0], config);
    if (resolved.ok) {
      tenantInput = piPassthrough[0];
      piPassthrough.splice(0, 1);
    }
  }

  const tenantId = resolveOrFail(tenantInput, config);
  if (!tenantId) return null;

  const dataDir = resolveDataDir(config);
  const tenantConfigDir = path.join(dataDir, "pi-config", tenantId);
  const classicPiAgentDir = path.join(homedir(), ".pi", "agent");
  if (fs.existsSync(classicPiAgentDir) && !fs.existsSync(path.join(tenantConfigDir, "settings.json"))) {
    console.log("");
    console.log("  \x1b[36m检测到现有 pi 环境 (~/.pi/agent/)\x1b[0m");
    console.log("  正在迁移扩展和配置...");
    try {
      await migrate({ tenantId });
      const sharedDir = path.join(dataDir, "shared");
      const { linkTenantToShared: relink } = await import("../shared-layer.js");
      relink(tenantConfigDir, sharedDir);
      console.log("  \x1b[32m✅ 迁移完成\x1b[0m");
    } catch (err: any) {
      console.log(`  \x1b[33m⚠️  迁移部分失败: ${err.message}\x1b[0m`);
    }
    console.log("");
  }

  return { tenantId, piPassthrough };
}
