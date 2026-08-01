/**
 * _shared/version-check — pit 本体 + pi SDK 更新检查（扩展侧，会话内提示用）
 *
 * 与 src/ptl/version-check.ts 独立实现（扩展不能 import src/），但共享：
 * - 缓存文件格式 dataDir/version-check.json：{ checkedAt, pit?, piSdk? }
 * - 常量 PIT_REPO、env 语义（PI_OFFLINE / PI_SKIP_VERSION_CHECK）
 * 扩展侧额外返回当前版本（currentPit/currentPiSdk）供 notify 文案使用。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export const PIT_REPO = "Phenol1145/pi-triple";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GITHUB_API = `https://api.github.com/repos/${PIT_REPO}/releases/latest`;
const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

export type Shell = (cmd: string, args: string[]) => { status: number | null; stdout: string };

export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string): number[] | undefined => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m) return undefined;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
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

function cachePath(): string {
  // 扩展运行于 pi 进程内，pi 的 DATA_DIR 语义与 pit 一致（~/.pi-triple/data）
  const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), ".pi-triple", "data");
  return path.join(dataDir, "version-check.json");
}

export function resolveInstalledPitVersion(shell: Shell = (cmd, args) => spawnSync(cmd, args, { encoding: "utf-8" })): string | undefined {
  try {
    const root = shell("npm", ["root", "-g"]);
    if (root.status !== 0) return undefined;
    const pkgPath = path.join(root.stdout.trim(), "pi-triple", "package.json");
    if (!fs.existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(deps: { fetchImpl?: typeof fetch; shell?: Shell } = {}): Promise<{
  pit?: string; piSdk?: string; currentPit?: string; currentPiSdk?: string;
}> {
  if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return {};
  const shell = deps.shell ?? ((cmd, args) => spawnSync(cmd, args, { encoding: "utf-8" }));
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 缓存新鲜 → 只返回最新版本（当前版本仍实时取）
  try {
    const raw = fs.readFileSync(cachePath(), "utf-8");
    const cache = JSON.parse(raw) as { checkedAt: string; pit?: string; piSdk?: string };
    if (cache && typeof cache.checkedAt === "string" && Date.now() - Date.parse(cache.checkedAt) < CACHE_TTL_MS) {
      return {
        pit: cache.pit,
        piSdk: cache.piSdk,
        currentPit: resolveInstalledPitVersion(shell),
        currentPiSdk: sdkVersion(shell),
      };
    }
  } catch { /* 无/损坏缓存 → 查询 */ }

  const [pit, piSdk] = await Promise.all([
    fetchImpl(GITHUB_API, {
      headers: { "User-Agent": "pi-triple", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    }).then(async (res) => {
      if (!res.ok) return undefined;
      const data = (await res.json()) as { tag_name?: string };
      return typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : undefined;
    }).catch(() => undefined),
    Promise.resolve().then(() => {
      const r = shell("npm", ["view", PI_SDK_PACKAGE, "version"]);
      if (r.status !== 0) return undefined;
      const v = r.stdout.trim();
      return v || undefined;
    }).catch(() => undefined),
  ]);

  const report: { pit?: string; piSdk?: string } = {};
  if (pit) report.pit = pit;
  if (piSdk) report.piSdk = piSdk;
  try {
    const p = cachePath();
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ checkedAt: new Date().toISOString(), ...report }));
    fs.renameSync(tmp, p);
  } catch { /* 缓存写失败静默 */ }

  return { ...report, currentPit: resolveInstalledPitVersion(shell), currentPiSdk: sdkVersion(shell) };
}

function sdkVersion(shell: Shell): string | undefined {
  try {
    const r = shell("pi", ["--version"]);
    if (r.status !== 0) return undefined;
    const v = r.stdout.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}
