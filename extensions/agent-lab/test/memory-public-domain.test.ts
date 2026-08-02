import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicDomainStore } from "../src/memory/public-domain.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createEntry } from "../src/memory/entry.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-pub-"));
  return { pub: new PublicDomainStore(dir), dir };
}

// ---- brief 测试（test 1-3 逐字；test 4 语义修正见其注释） ----

test("fork copies entries and returns generation", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const g = pub.fork(dir);
  assert.equal(g, 0);
  assert.equal(new MemoryStore(dir).get("e1")?.content, "x");
  rmSync(dir, { recursive: true, force: true });
});

test("submitWriteBack fast-forwards disjoint delta", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["b"], content: "y", id: "e2" })] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.generation, base + 1);
  assert.equal(new MemoryStore(dir).get("e2")?.content, "y");
  rmSync(dir, { recursive: true, force: true });
});

test("submitWriteBack rejects overlapping id (conflict)", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["a"], content: "changed", id: "e1" })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "overlap");
  rmSync(dir, { recursive: true, force: true });
});

test("stale generation rejected", () => {
  // brief 原案：空库 fork 后以 base 0 提交，期望 generation-stale——
  // 但 spec §2 不变量 3 / plan Step 3 语义下 fork 不递增 generation
  // （generation 仅在成功 merge 后原子递增），空库当前 generation = 0，
  // base 0 与 current 相等会 fast-forward 成功（与 brief 测试 2 的 generation
  // 序列完全相同，两者在单一 fork 语义下不可同时成立）。
  // 修正：先成功提交一次（0→1），再以旧 base 0 提交 → base !== current → generation-stale。
  const { pub, dir } = fresh();
  const base = pub.fork(dir);
  const r1 = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["b"], content: "y", id: "e9" })] });
  assert.equal(r1.ok, true);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["c"], content: "z", id: "e10" })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "generation-stale");
  rmSync(dir, { recursive: true, force: true });
});

// ---- 接口全量覆盖（brief 四测试之外的补充） ----

test("anchors overlap with different id is NOT a conflict (pinned predicate)", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["a"], content: "y", id: "e2" })] });
  assert.equal(r.ok, true); // 同锚点不同 id：不冲突 → fast-forward（第五轮裁决钉死）
  assert.equal(new MemoryStore(dir).get("e1")?.content, "x");
  assert.equal(new MemoryStore(dir).get("e2")?.content, "y");
  rmSync(dir, { recursive: true, force: true });
});

test("submitWriteBack applies removeIds and bumps generation", () => {
  const { pub, dir } = fresh();
  const store = new MemoryStore(dir);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" }));
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["b"], content: "y", id: "e2" })], removeIds: ["e1"] });
  assert.equal(r.ok, true);
  assert.equal(new MemoryStore(dir).get("e1"), undefined);
  assert.equal(new MemoryStore(dir).get("e2")?.content, "y");
  assert.equal(new MemoryStore(dir).retrieve({ anchors: ["a"] }).length, 0); // 索引同步重建
  assert.equal(pub.generation(), base + 1);
  rmSync(dir, { recursive: true, force: true });
});

test("submitWriteBack rejects removeIds not present in store (conflict)", () => {
  const { pub, dir } = fresh();
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [], removeIds: ["ghost"] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "conflict");
  rmSync(dir, { recursive: true, force: true });
});

test("generation persists across instances", () => {
  const { pub, dir } = fresh();
  const base = pub.fork(dir);
  const r = pub.submitWriteBack({ baseGeneration: base, delta: [createEntry({ kind: "fact", anchors: ["b"], content: "y", id: "e2" })] });
  assert.equal(r.ok, true);
  assert.equal(new PublicDomainStore(dir).generation(), 1);
  rmSync(dir, { recursive: true, force: true });
});

test("deadLetter push/query roundtrip (caller-managed retry exhaustion)", () => {
  const { pub, dir } = fresh();
  assert.deepEqual(pub.deadLetter(), []);
  pub.addDeadLetter({ deltaId: "e1", reason: "retry-exhausted (3 attempts)" });
  pub.addDeadLetter({ deltaId: "e2", reason: "operator-rejected" });
  const dl = pub.deadLetter();
  assert.equal(dl.length, 2);
  assert.equal(dl[0].deltaId, "e1");
  assert.equal(dl[0].reason, "retry-exhausted (3 attempts)");
  assert.ok(dl[0].at > 0);
  assert.equal(dl[1].deltaId, "e2");
  rmSync(dir, { recursive: true, force: true });
});
