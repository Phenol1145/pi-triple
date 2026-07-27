import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesVersionRange, RangeSyntaxError } from "../src/core/version-range.ts";

// ── wildcard ────────────────────────────────────────────────────────────────
test("wildcard * matches any valid semver", () => {
  assert.equal(matchesVersionRange("0.0.0", "*"), true);
  assert.equal(matchesVersionRange("1.0.0", "*"), true);
  assert.equal(matchesVersionRange("999.999.999", "*"), true);
});

// ── exact ───────────────────────────────────────────────────────────────────
test("exact version matches identical version", () => {
  assert.equal(matchesVersionRange("1.2.3", "1.2.3"), true);
  assert.equal(matchesVersionRange("0.0.0", "0.0.0"), true);
  assert.equal(matchesVersionRange("10.20.30", "10.20.30"), true);
});

test("exact version rejects different patch", () => {
  assert.equal(matchesVersionRange("1.2.3", "1.2.4"), false);
});

test("exact version rejects different minor", () => {
  assert.equal(matchesVersionRange("1.2.3", "1.3.3"), false);
});

test("exact version rejects different major", () => {
  assert.equal(matchesVersionRange("1.2.3", "2.2.3"), false);
});

test("exact version does not parse the range as a range operator", () => {
  // "1.0.0" is treated as exact, not as a shorthand for something else
  assert.equal(matchesVersionRange("1.0.0", "1.0.0"), true);
  assert.equal(matchesVersionRange("1.0.1", "1.0.0"), false);
});

// ── caret ^ ─────────────────────────────────────────────────────────────────
test("caret ^1.2.3 matches same major, >= specified", () => {
  assert.equal(matchesVersionRange("1.2.3", "^1.2.3"), true);
  assert.equal(matchesVersionRange("1.3.0", "^1.2.3"), true);
  assert.equal(matchesVersionRange("1.9.9", "^1.2.3"), true);
});

test("caret ^1.2.3 rejects lower minor within same major", () => {
  assert.equal(matchesVersionRange("1.2.2", "^1.2.3"), false);
  assert.equal(matchesVersionRange("1.1.0", "^1.2.3"), false);
});

test("caret ^1.0.0 rejects 2.0.0 (plan boundary)", () => {
  assert.equal(matchesVersionRange("2.0.0", "^1.0.0"), false);
});

test("caret ^1.0.0 rejects 0.9.0 (different major)", () => {
  assert.equal(matchesVersionRange("0.9.0", "^1.0.0"), false);
});

// npm caret semantics for 0.x:
//   ^0.0.z  →  >=0.0.z <0.0.(z+1)   (patch-level only)
//   ^0.y.z  →  >=0.y.z <0.(y+1).0   (minor-level, not major)
test("caret ^0.0.3 locks patch — allows same patch, rejects higher", () => {
  assert.equal(matchesVersionRange("0.0.3", "^0.0.3"), true);
  assert.equal(matchesVersionRange("0.0.4", "^0.0.3"), false);
  assert.equal(matchesVersionRange("0.1.0", "^0.0.3"), false);
});

test("caret ^0.2.3 allows minor bumps, rejects higher minor boundary", () => {
  assert.equal(matchesVersionRange("0.2.3", "^0.2.3"), true);
  assert.equal(matchesVersionRange("0.2.9", "^0.2.3"), true);
  assert.equal(matchesVersionRange("0.3.0", "^0.2.3"), false);
  assert.equal(matchesVersionRange("1.0.0", "^0.2.3"), false);
});

test("caret ^0.2.3 rejects lower patch", () => {
  assert.equal(matchesVersionRange("0.2.2", "^0.2.3"), false);
});

// ── tilde ~ ─────────────────────────────────────────────────────────────────
test("tilde ~1.2.3 matches same major.minor, >= specified", () => {
  assert.equal(matchesVersionRange("1.2.3", "~1.2.3"), true);
  assert.equal(matchesVersionRange("1.2.9", "~1.2.3"), true);
});

test("tilde ~1.2.3 rejects higher minor", () => {
  assert.equal(matchesVersionRange("1.3.0", "~1.2.3"), false);
});

test("tilde ~1.2.0 rejects 1.3.0 (plan boundary)", () => {
  assert.equal(matchesVersionRange("1.3.0", "~1.2.0"), false);
});

test("tilde ~1.2.3 rejects lower patch", () => {
  assert.equal(matchesVersionRange("1.2.2", "~1.2.3"), false);
});

test("tilde works with leading 0", () => {
  assert.equal(matchesVersionRange("0.2.3", "~0.2.0"), true);
  assert.equal(matchesVersionRange("0.2.9", "~0.2.0"), true);
  assert.equal(matchesVersionRange("0.3.0", "~0.2.0"), false);
});

// ── RangeSyntaxError: unsupported range forms ───────────────────────────────
test("throws RangeSyntaxError on >= operator", () => {
  assert.throws(() => matchesVersionRange("1.0.0", ">=1.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on || operator", () => {
  assert.throws(() => matchesVersionRange("1.0.0", "^1.0.0 || ^2.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on hyphen range", () => {
  assert.throws(() => matchesVersionRange("1.5.0", "1.0.0 - 2.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on x-range (1.x)", () => {
  assert.throws(() => matchesVersionRange("1.5.0", "1.x"), RangeSyntaxError);
});

test("throws RangeSyntaxError on x-range (1.2.x)", () => {
  assert.throws(() => matchesVersionRange("1.2.5", "1.2.x"), RangeSyntaxError);
});

test("throws RangeSyntaxError on <= operator", () => {
  assert.throws(() => matchesVersionRange("1.0.0", "<=1.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on > operator", () => {
  assert.throws(() => matchesVersionRange("1.0.0", ">1.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on empty range", () => {
  assert.throws(() => matchesVersionRange("1.0.0", ""), RangeSyntaxError);
});

test("throws RangeSyntaxError on garbage range", () => {
  assert.throws(() => matchesVersionRange("1.0.0", "not-a-version"), RangeSyntaxError);
});

// ── invalid semver version ──────────────────────────────────────────────────
test("throws RangeSyntaxError on non-semver version", () => {
  assert.throws(() => matchesVersionRange("abc", "^1.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on partial version (missing patch)", () => {
  assert.throws(() => matchesVersionRange("1.2", "^1.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on version with leading zeros", () => {
  assert.throws(() => matchesVersionRange("01.2.3", "^1.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on version with pre-release tag", () => {
  assert.throws(() => matchesVersionRange("1.0.0-alpha.1", "^1.0.0"), RangeSyntaxError);
});

test("throws RangeSyntaxError on version with build metadata", () => {
  assert.throws(() => matchesVersionRange("1.0.0+build.123", "^1.0.0"), RangeSyntaxError);
});

// ── range syntax error message is descriptive ───────────────────────────────
test("RangeSyntaxError has descriptive message", () => {
  try {
    matchesVersionRange("1.0.0", ">=1.0.0");
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof RangeSyntaxError);
    assert.ok((e as RangeSyntaxError).message.length > 0);
  }
});

// ── boundary / edge cases ───────────────────────────────────────────────────
test("caret lower bound is inclusive", () => {
  assert.equal(matchesVersionRange("1.0.0", "^1.0.0"), true);
});

test("caret upper bound is exclusive", () => {
  assert.equal(matchesVersionRange("2.0.0", "^1.0.0"), false);
  // Any 1.x.y < 2.0.0 is valid; 2.0.0 is the exclusive upper bound
  assert.equal(matchesVersionRange("1.999.999", "^1.0.0"), true);
});

test("tilde lower bound is inclusive", () => {
  assert.equal(matchesVersionRange("1.2.0", "~1.2.0"), true);
});

test("tilde upper bound is exclusive", () => {
  assert.equal(matchesVersionRange("1.3.0", "~1.2.0"), false);
});

test("zero versions are valid semver", () => {
  assert.equal(matchesVersionRange("0.0.0", "0.0.0"), true);
  // ^0.0.0 only matches exactly 0.0.0 (upper bound <0.0.1)
  assert.equal(matchesVersionRange("0.0.0", "^0.0.0"), true);
  assert.equal(matchesVersionRange("0.0.1", "^0.0.0"), false);
  assert.equal(matchesVersionRange("0.0.0", "~0.0.0"), true);
});

test("large version numbers work", () => {
  assert.equal(matchesVersionRange("999.998.997", "^999.998.0"), true);
  assert.equal(matchesVersionRange("1000.0.0", "^999.998.0"), false);
});

test("RangeSyntaxError is an instance of Error", () => {
  const e = new RangeSyntaxError("test");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof RangeSyntaxError);
});
