import { describe, it, expect } from "vitest";
import { inferModel } from "../../extensions/pit-providers/infer.js";
import { registerFailover } from "../../extensions/pit-providers/failover.js";
import { makeKeyPool } from "../../extensions/pit-providers/keypool.js";
import type { ProviderDef, KeyPool, KeyEntry, ModelDef } from "../../extensions/pit-providers/types.js";

// ─── buildModelsForIds 逻辑（index.ts inline，不便直接导出）───

function buildIds(ids: string[], lookups: Map<string, ModelDef>, def: ProviderDef): ModelDef[] {
  return ids.map((id) => {
    const staticDef = lookups.get(id);
    if (staticDef) {
      return {
        ...staticDef,
        cost: staticDef.cost ? { ...staticDef.cost, cacheWrite: 0 } : undefined,
      };
    }
    return {
      ...inferModel(id, def.inferRules, def.inferDefaults),
      cost: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        ...(def.inferDefaults?.cost ?? {}),
      },
    };
  });
}

function keyLabelHelper(k: KeyEntry, activeId: string): string {
  const mark = k.id === activeId ? " ← active" : "";
  const fail = k.failed ? " [失效]" : "";
  return `${k.alias}${mark}${fail}`;
}

function simpleProviderOptsHelper(def: ProviderDef) {
  return {
    name: def.name,
    baseUrl: def.baseUrl,
    api: def.api as any,
    apiKey: def.apiKeyEnv ? `$${def.apiKeyEnv}` : undefined,
    compat: def.compat,
    models: def.models.map((m) => ({ ...m })),
  };
}

const SAMPLE_DEF: ProviderDef = {
  id: "test-p",
  name: "Test",
  baseUrl: "https://example.com/v1",
  api: "openai-completions",
  multiKey: false,
  refreshModels: true,
  models: [
    {
      id: "gpt-4", name: "GPT-4",
      contextWindow: 8192, maxTokens: 4096,
      cost: { input: 30, output: 60, cacheRead: 15, cacheWrite: 30 },
      reasoning: false, input: ["text"],
    },
    {
      id: "gpt-4o", name: "GPT-4o",
      reasoning: true, input: ["text", "image"],
      cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 5 },
      contextWindow: 128000, maxTokens: 16384,
    },
  ],
  inferRules: [
    { pattern: "o1", reasoning: true },
    { pattern: "gpt", contextWindow: 100000 },
  ],
  inferDefaults: { contextWindow: 32000, maxTokens: 4096, reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
};

describe("buildModelsForIds (inline logic)", () => {
  it("静态 model 命中 → 复用元数据，cacheWrite 强制 0（quirk）", () => {
    const lookups = new Map<string, ModelDef>(SAMPLE_DEF.models.map((m) => [m.id, m]));
    const results = buildIds(["gpt-4", "gpt-4o"], lookups, SAMPLE_DEF);
    expect(results[0].name).toBe("GPT-4");
    expect(results[0].cost?.cacheWrite).toBe(0);
    expect(results[0].cost?.input).toBe(30);
    expect(results[1].reasoning).toBe(true);
    expect(results[1].cost?.cacheWrite).toBe(0);
  });

  it("未知 id 走 inferRules 全匹配合并", () => {
    const lookups = new Map<string, ModelDef>(SAMPLE_DEF.models.map((m) => [m.id, m]));
    const results = buildIds(["o1-preview"], lookups, SAMPLE_DEF);
    // o1 rule: reasoning=true. "o1-preview" does NOT match "gpt" → ctx stays at defaults 32000.
    expect(results[0].reasoning).toBe(true);
    expect(results[0].contextWindow).toBe(32000);
  });

  it("未知 id 无规则命中 → inferDefaults 兜底", () => {
    const lookups = new Map<string, ModelDef>(SAMPLE_DEF.models.map((m) => [m.id, m]));
    const results = buildIds(["unknown-model"], lookups, SAMPLE_DEF);
    expect(results[0].contextWindow).toBe(32000);
    expect(results[0].reasoning).toBe(false);
    expect(results[0].maxTokens).toBe(4096);
  });

  it("claude 全匹配合并多字段", () => {
    const claudeDef: ProviderDef = {
      ...SAMPLE_DEF,
      inferRules: [{ pattern: "claude", contextWindow: 1000000, input: ["text", "image"] }],
    };
    const lookups = new Map(claudeDef.models.map((m) => [m.id, m]));
    const results = buildIds(["claude-sonnet"], lookups, claudeDef);
    expect(results[0].contextWindow).toBe(1000000);
    expect(results[0].input).toEqual(["text", "image"]);
    expect(results[0].name).toBe("claude-sonnet");
  });
});

describe("keyLabel", () => {
  it("active → ← active", () => {
    const label = keyLabelHelper({ id: "k1", alias: "key1", key: "sk-xxx", failed: false }, "k1");
    expect(label).toContain("← active");
  });
  it("failed → [失效]", () => {
    const label = keyLabelHelper({ id: "k2", alias: "key2", key: "sk-yyy", failed: true }, "k2");
    expect(label).toContain("[失效]");
  });
  it("normal → alias only", () => {
    expect(keyLabelHelper({ id: "k3", alias: "key3", key: "sk-zzz", failed: false }, "k1")).toBe("key3");
  });
});

describe("simpleProviderOpts", () => {
  it("apiKey = $ENV, no oauth, no refreshModels", () => {
    const def: ProviderDef = {
      id: "test-api", name: "Test API", baseUrl: "https://api.example/v1",
      api: "openai-completions", apiKeyEnv: "TEST_KEY", multiKey: false,
      refreshModels: false, models: [{ id: "m1", name: "M1" }],
    };
    const opts = simpleProviderOptsHelper(def);
    expect(opts.apiKey).toBe("$TEST_KEY");
    expect((opts as any).oauth).toBeUndefined();
    expect((opts as any).refreshModels).toBeUndefined();
  });
});

describe("registerFailover 注册", () => {
  it("pi.on('after_provider_response') 被调用", () => {
    const called: string[] = [];
    const pi = { on(e: string, _h: any) { called.push(e); } };
    const mgr = new Map();
    mgr.set("test", { alias: "test", providerId: "test", name: "T",
      loadPool: () => makeKeyPool(), savePool: () => {} });
    expect(() => registerFailover(pi, mgr)).not.toThrow();
    expect(called).toContain("after_provider_response");
  });
});
