import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { aggregateByRole, listRoles, listModels, modelComparison } from "../src/lab-data/telemetry.js";
import { openDb } from "../src/lab-data/open-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
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
  intercepted INTEGER DEFAULT 0,
  signals TEXT,
  source TEXT NOT NULL,
  trace_id TEXT,
  tenant_id TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_role_model ON runs(role, model);
`;

function seedTestData(db: DatabaseSync) {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO runs (ts, role, model, acceptance, completion, tokens_in, tokens_out, cost, source, tenant_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // tenant-a data
  stmt.run(now, "coder", "model-A", "accepted", 1200, 4000, 2000, 0.003, "scheduler", "tenant-a", "sess-1");
  stmt.run(now - 60000, "coder", "model-A", "accepted", 1100, 3500, 1800, 0.002, "scheduler", "tenant-a", "sess-1");
  stmt.run(now - 120000, "coder", "model-B", "rejected", 2500, 5000, 2500, 0.01, "scheduler", "tenant-a", "sess-1");

  // tenant-b data
  stmt.run(now - 180000, "coder", "model-A", "accepted", 1000, 3000, 1500, 0.001, "scheduler", "tenant-b", "sess-2");
  stmt.run(now - 240000, "reviewer", "model-C", "accepted", 800, 2000, 1000, 0.005, "recommend", "tenant-b", "sess-2");

  // legacy (NULL tenant_id)
  stmt.run(now - 600000, "coder", "model-A", "accepted", 1500, 5000, 2000, 0.004, "manual", null, null);
}

describe("telemetry", () => {
  let db: DatabaseSync;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/pi-triple-test-");
    db = openDb(join(tmpDir, "test.db"));
    db.exec(SCHEMA);
    seedTestData(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aggregateByRole returns all roles aggregated", () => {
    const rows = aggregateByRole(db);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const coderRows = rows.filter((r) => r.role === "coder");
    expect(coderRows.length).toBeGreaterThanOrEqual(1);
  });

  it("aggregateByRole filters by role", () => {
    const rows = aggregateByRole(db, "reviewer");
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("reviewer");
    expect(rows[0].model).toBe("model-C");
  });

  it("aggregateByRole filters by tenantId", () => {
    const rows = aggregateByRole(db, undefined, "tenant-a");
    // tenant-a: 3 runs + NULL tenant_id: 1 run
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // All should belong to tenant-a or be legacy
    const coderModelA = rows.find((r) => r.role === "coder" && r.model === "model-A");
    expect(coderModelA).toBeDefined();
    // tenant-a model-A: 2 runs + legacy model-A: 1 run = 3
    expect(coderModelA?.runs).toBe(3);
  });

  it("aggregateByRole filters by days", () => {
    const rows = aggregateByRole(db, undefined, undefined, 0.001); // ~1.4 min
    // Only very recent rows should appear
    const coderModelA = rows.find((r) => r.role === "coder" && r.model === "model-A");
    expect(coderModelA?.runs).toBeLessThan(4);
  });

  it("listRoles returns distinct roles", () => {
    const roles = listRoles(db);
    expect(roles).toContain("coder");
    expect(roles).toContain("reviewer");
  });

  it("listRoles filters by tenantId", () => {
    const roles = listRoles(db, "tenant-b");
    expect(roles).toContain("coder");
    expect(roles).toContain("reviewer");
  });

  it("listModels returns distinct models", () => {
    const models = listModels(db);
    expect(models).toContain("model-A");
    expect(models).toContain("model-B");
    expect(models).toContain("model-C");
  });

  it("modelComparison returns metric rows", () => {
    const rows = modelComparison(db, "model-A", "model-B");
    expect(rows.length).toBe(5);
    expect(rows.find((r) => r.metric === "Runs")).toBeDefined();
    expect(rows.find((r) => r.metric === "Success %")).toBeDefined();
  });

  it("empty db returns no results gracefully", () => {
    const emptyDb = openDb(join(tmpDir, "empty.db"));
    emptyDb.exec(SCHEMA);
    expect(aggregateByRole(emptyDb)).toEqual([]);
    expect(listRoles(emptyDb)).toEqual([]);
    expect(listModels(emptyDb)).toEqual([]);
    const cmp = modelComparison(emptyDb, "X", "Y");
    expect(cmp.length).toBe(5);
    expect(cmp[0].modelA).toBe("0"); // empty DB = 0 runs
    emptyDb.close();
  });
});
