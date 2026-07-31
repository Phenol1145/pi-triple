/**
 * pit/admin — update / install / remove / shared / migrate / tenant rename
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadConfig, resolveDataDir,
  getTemplateAlias, getDefaultTemplateId,
} from "../config.js";
import { migrate } from "../migrate.js";
import { initSharedLayer, linkTemplateToShared, promoteToShared, installBundledExtensions } from "../shared-layer.js";
import { execSharedStatus } from "../commands.js";
import { printBanner } from "./main.js";
import { resolveOrFail } from "./onboard.js";

export async function cmdMigrate(flags: Record<string, string>): Promise<void> {
  const config = loadConfig();
  const templateId = resolveOrFail(flags.template, config);
  if (!templateId) { process.exit(1); }
  await migrate({ templateId, dryRun: flags["dry-run"] === "true" });
}

export async function handleUpdate(flags: Record<string, string>): Promise<void> {
  const updateAll = flags.all === "true";
  const updateExt = flags.extensions === "true" || updateAll;

  console.log("  检查 pi 更新…");
  const cur = spawnSync("pi", ["--version"], { encoding: "utf-8" });
  const latest = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], { encoding: "utf-8" });
  if (cur.status !== 0 || latest.status !== 0) {
    console.log(`  \x1b[31m❌ 无法检查更新\x1b[0m`);
    if (cur.status !== 0) console.log(`  pi --version 失败: ${cur.stderr?.trim() || cur.error}`);
    if (latest.status !== 0) console.log(`  npm view 失败: ${latest.stderr?.trim() || latest.error}`);
    return;
  }
  const curVer = cur.stdout?.trim() ?? "unknown";
  const latestVer = latest.stdout?.trim() ?? "unknown";
  console.log(`  当前: v${curVer}  最新: v${latestVer}`);
  if (curVer === latestVer) {
    console.log("  \x1b[32m✅ pi 已是最新版\x1b[0m");
  } else {
    console.log("  升级中…");
    const r = spawnSync("npm", ["install", "-g", `@earendil-works/pi-coding-agent@${latestVer}`], { stdio: "inherit" });
    if (r.status === 0) { console.log(`  \x1b[32m✅ pi 已升级到 v${latestVer}\x1b[0m`); }
    else { console.log("  \x1b[31m❌ pi 升级失败\x1b[0m"); process.exit(1); }
  }

  if (updateExt) {
    const config = loadConfig();
    const templateId = resolveOrFail(flags.template, config);
    if (templateId) {
      const dataDir = resolveDataDir(config);
      const agentDir = path.join(dataDir, "pi-config", templateId);
      const alias = getTemplateAlias(templateId, config);
      console.log(`  更新模板 "${alias}" 扩展包…`);
      const r = spawnSync("pi", ["update", "--extensions"], {
        stdio: "inherit",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      });
      if (r.status !== 0) console.log("  \x1b[33m⚠️  扩展包更新部分失败\x1b[0m");
    }
  }

  if (updateAll) {
    const config = loadConfig();
    const dataDir = resolveDataDir(config);
    const sharedDir = path.join(dataDir, "shared");
    const { syncBundledExtensions } = await import("../shared-layer.js");
    const synced = syncBundledExtensions(sharedDir);
    if (synced.length > 0) {
      console.log(`  \x1b[32m✅ 内置扩展已同步\x1b[0m: ${synced.join(", ")}`);
    }
  }

  if (!updateExt) {
    console.log("  \x1b[2m提示: pit update --extensions 更新扩展包 · pit update --all 全部更新\x1b[0m");
  }
}

export function handleInstallRemove(command: string, flags: Record<string, string>, subcommand: string | undefined, passthrough: string[]): void {
  const config2 = loadConfig();
  const dataDir = resolveDataDir(config2);
  const sharedDir = path.resolve(process.cwd(), config2.sharedDir);
  const isShared = flags.shared === "true";

  let agentDir: string;
  let tid: string | null = null;
  if (isShared) {
    initSharedLayer(sharedDir);
    agentDir = sharedDir;
  } else {
    tid = resolveOrFail(flags.template, config2);
    if (!tid) { process.exit(1); }
    agentDir = path.join(dataDir, "pi-config", tid);
  }

  const piArgs = [command, subcommand, ...passthrough].filter((a): a is string => Boolean(a));
  const templateAlias = isShared ? "shared" : getTemplateAlias(tid!, config2);
  console.log(`  ${isShared ? "共享层" : `模板 ${templateAlias}`}  ${agentDir}`);
  const r = spawnSync("pi", piArgs, {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  process.exit(r.status ?? 0);
}

export async function handleShared(subcommand: string | undefined): Promise<void> {
  const config2 = loadConfig();
  const dataDir2 = resolveDataDir(config2);
  const sharedDir2 = path.resolve(process.cwd(), config2.sharedDir);

  if (subcommand === "init") {
    const defaultId = getDefaultTemplateId(config2);
    const templateDir = path.join(dataDir2, "pi-config", defaultId);
    if (!fs.existsSync(templateDir)) {
      console.log(`  ❌ 默认模板目录不存在，先运行 pit onboard`);
      return;
    }
    const { moved, kept } = promoteToShared(templateDir, sharedDir2);
    console.log(`  ✅ 迁移到共享层: ${moved.length} 项`);
    for (const m of moved) console.log(`    📦 ${m}`);
    if (kept.length > 0) console.log(`  保留在模板: ${kept.length} 项`);
    linkTemplateToShared(templateDir, sharedDir2);
    console.log("  ✅ 已链接共享层到默认模板");
    const bundled = installBundledExtensions(sharedDir2);
    if (bundled.length > 0) console.log(`  ✅ 已安装内置扩展: ${bundled.join(", ")}`);
  } else {
    const ssr = await execSharedStatus();
    printBanner();
    console.log(ssr.message);
    console.log("");
  }
}
