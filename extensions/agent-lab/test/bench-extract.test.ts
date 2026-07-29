import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCode } from "../src/bench/extract.ts";

test("提取 ```python``` 围栏", () => {
  const raw = "好的，这是实现：\n```python\ndef f():\n    return 1\n```\n希望有帮助。";
  assert.ok(extractCode(raw, "f").includes("return 1"));
});

test("提取无语言围栏", () => {
  const raw = "```\ndef f():\n    return 1\n```";
  assert.ok(extractCode(raw, "f").includes("return 1"));
});

test("无围栏时取 def entry_point 到末尾", () => {
  const raw = "解释 blah\ndef f():\n    return 1\n";
  const code = extractCode(raw, "f");
  assert.ok(code.startsWith("def f("));
  assert.ok(code.includes("return 1"));
});

test("纯代码原样返回", () => {
  const raw = "def f():\n    return 1\n";
  assert.equal(extractCode(raw, "f").trim(), raw.trim());
});

test("空输出返回空串", () => {
  assert.equal(extractCode("", "f"), "");
});
