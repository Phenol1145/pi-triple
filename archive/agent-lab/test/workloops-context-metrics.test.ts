import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, contextTokenTotal } from "../src/workloops/context-metrics.ts";
import type { WorkContext } from "../src/workloop/contracts.ts";

// ── helpers ──────────────────────────────────────────────────────────

function ctx(overrides: Partial<WorkContext> = {}): WorkContext {
  return {
    systemPrompt: undefined,
    messages: [],
    metadata: {
      contextId: "test-ctx",
      sourceRefs: [],
      artifactRefs: [],
    },
    ...overrides,
  };
}

// ── estimateTokens ──────────────────────────────────────────────────

test("estimateTokens: empty string → 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens: undefined → 0", () => {
  assert.equal(estimateTokens(undefined), 0);
});

test("estimateTokens: null → 0", () => {
  assert.equal(estimateTokens(null), 0);
});

test("estimateTokens: 4-char string → 1", () => {
  assert.equal(estimateTokens("abcd"), 1);
});

test("estimateTokens: 5-char string → 2 (ceil)", () => {
  assert.equal(estimateTokens("abcde"), 2);
});

test("estimateTokens: monotonic — longer string → >= shorter string", () => {
  const short = estimateTokens("hello");
  const long = estimateTokens("hello world this is a longer string");
  assert.ok(long >= short, `longer string should have >= tokens: ${long} vs ${short}`);
});

test("estimateTokens: number → JSON-stringified estimate", () => {
  assert.ok(estimateTokens(42) > 0);
});

test("estimateTokens: boolean → JSON-stringified estimate", () => {
  assert.ok(estimateTokens(true) > 0);
});

test("estimateTokens: empty object → small estimate", () => {
  assert.equal(estimateTokens({}), 1); // "{}" = 2 chars → ceil(2/4) = 1
});

test("estimateTokens: structured object → scales with content", () => {
  const small = estimateTokens({ a: 1 });
  const large = estimateTokens({ a: 1, b: "hello world", c: [1, 2, 3], d: { nested: true } });
  assert.ok(large > small, `structured object should scale: ${large} > ${small}`);
});

test("estimateTokens: array → estimates JSON representation", () => {
  const tokens = estimateTokens([1, 2, 3]);
  assert.ok(tokens > 0);
});

test("estimateTokens: cyclic object → 0 (fallback)", () => {
  const obj: Record<string, unknown> = {};
  obj.self = obj;
  assert.equal(estimateTokens(obj), 0);
});

test("estimateTokens: non-negative for valid inputs", () => {
  const cases: unknown[] = ["text", "", 0, false, null, undefined, {}, [], { key: "val" }];
  for (const c of cases) {
    assert.ok(estimateTokens(c) >= 0, `estimateTokens(${JSON.stringify(c)}) should be >= 0`);
  }
});

// ── contextTokenTotal ───────────────────────────────────────────────

test("contextTokenTotal: empty context → 0", () => {
  assert.equal(contextTokenTotal(ctx()), 0);
});

test("contextTokenTotal: includes systemPrompt", () => {
  const c = ctx({ systemPrompt: "You are helpful.", messages: [] });
  const total = contextTokenTotal(c);
  // "You are helpful." = 16 chars → ceil(16/4) = 4
  assert.equal(total, 4);
});

test("contextTokenTotal: includes messages content", () => {
  const c = ctx({
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
  });
  const total = contextTokenTotal(c);
  // "hello" = 5 → 2, "world" = 5 → 2, total = 4
  assert.equal(total, 4);
});

test("contextTokenTotal: systemPrompt + messages sum correctly", () => {
  const c = ctx({
    systemPrompt: "abc", // 3 chars → ceil(3/4) = 1
    messages: [
      { role: "user", content: "1234" }, // 4 → 1
    ],
  });
  assert.equal(contextTokenTotal(c), 2);
});

test("contextTokenTotal: monotonic — more messages → >= fewer", () => {
  const base = ctx({
    systemPrompt: "sys",
    messages: [{ role: "user", content: "msg1" }],
  });
  const extended = ctx({
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2 longer" },
    ],
  });
  assert.ok(
    contextTokenTotal(extended) >= contextTokenTotal(base),
    "adding messages should not decrease total",
  );
});

test("contextTokenTotal: message with structured content works", () => {
  const c = ctx({
    messages: [{ role: "user", content: { key: "value" } }],
  });
  assert.ok(contextTokenTotal(c) > 0);
});
