import { describe, it, expect } from "vitest";
import { inferModel } from "../../extensions/pit-providers/infer.js";
import type { InferRule, InferDefaults } from "../../extensions/pit-providers/types.js";

const defaultRules: InferRule[] = [
  { pattern: "gemini", contextWindow: 1048576, input: ["text", "image"] },
  { pattern: "claude", contextWindow: 1000000, input: ["text", "image"] },
  { pattern: "gpt", contextWindow: 1048576 },
  { pattern: "vision|image", input: ["text", "image"] },
];

const defaultDefaults: InferDefaults = {
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("inferModel", () => {
  it("gemini → 1M context + image input (rule 1)", () => {
    const m = inferModel("gemini-3-flash", defaultRules, defaultDefaults);
    expect(m.id).toBe("gemini-3-flash");
    expect(m.contextWindow).toBe(1048576);
    expect(m.input).toEqual(["text", "image"]);
    expect(m.reasoning).toBe(false);
    expect(m.maxTokens).toBe(8192);
    expect(m.cost?.input).toBe(0);
  });

  it("claude → 1M context + image input (rule 2)", () => {
    const m = inferModel("claude-sonnet-4", defaultRules, defaultDefaults);
    expect(m.contextWindow).toBe(1000000);
    expect(m.input).toEqual(["text", "image"]);
  });

  it("gpt → 1M context, text only (rule 3)", () => {
    const m = inferModel("gpt-5", defaultRules, defaultDefaults);
    expect(m.contextWindow).toBe(1048576);
    expect(m.input).toEqual(["text"]);
  });

  it("image/vision keyword → image input (rule 4)", () => {
    const m = inferModel("my-vision-model", defaultRules, defaultDefaults);
    expect(m.input).toEqual(["text", "image"]);
    expect(m.contextWindow).toBe(128000); // defaults
  });

  it("unknown id → all defaults", () => {
    const m = inferModel("mystery-box", defaultRules, defaultDefaults);
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(8192);
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(["text"]);
    expect(m.cost?.input).toBe(0);
  });

  it("multiple rules merge: gemini with image in name hits both rules 1 and 4", () => {
    // "gemini-image-pro" matches rule 1 (gemini: ctx 1M, image input) AND rule 4 (vision|image: image input)
    // Both set image input → rule 4 overwrites rule 1's field, but they agree
    const m = inferModel("gemini-image-pro", defaultRules, defaultDefaults);
    expect(m.contextWindow).toBe(1048576); // from rule 1 (gemini)
    expect(m.input).toEqual(["text", "image"]); // from both
  });

  it("later rule overrides earlier for same field", () => {
    const rules: InferRule[] = [
      { pattern: "test", contextWindow: 500000, maxTokens: 4000 },
      { pattern: "model", contextWindow: 2000000 }, // overrides ctx
    ];
    const m = inferModel("test-model", rules, defaultDefaults);
    expect(m.contextWindow).toBe(2000000); // overridden by rule 2
    expect(m.maxTokens).toBe(4000); // only from rule 1
    expect(m.reasoning).toBe(false); // from defaults
  });

  it("no rules → pure defaults", () => {
    const m = inferModel("anything", [], defaultDefaults);
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(8192);
  });

  it("no rules and no defaults → bare minimum", () => {
    const m = inferModel("any", [], {});
    expect(m.id).toBe("any");
    expect(m.contextWindow).toBeUndefined();
    expect(m.maxTokens).toBeUndefined();
  });

  it("null rules → defaults only", () => {
    const m = inferModel("x", null as any, defaultDefaults);
    expect(m.contextWindow).toBe(128000);
  });
});
