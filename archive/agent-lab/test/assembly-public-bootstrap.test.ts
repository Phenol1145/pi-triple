import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { PublicDomainStore } from "../src/memory/public-domain.ts";
import { parseEbnf, validateAgainstGrammar } from "../src/memory/ebnf.ts";

test("ensureInitialized seeds axiom + base rules idempotently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-pub-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  pb.ensureInitialized();   // 幂等（不重复）
  const store = new PublicDomainStore(dir);
  const entries = store.listOfficialEntries();
  assert.ok(entries.length >= 3);                     // 公理 + fact 规则 + experience/preference 规则
  assert.ok(entries.some((e) => e.kind === "axiom"));
  assert.ok(entries.filter((e) => e.kind === "rule").length >= 2);
  rmSync(dir, { recursive: true, force: true });
});

test("rule:experience 种子 grammar 为行式 7 字段（D3：经验沉淀真实过校验非草稿区）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-pub-exp-"));
  try {
    new PublicDomainBootstrap(dir).ensureInitialized();
    const store = new PublicDomainStore(dir);
    const expRule = store.listOfficialEntries().find((e) => e.id === "rule:experience");
    assert.ok(expRule, "rule:experience 种子存在");
    // 编译 grammar → 7 字段行式样本过、markdown 拒
    const g = parseEbnf(expRule.content);
    assert.ok(g.ok, "rule:experience grammar 可解析");
    for (const ok of ["execution|code-1|a1|execute|0.9|22.8|-", "review|c|r1|review|0.7|9.5|ground-truth", "org_default|c|m|-|-|-|-"]) {
      assert.deepEqual(validateAgainstGrammar(g.grammar, "experience", ok), [], `过: ${ok}`);
    }
    assert.ok(validateAgainstGrammar(g.grammar, "experience", "## note\nhello").length > 0, "markdown 拒");
    assert.ok(validateAgainstGrammar(g.grammar, "experience", "single-field").length > 0, "单字段拒（7 字段序列）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
