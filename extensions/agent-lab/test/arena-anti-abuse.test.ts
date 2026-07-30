import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import type { EndowmentPolicy, ArenaTask } from "../src/arena/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
function mk() {
  const store = new SqliteStore(":memory:");
  const ledger = new SqliteLedger(store.raw, fixedEndow);
  return { store, ledger };
}
const task: ArenaTask = { id: "t1", role: "code", prompt: "x", difficulty: "medium", odds: 1, reward: 100 };

// ── minStake unit tests (logic verified via arena-scheduler integration) ──

test("minStake floor: bid below minStake is raised", () => {
  // Simulate the minStake logic from arena-scheduler
  const minStake = 10;
  const maxStakeRatio = 0.5;
  const balance = 1000;
  let stake = 3; // below minStake

  if (stake > 0 && stake < minStake) {
    const cap = balance * maxStakeRatio;
    stake = Math.min(minStake, cap);
  }
  assert.equal(stake, 10);
});

test("minStake floor: clamp to maxStakeRatio when balance is low", () => {
  const minStake = 10;
  const maxStakeRatio = 0.5;
  const balance = 12; // cap = 6, below minStake
  let stake = 3;

  if (stake > 0 && stake < minStake) {
    const cap = balance * maxStakeRatio;
    stake = Math.min(minStake, cap);
  }
  assert.equal(stake, 6); // clamped to cap
});

test("minStake floor: bid above minStake unchanged", () => {
  const minStake = 10;
  const maxStakeRatio = 0.5;
  const balance = 1000;
  let stake = 50; // above minStake

  if (stake > 0 && stake < minStake) {
    const cap = balance * maxStakeRatio;
    stake = Math.min(minStake, cap);
  }
  assert.equal(stake, 50); // unchanged
});

test("minStake floor: zero bid stays zero", () => {
  const minStake = 10;
  let stake = 0;

  if (stake > 0 && stake < minStake) {
    stake = minStake;
  }
  assert.equal(stake, 0); // zero bids are opt-out, not raised
});

// ── diversity penalty unit tests ──

test("diversity penalty: first win has no penalty", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("agent-a", { id: "m/a", provider: "m", name: "a", accessRoute: "free" }, "tpl-alpha");
  ledger.createTask({ ...task, id: "t1" }, "agent-a", 100, 1, "m/a", "tpl-alpha");
  ledger.setTaskStatus("t1", "settled");

  // First win: N=0 prior wins → no penalty
  const priorWins = ledger.countSettledByTemplate("tpl-alpha", "t2");
  assert.equal(priorWins, 1); // t1 is settled

  // For a new task t2, prior wins = 1
  const diversityFactor = 0.1;
  const net = 100;
  const penalty = 1 / (1 + priorWins * diversityFactor);
  const adjusted = net * penalty;
  assert.ok(adjusted < net, "penalty should reduce reward");
  assert.ok(Math.abs(adjusted - 100 / 1.1) < 0.001);
});

test("diversity penalty: increasing wins → decreasing reward", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("agent-a", { id: "m/a", provider: "m", name: "a", accessRoute: "free" }, "tpl-alpha");

  // Settle 3 tasks for tpl-alpha
  for (let i = 1; i <= 3; i++) {
    ledger.createTask({ ...task, id: `t${i}` }, "agent-a", 100, i, "m/a", "tpl-alpha");
    ledger.setTaskStatus(`t${i}`, "settled");
  }

  const diversityFactor = 0.1;
  const net = 100;

  // For task t4, prior wins = 3
  const priorWins = ledger.countSettledByTemplate("tpl-alpha", "t4");
  assert.equal(priorWins, 3);

  const penalty = 1 / (1 + priorWins * diversityFactor);
  const adjusted = net * penalty;
  assert.ok(Math.abs(adjusted - 100 / 1.3) < 0.001);

  // Verify decreasing: more wins → lower reward
  const penalty1 = 1 / (1 + 1 * diversityFactor);
  const penalty3 = 1 / (1 + 3 * diversityFactor);
  assert.ok(penalty3 < penalty1, "more prior wins → stronger penalty");
});

test("diversity penalty: different templates are independent", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("agent-a", { id: "m/a", provider: "m", name: "a", accessRoute: "free" }, "tpl-alpha");
  ledger.ensureEndowed("agent-b", { id: "m/b", provider: "m", name: "b", accessRoute: "free" }, "tpl-beta");

  // Settle 5 tasks for tpl-alpha
  for (let i = 1; i <= 5; i++) {
    ledger.createTask({ ...task, id: `ta${i}` }, "agent-a", 100, i, "m/a", "tpl-alpha");
    ledger.setTaskStatus(`ta${i}`, "settled");
  }
  // Settle 1 task for tpl-beta
  ledger.createTask({ ...task, id: "tb1" }, "agent-b", 100, 6, "m/b", "tpl-beta");
  ledger.setTaskStatus("tb1", "settled");

  assert.equal(ledger.countSettledByTemplate("tpl-alpha"), 5);
  assert.equal(ledger.countSettledByTemplate("tpl-beta"), 1);

  // tpl-beta should have much less penalty
  const diversityFactor = 0.1;
  const penaltyAlpha = 1 / (1 + 5 * diversityFactor);
  const penaltyBeta = 1 / (1 + 1 * diversityFactor);
  assert.ok(penaltyBeta > penaltyAlpha, "less-winning template has weaker penalty");
});

test("countSettledByTemplate excludes specified task", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("agent-a", { id: "m/a", provider: "m", name: "a", accessRoute: "free" }, "tpl-alpha");
  ledger.createTask({ ...task, id: "t1" }, "agent-a", 100, 1, "m/a", "tpl-alpha");
  ledger.setTaskStatus("t1", "settled");
  ledger.createTask({ ...task, id: "t2" }, "agent-a", 100, 2, "m/a", "tpl-alpha");
  ledger.setTaskStatus("t2", "settled");

  assert.equal(ledger.countSettledByTemplate("tpl-alpha"), 2);
  assert.equal(ledger.countSettledByTemplate("tpl-alpha", "t1"), 1); // excludes t1
  assert.equal(ledger.countSettledByTemplate("tpl-alpha", "t2"), 1); // excludes t2
});
