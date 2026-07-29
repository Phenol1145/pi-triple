/**
 * pit/onboard — cmdOnboard, tenant resolution, first-run migration
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  loadConfig, saveConfig, resolveDataDir, type PiTripleConfig,
  resolveTemplateId, getTemplateAlias, getDefaultTemplateId, migrateDirectoryNames,
} from "../config.js";
import { runDoctor } from "../doctor.js";
import { migrate } from "../migrate.js";
import { initSharedLayer, linkTemplateToShared, installBundledExtensions } from "../shared-layer.js";
import { printBanner } from "./main.js";

/** 解析用户输入的 tenant flag（alias 或 UUID）→ 返回 UUID 或 null + 打印错误 */
export function resolveOrFail(input: string | undefined, config: PiTripleConfig): string | null {
  if (!input) return getDefaultTemplateId(config);
  const result = resolveTemplateId(input, config);
  if (result.ok) return result.id;
  if (result.reason === "ambiguous") {
    console.log(`  \x1b[31m❌ "${input}" 匹配多个模板:\x1b[0m`);
    for (const c of result.candidates) {
      const alias = getTemplateAlias(c, config);
      console.log(`      ${alias} (${c})`);
    }
    console.log("  请使用更长的 UUID 前缀或别名");
  } else {
    console.log(`  \x1b[31m❌ 未知模板: "${input}"\x1b[0m`);
  }
  console.log("  运行 \x1b[36mpit template ls\x1b[0m 查看可用模板\n");
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
  console.log("  \x1b[1mStep 3/4\x1b[0m — 模板环境");
  console.log("  " + "─".repeat(40));
  const dataDir = resolveDataDir(config);
  const defaultId = getDefaultTemplateId(config);
  const templateDir = path.join(dataDir, "pi-config", defaultId);

  if (fs.existsSync(templateDir) && fs.existsSync(path.join(templateDir, "settings.json"))) {
    const alias = getTemplateAlias(defaultId, config);
    console.log(`  ✅ 模板 "${alias}" (${defaultId.slice(0, 8)}…) 已存在`);
  } else {
    const alias = getTemplateAlias(defaultId, config);
    console.log(`  创建模板 "${alias}" (${defaultId.slice(0, 8)}…)…`);
    await migrate({ templateId: defaultId });
  }

  const sharedDirOnboard = path.resolve(path.join(dataDir, "shared"));
  initSharedLayer(sharedDirOnboard);
  const bundledOnboard = installBundledExtensions(sharedDirOnboard);
  if (bundledOnboard.length > 0) {
    console.log(`  ✅ 内置扩展: ${bundledOnboard.join(", ")}`);
  }
  linkTemplateToShared(templateDir, sharedDirOnboard);

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
  console.log("  模板: pit template ls");
  console.log("  帮助: pit help");
  console.log("");
}

/** 解析模板（含位置参数）+ 首次启动自动迁移 */
export async function resolveTemplateAndMigrate(flags: Record<string, string>, passthrough: string[]): Promise<{ templateId: string; piPassthrough: string[] } | null> {
  const config = loadConfig();

  let templateInput = flags.template;
  const piPassthrough = [...passthrough];
  if (!templateInput && piPassthrough.length > 0) {
    const resolved = resolveTemplateId(piPassthrough[0], config);
    if (resolved.ok) {
      templateInput = piPassthrough[0];
      piPassthrough.splice(0, 1);
    }
  }

  const templateId = resolveOrFail(templateInput, config);
  if (!templateId) return null;

  const dataDir = resolveDataDir(config);
  const tenantConfigDir = path.join(dataDir, "pi-config", templateId);
  const classicPiAgentDir = path.join(homedir(), ".pi", "agent");
  if (fs.existsSync(classicPiAgentDir) && !fs.existsSync(path.join(tenantConfigDir, "settings.json"))) {
    console.log("");
    console.log("  \x1b[36m检测到现有 pi 环境 (~/.pi/agent/)\x1b[0m");
    console.log("  正在迁移扩展和配置...");
    try {
      await migrate({ templateId });
      const sharedDir = path.join(dataDir, "shared");
      const { linkTemplateToShared: relink } = await import("../shared-layer.js");
      relink(tenantConfigDir, sharedDir);
      console.log("  \x1b[32m✅ 迁移完成\x1b[0m");
    } catch (err: any) {
      console.log(`  \x1b[33m⚠️  迁移部分失败: ${err.message}\x1b[0m`);
    }
    console.log("");
  }

  return { templateId, piPassthrough };
}
