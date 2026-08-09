import { test } from "node:test";
import assert from "node:assert/strict";
import { createEntry, validateEntryStructure, isAxiom, AXIOM_RULE_ID } from "../src/memory/entry.ts";

test("createEntry fills defaults (status official, version 1, timestamps)", () => {
  const e = createEntry({ kind: "fact", anchors: ["api"], content: "rate_limit=100" });
  assert.equal(e.status, "official");
  assert.equal(e.meta.version, 1);
  assert.equal(e.meta.hitCount, 0);
  assert.ok(e.id.length > 0);
});

test("validateEntryStructure rejects empty anchors (invariant 5)", () => {
  const e = createEntry({ kind: "fact", anchors: [], content: "x" });
  assert.ok(validateEntryStructure(e).some((s) => s.includes("anchors must be a non-empty string array")));
});

test("ruleRef required for non-axiom kinds", () => {
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "x" });
  delete (e as { ruleRef?: string }).ruleRef;
  assert.ok(validateEntryStructure(e).some((s) => s.includes('ruleRef is required for kind "fact"')));
});

test("axiom is self-referential and exempt from ruleRef", () => {
  const axiom = createEntry({ id: AXIOM_RULE_ID, kind: "axiom", anchors: ["system.root"], content: "axiom content" });
  assert.ok(isAxiom(axiom));
  assert.equal(validateEntryStructure(axiom).length, 0);
});
