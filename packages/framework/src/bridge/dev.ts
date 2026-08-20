/**
 * bridge/dev.ts — ptl dev 命令
 *
 * 本地调试 agent 程序：用 pi 原生会话加载程序的 systemPrompt + skills。
 * 对称于 ptl run，但与 run 同级加载（未来可收敛为统一入口）。
 */
import fs from "node:fs";
import path from "node:path";
import { packProgram } from "@away_from/pth-console";
import { pipeToProcess } from "./pipe.js";

export async function cmdDev(dir: string, passthrough: string[], flags: Record<string, string>): Promise<void> {
  if (!dir) {
    console.log("  用法: ptl hub dev <dir> [pi args...]");
    process.exit(1);
  }

  const absDir = path.resolve(dir);
  let isDir = false;
  try { isDir = fs.statSync(absDir).isDirectory(); } catch { /* 不存在或不可读 */ }
  if (!isDir) {
    console.log(`  \x1b[31m❌ 目录不存在或不可访问: ${dir}\x1b[0m`);
    process.exit(1);
  }

  // 校验 manifest
  let manifest;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(absDir, "agent.json"), "utf-8"));
    const { validateManifest } = await import("@away_from/pth-console");
    const v = validateManifest(raw);
    if (!v.ok) {
      console.log("  \x1b[31m❌ agent.json 无效:\x1b[0m");
      for (const err of v.errors) console.log(`    - ${err}`);
      process.exit(1);
    }
    manifest = v.manifest;
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 无法读取 agent.json: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  console.log(`  \x1b[1m本地调试: ${manifest.name}\x1b[0m`);

  // 构建 pi 启动参数
  await pipeToProcess(absDir, manifest, passthrough, flags);
}
