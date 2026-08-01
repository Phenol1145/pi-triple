import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getPitVersion, maybePrintUpdateHint } from "../../src/ptl/version.js";
import { writeCache } from "../../src/ptl/version-check.js";
import { resolveDataDir } from "../../src/ptl/config.js";

describe("getPitVersion", () => {
  it("返回 package.json 的 version", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    expect(getPitVersion()).toBe(pkg.version);
  });
});

describe("maybePrintUpdateHint", () => {
  let tmpRoot: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pit-hint-"));
    process.env.DATA_DIR = tmpRoot;
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
    stderrSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("缓存有本体更新 → 打印提示", () => {
    writeCache({ checkedAt: new Date().toISOString(), pit: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("pit 更新可用: v9.9.9"));
  });

  it("缓存有 pi SDK 更新 → 打印提示", () => {
    writeCache({ checkedAt: new Date().toISOString(), piSdk: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("pi SDK 更新可用: v9.9.9"));
  });

  it("无更新 / 无缓存 → 不打印", () => {
    writeCache({ checkedAt: new Date().toISOString(), pit: "0.1.0", piSdk: "0.83.0" });
    stderrSpy.mockClear();
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
    fs.rmSync(path.join(resolveDataDir(), "version-check.json"), { force: true });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("过期缓存 → 不打印（CLI 不查询）", () => {
    writeCache({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), pit: "9.9.9" });
    maybePrintUpdateHint("0.1.0", "0.83.0");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
