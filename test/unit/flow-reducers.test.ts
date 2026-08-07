import { describe, it, expect } from "vitest";
import { parseStateField, applyReducer, VALID_REDUCERS } from "../../packages/framework/src/flow/reducers.js";

describe("parseStateField", () => {
  it("bare value → last-wins", () => {
    const f = parseStateField("hello");
    expect(f.initial).toBe("hello");
    expect(f.reducer).toBe("last-wins");
  });

  it("bare number → last-wins", () => {
    const f = parseStateField(42);
    expect(f.initial).toBe(42);
    expect(f.reducer).toBe("last-wins");
  });

  it("bare array → last-wins", () => {
    const f = parseStateField([1, 2, 3]);
    expect(f.initial).toEqual([1, 2, 3]);
    expect(f.reducer).toBe("last-wins");
  });

  it("object with initial + reducer", () => {
    const f = parseStateField({ initial: [], reducer: "append" });
    expect(f.initial).toEqual([]);
    expect(f.reducer).toBe("append");
  });

  it("object without reducer defaults to last-wins", () => {
    const f = parseStateField({ initial: "val" });
    expect(f.reducer).toBe("last-wins");
  });

  it("null → undefined initial, last-wins", () => {
    const f = parseStateField(null);
    expect(f.initial).toBeUndefined();
    expect(f.reducer).toBe("last-wins");
  });
});

describe("applyReducer", () => {
  it("last-wins single writer → returns value", () => {
    const result = applyReducer("last-wins", "old", [{ node: "a", value: "new" }]);
    expect(result).toBe("new");
  });

  it("last-wins multi-writer → last by nodeId sort", () => {
    const result = applyReducer("last-wins", "old", [
      { node: "z", value: "z-val" },
      { node: "a", value: "a-val" },
      { node: "m", value: "m-val" },
    ]);
    expect(result).toBe("z-val"); // z > m > a in sort
  });

  it("append → adds {node, value} objects sorted by nodeId", () => {
    const result = applyReducer("append", [], [
      { node: "review-kimi", value: "kimis output" },
      { node: "review-ds", value: "ds output" },
    ]);
    expect(result).toEqual([
      { node: "review-ds", value: "ds output" },
      { node: "review-kimi", value: "kimis output" },
    ]);
  });

  it("append preserves existing array", () => {
    const result = applyReducer("append", [{ node: "old", value: "x" }], [
      { node: "b", value: "y" },
    ]);
    expect(result).toEqual([
      { node: "old", value: "x" },
      { node: "b", value: "y" },
    ]);
  });

  it("concat → joins strings with separator sorted by nodeId", () => {
    const result = applyReducer("concat", "existing", [
      { node: "b", value: "second" },
      { node: "a", value: "first" },
    ]);
    expect(result).toBe("existing\n\n---\n\nfirst\n\n---\n\nsecond");
  });

  it("concat skips empty/null values", () => {
    const result = applyReducer("concat", "", [
      { node: "a", value: "hello" },
      { node: "b", value: null },
      { node: "c", value: "" },
    ]);
    expect(result).toBe("hello");
  });

  it("empty additions → returns current unchanged", () => {
    const result = applyReducer("append", [1], []);
    expect(result).toEqual([1]);
  });

  it("VALID_REDUCERS contains the three reducers", () => {
    expect(VALID_REDUCERS.has("last-wins")).toBe(true);
    expect(VALID_REDUCERS.has("append")).toBe(true);
    expect(VALID_REDUCERS.has("concat")).toBe(true);
    expect(VALID_REDUCERS.has("invalid")).toBe(false);
  });
});
