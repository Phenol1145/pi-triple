import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderBenchReport, writeBenchJson, type BenchReport } from "../src/bench/report.ts";

const REPORT: BenchReport = {
  runId: "bench-x",
  results: [
    { task_id: "HumanEval/0", model: "deepseek/deepseek-chat", stake: 100, passed: true, settled: true, latencyMs: 300 },
    { task_id: "HumanEval/1", model: "openai/gpt-4o", stake: 50, passed: false, settled: true, latencyMs: 200, error: "assert" },
    { task_id: "HumanEval/2", status: "routing_fallback", detail: "abstained" },
  ],
  modelStats: [
    { model: "deepseek/deepseek-chat", wins: 1, passes: 1, passRate: 1, totalStake: 100 },
    { model: "openai/gpt-4o", wins: 1, passes: 0, passRate: 0, totalStake: 50 },
  ],
  balanceDeltas: [
    { model: "deepseek/deepseek-chat", before: 1000, after: 1200, settlement: 200, tax: 0 },
    { model: "openai/gpt-4o", before: 1000, after: 895, settlement: -100, tax: -5 },
  ],
};

test("renderBenchReport 含逐题 + 模型统计 + 余额（结算与税分列）", () => {
  const out = renderBenchReport(REPORT);
  assert.ok(out.includes("HumanEval/0"));
  assert.ok(out.includes("deepseek/deepseek-chat"));
  assert.ok(out.includes("pass"));
  assert.ok(out.includes("routing_fallback"));
  assert.ok(out.includes("settlement") && out.includes("tax"), "余额变化须分列结算与税");
});

test("writeBenchJson 落盘且可读回", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-rep-"));
  try {
    const file = writeBenchJson(dir, REPORT);
    const back = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(back.runId, "bench-x");
    assert.equal(back.results.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
