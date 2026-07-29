import { describe, it, expect } from "vitest";
import { interpolate } from "../../src/ptl/flow/template.js";

describe("flow-template", () => {
  it("input 插值", () => {
    expect(interpolate("repo={{input.pr}}", { state: {}, input: { pr: "42" } })).toBe("repo=42");
  });

  it("state 插值（单层）", () => {
    expect(interpolate("v={{state.x}}", { state: { x: "hello" }, input: {} })).toBe("v=hello");
  });

  it("state 嵌套路径", () => {
    expect(
      interpolate("{{state.a.b.c}}", { state: { a: { b: { c: "deep" } } }, input: {} }),
    ).toBe("deep");
  });

  it("缺失 input key → 空串", () => {
    expect(interpolate("x={{input.missing}}", { state: {}, input: {} })).toBe("x=");
  });

  it("缺失 state 路径 → 空串", () => {
    expect(interpolate("x={{state.a.missing}}", { state: { a: {} }, input: {} })).toBe("x=");
  });

  it("state 中间值为 null → 空串", () => {
    expect(interpolate("x={{state.a.b}}", { state: { a: null }, input: {} })).toBe("x=");
  });

  it("state 中间值非对象 → 空串", () => {
    expect(interpolate("x={{state.a.b}}", { state: { a: "string" }, input: {} })).toBe("x=");
  });

  it("多个占位符", () => {
    expect(
      interpolate(
        "分析 PR {{input.pr}} 的变更: {{state.analysis}}",
        { state: { analysis: "result" }, input: { pr: "42" } },
      ),
    ).toBe("分析 PR 42 的变更: result");
  });

  it("不认识的占位符原样保留", () => {
    expect(interpolate("{{unknown}}", { state: {}, input: {} })).toBe("{{unknown}}");
  });

  it("state 值为数字 → string 化", () => {
    expect(interpolate("{{state.count}}", { state: { count: 5 }, input: {} })).toBe("5");
  });

  it("state 值为 true → string 化", () => {
    expect(interpolate("{{state.ok}}", { state: { ok: true }, input: {} })).toBe("true");
  });
});
