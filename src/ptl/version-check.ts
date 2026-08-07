/**
 * ptl/version-check — ptl 本体 + pi SDK 更新检查（CLI 侧）
 *
 * 缓存文件 dataDir/version-check.json 与 extensions/_shared/version-check.ts 共用格式：
 *   { checkedAt: string(ISO), ptl?: string, piSdk?: string }
 * 约定：CLI 启动提示只读缓存（零网络）；扩展侧兜底查询并写缓存。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDataDir } from "./config.js";

export const PIT_REPO = "Phenol1145/pi-triple";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GITHUB_API = `https://api.github.com/repos/${PIT_REPO}/releases/latest`;
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

export interface VersionCheckCache {
  checkedAt: string;
  ptl?: string;
  piSdk?: string;
}

export type Shell = (cmd: string, args: string[]) => { status: number | null; stdout: string };

export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string): number[] | undefined => {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
    if (!m) return undefined;
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(latest: string, current: string): boolean {
  const c = compareVersions(latest, current);
  return c === undefined ? latest.trim() !== current.trim() : c > 0;
}

export function cachePath(): string {
  return path.join(resolveDataDir(), "version-check.json");
}

export function readCache(): VersionCheckCache | null {
  try {
    const raw = fs.readFileSync(cachePath(), "utf-8");
    const data = JSON.parse(raw) as VersionCheckCache;
    if (typeof data.checkedAt !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

export function writeCache(data: VersionCheckCache): void {
  const p = cachePath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}

export function isCacheFresh(cache: VersionCheckCache): boolean {
  return Date.now() - Date.parse(cache.checkedAt) < CACHE_TTL_MS;
}

export async function fetchLatestPitVersion(fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const res = await fetchImpl(GITHUB_API, {
    headers: { "User-Agent": "pi-triple", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { tag_name?: string };
  return typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : undefined;
}

export async function fetchLatestPiSdkVersion(shell: Shell = (cmd, args) => spawnSync(cmd, args, { encoding: "utf-8" })): Promise<string | undefined> {
  const r = shell("npm", ["view", PI_SDK_PACKAGE, "version"]);
  if (r.status !== 0) return undefined;
  const v = r.stdout.trim();
  return v || undefined;
}

export async function checkForUpdates(deps: { fetchImpl?: typeof fetch; shell?: Shell } = {}): Promise<{ ptl?: string; piSdk?: string }> {
  if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return {};
  const cache = readCache();
  if (cache && isCacheFresh(cache)) {
    return { ptl: cache.ptl, piSdk: cache.piSdk };
  }
  const [ptl, piSdk] = await Promise.all([
    fetchLatestPitVersion(deps.fetchImpl).catch(() => undefined),
    fetchLatestPiSdkVersion(deps.shell).catch(() => undefined),
  ]);
  const report: { ptl?: string; piSdk?: string } = {};
  if (ptl) report.ptl = ptl;
  if (piSdk) report.piSdk = piSdk;
  try {
    writeCache({ checkedAt: new Date().toISOString(), ...report });
  } catch {
    /* 缓存写失败静默 */
  }
  return report;
}
