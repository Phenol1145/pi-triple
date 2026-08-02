import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { createEntry, AXIOM_RULE_ID } from "../src/memory/entry.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-pipe-"));
  const store = new MemoryStore(dir);
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  // brief 适配（supervisor 裁决 2026-08-02）：规则显式注册为 id "fact-rule"——
  // brief 测试逐字使用 ruleRef: "fact-rule"，Task 3 resolveRule 按 rule entry id 解析
  const rule = createEntry({ id: "fact-rule", kind: "rule", anchors: ["memory.fact"], content: "fact = subject, \"|\", predicate ;\nsubject = word ;\npredicate = word ;", ruleRef: AXIOM_RULE_ID });
  rules.registerRule(rule);
  // brief 适配（supervisor 裁决 2026-08-02）：PipelineDeps 必填 dir（管道文件布局所在）
  const pipe = new MemoryPipeline({ dir, store, rules, trace: { traceId: "t1", transitionSeq: 5 } });
  return { store, rules, pipe, dir, ruleId: rule.id };
}

function readJsonl(dir: string, name: string): unknown[] {
  const file = path.join(dir, name);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("observe allocates idempotencyKey, write is idempotent", () => {
  const { pipe, store, dir } = fresh();
  const key = pipe.observe({ content: "a|b", anchors: ["x"] });
  const r1 = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal(r1.ok, true);
  const r2 = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal(r2.ok, true);
  if (r1.ok && r2.ok) assert.equal(r1.entry.id, r2.entry.id);   // 幂等：同 key 同条目
  assert.equal(store.listIds().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("failed validation goes to draft with TTL and returns errors", () => {
  const { pipe, store, dir } = fresh();
  const r = pipe.write({ idempotencyKey: "k2", kind: "fact", anchors: ["x"], content: "only-one-field", ruleRef: "fact-rule" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  if (!r.ok && r.draft) {
    assert.equal(r.draft.status, "draft");
    assert.ok(r.draft.ttlExpiresAt! > Date.now());
  }
  rmSync(dir, { recursive: true, force: true });
});

test("promote upgrades draft to official with version continuity", () => {
  const { pipe, store, dir } = fresh();
  const r = pipe.write({ idempotencyKey: "k3", kind: "fact", anchors: ["x"], content: "bad", ruleRef: "fact-rule" });
  assert.equal(r.ok, false);
  if (!r.ok && r.draft) {
    const errs = pipe.promote(r.draft.id, "good|pair");
    assert.deepEqual(errs, []);
    const promoted = store.get(r.draft.id)!;
    assert.equal(promoted.status, "official");
    assert.equal(promoted.promotedFrom, r.draft.id);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("successful write attaches source trace", () => {
  const { pipe, store, dir } = fresh();
  const key = pipe.observe({ content: "a|b", anchors: ["x"] });
  const r = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.entry.meta.sourceTraces, [{ traceId: "t1", transitionSeq: 5 }]);
  rmSync(dir, { recursive: true, force: true });
});

// ---- 补充测试（brief 之外，覆盖重试上限/缓冲消费/事件顺序）----

test("retry limit: 3rd failure sinks directly to draft, counter caps at 2", () => {
  const { pipe, store, dir } = fresh();
  const key = pipe.observe({ content: "bad", anchors: ["x"] });
  const r1 = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "bad", ruleRef: "fact-rule" });
  const r2 = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "bad", ruleRef: "fact-rule" });
  const r3 = pipe.write({ idempotencyKey: key, kind: "fact", anchors: ["x"], content: "bad", ruleRef: "fact-rule" });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(r3.ok, false);
  if (!r1.ok && !r2.ok && !r3.ok) {
    assert.ok(r1.draft && r2.draft && r3.draft);      // 不静默丢：每次都进草稿区
    assert.ok(r3.errors.some((e) => e.includes("retry limit"))); // 第 3 次起走熔断路径
    assert.equal(store.listIds().length, 3);          // 每次失败 = 独立草稿条目
    const recs = readJsonl(dir, "retry-count.jsonl") as Array<{ key: string; count: number }>;
    const rec = recs.find((x) => x.key === key);
    assert.equal(rec?.count, 2);                      // 计数封顶 2（第 3 次不再计数）
    const consumed = readJsonl(dir, "buffer-consumed.jsonl") as Array<{ key: string }>;
    assert.equal(consumed.some((c) => c.key === key), false); // 失败不产生消费标记
  }
  rmSync(dir, { recursive: true, force: true });
});

test("flushBuffer drops consumed observations, keeps markers", () => {
  const { pipe, dir } = fresh();
  const k1 = pipe.observe({ content: "a|b", anchors: ["x"] });
  const k2 = pipe.observe({ content: "c|d", anchors: ["y"] });
  const r = pipe.write({ idempotencyKey: k1, kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal(r.ok, true);
  pipe.flushBuffer();
  const buffer = readJsonl(dir, "buffer.jsonl") as Array<{ key: string }>;
  assert.equal(buffer.length, 1);
  assert.equal(buffer[0].key, k2);                    // k1 已消费移除，k2 保留
  const consumed = readJsonl(dir, "buffer-consumed.jsonl") as Array<{ key: string }>;
  assert.ok(consumed.some((c) => c.key === k1));      // 消费标记保留（不重置）
  rmSync(dir, { recursive: true, force: true });
});

test("promote assigns new idempotencyKey, merges draft traces, clears TTL", () => {
  const { pipe, store, dir } = fresh();
  const r = pipe.write({ idempotencyKey: "k4", kind: "fact", anchors: ["x"], content: "bad", ruleRef: "fact-rule" });
  assert.equal(r.ok, false);
  if (!r.ok && r.draft) {
    const errs = pipe.promote(r.draft.id, "good|pair");
    assert.deepEqual(errs, []);
    const promoted = store.get(r.draft.id)!;
    assert.equal(promoted.meta.version, 2);           // 同 id 新版本（version 延续）
    assert.ok(promoted.idempotencyKey && promoted.idempotencyKey !== "k4"); // 新 idempotencyKey
    assert.equal(promoted.ttlExpiresAt, undefined);   // 草稿 TTL 使命结束
    assert.deepEqual(promoted.meta.sourceTraces, []); // 草稿 sourceTraces 并入（不新增）
    const idem = readJsonl(dir, "idem.jsonl") as Array<{ key: string; entryId: string }>;
    assert.ok(idem.some((i) => i.key === promoted.idempotencyKey && i.entryId === r.draft!.id)); // 新 key 注册幂等表
  }
  rmSync(dir, { recursive: true, force: true });
});

test("onEvent fires after write success and failure (persist before event)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-pipe-"));
  const store = new MemoryStore(dir);
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  const rule = createEntry({ kind: "rule", anchors: ["memory.fact"], content: "fact = subject, \"|\", predicate ;\nsubject = word ;\npredicate = word ;", ruleRef: AXIOM_RULE_ID });
  rules.registerRule(rule);
  const events: Array<{ type: string; ok: boolean; entryId: string; persisted: boolean }> = [];
  const pipe = new MemoryPipeline({
    dir, store, rules,
    trace: { traceId: "t1", transitionSeq: 5 },
    onEvent: (ev) => events.push({ type: ev.type, ok: ev.ok, entryId: ev.entryId, persisted: store.get(ev.entryId) !== undefined }),
  });
  const ok = pipe.write({ idempotencyKey: "e1", kind: "fact", anchors: ["x"], content: "a|b", ruleRef: rule.id });
  assert.equal(ok.ok, true);
  const bad = pipe.write({ idempotencyKey: "e2", kind: "fact", anchors: ["x"], content: "bad", ruleRef: rule.id });
  assert.equal(bad.ok, false);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "memory_tx");
  assert.equal(events[0].ok, true);
  assert.equal(events[1].ok, false);
  assert.ok(events.every((ev) => ev.persisted));      // 先落库、后发事件
  rmSync(dir, { recursive: true, force: true });
});
