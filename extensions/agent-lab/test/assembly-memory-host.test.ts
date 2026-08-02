import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryHost } from "../src/assembly/memory-host.ts";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";
import type { MemorySpec } from "../src/assembly/types.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { PublicDomainStore } from "../src/memory/public-domain.ts";
import { createEntry } from "../src/memory/entry.ts";
import type { MemoryEntry } from "../src/memory/entry.ts";
import type { WorkLoopSDK } from "../src/workloop/contracts.ts";

/** rule:fact 种子规则的合法内容（subject | predicate | object | confidence）。 */
const FACT_CONTENT = "sun | rises | east | 1.0";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** 最小 WorkLoopSDK 桩（attachSdk 只触碰 memory 端口）。 */
function makeSdk(): WorkLoopSDK {
  return {
    context: {
      append: (c) => c,
      filterMessages: (c) => c,
      merge: (b) => b,
      truncateMessages: (c) => c,
    },
    model: { complete: async () => ({ message: { role: "assistant", content: "" } }) },
    tools: { execute: async () => undefined },
    storage: {
      get: () => undefined,
      put: <T,>(_k: string, v: T, version: number) => ({ value: v, version }),
    },
    artifacts: { put: async () => "", get: async () => undefined },
    checkpoint: { save: async () => ({ checkpointId: "cp" }) },
    telemetry: { emit: () => {} },
    control: { signal: new AbortController().signal, throwIfCancelled: () => {} },
  };
}

interface FreshOpts {
  dialect?: MemorySpec["dialect"];
  seqProvider?: () => number;
  now?: () => number;
}

interface Fixture {
  root: string;
  workDir: string;
  pubDir: string;
  host: MemoryHost;
  pub: PublicDomainStore;
  cleanup(): void;
}

function fresh(opts: FreshOpts = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "asm-mem-"));
  const workDir = path.join(root, "agents", "agent-1");
  const pubDir = path.join(root, "public-domain");
  const ruleBootstrap = new RuleBootstrap(pubDir);
  ruleBootstrap.ensureInitialized();
  const host = new MemoryHost({
    workDir,
    pubDir,
    ruleBootstrap,
    spec: { ...(opts.dialect !== undefined ? { dialect: opts.dialect } : {}) },
    ...(opts.seqProvider !== undefined ? { seqProvider: opts.seqProvider } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return {
    root,
    workDir,
    pubDir,
    host,
    pub: new PublicDomainStore(pubDir),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 联合检索：私域（水位过滤）+ 公域 official 并集、去重、私域优先 ----

test("retrieve merges private (watermark-visible) and public official entries, dedup by id, private wins", () => {
  const f = fresh();
  try {
    // 私域条目（pipeline 写入；ruleRef 经 fallback 链解析公域 rule:fact）
    const r1 = f.host.pipeline.write({
      idempotencyKey: "k-p1", id: "priv-1", kind: "fact", anchors: ["alpha"], content: FACT_CONTENT, ruleRef: "rule:fact",
    });
    assert.equal(r1.ok, true);
    const r2 = f.host.pipeline.write({
      idempotencyKey: "k-p2", id: "shared", kind: "fact", anchors: ["beta"], content: FACT_CONTENT, ruleRef: "rule:fact",
    });
    assert.equal(r2.ok, true);

    // 公域条目（bootstrap 同款路径：直接写内部 MemoryStore）
    const pubStore = new MemoryStore(f.pubDir);
    pubStore.write(createEntry({ id: "pub-1", kind: "fact", anchors: ["gamma"], content: "public fact", ruleRef: "rule:fact", status: "official" }));
    pubStore.write(createEntry({ id: "shared", kind: "fact", anchors: ["beta"], content: "PUBLIC shared", ruleRef: "rule:fact", status: "official" }));

    // 私域水位过滤：future watermark 条目不可见（seqProvider 缺省 0）
    const r3 = f.host.pipeline.write({
      idempotencyKey: "k-p3", id: "future-1", kind: "fact", anchors: ["delta"], content: FACT_CONTENT, ruleRef: "rule:fact",
    });
    assert.equal(r3.ok, true);
    f.host.watermark.recordVersion("future-1", 100);

    const all = f.host.retrieve({});
    const byId = new Map(all.map((e) => [e.id, e]));
    assert.ok(byId.has("priv-1"), "private entry in union");
    assert.ok(byId.has("pub-1"), "public official entry in union");
    assert.equal(byId.get("shared")!.content, FACT_CONTENT, "private wins on id overlap");
    assert.equal(all.filter((e) => e.id === "shared").length, 1, "dedup by id");
    assert.ok(!byId.has("future-1"), "watermark-hidden private entry excluded");
    // 可及公域 v1 = 全局公域全部 official（种子条目也在并集内）
    assert.ok(byId.has("rule:fact"));
    assert.ok(byId.has("axiom"));

    // 锚点过滤（并集语义，同 store.retrieve）
    const alphaOnly = f.host.retrieve({ anchors: ["alpha"] });
    assert.ok(alphaOnly.some((e) => e.id === "priv-1"));
    assert.ok(!alphaOnly.some((e) => e.id === "pub-1"));
    assert.ok(!alphaOnly.some((e) => e.id === "shared"));
  } finally {
    f.cleanup();
  }
});

// ---- 2. 方言预检（契约⑤）：json 失败 → warning 不阻止写入 ----

test("dialect precheck (json): parse failure attaches warning, write not blocked", () => {
  const f = fresh({ dialect: "json" });
  try {
    const sdk = makeSdk();
    f.host.attachSdk(sdk);
    const mem = sdk.memory!;
    assert.ok(mem, "memory port mounted");

    // EBNF 合法但非 JSON → warning 附加，写入照常成功（ruleRef EBNF 校验是权威）
    const r = mem.write({ idempotencyKey: "k-j1", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact" });
    assert.equal((r as { ok: boolean }).ok, true);
    const warning = (r as { warning?: string }).warning;
    assert.ok(warning && warning.startsWith("dialect precheck failed:"), `warning attached, got: ${warning}`);
    const entryId = (r as { entry: MemoryEntry }).entry.id;
    assert.equal(f.host.store.get(entryId)!.status, "official", "write not blocked");

    // 合法 JSON 内容 → 预检通过（无 warning）；EBNF 失败仍走草稿区（不静默丢）
    const r2 = mem.write({ idempotencyKey: "k-j2", kind: "fact", anchors: ["x"], content: '{"fact":"ok"}', ruleRef: "rule:fact" });
    assert.equal((r2 as { warning?: string }).warning, undefined, "no warning on valid dialect");
    assert.equal((r2 as { ok: boolean }).ok, false);
    if (!(r2 as { ok: boolean }).ok) {
      assert.equal((r2 as { draft?: MemoryEntry }).draft!.status, "draft");
    }
  } finally {
    f.cleanup();
  }
});

// ---- 3. markdown 方言 → 恒 draft（draft-only 语义，契约⑤）----

test("markdown dialect forces draft status (draft-only); precheck failure still warns", () => {
  const f = fresh({ dialect: "markdown" });
  try {
    const sdk = makeSdk();
    f.host.attachSdk(sdk);
    const mem = sdk.memory!;

    // 通过 EBNF（experience = word）但非 markdown 结构 → warning + 强制 draft
    const r = mem.write({ idempotencyKey: "k-m1", kind: "experience", anchors: ["x"], content: "hello", ruleRef: "rule:experience" });
    assert.equal((r as { ok: boolean }).ok, true);
    assert.ok((r as { warning?: string }).warning?.startsWith("dialect precheck failed:"));
    assert.equal(f.host.store.get((r as { entry: MemoryEntry }).entry.id)!.status, "draft");

    // markdown 结构内容 → 预检通过（无 warning），仍强制 draft
    const r2 = mem.write({ idempotencyKey: "k-m2", kind: "experience", anchors: ["x"], content: "## note\nhello", ruleRef: "rule:experience" });
    assert.equal((r2 as { warning?: string }).warning, undefined);
    assert.equal((r2 as { ok: boolean }).ok, true);
    assert.equal(f.host.store.get((r2 as { entry: MemoryEntry }).entry.id)!.status, "draft");
  } finally {
    f.cleanup();
  }
});

// ---- 4. revive 钩子（契约①）：幂等命中 pending 条目 → 重盖章 nextSeq ----

test("revive hook: idempotent hit on pending entry re-stamps watermark to nextSeq (visible after)", () => {
  let seq = 10;
  const f = fresh({ seqProvider: () => seq });
  try {
    // 初始写入 + 盖章到 future watermark 100 → 在 seq=10 处于 pending-activation
    const w = f.host.pipeline.write({
      idempotencyKey: "k-rv", id: "rev-1", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact",
    });
    assert.equal(w.ok, true);
    f.host.watermark.recordVersion("rev-1", 100);
    assert.equal(f.host.watermark.isPendingActivation(f.host.store.get("rev-1")!, 10), true);
    assert.equal(f.host.watermark.visibleVersions(10).length, 0, "pending entry invisible at current seq");

    const sdk = makeSdk();
    f.host.attachSdk(sdk);
    const mem = sdk.memory!;

    // 幂等命中（同 idempotencyKey 重放）→ revive(rev-1, nextSeq = currentSeq + 1)
    const r = mem.write({ idempotencyKey: "k-rv", id: "rev-1", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact" });
    assert.equal((r as { ok: boolean }).ok, true);
    const entry = f.host.store.get("rev-1")!;
    assert.equal(entry.meta.versions![0].watermark, 11, "watermark re-stamped to currentSeq + 1");
    assert.equal(entry.meta.version, 1, "revive does not bump version");
    assert.equal(f.host.watermark.isPendingActivation(entry, 11), false);

    // revive 后可见（seqProvider 推进到 nextSeq）
    seq = 11;
    const vis = f.host.watermark.visibleVersions(11);
    assert.equal(vis.length, 1);
    assert.equal(vis[0].id, "rev-1");
    assert.equal(vis[0].content, FACT_CONTENT);

    // 非幂等新写入不触发 revive（fresh 条目无 versions 盖章）
    const r2 = mem.write({ idempotencyKey: "k-new", id: "fresh-1", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact" });
    assert.equal((r2 as { ok: boolean }).ok, true);
    assert.equal(f.host.store.get("fresh-1")!.meta.versions, undefined);
  } finally {
    f.cleanup();
  }
});

// ---- 5. TTL sweeper（契约③）：draft && ttlExpiresAt < now → archived ----

test("sweepDrafts archives expired drafts, keeps live ones", () => {
  let now = 1_000_000;
  const f = fresh({ now: () => now });
  try {
    // 校验失败 → 草稿（ttl = now + 7d）
    const bad = f.host.pipeline.write({ idempotencyKey: "k-d1", kind: "fact", anchors: ["x"], content: "bad", ruleRef: "rule:fact" });
    assert.equal(bad.ok, false);
    const draftId = (bad as { draft: MemoryEntry }).draft!.id;
    const good = f.host.pipeline.write({ idempotencyKey: "k-d2", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact" });
    assert.equal(good.ok, true); // official 条目不参与 sweep

    // 未过期 → 不清扫
    assert.equal(f.host.sweepDrafts(), 0);
    assert.equal(f.host.store.get(draftId)!.status, "draft");

    // 过期（now 推进 8 天）→ archived，返回清理数
    now += SEVEN_DAYS_MS + 1;
    assert.equal(f.host.sweepDrafts(), 1);
    assert.equal(f.host.store.get(draftId)!.status, "archived");

    // 幂等：二次清扫 0
    assert.equal(f.host.sweepDrafts(), 0);
  } finally {
    f.cleanup();
  }
});

test("startSweeper sweeps on interval and returns stop function", async () => {
  let now = 2_000_000;
  const f = fresh({ now: () => now });
  try {
    const bad = f.host.pipeline.write({ idempotencyKey: "k-s1", kind: "fact", anchors: ["x"], content: "bad", ruleRef: "rule:fact" });
    assert.equal(bad.ok, false);
    const draftId = (bad as { draft: MemoryEntry }).draft!.id;

    const stop = f.host.startSweeper(20);
    now += SEVEN_DAYS_MS + 1; // 草稿过期
    await sleep(120);          // 数个 interval
    assert.equal(f.host.store.get(draftId)!.status, "archived", "interval sweep archived expired draft");

    // 停止后不再清扫：新草稿过期后仍保留
    stop();
    const bad2 = f.host.pipeline.write({ idempotencyKey: "k-s2", kind: "fact", anchors: ["x"], content: "bad", ruleRef: "rule:fact" });
    assert.equal(bad2.ok, false);
    const draftId2 = (bad2 as { draft: MemoryEntry }).draft!.id;
    now += SEVEN_DAYS_MS + 1; // 第二次过期
    await sleep(80);
    assert.equal(f.host.store.get(draftId2)!.status, "draft", "sweeper stopped → no auto archive");
  } finally {
    f.cleanup();
  }
});
