import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { parseDoc } from "../src/ingest/docs-source.ts";
import type { IngestSource, SourceDoc } from "../src/ingest/source.ts";
import { ensureIngestRule, INGEST_POINTER_RULE_ID } from "../src/ingest/rule.ts";
import { IngestPipeline, pointerEntryId, buildPointerContent } from "../src/ingest/pipeline.ts";

class FakeSource implements IngestSource {
  docs: SourceDoc[];

  constructor(docs: SourceDoc[]) {
    this.docs = docs;
  }

  list(): SourceDoc[] { return this.docs; }
}

function fresh(docs: SourceDoc[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-pipe-"));
  const store = new MemoryStore(dir);
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  const ruleId = ensureIngestRule(rules);
  const memPipeline = new MemoryPipeline({ dir, store, rules, trace: { traceId: "ingest-test", transitionSeq: 1 } });
  const pipeline = new IngestPipeline({ source: new FakeSource(docs), store, memPipeline, ruleId });
  return { dir, store, pipeline };
}

const docA = parseDoc("superpowers/specs/2026-08-02-memory-system-design.md", "# 记忆系统设计\n\n三层记忆结构。\n");
const docB = parseDoc("ptl/authoring.md", "# 模板开发\n\nPTL 开发指南。\n");

test("首次运行全部 created，条目形态符合 spec §4.2", () => {
  const { pipeline, store, dir } = fresh([docA, docB]);
  const s = pipeline.run();
  assert.deepEqual({ scanned: s.scanned, created: s.created, updated: s.updated, skipped: s.skipped }, { scanned: 2, created: 2, updated: 0, skipped: 0 });
  assert.equal(s.changed.length, 2);
  const e = store.get(pointerEntryId(docA.relPath))!;
  assert.equal(e.kind, "fact");
  assert.equal(e.status, "official");
  assert.deepEqual(e.anchors, ["superpowers", "specs", "memory-system-design"]);
  assert.equal(e.content, buildPointerContent(docA));
  assert.ok(e.content.includes("源: superpowers/specs/2026-08-02-memory-system-design.md"));
  assert.equal(e.ruleRef, INGEST_POINTER_RULE_ID);
  rmSync(dir, { recursive: true, force: true });
});

test("二连跑幂等：全部 skipped，条目数不变", () => {
  const { pipeline, store, dir } = fresh([docA, docB]);
  pipeline.run();
  const before = store.listIds().length;
  const s2 = pipeline.run();
  assert.equal(s2.skipped, 2);
  assert.equal(s2.created + s2.updated, 0);
  assert.equal(s2.changed.length, 0);
  assert.equal(store.listIds().length, before);
  rmSync(dir, { recursive: true, force: true });
});

test("文档变更 → updated：同 id 版本 +1，changed 携带该文档", () => {
  const { pipeline, store, dir } = fresh([docA]);
  pipeline.run();
  const id = pointerEntryId(docA.relPath);
  assert.equal(store.get(id)!.meta.version, 1);
  const changed = parseDoc(docA.relPath, "# 记忆系统设计\n\n三层记忆结构，已修订。\n");
  (pipeline as unknown as { deps: { source: FakeSource } }).deps.source.docs = [changed];
  const s2 = pipeline.run();
  assert.deepEqual({ created: s2.created, updated: s2.updated, skipped: s2.skipped }, { created: 0, updated: 1, skipped: 0 });
  const e = store.get(id)!;
  assert.equal(e.meta.version, 2);
  assert.ok(e.content.includes("已修订"));
  assert.equal(s2.changed[0]!.relPath, docA.relPath);
  rmSync(dir, { recursive: true, force: true });
});

test("ensureIngestRule 幂等：重复调用不抛、不重复注册", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-rule-"));
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  assert.equal(ensureIngestRule(rules), INGEST_POINTER_RULE_ID);
  assert.equal(ensureIngestRule(rules), INGEST_POINTER_RULE_ID);
  rmSync(dir, { recursive: true, force: true });
});

test("指针条目可被锚点检索命中", () => {
  const { pipeline, store, dir } = fresh([docA]);
  pipeline.run();
  const hits = store.retrieve({ anchors: ["memory-system-design"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, pointerEntryId(docA.relPath));
  rmSync(dir, { recursive: true, force: true });
});
