import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createEntry, AXIOM_RULE_ID } from "../src/memory/entry.ts";

test("RuleBootstrap resolves seeded rule from public domain", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-rb-"));
  const rb = new RuleBootstrap(dir);
  rb.ensureInitialized(); // ensureInitialized 委托 PublicDomainBootstrap（幂等种子）
  const axiom = rb.resolveRule("axiom"); // 公理条目（kind=axiom）不参与校验链——钉死：返回 undefined
  assert.equal(axiom, undefined);
  const factRule = rb.resolveRule("rule:fact");
  assert.ok(factRule !== undefined); // 种子 fact 规则可解析
  assert.equal(factRule!.ruleId, "rule:fact");
  rmSync(dir, { recursive: true, force: true });
});

test("RuleRegistry fallback chain: private first, then public", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-rb2-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  const rb = new RuleBootstrap(dir);
  const registry = new RuleRegistry(path.join(dir, "private"), {
    resolveRule: (id) => rb.resolveRule(id),
  });
  // 私域无 rule:fact → fallback 命中公域种子
  assert.ok(registry.resolveRule("rule:fact") !== undefined);
  // 私域自建规则优先（本目录未命中才走 fallback）
  const own = registry.registerRule(
    createEntry({
      id: "rule:own",
      kind: "rule",
      anchors: ["own"],
      content: "fact = word ;",
      ruleRef: AXIOM_RULE_ID,
    }),
  );
  assert.deepEqual(own, []);
  assert.equal(registry.resolveRule("rule:own")!.ruleId, "rule:own");
  rmSync(dir, { recursive: true, force: true });
});

test("private rule shadows public rule with same id (fallback only on local miss)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-rb3-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  const rb = new RuleBootstrap(dir);
  const registry = new RuleRegistry(path.join(dir, "private"), {
    resolveRule: (id) => rb.resolveRule(id),
  });
  // 私域自建同 id 规则（内容与公域种子不同）——解析必须命中私域版本
  const own = registry.registerRule(
    createEntry({
      id: "rule:fact",
      kind: "rule",
      anchors: ["own"],
      content: "fact = word ;",
      ruleRef: AXIOM_RULE_ID,
    }),
  );
  assert.deepEqual(own, []);
  const compiled = registry.resolveRule("rule:fact")!;
  assert.equal(compiled.ruleId, "rule:fact");
  assert.equal(compiled.ebnfText, "fact = word ;"); // 私域版本优先（公域种子为 4 行 fact 语法）
  rmSync(dir, { recursive: true, force: true });
});

test("RuleBootstrap returns undefined for public rule with invalid EBNF / missing rule", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-rb4-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  // 坏 EBNF 的 rule 直接写公域（与种子同布局，绕过审核链——MemoryStore 直写）
  const store = new MemoryStore(dir);
  store.write(
    createEntry({
      id: "rule:broken",
      kind: "rule",
      anchors: ["system.rules"],
      ruleRef: AXIOM_RULE_ID,
      content: "fact = ;",
      status: "official",
    }),
  );
  const rb = new RuleBootstrap(dir);
  assert.equal(rb.resolveRule("rule:broken"), undefined); // 编译失败 → undefined
  assert.equal(rb.resolveRule("missing-rule"), undefined); // 不存在 → undefined
  rmSync(dir, { recursive: true, force: true });
});
