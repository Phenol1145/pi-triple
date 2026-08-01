import { describe, it, expect } from "vitest";
import { registerCodeFn, resolveCodeFn, listCodeFns, type CodeFn } from "../../src/ptl/flow/code-registry.js";

describe("FlowCodeRegistry", () => {
  it("registers and resolves a fn", () => {
    const fn: CodeFn = async (args) => args;
    registerCodeFn("market.score", fn);
    expect(resolveCodeFn("market.score")).toBe(fn);
  });

  it("rejects duplicate registration", () => {
    registerCodeFn("t.dup", () => 1);
    expect(() => registerCodeFn("t.dup", () => 2)).toThrow(/already registered: t\.dup/);
  });

  it("returns undefined for unknown fn", () => {
    expect(resolveCodeFn("nope.missing")).toBeUndefined();
  });

  it("lists registered names", () => {
    registerCodeFn("t.list.a", () => 1);
    expect(listCodeFns()).toContain("t.list.a");
  });
});
