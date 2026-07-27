/**
 * Pi-Triple Migrate — 将现有 pi 配置/扩展/技能迁移到 Pi-Triple
 *
 * 用法：
 *   npm run migrate                  # 迁移到默认租户 "local"
 *   npm run migrate -- --tenant dev  # 迁移到指定租户
 *   npm run migrate -- --source /custom/pi/agent  # 自定义源目录
 *   npm run migrate -- --dry-run     # 只预览，不复制
 */

import fs from "node:fs";
import path from "node:path";

interface MigrateOptions {
  source: string;
  target: string;
  dryRun: boolean;
}

interface MigrateReport {
  copied: string[];
  skipped: string[];
  errors: string[];
}

// 要迁移的目录
const DIRS_TO_MIGRATE = [
  "extensions",
  "skills",
  "git",
  "npm",
  "docs",
  "bin",
];

// 要迁移的文件
const FILES_TO_MIGRATE = [
  "settings.json",
  "auth.json",
  "models.json",
  "presets.json",
];

function copyDirRecursive(src: string, dst: string, report: MigrateReport, dryRun: boolean): void {
  if (!fs.existsSync(src)) {
    report.skipped.push(`${src} (不存在)`);
    return;
  }

  if (!dryRun) {
    fs.mkdirSync(dst, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    // 跳过 .git、.cache、临时文件
    if (entry.name === ".git" || entry.name === ".cache" || entry.name === ".pi-subagents") {
      report.skipped.push(srcPath);
      continue;
    }

    // 检测 symlink（包括指向目录的 symlink）
    const lstat = fs.lstatSync(srcPath);
    if (lstat.isSymbolicLink()) {
      if (!dryRun) {
        const linkTarget = fs.readlinkSync(srcPath);
        try {
          if (fs.existsSync(dstPath) || fs.lstatSync(dstPath)) {
            fs.rmSync(dstPath, { force: true });
          }
        } catch { /* dst doesn't exist, ok */ }
        try {
          fs.symlinkSync(linkTarget, dstPath);
          report.copied.push(`${dstPath} → symlink`);
        } catch (err: any) {
          report.skipped.push(`${srcPath} (symlink 失败: ${err.message})`);
        }
      } else {
        report.copied.push(`${dstPath} → symlink (dry-run)`);
      }
      continue;
    }

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath, report, dryRun);
    } else {
      // 跳过非常大的文件（>50MB）
      const stat = fs.statSync(srcPath);
      if (stat.size > 50 * 1024 * 1024) {
        report.skipped.push(`${srcPath} (${(stat.size / 1024 / 1024).toFixed(0)}MB, 太大)`);
        continue;
      }
      if (!dryRun) {
        fs.copyFileSync(srcPath, dstPath);
      }
      report.copied.push(dstPath);
    }
  }
}

export async function migrate(options: Partial<MigrateOptions> & { tenantId?: string }): Promise<MigrateReport> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const source = options.source ?? path.join(homeDir, ".pi", "agent");
  const dataDir = process.env.DATA_DIR ?? "./.pi-platform-data";
  const tenantId = options.tenantId ?? "local";
  const target = options.target ?? path.join(dataDir, "pi-config", tenantId);
  const dryRun = options.dryRun ?? false;

  const report: MigrateReport = { copied: [], skipped: [], errors: [] };

  console.log("");
  console.log("\x1b[36m╔══════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[36m║\x1b[0m   \x1b[1mPi-Triple Migrate\x1b[0m                \x1b[36m║\x1b[0m");
  console.log("\x1b[36m║\x1b[0m   扩展 & 配置迁移                  \x1b[36m║\x1b[0m");
  console.log("\x1b[36m╚══════════════════════════════════════╝\x1b[0m");
  console.log("");
  console.log(`  源:   ${source}`);
  console.log(`  目标: ${target}`);
  console.log(`  租户: ${tenantId}`);
  if (dryRun) console.log("  \x1b[33m模式: 预览 (dry-run)\x1b[0m");
  console.log("");

  // 检查源目录
  if (!fs.existsSync(source)) {
    console.log(`  \x1b[31m❌ 源目录不存在: ${source}\x1b[0m`);
    report.errors.push(`源目录不存在: ${source}`);
    return report;
  }

  // 迁移目录
  for (const dir of DIRS_TO_MIGRATE) {
    const srcDir = path.join(source, dir);
    const dstDir = path.join(target, dir);
    if (fs.existsSync(srcDir)) {
      console.log(`  📁 ${dir}/`);
      copyDirRecursive(srcDir, dstDir, report, dryRun);
    } else {
      report.skipped.push(`${dir}/ (不存在)`);
    }
  }

  // 迁移文件
  for (const file of FILES_TO_MIGRATE) {
    const srcFile = path.join(source, file);
    const dstFile = path.join(target, file);
    if (fs.existsSync(srcFile)) {
      if (!dryRun) {
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
      }
      report.copied.push(dstFile);
      console.log(`  📄 ${file}`);
    } else {
      report.skipped.push(`${file} (不存在)`);
    }
  }

  // 汇总
  console.log("");
  console.log(`  \x1b[32m✅ 复制: ${report.copied.length} 项\x1b[0m`);
  if (report.skipped.length > 0) {
    console.log(`  \x1b[33m⏭️  跳过: ${report.skipped.length} 项\x1b[0m`);
  }
  if (report.errors.length > 0) {
    console.log(`  \x1b[31m❌ 错误: ${report.errors.length} 项\x1b[0m`);
    for (const e of report.errors) {
      console.log(`     ${e}`);
    }
  }

  // 验证迁移结果
  if (!dryRun) {
    console.log("");
    console.log("  迁移后验证:");
    const settingsPath = path.join(target, "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const packages = settings.packages ?? [];
        console.log(`  📦 包: ${packages.length > 0 ? packages.join(", ") : "(无)"}`);
      } catch {
        console.log("  ⚠️  settings.json 解析失败");
      }
    }
    const extDir = path.join(target, "extensions");
    if (fs.existsSync(extDir)) {
      const exts = fs.readdirSync(extDir);
      console.log(`  🔌 扩展: ${exts.join(", ")}`);
    }
    const skillsDir = path.join(target, "skills");
    if (fs.existsSync(skillsDir)) {
      const skills = fs.readdirSync(skillsDir);
      console.log(`  📚 技能: ${skills.join(", ")}`);
    }
  }

  console.log("");
  if (!dryRun) {
    console.log(`  \x1b[32m迁移完成！\x1b[0m 运行 npm run tui 验证。`);
  } else {
    console.log(`  预览完成。去掉 --dry-run 执行实际迁移。`);
  }
  console.log("");

  return report;
}

// CLI 入口
async function main() {
  const args = process.argv.slice(2);
  let tenantId = "local";
  let source: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--tenant": tenantId = args[++i]; break;
      case "--source": source = args[++i]; break;
      case "--dry-run": dryRun = true; break;
    }
  }

  await migrate({ tenantId, source, dryRun });
}

// 只在直接执行时运行 main（被 import 时不执行）
const isDirectRun = process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
