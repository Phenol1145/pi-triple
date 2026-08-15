/**
 * shared-layer — bundled 扩展目录定位
 *
 * installBundledExtensions / syncBundledExtensions 需要从运行位置
 * 找到包内的 extensions/ 目录。布局有两种：
 *   - 发布（npm 包）：node_modules/<pkg>/dist/ptl/shared-layer.js → 包根/extensions
 *   - 开发（仓库源码）：<repo>/packages/framework/src/shared-layer.ts → 仓库根/extensions
 *
 * resolveBundledDir 逐级向上探测（最多 4 级），锁定两种布局都能命中。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveBundledDir,
  installBundledExtensions,
  syncBundledExtensions,
} from "../../packages/framework/src/shared-layer.js";

const tmpDirs: string[] = [];

function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-shared-layer-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("resolveBundledDir", () => {
  it("发布布局：dist/ptl/shared-layer.js → 包根/extensions", () => {
    const root = makeTmp();
    const pkgRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const extDir = path.join(pkgRoot, "extensions");
    fs.mkdirSync(path.join(pkgRoot, "dist", "ptl"), { recursive: true });
    fs.mkdirSync(path.join(extDir, "ptl-control"), { recursive: true });
    fs.writeFileSync(path.join(extDir, "ptl-control", "index.ts"), "x");

    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "ptl", "shared-layer.js")).href;
    expect(resolveBundledDir(moduleUrl)).toBe(extDir);
  });

  it("开发布局：packages/framework/src/shared-layer.ts → 仓库根/extensions", () => {
    const root = makeTmp();
    const extDir = path.join(root, "extensions");
    fs.mkdirSync(path.join(root, "src", "ptl"), { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });

    const moduleUrl = pathToFileURL(path.join(root, "src", "ptl", "shared-layer.ts")).href;
    expect(resolveBundledDir(moduleUrl)).toBe(extDir);
  });

  it("找不到任何 extensions/ 时返回 null", () => {
    const root = makeTmp();
    fs.mkdirSync(path.join(root, "src", "ptl"), { recursive: true });
    const moduleUrl = pathToFileURL(path.join(root, "src", "ptl", "shared-layer.ts")).href;
    expect(resolveBundledDir(moduleUrl)).toBeNull();
  });

  it("最近优先：dist/extensions 存在时命中它而非包根/extensions", () => {
    const root = makeTmp();
    const pkgRoot = path.join(root, "node_modules", "pkg");
    fs.mkdirSync(path.join(pkgRoot, "dist", "ptl"), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, "dist", "extensions"), { recursive: true });

    const moduleUrl = pathToFileURL(path.join(pkgRoot, "dist", "ptl", "shared-layer.js")).href;
    expect(resolveBundledDir(moduleUrl)).toBe(path.join(pkgRoot, "dist", "extensions"));
  });
});

/** 构造 tmp 仓库布局：<root>/extensions/{real-ext, link-ext→../packages/link-src} */
function makeBundledRepo(root: string): void {
  const bundledDir = path.join(root, "extensions");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "link-src"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "link-src", "index.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(bundledDir, "real-ext"), { recursive: true });
  fs.writeFileSync(path.join(bundledDir, "real-ext", "index.ts"), "export const r = 1;\n");
  fs.symlinkSync("../packages/link-src", path.join(bundledDir, "link-ext"), "dir");
}

/** 让 resolveBundledDir 命中 <root>/extensions 的 moduleUrl */
function moduleUrlFor(root: string): string {
  return pathToFileURL(path.join(root, "src", "ptl", "shared-layer.js")).href;
}

describe("installBundledExtensions / syncBundledExtensions — symlink 条目", () => {
  it("installBundledExtensions 把指向目录的 symlink 物化为共享层真实目录", () => {
    const root = makeTmp();
    makeBundledRepo(root);
    const sharedDir = path.join(root, "shared");

    const installed = installBundledExtensions(sharedDir, moduleUrlFor(root));

    expect(installed).toContain("real-ext");
    expect(installed).toContain("link-ext");
    const dst = path.join(sharedDir, "extensions", "link-ext");
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false); // 物化为真实目录，不残留仓库路径依赖
    expect(fs.statSync(dst).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dst, "index.ts"), "utf8")).toContain("export const x");
  });

  it("installBundledExtensions 跳过 dangling symlink 不报错", () => {
    const root = makeTmp();
    const bundledDir = path.join(root, "extensions");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(path.join(bundledDir, "real-ext"), { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "real-ext", "index.ts"), "x");
    fs.symlinkSync("../packages/missing", path.join(bundledDir, "dangling"), "dir");

    const installed = installBundledExtensions(path.join(root, "shared"), moduleUrlFor(root));

    expect(installed).toEqual(["real-ext"]);
  });

  it("syncBundledExtensions 同步 symlink 条目并写入 manifest", () => {
    const root = makeTmp();
    makeBundledRepo(root);
    const sharedDir = path.join(root, "shared");

    const synced = syncBundledExtensions(sharedDir, moduleUrlFor(root));

    expect(synced).toContain("link-ext");
    const dst = path.join(sharedDir, "extensions", "link-ext");
    expect(fs.statSync(dst).isDirectory()).toBe(true);
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(dst, "index.ts"))).toBe(true);
    const manifest = fs.readFileSync(path.join(sharedDir, "extensions", ".bundled-manifest"), "utf8");
    expect(manifest).toContain("link-ext");
  });

  it("syncBundledExtensions：manifest 含路径穿越条目（../ 或绝对路径）→ 拒绝删除共享层外目录", () => {
    const root = makeTmp();
    makeBundledRepo(root);
    const sharedDir = path.join(root, "shared");
    const extDir = path.join(sharedDir, "extensions");
    fs.mkdirSync(extDir, { recursive: true });

    // 构造外部受害目录 + 恶意 manifest（含 ../ 穿越与绝对路径条目）
    // 注意：path.join(extDir, "../victim") 解析为 sharedDir/victim——受害目录必须放这里才测得到
    const victimDir = path.join(sharedDir, "victim");
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, "keep.txt"), "keep");
    const absVictim = path.join(root, "victim2");
    fs.mkdirSync(absVictim, { recursive: true });
    fs.writeFileSync(path.join(absVictim, "keep.txt"), "keep");
    fs.writeFileSync(
      path.join(extDir, ".bundled-manifest"),
      `link-ext\n../victim\n${absVictim}\n`,
      "utf-8",
    );

    const synced = syncBundledExtensions(sharedDir, moduleUrlFor(root));

    // 合法条目照常同步；穿越条目不得删掉共享层外的目录
    expect(synced).toContain("link-ext");
    expect(fs.existsSync(path.join(victimDir, "keep.txt"))).toBe(true);
    expect(fs.existsSync(absVictim)).toBe(true);
  });
});

describe("仓库 bundled 扩展接线（finding #1）", () => {
  it("extensions/mailbox 与 extensions/dev-container 被 installBundledExtensions 同步", () => {
    const sharedDir = path.join(makeTmp(), "shared");
    const installed = installBundledExtensions(sharedDir);

    for (const name of ["mailbox", "dev-container"]) {
      const dst = path.join(sharedDir, "extensions", name);
      expect(fs.existsSync(dst), `${name} 未被同步为 bundled 扩展`).toBe(true);
      expect(fs.statSync(dst).isDirectory()).toBe(true);
    }
    expect(installed).toEqual(expect.arrayContaining(["mailbox", "dev-container"]));
  });
});
