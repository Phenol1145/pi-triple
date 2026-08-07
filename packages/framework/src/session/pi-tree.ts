// pi-tree.ts — Pi 纸带会话谱系森林渲染（平铺缩进）
// 按 parentSession 文件路径匹配父子；悬空引用（父文件不存在）标 "(deleted)"。
import path from "node:path";
import type { PiSessionFile } from "./pi-scan.js";

/** 按 parentSession 构建谱系森林（根无缩进；子带缩进；悬空标 (deleted)） */
export function buildSessionTree(files: PiSessionFile[]): string {
  const byFile = new Map(files.map((f) => [f.file, f]));
  const children = new Map<string, PiSessionFile[]>();
  const roots: PiSessionFile[] = [];
  for (const f of files) {
    if (f.parentSession && byFile.has(f.parentSession)) {
      const list = children.get(f.parentSession) ?? [];
      list.push(f);
      children.set(f.parentSession, list);
    } else {
      // 无 parentSession 或父文件不存在（悬空引用）→ 按根渲染，悬空标 (deleted)
      roots.push(f);
    }
  }
  roots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const list of children.values()) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const lines: string[] = [];
  const visit = (f: PiSessionFile, depth: number): void => {
    const indent = depth === 0 ? "" : "  ".repeat(depth - 1) + (depth > 1 ? "  " : "") + "└─ ";
    const parent = f.parentSession ? (byFile.has(f.parentSession) ? "" : " (deleted)") : "";
    lines.push(`${indent}${path.basename(f.file)}${parent}  [${f.templateId}]`);
    for (const c of children.get(f.file) ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return lines.join("\n");
}
