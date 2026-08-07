/**
 * ptl/config-cmd — cmdConfig: get/set/unset/init/show
 */

import { loadConfig, saveConfig, getConfigValue, setConfigValue, unsetConfigValue } from "@pi-triple/shared";
import { printBanner } from "./main.js";

export function cmdConfig(subcommand?: string, args: string[] = []): void {
  if (subcommand === "init") {
    const config = loadConfig();
    saveConfig(config);
    console.log("  ✅ pi-triple.json 已创建 (v2, UUID+alias)");
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (subcommand === "get") {
    const key = args[0];
    if (!key) { console.log("  用法: ptl config get <key>"); process.exit(1); }
    const val = getConfigValue(key);
    if (val === undefined) {
      console.log(`  \x1b[31m❌ 配置键不存在: ${key}\x1b[0m`);
      process.exit(1);
    }
    console.log(val);
    return;
  }

  if (subcommand === "set") {
    const [key, value] = args;
    if (!key || value === undefined) { console.log("  用法: ptl config set <key> <value>"); process.exit(1); }
    const r = setConfigValue(key, value);
    if (!r.ok) {
      console.log(`  \x1b[31m❌ ${r.error}\x1b[0m`);
      process.exit(1);
    }
    console.log(`  \x1b[32m✅ ${key} = ${value}\x1b[0m`);
    if (key === "dataDir" || key === "sharedDir") {
      console.log("  \x1b[33m⚠️  已修改路径但不迁移现有数据，请手动移动\x1b[0m");
    }
    return;
  }

  if (subcommand === "unset") {
    const key = args[0];
    if (!key) { console.log("  用法: ptl config unset <key>"); process.exit(1); }
    const r = unsetConfigValue(key);
    if (!r.ok) {
      console.log(`  \x1b[31m❌ ${r.error}\x1b[0m`);
      process.exit(1);
    }
    console.log(`  \x1b[32m✅ 已删除 ${key}\x1b[0m`);
    return;
  }

  const config = loadConfig();
  printBanner();
  console.log("  配置 (pi-triple.json):\n");
  console.log(JSON.stringify(config, null, 2).split("\n").map((l) => "  " + l).join("\n"));
  console.log("\n  修改: ptl config set <key> <value> · 读取: ptl config get <key>");
  console.log("  键: defaultTenant, redis, gateway.port, dataDir, sharedDir, templates.<alias>.model 等");
  console.log("");
}
