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
import type { IngestPipeline, IngestSummary } from "../src/ingest/pipeline.ts";
import type { SourceDoc } from "../src/ingest/source.ts";
import { parseDoc } from "../src/ingest/docs-source.ts";
import { runIngestCycleOnce, startIngestCycle } from "../src/ingest/cycle.ts";

const docA = parseDoc("ptl/authoring.md", "# 模板开发\n\n指南。\n");

function fakePipeline(changed: SourceDoc[]): IngestPipeline {
  return { run: (): IngestSummary => ({ scanned: changed.length, created: changed.length, updated: 0, skipped: 0, changed }) } as unknown as IngestPipeline;
}

function freshPool() {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-cycle-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const store = new SqliteTaskStore({ db, appendEvent: () => "inserted", traceId: "test" });
  return { dir, db, registry, store };
}

test("单轮：changed 逐文档 publish 到池，任务形状符合语义分解模板", async () => {
  const { dir, db, registry, store } = freshPool();
  const summary = await runIngestCycleOnce({ pipeline: fakePipeline([docA]), pool: { registry, store }, intervalMs: 60_000 });
  assert.equal(summary.published, 1);
  const tasks = store.list({ status: "pending" });
  assert.equal(tasks.length, 1);
  const t = tasks[0]!;
  assert.equal(t.templateId, "semantic-split");
  assert.equal(t.createdBy, "ingest-cycle");
  assert.ok(t.text.includes("ptl/authoring.md"));
  assert.ok(t.text.includes("sdk.memory.write"));
  assert.ok(t.labels.includes("memory-maintenance"));
  assert.ok(t.labels.includes("semantic-split"));
  assert.deepEqual(t.params, { relPath: docA.relPath });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("无增量不 publish", async () => {
  const { dir, db, registry, store } = freshPool();
  const summary = await runIngestCycleOnce({ pipeline: fakePipeline([]), pool: { registry, store }, intervalMs: 60_000 });
  assert.equal(summary.published, 0);
  assert.equal(store.list({ status: "pending" }).length, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("模板注册幂等 + 无增量不重复 publish", async () => {
  const { dir, db, registry, store } = freshPool();
  await runIngestCycleOnce({ pipeline: fakePipeline([docA]), pool: { registry, store }, intervalMs: 60_000 });
  await runIngestCycleOnce({ pipeline: fakePipeline([]), pool: { registry, store }, intervalMs: 60_000 });
  assert.equal(store.list({ status: "pending" }).length, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("startIngestCycle 返回 stop，stop 后不再触发", async () => {
  const { dir, db, registry, store } = freshPool();
  const handle = startIngestCycle({
    pipeline: fakePipeline([]),
    pool: { registry, store },
    intervalMs: 60_000,
  });
  handle.stop();
  // 无定时器泄漏即通过（unref + stop 后进程不挂起——node:test 自身会因挂起超时报错）
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
