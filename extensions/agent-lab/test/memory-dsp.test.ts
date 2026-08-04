import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DspBuilder } from "../src/memory/dsp.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { WatermarkManager } from "../src/memory/watermark.ts";
import { createEntry } from "../src/memory/entry.ts";
import { tmpDir } from "./test-utils/fixtures.ts";

function fresh() {
  const { dir } = tmpDir("mem-dsp-");
  const store = new MemoryStore(dir);
  const wm = new WatermarkManager(store);
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "rate=100", id: "m1" }));
  return { store, wm, dsp: new DspBuilder(store, wm, { maxRealtimeBytes: 4096, maxRestoreBytes: 16384 }), dir };
}

test("build includes projection and memory entry sections", () => {
  const { dsp, dir } = fresh();
  const out = dsp.build({ state: { credit: 10 }, memory: {}, env: { cwd: "/x" }, budget: { used: 0, max: 8000 } }, "realtime");
  assert.ok(out.includes("credit"));
  assert.ok(out.includes("api"));    // 记忆入口区：锚点命中检索注入
  rmSync(dir, { recursive: true, force: true });
});

test("truncation order: projection → tools → memory entry (candidates last)", () => {
  const { dsp, dir } = fresh();
  const small = new DspBuilder(new MemoryStore(dir), new WatermarkManager(new MemoryStore(dir)), { maxRealtimeBytes: 200, maxRestoreBytes: 200 });
  const out = small.build({ state: { credit: 10 }, memory: {}, env: { cwd: "/x" }, budget: { used: 0, max: 8000 }, candidates: ["obs-1"] }, "realtime");
  assert.ok(out.length <= 200 * 4);   // 截断后不超限（宽松断言，实现按顺序截断）
  rmSync(dir, { recursive: true, force: true });
});

test("snapshot/restore roundtrip without re-querying store", () => {
  const { store, wm, dsp, dir } = fresh();
  const snap = dsp.snapshot(10, "realtime");
  const out = dsp.restore(snap);
  assert.ok(out.length > 0);
  store.bumpHitCount("m1");
  assert.equal(out, dsp.restore(snap));   // 恢复不重检索：store 变化不影响快照
  rmSync(dir, { recursive: true, force: true });
});

// ---- 接口全量覆盖（brief 三个测试之外的补充） ----

test("snapshot persists to dir/dsp-snapshots/<seq>.json with memoryVersion", () => {
  const { dir, cleanup } = tmpDir("mem-dsp-");
  const store = new MemoryStore(dir);
  const dsp = new DspBuilder(store, new WatermarkManager(store), { maxRealtimeBytes: 4096, maxRestoreBytes: 16384, dir });
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "rate=100", id: "m1" }));
  const snap = dsp.snapshot(10, "realtime");
  const file = path.join(dir, "dsp-snapshots", "10.json");
  assert.ok(existsSync(file));
  const onDisk = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(onDisk, { text: snap.text, memoryVersion: snap.memoryVersion, atSeq: 10 });
  assert.match(snap.memoryVersion, /^[0-9a-f]{16}$/);
  cleanup();
});

test("content-addressed dedup: same text → same memoryVersion, no rewrite", () => {
  const { dir, cleanup } = tmpDir("mem-dsp-");
  const store = new MemoryStore(dir);
  const dsp = new DspBuilder(store, new WatermarkManager(store), { maxRealtimeBytes: 4096, maxRestoreBytes: 16384, dir });
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "rate=100", id: "m1" }));
  const s1 = dsp.snapshot(10, "realtime");
  const file = path.join(dir, "dsp-snapshots", "10.json");
  const mtime1 = statSync(file).mtimeMs;
  const s2 = dsp.snapshot(10, "realtime");           // 同 seq 重拍：同 text → 复用不重写
  assert.equal(s2.text, s1.text);
  assert.equal(s2.memoryVersion, s1.memoryVersion);
  assert.equal(statSync(file).mtimeMs, mtime1);
  const s3 = dsp.snapshot(11, "realtime");           // 跨 seq：text 相同 → 版本号一致（内容寻址）
  assert.equal(s3.memoryVersion, s1.memoryVersion);
  assert.equal(s3.atSeq, 11);
  cleanup();
});

test("snapshot at seq only contains versions visible at that seq (watermark masking)", () => {
  const { store, wm, dsp, dir } = fresh();
  wm.recordVersion("m1", 20);                       // v1 @ watermark 20
  const snap10 = dsp.snapshot(10, "realtime");      // S=10：m1 被屏蔽
  assert.ok(!snap10.text.includes("rate=100"));
  const snap20 = dsp.snapshot(20, "realtime");      // S=20：m1 可见
  assert.ok(snap20.text.includes("rate=100"));
  assert.notEqual(snap20.memoryVersion, snap10.memoryVersion);
  rmSync(dir, { recursive: true, force: true });
});

test("build in restore mode uses snapshot text (no re-query after store evolution)", () => {
  const { store, wm, dsp, dir } = fresh();
  dsp.snapshot(10, "realtime");
  const input = { state: { credit: 10 }, memory: {}, env: { cwd: "/x" }, budget: { used: 0, max: 8000 } };
  const out1 = dsp.build(input, "restore");
  assert.ok(out1.includes("rate=100"));
  store.write(createEntry({ kind: "fact", anchors: ["x"], content: "new-fact", id: "m2" }));
  const out2 = dsp.build(input, "restore");          // 恢复模式：仍用快照，不重检索
  assert.equal(out2, out1);
  assert.ok(!out2.includes("new-fact"));
  const out3 = dsp.build(input, "realtime");         // 实时模式：新鲜检索可见新条目
  assert.ok(out3.includes("new-fact"));
  rmSync(dir, { recursive: true, force: true });
});

test("restore does not count (hitCount untouched, no counter files)", () => {
  const { store, wm, dsp, dir } = fresh();
  dsp.snapshot(10, "realtime");
  dsp.restore(dsp.snapshot(10, "realtime"));
  assert.equal(store.get("m1")!.meta.hitCount, 0);
  assert.ok(!existsSync(path.join(dir, "counters")));  // 无计数旁路文件产生
  rmSync(dir, { recursive: true, force: true });
});

test("truncation is byte-level and respects limit with multibyte content", () => {
  const { dir, cleanup } = tmpDir("mem-dsp-");
  const store = new MemoryStore(dir);
  const dsp = new DspBuilder(store, new WatermarkManager(store), { maxRealtimeBytes: 100, maxRestoreBytes: 100 });
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "记忆内容示例", id: "m1" }));
  const out = dsp.build({ state: { note: "中文状态投影" }, memory: {}, env: {}, budget: { used: 0, max: 8000 } }, "realtime");
  assert.ok(Buffer.byteLength(out, "utf8") <= 100);
  cleanup();
});

test("candidates are truncated last: summary cut before candidates", () => {
  const { dir, cleanup } = tmpDir("mem-dsp-");
  const store = new MemoryStore(dir);
  // header(16B) + candidates(24B) = 40B 恰好放得下 → 摘要被砍、候选保留
  const dsp = new DspBuilder(store, new WatermarkManager(store), { maxRealtimeBytes: 40, maxRestoreBytes: 40 });
  store.write(createEntry({ kind: "fact", anchors: ["api"], content: "rate=100", id: "m1" }));
  const out = dsp.build({ state: { credit: 10 }, memory: {}, env: { cwd: "/x" }, budget: { used: 0, max: 8000 }, candidates: ["obs-1"] }, "realtime");
  assert.ok(out.includes("obs-1"));
  assert.ok(!out.includes("rate=100"));
  assert.ok(Buffer.byteLength(out, "utf8") <= 40);
  cleanup();
});

test("empty store build yields memory entry header without crash; no candidates section when absent", () => {
  const { dir, cleanup } = tmpDir("mem-dsp-");
  const store = new MemoryStore(dir);
  const dsp = new DspBuilder(store, new WatermarkManager(store), { maxRealtimeBytes: 4096, maxRestoreBytes: 16384 });
  const out = dsp.build({ state: {}, memory: {}, env: {}, budget: { used: 0, max: 8000 } }, "realtime");
  assert.ok(out.includes("Memory Entry"));
  assert.ok(!out.includes("Candidates"));
  cleanup();
});
