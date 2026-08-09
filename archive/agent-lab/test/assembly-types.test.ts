import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMemorySpec, ROUND_SENTINEL } from "../src/assembly/types.ts";

test("valid memory spec passes", () => {
  assert.deepEqual(validateMemorySpec({ dialect: "json", maxEntries: 100 }), []);
});
test("invalid dialect rejected", () => {
  assert.ok(validateMemorySpec({ dialect: "yaml" as never }).some((e) => e.includes("dialect")));
});
test("markdown dialect is allowed but documented draft-only", () => {
  assert.deepEqual(validateMemorySpec({ dialect: "markdown" }), []);
});
test("maxEntries must be positive integer", () => {
  assert.ok(validateMemorySpec({ maxEntries: 0 }).length > 0);
  assert.ok(validateMemorySpec({ maxEntries: -1 }).length > 0);
  assert.ok(validateMemorySpec({ maxEntries: 1.5 }).length > 0);
});
test("unknown fields rejected", () => {
  assert.ok(validateMemorySpec({ projection: {} } as never).length > 0);
});
test("ROUND_SENTINEL is empty string", () => {
  assert.equal(ROUND_SENTINEL, "");
});
