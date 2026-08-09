import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { MemoryStore } from "../src/memory/store.ts";
import { WatermarkManager } from "../src/memory/watermark.ts";
import { createEntry } from "../src/memory/entry.ts";
import { tmpDir } from "./test-utils/fixtures.ts";

function fresh() {
  const { dir } = tmpDir("mem-wm-");
  return { store: new MemoryStore(dir), wm: new WatermarkManager(new MemoryStore(dir)), dir };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---- brief 三测试逐字 ----

test("visibleVersions masks future versions (watermark > S)", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" });
  store.write(e);
  wm.recordVersion("e", 10);          // v1 @ watermark 10
  store.update("e", { content: "v2" });
  wm.recordVersion("e", 20);          // v2 @ watermark 20
  const vis = wm.visibleVersions(15); // resume 到 S=15
  assert.equal(vis.length, 1);
  assert.equal(vis[0].content, "v1"); // v1 可见，v2 屏蔽
  rmSync(dir, { recursive: true, force: true });
});

test("all versions masked → pendingActivation", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" });
  store.write(e);
  wm.recordVersion("e", 20);
  assert.equal(wm.isPendingActivation(store.get("e")!, 15), true);
  rmSync(dir, { recursive: true, force: true });
});

test("revive re-stamps current version watermark", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  const e = createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" });
  store.write(e);
  wm.recordVersion("e", 20);
  wm.revive("e", 25);                 // 幂等重落库：内容不变，watermark = 25
  assert.equal(wm.visibleVersions(25).length, 1);
  assert.equal(wm.visibleVersions(25)[0].content, "v1");
  rmSync(dir, { recursive: true, force: true });
});

// ---- 补充：接口语义锁定 ----

test("recordVersion persists watermark into versions[] (current version, no bump)", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  wm.recordVersion("e", 10);
  const e = store.get("e")!;
  assert.equal(e.meta.version, 1); // 版本号不变（重落库路径）
  assert.equal(e.meta.versions!.length, 1);
  assert.equal(e.meta.versions![0].version, 1);
  assert.equal(e.meta.versions![0].watermark, 10);
  assert.equal(e.meta.versions![0].contentHash, hash("v1"));
  rmSync(dir, { recursive: true, force: true });
});

test("recordVersion stamps each version; older versions keep their watermark", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  wm.recordVersion("e", 10);
  store.update("e", { content: "v2" });
  wm.recordVersion("e", 20);
  const e = store.get("e")!;
  assert.equal(e.meta.version, 2);
  assert.deepEqual(e.meta.versions, [
    { version: 1, watermark: 10, contentHash: hash("v1") },
    { version: 2, watermark: 20, contentHash: hash("v2") },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("revive keeps version and content unchanged (restamp, not new version)", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  wm.recordVersion("e", 20);
  wm.revive("e", 25);
  const e = store.get("e")!;
  assert.equal(e.meta.version, 1); // 不递增版本
  assert.equal(e.content, "v1");   // 内容不变
  assert.equal(e.meta.versions![0].watermark, 25);
  rmSync(dir, { recursive: true, force: true });
});

test("isPendingActivation false when any version visible", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "v1", id: "e" }));
  wm.recordVersion("e", 10);
  store.update("e", { content: "v2" });
  wm.recordVersion("e", 20);
  assert.equal(wm.isPendingActivation(store.get("e")!, 15), false); // v1(10) 可见
  assert.equal(wm.isPendingActivation(store.get("e")!, 5), true);   // 全部 > 5
  rmSync(dir, { recursive: true, force: true });
});

test("visibleVersions projects multiple entries (stable order)", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "a1", id: "a" }));
  wm.recordVersion("a", 10);
  store.write(createEntry({ kind: "fact", anchors: ["b"], content: "b1", id: "b" }));
  wm.recordVersion("b", 10);
  store.update("b", { content: "b2" });
  wm.recordVersion("b", 30);
  const vis = wm.visibleVersions(20);
  assert.equal(vis.length, 2);
  assert.deepEqual(vis.map((x) => x.content), ["a1", "b1"]); // a 当前可见；b 投影到 v1
  assert.deepEqual(vis.map((x) => x.meta.version), [1, 1]);  // 投影版本归因
  rmSync(dir, { recursive: true, force: true });
});

test("unstamped entry (no versions[]) is visible as-is, not pendingActivation", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["a"], content: "x", id: "e" }));
  const vis = wm.visibleVersions(10);
  assert.equal(vis.length, 1);
  assert.equal(vis[0].content, "x");
  assert.equal(wm.isPendingActivation(store.get("e")!, 10), false);
  rmSync(dir, { recursive: true, force: true });
});

test("recordVersion/revive on missing entry throws (programming error)", () => {
  const { store, dir } = fresh();
  const wm = new WatermarkManager(store);
  assert.throws(() => wm.recordVersion("nope", 10), /entry not found/);
  assert.throws(() => wm.revive("nope", 10), /entry not found/);
  rmSync(dir, { recursive: true, force: true });
});
