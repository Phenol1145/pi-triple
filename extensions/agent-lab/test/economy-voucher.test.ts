import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteVoucher, VOUCHER_PHYSICAL_ANCHOR } from "../src/economy/voucher-port.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";
import type { ModelInfo } from "../src/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
const RATES = { llm: 10, time: 5, compute: 2 };
function model(id: string): ModelInfo { return { id, provider: id.split("/")[0], name: id, accessRoute: "free" }; }
function mk() {
  const store = new SqliteStore(":memory:");
  const ledger = new SqliteLedger(store.raw, fixedEndow);
  return { store, ledger };
}

test("VOUCHER_PHYSICAL_ANCHOR documents physical anchors", () => {
  assert.deepEqual(VOUCHER_PHYSICAL_ANCHOR, { llm: 1_000_000, time: 3600, compute: 1 });
});

test("① buy: vouchers credited, credits debited, revenue pooled (default central-pool)", () => {
  const { store, ledger } = mk();
  const v = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES } });
  ledger.ensureEndowed("a", model("m/a"));
  v.buy("a", "llm", 5);
  assert.equal(v.balance("a", "llm"), 5);
  assert.equal(ledger.balance("a"), 1000 - 50);
  assert.equal(ledger.balance("central-pool"), 50);
  // batch recorded at historical rate
  const batches = store.raw.prepare(
    `SELECT units, credit_per_unit FROM voucher_batches WHERE agent_id = ? AND kind = ?`,
  ).all("a", "llm") as Array<{ units: number; credit_per_unit: number }>;
  assert.equal(batches.length, 1);
  assert.equal(batches[0].units, 5);
  assert.equal(batches[0].credit_per_unit, 10);
});

test("①b buy: custom poolId routes revenue to that pool", () => {
  const { store, ledger } = mk();
  const v = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES }, poolId: "my-pool" });
  ledger.ensureEndowed("a", model("m/a"));
  v.buy("a", "time", 10);
  assert.equal(v.balance("a", "time"), 10);
  assert.equal(ledger.balance("my-pool"), 50);
  assert.equal(ledger.balance("central-pool"), 0);
});

test("② buy is atomic: ledger.debit throw leaves voucher state unchanged", () => {
  const { store, ledger } = mk();
  ledger.ensureEndowed("a", model("m/a")); // credit balance 1000
  const failing = {
    debit(): void { throw new Error("debit failed"); },
    credit(): void { /* no-op */ },
  };
  const v = new SqliteVoucher({ db: store.raw, ledger: failing, rates: { creditPerUnit: RATES } });
  assert.throws(() => v.buy("a", "llm", 5), /debit failed/);
  assert.equal(v.balance("a", "llm"), 0);
  const n = store.raw.prepare(`SELECT COUNT(*) AS n FROM voucher_batches WHERE agent_id = ?`).get("a") as { n: number };
  assert.equal(n.n, 0);
  assert.equal(ledger.balance("a"), 1000); // no credit change
});

test("③ buy: insufficient credit throws and does not mint vouchers", () => {
  const { store, ledger } = mk();
  const v = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES } });
  ledger.ensureEndowed("a", model("m/a")); // 1000 credits; 500 llm units cost 5000
  assert.throws(() => v.buy("a", "llm", 500), /insufficient/i);
  assert.equal(v.balance("a", "llm"), 0);
  const n = store.raw.prepare(`SELECT COUNT(*) AS n FROM voucher_batches WHERE agent_id = ?`).get("a") as { n: number };
  assert.equal(n.n, 0);
  assert.equal(ledger.balance("a"), 1000); // untouched
});

test("④ burn: deducts balance, records burn with FIFO creditCost", () => {
  const { store, ledger } = mk();
  const v1 = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: { ...RATES, llm: 10 } } });
  ledger.ensureEndowed("a", model("m/a"));
  v1.buy("a", "llm", 5); // batch1: 5 @ 10/unit
  const v2 = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: { ...RATES, llm: 20 } } });
  v2.buy("a", "llm", 5); // batch2: 5 @ 20/unit
  assert.equal(v2.balance("a", "llm"), 10);

  const v3 = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES } });
  v3.burn("a", "llm", 6, { traceId: "t1", transitionSeq: 1 });
  assert.equal(v3.balance("a", "llm"), 4);
  const burns = v3.burnHistory("a", "llm");
  assert.equal(burns.length, 1);
  assert.equal(burns[0].kind, "llm");
  assert.equal(burns[0].units, 6);
  // FIFO: 5 from batch1 @10 + 1 from batch2 @20 = 70
  assert.equal(burns[0].creditCost, 5 * 10 + 1 * 20);
  assert.deepEqual(burns[0].cause, { traceId: "t1", transitionSeq: 1 });
  assert.ok(typeof burns[0].ts === "number");
  // batch residues (insertion order): batch1 drained, batch2 partially consumed
  const rows = store.raw.prepare(
    `SELECT units FROM voucher_batches WHERE agent_id = ? AND kind = ? ORDER BY id ASC`,
  ).all("a", "llm") as Array<{ units: number }>;
  assert.deepEqual(rows.map((r) => r.units), [0, 4]);
});

test("⑤ burn: insufficient voucher balance throws, state unchanged", () => {
  const { store, ledger } = mk();
  const v = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES } });
  ledger.ensureEndowed("a", model("m/a"));
  v.buy("a", "llm", 3);
  assert.throws(() => v.burn("a", "llm", 5, { traceId: "t1", transitionSeq: 1 }), /insufficient/i);
  assert.equal(v.balance("a", "llm"), 3);
  assert.equal(v.burnHistory("a", "llm").length, 0);
  const n = store.raw.prepare(
    `SELECT COUNT(*) AS n FROM voucher_batches WHERE agent_id = ? AND kind = ? AND units = 0`,
  ).get("a", "llm") as { n: number };
  assert.equal(n.n, 0); // no batch drained
});

test("⑥ buy rejects non-positive units and leaves state unchanged", () => {
  const { store, ledger } = mk();
  const v = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES } });
  ledger.ensureEndowed("a", model("m/a"));
  assert.throws(() => v.buy("a", "llm", -5), /units must be positive/);
  assert.throws(() => v.buy("a", "llm", 0), /units must be positive/);
  assert.equal(v.balance("a", "llm"), 0);
  assert.equal(ledger.balance("a"), 1000);
  assert.equal(ledger.balance("central-pool"), 0);
  const n = store.raw.prepare(`SELECT COUNT(*) AS n FROM voucher_batches WHERE agent_id = ?`).get("a") as { n: number };
  assert.equal(n.n, 0);
});

test("⑥b burn rejects negative units and leaves state unchanged", () => {
  const { store, ledger } = mk();
  const v = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES } });
  ledger.ensureEndowed("a", model("m/a"));
  v.buy("a", "llm", 5);
  assert.throws(() => v.burn("a", "llm", -1), /units must be positive/);
  assert.equal(v.balance("a", "llm"), 5);
  assert.equal(v.burnHistory("a", "llm").length, 0);
  const n = store.raw.prepare(`SELECT COUNT(*) AS n FROM voucher_burns WHERE agent_id = ?`).get("a") as { n: number };
  assert.equal(n.n, 0);
});

test("⑥ burnHistory: traceId precise filter and sinceTs", () => {
  const { store, ledger } = mk();
  const v = new SqliteVoucher({ db: store.raw, ledger, rates: { creditPerUnit: RATES } });
  ledger.ensureEndowed("a", model("m/a"));
  v.buy("a", "llm", 10);
  v.burn("a", "llm", 2, { traceId: "t-1", transitionSeq: 1 });
  v.burn("a", "llm", 3, { traceId: "t-10", transitionSeq: 2 });
  v.burn("a", "llm", 1, { periodic: "memory-storage" });

  // Force deterministic, strictly increasing ts for filter assertions.
  const ids = store.raw.prepare(`SELECT id FROM voucher_burns ORDER BY ts ASC, id ASC`).all() as Array<{ id: number }>;
  for (const [i, row] of ids.entries()) {
    store.raw.prepare(`UPDATE voucher_burns SET ts = ? WHERE id = ?`).run(1000 * (i + 1), row.id);
  }

  const all = v.burnHistory("a", "llm");
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.ts), [1000, 2000, 3000]); // chronological
  assert.deepEqual(all[2].cause, { periodic: "memory-storage" });

  // Precise traceId filter: "t-1" must NOT match "t-10"
  const t1 = v.burnHistory("a", "llm", { traceId: "t-1" });
  assert.equal(t1.length, 1);
  assert.deepEqual(t1[0].cause, { traceId: "t-1", transitionSeq: 1 });

  // sinceTs inclusive
  const since = v.burnHistory("a", "llm", { sinceTs: 2000 });
  assert.deepEqual(since.map((r) => r.ts), [2000, 3000]);

  // combined filter
  const comb = v.burnHistory("a", "llm", { traceId: "t-10", sinceTs: 2000 });
  assert.equal(comb.length, 1);
  assert.deepEqual(comb[0].cause, { traceId: "t-10", transitionSeq: 2 });

  // kind isolation
  assert.equal(v.burnHistory("a", "time").length, 0);
});
