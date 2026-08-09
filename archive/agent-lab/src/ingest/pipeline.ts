// 摄入管道（spec §4）：源扫描 → 指针条目（create/update/skip）。
// 机械、确定性、幂等——不经 agent；文档层进入记忆系统的唯一接口。
// 增量判定：源文档 contentHash 相同 ⟺ 无变更（idempotencyKey 携带全量哈希，spec §4）。

import { createHash } from "node:crypto";
import type { MemoryPipeline } from "../memory/pipeline.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { IngestSource, SourceDoc } from "./source.ts";
import { deriveTags } from "./tags.ts";

export interface IngestSummary {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  /** created + updated 的文档——cycle 用其派发语义分解任务 */
  changed: SourceDoc[];
}

export interface IngestPipelineDeps {
  source: IngestSource;
  store: MemoryStore;
  memPipeline: MemoryPipeline;
  ruleId: string;
}

/** 确定性条目 id：relPath → sha256 → UUID 形态（同文档恒同 id）。 */
export function pointerEntryId(relPath: string): string {
  const hex = createHash("sha256").update(`ingest-pointer:${relPath}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildPointerContent(doc: SourceDoc): string {
  return `# ${doc.title}\n\n${doc.firstPara}\n\n源: ${doc.relPath}`;
}

export class IngestPipeline {
  private deps: IngestPipelineDeps;

  constructor(deps: IngestPipelineDeps) {
    this.deps = deps;
  }

  run(): IngestSummary {
    const docs = this.deps.source.list();
    const summary: IngestSummary = { scanned: docs.length, created: 0, updated: 0, skipped: 0, changed: [] };
    for (const doc of docs) {
      const id = pointerEntryId(doc.relPath);
      const content = buildPointerContent(doc);
      const existing = this.deps.store.get(id);
      if (existing && existing.idempotencyKey === `ingest:${doc.relPath}:${doc.contentHash}`) { summary.skipped++; continue; }
      const r = this.deps.memPipeline.write({
        id,
        kind: "fact",
        anchors: deriveTags(doc.relPath),
        content,
        ruleRef: this.deps.ruleId,
        status: "official",
        idempotencyKey: `ingest:${doc.relPath}:${doc.contentHash}`,
        // spec §4：hash 不同写新版本——store.write 仅按内容差异递增版本，
        // 正文变更（派生内容不变）时须显式携带下一版本号。
        ...(existing ? { meta: { version: existing.meta.version + 1 } } : {}),
      });
      if (!r.ok) throw new Error(`ingest ${doc.relPath} failed: ${r.errors.join("; ")}`);
      if (existing) summary.updated++; else summary.created++;
      summary.changed.push(doc);
    }
    return summary;
  }
}
