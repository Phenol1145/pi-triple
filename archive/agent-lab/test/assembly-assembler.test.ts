// AgentAssembler 测试（plan Task 8 / spec §2.2 六步装配流程）。
// 8 场景：成功装配 / workloop 未注册 / config 违 schema / 已注册 agent（幂等冲突）/
// fresh 空私域 + fallback / fork 整库拷贝 + 独立演化 / 失败清理（removeAccount attempt-local）/
// 续跑（open created=false）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkLoopDefinition, AgentInstanceRecord } from "../src/core/contracts.ts";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { MemoryHost } from "../src/assembly/memory-host.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { createEntry } from "../src/memory/entry.ts";
import { AgentRuntime } from "../src/assembly/agent-runtime.ts";
import type { CompiledRule } from "../src/memory/rules.ts";
import type { AgentAssemblerDeps } from "../src/assembly/assembler.ts";
import { createAgentAssembler } from "../src/assembly/assembler.ts";
import { ROUND_SENTINEL, ASSEMBLY_DIR } from "../src/assembly/types.ts";
import type { WorkLoopResult } from "../src/workloop/contracts.ts";
import type { WorkLoopRunRequest } from "../src/workloop/runner.ts";
import type { LedgerPort } from "../src/assembly/ledger-port.ts";
import type { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";

const WL_ID = "test-loop";
const WL_VERSION = "1.0.0";
const NOW = 1_700_000_000_000;

function workloopDef(overrides: Partial<WorkLoopDefinition> = {}): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: WL_ID,
    version: WL_VERSION,
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh", "fork"],
    ...overrides,
  };
}

function done(): WorkLoopResult {
  return {
    status: "completed",
    context: { messages: [], metadata: { contextId: "", sourceRefs: [], artifactRefs: [] } },
    state: {},
  };
}

/** mock ruleBootstrap：resolveRule 对 rule:fact 返回编译产物（记录调用），其余 undefined。 */
function mockRuleBootstrap(): { rb: RuleBootstrap; calls: string[] } {
  const calls: string[] = [];
  const compiled: CompiledRule = {
    ruleId: "rule:fact",
    version: 1,
    grammar: { productions: [] },
    entryName: "fact",
    compiledAt: NOW,
    ebnfText: "fact = word ;",
  };
  const rb = {
    resolveRule: (id: string): CompiledRule | undefined => {
      calls.push(id);
      return id === "rule:fact" ? compiled : undefined;
    },
    ensureInitialized: (): void => {},
  } as unknown as RuleBootstrap;
  return { rb, calls };
}

/** mock ledger：open 返回可配置 created；removeAccount 记录调用（C 接线包项 9：已提进 LedgerPort 接口）。 */
function mockLedger(openResult: { created: boolean }) {
  const openCalls: Array<[string, number]> = [];
  const removeAccountCalls: string[] = [];
  const ledger = {
    open: (agentId: string, initialK: number): { created: boolean } => {
      openCalls.push([agentId, initialK]);
      return openResult;
    },
    balance: (): number => 0,
    credit: (): void => {},
    debit: (): void => {},
    freeze: (): void => {},
    unfreeze: (): void => {},
    removeAccount: (id: string): void => {
      removeAccountCalls.push(id);
    },
  } as unknown as LedgerPort;
  return { ledger, openCalls, removeAccountCalls };
}

interface FreshOpts {
  def?: WorkLoopDefinition;
  openResult?: { created: boolean };
  preRegisteredAgent?: AgentInstanceRecord;
  insertThrows?: Error;
  idGen?: () => string;
}

interface Fixture {
  root: string;
  registry: DefinitionRegistry;
  deps: AgentAssemblerDeps;
  assembler: ReturnType<typeof createAgentAssembler>;
  store: { getAgent(id: string): AgentInstanceRecord | undefined; insertAgent(r: AgentInstanceRecord): void };
  inserted: AgentInstanceRecord[];
  openCalls: Array<[string, number]>;
  removeAccountCalls: string[];
  rbCalls: string[];
  cleanup(): void;
}

function fresh(opts: FreshOpts = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "asm-assembler-"));
  const registry = new DefinitionRegistry();
  registry.register(opts.def ?? workloopDef());

  const inserted: AgentInstanceRecord[] = [];
  const records = new Map<string, AgentInstanceRecord>();
  if (opts.preRegisteredAgent) records.set(opts.preRegisteredAgent.id, opts.preRegisteredAgent);
  const store = {
    getAgent: (id: string): AgentInstanceRecord | undefined => records.get(id),
    insertAgent: (r: AgentInstanceRecord): void => {
      if (opts.insertThrows) throw opts.insertThrows;
      inserted.push(r);
      records.set(r.id, r);
    },
  };

  const { ledger, openCalls, removeAccountCalls } = mockLedger(opts.openResult ?? { created: true });
  const { rb, calls } = mockRuleBootstrap();
  const runner = {
    run: async (_req: WorkLoopRunRequest): Promise<WorkLoopResult> => done(),
  } as unknown as AgentAssemblerDeps["runner"];

  const deps: AgentAssemblerDeps = {
    registry,
    agentStore: store,
    ledger,
    ruleBootstrap: rb,
    runner,
    workDir: root,
    now: () => NOW,
    ...(opts.idGen !== undefined ? { idGen: opts.idGen } : {}),
  };
  const assembler = createAgentAssembler(deps);

  return {
    root,
    registry,
    deps,
    assembler,
    store,
    inserted,
    openCalls,
    removeAccountCalls,
    rbCalls: calls,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const REF = { kind: "workloop" as const, id: WL_ID, version: WL_VERSION };

// ── 1. 成功装配 ─────────────────────────────────────────────────────
test("成功装配：AgentRuntime 返回；insertAgent 断言（ready/哨兵 round/绑定 workloop）；open created=true", () => {
  const fx = fresh({ idGen: () => "ag-1" });
  try {
    const runtime = fx.assembler.assembleAgent(REF, {
      cloneMode: "fresh",
      schedulerInstanceId: "sched-1",
      endowment: { K: 250, initialFloor: 0.1 },
      memory: { dialect: "json" },
    });
    assert.ok(runtime instanceof AgentRuntime);
    assert.equal(runtime.agentId, "ag-1");

    // insertAgent 断言：status ready / 哨兵 round / 绑定 workloop / memorySpec / endowment
    assert.equal(fx.inserted.length, 1);
    const rec = fx.inserted[0] as AgentInstanceRecord & {
      memorySpec?: { dialect: string };
      endowment?: { K: number; initialFloor: number };
    };
    assert.equal(rec.id, "ag-1");
    assert.equal(rec.schedulerInstanceId, "sched-1");
    assert.equal(rec.status, "ready");
    assert.equal(rec.createdAtRoundId, ROUND_SENTINEL);
    assert.equal(rec.createdAt, NOW);
    assert.equal(rec.definition.workLoop.id, WL_ID);
    assert.equal(rec.definition.workLoop.version, WL_VERSION);
    assert.deepEqual(rec.memorySpec, { dialect: "json" });
    assert.deepEqual(rec.endowment, { K: 250, initialFloor: 0.1 });

    // open created=true（flat-K 开户）
    assert.deepEqual(fx.openCalls, [["ag-1", 250]]);

    // 记忆域目录已建（装配产物 <root>/agents/<id>/）
    assert.ok(existsSync(path.join(fx.root, ASSEMBLY_DIR, "ag-1")));

    runtime.dispose(); // 停 sweeper（真实 MemoryHost 定时器）
  } finally {
    fx.cleanup();
  }
});

// ── 2. workloop 未注册 ─────────────────────────────────────────────
test("workloop 未注册 → 抛错", () => {
  const fx = fresh();
  try {
    assert.throws(
      () =>
        fx.assembler.assembleAgent({ kind: "workloop", id: "nope", version: "9.9.9" }, {
          cloneMode: "fresh",
          schedulerInstanceId: "sched-1",
        }),
      /workloop not registered/,
    );
    assert.equal(fx.inserted.length, 0);
  } finally {
    fx.cleanup();
  }
});

// ── 3. config 违 schema ────────────────────────────────────────────
test("config 违 schema → 抛错（含第一条错误）", () => {
  const fx = fresh({
    def: {
      ...workloopDef({
        configSchema: { type: "object", properties: { model: { type: "string" } }, required: ["model"] },
      }),
      config: { model: 123 }, // 定义声明 config（装配器 2a 校验对象；WorkLoopDefinition 类型无此字段——duck-typed）
    } as WorkLoopDefinition & { config: unknown },
  });
  try {
    assert.throws(
      () =>
        fx.assembler.assembleAgent(REF, {
          cloneMode: "fresh",
          schedulerInstanceId: "sched-1",
        }),
      /config validation failed: config\.model: expected string/,
    );
    assert.equal(fx.inserted.length, 0);
  } finally {
    fx.cleanup();
  }
});

// ── 4. 已注册 agent（幂等冲突）──────────────────────────────────────
test("已注册 agent → 抛错（幂等冲突）", () => {
  const existing: AgentInstanceRecord = {
    id: "ag-1",
    schedulerInstanceId: "sched-1",
    definition: {
      standard: { name: "x", capabilities: [], executionKind: "workloop", labels: {} },
      workLoop: { id: WL_ID, version: WL_VERSION, config: {} },
      custom: null,
    },
    createdAtRoundId: "round-0",
    status: "ready",
    createdAt: 1,
  };
  const fx = fresh({ idGen: () => "ag-1", preRegisteredAgent: existing });
  try {
    assert.throws(
      () =>
        fx.assembler.assembleAgent(REF, {
          cloneMode: "fresh",
          schedulerInstanceId: "sched-1",
        }),
      /agent already registered: ag-1/,
    );
    assert.equal(fx.inserted.length, 0);
    assert.equal(fx.openCalls.length, 0); // 未走到开户
  } finally {
    fx.cleanup();
  }
});

// ── 5. fresh：记忆域空私域 + fallback 解析公域种子规则 ──────────────
test("fresh：记忆域空私域 + ruleBootstrap fallback 解析 rule:fact", () => {
  const fx = fresh({ idGen: () => "ag-1" });
  try {
    const runtime = fx.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "sched-1" });
    const agentDir = path.join(fx.root, ASSEMBLY_DIR, "ag-1");
    assert.ok(existsSync(agentDir));

    // 空私域（无 entries）
    const host = new MemoryHost({
      workDir: agentDir,
      pubDir: path.join(fx.root, "public-domain"),
      ruleBootstrap: fx.deps.ruleBootstrap,
      spec: {},
    });
    assert.deepEqual(host.store.listIds(), []);

    // 私域未命中 → fallback 命中 ruleBootstrap mock（公域种子规则视图）
    const rule = host.rules.resolveRule("rule:fact");
    assert.ok(rule !== undefined);
    assert.equal(rule!.ruleId, "rule:fact");
    assert.ok(fx.rbCalls.includes("rule:fact"));

    runtime.dispose();
  } finally {
    fx.cleanup();
  }
});

// ── 6. fork：源私域整库拷贝 + 独立演化 ──────────────────────────────
test("fork：源私域拷贝（条目数一致/索引重建）+ 拷贝后独立演化互不影响", () => {
  const ids = ["ag-src", "ag-fork"];
  let i = 0;
  const fx = fresh({ idGen: () => ids[i++] });
  try {
    // 源 agent（fresh）装配后写两条私域条目
    const src = fx.assembler.assembleAgent(REF, { cloneMode: "fresh", schedulerInstanceId: "sched-1" });
    const srcDir = path.join(fx.root, ASSEMBLY_DIR, "ag-src");
    const srcHost = new MemoryHost({
      workDir: srcDir,
      pubDir: path.join(fx.root, "public-domain"),
      ruleBootstrap: fx.deps.ruleBootstrap,
      spec: {},
    });
    srcHost.store.write(createEntry({ id: "fact-1", kind: "fact", anchors: ["alpha"], content: "a | b | c | 1.0", status: "official" }));
    srcHost.store.write(createEntry({ id: "fact-2", kind: "fact", anchors: ["beta"], content: "d | e | f | 1.0", status: "official" }));
    // 源索引人为损坏（模拟崩溃窗口索引落后）→ fork 拷贝后必须 rebuildIndex 修复
    writeFileSync(path.join(srcDir, "index", "anchors.json"), JSON.stringify({}, null, 2));
    src.dispose();

    // fork 装配
    const fork = fx.assembler.assembleAgent(REF, {
      cloneMode: "fork",
      sourceAgentId: "ag-src",
      schedulerInstanceId: "sched-1",
    });
    assert.equal(fork.agentId, "ag-fork");
    const forkDir = path.join(fx.root, ASSEMBLY_DIR, "ag-fork");
    assert.ok(existsSync(forkDir));

    const forkHost = new MemoryHost({
      workDir: forkDir,
      pubDir: path.join(fx.root, "public-domain"),
      ruleBootstrap: fx.deps.ruleBootstrap,
      spec: {},
    });
    // 条目数一致 + 内容一致
    assert.deepEqual(forkHost.store.listIds(), ["fact-1", "fact-2"]);
    assert.equal(forkHost.store.get("fact-1")?.content, "a | b | c | 1.0");
    // 索引已重建：源索引被破坏为空 → fork 检索 anchor 仍命中
    assert.ok(forkHost.store.retrieve({ anchors: ["alpha"] }).some((e) => e.id === "fact-1"));

    // 独立演化：fork 写入新条目，源不受影响
    forkHost.store.write(createEntry({ id: "fact-3", kind: "fact", anchors: ["gamma"], content: "g | h | i | 1.0", status: "official" }));
    assert.deepEqual(forkHost.store.listIds(), ["fact-1", "fact-2", "fact-3"]);
    const srcStoreAfter = new MemoryStore(srcDir);
    assert.deepEqual(srcStoreAfter.listIds(), ["fact-1", "fact-2"]);

    fork.dispose();
  } finally {
    fx.cleanup();
  }
});

// ── 7. 失败清理：insertAgent 抛 → 记忆域目录已删 + removeAccount（created=true 时）──
test("失败清理：insertAgent 抛 → 目录删除 + removeAccount 被调（created=true）", () => {
  const fx = fresh({ idGen: () => "ag-1", insertThrows: new Error("insert failed") });
  try {
    const agentDir = path.join(fx.root, ASSEMBLY_DIR, "ag-1");
    assert.throws(
      () =>
        fx.assembler.assembleAgent(REF, {
          cloneMode: "fresh",
          schedulerInstanceId: "sched-1",
        }),
      /insert failed/,
    );
    assert.ok(!existsSync(agentDir), "记忆域目录应被清理");
    assert.deepEqual(fx.removeAccountCalls, ["ag-1"]); // attempt-local：本调用创建 → 回滚
  } finally {
    fx.cleanup();
  }
});

test("失败清理：created=false（既有账户续跑）→ removeAccount 不被调（attempt-local）", () => {
  const fx = fresh({
    idGen: () => "ag-1",
    openResult: { created: false },
    insertThrows: new Error("insert failed"),
  });
  try {
    const agentDir = path.join(fx.root, ASSEMBLY_DIR, "ag-1");
    assert.throws(
      () =>
        fx.assembler.assembleAgent(REF, {
          cloneMode: "fresh",
          schedulerInstanceId: "sched-1",
        }),
      /insert failed/,
    );
    assert.ok(!existsSync(agentDir));
    assert.deepEqual(fx.removeAccountCalls, []); // 绝不删除既有账户
  } finally {
    fx.cleanup();
  }
});

// ── 8. 续跑：open created=false（崩溃残留）→ 装配继续成功 ──────────
test("续跑：open {created:false}（模拟崩溃残留）→ 装配继续成功（注册预检未注册）", () => {
  const fx = fresh({ idGen: () => "ag-1", openResult: { created: false } });
  try {
    const runtime = fx.assembler.assembleAgent(REF, {
      cloneMode: "fresh",
      schedulerInstanceId: "sched-1",
      endowment: { K: 100, initialFloor: 0.05 },
    });
    assert.ok(runtime instanceof AgentRuntime);
    assert.equal(runtime.agentId, "ag-1");
    // 续跑仍完成注册持久（注册预检已保证未注册）
    assert.equal(fx.inserted.length, 1);
    assert.equal(fx.inserted[0].status, "ready");
    assert.deepEqual(fx.openCalls, [["ag-1", 100]]);
    runtime.dispose();
  } finally {
    fx.cleanup();
  }
});
