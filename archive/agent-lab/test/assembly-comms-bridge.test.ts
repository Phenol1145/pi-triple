import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommsChannel, IdentityMap, type CommsMessage, type CommsTransport } from "../src/memory/comms.ts";
import { CommsBridge } from "../src/assembly/comms-bridge.ts";

class MemTransport implements CommsTransport {
  received: CommsMessage[] = [];
  listeners: Array<(m: CommsMessage) => void> = [];
  send(m: CommsMessage) { this.received.push(m); for (const l of this.listeners) l(m); }
  onReceive(cb: (m: CommsMessage) => void) { this.listeners.push(cb); }
  activePeers() { return ["peer-b"]; }
}

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-comms-"));
  const inboxDir = path.join(dir, "inbox");
  const channel = new CommsChannel(
    new MemTransport(),
    { agentId: "a", tenantId: "t1", sessionId: "s1" },
    path.join(dir, "comms"),
  );
  const identityMap = new IdentityMap(path.join(dir, "identity"));
  const bridge = new CommsBridge({ inboxDir, channel, identityMap });
  return { dir, inboxDir, channel, identityMap, bridge };
}

function msg(id: string, frag = "f", type?: string): CommsMessage {
  return {
    msgId: id,
    from: "peer-b",
    to: "a",
    tapeFragment: frag,
    timestamp: 1,
    ...(type !== undefined ? { type } : {}),
  };
}

function readInbox(inboxDir: string): Array<Record<string, unknown>> {
  const file = path.join(inboxDir, "inbox.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ── brief 四个场景 ────────────────────────────────────────────────

test("1. enqueue/drain/ack 生命周期：消息并入 → ack 后 pending 0", () => {
  const { dir, inboxDir, bridge } = fresh();
  bridge.enqueue(msg("m1", "f1", "observe"));
  bridge.enqueue(msg("m2", "f2"));
  assert.equal(bridge.pending(), 2);

  const drained = bridge.drainInto(5);
  assert.deepEqual(drained.map((m) => m.msgId), ["m1", "m2"]);
  assert.equal(drained[0].type, "observe");          // type 透传保留
  assert.equal("mergedAtSeq" in drained[0], false);  // 返回值 = CommsMessage（无内部字段）

  // 落盘条目已标记 mergedAtSeq=5（未 ack 前保留）
  const stored = readInbox(inboxDir);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((e) => e.mergedAtSeq === 5));
  assert.equal(bridge.pending(), 2);                 // 并入 ≠ ack

  bridge.ack(5);                                     // mergedAtSeq 5 ≤ 5 → 删除
  assert.equal(bridge.pending(), 0);
  assert.equal(readInbox(inboxDir).length, 0);       // inbox.jsonl 已 compact
  rmSync(dir, { recursive: true, force: true });
});

test("2. ack 前 resume 重并入 → 按 msgId 去重（不重复注入）", () => {
  const { dir, bridge } = fresh();
  bridge.enqueue(msg("m1"));
  assert.deepEqual(bridge.drainInto(5).map((m) => m.msgId), ["m1"]);

  // resume（未 ack）：m1 已并入（桥接 Set 命中）→ 跳过，不重复注入
  assert.deepEqual(bridge.drainInto(10).map((m) => m.msgId), []);
  assert.equal(bridge.pending(), 1);                 // 仍待 ack（checkpoint ≥ 5 后清理）
  rmSync(dir, { recursive: true, force: true });
});

test("3. 溢出 drop-oldest（容量 2 → 第 3 条丢弃最旧）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-comms-"));
  const inboxDir = path.join(dir, "inbox");
  const channel = new CommsChannel(new MemTransport(), { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const bridge = new CommsBridge({ inboxDir, channel, identityMap: new IdentityMap(dir), capacity: 2 });
  bridge.enqueue(msg("m1", "oldest"));
  bridge.enqueue(msg("m2", "mid"));
  bridge.enqueue(msg("m3", "newest"));
  assert.equal(bridge.pending(), 2);                 // m1 已溢出丢弃
  const drained = bridge.drainInto(99);
  assert.deepEqual(drained.map((m) => m.msgId), ["m2", "m3"]);
  assert.equal(drained[0].tapeFragment, "mid");
  assert.equal(drained[1].tapeFragment, "newest");
  rmSync(dir, { recursive: true, force: true });
});

test("4. mergedAtSeq 语义：ack(seq) 只删 mergedAtSeq ≤ seq 的条目", () => {
  const { dir, bridge } = fresh();
  bridge.enqueue(msg("m1"));
  bridge.drainInto(5);                               // m1 mergedAtSeq=5
  bridge.enqueue(msg("m2"));
  bridge.drainInto(10);                              // m2 mergedAtSeq=10（m1 已并入 → 跳过）
  bridge.enqueue(msg("m3"));                         // 永不并入（模拟待处理）

  bridge.ack(7);                                     // 只删 m1（5 ≤ 7）
  assert.equal(bridge.pending(), 2);                 // m2（10 > 7）+ m3（未并入）保留
  bridge.ack(10);                                    // m2（10 ≤ 10）删除
  assert.equal(bridge.pending(), 1);                 // m3 未并入 → 保留
  bridge.ack(100);                                   // m3 无 mergedAtSeq → 永不删
  assert.equal(bridge.pending(), 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── 接口全量覆盖（brief 四个场景之外的补充）────────────────────────

test("restart 后 resume 重并入未 ack 条目（Set 丢失 → 重新并入）", () => {
  const { dir, inboxDir, channel, identityMap } = fresh();
  const b1 = new CommsBridge({ inboxDir, channel, identityMap });
  b1.enqueue(msg("m1"));
  b1.drainInto(5);                                   // 并入但未 ack（崩溃残留）

  // 进程重启：新桥接（Set 空；通道未记录 m1——直接入队路径）→ 重并入未 ack 条目
  const b2 = new CommsBridge({ inboxDir, channel, identityMap });
  const re = b2.drainInto(10);
  assert.deepEqual(re.map((m) => m.msgId), ["m1"]);
  assert.equal(readInbox(inboxDir)[0].mergedAtSeq, 10);  // mergedAtSeq 更新为 10
  b2.ack(10);
  assert.equal(b2.pending(), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("通道去重兜底：channel.isDuplicate 命中的已并入条目不重并入", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-comms-"));
  const inboxDir = path.join(dir, "inbox");
  // 模拟 m1 曾经通道投递（去重表已记录）：重启后桥接 Set 为空 → 去重靠通道兜底
  const transport = new MemTransport();
  const channel = new CommsChannel(transport, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  transport.send({ msgId: "m1", from: "peer-b", to: "a", tapeFragment: "f", timestamp: 1 });
  assert.equal(channel.isDuplicate("m1"), true);
  // 预置崩溃残留 inbox：m1 已并入未 ack（mergedAtSeq=5）
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(path.join(inboxDir, "inbox.jsonl"), JSON.stringify({ ...msg("m1"), mergedAtSeq: 5 }) + "\n");
  const b = new CommsBridge({ inboxDir, channel, identityMap: new IdentityMap(dir) });
  assert.deepEqual(b.drainInto(10).map((m) => m.msgId), []);  // 通道去重命中 → 不重并入
  assert.equal(b.pending(), 1);                              // 仍待 ack（checkpoint ≥ 5 后清理）
  b.ack(5);
  assert.equal(b.pending(), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("同 msgId 重复入队（双副本）→ 只并入一次（重复副本消费不注入）", () => {
  const { dir, bridge } = fresh();
  bridge.enqueue(msg("m1"));
  bridge.enqueue(msg("m1"));                         // 重复投递副本（上游去重失效兜底）
  const drained = bridge.drainInto(5);
  assert.deepEqual(drained.map((m) => m.msgId), ["m1"]);   // 只注入一次
  assert.equal(bridge.pending(), 2);                 // 两副本均已标记 mergedAtSeq=5
  bridge.ack(5);
  assert.equal(bridge.pending(), 0);                 // 无泄漏（重复副本不滞留）
  rmSync(dir, { recursive: true, force: true });
});

test("默认容量 100：第 101 条丢弃最旧", () => {
  const { dir, bridge } = fresh();
  for (let i = 1; i <= 101; i++) bridge.enqueue(msg(`m${i}`));
  assert.equal(bridge.pending(), 100);
  const drained = bridge.drainInto(999);
  assert.equal(drained[0].msgId, "m2");              // m1 被丢弃
  assert.equal(drained[99].msgId, "m101");
  rmSync(dir, { recursive: true, force: true });
});

test("身份权威（契约⑨）：registerIdentity 装配注册 + refreshSession 刷新 + 回调通知/反注册", () => {
  const { dir, bridge, identityMap } = fresh();
  const refreshes: Array<[string, string]> = [];
  const unreg = bridge.registerSessionRefresh((agentId, sessionId) => refreshes.push([agentId, sessionId]));

  bridge.registerIdentity("agent-1", "tenant-1", "session-1");   // 装配时注册（IdentityMap 权威源）
  assert.deepEqual(identityMap.resolve("agent-1"), { tenantId: "tenant-1", sessionId: "session-1" });

  bridge.refreshSession("agent-1", "session-2");                 // session_start 刷新
  assert.equal(identityMap.resolve("agent-1")!.sessionId, "session-2");
  assert.deepEqual(refreshes, [["agent-1", "session-2"]]);

  unreg();                                                       // 反注册后不再通知（刷新仍生效）
  bridge.refreshSession("agent-1", "session-3");
  assert.equal(identityMap.resolve("agent-1")!.sessionId, "session-3");
  assert.deepEqual(refreshes, [["agent-1", "session-2"]]);
  rmSync(dir, { recursive: true, force: true });
});

test("refreshSession 未映射 agent → no-op（回调不触发，不发明映射）", () => {
  const { dir, bridge, identityMap } = fresh();
  let fired = 0;
  bridge.registerSessionRefresh(() => fired++);
  bridge.refreshSession("ghost", "s9");
  assert.equal(fired, 0);
  assert.equal(identityMap.resolve("ghost"), undefined);
  rmSync(dir, { recursive: true, force: true });
});
