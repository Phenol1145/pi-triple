import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteLedgerAdapter } from "../src/assembly/ledger-port.ts";
import { tmpDir, tmpDbFile } from "./test-utils/fixtures.ts";

function fresh() {
  const { dir } = tmpDir("asm-ledger-");
  const db = tmpDbFile(dir);
  const ledger = new SqliteLedger(db);
  return { ledger: new SqliteLedgerAdapter(ledger), db, dir };
}

test("open creates account with flat K and returns created", async () => {
  const { ledger, db, dir } = await fresh();
  assert.deepEqual(ledger.open("a1", 100), { created: true });
  assert.equal(ledger.balance("a1"), 100);
  assert.deepEqual(ledger.open("a1", 100), { created: false });  // 已存在 → 续跑信号
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("debit throws on insufficient funds", async () => {
  const { ledger, db, dir } = await fresh();
  ledger.open("a1", 10);
  assert.throws(() => ledger.debit("a1", 20, "test"), /insufficient funds/);
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("removeAccount deletes account (idempotent)", async () => {
  const { ledger, db, dir } = await fresh();
  ledger.open("a1", 10);
  (ledger as { impl: SqliteLedger }).impl.removeAccount("a1");
  assert.equal(ledger.balance("a1"), 0);
  (ledger as { impl: SqliteLedger }).impl.removeAccount("a1");  // no-op
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test("freeze maps reason to taskId key and throws on insufficient", async () => {
  const { ledger, db, dir } = await fresh();
  ledger.open("a1", 10);
  ledger.freeze("a1", 5, "bid-1");
  ledger.unfreeze("a1", "bid-1");
  assert.throws(() => ledger.freeze("a1", 20, "bid-2"), /insufficient/);
  db.close(); rmSync(dir, { recursive: true, force: true });
});
