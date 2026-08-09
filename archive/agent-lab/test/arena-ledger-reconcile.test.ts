import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };

function mk() {
  const store = new SqliteStore(":memory:");
  const ledger = new SqliteLedger(store.raw, fixedEndow);
  return { store, ledger };
}

// --- reconcileFrozenResidue ---

test("reconcileFrozenResidue returns empty when no residue", () => {
  const { ledger } = mk();
  assert.deepEqual(ledger.reconcileFrozenResidue(), []);
});

test("reconcileFrozenResidue returns frozen to balance and zeros frozen column", () => {
  const { store, ledger } = mk();
  // Simulate residue: frozen > 0, balance was already debited, no freeze row
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/a', 500, 300, 1000)`).run();
  assert.equal(ledger.balance("m/a"), 500);

  const result = ledger.reconcileFrozenResidue();
  assert.equal(result.length, 1);
  assert.equal(result[0].agent, "m/a");
  assert.equal(result[0].frozenBefore, 300);

  // Balance returned: 500 + 300 = 800
  assert.equal(ledger.balance("m/a"), 800);

  // Frozen zeroed
  const frozen = (store.raw.prepare(`SELECT frozen FROM credits WHERE agent = 'm/a'`).get() as { frozen: number });
  assert.equal(frozen.frozen, 0);
});

test("reconcileFrozenResidue creates compensating credit_tx with delta=0", () => {
  const { store, ledger } = mk();
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/a', 500, 300, 1000)`).run();

  ledger.reconcileFrozenResidue();

  const txs = ledger.history("m/a", 10);
  const reconcileTx = txs.find((t) => t.reason?.startsWith("migration-reconcile"));
  assert.ok(reconcileTx, "should create migration-reconcile credit_tx");
  assert.equal(reconcileTx!.delta, 0);
  assert.ok(reconcileTx!.reason!.includes("frozenBefore=300"), `expected frozenBefore in reason, got: ${reconcileTx!.reason}`);
});

test("reconcileFrozenResidue is idempotent", () => {
  const { store, ledger } = mk();
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/a', 500, 300, 1000)`).run();

  const first = ledger.reconcileFrozenResidue();
  assert.equal(first.length, 1);

  const second = ledger.reconcileFrozenResidue();
  assert.deepEqual(second, []);
});

test("reconcileFrozenResidue handles multiple residue agents", () => {
  const { store, ledger } = mk();
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/a', 500, 300, 1000)`).run();
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/b', 200, 150, 1000)`).run();

  const result = ledger.reconcileFrozenResidue();
  assert.equal(result.length, 2);
  const agents = result.map((r) => r.agent).sort();
  assert.deepEqual(agents, ["m/a", "m/b"]);

  assert.equal(ledger.balance("m/a"), 800);
  assert.equal(ledger.balance("m/b"), 350);
});

test("reconcileFrozenResidue does not affect agents with active freeze rows", () => {
  const { store, ledger } = mk();
  // m/a: frozen > 0 AND has a freeze row (normal state, NOT residue)
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/a', 700, 300, 1000)`).run();
  store.raw.prepare(`INSERT INTO arena_freezes (task_id, agent, amount, created_ts) VALUES ('t1', 'm/a', 300, 1000)`).run();

  // m/b: frozen > 0 but NO freeze row (residue)
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/b', 500, 200, 1000)`).run();

  const result = ledger.reconcileFrozenResidue();
  assert.equal(result.length, 1);
  assert.equal(result[0].agent, "m/b");

  // m/a untouched
  assert.equal(ledger.balance("m/a"), 700);
  const frozenA = (store.raw.prepare(`SELECT frozen FROM credits WHERE agent = 'm/a'`).get() as { frozen: number });
  assert.equal(frozenA.frozen, 300);

  // m/b reconciled
  assert.equal(ledger.balance("m/b"), 700);
  const frozenB = (store.raw.prepare(`SELECT frozen FROM credits WHERE agent = 'm/b'`).get() as { frozen: number });
  assert.equal(frozenB.frozen, 0);
});

test("reconcileFrozenResidue only targets frozen>0 agents", () => {
  const { store, ledger } = mk();
  // Agent with frozen=0 (clean)
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/a', 1000, 0, 1000)`).run();
  // Agent with frozen>0 but has freeze row (not residue)
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/b', 700, 300, 1000)`).run();
  store.raw.prepare(`INSERT INTO arena_freezes (task_id, agent, amount, created_ts) VALUES ('t1', 'm/b', 300, 1000)`).run();

  const result = ledger.reconcileFrozenResidue();
  assert.deepEqual(result, []);
  assert.equal(ledger.balance("m/a"), 1000);
  assert.equal(ledger.balance("m/b"), 700);
});

// --- crash-atomic freeze ---

test("freeze with insufficient balance leaves no partial state (crash-atomic)", () => {
  const { store, ledger } = mk();
  store.raw.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES ('m/a', 100, 0, 1000)`).run();

  const ok = ledger.freeze("m/a", 200, "t-fail");
  assert.equal(ok, false);

  // Balance unchanged
  assert.equal(ledger.balance("m/a"), 100);

  // No freeze row (INSERT was rolled back by ROLLBACK)
  const freezeRow = store.raw.prepare(`SELECT * FROM arena_freezes WHERE task_id = 't-fail'`).get();
  assert.equal(freezeRow, undefined);

  // Frozen column still zero
  const frozen = (store.raw.prepare(`SELECT frozen FROM credits WHERE agent = 'm/a'`).get() as { frozen: number });
  assert.equal(frozen.frozen, 0);
});

test("freeze transaction succeeds atomically: both INSERT and UPDATE committed", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("m/a", { id: "m/a", provider: "p", name: "n", accessRoute: "free" });

  const ok = ledger.freeze("m/a", 300, "t-success");
  assert.equal(ok, true);
  assert.equal(ledger.balance("m/a"), 700);

  // Freeze row exists
  const freezeRow = store.raw.prepare(`SELECT * FROM arena_freezes WHERE task_id = 't-success'`).get() as { amount: number };
  assert.ok(freezeRow, "freeze row should exist");
  assert.equal(freezeRow.amount, 300);

  // Frozen column updated
  const frozen = (store.raw.prepare(`SELECT frozen FROM credits WHERE agent = 'm/a'`).get() as { frozen: number });
  assert.equal(frozen.frozen, 300);
});
