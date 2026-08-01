import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  compareVersions, isUpdateAvailable, resolveInstalledPitVersion, checkForUpdates,
} from "../../extensions/_shared/version-check.js";

describe("compareVersions / isUpdateAvailable", () => {
  it("三段比较与 v 前缀", () => {
    expect(compareVersions("v0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("x", "0.1.0")).toBeUndefined();
  });
  it("isUpdateAvailable", () => {
    expect(isUpdateAvailable("0.2.0", "0.1.0")).toBe(true);
    expect(isUpdateAvailable("0.1.0", "0.2.0")).toBe(false);
  });
});

describe("resolveInstalledPitVersion", () => {
  it("npm root -g + package.json 读取", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pit-ver-"));
    fs.mkdirSync(path.join(tmp, "pi-triple"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "pi-triple", "package.json"), JSON.stringify({ version: "0.7.7" }));
    const shell = vi.fn(() => ({ status: 0, stdout: tmp + "\n" }));
    expect(resolveInstalledPitVersion(shell as never)).toBe("0.7.7");
    expect(shell).toHaveBeenCalledWith("npm", ["root", "-g"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it("npm root 失败 → undefined", () => {
    expect(resolveInstalledPitVersion((() => ({ status: 1, stdout: "" })) as never)).toBeUndefined();
  });
  it("未安装 pi-triple → undefined", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pit-ver2-"));
    const shell = vi.fn(() => ({ status: 0, stdout: tmp + "\n" }));
    expect(resolveInstalledPitVersion(shell as never)).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("checkForUpdates", () => {
  let tmpRoot: string;
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pit-vce-"));
    process.env.DATA_DIR = tmpRoot;
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("聚合 GitHub + npm view + 当前版本", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pit-vce2-"));
    fs.mkdirSync(path.join(tmp, "pi-triple"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "pi-triple", "package.json"), JSON.stringify({ version: "0.1.0" }));
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ tag_name: "v0.2.0" }) })) as unknown as typeof fetch;
    const shell = ((cmd: string, args: string[]) =>
      cmd === "npm" && args[0] === "root" ? { status: 0, stdout: tmp + "\n" }
      : cmd === "npm" ? { status: 0, stdout: "0.84.0\n" }
      : { status: 0, stdout: "0.83.0\n" }) as never;
    const r = await checkForUpdates({ fetchImpl, shell });
    expect(r.pit).toBe("0.2.0");
    expect(r.piSdk).toBe("0.84.0");
    expect(r.currentPit).toBe("0.1.0");
    expect(r.currentPiSdk).toBe("0.83.0");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("PI_OFFLINE 跳过", async () => {
    process.env.PI_OFFLINE = "1";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await checkForUpdates({ fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    delete process.env.PI_OFFLINE;
  });

  it("异常静默（fetch 抛错 → 空结果）", async () => {
    // 密闭化：清缓存避免命中聚合测试写入的新鲜缓存；shell mock 失败避免真实 npm view/pi 命令（与 Task 1 测试模式一致）
    fs.rmSync(path.join(tmpRoot, "version-check.json"), { force: true });
    const fetchImpl = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    const shell = (() => ({ status: 1, stdout: "" })) as never;
    const r = await checkForUpdates({ fetchImpl, shell });
    expect(r.pit).toBeUndefined();
    expect(r.piSdk).toBeUndefined();
  });
});
