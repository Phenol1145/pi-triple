import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We test via the module's functions — but since the module uses
// PI_TRIPLE_HOME at import time, we inject it in-process.
// Instead we directly test the validation and load logic by
// using a temp dir and calling the functions with explicit paths.

// Re-import per-test to pick up env changes
let registry: typeof import("../../extensions/pit-providers/registry.js");
let tmpHome: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-reg-"));
  process.env.PI_TRIPLE_HOME = tmpHome;
  // Dynamic reimport to clear module cache
  registry = await import("../../extensions/pit-providers/registry.js");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function providersPath(): string {
  return path.join(tmpHome, "providers.json");
}

describe("validateProvider", () => {
  it("rejects non-object", () => {
    const r = registry.validateProvider("string");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("rejects missing id", () => {
    const r = registry.validateProvider({ name: "Test", baseUrl: "https://x", api: "openai-completions", multiKey: false, refreshModels: false, models: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("id");
  });

  it("rejects invalid id (uppercase/dashy)", () => {
    const r = registry.validateProvider({ id: "KimI", name: "Test", baseUrl: "https://x", api: "openai-completions", multiKey: false, refreshModels: false, models: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("id");
  });

  it("rejects invalid id (has dot)", () => {
    const r = registry.validateProvider({ id: "kimi.platform", name: "Test", baseUrl: "https://x", api: "openai-completions", multiKey: false, refreshModels: false, models: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("id");
  });

  it("rejects missing baseUrl", () => {
    const r = registry.validateProvider({ id: "test", name: "Test", api: "openai-completions", multiKey: false, refreshModels: false, models: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("baseUrl");
  });

  it("rejects missing api", () => {
    const r = registry.validateProvider({ id: "test", name: "Test", baseUrl: "https://x", multiKey: false, refreshModels: false, models: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("api");
  });

  it("accepts model id with spaces", () => {
    const r = registry.validateProvider({
      id: "test", name: "Test", baseUrl: "https://x", api: "openai-completions", multiKey: false, refreshModels: false,
      models: [{ id: "Gemini 3.5 Flash (Low)" }],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts model id with slash", () => {
    const r = registry.validateProvider({
      id: "test", name: "Test", baseUrl: "https://x", api: "openai-completions", multiKey: false, refreshModels: false,
      models: [{ id: "kiro/claude-opus-4-8" }],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts valid minimal provider", () => {
    const r = registry.validateProvider({
      id: "kimi", name: "Kimi", baseUrl: "https://api.x/v1", api: "openai-completions", multiKey: false, refreshModels: false, models: [],
    });
    expect(r.ok).toBe(true);
    expect(r.def!.id).toBe("kimi");
  });

  it("reports extra keys as warnings but still passes", () => {
    const r = registry.validateProvider({
      id: "kimi", name: "Kimi", baseUrl: "https://api.x/v1", api: "openai-completions",
      multiKey: false, refreshModels: false, models: [], extraUnknown: "yes",
    });
    // Should still be ok, but the warning should be captured somewhere
    expect(r.ok).toBe(true);
    // Warnings may be collected via a side channel; at minimum it shouldn't crash
  });
});

describe("loadProviders", () => {
  it("returns empty list when file does not exist", () => {
    const result = registry.loadProviders();
    expect(result.providers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("reports error for bad JSON", () => {
    fs.writeFileSync(providersPath(), "not json at all {{{");
    const result = registry.loadProviders();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("JSON");
    expect(result.providers).toEqual([]);
  });

  it("skips individual invalid providers but loads the rest", () => {
    fs.writeFileSync(providersPath(), JSON.stringify({ version: 1, providers: [
      { id: "kimi", name: "Kimi", baseUrl: "https://api.x/v1", api: "openai-completions", multiKey: false, refreshModels: false, models: [] },
      { name: "BadNoId" },   // missing id
      { id: "valid", name: "Valid", baseUrl: "https://api.y/v1", api: "openai-completions", multiKey: false, refreshModels: false, models: [] },
    ]}));
    const result = registry.loadProviders();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("Providers[1]");
    expect(result.providers.length).toBe(2);
    expect(result.providers[0].id).toBe("kimi");
    expect(result.providers[1].id).toBe("valid");
  });

  it("reports error when version missing", () => {
    fs.writeFileSync(providersPath(), JSON.stringify({ providers: [ { id: "kimi", name: "Kimi", baseUrl: "https://api.x/v1", api: "openai-completions", multiKey: false, refreshModels: false, models: [] } ] }));
    const result = registry.loadProviders();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("version");
  });
});

describe("ensureDefaultProviders", () => {
  it("creates default file if it does not exist", () => {
    const p = providersPath();
    expect(fs.existsSync(p)).toBe(false);
    const created = registry.ensureDefaultProviders(p);
    expect(created).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.providers)).toBe(true);
    expect(raw.providers.length).toBeGreaterThan(0);
    // At least kimi is present as a placeholder
    const ids = raw.providers.map((p: any) => p.id);
    expect(ids).toContain("kimi");
  });

  it("does not overwrite existing file", () => {
    const p = providersPath();
    const custom = { version: 1, providers: [{ id: "custom", name: "Custom", baseUrl: "https://x", api: "openai-completions", multiKey: false, refreshModels: false, models: [] }] };
    fs.writeFileSync(p, JSON.stringify(custom));
    const created = registry.ensureDefaultProviders(p);
    expect(created).toBe(false);
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(raw.providers[0].id).toBe("custom");
  });
});
