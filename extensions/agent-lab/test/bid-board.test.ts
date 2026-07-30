import { test } from "node:test";
import assert from "node:assert/strict";
import { BidBoard, getBidBoard } from "../src/arena/bid-board.ts";

test("place requires openToken first (unknown token rejected)", () => {
  const b = new BidBoard();
  const res = b.place("nope", 50, "x");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unknown-token");
  assert.equal(b.collect("nope"), undefined);
});

test("openToken + place + collect round-trip", () => {
  const b = new BidBoard();
  b.openToken("t1", "agent-a");
  const res = b.place("t1", 42, "good odds");
  assert.equal(res.ok, true);
  assert.deepEqual(b.collect("t1"), { agentId: "agent-a", stake: 42, reasoning: "good odds" });
});

test("second place on same token rejected (first-wins)", () => {
  const b = new BidBoard();
  b.openToken("t1", "agent-a");
  assert.equal(b.place("t1", 10, "first").ok, true);
  const second = b.place("t1", 99, "second");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already-bid");
  assert.equal(b.collect("t1")?.stake, 10);
});

test("close removes token and bid", () => {
  const b = new BidBoard();
  b.openToken("t1", "agent-a");
  b.place("t1", 10, "x");
  b.close("t1");
  assert.equal(b.collect("t1"), undefined);
  assert.equal(b.place("t1", 5, "y").ok, false);
});

test("getBidBoard returns a shared singleton across calls", () => {
  const a = getBidBoard();
  const b = getBidBoard();
  assert.equal(a, b);
});
