import { describe, it, expect } from "vitest";
import { evalExpr, parseExpr, ExprError } from "../../packages/framework/src/flow/expr.js";

describe("flow-expr parseExpr (static validation)", () => {
  it("valid simple eq", () => {
    const r = parseExpr("state.x == true");
    expect(r.ok).toBe(true);
  });

  it("valid contains", () => {
    const r = parseExpr('state.x contains "needle"');
    expect(r.ok).toBe(true);
  });

  it("valid !contains", () => {
    const r = parseExpr('state.x !contains "needle"');
    expect(r.ok).toBe(true);
  });

  it("valid nested path", () => {
    const r = parseExpr("state.a.b.c == 42");
    expect(r.ok).toBe(true);
  });

  it("invalid: missing operand", () => {
    const r = parseExpr("state.x ==");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Expected operand");
  });

  it("invalid: unknown keyword", () => {
    const r = parseExpr("foo == 1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Unknown identifier");
  });

  it("valid with spaces", () => {
    const r = parseExpr("  state.x   ==   42  ");
    expect(r.ok).toBe(true);
  });

  it("valid string literal with single quotes", () => {
    const r = parseExpr("state.x == 'hello world'");
    expect(r.ok).toBe(true);
  });
});

describe("flow-expr evalExpr", () => {
  // ── Strict equality ──────────────────────────────────────
  it("strict equality: same type same value", () => {
    expect(evalExpr("state.x == 42", { x: 42 })).toBe(true);
  });

  it("strict inequality: string != number", () => {
    expect(evalExpr("state.x == 2", { x: "2" })).toBe(false);
    expect(evalExpr("state.x == 2", { x: 2 })).toBe(true);
  });

  it("!= operator", () => {
    expect(evalExpr("state.x != 1", { x: 2 })).toBe(true);
    expect(evalExpr("state.x != 2", { x: 2 })).toBe(false);
  });

  it("strict !=: string vs number", () => {
    expect(evalExpr("state.x != 2", { x: "2" })).toBe(true); // "2" !== 2
  });

  it("boolean literal vs state string", () => {
    expect(evalExpr("state.x == true", { x: true })).toBe(true);
    expect(evalExpr("state.x == true", { x: "true" })).toBe(false);
  });

  // ── Number comparisons ───────────────────────────────────
  it("> with numbers", () => {
    expect(evalExpr("state.x > 5", { x: 10 })).toBe(true);
    expect(evalExpr("state.x > 15", { x: 10 })).toBe(false);
  });

  it(">= >= <= <", () => {
    expect(evalExpr("state.x >= 5", { x: 5 })).toBe(true);
    expect(evalExpr("state.x <= 5", { x: 5 })).toBe(true);
    expect(evalExpr("state.x < 5", { x: 5 })).toBe(false);
  });

  it("> with non-number throws ExprError", () => {
    expect(() => evalExpr("state.x > 5", { x: "ten" })).toThrow(ExprError);
    expect(() => evalExpr("state.x > 5", { x: "ten" })).toThrow("> requires numbers");
  });

  it("< with non-number throws ExprError", () => {
    expect(() => evalExpr("state.x < 5", { x: true })).toThrow(ExprError);
  });

  it("<= with non-number throws ExprError", () => {
    expect(() => evalExpr("state.x <= 5", { x: {} })).toThrow(ExprError);
  });

  // ── contains ─────────────────────────────────────────────
  it("contains: true", () => {
    expect(evalExpr("state.x contains 'hello'", { x: "hello world" })).toBe(true);
  });

  it("contains: false", () => {
    expect(evalExpr("state.x contains 'xyz'", { x: "hello" })).toBe(false);
  });

  it("contains coerces to string", () => {
    expect(evalExpr("state.x contains '3'", { x: 123 })).toBe(true);
  });

  it("!contains", () => {
    expect(evalExpr("state.x !contains 'xyz'", { x: "hello" })).toBe(true);
    expect(evalExpr("state.x !contains 'he'", { x: "hello" })).toBe(false);
  });

  // ── Not operator ─────────────────────────────────────────
  it("! prefix", () => {
    expect(evalExpr("!state.x", { x: false })).toBe(true);
    expect(evalExpr("!state.x", { x: true })).toBe(false);
    expect(evalExpr("!state.x", { x: 0 })).toBe(true);
  });

  // ── Boolean literals ─────────────────────────────────────
  it("true/false literal comparison", () => {
    expect(evalExpr("state.x == true", { x: true })).toBe(true);
    expect(evalExpr("state.x == false", { x: false })).toBe(true);
    expect(evalExpr("state.x == true", { x: false })).toBe(false);
  });

  // ── Nested paths ─────────────────────────────────────────
  it("nested state path", () => {
    expect(evalExpr("state.a.b.c == 42", { a: { b: { c: 42 } } })).toBe(true);
    expect(evalExpr("state.a.b.c == 42", { a: { b: { c: 99 } } })).toBe(false);
  });

  it("nested path missing intermediate", () => {
    // undefined == true → false
    expect(evalExpr("state.a.b.c == true", { a: {} })).toBe(false);
  });

  // ── Combined operators ───────────────────────────────────
  it("operator precedence: not binds tighter than comparison", () => {
    // !state.x != 42 = (!state.x) != 42
    expect(evalExpr("!state.x != 1", { x: false })).toBe(true);  // !false=1 → 1!=1→false? no: !false=true, true!==1→true
    expect(evalExpr("!state.x != 1", { x: true })).toBe(true);   // !true=false, false!==1→true
  });

  // ── Error cases ──────────────────────────────────────────
  it("invalid expression syntax", () => {
    expect(() => evalExpr("state.x @@ 1", { x: 1 })).toThrow(ExprError);
  });

  it("empty string", () => {
    expect(() => evalExpr("", { x: 1 })).toThrow(ExprError);
  });
});
