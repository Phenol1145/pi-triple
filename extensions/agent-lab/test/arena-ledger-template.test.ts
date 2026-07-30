import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import type { ModelInfo } from "../src/types.ts";
import type { EndowmentPolicy, ArenaTask } from "../src/arena/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
function model(id: string): ModelInfo { return { id, provider: id.split("/")[0], name: id, accessRoute: "free" }; }
function mk() {
  const store = new SqliteStore(":memory:");
  const ledger = new SqliteLedger(store.raw, fixedEndow);
  return { store, ledger };
}
const task: ArenaTask = { id: "t1", role: "code", prompt: "x", difficulty: "medium", odds: 1, reward: 100 };

test("ensureEndowed records template_id on credits", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("agent-1", model("m/a"), "tpl-alpha");
  const row = store.raw.prepare("SELECT template_id FROM credits WHERE agent = ?").get("agent-1") as { template_id: string };
  assert.equal(row.template_id, "tpl-alpha");
});

test("ensureEndowed without template_id leaves NULL", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("agent-1", model("m/a"));
  const row = store.raw.prepare("SELECT template_id FROM credits WHERE agent = ?").get("agent-1") as { template_id: string | null };
  assert.equal(row.template_id, null);
});

test("credit records template_id on credit_tx", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("agent-1", model("m/a"), "tpl-alpha");
  ledger.credit("agent-1", 50, "reward", "t1", 1, "tpl-alpha");
  const tx = store.raw.prepare("SELECT template_id FROM credit_tx WHERE agent = ? AND reason = 'reward'").get("agent-1") as { template_id: string };
  assert.equal(tx.template_id, "tpl-alpha");
});

test("debit records template_id on credit_tx", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("agent-1", model("m/a"), "tpl-beta");
  ledger.debit("agent-1", 30, "opt-out-tax", "t1", undefined, "tpl-beta");
  const tx = store.raw.prepare("SELECT template_id FROM credit_tx WHERE agent = ? AND reason = 'opt-out-tax'").get("agent-1") as { template_id: string };
  assert.equal(tx.template_id, "tpl-beta");
});

test("createTask records template_id on market_tasks", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("agent-1", model("m/a"), "tpl-alpha");
  ledger.createTask(task, "agent-1", 100, 1, "m/a", "tpl-alpha");
  const row = store.raw.prepare("SELECT template_id FROM market_tasks WHERE task_id = ?").get("t1") as { template_id: string };
  assert.equal(row.template_id, "tpl-alpha");
});

test("getTask returns templateId", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("agent-1", model("m/a"), "tpl-alpha");
  ledger.createTask(task, "agent-1", 100, 1, "m/a", "tpl-alpha");
  const row = ledger.getTask("t1");
  assert.equal(row?.templateId, "tpl-alpha");
});

test("cross-template aggregation: credits per template", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("agent-a", model("m/a"), "tpl-alpha");
  ledger.ensureEndowed("agent-b", model("m/b"), "tpl-beta");
  ledger.credit("agent-a", 200, "reward", undefined, undefined, "tpl-alpha");
  ledger.credit("agent-b", 300, "reward", undefined, undefined, "tpl-beta");

  const rows = store.raw.prepare(
    "SELECT template_id, SUM(balance) AS total FROM credits WHERE template_id IS NOT NULL GROUP BY template_id ORDER BY template_id"
  ).all() as { template_id: string; total: number }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].template_id, "tpl-alpha");
  assert.equal(rows[0].total, 1200);
  assert.equal(rows[1].template_id, "tpl-beta");
  assert.equal(rows[1].total, 1300);
});

test("cross-template aggregation: market_tasks per template", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("agent-a", model("m/a"), "tpl-alpha");
  ledger.ensureEndowed("agent-b", model("m/b"), "tpl-beta");
  ledger.createTask({ ...task, id: "t1" }, "agent-a", 100, 1, "m/a", "tpl-alpha");
  ledger.createTask({ ...task, id: "t2" }, "agent-b", 80, 2, "m/b", "tpl-beta");
  ledger.createTask({ ...task, id: "t3" }, "agent-a", 120, 3, "m/a", "tpl-alpha");

  const rows = store.raw.prepare(
    "SELECT template_id, COUNT(*) AS n, SUM(stake) AS total_stake FROM market_tasks WHERE template_id IS NOT NULL GROUP BY template_id ORDER BY template_id"
  ).all() as { template_id: string; n: number; total_stake: number }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].template_id, "tpl-alpha");
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].total_stake, 220);
  assert.equal(rows[1].template_id, "tpl-beta");
  assert.equal(rows[1].n, 1);
  assert.equal(rows[1].total_stake, 80);
});

test("ALTER migration adds template_id to existing DB", () => {
  const store = new SqliteStore(":memory:");
  // Simulate old schema without template_id
  store.raw.exec("DROP TABLE IF EXISTS credits");
  store.raw.exec("CREATE TABLE credits (agent TEXT PRIMARY KEY, balance REAL NOT NULL, frozen REAL NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL)");
  store.raw.exec("INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('old-agent', 500, 0, 0)");

  // Re-create ledger on same DB — migration should add template_id
  const ledger = new SqliteLedger(store.raw, fixedEndow);
  const cols = store.raw.prepare("PRAGMA table_info(credits)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "template_id"), "template_id column should exist after migration");

  // Old row should have NULL template_id
  const row = store.raw.prepare("SELECT template_id FROM credits WHERE agent = 'old-agent'").get() as { template_id: string | null };
  assert.equal(row.template_id, null);

  // New operations work with template_id
  ledger.ensureEndowed("new-agent", model("m/x"), "tpl-new");
  const newRow = store.raw.prepare("SELECT template_id FROM credits WHERE agent = 'new-agent'").get() as { template_id: string };
  assert.equal(newRow.template_id, "tpl-new");
});
