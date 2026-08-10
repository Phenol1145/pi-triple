/**
 * Pi-Triple 共享扩展层
 *
 * 消除多模板间 extensions/skills/packages 的重复存储。
 * 共享目录存放公共扩展，模板通过逐项 symlink 引用。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 共享层覆盖的目录名 */
const SHARED_DIRS = ["extensions", "skills", "git", "npm"];

/**
 * 定位包内 bundled extensions/ 目录（从模块文件位置逐级向上探测，最近优先，最多 4 级）。
 * 布局有两种：
 *   - 发布（npm 包）：<pkg>/dist/ptl/shared-layer.js → 包根/extensions（上 2 级）
 *   - 开发（仓库源码）：<repo>/packages/framework/src/shared-layer.ts → 仓库根/extensions（上 3 级）
 * 找不到返回 null。
 */
export function resolveBundledDir(moduleUrl: string): string | null {
  let cursor = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(cursor, "extensions");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // 已到文件系统根
    cursor = parent;
  }
  return null;
}

/** 初始化共享层目录 */
export function initSharedLayer(sharedDir: string): void {
  if (!fs.existsSync(sharedDir)) {
    fs.mkdirSync(sharedDir, { recursive: true });
  }
  for (const dir of SHARED_DIRS) {
    fs.mkdirSync(path.join(sharedDir, dir), { recursive: true });
  }
}

/** 将共享层通过 symlink 挂载到模板目录 */
export function linkTemplateToShared(templateDir: string, sharedDir: string): void {
  for (const dir of SHARED_DIRS) {
    const tenantSubDir = path.join(templateDir, dir);
    const sharedSubDir = path.join(sharedDir, dir);

    fs.mkdirSync(tenantSubDir, { recursive: true });
    if (!fs.existsSync(sharedSubDir)) continue;

    // 移除旧的 _shared 目录级 symlink（迁移）
    const oldLink = path.join(tenantSubDir, "_shared");
    try {
      if (fs.lstatSync(oldLink).isSymbolicLink()) {
        fs.unlinkSync(oldLink);
      }
    } catch { /* 不存在 */ }

    // 逐个共享项创建相对 symlink（跳过已存在的）
    for (const entry of fs.readdirSync(sharedSubDir, { withFileTypes: true })) {
      const linkPath = path.join(tenantSubDir, entry.name);
      try { fs.lstatSync(linkPath); continue; } catch { /* ok，不存在 */ }

      const target = path.join(sharedSubDir, entry.name);
      const relTarget = path.relative(tenantSubDir, target);
      fs.symlinkSync(relTarget, linkPath, entry.isDirectory() ? "dir" : "file");
    }
  }
}

/** 移除模板的共享层链接（只删 symlink，不删模板自有文件） */

/** 确保模板链接完整（launcher 启动前调用） */
export function ensureTemplateLinks(templateDir: string, sharedDir: string): void {
  if (!fs.existsSync(sharedDir)) return;
  linkTemplateToShared(templateDir, sharedDir);
}

/** 共享层状态 */
export function sharedStatus(sharedDir: string): {
  exists: boolean;
  extensions: number;
  skills: number;
  packages: number;
} {
  if (!fs.existsSync(sharedDir)) {
    return { exists: false, extensions: 0, skills: 0, packages: 0 };
  }
  const count = (sub: string): number => {
    const p = path.join(sharedDir, sub);
    if (!fs.existsSync(p)) return 0;
    return fs.readdirSync(p).filter((n) => !n.startsWith(".")).length;
  };
  return {
    exists: true,
    extensions: count("extensions"),
    skills: count("skills"),
    packages: count("git") + count("npm"),
  };
}

/**
 * 将现有模板中的扩展/技能/包提升到共享层。
 * 使用 cpSync + rmSync 而非 rename，因为可能跨文件系统。
 */
export function promoteToShared(templateDir: string, sharedDir: string): {
  moved: string[];
  kept: string[];
} {
  const moved: string[] = [];
  const kept: string[] = [];

  initSharedLayer(sharedDir);

  for (const dir of SHARED_DIRS) {
    const srcDir = path.join(templateDir, dir);
    const dstDir = path.join(sharedDir, dir);

    if (!fs.existsSync(srcDir)) continue;

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name.startsWith("_")) continue; // 跳过内部文件

      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);

      if (fs.existsSync(dstPath)) {
        kept.push(`${dir}/${entry.name} (共享层已有，跳过)`);
        // 本地副本可以删除（共享层已有）
        fs.rmSync(srcPath, { recursive: true, force: true });
        continue;
      }

      try {
        // 处理 symlink：解析为绝对路径后在共享层重建
        const lstat = fs.lstatSync(srcPath);
        if (lstat.isSymbolicLink()) {
          const target = fs.readlinkSync(srcPath);
          const absTarget = path.resolve(path.dirname(srcPath), target);
          fs.symlinkSync(absTarget, dstPath);
          fs.unlinkSync(srcPath);
          moved.push(`${dir}/${entry.name} (symlink)`);
          continue;
        }
        fs.cpSync(srcPath, dstPath, { recursive: true });
        fs.rmSync(srcPath, { recursive: true, force: true });
        moved.push(`${dir}/${entry.name}`);
      } catch (e: any) {
        kept.push(`${dir}/${entry.name} (复制失败: ${e.message})`);
      }
    }
  }

  return { moved, kept };
}

/**
 * 判断 bundled 条目是否算扩展目录。
 * 真实目录直接算；symlink 指向目录也算（packages/ 下的扩展以相对 symlink 挂到 extensions/）；
 * dangling symlink 或指向非目录的条目不算。
 */
function isDirEntry(bundledDir: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(bundledDir, entry.name)).isDirectory();
  } catch {
    return false; // dangling symlink
  }
}

/**
 * 安装随包分发的内置扩展到共享层。
 * 源目录：包根目录/extensions/（npm install 后可通过 import.meta 或 __dirname 定位）
 * 目标：sharedDir/extensions/
 * moduleUrl 可选（默认当前模块），测试可注入以指向临时 bundled 目录。
 */
export function installBundledExtensions(sharedDir: string, moduleUrl: string = import.meta.url): string[] {
  const installed: string[] = [];

  // 定位包内 extensions/ 目录（发布：包根；开发：仓库根）
  const bundledDir = resolveBundledDir(moduleUrl);

  if (!bundledDir) return installed;

  const targetExtDir = path.join(sharedDir, "extensions");
  fs.mkdirSync(targetExtDir, { recursive: true });

  for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!isDirEntry(bundledDir, entry)) continue;
    const src = path.join(bundledDir, entry.name);
    const dst = path.join(targetExtDir, entry.name);

    // 已存在则跳过（不覆盖用户修改）
    if (fs.existsSync(dst)) continue;

    // symlink 条目解引用复制：共享层落真实目录，不残留对仓库路径的依赖
    fs.cpSync(src, dst, { recursive: true, dereference: entry.isSymbolicLink() });
    installed.push(entry.name);
  }

  return installed;
}

/**
 * 覆盖式同步 bundled 扩展（用于 ptl update --all）。
 * 共享层的 bundled 扩展由平台托管，更新时直接覆盖；
 * 用户自定义扩展不应放在与 bundled 同名的目录。
 * 也负责剪枝：.bundled-manifest 记录平台托管名单，旧 bundled 中已移除的条目自动删除。
 */
export function syncBundledExtensions(sharedDir: string, moduleUrl: string = import.meta.url): string[] {
  const synced: string[] = [];

  // 定位包内 extensions/ 目录（发布：包根；开发：仓库根）
  const bundledDir = resolveBundledDir(moduleUrl);
  if (!bundledDir) return synced;

  const targetExtDir = path.join(sharedDir, "extensions");
  fs.mkdirSync(targetExtDir, { recursive: true });

  // 1. 当前 bundled 名单（name → 是否 symlink 条目）
  const bundledEntries = new Map<string, boolean>();
  for (const e of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (isDirEntry(bundledDir, e)) bundledEntries.set(e.name, e.isSymbolicLink());
  }

  // 2. 读旧 manifest，剪枝：删除"曾在旧 manifest 但不在新 bundled"的共享层条目
  const manifestPath = path.join(targetExtDir, ".bundled-manifest");
  const oldManifest = readManifest(manifestPath);
  for (const name of oldManifest) {
    if (!bundledEntries.has(name)) {
      const p = path.join(targetExtDir, name);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }

  // 3. 覆盖式同步 bundled → 共享层
  for (const [name, isSymlink] of bundledEntries) {
    const src = path.join(bundledDir, name);
    const dst = path.join(targetExtDir, name);

    // 目标存在：非目录跳过（不能覆盖），symlink 先删
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink()) fs.unlinkSync(dst);
    } catch { /* 不存在 */ }
    // symlink 条目解引用复制：共享层落真实目录，不残留对仓库路径的依赖
    fs.cpSync(src, dst, { recursive: true, force: true, dereference: isSymlink });
    synced.push(name);
  }

  // 4. 写新 manifest
  writeManifest(manifestPath, [...bundledEntries.keys()]);

  return synced;
}

/** 读 .bundled-manifest（纯文本，每行一个目录名） */
function readManifest(path: string): Set<string> {
  try {
    const content = fs.readFileSync(path, "utf-8");
    return new Set(content.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !l.startsWith("#")));
  } catch {
    return new Set();
  }
}

/** 写 .bundled-manifest */
function writeManifest(path: string, entries: string[]): void {
  try {
    fs.writeFileSync(path, entries.join("\n") + "\n", "utf-8");
  } catch { /* best-effort */ }
}
