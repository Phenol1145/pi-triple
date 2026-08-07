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
import { resolveBundledDir } from "../../packages/framework/src/shared-layer.js";

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
