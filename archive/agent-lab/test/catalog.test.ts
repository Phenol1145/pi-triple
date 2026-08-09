import { test } from "node:test";
import assert from "node:assert/strict";
import { CatalogService } from "../src/catalog/catalog.ts";

const OR_JSON = {
  data: [
    { id: "google/gemma-4-31b-it:free", name: "Gemma (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" } },
    { id: "deepseek/deepseek-v3.2", name: "DS V3.2", context_length: 163840, pricing: { prompt: "0.00000027", completion: "0.0000004" } },
    { id: "anthropic/claude-sonnet-4", name: "Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
  ],
};

function mockFetch(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

test("refresh parses free + direct candidates only", async () => {
  const cat = new CatalogService({ directPrefixes: ["deepseek"], ttlMs: 1000, fetchImpl: mockFetch(OR_JSON) });
  await cat.refresh();
  const ids = cat.candidates().map((m) => m.id).sort();
  assert.deepEqual(ids, ["deepseek/deepseek-v3.2", "google/gemma-4-31b-it:free"]);
});

test("isFresh reflects ttl", async () => {
  let t = 1000;
  const cat = new CatalogService({ directPrefixes: ["deepseek"], ttlMs: 500, fetchImpl: mockFetch(OR_JSON), now: () => t });
  await cat.refresh();
  assert.equal(cat.isFresh, true);
  t = 1600;
  assert.equal(cat.isFresh, false);
});
