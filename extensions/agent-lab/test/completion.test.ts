import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCompletion, acceptanceBase, clamp01 } from "../src/scorer/completion.ts";

const MAP = { reviewed: 1.0, verified: 0.9, checked: 0.7, attested: 0.5, auto: 0.4, none: 0.2 };
const base = { map: MAP, interruptedPenalty: 0.3, toolFailPenalty: 0.2 };

test("acceptance maps to base score", () => {
  assert.equal(acceptanceBase("verified", MAP), 0.9);
  assert.equal(acceptanceBase(undefined, MAP), 0.4);
  assert.equal(acceptanceBase("unknown", MAP), 0.4);
});

test("clean verified run => 0.9", () => {
  assert.equal(deriveCompletion({ ...base, acceptance: "verified", toolSuccess: 1 }), 0.9);
});

test("interrupted subtracts penalty", () => {
  assert.ok(Math.abs(deriveCompletion({ ...base, acceptance: "verified", interrupted: 1, toolSuccess: 1 }) - 0.6) < 1e-9);
});

test("low tool success subtracts", () => {
  assert.ok(Math.abs(deriveCompletion({ ...base, acceptance: "checked", toolSuccess: 0.5 }) - 0.6) < 1e-9);
});

test("manual rating overrides", () => {
  assert.equal(deriveCompletion({ ...base, acceptance: "verified", manualRating: 0.2 }), 0.2);
});

test("clamps to [0,1]", () => {
  assert.equal(deriveCompletion({ ...base, acceptance: "none", interrupted: 1, toolSuccess: 0 }), 0);
  assert.equal(clamp01(1.5), 1);
});
