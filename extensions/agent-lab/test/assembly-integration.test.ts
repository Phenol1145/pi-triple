// 集成冒烟（plan Task 10 / spec §5 验证标准）——装配层端到端收口测试。
//
// 全链路：真实 SqliteLedger（临时库）+ PublicDomainBootstrap 种子（真实公域）+
// 内存 runner mock（brief 裁决：mock runner.run 返回伪结果——集成测试聚焦装配产物
// 而非真实 machine 执行；pi-default-loop 真实 machine 的委托链需 pi-subagents 运行时，
// 超出本任务范围）→ assembleAgent（fresh, pi-default-loop 定义）→ run 一轮 → 断言：
//   AgentInstance 注册（含扩展字段，T8 ruling）/ 开户余额 / 记忆域目录存在（公理
//   fallback 可解析）/ DSP build 含记忆入口区
//
// 接线契约抽检（brief）：① revive 触发（T7 ruling stub 边界注明）、⑤ 方言预检警告、
// ⑧ dir 无 cwd 污染。
// 已知留白验证：Task 5 遗留（DSP build 输出不含 draft）、T8 遗留（续跑目录残留：
// open created=false 时记忆域 fresh 覆盖式重建——不删除既有目录）。
//
// T7 ruling 边界（attachSdk 真实接线）：runner.buildSDK 私有无扩展钩子——集成测试
// 接受 stub 语义：AgentRuntime 内部挂载惰性 SDK stub（attachSdk 调用面成立），
// 本文件经 MemoryHost.attachSdk(桩 SDK) 验证挂载后的 write 包装链（revive/方言预检）；
// 真实记忆挂载（machine 可见 SDK）留 D/后续专项。
//
// T8 ruling 边界（memorySpec/endowment 持久层）：AgentInstanceRecord 结构超集字段
// 在 insertAgent 调用面可见（本文件断言）；repository 持久层无对应列（N-I9 迁移未
// 落地），insertAgent 落库时静默丢弃扩展字段——由 D/N-I9 专项闭合，此处注明。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteLedgerAdapter } from "../src/assembly/ledger-port.ts";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import type { AgentInstanceRecord, WorkLoopDefinition } from "../src/core/contracts.ts";
import type { AgentAssemblerDeps } from "../src/assembly/assembler.ts";
import { createAgentAssembler } from "../src/assembly/assembler.ts";
import { AgentRuntime } from "../src/assembly/agent-runtime.ts";
import { MemoryHost } from "../src/assembly/memory-host.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createEntry } from "../src/memory/entry.ts";
import type { MemoryEntry } from "../src/memory/entry.ts";
import type { WorkLoopResult, WorkLoopSDK } from "../src/workloop/contracts.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import { ASSEMBLY_DIR, PUBLIC_DOMAIN_DIR, ROUND_SENTINEL } from "../src/assembly/types.ts";

const WL_ID = "pi-default-loop"; // bench/集成共用定义（spec §5.6：pi-default-loop）
const WL_VERSION = "1.0.0";
const NOW = 1_700_000_000_000;
/** rule:fact 种子语法的合法内容（subject | predicate | object | confidence）。 */
const FACT_CONTENT = "sun | rises | east | 1.0";

/** pi-default-loop 的 WorkLoopDefinition（装配器消费面；machine 实现在 runner 侧）。 */
function piDefaultLoopDef(): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: WL_ID,
    version: WL_VERSION,
    sdkVersionRange: "^1.0.0",
    configSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        cwd: { type: "string" },
        contextMode: { type: "string", enum: ["fresh", "fork"] },
      },
      required: ["agent", "cwd", "contextMode"],
    },
    requiredCapabilities: [],
    cloneModes: ["fresh", "fork"],
  };
}

function done(): WorkLoopResult {
  return {
    status: "completed",
    context: { messages: [], metadata: { contextId: "", sourceRefs: [], artifactRefs: [] } },
    state: {},
  };
}

/** 最小 WorkLoopSDK 桩（attachSdk 只触碰 memory 端口；同 assembly-memory-host 测试桩）。 */
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

interface FixtureOpts {
  idGen?: () => string;
  /** 预开账户（模拟崩溃残留：账户已存在 → open created=false） */
  preOpen?: { agentId: string; K: number };
}

interface Fixture {
  root: string;
  db: DatabaseSync;
  ledger: SqliteLedgerAdapter;
  registry: DefinitionRegistry;
  ruleBootstrap: RuleBootstrap;
  assembler: ReturnType<typeof createAgentAssembler>;
  inserted: AgentInstanceRecord[];
  runRequests: WorkLoopRunRequest[];
  pubDir: string;
  cleanup(): void;
}

function fresh(opts: FixtureOpts = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "asm-int-"));
  const db = new DatabaseSync(path.join(root, "ledger.db"));
  const ledger = new SqliteLedgerAdapter(new SqliteLedger(db));

  // 公域种子（真实）
  const pubDir = path.join(root, PUBLIC_DOMAIN_DIR);
  new PublicDomainBootstrap(pubDir).ensureInitialized();
  const ruleBootstrap = new RuleBootstrap(pubDir);

  // workloop 注册（真实 registry）
  const registry = new DefinitionRegistry();
  registry.register(piDefaultLoopDef());

  // agentStore：内存记录（T8 ruling：断言 insertAgent 收到的 record——调用面断言）
  const inserted: AgentInstanceRecord[] = [];
  const records = new Map<string, AgentInstanceRecord>();
  const agentStore = {
    getAgent: (id: string): AgentInstanceRecord | undefined => records.get(id),
    insertAgent: (r: AgentInstanceRecord): void => {
      inserted.push(r);
      records.set(r.id, r);
    },
  };

  // runner mock（brief：返回伪结果——聚焦装配产物）
  const runRequests: WorkLoopRunRequest[] = [];
  const runner = {
    run: async (req: WorkLoopRunRequest): Promise<WorkLoopResult> => {
      runRequests.push(req);
      return done();
    },
  } as unknown as AgentAssemblerDeps["runner"];

  if (opts.preOpen) ledger.open(opts.preOpen.agentId, opts.preOpen.K);

  const deps: AgentAssemblerDeps = {
    registry,
    agentStore,
    ledger,
    ruleBootstrap,
    runner,
    workDir: root,
    now: () => NOW,
    ...(opts.idGen !== undefined ? { idGen: opts.idGen } : {}),
  };
  const assembler = createAgentAssembler(deps);

  return {
    root,
    db,
    ledger,
    registry,
    ruleBootstrap,
    assembler,
    inserted,
    runRequests,
    pubDir,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const REF = { kind: "workloop" as const, id: WL_ID, version: WL_VERSION };

/** 装配产物目录上的断言 MemoryHost（同目录第二实例；同 assembly-assembler 测试模式）。 */
function hostOn(fx: Fixture, agentId: string, spec: { dialect?: string } = {}): MemoryHost {
  return new MemoryHost({
    workDir: path.join(fx.root, ASSEMBLY_DIR, agentId),
    pubDir: fx.pubDir,
    ruleBootstrap: fx.ruleBootstrap,
    spec,
  });
}

// ══════════════════════════════════════════════════════════════════
// 1. 全链路：真实 ledger + 公域种子 + mock runner → 装配 → run 一轮
// ══════════════════════════════════════════════════════════════════
test("全链路：装配（fresh, pi-default-loop, json 方言, endowment 100）→ run 一轮 → 注册/余额/记忆域/DSP", async () => {
  const fx = fresh({ idGen: () => "ag-1" });
  let runtime: AgentRuntime | undefined;
  try {
    runtime = fx.assembler.assembleAgent(REF, {
      cloneMode: "fresh",
      schedulerInstanceId: "sched-1",
      endowment: { K: 100, initialFloor: 0.05 },
      memory: { dialect: "json" },
    });
    assert.ok(runtime instanceof AgentRuntime);
    assert.equal(runtime.agentId, "ag-1");

    // ── AgentInstance 注册（含扩展字段——T8 ruling：结构超集）──
    assert.equal(fx.inserted.length, 1);
    const rec = fx.inserted[0] as AgentInstanceRecord & {
      memorySpec?: { dialect: string };
      endowment?: { K: number; initialFloor: number };
    };
    assert.equal(rec.id, "ag-1");
    assert.equal(rec.schedulerInstanceId, "sched-1");
    assert.equal(rec.status, "ready");
    assert.equal(rec.createdAtRoundId, ROUND_SENTINEL); // 哨兵 ""（N-I9 裁决）
    assert.equal(rec.createdAt, NOW);
    assert.equal(rec.definition.workLoop.id, WL_ID);
    assert.equal(rec.definition.workLoop.version, WL_VERSION);
    assert.deepEqual(rec.memorySpec, { dialect: "json" }); // 扩展字段（结构超集）
    assert.deepEqual(rec.endowment, { K: 100, initialFloor: 0.05 });
    // ⚠️ T8 ruling 边界：AgentInstanceRecord 持久层（repository agents 表）无
    // memory_spec/endowment 列——N-I9 迁移未落地，insertAgent 落库时静默丢弃扩展
    // 字段；本断言在调用面（insertAgent 收到的 record），持久化语义由 D/N-I9 闭合。

    // ── 开户余额（真实 SqliteLedger 临时库；flat-K 开户）──
    assert.equal(fx.ledger.balance("ag-1"), 100);

    // ── 记忆域目录存在（<root>/agents/<id>/）+ 公理 fallback 可解析 ──
    const agentDir = path.join(fx.root, ASSEMBLY_DIR, "ag-1");
    assert.ok(existsSync(agentDir), "装配产物目录存在");
    const host = hostOn(fx, "ag-1", { dialect: "json" });
    // 公理由 RuleRegistry.bootstrapAxiom 落 rules/axiom.json（RuleFile 布局，非
    // MemoryStore entries/）——可解析断言走 rules.resolveRule
    assert.ok(host.rules.resolveRule("axiom") !== undefined, "公理本地可解析（rules/axiom.json）");
    assert.ok(host.rules.resolveRule("rule:fact") !== undefined, "规则 fallback 解析公域种子 rule:fact");
    assert.ok(host.rules.resolveRule("rule:experience") !== undefined, "fallback 解析 rule:experience");

    // ── run 一轮（mock runner）→ 身份字段自填绑定 + 结果透传 ──
    const result = await runtime.run({ task: "集成冒烟一轮", config: { agent: "a", cwd: "/tmp", contextMode: "fresh" } });
    assert.equal(result.status, "completed");
    assert.equal(fx.runRequests.length, 1);
    const req = fx.runRequests[0];
    assert.equal(req.agentInstanceId, "ag-1");
    assert.equal(req.workLoopId, WL_ID);
    assert.equal(req.workLoopVersion, WL_VERSION);
    assert.equal(req.schedulerInstanceId, "sched-1");
    assert.equal(req.optimizationRoundId, ROUND_SENTINEL);
    assert.ok(req.traceId && req.executionId, "traceId/executionId 自填");
    assert.equal(req.task, "集成冒烟一轮");
    assert.deepEqual(req.config, { agent: "a", cwd: "/tmp", contextMode: "fresh" });
    // ⚠️ T7 ruling stub 边界：runner.buildSDK 私有无扩展钩子——run 内挂载的是
    // AgentRuntime 内部惰性 SDK stub（attachSdk 调用面成立）；真实记忆挂载
    // （machine 可见 sdk.memory）留 D/后续专项。

    // ── DSP build 含记忆入口区（私域条目注入）──
    const w = host.pipeline.write({
      idempotencyKey: "int-1",
      id: "fact-int-1",
      kind: "fact",
      anchors: ["integration"],
      content: FACT_CONTENT,
      ruleRef: "rule:fact",
    });
    assert.equal(w.ok, true);
    const out = host.dsp.build({ state: {}, memory: {}, env: {}, budget: { used: 0, max: 100 } }, "realtime");
    assert.ok(out.includes("## Memory Entry"), "DSP 输出含记忆入口区");
    assert.ok(out.includes(FACT_CONTENT), "记忆入口区含私域条目内容");
  } finally {
    runtime?.dispose(); // 任何路径（含断言失败）都停 sweeper——否则 interval 保活事件循环
    fx.cleanup();
  }
});

// ══════════════════════════════════════════════════════════════════
// 2. 接线契约抽检：① revive 触发（stub 边界注明）⑤ 方言预检警告 ⑧ dir 无 cwd 污染
// ══════════════════════════════════════════════════════════════════
test("接线契约①⑤⑧：revive 触发 / 方言预检警告 / DSP dir 显式无 cwd 污染", () => {
  const fx = fresh({ idGen: () => "ag-2" });
  let runtime: AgentRuntime | undefined;
  try {
    runtime = fx.assembler.assembleAgent(REF, {
      cloneMode: "fresh",
      schedulerInstanceId: "sched-1",
      memory: { dialect: "json" }, // ⑤ 方言预检：json 方言声明
    });
    const host = hostOn(fx, "ag-2", { dialect: "json" });
    const sdk = makeSdk();
    host.attachSdk(sdk);
    assert.ok(sdk.memory, "attachSdk 挂载 memory 端口");

    // ── ① revive 触发：幂等命中 pending 条目 → watermark 重盖章（nextSeq = currentSeq + 1 = 1）──
    const w = host.pipeline.write({
      idempotencyKey: "k-rv", id: "revive-1", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact",
    });
    assert.equal(w.ok, true);
    host.watermark.recordVersion("revive-1", 100); // future watermark → seq=0 下 pending
    assert.equal(host.watermark.isPendingActivation(host.store.get("revive-1")!, 0), true);
    const r = sdk.memory!.write({ idempotencyKey: "k-rv", id: "revive-1", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact" });
    assert.equal((r as { ok: boolean }).ok, true);
    const revived = host.store.get("revive-1")!;
    assert.equal(revived.meta.versions![0].watermark, 1, "revive 重盖章到 nextSeq（seqProvider 缺省 0 → 1）");
    assert.equal(revived.meta.version, 1, "revive 不递增版本");
    assert.equal(host.watermark.visibleVersions(1).some((e) => e.id === "revive-1"), true, "revive 后可见");
    // ⚠️ T7 ruling stub 边界：revive 经 MemoryHost.attachSdk 包装链验证（与
    // AgentRuntime 内部挂载同一调用面）；真实 runner SDK 无扩展钩子，真实接线留 D。

    // ── ⑤ 方言预检：json 声明下非 JSON 内容 → warning 附加，不阻止写入 ──
    const r2 = sdk.memory!.write({ idempotencyKey: "k-j1", kind: "fact", anchors: ["x"], content: FACT_CONTENT, ruleRef: "rule:fact" });
    assert.equal((r2 as { ok: boolean }).ok, true, "EBNF 合法 → 写入成功（预检不阻止）");
    const warning = (r2 as { warning?: string }).warning;
    assert.ok(warning && warning.startsWith("dialect precheck failed:"), `warning 附加，got: ${warning}`);
    const r3 = sdk.memory!.write({ idempotencyKey: "k-j2", kind: "fact", anchors: ["x"], content: '{"fact":"ok"}', ruleRef: "rule:fact" });
    assert.equal((r3 as { warning?: string }).warning, undefined, "合法 JSON 内容 → 无 warning（预检通过）");

    // ── ⑧ dir 无 cwd 污染：DSP 快照落 <agentDir>/dsp-snapshots/，不经 process.cwd() ──
    host.dsp.snapshot(1, "realtime");
    assert.ok(existsSync(path.join(fx.root, ASSEMBLY_DIR, "ag-2", "dsp-snapshots", "1.json")), "快照落装配产物目录");
    assert.ok(!existsSync(path.join(process.cwd(), "dsp-snapshots")), "无 cwd 污染（杜绝 process.cwd() 兜底）");
  } finally {
    runtime?.dispose(); // 任何路径都停 sweeper（interval 不 unref——保活源）
    fx.cleanup();
  }
});

// ══════════════════════════════════════════════════════════════════
// 3. Task 5 遗留：私域 draft 不混入 DSP build 输出（excludeDrafts 保护）
// ══════════════════════════════════════════════════════════════════
test("DSP build 输出不含私域 draft（Task 5 遗留：excludeDrafts 保护确认）", () => {
  const fx = fresh({ idGen: () => "ag-3" });
  let runtime: AgentRuntime | undefined;
  try {
    runtime = fx.assembler.assembleAgent(REF, {
      cloneMode: "fresh",
      schedulerInstanceId: "sched-1",
      memory: { dialect: "json" },
    });
    const host = hostOn(fx, "ag-3", { dialect: "json" });

    // 合法条目（official）+ 非法内容 → 草稿区
    const good = host.pipeline.write({
      idempotencyKey: "k-g", id: "good-1", kind: "fact", anchors: ["good"], content: FACT_CONTENT, ruleRef: "rule:fact",
    });
    assert.equal(good.ok, true);
    const bad = host.pipeline.write({
      idempotencyKey: "k-b", id: "draft-1", kind: "fact", anchors: ["bad"], content: "not-a-valid-fact-shape", ruleRef: "rule:fact",
    });
    assert.equal(bad.ok, false);
    assert.equal((bad as { draft?: MemoryEntry }).draft!.status, "draft");
    assert.ok(host.store.get("draft-1") !== undefined, "草稿落库（不静默丢）");

    // DSP build（realtime）：记忆入口区只含 official——draft 内容/锚点行不出现
    const out = host.dsp.build({ state: {}, memory: {}, env: {}, budget: { used: 0, max: 100 } }, "realtime");
    assert.ok(out.includes(FACT_CONTENT), "official 条目在入口区");
    assert.ok(!out.includes("not-a-valid-fact-shape"), "draft 内容不混入 DSP build 输出");
    assert.ok(!out.includes("- [bad]"), "draft 锚点行不出现");
  } finally {
    runtime?.dispose(); // 任何路径都停 sweeper
    fx.cleanup();
  }
});

// ══════════════════════════════════════════════════════════════════
// 4. T8 遗留：续跑目录残留（open created=false 时记忆域 fresh 覆盖式重建）
// ══════════════════════════════════════════════════════════════════
test("续跑目录残留：open created=false + 残留目录 → 装配继续成功（覆盖式重建不删除既有目录）", () => {
  const AGENT_ID = "ag-residue";
  const fx = fresh({ idGen: () => AGENT_ID, preOpen: { agentId: AGENT_ID, K: 100 } });
  let runtime: AgentRuntime | undefined;
  try {
    // 崩溃残留模拟：未注册但目录已存在（含私域条目）+ 账户已存在（open → created=false）
    const agentDir = path.join(fx.root, ASSEMBLY_DIR, AGENT_ID);
    mkdirSync(agentDir, { recursive: true });
    new MemoryStore(agentDir).write(
      createEntry({ id: "stale-1", kind: "fact", anchors: ["stale"], content: "stale | residue | entry | 1.0", ruleRef: "rule:fact", status: "official" }),
    );

    runtime = fx.assembler.assembleAgent(REF, {
      cloneMode: "fresh",
      schedulerInstanceId: "sched-1",
      endowment: { K: 100, initialFloor: 0.05 },
    });
    assert.ok(runtime instanceof AgentRuntime);
    assert.equal(runtime.agentId, AGENT_ID);

    // 续跑成功：注册持久完成（注册预检未注册 → 不拦截）
    assert.equal(fx.inserted.length, 1);
    assert.equal(fx.inserted[0].status, "ready");
    assert.equal(fx.inserted[0].createdAtRoundId, ROUND_SENTINEL);

    // 余额不重复入账（open created=false → flat-K 不再 credit）
    assert.equal(fx.ledger.balance(AGENT_ID), 100);

    // 记忆域 fresh 覆盖式重建：不删除既有目录（T8 minor 裁决：避免误删续跑 agent
    // 既有私域）——残留条目保留、规则链在重建域上可解析
    const host = hostOn(fx, AGENT_ID);
    assert.ok(host.store.get("stale-1") !== undefined, "残留条目保留（目录不删除）");
    // 公理可解析（rules/axiom.json 重建 + 公域规则 fallback）
    assert.ok(host.rules.resolveRule("axiom") !== undefined, "重建域公理可解析");
    assert.ok(host.rules.resolveRule("rule:fact") !== undefined, "重建域规则 fallback 可解析");
  } finally {
    runtime?.dispose(); // 任何路径都停 sweeper
    fx.cleanup();
  }
});
