/**
 * 并发 WAL 写入测试 — 验证 agent-lab 共享 DB 的多进程并发写入安全性。
 *
 * Fork 4 个 node 进程，各自用 node:sqlite 写入 100 条 run 记录。
 * 断言总条数 400，无 SQLITE_BUSY 错误。
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const WORKER_SRC = `
import { DatabaseSync } from "node:sqlite";
const dbPath = process.argv[2];
const tenantId = process.argv[3];
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=5000");
for (let i = 0; i < 100; i++) {
  db.prepare("INSERT INTO runs (ts, role, model, tenant_id, session_id) VALUES (?, ?, ?, ?, ?)").run(
    Date.now(), "coder-" + process.argv[3], "model-" + i, tenantId, process.argv[4]
  );
}
db.close();
`;

describe("concurrent WAL writes", () => {
  let dbDir: string;
  let dbPath: string;
  let workerScript: string;

  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), "ptl-wal-test-"));
    dbPath = join(dbDir, "shared.db");
    workerScript = join(dbDir, "worker.mjs");
    writeFileSync(workerScript, WORKER_SRC);
    // Initialize the DB with WAL mode + schema before spawning workers
    const initDb = new DatabaseSync(dbPath);
    initDb.exec("PRAGMA journal_mode=WAL");
    initDb.exec("PRAGMA synchronous=NORMAL");
    initDb.exec("CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, tenant_id TEXT, session_id TEXT)");
    initDb.close();
  });

  afterAll(() => {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test("4 concurrent writers produce 400 total rows", async () => {
    const workers = [
      fork(workerScript, [dbPath, "t-a", "s-a"], { execArgv: [] }),
      fork(workerScript, [dbPath, "t-b", "s-b"], { execArgv: [] }),
      fork(workerScript, [dbPath, "t-c", "s-c"], { execArgv: [] }),
      fork(workerScript, [dbPath, "t-d", "s-d"], { execArgv: [] }),
    ];

    const results = await Promise.allSettled(
      workers.map((w) => new Promise<void>((resolve, reject) => {
        w.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Worker exit ${code}`));
        });
        w.on("error", reject);
      }))
    );

    // Verify all workers succeeded
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") {
        console.error(`Worker ${i} failed:`, r.reason);
      }
      expect(r.status).toBe("fulfilled");
    }

    // Verify total row count
    const db = new DatabaseSync(dbPath);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
    db.close();
    expect(count).toBe(400);
  });

  test("tenant_id correctly attributed per worker", async () => {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT DISTINCT tenant_id FROM runs ORDER BY tenant_id").all() as Array<{ tenant_id: string }>;
    db.close();
    // Each of the 4 workers wrote with a different tenant_id
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual(["t-a", "t-b", "t-c", "t-d"]);
  });
});
