import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHumanEvalJsonl } from "../src/bench/humaneval.ts";

const SAMPLE = [
  JSON.stringify({ task_id: "HumanEval/0", prompt: "def f():\n  \"\"\"d\"\"\"\n", entry_point: "f", canonical_solution: "  return 1\n", test: "def check(c):\n  assert c()==1\n" }),
  JSON.stringify({ task_id: "HumanEval/1", prompt: "def g():\n", entry_point: "g", canonical_solution: "  return 2\n", test: "def check(c):\n  assert c()==2\n" }),
].join("\n");

test("parseHumanEvalJsonl 解析多行", () => {
  const tasks = parseHumanEvalJsonl(SAMPLE);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].task_id, "HumanEval/0");
  assert.equal(tasks[0].entry_point, "f");
  assert.ok(tasks[0].test.includes("def check"));
});

test("parseHumanEvalJsonl 跳过空行/坏行", () => {
  const tasks = parseHumanEvalJsonl(SAMPLE + "\n\nnot-json\n");
  assert.equal(tasks.length, 2);
});
