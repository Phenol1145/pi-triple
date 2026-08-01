/**
 * pit/version — 版本单源（package.json）+ 启动更新提示（CLI 辅通道，只读缓存零网络）
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { readCache, isCacheFresh, isUpdateAvailable } from "./version-check.js";

let cachedVersion: string | null = null;

export function getPitVersion(): string {
  if (cachedVersion) return cachedVersion;
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version?: string };
  cachedVersion = pkg.version ?? "0.0.0";
  return cachedVersion;
}

export function currentPiSdkVersion(): string {
  try {
    const r = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    return (r.stdout?.trim() ?? "") || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function maybePrintUpdateHint(currentPit?: string, currentPiSdk?: string): void {
  try {
    if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return;
    const cache = readCache();
    if (!cache || !isCacheFresh(cache)) return; // CLI 只读缓存，不查询（扩展兜底）
    const hints: string[] = [];
    const pitVer = currentPit ?? getPitVersion();
    if (cache.pit && isUpdateAvailable(cache.pit, pitVer)) {
      hints.push(`pit 更新可用: v${cache.pit}（当前 v${pitVer}）`);
    }
    if (cache.piSdk) {
      const piSdkVer = currentPiSdk ?? currentPiSdkVersion();
      if (isUpdateAvailable(cache.piSdk, piSdkVer)) {
        hints.push(`pi SDK 更新可用: v${cache.piSdk}（当前 v${piSdkVer}）`);
      }
    }
    if (hints.length > 0) {
      console.error(`\x1b[33m⚠ ${hints.join(" · ")} → 运行 pit update 一次更新全部\x1b[0m`);
    }
  } catch {
    /* 提示失败静默 */
  }
}
