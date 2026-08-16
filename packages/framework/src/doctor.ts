/**
 * Pi-Triple Doctor — 启动导引 & 健康检查
 *
 * 首次启动：完整检查 + 交互式修复
 * 后续启动：快速检查（跳过已通过项）
 *
 * 用法：
 *   ptl doctor              # 独立运行完整检查
 *   ptl tui dashboard       # 启动前自动快速检查
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import * as readline from "node:readline";
import { checkTemplateAgentsMd } from "./doctor-agents.js";
import { loadConfig, resolveDataDir } from "@away_from/shared";

// ─── Types ───────────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  fixable: boolean;
  /** 非交互环境可执行的修复指引（如 brew install git / export API key） */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  allOk: boolean;
}

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: () => Promise<boolean>;  // 返回 true = 已修复
  fixDescription?: string;
}

type CheckFn = () => Promise<CheckResult>;

// ─── UI Helpers ──────────────────────────────────────────────

const icons = { ok: "✅", warn: "⚠️", fail: "❌", arrow: "→" };

function printHeader(): void {
  console.log("");
  console.log("\x1b[36m╔══════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║\x1b[0m   \x1b[1mPi-Triple Doctor\x1b[0m                 \x1b[36m║\x1b[0m");
  console.log("\x1b[36m║\x1b[0m   启动导引 & 健康检查              \x1b[36m║\x1b[0m");
  console.log("\x1b[36m╚══════════════════════════════════════╝\x1b[0m");
  console.log("");
}

async function ask(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  \x1b[36m${icons.arrow} ${question} (Y/n) \x1b[0m`, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== "n");
    });
  });
}

function tryExec(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr?.toString()?.trim() ?? err.message };
  }
}

// ─── Checks ──────────────────────────────────────────────────

const checkNodeVersion: CheckFn = async () => {
  const version = process.version;
  const major = parseInt(version.slice(1), 10);
  if (major >= 22) {
    return { name: "Node.js", status: "ok", message: `${version}` };
  }
  return {
    name: "Node.js",
    status: "fail",
    message: `${version} — 需要 >= 22`,
    fixDescription: "安装 Node.js 22+: brew install node@22",
    fix: async () => {
      console.log("  请手动安装 Node.js 22+:");
      console.log("    macOS:  brew install node@22");
      console.log("    Linux:  https://nodejs.org/");
      console.log("    Windows: https://nodejs.org/");
      return false;
    },
  };
};

const checkPiInstalled: CheckFn = async () => {
  const result = tryExec("pi --version");
  if (result.ok) {
    return { name: "pi CLI", status: "ok", message: `v${result.output}` };
  }
  return {
    name: "pi CLI",
    status: "fail",
    message: "未安装",
    fixDescription: "npm install -g @earendil-works/pi-coding-agent",
    fix: async () => {
      if (await ask("自动安装 pi？")) {
        console.log("  安装中…");
        const install = tryExec("npm install -g @earendil-works/pi-coding-agent");
        if (install.ok) {
          console.log("  ✅ pi 安装成功");
          return true;
        }
        console.log(`  ❌ 安装失败: ${install.output}`);
      }
      return false;
    },
  };
};

const checkPiUpdate: CheckFn = async () => {
  const current = tryExec("pi --version");
  if (!current.ok) return { name: "pi 更新", status: "warn", message: "跳过（pi 未安装）" };

  const latest = tryExec("npm view @earendil-works/pi-coding-agent version");
  if (!latest.ok) return { name: "pi 更新", status: "warn", message: "无法检查最新版本" };

  const currentVer = current.output.trim();
  const latestVer = latest.output.trim();

  if (currentVer === latestVer) {
    return { name: "pi 更新", status: "ok", message: `已是最新 (v${currentVer})` };
  }
  return {
    name: "pi 更新",
    status: "warn",
    message: `当前 v${currentVer} → 最新 v${latestVer}`,
    fixDescription: `npm install -g @earendil-works/pi-coding-agent@${latestVer}`,
    fix: async () => {
      if (await ask(`升级到 v${latestVer}？`)) {
        console.log("  升级中…");
        const upgrade = spawnSync("npm", ["install", "-g", `@earendil-works/pi-coding-agent@${latestVer}`], { encoding: "utf-8", timeout: 60_000 });
        if (upgrade.status === 0) {
          console.log(`  ✅ 已升级到 v${latestVer}`);
          return true;
        }
        console.log(`  ❌ 升级失败: ${upgrade.output}`);
      }
      return false;
    },
  };
};

const checkRedis: CheckFn = async () => {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  let host: string;
  let port: number;
  try {
    const url = new URL(redisUrl);
    host = url.hostname;
    port = parseInt(url.port || "6379", 10);
  } catch {
    return {
      name: "Redis",
      status: "fail",
      message: `${redisUrl} 不是有效的 URL`,
      fixDescription: "设置 REDIS_URL=redis://localhost:6379",
    };
  }

  const reachable = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 3000 });
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });

  if (reachable) {
    return { name: "Redis", status: "ok", message: `${host}:${port} 可连接` };
  }

  return {
    name: "Redis",
    status: "fail",
    message: `${host}:${port} 无法连接`,
    fixDescription: "brew install redis && brew services start redis",
    fix: async () => {
      // 检查是否已安装但未启动
      const installed = tryExec("redis-server --version");
      if (installed.ok) {
        if (await ask("Redis 已安装但未运行，启动它？")) {
          const started = tryExec("redis-server --daemonize yes");
          if (started.ok) {
            // 等待启动
            await new Promise((r) => setTimeout(r, 1000));
            console.log("  ✅ Redis 已启动");
            return true;
          }
          // macOS brew services
          const brew = tryExec("brew services start redis");
          if (brew.ok) {
            await new Promise((r) => setTimeout(r, 1000));
            console.log("  ✅ Redis 已通过 brew services 启动");
            return true;
          }
        }
      } else {
        if (await ask("安装并启动 Redis？")) {
          if (process.platform === "darwin") {
            console.log("  安装中 (brew)…");
            const install = tryExec("brew install redis");
            if (install.ok) {
              tryExec("brew services start redis");
              await new Promise((r) => setTimeout(r, 1500));
              console.log("  ✅ Redis 已安装并启动");
              return true;
            }
          } else if (process.platform === "linux") {
            console.log("  请手动安装:");
            console.log("    Ubuntu/Debian: sudo apt install redis-server");
            console.log("    CentOS/RHEL:   sudo yum install redis");
          } else {
            console.log("  Windows: 下载 https://github.com/tporadowski/redis/releases");
          }
        }
      }
      return false;
    },
  };
};

const checkApiKeys: CheckFn = async () => {
  const providers: Array<{ name: string; envVars: string[] }> = [
    { name: "Anthropic", envVars: ["PI_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"] },
    { name: "OpenAI", envVars: ["PI_OPENAI_API_KEY", "OPENAI_API_KEY"] },
    { name: "Google", envVars: ["PI_GOOGLE_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"] },
    { name: "OpenRouter", envVars: ["PI_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"] },
    { name: "DeepSeek", envVars: ["PI_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"] },
  ];

  const found: string[] = [];
  for (const p of providers) {
    if (p.envVars.some((v) => process.env[v])) {
      found.push(p.name);
    }
  }

  // 也检查 pi 的 auth.json
  const authJsonPath = path.join(process.env.HOME ?? "~", ".pi", "agent", "auth.json");
  let piAuth = false;
  if (fs.existsSync(authJsonPath)) {
    try {
      const auth = JSON.parse(fs.readFileSync(authJsonPath, "utf-8"));
      piAuth = Object.keys(auth).length > 0;
    } catch { /* ignore */ }
  }

  if (found.length > 0 || piAuth) {
    const sources = [...found];
    if (piAuth) sources.push("pi auth.json");
    return { name: "API Keys", status: "ok", message: sources.join(", ") };
  }

  return {
    name: "API Keys",
    status: "fail",
    message: "未检测到任何 API key",
    fixDescription: "export ANTHROPIC_API_KEY=sk-... 或 pi /login",
    fix: async () => {
      console.log("  设置 API key（任选一个）:");
      console.log("    export ANTHROPIC_API_KEY=sk-ant-...");
      console.log("    export OPENAI_API_KEY=sk-...");
      console.log("    export GOOGLE_API_KEY=...");
      console.log("    export DEEPSEEK_API_KEY=sk-...");
      console.log("  或使用 pi 内置登录:");
      console.log("    pi /login");
      return false;
    },
  };
};

const checkNpmDeps: CheckFn = async () => {
  const nodeModules = path.join(process.cwd(), "node_modules");
  if (fs.existsSync(nodeModules)) {
    return { name: "npm 依赖", status: "ok", message: "已安装" };
  }
  return {
    name: "npm 依赖",
    status: "fail",
    message: "node_modules 不存在",
    fixDescription: "npm install",
    fix: async () => {
      if (await ask("运行 npm install？")) {
        console.log("  安装中…");
        const install = spawnSync("npm", ["install"], { stdio: "inherit", timeout: 120_000 });
        if (install.status === 0) {
          console.log("  ✅ 依赖安装成功");
          return true;
        }
        console.log("  ❌ 安装失败");
      }
      return false;
    },
  };
};

const checkDataDir: CheckFn = async () => {
  const dataDir = process.env.DATA_DIR ?? "./.pi-platform-data";
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const testFile = path.join(dataDir, ".doctor-test");
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return { name: "数据目录", status: "ok", message: `${dataDir} 可写` };
  } catch (err: any) {
    return {
      name: "数据目录",
      status: "fail",
      message: `${dataDir} 不可写: ${err.message}`,
    };
  }
};

const checkGit: CheckFn = async () => {
  const result = tryExec("git --version");
  if (result.ok) {
    return { name: "Git", status: "ok", message: result.output };
  }
  return {
    name: "Git",
    status: "warn",
    message: "未安装（pi 的 bash 工具需要 git）",
    fixDescription: "brew install git / apt install git",
  };
};

// ─── Structured Runner (no console.log, no interactive fix) ─

export async function runDoctorStructured(mode: "full" | "quick" = "full"): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const fns = mode === "full" ? ALL_CHECKS : QUICK_CHECKS;

  for (const fn of fns) {
    const result = await fn();
    checks.push({
      name: result.name,
      ok: result.status === "ok" || result.status === "warn",
      message: result.message,
      fixable: result.status === "fail",
      ...(result.status === "fail" && result.fixDescription ? { fix: result.fixDescription } : {}),
    });
  }

  // 模板 AGENTS.md 认知注入检查（pi 原生机制，逐模板一条）
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  for (const [templateId, tpl] of Object.entries(config.templates)) {
    const agentsCheck = checkTemplateAgentsMd(path.join(dataDir, "pi-config", templateId));
    checks.push({
      name: `AGENTS.md (${templateId.slice(0, 8)}…)`,
      ok: agentsCheck.ok,
      message: agentsCheck.ok ? `模板「${tpl.alias}」已就绪` : (agentsCheck.detail ?? "AGENTS.md 异常"),
      // AGENTS.md 修复由 template new / launcher 启动补写自动完成，doctor 内无交互修复入口
      fixable: false,
    });
  }

  return {
    checks,
    allOk: checks.every((c) => c.ok),
  };
}

// ─── Print Renderer ──────────────────────────────────────────

function renderDoctorPrint(report: DoctorReport): void {
  for (const c of report.checks) {
    const icon = c.ok ? icons.ok : icons.fail;
    const color = c.ok ? "\x1b[32m" : "\x1b[31m";
    console.log(`  ${icon} ${color}${c.name}\x1b[0m — ${c.message}`);
    if (!c.ok && c.fix) console.log(`    \x1b[2m→ ${c.fix}\x1b[0m`);
  }
}

// ─── Interactive Fix Runner ──────────────────────────────────

async function offerFixes(failures: CheckResult[]): Promise<void> {
  console.log("");
  console.log(`  \x1b[33m发现 ${failures.length} 个问题需要修复\x1b[0m`);
  console.log("");

  for (const f of failures) {
    if (f.fix) {
      const fixed = await f.fix();
      if (fixed) {
        console.log("");
      }
    } else if (f.fixDescription) {
      console.log(`  ${icons.arrow} ${f.name}: ${f.fixDescription}`);
    }
  }
}

// ─── Runner ──────────────────────────────────────────────────

const ALL_CHECKS: CheckFn[] = [
  checkNodeVersion,
  checkPiInstalled,
  checkPiUpdate,
  checkRedis,
  checkApiKeys,
  checkNpmDeps,
  checkDataDir,
  checkGit,
];

/** 快速检查（启动前，跳过更新检查） */
const QUICK_CHECKS: CheckFn[] = [
  checkNodeVersion,
  checkPiInstalled,
  checkRedis,
  checkApiKeys,
];

export async function runDoctor(mode: "full" | "quick" = "full"): Promise<boolean> {
  if (mode === "full") {
    printHeader();
  }

  // 第一遍：通过 runDoctorStructured 获取数据（不重复执行检查逻辑）
  const report = await runDoctorStructured(mode);
  renderDoctorPrint(report);

  // 交互式修复：仅 full 模式，且存在失败项
  if (!report.allOk && mode === "full") {
    // 重新执行检查（仅失败项）以获取带 fix 函数的 CheckResult
    const failedNames = new Set(report.checks.filter(c => !c.ok).map(c => c.name));
    const failures: CheckResult[] = [];
    for (const checkFn of ALL_CHECKS) {
      const result = await checkFn();
      if (failedNames.has(result.name) && result.status === "fail") {
        failures.push(result);
      }
    }
    if (failures.length > 0) {
      await offerFixes(failures);
    }
  }

  console.log("");
  if (report.allOk) {
    console.log("  \x1b[32m✅ 所有检查通过，Pi-Triple 准备就绪！\x1b[0m");
  } else {
    console.log("  \x1b[33m⚠️  部分检查未通过，某些功能可能不可用。\x1b[0m");
    console.log("  \x1b[2m运行 ptl doctor 重新检查\x1b[0m");
  }
  console.log("");

  return report.allOk;
}

// 独立运行
if (process.argv[1]?.endsWith("doctor.ts") || process.argv[1]?.endsWith("doctor.js")) {
  runDoctor("full").then((ok) => process.exit(ok ? 0 : 1));
}
