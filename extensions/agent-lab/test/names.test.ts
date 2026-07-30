import { test } from "node:test";
import assert from "node:assert/strict";
import * as names from "../src/schedulers/names.ts";

test("scheduler definition ids are non-empty and distinct", () => {
  assert.ok(names.MARKET_SCHEDULER_DEFINITION_ID.length > 0);
  assert.ok(names.WEIGHTED_SCORER_DEFINITION_ID.length > 0);
  assert.notEqual(names.MARKET_SCHEDULER_DEFINITION_ID, names.WEIGHTED_SCORER_DEFINITION_ID);
});

test("default instance ids are non-empty and distinct", () => {
  const ids = [names.DEFAULT_MARKET_INSTANCE_ID, names.DEFAULT_WEIGHTED_SCORER_INSTANCE_ID];
  assert.ok(ids.every((x) => x.length > 0));
  assert.equal(new Set(ids).size, ids.length);
});

test("optimizer + binding ids are non-empty", () => {
  assert.ok(names.WEIGHTED_TUNER_OPTIMIZER_ID.length > 0);
  assert.ok(names.DEFAULT_WEIGHTED_TUNER_INSTANCE_ID.length > 0);
  assert.ok(names.MARKET_DEFAULT_BINDING_ID.length > 0);
  assert.ok(names.WEIGHTED_SCORER_DEFAULT_BINDING_ID.length > 0);
});
