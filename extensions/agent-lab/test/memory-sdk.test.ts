import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mountMemorySdk } from "../src/memory/sdk.ts";
import { MemoryPipeline } from "../src/memory/pipeline.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { RuleRegistry } from "../src/memory/rules.ts";
import { WatermarkManager } from "../src/memory/watermark.ts";
import { DspBuilder } from "../src/memory/dsp.ts";
import { CommsChannel, type CommsTransport } from "../src/memory/comms.ts";
import { createEntry, AXIOM_RULE_ID } from "../src/memory/entry.ts";

class MemTransport implements CommsTransport {
  received: { to: string; fragment: string }[] = [];
  send(m: { msgId: string; from: string; to: string; tapeFragment: string; timestamp: number }) { this.received.push({ to: m.to, fragment: m.tapeFragment }); }
  onReceive() {}
  activePeers() { return []; }
}

// brief 适配（supervisor 裁决 2026-08-02，同 Task 6 fresh() 注释）：规则显式注册为
// id "fact-rule"——brief 测试逐字使用 ruleRef: "fact-rule"，Task 3 resolveRule 按
// rule entry id 解析；PipelineDeps 必填 dir（管道文件布局所在）。
function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-sdk-"));
  const store = new MemoryStore(dir);
  const rules = new RuleRegistry(dir);
  rules.bootstrapAxiom();
  const rule = createEntry({ id: "fact-rule", kind: "rule", anchors: ["memory.fact"], content: "fact = subject, \"|\", predicate ;\nsubject = word ;\npredicate = word ;", ruleRef: AXIOM_RULE_ID });
  rules.registerRule(rule);
  const pipe = new MemoryPipeline({ dir, store, rules, trace: { traceId: "t", transitionSeq: 1 } });
  return { dir, store, pipe };
}

test("mounted sdk.memory.write goes through pipeline (validation + idempotency)", () => {
  const { dir, store, pipe } = fresh();
  const sdk: Record<string, unknown> = {};
  const t = new MemTransport();
  const comms = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  // brief 适配：deps 增补 store（brief Produces 要求 retrieve(opts): MemoryEntry[]，
  // 无 store 引用不可实现——deps 最小必要增补，先例：Task 11 opts.dir 扩展）
  mountMemorySdk(sdk as never, { pipeline: pipe, store, comms, dsp: null as never });
  const mem = (sdk as { memory: { write(e: unknown): unknown } }).memory;
  const r = mem.write({ idempotencyKey: "k1", kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal((r as { ok: boolean }).ok, true);
  const r2 = mem.write({ idempotencyKey: "k1", kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal((r2 as { ok: boolean }).ok, true);   // 幂等
  rmSync(dir, { recursive: true, force: true });
});

test("mounted sdk.comms.send delivers via channel", () => {
  const t = new MemTransport();
  const comms = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const sdk: Record<string, unknown> = {};
  mountMemorySdk(sdk as never, { pipeline: null as never, store: null as never, comms, dsp: null as never });
  (sdk as { comms: { send(to: string, fragment: string): void } }).comms.send("peer-b", "fragment-1");
  assert.equal(t.received.length, 1);
});

// ---- 补充测试（brief 之外：retrieve 挂载 / 全 deps 装配含 DSP 裁决①② / 防御性挂载）----

test("mounted sdk.memory.retrieve returns written entries via store", () => {
  const { dir, store, pipe } = fresh();
  const sdk: Record<string, unknown> = {};
  const comms = new CommsChannel(new MemTransport(), { agentId: "a", tenantId: "t1", sessionId: "s1" });
  mountMemorySdk(sdk as never, { pipeline: pipe, store, comms, dsp: null as never });
  const mem = (sdk as { memory: { write(e: unknown): unknown; retrieve(opts: unknown): unknown[] } }).memory;
  mem.write({ idempotencyKey: "k-r1", kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  const all = mem.retrieve({});
  assert.equal(all.length, 1);
  assert.equal((all[0] as { content: string }).content, "a|b");
  assert.equal(mem.retrieve({ anchors: ["x"] }).length, 1);
  assert.equal(mem.retrieve({ anchors: ["nope"] }).length, 0);
  // 防御：opts 为 null/undefined 时按全量检索处理（store 默认参数仅覆盖 undefined）
  assert.doesNotThrow(() => mem.retrieve(null as never));
  assert.equal(mem.retrieve(undefined as never).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("mount with full deps incl. DspBuilder(dir) composes; DSP shows written entry (Task 11 rulings)", () => {
  const { dir, store, pipe } = fresh();
  const wm = new WatermarkManager(store);
  const dsp = new DspBuilder(store, wm, { maxRealtimeBytes: 4096, maxRestoreBytes: 16384, dir }); // 裁决①：挂载显式传 dir
  const sdk: Record<string, unknown> = {};
  const comms = new CommsChannel(new MemTransport(), { agentId: "a", tenantId: "t1", sessionId: "s1" });
  mountMemorySdk(sdk as never, { pipeline: pipe, store, comms, dsp });
  const mem = (sdk as { memory: { write(e: unknown): unknown } }).memory;
  const r = mem.write({ idempotencyKey: "k-dsp", kind: "fact", anchors: ["x"], content: "a|b", ruleRef: "fact-rule" });
  assert.equal((r as { ok: boolean }).ok, true);
  // 裁决②：DSP 检索 = 全量官方条目（写入的 fact 出现在记忆入口区摘要行）
  const built = dsp.build({ state: {}, memory: undefined, env: {}, budget: { used: 0, max: 4096 } }, "realtime");
  assert.ok(built.includes("a|b"));
  rmSync(dir, { recursive: true, force: true });
});

test("mount without pipeline leaves sdk.memory unmounted (defensive)", () => {
  const t = new MemTransport();
  const comms = new CommsChannel(t, { agentId: "a", tenantId: "t1", sessionId: "s1" });
  const sdk: Record<string, unknown> = {};
  mountMemorySdk(sdk as never, { pipeline: null as never, store: null as never, comms, dsp: null as never });
  assert.equal(sdk.memory, undefined);
  assert.ok(sdk.comms);
});
