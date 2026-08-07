import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTemplateRegistry } from "../src/taskpool/templates.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../src/taskpool/semantic-split.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { runIngestCycleOnce } from "../src/ingest/cycle.ts";
import type { IngestPipeline } from "../src/ingest/pipeline.ts";
import type { SourceDoc } from "../src/ingest/source.ts";

const docA: SourceDoc = { relPath: "docs/a.md", title: "A", firstPara: "摘要", contentHash: "hash-a" };

function fakePipeline(changed: SourceDoc[]): IngestPipeline {
  return { run: () => ({ scanned: changed.length, created: changed.length, updated: 0, skipped: 0, changed }) } as unknown as IngestPipeline;
}

test("迁移：摄入增量 → 向池 publish semantic-split 任务（不再直接 dispatch）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-mig-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const store = new SqliteTaskStore({ db, appendEvent: () => "inserted", traceId: "test" });

  await runIngestCycleOnce({ pipeline: fakePipeline([docA]), pool: { registry, store }, intervalMs: 60_000 });
  const tasks = store.list({ status: "pending" });
  assert.equal(tasks.length, 1);
  const t = tasks[0]!;
  assert.equal(t.templateId, "semantic-split");
  assert.ok(t.text.includes("docs/a.md"));
  assert.ok(t.labels.includes("memory-maintenance"));
  assert.ok(t.labels.includes("semantic-split"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
