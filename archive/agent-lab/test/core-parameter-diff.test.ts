import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffLeafPaths,
  assertPathsTunable,
  TunablePathViolationError,
} from "../src/core/parameter-diff.ts";

// ── diffLeafPaths ──────────────────────────────────────────────────

test("diffLeafPaths returns empty for identical objects", () => {
  assert.deepEqual(diffLeafPaths({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffLeafPaths({ a: { b: 2 } }, { a: { b: 2 } }), []);
});

test("diffLeafPaths returns empty for identical primitives", () => {
  assert.deepEqual(diffLeafPaths(1, 1), []);
  assert.deepEqual(diffLeafPaths("x", "x"), []);
  assert.deepEqual(diffLeafPaths(null, null), []);
  assert.deepEqual(diffLeafPaths(undefined, undefined), []);
});

test("diffLeafPaths returns root path for differing primitives", () => {
  assert.deepEqual(diffLeafPaths(1, 2), [""]);
  assert.deepEqual(diffLeafPaths("a", "b"), [""]);
  assert.deepEqual(diffLeafPaths(null, 1), [""]);
});

test("diffLeafPaths enumerates single-level leaf changes", () => {
  assert.deepEqual(diffLeafPaths({ a: 1, b: 2 }, { a: 1, b: 3 }), ["b"]);
  assert.deepEqual(diffLeafPaths({ a: 1 }, { a: 2 }), ["a"]);
});

test("diffLeafPaths enumerates nested leaf paths", () => {
  assert.deepEqual(
    diffLeafPaths({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }),
    ["a.c"],
  );
  assert.deepEqual(
    diffLeafPaths({ x: { y: { z: 1 } } }, { x: { y: { z: 2 } } }),
    ["x.y.z"],
  );
});

test("diffLeafPaths detects added keys", () => {
  assert.deepEqual(diffLeafPaths({ a: 1 }, { a: 1, b: 2 }), ["b"]);
});

test("diffLeafPaths detects removed keys", () => {
  assert.deepEqual(diffLeafPaths({ a: 1, b: 2 }, { a: 1 }), ["b"]);
});

test("diffLeafPaths treats arrays as whole leaf (no index descent)", () => {
  assert.deepEqual(diffLeafPaths({ arr: [1, 2] }, { arr: [1, 3] }), ["arr"]);
  assert.deepEqual(diffLeafPaths({ arr: [1, 2] }, { arr: [1, 2] }), []);
});

test("diffLeafPaths non-object defense: one side primitive", () => {
  // If base is an object but next is a primitive, the path is a leaf change
  assert.deepEqual(diffLeafPaths({ a: { b: 1 } }, { a: 2 }), ["a"]);
  assert.deepEqual(diffLeafPaths({ a: 2 }, { a: { b: 1 } }), ["a"]);
});

test("diffLeafPaths non-object defense: null vs object", () => {
  assert.deepEqual(diffLeafPaths({ a: null }, { a: { b: 1 } }), ["a"]);
});

test("diffLeafPaths multiple changes across branches", () => {
  assert.deepEqual(
    diffLeafPaths({ a: 1, b: 2, c: { d: 3 } }, { a: 99, b: 2, c: { d: 4 } }),
    ["a", "c.d"],
  );
});

test("diffLeafPaths empty objects are equal", () => {
  assert.deepEqual(diffLeafPaths({}, {}), []);
});

test("diffLeafPaths both sides arrays", () => {
  assert.deepEqual(diffLeafPaths([1, 2], [1, 3]), [""]);
  assert.deepEqual(diffLeafPaths([1, 2], [1, 2]), []);
});

// ── assertPathsTunable ────────────────────────────────────────────

test("assertPathsTunable does not throw when all paths tunable (exact)", () => {
  assert.doesNotThrow(() =>
    assertPathsTunable(["weights.completion"], ["weights.completion"]),
  );
});

test("assertPathsTunable does not throw when all paths tunable (wildcard)", () => {
  assert.doesNotThrow(() =>
    assertPathsTunable(
      ["weights.completion", "weights.costEffectiveness"],
      ["weights.*"],
    ),
  );
});

test("assertPathsTunable does not throw for empty paths", () => {
  assert.doesNotThrow(() => assertPathsTunable([], ["weights.*"]));
  assert.doesNotThrow(() => assertPathsTunable([], []));
});

test("assertPathsTunable throws TunablePathViolationError with violations", () => {
  try {
    assertPathsTunable(["weights.completion", "topN"], ["weights.*"]);
    assert.fail("expected TunablePathViolationError");
  } catch (e) {
    assert.ok(e instanceof TunablePathViolationError);
    assert.deepEqual((e as TunablePathViolationError).violations, ["topN"]);
  }
});

test("assertPathsTunable lists all violations", () => {
  try {
    assertPathsTunable(["a.b", "c.d", "e.f"], ["x.y"]);
    assert.fail("expected TunablePathViolationError");
  } catch (e) {
    assert.ok(e instanceof TunablePathViolationError);
    assert.deepEqual((e as TunablePathViolationError).violations, [
      "a.b",
      "c.d",
      "e.f",
    ]);
  }
});

test("assertPathsTunable matching is case-sensitive", () => {
  try {
    assertPathsTunable(["Weights.completion"], ["weights.*"]);
    assert.fail("expected TunablePathViolationError");
  } catch (e) {
    assert.ok(e instanceof TunablePathViolationError);
    assert.deepEqual((e as TunablePathViolationError).violations, [
      "Weights.completion",
    ]);
  }
});

test("assertPathsTunable star only matches one segment", () => {
  // "weights.*" should NOT match "weights.completion.sub"
  try {
    assertPathsTunable(["weights.completion.sub"], ["weights.*"]);
    assert.fail("expected TunablePathViolationError");
  } catch (e) {
    assert.ok(e instanceof TunablePathViolationError);
    assert.deepEqual((e as TunablePathViolationError).violations, [
      "weights.completion.sub",
    ]);
  }
});

test("assertPathsTunable mix of exact and wildcard entries", () => {
  assert.doesNotThrow(() =>
    assertPathsTunable(
      ["weights.completion", "topN"],
      ["weights.*", "topN"],
    ),
  );
});

test("assertPathsTunable error message lists violations", () => {
  try {
    assertPathsTunable(["a"], ["b"]);
  } catch (e) {
    assert.ok((e as Error).message.includes("a"));
  }
});
