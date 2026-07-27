import { test } from "node:test";
import assert from "node:assert/strict";
import { parseORModels, isFreeModel, toPerMillion, providerPrefix, blendedPrice } from "../src/catalog/parse.ts";
import type { ORModelsJson } from "../src/catalog/parse.ts";

const DIRECT = ["deepseek", "moonshotai", "z-ai", "qwen"];
const json: ORModelsJson = {
  data: [
    { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", context_length: 163840, pricing: { prompt: "0.00000027", completion: "0.0000004" } },
    { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-oss-20b:free", name: "gpt-oss-20b (free)", context_length: 131072, pricing: { prompt: "0", completion: "0" } },
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
  ],
};

test("providerPrefix", () => {
  assert.equal(providerPrefix("deepseek/deepseek-v3.2"), "deepseek");
  assert.equal(providerPrefix("noslash"), "noslash");
});

test("toPerMillion converts per-token to per-million", () => {
  assert.ok(Math.abs(toPerMillion("0.00000027") - 0.27) < 1e-9);
  assert.equal(toPerMillion("0"), 0);
  assert.equal(toPerMillion(undefined), 0);
});

test("isFreeModel", () => {
  assert.equal(isFreeModel({ id: "x", pricing: { prompt: "0", completion: "0" } }), true);
  assert.equal(isFreeModel({ id: "x", pricing: { prompt: "0.00000027", completion: "0" } }), false);
});

test("parseORModels keeps only free + direct candidates and tags route", () => {
  const models = parseORModels(json, DIRECT);
  const ids = models.map((m) => m.id).sort();
  assert.deepEqual(ids, ["deepseek/deepseek-v3.2", "google/gemma-4-31b-it:free", "openai/gpt-oss-20b:free"]);
  const ds = models.find((m) => m.id === "deepseek/deepseek-v3.2")!;
  assert.equal(ds.accessRoute, "direct");
  assert.ok(Math.abs(ds.pricing!.in - 0.27) < 1e-9);
  const gemma = models.find((m) => m.id === "google/gemma-4-31b-it:free")!;
  assert.equal(gemma.accessRoute, "free");
  assert.equal(blendedPrice(gemma), 0);
});
