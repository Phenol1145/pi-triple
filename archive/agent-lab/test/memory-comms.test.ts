import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommsChannel, IdentityMap, type CommsMessage, type CommsTransport } from "../src/memory/comms.ts";

class MemTransport implements CommsTransport {
  received: CommsMessage[] = [];
  listeners: Array<(m: CommsMessage) => void> = [];
  send(m: CommsMessage) { this.received.push(m); for (const l of this.listeners) l(m); }
  onReceive(cb: (m: CommsMessage) => void) { this.listeners.push(cb); }
  activePeers() { return ["peer-b"]; }
}

test("send generates msgId and delivers via transport", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const msg = c.send("peer-b", "observed x");
  assert.ok(msg.msgId.length > 0);
  assert.equal(t.received.length, 1);
});

test("receive dedups by msgId (isDuplicate)", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const injected: CommsMessage[] = [];
  c.onTapeInjection((m) => injected.push(m));
  const msg = c.send("peer-b", "fragment");
  t.send({ msgId: msg.msgId, from: "b", to: "a", tapeFragment: "fragment", timestamp: 1 }); // 模拟重复投递
  t.send({ msgId: "new-1", from: "b", to: "a", tapeFragment: "f2", timestamp: 2 });
  assert.equal(injected.length, 1);   // 重复 msgId 被去重
});

test("oversized fragment rejected", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  assert.throws(() => c.send("peer-b", "x".repeat(5000)));
});

test("identity map persists and resolves, session optional", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-idm-"));
  const im = new IdentityMap(dir);
  im.set("agent-1", "tenant-1", "session-1");
  assert.deepEqual(im.resolve("agent-1"), { tenantId: "tenant-1", sessionId: "session-1" });
  im.refreshSession("agent-1", "session-2");
  assert.equal(im.resolve("agent-1")!.sessionId, "session-2");
  assert.equal(im.resolve("nope"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

// ---- 接口全量覆盖（brief 四个测试之外的补充） ----

test("messages addressed to other agents are ignored (routing guard)", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const injected: CommsMessage[] = [];
  c.onTapeInjection((m) => injected.push(m));
  t.send({ msgId: "m-other", from: "b", to: "peer-b", tapeFragment: "x", timestamp: 1 }); // 发给别人
  t.send({ msgId: "m-own", from: "a", to: "a", tapeFragment: "y", timestamp: 2 });       // 自己的回环（to 匹配）
  assert.equal(injected.length, 1);
  assert.equal(injected[0].msgId, "m-own");
});

test("send self-records msgId: own broadcast/loopback never injected", () => {
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const injected: CommsMessage[] = [];
  c.onTapeInjection((m) => injected.push(m));
  c.send("peer-b", "fragment");           // transport 回环投递自己 → 被自我打点去重
  assert.equal(injected.length, 0);
});

test("dedup state persists across restart (dedup.jsonl reload)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-comms-"));
  const t1 = new MemTransport();
  const c1 = new CommsChannel(t1, { agentId: "a", tenantId: "t1", sessionId: "s1" }, dir);
  t1.send({ msgId: "m1", from: "b", to: "a", tapeFragment: "f", timestamp: 1 });
  assert.equal(c1.isDuplicate("m1"), true);
  // 重启加载：新实例从 dedup.jsonl 恢复去重状态
  const t2 = new MemTransport();
  const c2 = new CommsChannel(t2, { agentId: "a", tenantId: "t1", sessionId: "s1" }, dir);
  assert.equal(c2.isDuplicate("m1"), true);
  const injected: CommsMessage[] = [];
  c2.onTapeInjection((m) => injected.push(m));
  t2.send({ msgId: "m1", from: "b", to: "a", tapeFragment: "f", timestamp: 1 }); // 重启后重复投递
  assert.equal(injected.length, 0);       // 不重复注入纸带
  rmSync(dir, { recursive: true, force: true });
});

test("pruneDedup drops records newer than seq (ghost-rejection guard)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-comms-"));
  // 预置 dedup.jsonl：ghost 记录水位 50（晚于 S=20），old 记录水位 10（早于 S）
  writeFileSync(
    path.join(dir, "dedup.jsonl"),
    JSON.stringify({ msgId: "ghost", watermark: 50 }) + "\n" + JSON.stringify({ msgId: "old", watermark: 10 }) + "\n"
  );
  const c = new CommsChannel(new MemTransport(), { agentId: "a", tenantId: "t1", sessionId: "s1" }, dir);
  c.pruneDedup(20);                       // resume 到 S=20：丢弃晚于 S 的 dedup 记录（允许重复投递）
  assert.equal(c.isDuplicate("ghost"), false);
  assert.equal(c.isDuplicate("old"), true);
  const lines = readFileSync(path.join(dir, "dedup.jsonl"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.msgId), ["old"]);   // 文件同步重写
  rmSync(dir, { recursive: true, force: true });
});

test("pruneDedup advances watermark for subsequent records", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-comms-"));
  const t = new MemTransport();
  const c = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" }, dir);
  c.pruneDedup(20);                       // 水位推进到 20
  t.send({ msgId: "m2", from: "b", to: "a", tapeFragment: "f", timestamp: 1 });
  const recs = readFileSync(path.join(dir, "dedup.jsonl"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].msgId, "m2");
  assert.equal(recs[0].watermark, 20);    // 记录随 checkpoint 水位打点（{msgId, watermark}）
  rmSync(dir, { recursive: true, force: true });
});

test("send carries from/to/timestamp/type and enforces 4096-byte boundary (UTF-8)", () => {
  const c = new CommsChannel(new MemTransport(), { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const msg = c.send("peer-b", "frag", "observe");
  assert.equal(msg.msgId.length, 36);     // UUID
  assert.equal(msg.from, "a");
  assert.equal(msg.to, "peer-b");
  assert.equal(msg.type, "observe");
  assert.ok(msg.timestamp > 0);
  assert.equal(c.send("peer-b", "x".repeat(4096)).tapeFragment.length, 4096);   // 恰在上限内
  assert.throws(() => c.send("peer-b", "x".repeat(4097)));
  assert.throws(() => c.send("peer-b", "好".repeat(1366)));                     // 1366*3=4098 字节 → 拒绝
  assert.equal(c.send("peer-b", "好".repeat(1365)).tapeFragment.length, 1365);  // 1365*3=4095 字节 → 通过（按字节计）
});

test("identity map persists across instances", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-idm-"));
  const im1 = new IdentityMap(dir);
  im1.set("agent-1", "tenant-1", "session-1");
  const im2 = new IdentityMap(dir);       // 重启加载 identity.json
  assert.deepEqual(im2.resolve("agent-1"), { tenantId: "tenant-1", sessionId: "session-1" });
  rmSync(dir, { recursive: true, force: true });
});

test("resolve returns mapping without sessionId (offline semantics)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-idm-"));
  writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ "agent-9": { tenantId: "tenant-9" } }));
  const im = new IdentityMap(dir);
  const r = im.resolve("agent-9");
  assert.deepEqual(r, { tenantId: "tenant-9" });   // 缺 sessionId = 离线（排队语义由调用方判定）
  assert.equal(r !== undefined && "sessionId" in r, false);
  rmSync(dir, { recursive: true, force: true });
});

test("refreshSession on unknown agent is a no-op", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-idm-"));
  const im = new IdentityMap(dir);
  im.refreshSession("ghost", "s9");
  assert.equal(im.resolve("ghost"), undefined);
  rmSync(dir, { recursive: true, force: true });
});
