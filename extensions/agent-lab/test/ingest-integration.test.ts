// 端到端集成（spec §9）：真实 docs 树 → DocsSource → IngestPipeline（真实 MemoryStore/Pipeline）
// → 锚点检索 → 热度旁路 → 周期流派发。PI 风格隔离目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { DocsSource } from "../src/ingest/docs-source.ts";
import { ensureIngestRule } from "../src/ingest/rule.ts";
import { IngestPipeline, pointerEntryId } from "../src/ingest/pipeline.ts";
import { runIngestCycleOnce } from "../src/ingest/cycle.ts";
import type { DispatchRequest } from "../src/scheduler/runner-types.ts";

function fixtureDocs(): string {
  const docs = mkdtempSync(path.join(tmpdir(), "ingest-docs-"));
  writeFileSync(path.join(docs, "guide.md"), "# 使用指南\n\n这是使用指南的摘要。\n\n正文若干。\n");
  mkdirSync(path.join(docs, "specs"));
  writeFileSync(path.join(docs, "specs", "2026-08-06-demo-design.md"), "# Demo 设计\n\n设计摘要。\n");
  return docs;
}

function freshMem() {
  const memDir = mkdtempSync(path.join(tmpdir(), "ingest-mem-"));
  const store = new MemoryStore(memDir);
  const rules = new RuleRegistry(memDir);
  rules.bootstrapAxiom();
  const ruleId = ensureIngestRule(rules);
  const memPipeline = new MemoryPipeline({ dir: memDir, store, rules, trace: { traceId: "ingest-int", transitionSeq: 1 } });
  return { memDir, store, ruleId, memPipeline };
}

test("端到端：摄入→幂等→增量→检索→热度→派发", async () => {
  const docsDir = fixtureDocs();
  const { memDir, store, ruleId, memPipeline } = freshMem();
  const pipeline = new IngestPipeline({ source: new DocsSource(docsDir), store, memPipeline, ruleId });

  // 1. 首轮：全部 created
  const s1 = pipeline.run();
  assert.deepEqual({ scanned: s1.scanned, created: s1.created }, { scanned: 2, created: 2 });

  // 2. 二轮：全部 skipped（幂等）
  const s2 = pipeline.run();
  assert.equal(s2.skipped, 2);
  assert.equal(s2.changed.length, 0);

  // 3. 改动文档 → updated + 版本递增
  appendFileSync(path.join(docsDir, "guide.md"), "\n新增段落。\n");
  const s3 = pipeline.run();
  assert.deepEqual({ created: s3.created, updated: s3.updated, skipped: s3.skipped }, { created: 0, updated: 1, skipped: 1 });
  const id = pointerEntryId("guide.md");
  assert.equal(store.get(id)!.meta.version, 2);

  // 4. 锚点检索命中
  const hits = store.retrieve({ anchors: ["demo-design"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, pointerEntryId("specs/2026-08-06-demo-design.md"));
  assert.ok(hits[0]!.content.includes("源: specs/2026-08-06-demo-design.md"));

  // 5. 热度旁路：bumpHitCount 两次 → 计数 2
  store.bumpHitCount(id);
  store.bumpHitCount(id);
  const counterFile = path.join(memDir, "counters", `${id}.json`);
  assert.ok(existsSync(counterFile));
  assert.equal(JSON.parse(readFileSync(counterFile, "utf-8")).hitCount, 2);

  // 6. 周期流：改文档后单轮 → 为变更文档派发语义分解任务
  const calls: DispatchRequest[] = [];
  appendFileSync(path.join(docsDir, "guide.md"), "\n再改一次。\n");
  await runIngestCycleOnce({ pipeline, dispatch: async (req) => { calls.push(req); }, intervalMs: 60_000 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.task.includes("guide.md"));
  assert.equal(calls[0]!.labels?.strategy, "weighted");

  rmSync(docsDir, { recursive: true, force: true });
  rmSync(memDir, { recursive: true, force: true });
});
