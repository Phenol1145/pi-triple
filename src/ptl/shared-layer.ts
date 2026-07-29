/**
 * Pi-Triple 共享扩展层
 *
 * 消除多模板间 extensions/skills/packages 的重复存储。
 * 共享目录存放公共扩展，模板通过逐项 symlink 引用。
 */

import fs from "node:fs";
import path from "node:path";

/** 共享层覆盖的目录名 */
const SHARED_DIRS = ["extensions", "skills", "git", "npm"];

/** 初始化共享层目录 */
export function initSharedLayer(sharedDir: string): void {
  if (!fs.existsSync(sharedDir)) {
    fs.mkdirSync(sharedDir, { recursive: true });
  }
  for (const dir of SHARED_DIRS) {
    fs.mkdirSync(path.join(sharedDir, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(sharedDir, "agent-lab"), { recursive: true });
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

/** 移除租户的共享层链接（只删 symlink，不删租户自有文件） */
export function unlinkTemplateFromShared(templateDir: string): void {
  for (const dir of SHARED_DIRS) {
    const tenantSubDir = path.join(templateDir, dir);
    try {
      for (const entry of fs.readdirSync(tenantSubDir, { withFileTypes: true })) {
        const fullPath = path.join(tenantSubDir, entry.name);
        try {
          if (fs.lstatSync(fullPath).isSymbolicLink()) {
            fs.unlinkSync(fullPath);
          }
        } catch { /* ok */ }
      }
    } catch { /* 目录不存在 */ }
  }
}

/** 确保租户链接完整（launcher 启动前调用） */
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
 * 将现有租户中的扩展/技能/包提升到共享层。
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
 * 安装随包分发的内置扩展到共享层。
 * 源目录：包根目录/extensions/（npm install 后可通过 import.meta 或 __dirname 定位）
 * 目标：sharedDir/extensions/
 */
export function installBundledExtensions(sharedDir: string): string[] {
  const installed: string[] = [];

  // 定位包内 extensions/ 目录
  // 编译后在 dist/shared-layer.js，包根在上一级
  const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const bundledDir = path.join(packageRoot, "extensions");

  if (!fs.existsSync(bundledDir)) return installed;

  const targetExtDir = path.join(sharedDir, "extensions");
  fs.mkdirSync(targetExtDir, { recursive: true });

  for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(bundledDir, entry.name);
    const dst = path.join(targetExtDir, entry.name);

    // 已存在则跳过（不覆盖用户修改）
    if (fs.existsSync(dst)) continue;

    fs.cpSync(src, dst, { recursive: true });
    installed.push(entry.name);
  }

  return installed;
}

/**
 * 覆盖式同步 bundled 扩展（用于 pit update --all）。
 * 共享层的 bundled 扩展由平台托管，更新时直接覆盖；
 * 用户自定义扩展不应放在与 bundled 同名的目录。
 * 也负责剪枝：.bundled-manifest 记录平台托管名单，旧 bundled 中已移除的条目自动删除。
 */
export function syncBundledExtensions(sharedDir: string): string[] {
  const synced: string[] = [];

  const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const bundledDir = path.join(packageRoot, "extensions");
  if (!fs.existsSync(bundledDir)) return synced;

  const targetExtDir = path.join(sharedDir, "extensions");
  fs.mkdirSync(targetExtDir, { recursive: true });

  // 1. 当前 bundled 名单
  const bundledEntries = new Set(
    fs.readdirSync(bundledDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );

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
  for (const name of bundledEntries) {
    const src = path.join(bundledDir, name);
    const dst = path.join(targetExtDir, name);

    // 目标存在：非目录跳过（不能覆盖），symlink 先删
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink()) fs.unlinkSync(dst);
    } catch { /* 不存在 */ }
    fs.cpSync(src, dst, { recursive: true, force: true });
    synced.push(name);
  }

  // 4. 写新 manifest
  writeManifest(manifestPath, [...bundledEntries]);

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
