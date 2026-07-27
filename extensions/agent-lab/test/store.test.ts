import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/store.ts";
import type { RunRecord } from "../src/types.ts";

function mkStore() { return new SqliteStore(":memory:"); }
function run(p: Partial<RunRecord>): RunRecord {
  return { ts: Date.now(), role: "reviewer", model: "deepseek/deepseek-v3.2", completion: 0.7, source: "auto", ...p };
}

test("appendRun + aggregateByRole computes avg completion/cost/success", () => {
  const s = mkStore();
  s.appendRun(run({ model: "m1", completion: 1.0, cost: 0.10, toolSuccess: 1 }));
  s.appendRun(run({ model: "m1", completion: 0.5, cost: 0.30, toolSuccess: 1 }));
  s.appendRun(run({ model: "m2", completion: 0.8, cost: 0.00, toolSuccess: 0.5 }));
  const aggs = s.aggregateByRole("reviewer");
  const m1 = aggs.find((a) => a.model === "m1")!;
  assert.equal(m1.runs, 2);
  assert.ok(Math.abs(m1.avgCompletion - 0.75) < 1e-9);
  assert.ok(Math.abs(m1.avgCost - 0.20) < 1e-9);
  const m2 = aggs.find((a) => a.model === "m2")!;
  assert.ok(Math.abs(m2.successRate - 0.5) < 1e-9);
  s.close();
});

test("pin get/set/overwrite/clear", () => {
  const s = mkStore();
  assert.equal(s.getPin("worker"), undefined);
  s.setPin("worker", "qwen/qwen3.7-max");
  assert.equal(s.getPin("worker"), "qwen/qwen3.7-max");
  s.setPin("worker", "deepseek/deepseek-v4-pro");
  assert.equal(s.getPin("worker"), "deepseek/deepseek-v4-pro");
  s.clearPin("worker");
  assert.equal(s.getPin("worker"), undefined);
  s.close();
});

test("config get/set roundtrip", () => {
  const s = mkStore();
  s.setConfig("weights.completion", "0.8");
  assert.equal(s.getConfig()["weights.completion"], "0.8");
  s.close();
});

test("appendRun stores trace_id when traceId is provided", () => {
  const s = mkStore();
  s.appendRun(run({ traceId: "call-abc123" }));
  const row = s.raw.prepare("SELECT trace_id FROM runs LIMIT 1").get() as { trace_id: string | null } | undefined;
  assert.ok(row);
  assert.equal(row!.trace_id, "call-abc123");
  s.close();
});

test("appendRun stores NULL trace_id when traceId is absent", () => {
  const s = mkStore();
  s.appendRun(run({}));
  const row = s.raw.prepare("SELECT trace_id FROM runs LIMIT 1").get() as { trace_id: string | null } | undefined;
  assert.ok(row);
  assert.equal(row!.trace_id, null);
  s.close();
});

test("existing DB without trace_id column is migrated and rows readable with NULL", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-lab-test-"));
  const dbPath = join(tmpDir, "test.db");

  try {
    // Create DB without trace_id column (simulating old pre-T2 schema)
    const db1 = new DatabaseSync(dbPath);
    db1.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        task_category TEXT,
        acceptance TEXT,
        completion REAL NOT NULL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost REAL,
        tool_success REAL,
        turns INTEGER,
        interrupted INTEGER,
        signals TEXT,
        source TEXT NOT NULL
      );
      INSERT INTO runs (ts, role, model, completion, cost, tool_success, source)
      VALUES (1700000000000, 'reviewer', 'm1', 0.8, 0.10, 1.0, 'auto');
      INSERT INTO runs (ts, role, model, completion, cost, tool_success, source)
      VALUES (1700000000001, 'reviewer', 'm1', 0.5, 0.05, 1.0, 'auto');
    `);
    db1.close();

    // Open with SqliteStore which should migrate
    const s = new SqliteStore(dbPath);
    // Legacy row should be readable
    const aggs = s.aggregateByRole("reviewer");
    assert.equal(aggs.length, 1);
    assert.equal(aggs[0].runs, 2);
    // Legacy row has NULL trace_id
    const row = s.raw.prepare("SELECT trace_id FROM runs LIMIT 1").get() as { trace_id: string | null } | undefined;
    assert.ok(row);
    assert.equal(row!.trace_id, null);
    // New row can carry trace_id
    s.appendRun(run({ traceId: "call-new" }));
    const rows = s.raw.prepare("SELECT trace_id FROM runs ORDER BY id").all() as Array<{ trace_id: string | null }>;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].trace_id, null);
    assert.equal(rows[1].trace_id, null);
    assert.equal(rows[2].trace_id, "call-new");
    s.close();
  } finally {
    unlinkSync(dbPath);
    rmdirSync(tmpDir);
  }
});

test("listRoles distinct + sorted", () => {
  const s = mkStore();
  s.appendRun(run({ role: "reviewer" }));
  s.appendRun(run({ role: "worker" }));
  s.appendRun(run({ role: "reviewer" }));
  assert.deepEqual(s.listRoles(), ["reviewer", "worker"]);
  s.close();
});
