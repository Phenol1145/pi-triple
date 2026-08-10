/**
 * ptl/version — 版本单源（package.json）+ 启动更新提示（CLI 辅通道，只读缓存零网络）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readCache, isCacheFresh, isUpdateAvailable } from "@away_from/shared";

let cachedVersion: string | null = null;

/**
 * 定位仓库根 package.json（monorepo 单源版本）。
 * 源码布局（packages/framework/src/version.ts，上溯 3 级）与构建产物布局
 * （packages/framework/dist/packages/framework/src/version.js，上溯 5 级）层级不同，
 * 故从模块位置向上探测最近一个 name === "@away_from/pi-triple"（旧名 pi-triple 兼容）的
 * package.json，两种布局均命中仓库根。
 */
export function resolveRepoRootPackageJson(moduleUrl: string): { name?: string; version?: string } | null {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "@away_from/pi-triple" || pkg.name === "pi-triple") return pkg;
    } catch {
      // 该级无 package.json 或不可读——继续上溯
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到文件系统根
    dir = parent;
  }
  return null;
}

export function getPtlVersion(): string {
  if (cachedVersion) return cachedVersion;
  cachedVersion = resolveRepoRootPackageJson(import.meta.url)?.version ?? "0.0.0";
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

export function maybePrintUpdateHint(currentPtl?: string, currentPiSdk?: string): void {
  try {
    if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return;
    const cache = readCache();
    if (!cache || !isCacheFresh(cache)) return; // CLI 只读缓存，不查询（扩展兜底）
    const hints: string[] = [];
    const ptlVer = currentPtl ?? getPtlVersion();
    if (cache.ptl && isUpdateAvailable(cache.ptl, ptlVer)) {
      hints.push(`ptl 更新可用: v${cache.ptl}（当前 v${ptlVer}）`);
    }
    if (cache.piSdk) {
      const piSdkVer = currentPiSdk ?? currentPiSdkVersion();
      if (isUpdateAvailable(cache.piSdk, piSdkVer)) {
        hints.push(`pi SDK 更新可用: v${cache.piSdk}（当前 v${piSdkVer}）`);
      }
    }
    if (hints.length > 0) {
      console.error(`\x1b[33m⚠ ${hints.join(" · ")} → 运行 ptl update 一次更新全部\x1b[0m`);
    }
  } catch {
    /* 提示失败静默 */
  }
}
