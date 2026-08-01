import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  compareVersions, isUpdateAvailable, cachePath, readCache, writeCache,
  isCacheFresh, fetchLatestPitVersion, fetchLatestPiSdkVersion, checkForUpdates,
} from "../../src/ptl/version-check.js";
import { loadConfig, resolveDataDir } from "../../src/ptl/config.js";

// 用 DATA_DIR 环境变量隔离缓存路径（resolveDataDir 支持 process.env.DATA_DIR）
let tmpRoot: string;
let savedDataDir: string | undefined;
let savedOffline: string | undefined;
let savedSkip: string | undefined;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pit-vc-"));
  savedDataDir = process.env.DATA_DIR;
  savedOffline = process.env.PI_OFFLINE;
  savedSkip = process.env.PI_SKIP_VERSION_CHECK;
  process.env.DATA_DIR = tmpRoot;
  delete process.env.PI_OFFLINE;
  delete process.env.PI_SKIP_VERSION_CHECK;
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedDataDir;
  if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
  if (savedSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK; else process.env.PI_SKIP_VERSION_CHECK = savedSkip;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("compareVersions", () => {
  it("比较 x.y.z 三段", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
  });
  it("接受 v 前缀与缺段", () => {
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
  });
  it("无效版本返回 undefined", () => {
    expect(compareVersions("abc", "0.1.0")).toBeUndefined();
    expect(compareVersions("0.1.0", "")).toBeUndefined();
  });
});

describe("isUpdateAvailable", () => {
  it("最新大于当前 → true", () => {
    expect(isUpdateAvailable("0.2.0", "0.1.0")).toBe(true);
  });
  it("相同或更小 → false", () => {
    expect(isUpdateAvailable("0.1.0", "0.1.0")).toBe(false);
    expect(isUpdateAvailable("0.1.0", "0.2.0")).toBe(false);
  });
  it("比较失败 fallback 字符串不等", () => {
    expect(isUpdateAvailable("dev", "0.1.0")).toBe(true);
    expect(isUpdateAvailable("dev", "dev")).toBe(false);
  });
});

describe("缓存", () => {
  it("writeCache → readCache 往返一致", () => {
    const data = { checkedAt: new Date().toISOString(), pit: "0.2.0", piSdk: "0.84.0" };
    writeCache(data);
    expect(readCache()).toEqual(data);
  });
  it("损坏缓存 readCache 返回 null", () => {
    fs.writeFileSync(cachePath(), "{ not json");
    expect(readCache()).toBeNull();
  });
  it("isCacheFresh：24h 内新鲜，超过过期", () => {
    expect(isCacheFresh({ checkedAt: new Date().toISOString() })).toBe(true);
    expect(isCacheFresh({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })).toBe(false);
  });
});

describe("fetchLatestPitVersion", () => {
  it("解析 GitHub releases/latest 的 tag_name（去 v 前缀）", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: "v0.2.0" }),
    })) as unknown as typeof fetch;
    expect(await fetchLatestPitVersion(fakeFetch)).toBe("0.2.0");
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/Phenol1145/pi-triple/releases/latest",
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": "pi-triple" }) }),
    );
  });
  it("非 200 返回 undefined", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await fetchLatestPitVersion(fakeFetch)).toBeUndefined();
  });
});

describe("fetchLatestPiSdkVersion", () => {
  it("npm view 成功返回版本", async () => {
    const shell = vi.fn(() => ({ status: 0, stdout: "0.84.0\n" }));
    expect(await fetchLatestPiSdkVersion(shell as never)).toBe("0.84.0");
    expect(shell).toHaveBeenCalledWith("npm", ["view", "@earendil-works/pi-coding-agent", "version"]);
  });
  it("失败返回 undefined", async () => {
    expect(await fetchLatestPiSdkVersion((() => ({ status: 1, stdout: "" })) as never)).toBeUndefined();
  });
});

describe("checkForUpdates", () => {
  it("env PI_OFFLINE 跳过（不查不写）", async () => {
    process.env.PI_OFFLINE = "1";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await checkForUpdates({ fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    delete process.env.PI_OFFLINE;
  });
  it("PI_SKIP_VERSION_CHECK 跳过", async () => {
    process.env.PI_SKIP_VERSION_CHECK = "1";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await checkForUpdates({ fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    delete process.env.PI_SKIP_VERSION_CHECK;
  });
  it("缓存新鲜时直接返回缓存不查询", async () => {
    writeCache({ checkedAt: new Date().toISOString(), pit: "0.2.0" });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await checkForUpdates({ fetchImpl });
    expect(r).toEqual({ pit: "0.2.0" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("无缓存/过期时并行查询并写缓存", async () => {
    fs.rmSync(cachePath(), { force: true });
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ tag_name: "v0.3.0" }) })) as unknown as typeof fetch;
    const shell = (() => ({ status: 0, stdout: "0.85.0" })) as never;
    const r = await checkForUpdates({ fetchImpl, shell });
    expect(r).toEqual({ pit: "0.3.0", piSdk: "0.85.0" });
    expect(readCache()).toMatchObject({ pit: "0.3.0", piSdk: "0.85.0" });
  });
});
