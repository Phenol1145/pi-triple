/**
 * ptl/admin — update / install / remove / shared / migrate / tenant rename
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { compareVersions, PIT_REPO } from "@away_from/shared";
import {
  loadConfig, resolveDataDir,
  getTemplateAlias, getDefaultTemplateId,
} from "@away_from/shared";
import { migrate } from "../migrate.js";
import { resolveRepoRootPackageJson } from "../version.js";
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

// ─── 阶段② Pi-Triple 本体更新（GitHub Release 拉包）────────

export function buildAssetUrl(tag: string, version: string): string {
  return `https://github.com/${PIT_REPO}/releases/download/${tag}/pi-triple-${version}.tgz`;
}

export function parseLatestRelease(json: unknown): { tag: string; version: string; assetName: string; digestAssetName?: string } | undefined {
  const data = json as { tag_name?: string; assets?: Array<{ name?: string }> };
  if (typeof data.tag_name !== "string") return undefined;
  const tag = data.tag_name;
  const version = tag.replace(/^v/, "");
  const assets = data.assets ?? [];
  const asset = assets.find((a) => a.name === `pi-triple-${version}.tgz`);
  if (!asset?.name) return undefined;
  const digestAsset = assets.find((a) => a.name === `pi-triple-${version}.sha256`);
  return {
    tag,
    version,
    assetName: asset.name,
    digestAssetName: digestAsset?.name,
  };
}

export function verifySha256(actualHex: string, expectedHex: string): boolean {
  return actualHex.toLowerCase() === expectedHex.toLowerCase();
}

// shasum 输出格式（`<hex>  <文件名>`）或裸 hex：取第一个空白分隔 token，须为 64 位 hex
export function parseSha256File(content: string): string | undefined {
  const first = content.trim().split(/\s+/)[0];
  if (!first || !/^[0-9a-fA-F]{64}$/.test(first)) return undefined;
  return first.toLowerCase();
}

async function updatePitSelf(): Promise<boolean> {
  try {
    console.log("  检查 Pi-Triple 本体更新…");
    const res = await fetch(`https://api.github.com/repos/${PIT_REPO}/releases/latest`, {
      headers: { "User-Agent": "pi-triple", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.log(`  \x1b[31m❌ 无法检查本体更新（GitHub API ${res.status}）\x1b[0m`);
      return false;
    }
    const release = parseLatestRelease(await res.json());
    if (!release) {
      console.log("  \x1b[31m❌ 无法解析 GitHub Release（未找到 pi-triple tarball asset）\x1b[0m");
      return false;
    }
    const localVersion = resolveRepoRootPackageJson(import.meta.url)?.version ?? "0.0.0";
    const cmp = compareVersions(release.version, localVersion);
    if (cmp === undefined) {
      console.log(`  \x1b[31m❌ 无法比较版本（远端 ${release.version} vs 本地 ${localVersion}），已中止（不安装）\x1b[0m`);
      return false;
    }
    if (cmp <= 0) {
      console.log(`  \x1b[32m✅ Pi-Triple 已是最新版 (v${localVersion})\x1b[0m`);
      return true;
    }
    console.log(`  当前 v${localVersion} → 最新 v${release.version}，下载中…`);

    const url = buildAssetUrl(release.tag, release.version);
    const dl = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!dl.ok) {
      console.log(`  \x1b[31m❌ 下载失败（HTTP ${dl.status}）: ${url}\x1b[0m`);
      return false;
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    const tmpFile = path.join(os.tmpdir(), `pi-triple-${release.version}.tgz`);
    try {
      fs.writeFileSync(tmpFile, buf);
      if (release.digestAssetName) {
        const digestUrl = `https://github.com/${PIT_REPO}/releases/download/${release.tag}/${release.digestAssetName}`;
        const digestRes = await fetch(digestUrl, { signal: AbortSignal.timeout(60_000) });
        if (!digestRes.ok) {
          console.log(`  \x1b[31m❌ sha256 校验文件下载失败（HTTP ${digestRes.status}），已中止（不安装）\x1b[0m`);
          return false;
        }
        const expected = parseSha256File(await digestRes.text());
        if (!expected) {
          console.log("  \x1b[31m❌ sha256 校验文件格式无效，已中止（不安装）\x1b[0m");
          return false;
        }
        const actual = crypto.createHash("sha256").update(buf).digest("hex");
        if (!verifySha256(actual, expected)) {
          console.log("  \x1b[31m❌ sha256 校验失败，已中止（不安装）\x1b[0m");
          return false;
        }
        console.log("  \x1b[32m✅ sha256 校验通过\x1b[0m");
      } else {
        console.log("  \x1b[33m⚠ 未找到 sha256 校验文件，跳过校验（信任 HTTPS）\x1b[0m");
      }
      console.log(`  \x1b[36m安装 pi-triple@${release.version}（npm install -g，约需 10-30s）…\x1b[0m`);
      const r = spawnSync("npm", ["install", "-g", tmpFile], { stdio: "inherit" });
      if (r.status === 0) {
        console.log(`  \x1b[32m✅ Pi-Triple 已升级到 v${release.version}，重启 ptl 会话生效\x1b[0m`);
        return true;
      }
      console.log("  \x1b[31m❌ npm install -g 失败（可尝试 sudo 或检查 npm 权限）\x1b[0m");
      return false;
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m❌ 本体更新失败: ${msg}\x1b[0m`);
    return false;
  }
}

export async function handleUpdate(flags: Record<string, string>): Promise<void> {
  const dryRun = flags["dry-run"] === "true";
  // 语义：默认/--all = 全量（含②）；--extensions = ①+③；--pi-only = 仅①
  const updateAll = flags.all === "true" || (flags.extensions !== "true" && flags["pi-only"] !== "true");
  const updateExt = flags.extensions === "true" || updateAll;
  const updateSelf = updateAll; // 仅默认/--all 时含阶段②（--extensions 不含）

  console.log("  检查 pi 更新…");
  const cur = spawnSync("pi", ["--version"], { encoding: "utf-8" });
  const latest = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], { encoding: "utf-8" });
  if (cur.status !== 0 || latest.status !== 0) {
    console.log(`  \x1b[31m❌ 无法检查更新\x1b[0m`);
    if (cur.status !== 0) console.log(`  pi --version 失败: ${cur.stderr?.trim() || cur.error?.message || String(cur.error ?? "未知错误")}`);
    if (latest.status !== 0) console.log(`  npm view 失败: ${latest.stderr?.trim() || latest.error?.message || String(latest.error ?? "未知错误")}`);
    return;
  }
  const curVer = cur.stdout?.trim() ?? "unknown";
  const latestVer = latest.stdout?.trim() ?? "unknown";
  console.log(`  当前: v${curVer}  最新: v${latestVer}`);
  if (curVer === latestVer) {
    console.log("  \x1b[32m✅ pi 已是最新版\x1b[0m");
  } else if (dryRun) {
    console.log(`  \x1b[33m⚠ pi 有更新（v${latestVer}）→ 运行 ptl update 升级\x1b[0m`);
  } else {
    console.log("  升级中…");
    const r = spawnSync("npm", ["install", "-g", `@earendil-works/pi-coding-agent@${latestVer}`], { stdio: "inherit" });
    if (r.status === 0) { console.log(`  \x1b[32m✅ pi 已升级到 v${latestVer}\x1b[0m`); }
    else { console.log("  \x1b[31m❌ pi 升级失败\x1b[0m"); process.exit(1); }
  }

  // 阶段② Pi-Triple 本体（GitHub Release）
  if (updateSelf && !dryRun) {
    await updatePitSelf();
  } else if (updateAll && dryRun) {
    console.log("  [dry-run] 将检查 Pi-Triple 本体（GitHub Release）");
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
    console.log("  \x1b[2m提示: ptl update --extensions 更新扩展包 · ptl update --all 全部更新\x1b[0m");
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
      console.log(`  ❌ 默认模板目录不存在，先运行 ptl onboard`);
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
