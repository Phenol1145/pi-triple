import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuleRegistry } from "../src/memory/rules.ts";
import { createEntry, AXIOM_RULE_ID } from "../src/memory/entry.ts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mem-rules-"));
}

test("bootstrapAxiom writes the unique axiom entry", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  assert.ok(r.resolveRule(AXIOM_RULE_ID));
});

test("registerRule compiles EBNF and validates conforming content", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const rule = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: 'fact = subject, "|", predicate ;\nsubject = word ;\npredicate = word ;',
    ruleRef: AXIOM_RULE_ID,
  });
  assert.deepEqual(r.registerRule(rule), []);
  const fact = createEntry({ kind: "fact", anchors: ["a"], content: "x|y", ruleRef: rule.id });
  assert.deepEqual(r.validateContent(fact), []);
  const bad = createEntry({ kind: "fact", anchors: ["a"], content: "x", ruleRef: rule.id });
  assert.ok(r.validateContent(bad).length > 0);
});

test("updateRule rejects invalid EBNF atomically (old version intact)", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const rule = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: "fact = word ;",
    ruleRef: AXIOM_RULE_ID,
  });
  r.registerRule(rule);
  const v1 = r.resolveRule(rule.id)!;
  const badUpdate = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: "fact = ;",
    ruleRef: AXIOM_RULE_ID,
    id: rule.id,
  });
  const errs = r.updateRule(badUpdate);
  assert.ok(errs.length > 0);
  assert.equal(r.resolveRule(rule.id)!.version, v1.version);
});

test("bootstrapAxiom is idempotent", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const v1 = r.resolveRule(AXIOM_RULE_ID)!;
  r.bootstrapAxiom();
  const v2 = r.resolveRule(AXIOM_RULE_ID)!;
  assert.equal(v1.version, v2.version);
});

test("registerRule rejects non-rule kind", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const entry = createEntry({ kind: "fact", anchors: ["a"], content: "x", ruleRef: AXIOM_RULE_ID });
  const errs = r.registerRule(entry);
  assert.ok(errs.length > 0);
  assert.ok(errs.some((e) => e.includes("kind must be")));
});

test("registerRule rejects invalid EBNF", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const rule = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: "fact = ;",
    ruleRef: AXIOM_RULE_ID,
  });
  const errs = r.registerRule(rule);
  assert.ok(errs.length > 0);
});

test("resolveRule returns undefined for unregistered rule", () => {
  const r = new RuleRegistry(freshDir());
  assert.equal(r.resolveRule("nonexistent"), undefined);
});

test("updateRule increments version on success", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const rule = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: "fact = word ;",
    ruleRef: AXIOM_RULE_ID,
  });
  r.registerRule(rule);
  const v1 = r.resolveRule(rule.id)!.version;
  const updated = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: "fact = word, word ;",
    ruleRef: AXIOM_RULE_ID,
    id: rule.id,
  });
  const errs = r.updateRule(updated);
  assert.deepEqual(errs, []);
  assert.equal(r.resolveRule(rule.id)!.version, v1 + 1);
});

test("validateContent returns error for unregistered ruleRef", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const entry = createEntry({ kind: "fact", anchors: ["a"], content: "x", ruleRef: "nonexistent" });
  const errs = r.validateContent(entry);
  assert.ok(errs.some((e) => e.includes("rule not found: nonexistent")));
});

test("updateRule succeeds with valid EBNF and atomically writes", () => {
  const r = new RuleRegistry(freshDir());
  r.bootstrapAxiom();
  const rule = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: "fact = word ;",
    ruleRef: AXIOM_RULE_ID,
  });
  r.registerRule(rule);
  const updated = createEntry({
    kind: "rule",
    anchors: ["memory.fact"],
    content: "fact = word, word ;",
    ruleRef: AXIOM_RULE_ID,
    id: rule.id,
  });
  const errs = r.updateRule(updated);
  assert.deepEqual(errs, []);
  const compiled = r.resolveRule(rule.id)!;
  assert.equal(compiled.version, 2);
  assert.equal(compiled.grammar.productions[0].name, "fact");
});

test("validateContent returns compilation error for rule with invalid EBNF cached", () => {
  const dir = freshDir();
  const reg = new RuleRegistry(dir);
  reg.bootstrapAxiom();
  const ruleId = "broken-rule";
  const ruleEntry = createEntry({
    kind: "rule",
    anchors: ["a"],
    content: "fact = ;",
    ruleRef: AXIOM_RULE_ID,
    id: ruleId,
  });
  // Manually write a rule file with invalid EBNF and no compiled cache
  const rulesDir = path.join(dir, "rules");
  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  writeFileSync(path.join(rulesDir, `${ruleId}.json`), JSON.stringify({ entry: ruleEntry }));
  const entry = createEntry({ kind: "fact", anchors: ["a"], content: "x", ruleRef: ruleId });
  const errs = reg.validateContent(entry);
  assert.ok(errs.length > 0);
});
