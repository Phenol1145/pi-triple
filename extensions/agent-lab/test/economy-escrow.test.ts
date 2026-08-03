// 双向托管测试（plan Task 9 / spec §4.3/§4.4）——escrow 两阶段 + bid 对称冻结，数值钉死。
//
// 接线约定：本模块函数要求 ledger 为共享同一 DatabaseSync 的 SqliteLedger 实例
//（Task 1 已交付 freeze/unfreeze 事务包裹，本任务确认 (agentId, taskId) 复合键）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";
import {
  escrowMax,
  escrowActual,
  freezeEscrowMax,
  adjustEscrow,
  freezeBid,
  releaseBid,
  type EscrowParams,
} from "../src/economy/escrow.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };

function freshLedger() {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, fixedEndow);
  return { db, ledger };
}

const baseParams: EscrowParams = {
  maxStake: 20,
  odds: 3,
  reviewerCount: 5,
  stakeR: 10,
  oddsR: 2,
  voucherAllowance: 6,
};

// ── ① escrowMax/escrowActual 数值钉死 ─────────────────────────────
test("① escrowMax / escrowActual 数值钉死", () => {
  // maxStake×(O−1) + N×stake_r×(O_r−1) + voucherAllowance
  // = 20×2 + 5×10×1 + 6 = 40 + 50 + 6 = 96
  assert.equal(escrowMax(baseParams), 96);
  // actual stake=15 → 15×2 + 50 + 6 = 30 + 50 + 6 = 86
  assert.equal(escrowActual(baseParams, 15), 86);
});

// ── ② freezeEscrowMax 余额不足抛错 ────────────────────────────────
test("② freezeEscrowMax：余额不足时抛错，余额与冻结列不变", () => {
  const { ledger } = freshLedger();
  ledger.credit("pub", 50, "seed");
  assert.equal(ledger.balance("pub"), 50);
  assert.throws(
    () => freezeEscrowMax(ledger, "pub", "t1", baseParams),
    /escrow|balance|insufficient/i,
  );
  assert.equal(ledger.balance("pub"), 50);
  const frozen = (ledger as any).db
    .prepare("SELECT frozen FROM credits WHERE agent = 'pub'")
    .get() as { frozen: number } | undefined;
  assert.equal(frozen?.frozen ?? 0, 0);
});

// ── ③ adjustEscrow 解冻差额 ───────────────────────────────────────
test("③ adjustEscrow：max 96 → actual 86，解冻差额 10，仍保留 86 冻结", () => {
  const { ledger } = freshLedger();
  ledger.credit("pub", 200, "seed");
  freezeEscrowMax(ledger, "pub", "t1", baseParams);
  assert.equal(ledger.balance("pub"), 200 - 96);

  adjustEscrow(ledger, "pub", "t1", baseParams, 15);
  assert.equal(ledger.balance("pub"), 200 - 86);

  const frozen = (ledger as any).db
    .prepare("SELECT frozen FROM credits WHERE agent = 'pub'")
    .get() as { frozen: number };
  assert.equal(frozen.frozen, 86);

  const row = (ledger as any).db
    .prepare("SELECT amount FROM arena_freezes WHERE task_id = 't1' AND agent = 'pub'")
    .get() as { amount: number } | undefined;
  assert.equal(row?.amount, 86);
});

// ── ④ freezeBid 冻结 stake×(O−1) ───────────────────────────────────
test("④ freezeBid：stake=15, odds=3 → 冻结 30，且支持同 task 多 bidder（复合键）", () => {
  const { ledger } = freshLedger();
  ledger.credit("bid-a", 200, "seed");
  ledger.credit("bid-b", 200, "seed");

  freezeBid(ledger, "bid-a", "t1", 15, 3);
  freezeBid(ledger, "bid-b", "t1", 15, 3);

  assert.equal(ledger.balance("bid-a"), 170);
  assert.equal(ledger.balance("bid-b"), 170);

  const rows = (ledger as any).db
    .prepare("SELECT agent, amount FROM arena_freezes WHERE task_id = 't1' ORDER BY agent")
    .all() as Array<{ agent: string; amount: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agent, "bid-a");
  assert.equal(rows[0].amount, 30);
  assert.equal(rows[1].agent, "bid-b");
  assert.equal(rows[1].amount, 30);
});

// ── ⑤ freezeBid 余额不足抛错 ──────────────────────────────────────
test("⑤ freezeBid：余额不足时抛错，余额不变", () => {
  const { ledger } = freshLedger();
  ledger.credit("bid", 20, "seed");
  assert.throws(
    () => freezeBid(ledger, "bid", "t1", 15, 3),
    /bid|balance|insufficient/i,
  );
  assert.equal(ledger.balance("bid"), 20);
});

// ── ⑥ releaseBid 解冻 ─────────────────────────────────────────────
test("⑥ releaseBid：未中标 bidder 解冻，其他 bidder 仍冻结", () => {
  const { ledger } = freshLedger();
  ledger.credit("bid-a", 200, "seed");
  ledger.credit("bid-b", 200, "seed");
  freezeBid(ledger, "bid-a", "t1", 15, 3);
  freezeBid(ledger, "bid-b", "t1", 15, 3);

  releaseBid(ledger, "bid-a", "t1");

  assert.equal(ledger.balance("bid-a"), 200);
  assert.equal(ledger.balance("bid-b"), 170);

  const rows = (ledger as any).db
    .prepare("SELECT agent FROM arena_freezes WHERE task_id = 't1' ORDER BY agent")
    .all() as Array<{ agent: string }>;
  assert.deepEqual(rows.map((r) => r.agent), ["bid-b"]);
});

// ── ⑦ escrow_max ≥ escrow_actual 恒成立；stake > maxStake 抛错 ─────
test("⑦ adjustEscrow：actualStake > maxStake 抛错；stake ≤ maxStake 恒有 escrow_max ≥ escrow_actual", () => {
  assert.equal(escrowMax(baseParams), 96);
  assert.equal(escrowActual(baseParams, 20), 96);
  assert.ok(escrowMax(baseParams) >= escrowActual(baseParams, 20));
  assert.ok(escrowMax(baseParams) >= escrowActual(baseParams, 15));
  assert.ok(escrowMax(baseParams) >= escrowActual(baseParams, 0));

  const { ledger } = freshLedger();
  ledger.credit("pub", 200, "seed");
  freezeEscrowMax(ledger, "pub", "t1", baseParams);
  assert.throws(
    () => adjustEscrow(ledger, "pub", "t1", baseParams, 21),
    /maxStake|stake|exceed/i,
  );
  // 抛错后冻结额不变
  assert.equal(ledger.balance("pub"), 200 - 96);
});
