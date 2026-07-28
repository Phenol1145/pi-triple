import { describe, it, expect } from "vitest";
import {
  makeKeyPool,
  generateId,
  getActiveKey,
  getNextAvailableKey,
} from "../../extensions/pit-providers/keypool.js";

describe("keypool", () => {
  describe("makeKeyPool", () => {
    it("returns empty pool", () => {
      const pool = makeKeyPool();
      expect(pool.keys).toEqual([]);
      expect(pool.activeId).toBe("");
    });
  });

  describe("generateId", () => {
    it("returns 8-char hex string", () => {
      const id = generateId();
      expect(id).toHaveLength(8);
      expect(id).toMatch(/^[0-9a-f]+$/);
    });

    it("generates unique ids", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("getActiveKey", () => {
    it("returns active key by activeId", () => {
      const pool = {
        keys: [
          { id: "a", alias: "a", key: "k1", failed: false },
          { id: "b", alias: "b", key: "k2", failed: false },
        ],
        activeId: "b",
      };
      const active = getActiveKey(pool);
      expect(active?.id).toBe("b");
      expect(active?.key).toBe("k2");
    });

    it("returns undefined when activeId not in pool", () => {
      const pool = {
        keys: [{ id: "a", alias: "a", key: "k1", failed: false }],
        activeId: "ghost",
      };
      expect(getActiveKey(pool)).toBeUndefined();
    });

    it("returns undefined for empty pool", () => {
      const pool = makeKeyPool();
      expect(getActiveKey(pool)).toBeUndefined();
    });
  });

  describe("getNextAvailableKey", () => {
    it("branch 1: active exists and not failed → return active", () => {
      const pool = {
        keys: [
          { id: "a", alias: "a", key: "k1", failed: false },
          { id: "b", alias: "b", key: "k2", failed: false },
        ],
        activeId: "a",
      };
      expect(getNextAvailableKey(pool)?.id).toBe("a");
    });

    it("branch 2: active failed → return first non-failed key", () => {
      const pool = {
        keys: [
          { id: "a", alias: "a", key: "k1", failed: true },
          { id: "b", alias: "b", key: "k2", failed: false },
        ],
        activeId: "a",
      };
      expect(getNextAvailableKey(pool)?.id).toBe("b");
    });

    it("branch 3: active not found, first non-failed", () => {
      const pool = {
        keys: [
          { id: "a", alias: "a", key: "k1", failed: true },
          { id: "b", alias: "b", key: "k2", failed: false },
        ],
        activeId: "ghost",
      };
      expect(getNextAvailableKey(pool)?.id).toBe("b");
    });

    it("branch 4: all keys failed → undefined", () => {
      const pool = {
        keys: [
          { id: "a", alias: "a", key: "k1", failed: true },
          { id: "b", alias: "b", key: "k2", failed: true },
        ],
        activeId: "a",
      };
      expect(getNextAvailableKey(pool)).toBeUndefined();
    });

    it("empty pool → undefined", () => {
      const pool = makeKeyPool();
      expect(getNextAvailableKey(pool)).toBeUndefined();
    });

    it("does NOT mutate pool", () => {
      const pool = {
        keys: [
          { id: "a", alias: "a", key: "k1", failed: true },
          { id: "b", alias: "b", key: "k2", failed: false },
        ],
        activeId: "a",
      };
      const before = JSON.stringify(pool);
      getNextAvailableKey(pool);
      expect(JSON.stringify(pool)).toBe(before);
    });
  });
});
