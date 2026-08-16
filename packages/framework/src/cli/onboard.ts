/**
 * ptl/onboard — cmdOnboard, tenant resolution, first-run migration
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";
import {
  loadConfig, saveConfig, resolveDataDir, type PiTripleConfig,
  resolveTemplateId, getTemplateAlias, getDefaultTemplateId, migrateDirectoryNames,
} from "@away_from/shared";
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
  console.log("  运行 \x1b[36mptl template ls\x1b[0m 查看可用模板\n");
  return null;
}

// ── DI 接口 ──

export interface OnboardPrompter {
  confirm(question: string): Promise<boolean>;
  text(question: string, def?: string): Promise<string>;
}

export interface OnboardDeps {
  doctor: (mode: "full" | "quick") => Promise<void>;
  saveConfig: (cfg: PiTripleConfig) => void;
  ensureTemplate: (templateId: string) => Promise<{ created: boolean; alias: string }>;
  initShared: (sharedDir: string) => string[];
  linkShared: (templateDir: string, sharedDir: string) => void;
  migrateDirs: (cfg: PiTripleConfig) => string[];
  launchTui: () => Promise<void>;
}

// ── 默认实现 ──

/** readline 交互 prompter（复用 doctor.ts 模式）。 */
function createReadlinePrompter(): OnboardPrompter {
  const ask = (question: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    });
  };
  return {
    confirm: async (q) => {
      const a = await ask(`  \x1b[36m▸ ${q} (Y/n) \x1b[0m`);
      return a.trim().toLowerCase() !== "n";
    },
    text: async (q, def) => {
      const a = await ask(`  \x1b[36m▸ ${q}${def ? ` [${def}]` : ""}: \x1b[0m`);
      return a.trim() || def || "";
    },
  };
}

function defaultDeps(): OnboardDeps {
  return {
    doctor: async (mode) => { await runDoctor(mode); },
    saveConfig: (cfg) => saveConfig(cfg),
    ensureTemplate: async (templateId) => {
      const config = loadConfig();
      const dataDir = resolveDataDir(config);
      const templateDir = path.join(dataDir, "pi-config", templateId);
      const alias = getTemplateAlias(templateId, config);
      const exists = fs.existsSync(templateDir) && fs.existsSync(path.join(templateDir, "settings.json"));
      if (!exists) await migrate({ templateId, quietIfNoSource: true });
      return { created: !exists, alias };
    },
    initShared: (sharedDir) => {
      initSharedLayer(sharedDir);
      return installBundledExtensions(sharedDir);
    },
    linkShared: (templateDir, sharedDir) => linkTemplateToShared(templateDir, sharedDir),
    migrateDirs: (cfg) => migrateDirectoryNames(cfg),
    launchTui: async () => {
      const { render } = await import("ink");
      const React = (await import("react")).default;
      const { PtlApp } = await import("../tui-ptl/app.js");
      render(React.createElement(PtlApp), { exitOnCtrlC: false });
    },
  };
}

// ── 导引主流程 ──

export async function cmdOnboard(
  flags: Record<string, string>,
  prompter?: OnboardPrompter,
  deps: OnboardDeps = defaultDeps(),
): Promise<void> {
  const interactive = !!prompter || (process.stdout.isTTY && process.stdin.isTTY);
  const p = prompter ?? (interactive ? createReadlinePrompter() : undefined);

  printBanner();
  console.log("  \x1b[1m欢迎使用 Pi-Triple！\x1b[0m 开始首次导引…\n");

  console.log("  \x1b[1mStep 1/4\x1b[0m — 环境检查\n  " + "─".repeat(40));
  await deps.doctor("full");

  console.log("  \x1b[1mStep 2/4\x1b[0m — 初始化配置\n  " + "─".repeat(40));
  const config = loadConfig();
  if (!fs.existsSync(path.resolve("pi-triple.json"))) {
    deps.saveConfig(config);
  }
  console.log("  ✅ pi-triple.json 已就绪 (v2, UUID+alias)\n");

  console.log("  \x1b[1mStep 3/4\x1b[0m — 模板环境\n  " + "─".repeat(40));
  const dataDir = resolveDataDir(config);
  const defaultId = getDefaultTemplateId(config);
  const t = await deps.ensureTemplate(defaultId);
  console.log(t.created ? `  创建模板 "${t.alias}"` : `  ✅ 模板 "${t.alias}" 已存在`);
  const sharedDir = path.join(dataDir, "shared");
  const bundled = deps.initShared(sharedDir);
  if (bundled.length > 0) console.log(`  ✅ 内置扩展: ${bundled.join(", ")}`);
  deps.linkShared(path.join(dataDir, "pi-config", defaultId), sharedDir);
  const renamed = deps.migrateDirs(config);
  if (renamed.length > 0) console.log(`  📁 目录迁移: ${renamed.join(", ")}`);

  console.log("  \x1b[1mStep 4/4\x1b[0m — 验证\n  " + "─".repeat(40));
  await deps.doctor("quick");

  console.log("\n  \x1b[32m\x1b[1m🎉 Pi-Triple 准备就绪！\x1b[0m\n");
  console.log("  启动: ptl start\n  可视化: ptl tui dashboard\n  帮助: ptl help\n");

  // 交互向导：询问是否立即启动总控 TUI
  if (p) {
    const go = await p.confirm("立即打开系统总控面板 (ptl tui dashboard)？");
    if (go) await deps.launchTui();
  }
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
