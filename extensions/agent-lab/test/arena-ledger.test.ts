import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import type { ModelInfo } from "../src/types.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
function model(id: string): ModelInfo { return { id, provider: id.split("/")[0], name: id, accessRoute: "free" }; }
function mk() {
  const store = new SqliteStore(":memory:");
  const ledger = new SqliteLedger(store.raw, fixedEndow);
  return { store, ledger };
}

test("ensureEndowed grants initial credits once", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  assert.equal(ledger.balance("m/a"), 1000);
  ledger.ensureEndowed("m/a", model("m/a"));
  assert.equal(ledger.balance("m/a"), 1000);
});

test("credit/debit clamps at 0 (no debt)", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.credit("m/a", 500, "reward");
  assert.equal(ledger.balance("m/a"), 1500);
  ledger.debit("m/a", 2000, "loss");
  assert.equal(ledger.balance("m/a"), 0);
});

test("freeze/unfreeze conserves balance", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.freeze("m/a", 300, "t1");
  assert.equal(ledger.balance("m/a"), 700);
  assert.equal(ledger.unfreeze("m/a", "t1"), 300);
  assert.equal(ledger.balance("m/a"), 1000);
});

test("nextRound increments and persists", () => {
  const { ledger } = mk();
  assert.equal(ledger.currentRound(), 0);
  assert.equal(ledger.nextRound(), 1);
  assert.equal(ledger.nextRound(), 2);
  assert.equal(ledger.currentRound(), 2);
});

test("createTask/getTask/setTaskStatus + agentTurn", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.createTask({ id: "t1", role: "r", prompt: "p", difficulty: "easy", odds: 1.5, reward: 10 }, "m/a", 100, 1, "m/a");
  const t = ledger.getTask("t1")!;
  assert.equal(t.winner, "m/a");
  assert.equal(t.status, "pending");
  assert.equal(ledger.agentTurn("m/a"), 0);
  ledger.setTaskStatus("t1", "settled");
  assert.equal(ledger.getTask("t1")!.status, "settled");
  assert.equal(ledger.agentTurn("m/a"), 1);
});

test("leaderboard ordered desc", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.ensureEndowed("m/b", model("m/b"));
  ledger.credit("m/b", 500, "x");
  assert.equal(ledger.leaderboard()[0].agent, "m/b");
});

test("stale recovery unfreezes stake and marks task failed", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));   // balance 1000
  ledger.createTask({ id: "t1", role: "r", prompt: "p", difficulty: "easy", odds: 1.5, reward: 10 }, "m/a", 300, 1, "m/a");
  ledger.freeze("m/a", 300, "t1");             // balance 700, frozen 300
  store.raw.prepare(`UPDATE market_tasks SET created_ts = 0 WHERE task_id = 't1'`).run(); // backdate -> stale
  const stale = ledger.staleTasks(1000);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].taskId, "t1");
  ledger.recoverStaleTask("t1");
  assert.equal(ledger.balance("m/a"), 1000);   // stake returned
  assert.equal(ledger.getTask("t1")!.status, "failed");
});

// --- Task 2: per-task freeze isolation ---

test("per-task freeze: two tasks freeze independently, unfreeze one leaves other frozen", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a")); // balance 1000
  ledger.freeze("m/a", 300, "t1");
  ledger.freeze("m/a", 200, "t2");
  assert.equal(ledger.balance("m/a"), 500); // 1000 - 300 - 200
  // unfreeze only t1
  assert.equal(ledger.unfreeze("m/a", "t1"), 300);
  assert.equal(ledger.balance("m/a"), 800); // 500 + 300, t2 still frozen
  // unfreeze t2
  assert.equal(ledger.unfreeze("m/a", "t2"), 200);
  assert.equal(ledger.balance("m/a"), 1000);
});

test("atomic guard: freeze more than balance fails, returns false, balance unchanged, no freeze row", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a")); // balance 1000
  const before = ledger.balance("m/a");
  const ok = ledger.freeze("m/a", 2000, "t-over");
  assert.equal(ok, false); // returns false on atomic guard rejection
  assert.equal(ledger.balance("m/a"), before); // balance unchanged
  // unfreeze should return 0 (no freeze row was created)
  assert.equal(ledger.unfreeze("m/a", "t-over"), 0);
});

test("freeze returns true on success", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a")); // balance 1000
  const ok = ledger.freeze("m/a", 300, "t-success");
  assert.equal(ok, true);
  assert.equal(ledger.balance("m/a"), 700);
});

test("freeze returns true on idempotent duplicate", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a")); // balance 1000
  assert.equal(ledger.freeze("m/a", 300, "t-dup"), true);
  assert.equal(ledger.balance("m/a"), 700);
  assert.equal(ledger.freeze("m/a", 999, "t-dup"), true); // idempotent, same taskId
  assert.equal(ledger.balance("m/a"), 700); // balance unchanged
});

test("duplicate freeze same taskId is idempotent", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a")); // balance 1000
  ledger.freeze("m/a", 300, "t1");
  assert.equal(ledger.balance("m/a"), 700);
  // duplicate freeze same taskId — idempotent, balance unchanged
  ledger.freeze("m/a", 999, "t1"); // different amount, same taskId — ignored
  assert.equal(ledger.balance("m/a"), 700);
  // unfreeze returns the original amount
  assert.equal(ledger.unfreeze("m/a", "t1"), 300);
  assert.equal(ledger.balance("m/a"), 1000);
});

test("unfreeze missing task returns 0 (idempotent)", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  assert.equal(ledger.unfreeze("m/a", "no-such-task"), 0);
  assert.equal(ledger.balance("m/a"), 1000); // balance unchanged
});

test("duplicate unfreeze same taskId is idempotent", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.freeze("m/a", 300, "t1");
  assert.equal(ledger.unfreeze("m/a", "t1"), 300);
  // second unfreeze returns 0
  assert.equal(ledger.unfreeze("m/a", "t1"), 0);
  assert.equal(ledger.balance("m/a"), 1000); // unchanged from first unfreeze
});

test("frozen column never goes below zero after unfreeze", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.freeze("m/a", 300, "t1");
  // directly corrupt frozen column via raw SQL to simulate edge case
  store.raw.prepare(`UPDATE credits SET frozen = 10 WHERE agent = 'm/a'`).run();
  // unfreeze should clamp — returns 300 (the arena_freezes amount), frozen becomes max(10-300, 0) = 0
  assert.equal(ledger.unfreeze("m/a", "t1"), 300);
  const frozen = (store.raw.prepare(`SELECT frozen FROM credits WHERE agent = 'm/a'`).get() as { frozen: number });
  assert.equal(frozen.frozen, 0);
});
