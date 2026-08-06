import { test } from "node:test";
import assert from "node:assert/strict";
import type { DispatchRequest } from "../src/scheduler/runner-types.ts";
import type { IngestPipeline, IngestSummary } from "../src/ingest/pipeline.ts";
import type { SourceDoc } from "../src/ingest/source.ts";
import { parseDoc } from "../src/ingest/docs-source.ts";
import { runIngestCycleOnce, startIngestCycle, semanticSplitTask, MEMORY_MAINTENANCE_ROLE } from "../src/ingest/cycle.ts";

const docA = parseDoc("ptl/authoring.md", "# 模板开发\n\n指南。\n");

function fakePipeline(changed: SourceDoc[]): IngestPipeline {
  return { run: (): IngestSummary => ({ scanned: changed.length, created: changed.length, updated: 0, skipped: 0, changed }) } as unknown as IngestPipeline;
}

test("单轮：changed 逐文档派发，参数符合 spec（weighted 路由 + 执行模式）", async () => {
  const calls: DispatchRequest[] = [];
  const summary = await runIngestCycleOnce({
    pipeline: fakePipeline([docA]),
    dispatch: async (req) => { calls.push(req); return { status: "completed" }; },
    intervalMs: 60_000,
  });
  assert.equal(summary.created, 1);
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.role, MEMORY_MAINTENANCE_ROLE);
  assert.equal(req.task, semanticSplitTask(docA.relPath));
  assert.ok(req.task.includes("ptl/authoring.md"));
  assert.ok(req.task.includes("sdk.memory.write"));
  assert.equal(req.labels?.strategy, "weighted");
  assert.equal(req.labels?.relPath, docA.relPath);
  assert.equal(req.caller, "ingest-cycle");
  assert.equal(req.taskCategory, "memory-maintenance");
  assert.equal(req.mode, "execute");
  assert.ok(req.traceId.startsWith("ingest-cycle:"));
});

test("无增量不派发", async () => {
  const calls: DispatchRequest[] = [];
  await runIngestCycleOnce({
    pipeline: fakePipeline([]),
    dispatch: async (req) => { calls.push(req); },
    intervalMs: 60_000,
  });
  assert.equal(calls.length, 0);
});

test("role 可覆盖", async () => {
  const calls: DispatchRequest[] = [];
  await runIngestCycleOnce({
    pipeline: fakePipeline([docA]),
    dispatch: async (req) => { calls.push(req); },
    intervalMs: 60_000,
    role: "custom-role",
  });
  assert.equal(calls[0]!.role, "custom-role");
});

test("startIngestCycle 返回 stop，stop 后不再触发", async () => {
  const handle = startIngestCycle({
    pipeline: fakePipeline([]),
    dispatch: async () => { throw new Error("不应被调用"); },
    intervalMs: 60_000,
  });
  handle.stop();
  // 无定时器泄漏即通过（unref + stop 后进程不挂起——node:test 自身会因挂起超时报错）
});
