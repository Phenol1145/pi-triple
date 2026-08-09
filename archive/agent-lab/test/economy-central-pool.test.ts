// 中央池测试（plan Task 3 / spec §2）——RESERVED_IDS 双校验 + 池专用负余额路径。
// 5 场景：① ensureCentralPool 幂等（重复调用余额不变）；② poolDebit 允许负余额（100 → -50 不抛错）；
// ③ 普通 debit 仍夹紧（对比）；④ LedgerPort.open(RESERVED_IDS) → 抛错；⑤ assembler 装配 RESERVED_IDS
// → 步骤 2b 后抛错（早于开户）。
//
// 接线约定（T2 裁决）：本模块函数要求 ledger 为共享同一 DatabaseSync 的 SqliteLedger 实例
// （与注入 SqliteVoucher 的 ledger 一致——直读 credits 表耦合），不经 LedgerPort 适配层。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { SqliteLedgerAdapter } from "../src/assembly/ledger-port.ts";
import {
  CENTRAL_POOL_ID,
  RESERVED_IDS,
  ensureCentralPool,
  poolCredit,
  poolDebit,
} from "../src/economy/central-pool.ts";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import type { WorkLoopDefinition } from "../src/core/contracts.ts";
import type { AgentAssemblerDeps } from "../src/assembly/assembler.ts";
import { createAgentAssembler } from "../src/assembly/assembler.ts";
import type { RuleBootstrap } from "../src/assembly/rule-bootstrap.ts";
import type { CompiledRule } from "../src/memory/rules.ts";
import type { WorkLoopResult } from "../src/workloop/contracts.ts";
import type { LedgerPort } from "../src/assembly/ledger-port.ts";

const WL_ID = "pool-test-loop";
const WL_VERSION = "1.0.0";

function freshLedger() {
  const dir = mkdtempSync(path.join(tmpdir(), "eco-pool-"));
  const db = new DatabaseSync(path.join(dir, "ledger.db"));
  const ledger = new SqliteLedger(db);
  return { ledger, db, dir };
}

function close(fx: { db: DatabaseSync; dir: string }): void {
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

function workloopDef(): WorkLoopDefinition {
  return {
    kind: "workloop",
    id: WL_ID,
    version: WL_VERSION,
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
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

/** mock ruleBootstrap（装配器依赖面最小实现）。 */
function mockRuleBootstrap(): RuleBootstrap {
  const compiled: CompiledRule = {
    ruleId: "rule:fact",
    version: 1,
    grammar: { productions: [] },
    entryName: "fact",
    compiledAt: 0,
    ebnfText: "fact = word ;",
  };
  return {
    resolveRule: (id: string): CompiledRule | undefined => (id === "rule:fact" ? compiled : undefined),
    ensureInitialized: (): void => {},
  } as unknown as RuleBootstrap;
}

// ── 常量钉死 ─────────────────────────────────────────────────────
test("RESERVED_IDS 钉死 + CENTRAL_POOL_ID", () => {
  assert.deepEqual([...RESERVED_IDS].sort(), ["calibration-executor", "central-pool"]);
  assert.equal(CENTRAL_POOL_ID, "central-pool");
});

// ── ① ensureCentralPool 幂等 ──────────────────────────────────────
test("① ensureCentralPool：初始化建行 + 重复调用幂等（余额不变）", () => {
  const fx = freshLedger();
  try {
    ensureCentralPool(fx.ledger);
    assert.equal(fx.ledger.balance("central-pool"), 0);
    // 入池后重复初始化不重置
    poolCredit(fx.ledger, 50, "seed");
    ensureCentralPool(fx.ledger);
    ensureCentralPool(fx.ledger);
    assert.equal(fx.ledger.balance("central-pool"), 50);
  } finally {
    close(fx);
  }
});

// ── ② poolDebit 允许负余额 ────────────────────────────────────────
test("② poolDebit：允许负余额（100 → -50 不抛错）", () => {
  const fx = freshLedger();
  try {
    ensureCentralPool(fx.ledger);
    poolCredit(fx.ledger, 100, "seed");
    poolDebit(fx.ledger, 150, "endowment-drain"); // 绕过 debit 夹紧
    assert.equal(fx.ledger.balance("central-pool"), -50);
  } finally {
    close(fx);
  }
});

// ── ③ 普通 debit 仍夹紧（对比）────────────────────────────────────
test("③ 普通 debit 仍夹紧：balance 100 debit 150 → 0（不越负）", () => {
  const fx = freshLedger();
  try {
    ensureCentralPool(fx.ledger);
    poolCredit(fx.ledger, 100, "seed");
    fx.ledger.debit("central-pool", 150, "normal-debit"); // arena clamp 语义
    assert.equal(fx.ledger.balance("central-pool"), 0);
  } finally {
    close(fx);
  }
});

// ── ④ LedgerPort.open 拒绝 RESERVED_IDS ──────────────────────────
test("④ LedgerPort.open(RESERVED_IDS) → 抛错且未建行", () => {
  const fx = freshLedger();
  const adapter = new SqliteLedgerAdapter(fx.ledger);
  try {
    for (const id of RESERVED_IDS) {
      assert.throws(() => adapter.open(id, 100), /reserved/);
      assert.equal(adapter.balance(id), 0); // 未建行
    }
    // 对照：非保留 id 正常开户
    assert.deepEqual(adapter.open("a-1", 100), { created: true });
    assert.equal(adapter.balance("a-1"), 100);
  } finally {
    close(fx);
  }
});

// ── ⑤ assembler 装配 RESERVED_IDS → 步骤 2b 后抛错（早于开户）─────
test("⑤ assembler 装配 agentId=RESERVED_IDS → 抛错，早于开户/注册", () => {
  const fx = freshLedger();
  const root = mkdtempSync(path.join(tmpdir(), "eco-pool-asm-"));
  const registry = new DefinitionRegistry();
  registry.register(workloopDef());
  const inserted: unknown[] = [];
  const openCalls: Array<[string, number]> = [];
  const port = {
    open: (agentId: string, initialK: number): { created: boolean } => {
      openCalls.push([agentId, initialK]);
      return { created: true };
    },
    balance: (): number => 0,
    credit: (): void => {},
    debit: (): void => {},
    freeze: (): void => {},
    unfreeze: (): void => {},
  } as unknown as LedgerPort;
  const runner = { run: async (): Promise<WorkLoopResult> => done() } as unknown as AgentAssemblerDeps["runner"];
  const deps: AgentAssemblerDeps = {
    registry,
    agentStore: {
      getAgent: () => undefined,
      insertAgent: (r: unknown): void => {
        inserted.push(r);
      },
    },
    ledger: port,
    ruleBootstrap: mockRuleBootstrap(),
    runner,
    workDir: root,
    idGen: () => "central-pool",
  };
  try {
    const assembler = createAgentAssembler(deps);
    assert.throws(
      () =>
        assembler.assembleAgent(
          { kind: "workloop", id: WL_ID, version: WL_VERSION },
          { cloneMode: "fresh", schedulerInstanceId: "sched-1" },
        ),
      /reserved/,
    );
    assert.equal(openCalls.length, 0); // 早于开户（步骤 4）
    assert.equal(inserted.length, 0);  // 早于注册（步骤 5）
    assert.equal(fx.ledger.balance("central-pool"), 0); // 池账户未被外部装配创建
  } finally {
    close(fx);
    rmSync(root, { recursive: true, force: true });
  }
});
