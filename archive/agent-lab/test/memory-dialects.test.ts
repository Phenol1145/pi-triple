import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDialect } from "../src/memory/dialects.ts";

test("json dialect extracts fields", () => {
  const r = parseDialect("json", '```json\n{"subject": "api", "predicate": "limit", "object": 100}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.confidence, "high");
  assert.equal(r.fields.subject, "api");
});

test("xml dialect extracts fields by tag", () => {
  const r = parseDialect("xml", "<fact><subject>api</subject><predicate>limit</predicate></fact>");
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields.subject, "api");
});

test("markdown dialect is medium confidence and flags missing required", () => {
  const r = parseDialect("markdown", "## subject\napi\n## predicate\nlimit");
  assert.equal(r.confidence, "medium");
  // 调用方按 ok/errors 决策草稿区
  assert.equal(r.ok, true);
});

test("invalid json reports errors", () => {
  const r = parseDialect("json", "{not json");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});