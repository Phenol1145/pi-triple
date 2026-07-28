/**
 * Pi-Triple 共享扩展层
 *
 * 消除多租户间 extensions/skills/packages 的重复存储。
 * 共享目录存放公共扩展，租户通过逐项 symlink 引用。
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

/** 将共享层通过 symlink 挂载到租户目录 */
export function linkTenantToShared(tenantDir: string, sharedDir: string): void {
  for (const dir of SHARED_DIRS) {
    const tenantSubDir = path.join(tenantDir, dir);
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

    // 逐个共享项创建 symlink
    for (const entry of fs.readdirSync(sharedSubDir, { withFileTypes: true })) {
      const linkPath = path.join(tenantSubDir, entry.name);

      // 已存在（租户自有或已链接）则跳过
      try { fs.lstatSync(linkPath); continue; } catch { /* 不存在，继续 */ }
    }

    // 重新遍历创建（上面只是检查）
    for (const entry of fs.readdirSync(sharedSubDir, { withFileTypes: true })) {
      const linkPath = path.join(tenantSubDir, entry.name);
      try { fs.lstatSync(linkPath); continue; } catch { /* ok */ }

      const target = path.join(sharedSubDir, entry.name);
      const relTarget = path.relative(tenantSubDir, target);
      fs.symlinkSync(relTarget, linkPath, entry.isDirectory() ? "dir" : "file");
    }
  }
}

/** 移除租户的共享层链接（只删 symlink，不删租户自有文件） */
export function unlinkTenantFromShared(tenantDir: string): void {
  for (const dir of SHARED_DIRS) {
    const tenantSubDir = path.join(tenantDir, dir);
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
export function ensureTenantLinks(tenantDir: string, sharedDir: string): void {
  if (!fs.existsSync(sharedDir)) return;
  linkTenantToShared(tenantDir, sharedDir);
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
export function promoteToShared(tenantDir: string, sharedDir: string): {
  moved: string[];
  kept: string[];
} {
  const moved: string[] = [];
  const kept: string[] = [];

  initSharedLayer(sharedDir);

  for (const dir of SHARED_DIRS) {
    const srcDir = path.join(tenantDir, dir);
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
 */
export function syncBundledExtensions(sharedDir: string): string[] {
  const synced: string[] = [];

  const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const bundledDir = path.join(packageRoot, "extensions");
  if (!fs.existsSync(bundledDir)) return synced;

  const targetExtDir = path.join(sharedDir, "extensions");
  fs.mkdirSync(targetExtDir, { recursive: true });

  for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(bundledDir, entry.name);
    const dst = path.join(targetExtDir, entry.name);

    // 目标是 symlink（不應發生）或目录时先删除再复制，保证完全同步
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink()) fs.unlinkSync(dst);
    } catch { /* 不存在 */ }
    fs.cpSync(src, dst, { recursive: true, force: true });
    synced.push(entry.name);
  }

  return synced;
}
