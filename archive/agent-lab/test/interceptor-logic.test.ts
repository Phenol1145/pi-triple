import { test } from "node:test";
import assert from "node:assert/strict";
import { modelAllowed, globMatch } from "../src/interceptor/model-scope.ts";

test("modelAllowed with globs", () => {
  assert.equal(modelAllowed("deepseek/deepseek-v3.2", undefined), true);
  assert.equal(modelAllowed("deepseek/deepseek-v3.2", ["deepseek/*"]), true);
  assert.equal(modelAllowed("anthropic/claude", ["deepseek/*"]), false);
  assert.equal(globMatch("*/kimi-*", "moonshotai/kimi-k3"), true);
});
