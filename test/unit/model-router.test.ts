import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelRouter } from "@pi-triple/infra";

describe("ModelRouter", () => {
  let router: ModelRouter;
  let mockCredentials: any;
  let mockLogger: any;

  beforeEach(() => {
    mockCredentials = { getApiKey: vi.fn().mockResolvedValue(null) };
    mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    router = new ModelRouter(mockCredentials, mockLogger);
  });

  function setupRuntime(available: Array<{ provider: string; id: string }>) {
    const getModel = vi.fn().mockImplementation((provider: string, model: string) => {
      const found = available.find((m) => m.provider === provider && m.id === model);
      return found ?? null;
    });
    const getAvailable = vi.fn().mockResolvedValue(available);

    // Directly inject — we're testing resolve behavior, not initialize
    (router as any).runtime = { getModel, getAvailable };
    (router as any).detectedProvider = available[0]?.provider ?? null;
    (router as any).detectedModel = available[0]?.id ?? null;
  }

  it("resolve returns detected default model when no provider/model specified", () => {
    setupRuntime([
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "anthropic", id: "claude-opus-4-5" },
    ]);

    const resolved = router.resolve();
    expect(resolved).toEqual({ provider: "deepseek", id: "deepseek-v4-flash" });
  });

  it("resolve uses specified provider/model when provided", () => {
    setupRuntime([
      { provider: "deepseek", id: "deepseek-v4-flash" },
      { provider: "kimi-coding", id: "k3" },
    ]);

    const resolved = router.resolve("kimi-coding", "k3");
    expect(resolved).toEqual({ provider: "kimi-coding", id: "k3" });
  });

  it("resolve fails over to other providers when specified model unavailable", () => {
    const available = [
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "claude-opus-4-5" },
    ];
    const getModel = vi.fn().mockImplementation((provider: string, model: string) => {
      // "openai" + "gpt-5-missing" -> null, but "openai" + "gpt-5" returns the model
      if (provider === "openai" && model === "gpt-5-missing") return null;
      const found = available.find((m) => m.provider === provider && m.id === model);
      return found ?? null;
    });
    (router as any).runtime = { getModel, getAvailable: vi.fn().mockResolvedValue(available) };
    (router as any).detectedProvider = "openai";
    (router as any).detectedModel = "gpt-5";

    // Request "openai"/"gpt-5-missing" — not found in openai, failover to next providers
    const resolved = router.resolve("openai", "gpt-5-missing");
    // Should fall through failover and return the detected default (last resort)
    expect(resolved).toBeDefined();
    expect(resolved!.provider).toBe("openai"); // or anthropic from failover
  });

  it("resolve uses last-resort detected model when all failovers exhausted", () => {
    const available = [{ provider: "deepseek", id: "deepseek-v4-flash" }];
    const getModel = vi.fn().mockImplementation((provider: string, model: string) => {
      return available.find((m) => m.provider === provider && m.id === model) ?? null;
    });
    (router as any).runtime = { getModel, getAvailable: vi.fn().mockResolvedValue(available) };
    (router as any).detectedProvider = "deepseek";
    (router as any).detectedModel = "deepseek-v4-flash";

    // Request a nonexistent model — should fall back to detected default
    const resolved = router.resolve("nonexistent", "no-model");
    expect(resolved).toEqual({ provider: "deepseek", id: "deepseek-v4-flash" });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("resolve throws when no model available at all", () => {
    (router as any).runtime = { getModel: vi.fn().mockReturnValue(null), getAvailable: vi.fn().mockResolvedValue([]) };
    (router as any).detectedProvider = null;
    (router as any).detectedModel = null;

    expect(() => router.resolve("any", "model")).toThrow("no failover available");
  });
});
