import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { getPtlVersion, resolveRepoRootPackageJson, maybePrintUpdateHint } from "../../packages/framework/src/version.js";
import { writeCache } from "@away_from/shared";
import { resolveDataDir } from "@away_from/shared";

describe("getPtlVersion", () => {
  it("返回 package.json 的 version", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    expect(getPtlVersion()).toBe(pkg.version);
  });
});

describe("resolveRepoRootPackageJson", () => {
  let tmpRoot: string;
  let srcUrl: string;
  let distUrl: string;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-root-"));
    fs.writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "pi-triple", version: "9.9.9" }));
    // 源码布局：packages/framework/src/version.ts（模块深 3 级）
    const srcLayout = path.join(tmpRoot, "packages", "framework", "src");
    fs.mkdirSync(srcLayout, { recursive: true });
    // 构建产物布局：packages/framework/dist/packages/framework/src/version.js（模块深 5 级）
    const distLayout = path.join(tmpRoot, "packages", "framework", "dist", "packages", "framework", "src");
    fs.mkdirSync(distLayout, { recursive: true });
    // 干扰项：中间层 package.json（非 pi-triple，不应命中）
    fs.writeFileSync(
      path.join(tmpRoot, "packages", "framework", "package.json"),
      JSON.stringify({ name: "@away_from/framework", version: "0.1.0" }),
    );
    srcUrl = pathToFileURL(path.join(srcLayout, "version.ts")).href;
    distUrl = pathToFileURL(path.join(distLayout, "version.js")).href;
  });
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("源码布局与构建产物布局均解析到仓库根版本（跳过非 pi-triple 中间包）", () => {
    expect(resolveRepoRootPackageJson(srcUrl)?.version).toBe("9.9.9");
    expect(resolveRepoRootPackageJson(distUrl)?.version).toBe("9.9.9");
  });

  it("无可解析路径返回 null", () => {
    expect(resolveRepoRootPackageJson(pathToFileURL("/nonexistent/x.js").href)).toBeNull();
  });
});

describe("maybePrintUpdateHint", () => {
  let tmpRoot: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-hint-"));
    process.env.DATA_DIR = tmpRoot;
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
    stderrSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("缓存有本体更新 → 打印提示", () => {
    writeCache({ checkedAt: new Date().toISOString(), ptl: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("ptl 更新可用: v9.9.9"));
  });

  it("缓存有 pi SDK 更新 → 打印提示", () => {
    writeCache({ checkedAt: new Date().toISOString(), piSdk: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("pi SDK 更新可用: v9.9.9"));
  });

  it("无更新 / 无缓存 → 不打印", () => {
    writeCache({ checkedAt: new Date().toISOString(), ptl: "0.1.0", piSdk: "0.83.0" });
    stderrSpy.mockClear();
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
    fs.rmSync(path.join(resolveDataDir(), "version-check.json"), { force: true });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("过期缓存 → 不打印（CLI 不查询）", () => {
    writeCache({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), ptl: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
