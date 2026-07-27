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
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig, resolveDataDir, type PiTripleConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { launchPi } from "./launcher.js";
import { migrate } from "./migrate.js";
import { initSharedLayer, linkTenantToShared, sharedStatus, promoteToShared } from "./shared-layer.js";

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
  console.log("    start [args...]    启动 pi（--bg 后台，--name 命名）");
  console.log("    attach <name>      接入后台会话（同一终端切换）");
  console.log("    ls                 列出所有会话（前台+后台）");
  console.log("    stop <name>        停止后台会话");
  console.log("    status             快速健康检查");
  console.log("    doctor             完整健康检查 + 交互修复");
  console.log("    tenant ls          列出所有租户");
  console.log("    tenant new [name]  新建租户");
  console.log("    tenant rm <name>   删除租户");
  console.log("    update             更新 pi 到最新版");
  console.log("    install <source>    安装 pi 扩展 (--shared 装到共享层)");
  console.log("    remove <source>     卸载 pi 扩展");
  console.log("    migrate            迁移 pi 扩展到当前租户");
  console.log("    shared status       查看共享层状态");
  console.log("    shared init         初始化共享层（从默认租户提升）");
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
  console.log("    pit start --bg --name coding         # 后台启动");
  console.log("    pit attach coding                    # 接入后台会话");
  console.log("    pit ls                               # 列出所有会话");
  console.log("    pit stop coding                      # 停止后台会话");
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
      if (key === "tenant" || key === "project" || key === "model" || key === "provider" || key === "thinking" || key === "name") {
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

  // 自动链接共享层
  const sharedDirPath = path.resolve(process.cwd(), config.sharedDir);
  if (fs.existsSync(sharedDirPath)) {
    linkTenantToShared(tenantDir, sharedDirPath);
    console.log("  ✅ 已链接共享层");
  }

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


// ─── Tmux Session Management ─────────────────────────────────

function hasTmux(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
}

function tmuxSessionName(name: string): string {
  return `pit-${name}`;
}

function cmdStartBg(flags: Record<string, string>, passthrough: string[]): void {
  const config = loadConfig();
  const tenantId = flags.tenant ?? config.defaultTenant;
  const name = flags.name ?? `${tenantId}-${Date.now().toString(36)}`;
  const session = tmuxSessionName(name);

  if (!hasTmux()) {
    console.log("  \x1b[31m❌ tmux 未安装\x1b[0m");
    if (process.platform === "darwin") console.log("  安装: brew install tmux");
    else if (process.platform === "linux") console.log("  安装: sudo apt install tmux");
    else console.log("  Windows: 请使用 WSL2 安装 tmux");
    process.exit(1);
  }

  const check = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf-8" });
  if (check.status === 0) {
    console.log(`  ⚠️  会话 "${name}" 已在运行`);
    console.log(`  接入: pit attach ${name}`);
    return;
  }

  const tenantConfig = config.tenants[tenantId] ?? {};
  const piArgs: string[] = [];
  const provider = flags.provider ?? tenantConfig.provider;
  const model = flags.model ?? tenantConfig.model;
  if (provider) piArgs.push("--provider", provider);
  if (model) piArgs.push("--model", model);
  if (flags.thinking) piArgs.push("--thinking", flags.thinking);
  if (passthrough.includes("-c")) piArgs.push("--continue");

  const dataDir = resolveDataDir(config);
  const agentDir = path.join(dataDir, "pi-config", tenantId);
  const piCmd = `PI_CODING_AGENT_DIR=${agentDir} pi ${piArgs.join(" ")}`;

  const result = spawnSync("tmux", [
    "new-session", "-d", "-s", session,
    "-x", "200", "-y", "50",
    piCmd,
  ], { encoding: "utf-8", env: { ...process.env } });

  if (result.status === 0) {
    console.log(`  \x1b[32m✅ 后台会话已启动\x1b[0m`);
    console.log(`  名称: ${name}  租户: ${tenantId}`);
    console.log(`  接入: \x1b[36mpit attach ${name}\x1b[0m`);
    console.log(`  切换: tmux 内 \x1b[2mCtrl+B s\x1b[0m 选择 · \x1b[2mCtrl+B d\x1b[0m 脱离`);
  } else {
    console.log(`  \x1b[31m❌ 启动失败: ${result.stderr}\x1b[0m`);
  }
}

function cmdAttach(name: string): void {
  if (!name) { cmdLs(); console.log("  用法: pit attach <name>"); return; }
  if (!hasTmux()) { console.log("  \x1b[31m❌ tmux 未安装\x1b[0m"); process.exit(1); }

  const session = tmuxSessionName(name);
  const check = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf-8" });
  if (check.status !== 0) {
    console.log(`  \x1b[31m❌ 会话 "${name}" 不存在\x1b[0m`);
    console.log("  运行 pit ls 查看可用会话");
    return;
  }

  const result = spawnSync("tmux", ["attach", "-t", session], {
    stdio: "inherit",
    env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
  });
  process.exit(result.status ?? 0);
}

function cmdLs(): void {
  printBanner();
  if (!hasTmux()) { console.log("  tmux 未安装\n"); return; }

  const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_created}"], { encoding: "utf-8" });
  const sessions = (result.stdout ?? "").trim().split("\n")
    .filter((l) => l.startsWith("pit-"))
    .map((l) => {
      const [full, win, created] = l.split(":");
      return { name: full.replace(/^pit-/, ""), windows: parseInt(win ?? "1"), created: new Date(parseInt(created ?? "0") * 1000) };
    });

  if (sessions.length === 0) {
    console.log("  无后台会话");
    console.log("  启动: pit start --bg --name coding");
  } else {
    console.log("  \x1b[2mNAME              WINDOWS  CREATED\x1b[0m");
    for (const s of sessions) {
      const age = formatAge(Date.now() - s.created.getTime());
      console.log(`  \x1b[1m${s.name.padEnd(18)}\x1b[0m${String(s.windows).padEnd(9)}${age}`);
    }
    console.log("\n  接入: \x1b[36mpit attach <name>\x1b[0m · 停止: \x1b[36mpit stop <name>\x1b[0m");
  }
  console.log("");
}

function cmdStop(name: string): void {
  if (!name) { console.log("  用法: pit stop <name>"); return; }
  if (name === "--all") {
    const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf-8" });
    const pits = (result.stdout ?? "").trim().split("\n").filter((s) => s.startsWith("pit-"));
    for (const s of pits) { spawnSync("tmux", ["kill-session", "-t", s]); console.log(`  ✅ 已停止 ${s.replace(/^pit-/, "")}`); }
    if (pits.length === 0) console.log("  无后台会话");
    return;
  }
  const result = spawnSync("tmux", ["kill-session", "-t", tmuxSessionName(name)], { encoding: "utf-8" });
  console.log(result.status === 0 ? `  ✅ 已停止 "${name}"` : `  \x1b[31m❌ 会话 "${name}" 不存在\x1b[0m`);
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
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
      if (flags.bg === "true") {
        cmdStartBg(flags, passthrough);
      } else {
        await cmdStart(flags, passthrough);
      }
      break;
    case "attach":
      cmdAttach(subcommand || passthrough[0] || "");
      break;
    case "ls":
      cmdLs();
      break;
    case "stop":
      cmdStop(subcommand || passthrough[0] || "");
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
    case "update": {
      console.log("  检查 pi 更新…");
      const cur = spawnSync("pi", ["--version"], { encoding: "utf-8" });
      const latest = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], { encoding: "utf-8" });
      const curVer = cur.stdout?.trim() ?? "unknown";
      const latestVer = latest.stdout?.trim() ?? "unknown";
      console.log(`  当前: v${curVer}  最新: v${latestVer}`);
      if (curVer === latestVer) {
        console.log("  \x1b[32m✅ 已是最新版\x1b[0m");
      } else {
        console.log(`  升级中…`);
        const r = spawnSync("npm", ["install", "-g", `@earendil-works/pi-coding-agent@${latestVer}`], { stdio: "inherit" });
        if (r.status === 0) console.log(`  \x1b[32m✅ 已升级到 v${latestVer}\x1b[0m`);
        else console.log("  \x1b[31m❌ 升级失败\x1b[0m");
      }
      break;
    }
    case "install":
    case "remove":
    case "uninstall": {
      const config2 = loadConfig();
      const dataDir = resolveDataDir(config2);
      const sharedDir = path.resolve(process.cwd(), config2.sharedDir);
      const isShared = flags.shared === "true";

      // 确定目标目录
      let agentDir: string;
      if (isShared) {
        initSharedLayer(sharedDir);
        agentDir = sharedDir;
      } else {
        const tid = flags.tenant ?? config2.defaultTenant;
        agentDir = path.join(dataDir, "pi-config", tid);
      }

      const piArgs = [command, subcommand, ...passthrough].filter((a): a is string => Boolean(a));
      console.log(`  ${isShared ? "共享层" : "租户"}  ${agentDir}`);
      const r = spawnSync("pi", piArgs, {
        stdio: "inherit",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      });
      process.exit(r.status ?? 0);
      break;
    }
    case "shared": {
      const config2 = loadConfig();
      const dataDir2 = resolveDataDir(config2);
      const sharedDir2 = path.resolve(process.cwd(), config2.sharedDir);

      if (subcommand === "init") {
        // 从默认租户提升到共享层
        const tenantDir = path.join(dataDir2, "pi-config", config2.defaultTenant);
        if (!fs.existsSync(tenantDir)) {
          console.log(`  ❌ 默认租户 "${config2.defaultTenant}" 不存在，先运行 pit onboard`);
          break;
        }
        const { moved, kept } = promoteToShared(tenantDir, sharedDir2);
        console.log(`  ✅ 迁移到共享层: ${moved.length} 项`);
        for (const m of moved) console.log(`    📦 ${m}`);
        if (kept.length > 0) {
          console.log(`  保留在租户: ${kept.length} 项`);
          for (const k of kept) console.log(`    ${k}`);
        }
        // 重新链接
        linkTenantToShared(tenantDir, sharedDir2);
        console.log("  ✅ 已链接共享层到默认租户");
      } else {
        // status
        const st = sharedStatus(sharedDir2);
        printBanner();
        if (!st.exists) {
          console.log("  共享层未初始化。运行: pit shared init");
        } else {
          console.log(`  共享层: ${sharedDir2}`);
          console.log(`  扩展: ${st.extensions}  技能: ${st.skills}  包: ${st.packages}`);
        }
        console.log("");
      }
      break;
    }
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
