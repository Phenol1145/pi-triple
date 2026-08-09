// test/bench-judge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePython, buildJudgeScript } from "../src/bench/judge.ts";

// 真实 HumanEval/0 数据（k3 BLOCKER-3 实测用）
const HE0_PROMPT = "from typing import List\n\n\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n    \"\"\" Check if in given list of numbers, are any two numbers closer to each other than given threshold.\n    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n    \"\"\"\n";
const HE0_ENTRY = "has_close_elements";
const HE0_TEST = "def check(candidate):\n    assert candidate([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.3) == True\n    assert candidate([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.05) == False\n";
const HE0_CANON = "    for idx, elem in enumerate(numbers):\n        for idx2, elem2 in enumerate(numbers):\n            if idx != idx2:\n                distance = abs(elem - elem2)\n                if distance < threshold:\n                    return True\n    return False\n";

test("buildJudgeScript 追加 check(entry_point) 调用（BLOCKER-3）", () => {
  const script = buildJudgeScript(HE0_PROMPT, HE0_CANON, HE0_TEST, HE0_ENTRY);
  assert.ok(script.includes(`check(${HE0_ENTRY})`), "必须追加 check 调用");
});

test("真实 HumanEval/0：canonical 解 → pass", async () => {
  const r = await judgePython(HE0_PROMPT, HE0_CANON, HE0_TEST, HE0_ENTRY, 10000);
  assert.equal(r.passed, true, r.error);
});

test("真实 HumanEval/0：错误解 return False → fail（无 check 调用会假 pass）", async () => {
  const r = await judgePython(HE0_PROMPT, "    return False\n", HE0_TEST, HE0_ENTRY, 10000);
  assert.equal(r.passed, false);
});

test("真实 HumanEval/0：完整 def 遮蔽形态 → pass", async () => {
  const fullDef = `def has_close_elements(numbers, threshold):\n${HE0_CANON}`;
  const r = await judgePython(HE0_PROMPT, fullDef, HE0_TEST, HE0_ENTRY, 10000);
  assert.equal(r.passed, true, r.error);
});

test("语法错误 → fail + error", async () => {
  const r = await judgePython(HE0_PROMPT, "    return (((\n", HE0_TEST, HE0_ENTRY, 10000);
  assert.equal(r.passed, false);
  assert.ok(r.error);
});

test("死循环超时 → fail + timeout", async () => {
  const r = await judgePython("def f():\n", "    while True: pass\n", "def check(c):\n    assert c()==1\n", "f", 1500);
  assert.equal(r.passed, false);
  assert.match(r.error ?? "", /timeout/i);
});
