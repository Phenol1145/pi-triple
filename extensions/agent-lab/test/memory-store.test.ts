import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.ts";
import { createEntry } from "../src/memory/entry.ts";

function fresh(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-store-"));
  return { store: new MemoryStore(dir), dir };
}

test("write/get roundtrip", () => {
  const { store, dir } = fresh();
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e1" });
  store.write(e);
  assert.equal(store.get("e1")?.content, "x");
  rmSync(dir, { recursive: true, force: true });
});

test("retrieve by anchor and excludes drafts when requested", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "x", id: "a1" }));
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "y", id: "a2", status: "draft" }));
  assert.equal(store.retrieve({ anchors: ["api"], excludeDrafts: true }).length, 1);
  assert.equal(store.retrieve({ anchors: ["api"] }).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("update increments version (CAS)", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  store.update("e", { content: "v2" });
  const e = store.get("e")!;
  assert.equal(e.content, "v2");
  assert.equal(e.meta.version, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("rebuildIndex recovers from missing index", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e" }));
  rmSync(path.join(dir, "index"), { recursive: true, force: true });
  store.rebuildIndex();
  assert.equal(store.retrieve({ anchors: ["a"] }).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ---- 接口全量覆盖（brief 四个测试之外的补充） ----

test("write with existing id merges with version increment (idempotent write)", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v2", id: "e" }));
  const e = store.get("e")!;
  assert.equal(e.content, "v2");
  assert.equal(e.meta.version, 2);
  assert.equal(e.meta.versions!.length, 1);
  assert.equal(e.meta.versions![0].version, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("update appends versions[] with watermark 0 and contentHash", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  store.update("e", { content: "v2" });
  const e = store.get("e")!;
  assert.equal(e.meta.version, 2);
  const v = e.meta.versions![0];
  assert.equal(v.version, 2);
  assert.equal(v.watermark, 0);
  assert.equal(v.contentHash.length, 16);
  rmSync(dir, { recursive: true, force: true });
});

test("bumpHitCount writes side-channel counter without versioning", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e" }));
  store.bumpHitCount("e");
  store.bumpHitCount("e");
  const counter = JSON.parse(readFileSync(path.join(dir, "counters", "e.json"), "utf-8"));
  assert.equal(counter.hitCount, 2);
  assert.equal(store.get("e")!.meta.version, 1); // 旁路计数器不触发版本化
  rmSync(dir, { recursive: true, force: true });
});

test("listIds returns all stored ids", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "b" }));
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "y", id: "a" }));
  assert.deepEqual(store.listIds(), ["a", "b"]);
  rmSync(dir, { recursive: true, force: true });
});

test("retrieve filters by kinds and status", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "f1" }));
  store.write(createEntry({ kind: "preference", anchors: ["a"], content: "y", id: "p1", status: "archived" }));
  assert.equal(store.retrieve({ kinds: ["fact"] }).length, 1);
  assert.equal(store.retrieve({ status: ["archived"] }).length, 1);
  assert.equal(store.retrieve({}).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("write with same version and content restamps without version bump (watermark path)", () => {
  const { store, dir } = fresh();
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  const e = store.get("e")!;
  store.write(e); // 同版本同内容重落库（Task 7 revive/recordVersion 路径）
  assert.equal(store.get("e")!.meta.version, 1);
  assert.equal(store.get("e")!.meta.versions, undefined);
  rmSync(dir, { recursive: true, force: true });
});
