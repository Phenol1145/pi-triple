import { test } from "node:test";
import assert from "node:assert/strict";
import { TopBalanceSelector, RandomSelector } from "../src/arena/policies.ts";
import type { AgentState } from "../src/arena/types.ts";
import type { ModelInfo } from "../src/types.ts";

function st(agent: string, balance: number): AgentState {
  const model: ModelInfo = { id: agent, provider: agent.split("/")[0], name: agent, accessRoute: "free" };
  return { agent, model, balance };
}
const candidates = [st("m/a", 100), st("m/b", 500), st("m/c", 300), st("m/d", 200)];

test("TopBalanceSelector picks top N by balance desc", () => {
  const sel = new TopBalanceSelector().select(candidates, 2);
  assert.deepEqual(sel.map((s) => s.agent), ["m/b", "m/c"]);
});

test("TopBalanceSelector N > length returns all", () => {
  const sel = new TopBalanceSelector().select(candidates, 10);
  assert.equal(sel.length, 4);
});

test("RandomSelector returns exactly N distinct candidates", () => {
  const sel = new RandomSelector().select(candidates, 3);
  assert.equal(sel.length, 3);
  assert.equal(new Set(sel.map((s) => s.agent)).size, 3);
  for (const s of sel) assert.ok(candidates.some((c) => c.agent === s.agent));
});

test("selectors with N=0 return empty", () => {
  assert.equal(new TopBalanceSelector().select(candidates, 0).length, 0);
  assert.equal(new RandomSelector().select(candidates, 0).length, 0);
});
