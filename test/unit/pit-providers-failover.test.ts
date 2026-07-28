import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerFailover } from "../../extensions/pit-providers/failover.js";
import {
  makeKeyPool,
  getActiveKey,
  getNextAvailableKey,
  generateId,
} from "../../extensions/pit-providers/keypool.js";
import type { KeyPool } from "../../extensions/pit-providers/types.js";

/** Minimal mock for ProviderManager */
interface MockManager {
  alias: string;
  providerId: string;
  name: string;
  loadPool: () => KeyPool;
  savePool: (pool: KeyPool) => void;
}

function mockManager(providerId: string, alias: string, pool: KeyPool): MockManager {
  return {
    alias,
    providerId,
    name: providerId.toUpperCase(),
    loadPool: () => pool,
    savePool: () => {},
  };
}

function setup() {
  const pi: any = {
    handlers: {} as Record<string, Function>,
    on(event: string, handler: Function) {
      pi.handlers[event] = handler;
    },
  };
  const managers = new Map<string, MockManager>();
  const event = (status: number, provider?: string, hasUI = true) => {
    return {
      status,
      ui: hasUI ? { notify: vi.fn() } : undefined,
    };
  };
  const ctx = (provider?: string, hasUI = true) => {
    return {
      model: provider ? { provider } : undefined,
      hasUI,
      ui: hasUI ? { notify: vi.fn() } : undefined,
    };
  };
  return { pi, managers, event, ctx };
}

describe("registerFailover", () => {
  it("registers after_provider_response handler on pi", () => {
    const { pi, managers } = setup();
    registerFailover(pi as any, managers as any);
    expect(pi.handlers["after_provider_response"]).toBeDefined();
    expect(typeof pi.handlers["after_provider_response"]).toBe("function");
  });

  it("401 → marks active failed + switches activeId + notifies", () => {
    const { pi, managers, event, ctx } = setup();
    const pool = makeKeyPool();
    const k1 = { id: generateId(), alias: "key1", key: "a1", failed: false };
    const k2 = { id: generateId(), alias: "key2", key: "a2", failed: false };
    pool.keys = [k1, k2];
    pool.activeId = k1.id;
    const mgr = mockManager("ustc", "ustc", pool);
    let savedPool: KeyPool | null = null;
    mgr.savePool = (p) => { savedPool = { ...p, keys: [...p.keys] }; };
    managers.set("ustc", mgr);
    const c = ctx("ustc");

    registerFailover(pi as any, managers as any);
    pi.handlers["after_provider_response"](event(401, "ustc"), c);

    expect(k1.failed).toBe(true);
    expect(savedPool).not.toBeNull();
    expect(savedPool!.activeId).toBe(k2.id);
    expect(c.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("key1"),
      "warn",
    );
    expect(c.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("key2"),
      "warn",
    );
  });

  it("403 → same failover as 401", () => {
    const { pi, managers, event, ctx } = setup();
    const pool = makeKeyPool();
    const k1 = { id: generateId(), alias: "k1", key: "x", failed: false };
    const k2 = { id: generateId(), alias: "k2", key: "y", failed: false };
    pool.keys = [k1, k2];
    pool.activeId = k1.id;
    const mgr = mockManager("p", "p", pool);
    let savedPool: KeyPool | null = null;
    mgr.savePool = (p) => { savedPool = { ...p, keys: [...p.keys] }; };
    managers.set("p", mgr);
    const c = ctx("p");

    registerFailover(pi as any, managers as any);
    pi.handlers["after_provider_response"](event(403, "p"), c);

    expect(k1.failed).toBe(true);
    expect(savedPool!.activeId).toBe(k2.id);
    expect(c.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("k1"),
      "warn",
    );
  });

  it("429 → no switch (rate limit is server-side, not auth)", () => {
    const { pi, managers, event, ctx } = setup();
    const pool = makeKeyPool();
    const k1 = { id: generateId(), alias: "k1", key: "x", failed: false };
    pool.keys = [k1];
    pool.activeId = k1.id;
    const mgr = mockManager("p", "p", pool);
    mgr.savePool = vi.fn();
    managers.set("p", mgr);

    registerFailover(pi as any, managers as any);
    pi.handlers["after_provider_response"](event(429, "p"), ctx("p"));

    expect(k1.failed).toBe(false);
    expect(mgr.savePool).not.toHaveBeenCalled();
  });

  it("500 → no switch (server error, not auth)", () => {
    const { pi, managers, event, ctx } = setup();
    const pool = makeKeyPool();
    pool.keys = [{ id: generateId(), alias: "k1", key: "x", failed: false }];
    pool.activeId = pool.keys[0].id;
    const mgr = mockManager("p", "p", pool);
    mgr.savePool = vi.fn();
    managers.set("p", mgr);

    registerFailover(pi as any, managers as any);
    pi.handlers["after_provider_response"](event(500, "p"), ctx("p"));

    expect(pool.keys[0].failed).toBe(false);
    expect(mgr.savePool).not.toHaveBeenCalled();
  });

  it("non-multiKey provider → ignored", () => {
    const { pi, managers, event, ctx } = setup();
    const pool = makeKeyPool();
    pool.keys = [{ id: generateId(), alias: "k1", key: "x", failed: false }];
    pool.activeId = pool.keys[0].id;
    const mgr = mockManager("simple-p", "simple", pool);
    mgr.savePool = vi.fn();
    managers.set("simple-p", mgr);

    // A provider not in managers
    registerFailover(pi as any, managers as any);
    pi.handlers["after_provider_response"](event(401, "unknown-provider"), ctx("unknown-provider"));

    expect(pool.keys[0].failed).toBe(false);
    expect(mgr.savePool).not.toHaveBeenCalled();
  });

  it("all keys failed → error notify, no crash", () => {
    const { pi, managers, event, ctx } = setup();
    const pool = makeKeyPool();
    const k1 = { id: generateId(), alias: "k1", key: "a", failed: false };
    const k2 = { id: generateId(), alias: "k2", key: "b", failed: true };
    pool.keys = [k1, k2];
    pool.activeId = k1.id;
    const mgr = mockManager("p", "p", pool);
    let saved = false;
    mgr.savePool = () => { saved = true; };
    managers.set("p", mgr);
    const c = ctx("p");

    registerFailover(pi as any, managers as any);
    pi.handlers["after_provider_response"](event(401, "p"), c);

    expect(k1.failed).toBe(true);
    expect(pool.activeId).toBe(k1.id); // unchanged (no next key)
    expect(saved).toBe(true);
    expect(c.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("无可用"),
      "error",
    );
  });

  it("empty pool → early return, no crash", () => {
    const { pi, managers, event, ctx } = setup();
    const pool = makeKeyPool(); // empty
    const mgr = mockManager("p", "p", pool);
    mgr.savePool = vi.fn();
    managers.set("p", mgr);

    registerFailover(pi as any, managers as any);
    // should not throw
    pi.handlers["after_provider_response"](event(401, "p"), ctx("p"));

    expect(mgr.savePool).not.toHaveBeenCalled();
  });

  it("ctx.model undefined → early return", () => {
    const { pi, managers, event } = setup();
    const pool = makeKeyPool();
    const mgr = mockManager("p", "p", pool);
    mgr.savePool = vi.fn();
    managers.set("p", mgr);

    registerFailover(pi as any, managers as any);
    pi.handlers["after_provider_response"](event(401), { model: undefined, hasUI: true, ui: { notify: vi.fn() } });

    expect(mgr.savePool).not.toHaveBeenCalled();
  });

  it("hasUI=false → no crash, savePool still called", () => {
    const { pi, managers, event } = setup();
    const pool = makeKeyPool();
    const k1 = { id: generateId(), alias: "k1", key: "a", failed: false };
    const k2 = { id: generateId(), alias: "k2", key: "b", failed: false };
    pool.keys = [k1, k2];
    pool.activeId = k1.id;
    const mgr = mockManager("p", "p", pool);
    let saved = false;
    mgr.savePool = () => { saved = true; };
    managers.set("p", mgr);

    registerFailover(pi as any, managers as any);
    // headless ctx
    pi.handlers["after_provider_response"](event(401, "p"), { model: { provider: "p" }, hasUI: false, ui: undefined });

    expect(k1.failed).toBe(true);
    expect(saved).toBe(true);
  });
});
