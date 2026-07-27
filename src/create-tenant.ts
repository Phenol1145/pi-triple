/**
 * Pi-Triple Create Tenant — 交互式创建独立 pi 环境
 *
 * 用法：
 *   npm run create-tenant                # 交互式
 *   npm run create-tenant -- --name dev  # 指定名称，其余交互
 */

import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { migrate } from "./migrate.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal?: string): Promise<string> {
  const hint = defaultVal ? ` \x1b[2m(${defaultVal})\x1b[0m` : "";
  return new Promise((resolve) => {
    rl.question(`  \x1b[36m→\x1b[0m ${question}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function askYesNo(question: string, defaultVal = true): Promise<boolean> {
  const hint = defaultVal ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`  \x1b[36m→\x1b[0m ${question} (${hint}): `, (answer) => {
      const a = answer.trim().toLowerCase();
      resolve(a === "" ? defaultVal : a !== "n");
    });
  });
}

async function main() {
  console.log("");
  console.log("\x1b[36m╔══════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║\x1b[0m   \x1b[1mPi-Triple Create Tenant\x1b[0m          \x1b[36m║\x1b[0m");
  console.log("\x1b[36m║\x1b[0m   创建独立 pi 环境                 \x1b[36m║\x1b[0m");
  console.log("\x1b[36m╚══════════════════════════════════════╝\x1b[0m");
  console.log("");

  const dataDir = path.resolve(process.env.DATA_DIR ?? "./.pi-platform-data");

  // 列出现有租户
  const configDir = path.join(dataDir, "pi-config");
  const existingTenants: string[] = [];
  if (fs.existsSync(configDir)) {
    for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingTenants.push(entry.name);
    }
  }
  if (existingTenants.length > 0) {
    console.log(`  现有租户: ${existingTenants.join(", ")}`);
    console.log("");
  }

  // 1. 租户名
  let name = process.argv.includes("--name")
    ? process.argv[process.argv.indexOf("--name") + 1]
    : "";
  if (!name) {
    name = await ask("租户名称", "my-team");
  }
  name = name.replace(/[^a-zA-Z0-9_-]/g, "-"); // 安全化

  const tenantDir = path.join(configDir, name);
  if (fs.existsSync(tenantDir)) {
    console.log(`\n  \x1b[33m⚠️  租户 "${name}" 已存在\x1b[0m`);
    const overwrite = await askYesNo("覆盖现有配置？", false);
    if (!overwrite) {
      console.log("  取消。");
      rl.close();
      return;
    }
    fs.rmSync(tenantDir, { recursive: true, force: true });
  }

  // 2. 配置来源
  console.log("");
  console.log("  配置来源:");
  console.log("    1. 从现有 pi 环境复制（推荐）");
  console.log("    2. 从其他租户复制");
  console.log("    3. 全新空白环境");
  const sourceChoice = await ask("选择", "1");

  if (sourceChoice === "1") {
    // 从 ~/.pi/agent 复制
    console.log("");
    await migrate({ tenantId: name });
  } else if (sourceChoice === "2") {
    const sourceTenant = await ask("源租户名", existingTenants[0] ?? "local");
    const sourceDir = path.join(configDir, sourceTenant);
    if (!fs.existsSync(sourceDir)) {
      console.log(`  \x1b[31m❌ 租户 "${sourceTenant}" 不存在\x1b[0m`);
      rl.close();
      return;
    }
    console.log("");
    await migrate({ tenantId: name, source: sourceDir });
  } else {
    // 空白环境
    fs.mkdirSync(tenantDir, { recursive: true });
    fs.writeFileSync(
      path.join(tenantDir, "settings.json"),
      JSON.stringify({ theme: "dark", packages: [] }, null, 2),
    );
    console.log(`\n  ✅ 空白环境已创建: ${tenantDir}`);
    console.log("  首次启动时 pi 会引导你 /login 设置 API key");
  }

  // 3. 自定义设置
  console.log("");
  const customize = await askYesNo("自定义默认模型/提供商？", false);
  if (customize) {
    const settingsPath = path.join(tenantDir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { /* */ }
    }

    const provider = await ask("默认提供商 (留空跳过)", "");
    if (provider) settings.defaultProvider = provider;

    const model = await ask("默认模型 (留空跳过)", "");
    if (model) settings.defaultModel = model;

    const thinking = await ask("思考级别 (off/minimal/low/medium/high/xhigh/max)", "");
    if (thinking) settings.defaultThinkingLevel = thinking;

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log("  ✅ 设置已保存");
  }

  // 4. 完成
  console.log("");
  console.log("\x1b[32m  ✅ 租户创建完成！\x1b[0m");
  console.log("");
  console.log(`  启动: npm run tui -- --tenant ${name}`);
  console.log(`  配置: ${tenantDir}/`);
  console.log(`  工作目录: ${path.join(dataDir, "workspaces", name)}/`);
  console.log(`  会话历史: ${path.join(dataDir, "sessions", name)}/`);
  console.log("");

  rl.close();
}

const isDirectRun = process.argv[1]?.endsWith("create-tenant.ts") || process.argv[1]?.endsWith("create-tenant.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    rl.close();
    process.exit(1);
  });
}
