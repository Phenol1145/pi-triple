import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubagentRun } from "../src/telemetry/parse.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("parses a full subagent result", () => {
  const rec = parseSubagentRun({
    input: { agent: "reviewer" },
    result: { model: "deepseek/deepseek-v3.2", acceptance: { status: "verified" }, usage: { input: 1000, output: 500, cost: { total: 0.012 } }, turns: 4 },
  }, DEFAULT_CONFIG, 12345);
  assert.ok(rec);
  assert.equal(rec!.role, "reviewer");
  assert.equal(rec!.model, "deepseek/deepseek-v3.2");
  assert.equal(rec!.acceptance, "verified");
  assert.equal(rec!.tokensIn, 1000);
  assert.equal(rec!.tokensOut, 500);
  assert.ok(Math.abs(rec!.cost! - 0.012) < 1e-9);
  assert.equal(rec!.turns, 4);
  assert.ok(Math.abs(rec!.completion - 0.9) < 1e-9);
  assert.equal(rec!.source, "auto");
});

test("skips when no agent role", () => {
  assert.equal(parseSubagentRun({ input: {}, result: {} }, DEFAULT_CONFIG), undefined);
});

test("interrupted result lowers completion", () => {
  const rec = parseSubagentRun({ input: { agent: "worker" }, result: { acceptance: "checked", state: "stopped" } }, DEFAULT_CONFIG)!;
  assert.equal(rec.interrupted, 1);
  assert.ok(Math.abs(rec.completion - 0.4) < 1e-9);
});

test("acceptance as plain string", () => {
  const rec = parseSubagentRun({ input: { agent: "scout" }, result: { acceptance: "attested" } }, DEFAULT_CONFIG)!;
  assert.equal(rec.acceptance, "attested");
  assert.ok(Math.abs(rec.completion - 0.5) < 1e-9);
});
