import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEbnf, validateAgainstGrammar } from "../src/memory/ebnf.ts";

const FACT_GRAMMAR = `
fact = subject, "|", predicate, "|", object, "|", confidence, "?" ;
subject = word ;
predicate = word ;
object = word | number ;
confidence = number (* min=0 max=1 *) ;
`;

test("parses valid grammar", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.grammar.productions.length, 5);
});

test("reports parse error with line/column", () => {
  const r = parseEbnf("fact = subject, ;\nsubject = word ;");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors[0].line >= 1);
    assert.ok(r.errors[0].message.length > 0);
  }
});

test("validates conforming entry", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  const errs = validateAgainstGrammar(r.grammar, "fact", "api|limits|100|0.5");
  assert.deepEqual(errs, []);
});

test("validates non-conforming entry with production-level error", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  const errs = validateAgainstGrammar(r.grammar, "fact", "api|limits|100|1.5");  // confidence 超界
  assert.ok(errs.some((s) => s.includes("fact") && s.includes("confidence")));
});

test("supports optional field (?)", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  assert.deepEqual(validateAgainstGrammar(r.grammar, "fact", "api|limits|100"), []);
});

// ---- 补充：v1 子集其余语义 ----

const LIST_GRAMMAR = `
line = item, "*" ;
line2 = item, "+" ;
item = word ;
`;

test("supports repeat * and +", () => {
  const r = parseEbnf(LIST_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  assert.deepEqual(validateAgainstGrammar(r.grammar, "line", "a|b|c"), []);
  assert.deepEqual(validateAgainstGrammar(r.grammar, "line2", "a|b"), []);
});

test("reports missing required field with position", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  const errs = validateAgainstGrammar(r.grammar, "fact", "api");
  assert.ok(errs.some((s) => s.includes("fact") && s.includes("第 2 项") && s.includes("predicate")));
});

test("reports unknown main rule", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  const errs = validateAgainstGrammar(r.grammar, "nope", "x");
  assert.ok(errs.length > 0 && errs[0].includes("nope"));
});

test("validates every line of multi-line input", () => {
  const r = parseEbnf(FACT_GRAMMAR);
  if (!r.ok) throw new Error("grammar parse failed");
  assert.deepEqual(validateAgainstGrammar(r.grammar, "fact", "api|limits|100|0.5\napi|limits|100"), []);
  const errs = validateAgainstGrammar(r.grammar, "fact", "api|limits|100|0.5\napi|limits|100|1.5");
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes("confidence"));
});

test("syntax error carries 1-based column", () => {
  const r = parseEbnf("fact = subject, ;");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.errors[0].line, 1);
    assert.ok(r.errors[0].column >= 1);
  }
});
