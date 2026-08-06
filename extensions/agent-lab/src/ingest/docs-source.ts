// 仓库 docs 源适配器：递归扫描 *.md → SourceDoc（机械提取，零 LLM）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { IngestSource, SourceDoc } from "./source.ts";

const FIRST_PARA_MAX = 500;

export function parseDoc(relPath: string, text: string): SourceDoc {
  const lines = text.split("\n");
  let title = "";
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^#\s+(.+?)\s*$/);
    if (m) { title = m[1]!; titleIdx = i; break; }
  }
  if (!title) {
    const file = relPath.split("/").pop() ?? relPath;
    title = file.replace(/\.[^.]*$/, "");
  }
  // firstPara：标题（或文首）后首个非空段落；遇下一标题停止
  const paraLines: string[] = [];
  let started = false;
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") { if (started) break; continue; }
    if (line.startsWith("#")) break;
    started = true;
    paraLines.push(line);
  }
  const firstPara = paraLines.join(" ").slice(0, FIRST_PARA_MAX);
  return {
    relPath,
    title: title.replaceAll("|", "／"),
    firstPara: (firstPara.length > 0 ? firstPara : "（无摘要）").replaceAll("|", "／"),
    contentHash: createHash("sha256").update(text).digest("hex"),
  };
}

export class DocsSource implements IngestSource {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  list(): SourceDoc[] {
    const out: SourceDoc[] = [];
    this.walk(this.rootDir, out);
    out.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
    return out;
  }

  private walk(dir: string, out: SourceDoc[]): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { this.walk(full, out); continue; }
      if (!name.endsWith(".md")) continue;
      const text = readFileSync(full, "utf-8");
      out.push(parseDoc(relative(this.rootDir, full).replace(/\\/g, "/"), text));
    }
  }
}
