#!/usr/bin/env node
/**
 * pit — Pi-Triple 统一 CLI
 *
 * 用法：
 *   pit onboard          首次导引（检查 + 安装 + 创建租户 + 迁移）
 *   pit start            启动 pi（带租户隔离）
 *   pit status           健康检查
 *   pit tenant ls        列出租户
 *   pit tenant new       新建租户（交互式）
 *   pit tenant rm <name> 删除租户
 *   pit config           查看/编辑配置
 *   pit doctor           完整健康检查
 *   pit migrate          迁移扩展
 *   pit help             帮助
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig, resolveDataDir, type PiTripleConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { launchPi } from "./launcher.js";
import { migrate } from "./migrate.js";

const VERSION = "0.1.0";

// ─── Helpers ─────────────────────────────────────────────────

function printBanner(): void {
  console.log("");
  console.log("  \x1b[36m\x1b[1mPi-Triple\x1b[0m \x1b[2mv" + VERSION + "\x1b[0m");
  console.log("");
}

function printHelp(): void {
  printBanner();
  console.log("  用法: pit <command> [options]");
  console.log("");
  console.log("  命令:");
  console.log("    onboard            首次导引（检查→安装→租户→迁移→验证）");
  console.log("    start [args...]    启动 pi（透传 pi 参数）");
  console.log("    status             快速健康检查");
  console.log("    doctor             完整健康检查 + 交互修复");
  console.log("    tenant ls          列出所有租户");
  console.log("    tenant new [name]  新建租户");
  console.log("    tenant rm <name>   删除租户");
  console.log("    migrate            迁移 pi 扩展到当前租户");
  console.log("    config             显示当前配置");
  console.log("    config init        初始化 pi-triple.json");
  console.log("    help               显示帮助");
  console.log("");
  console.log("  选项:");
  console.log("    --tenant <name>    指定租户（默认读 pi-triple.json）");
  console.log("    --project <name>   指定项目");
  console.log("    --model <model>    覆盖模型");
  console.log("");
  console.log("  示例:");
  console.log("    pit start                          # 默认租户启动");
  console.log("    pit start --tenant dev -c          # dev 租户，继续会话");
  console.log("    pit start -- --thinking high       # 透传 pi 参数");
  console.log("    pit tenant new my-team             # 新建租户");
  console.log("");
}

function parseArgs(args: string[]): { command: string; subcommand?: string; flags: Record<string, string>; passthrough: string[] } {
  const flags: Record<string, string> = {};
  const passthrough: string[] = [];
  let command = "";
  let subcommand = "";
  let i = 0;

  // 第一个非 -- 参数是 command
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "tenant" || key === "project" || key === "model" || key === "provider" || key === "thinking") {
        flags[key] = args[++i] ?? "";
      } else {
        flags[key] = "true";
      }
    } else if (!command) {
      command = arg;
    } else if (!subcommand && !arg.startsWith("-")) {
      subcommand = arg;
    } else {
      passthrough.push(arg);
    }
    i++;
  }

  return { command, subcommand, flags, passthrough };
}

// ─── Commands ────────────────────────────────────────────────

async function cmdOnboard(flags: Record<string, string>): Promise<void> {
  printBanner();
  console.log("  \x1b[1m欢迎使用 Pi-Triple！\x1b[0m 开始首次导引…");
  console.log("");

  // Step 1: 健康检查
  console.log("  \x1b[1mStep 1/4\x1b[0m — 环境检查");
  console.log("  " + "─".repeat(40));
  const healthy = await runDoctor("full");

  // Step 2: 初始化配置
  console.log("  \x1b[1mStep 2/4\x1b[0m — 初始化配置");
  console.log("  " + "─".repeat(40));
  const configPath = path.resolve("pi-triple.json");
  if (fs.existsSync(configPath)) {
    console.log("  ✅ pi-triple.json 已存在");
  } else {
    const config = loadConfig();
    saveConfig(config);
    console.log("  ✅ 已创建 pi-triple.json");
  }

  // Step 3: 创建/确认租户
  console.log("");
  console.log("  \x1b[1mStep 3/4\x1b[0m — 租户环境");
  console.log("  " + "─".repeat(40));
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const tenantName = flags.tenant ?? config.defaultTenant;
  const tenantDir = path.join(dataDir, "pi-config", tenantName);

  if (fs.existsSync(tenantDir) && fs.existsSync(path.join(tenantDir, "settings.json"))) {
    console.log(`  ✅ 租户 "${tenantName}" 已存在`);
  } else {
    console.log(`  创建租户 "${tenantName}"…`);
    await migrate({ tenantId: tenantName });
  }

  // Step 4: 验证
  console.log("  \x1b[1mStep 4/4\x1b[0m — 验证");
  console.log("  " + "─".repeat(40));
  const quickOk = await runDoctor("quick");

  console.log("");
  if (quickOk) {
    console.log("  \x1b[32m\x1b[1m🎉 Pi-Triple 准备就绪！\x1b[0m");
    console.log("");
    console.log(`  启动: pit start`);
    console.log(`  帮助: pit help`);
  } else {
    console.log("  \x1b[33m⚠️  部分检查未通过，请修复后重试\x1b[0m");
    console.log("  运行: pit doctor");
  }
  console.log("");
}

async function cmdStart(flags: Record<string, string>, passthrough: string[]): Promise<void> {
  const config = loadConfig();
  const tenantId = flags.tenant ?? config.defaultTenant;
  const tenantConfig = config.tenants[tenantId] ?? {};

  // 快速检查
  await runDoctor("quick");

  const code = await launchPi({
    tenantId,
    project: flags.project,
    provider: flags.provider ?? tenantConfig.provider,
    model: flags.model ?? tenantConfig.model,
    thinking: flags.thinking ?? tenantConfig.thinking,
    tools: tenantConfig.tools,
    excludeTools: tenantConfig.excludeTools,
    continueSession: passthrough.includes("-c") || passthrough.includes("--continue"),
    extraArgs: passthrough.filter((a) => a !== "-c" && a !== "--continue"),
  });

  process.exit(code);
}

async function cmdStatus(): Promise<void> {
  printBanner();
  await runDoctor("quick");
}

async function cmdDoctor(): Promise<void> {
  await runDoctor("full");
}

function cmdTenantList(): void {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const configDir = path.join(dataDir, "pi-config");

  printBanner();
  console.log("  租户列表:");
  console.log("");

  if (!fs.existsSync(configDir)) {
    console.log("  (无租户，运行 pit onboard 创建)");
    console.log("");
    return;
  }

  const tenants = fs.readdirSync(configDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (tenants.length === 0) {
    console.log("  (无租户，运行 pit tenant new 创建)");
  } else {
    for (const t of tenants) {
      const isDefault = t === config.defaultTenant;
      const mark = isDefault ? "\x1b[36m*\x1b[0m" : " ";
      const tenantCfg = config.tenants[t];
      const model = tenantCfg?.model ?? "(默认)";

      // 统计扩展/技能数
      const extDir = path.join(configDir, t, "extensions");
      const skillDir = path.join(configDir, t, "skills");
      const extCount = fs.existsSync(extDir) ? fs.readdirSync(extDir).length : 0;
      const skillCount = fs.existsSync(skillDir) ? fs.readdirSync(skillDir).length : 0;

      console.log(`  ${mark} \x1b[1m${t}\x1b[0m  model: ${model}  ext: ${extCount}  skills: ${skillCount}${isDefault ? "  \x1b[2m(default)\x1b[0m" : ""}`);
    }
  }
  console.log("");
}

async function cmdTenantNew(name?: string, flags?: Record<string, string>): Promise<void> {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);

  printBanner();

  if (!name) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    name = await new Promise<string>((resolve) => {
      rl.question("  租户名称: ", (answer) => { rl.close(); resolve(answer.trim() || "my-team"); });
    });
  }

  name = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const tenantDir = path.join(dataDir, "pi-config", name);

  if (fs.existsSync(tenantDir)) {
    console.log(`  ⚠️  租户 "${name}" 已存在`);
    return;
  }

  console.log(`  创建租户 "${name}"…`);
  console.log("");
  await migrate({ tenantId: name });

  // 写入 config
  config.tenants[name] = {};
  saveConfig(config);
  console.log(`  ✅ 已添加到 pi-triple.json`);
  console.log(`  启动: pit start --tenant ${name}`);
  console.log("");
}

function cmdTenantRm(name: string): void {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);

  if (!name) {
    console.log("  用法: pit tenant rm <name>");
    return;
  }

  const tenantDir = path.join(dataDir, "pi-config", name);
  if (!fs.existsSync(tenantDir)) {
    console.log(`  ❌ 租户 "${name}" 不存在`);
    return;
  }

  fs.rmSync(tenantDir, { recursive: true, force: true });
  delete config.tenants[name];
  if (config.defaultTenant === name) {
    config.defaultTenant = "local";
  }
  saveConfig(config);
  console.log(`  ✅ 租户 "${name}" 已删除`);
}

function cmdConfig(subcommand?: string): void {
  if (subcommand === "init") {
    const config = loadConfig();
    saveConfig(config);
    console.log("  ✅ pi-triple.json 已创建");
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const config = loadConfig();
  printBanner();
  console.log("  配置 (pi-triple.json):");
  console.log("");
  console.log(JSON.stringify(config, null, 2).split("\n").map((l) => "  " + l).join("\n"));
  console.log("");
}

async function cmdMigrate(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  const tenantId = flags.tenant ?? config.defaultTenant;
  await migrate({ tenantId, dryRun: flags["dry-run"] === "true" });
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const { command, subcommand, flags, passthrough } = parseArgs(args);

  switch (command) {
    case "onboard":
      await cmdOnboard(flags);
      break;
    case "start":
      await cmdStart(flags, passthrough);
      break;
    case "status":
      await cmdStatus();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "tenant":
      if (subcommand === "ls" || subcommand === "list") cmdTenantList();
      else if (subcommand === "new") await cmdTenantNew(passthrough[0], flags);
      else if (subcommand === "rm") cmdTenantRm(passthrough[0] ?? subcommand);
      else cmdTenantList();
      break;
    case "migrate":
      await cmdMigrate(flags);
      break;
    case "config":
      cmdConfig(subcommand);
      break;
    case "help":
    case "--help":
    case "-h":
    case "":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(`pit v${VERSION}`);
      break;
    default:
      console.log(`  未知命令: ${command}`);
      console.log("  运行 pit help 查看帮助");
      break;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
