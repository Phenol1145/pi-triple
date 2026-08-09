// test/ingest-tags.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTags } from "../src/ingest/tags.ts";

test("多级目录段 + 文件名去日期前缀", () => {
  assert.deepEqual(
    deriveTags("superpowers/specs/2026-08-02-memory-system-design.md"),
    ["superpowers", "specs", "memory-system-design"],
  );
});

test("根直属文件仅文件名标签", () => {
  assert.deepEqual(deriveTags("README.md"), ["README"]);
});

test("无日期前缀文件名原样", () => {
  assert.deepEqual(deriveTags("ptl/authoring.md"), ["ptl", "authoring"]);
});

test("文件名去日期前缀后为空 → 回退去扩展名（锚点恒非空）", () => {
  assert.deepEqual(deriveTags("x/2026-08-02.md"), ["x", "2026-08-02"]);
});

test("./ 前缀与空段被忽略", () => {
  assert.deepEqual(deriveTags("./a//b.md"), ["a", "b"]);
});
