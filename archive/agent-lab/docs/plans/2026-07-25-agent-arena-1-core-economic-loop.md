# Agent Arena-1 (核心经济闭环) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agent-lab 扩展内新增 `arena/` 模块，实现 Market 模式的核心经济闭环：credits 账本+初始发放、任务发布+押注竞价、博彩式结算、三类用量成本、轮次记录，并与 Classic（M2）模式手动切换。

**Architecture:** 接口优先——经济规则全部落在可插拔策略接口（Endowment/Odds/Bidding/Settlement/CostModel/Judge）后，v1 给具体实现。`MarketV1` 编排 allocate(征bid选中标)/settle(结算)；`SqliteLedger` 记账（含 round/agent_turn）。interceptor/telemetry 钩子按 `cfg.mode` 分流：classic→M2，market→Market（失败 fail-open 降级 classic）。

**Tech Stack:** TypeScript（pi 经 jiti 加载）；`node:sqlite`（DatabaseSync，经 `SqliteStore.raw` 共享连接）；`node:test`；pi 扩展 API + `typebox`（仅胶水层）；pi-ai（BiddingPolicy 轻量模型调用，运行时）。

## Global Constraints

- Node ≥ 22.5（v24.14.1）；`node:sqlite` 无 flag。相对导入用 `.ts` 扩展名。
- 纯逻辑模块（`arena/ledger.ts`、`arena/policies.ts`、`arena/market.ts`、`arena/bidding.ts` 的策略部分）**不得** import pi 内部；pi import（`import type ExtensionAPI`、`typebox`、pi-ai）仅出现在 `index.ts` 与 `*/register.ts`。
- **fail-open**：Market/钩子任何异常绝不阻断 subagent 派发；market 分配失败降级为 classic（M2）。
- 余额钳制 ≥ 0（v1 无负债）。押注截断到可用余额 `balance − frozen`。
- 中标平局：stake 大者 → 可用余额高者 → `agent` id 字典序（确定性）。
- 设置统一走 `/lab config`；`mode` 为 config 键；Arena 操作挂 `/lab arena …`；`/lab mode` 快捷切换。
- 测试命令：`node --experimental-strip-types --test test/*.test.ts`。
- 每个任务结尾单独 commit。

---

## File Structure

```
src/types.ts            # (改) 增 Mode/ArenaConfig；LabConfig 增 mode+arena
src/config.ts           # (改) DEFAULT_ARENA_CONFIG；mergeConfig 深合并 arena
src/store/store.ts      # (改) 增 get raw(): DatabaseSync
src/arena/types.ts      # (新) AgentId/AgentState/ArenaTask/Bid/Outcome/CreditTx + 策略接口 + Ledger/Market
src/arena/ledger.ts     # (新) SqliteLedger（建 arena 表；记账/冻结/轮次/任务）
src/arena/policies.ts   # (新) Endowment/Odds/Settlement/CostModel v1 + bid 解析/提示词渲染
src/arena/market.ts     # (新) MarketV1（allocate/settle）
src/arena/bidding.ts    # (新) BiddingPolicyV1（逐个问模型押注）+ ModelCaller 接口
src/arena/register.ts   # (新) arena 命令辅助（leaderboard/history/applyArenaConfig）
src/interceptor/register.ts  # (改) mode 感知（market→Market.allocate，失败降级 classic）
src/telemetry/register.ts    # (改) 若有 market_task 则 Market.settle
src/commands/register.ts     # (改) /lab mode、/lab arena …、applyConfig 支持 mode+arena 键
index.ts                # (改) 装配 Ledger/Market，传入钩子与命令
test/arena-ledger.test.ts    # (新)
test/arena-policies.test.ts  # (新)
test/arena-market.test.ts    # (新)
test/arena-bidding.test.ts   # (新)
test/config.test.ts          # (改) 增 mode/arena 测试
```

---

## Task 1: 类型 + 配置（arena）

**Files:**
- Modify: `src/types.ts`（增 `Mode`/`ArenaConfig`；`LabConfig` 增 `mode`+`arena`）
- Modify: `src/config.ts`（`DEFAULT_ARENA_CONFIG`；`mergeConfig` 深合并 arena）
- Create: `src/arena/types.ts`
- Test: `test/config.test.ts`（扩展）

**Interfaces:**
- Produces: `Mode`, `ArenaConfig`, `DEFAULT_ARENA_CONFIG`, `mergeConfig`(扩展)；`AgentId/AgentState/ArenaTask/Bid/Outcome/CreditTx` + 策略接口 + `Ledger/Market/MarketAllocation`。

- [ ] **Step 1: 写失败测试（扩展 test/config.test.ts，在文件末尾追加）**

在 `test/config.test.ts` 顶部 import 处补 `ArenaConfig` 类型，并追加：
```ts
test("mode defaults to classic and arena defaults present", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.mode, "classic");
  assert.equal(cfg.arena.endowment.K, 100);
  assert.equal(cfg.arena.odds.hard, 5.0);
  assert.equal(cfg.arena.settlement.errorMode, "stakeTimesOdds");
});

test("arena deep-merge keeps siblings", () => {
  const cfg = mergeConfig({ arena: { endowment: { K: 200 } } as ArenaConfig });
  assert.equal(cfg.arena.endowment.K, 200);
  assert.equal(cfg.arena.endowment.floor, 0.05);
  assert.equal(cfg.arena.odds.easy, 1.5);
});
```
（顶部 import 改为：`import { DEFAULT_CONFIG, mergeConfig, DEFAULT_ARENA_CONFIG } from "../src/config.ts";` 和 `import type { ArenaConfig, LabConfig } from "../src/types.ts";`）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/config.test.ts`
Expected: FAIL（`cfg.mode`/`cfg.arena` 不存在 / `DEFAULT_ARENA_CONFIG` 未导出）

- [ ] **Step 3: 改 src/types.ts（在 LabConfig 之后追加 Mode/ArenaConfig，并给 LabConfig 增字段）**

将 `LabConfig` 接口改为：
```ts
export interface LabConfig {
  weights: Weights;
  autoApply: boolean;
  acceptanceScoreMap: Record<string, number>;
  interruptedPenalty: number;
  toolFailPenalty: number;
  topN: number;
  catalogTtlMs: number;
  mode: Mode;
  arena: ArenaConfig;
}

export type Mode = "classic" | "market";

export interface ArenaConfig {
  endowment: { K: number; floor: number };
  odds: { easy: number; medium: number; hard: number };
  settlement: { tax: number; errorMode: "stakeOnly" | "stakeTimesOdds" };
  cost: { tokenMult: number; toolMult: number; latencyMult: number; resourceFactor: number; toolWeights: Record<string, number> };
  bidding: { timeoutMs: number; promptTemplate: string };
  market: { staleTaskTimeoutMs: number; eligibility: string };
}
```

- [ ] **Step 4: 创建 src/arena/types.ts**

```ts
import type { ModelInfo } from "../types.ts";

export type AgentId = string;   // v1 = model id

export interface AgentState { agent: AgentId; model: ModelInfo; balance: number; }

export interface ArenaTask {
  id: string;
  role: string;
  prompt: string;
  difficulty: "easy" | "medium" | "hard" | number;
  odds: number;
  reward: number;
}

export interface Bid { agent: AgentId; stake: number; }
export interface ToolCallStat { name: string; durationMs: number; }

export interface Outcome {
  completion: number;
  majorError: boolean;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  toolCalls: ToolCallStat[];
  inferenceLatencyMs: number;
}

export interface CreditTx {
  id: number; ts: number; agent: AgentId; delta: number;
  reason?: string; taskId?: string; round?: number; agentTurn?: number;
}

export interface EndowmentPolicy { initialCredits(m: ModelInfo): number; }
export interface OddsPolicy { odds(t: ArenaTask): number; }
export interface BiddingPolicy { solicitBids(t: ArenaTask, c: AgentState[]): Promise<Bid[]>; }
export interface SettlementPolicy { settle(t: ArenaTask, stake: number, o: Outcome): number; }
export interface CostModel { usageCost(o: Outcome, m: ModelInfo): number; }
export interface Judge { score(t: ArenaTask, outputs: unknown[]): number[]; }   // 占位，Arena-8

export interface MarketTaskRow {
  taskId: string; role: string; prompt: string; difficulty: string;
  odds: number; reward: number; winner: string; stake: number; status: string; round: number;
}

export interface Ledger {
  balance(a: AgentId): number;
  ensureEndowed(a: AgentId, m: ModelInfo): void;
  credit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void;
  debit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void;
  freeze(a: AgentId, amt: number, taskId: string): void;
  unfreeze(a: AgentId, taskId: string): number;
  leaderboard(): { agent: AgentId; balance: number }[];
  history(a?: AgentId, limit?: number): CreditTx[];
  currentRound(): number;
  nextRound(): number;
  agentTurn(a: AgentId): number;
  createTask(t: ArenaTask, winner: AgentId, stake: number, round: number): void;
  getTask(taskId: string): MarketTaskRow | undefined;
  setTaskStatus(taskId: string, status: string): void;
}

export interface MarketAllocation { winner: AgentId; model: string; stake: number; taskId: string; round: number; }
export interface Market {
  allocate(t: ArenaTask): Promise<MarketAllocation | undefined>;
  settle(taskId: string, o: Outcome): void;
}
```

- [ ] **Step 5: 改 src/config.ts**

```ts
import type { ArenaConfig, LabConfig } from "./types.ts";

export const DEFAULT_ARENA_CONFIG: ArenaConfig = {
  endowment: { K: 100, floor: 0.05 },
  odds: { easy: 1.5, medium: 3.0, hard: 5.0 },
  settlement: { tax: 5, errorMode: "stakeTimesOdds" },
  cost: { tokenMult: 1.0, toolMult: 1.0, latencyMult: 1.0, resourceFactor: 1.0, toolWeights: { bash: 1.0, edit: 0.8, write: 0.8, read: 0.2 } },
  bidding: { timeoutMs: 10000, promptTemplate: "任务：{prompt}（角色 {role}），难度 {difficulty}，赔率 {odds}。你当前 credits：{balance}。可押不超过可用余额。你押多少 credits 接此任务？只回一个数字。" },
  market: { staleTaskTimeoutMs: 600000, eligibility: "all" },
};

export const DEFAULT_CONFIG: LabConfig = {
  weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
  autoApply: true,
  acceptanceScoreMap: { reviewed: 1.0, verified: 0.9, checked: 0.7, attested: 0.5, auto: 0.4, none: 0.2 },
  interruptedPenalty: 0.3,
  toolFailPenalty: 0.2,
  topN: 3,
  catalogTtlMs: 21_600_000,
  mode: "classic",
  arena: mergeArena(DEFAULT_ARENA_CONFIG),
};

export function mergeConfig(partial: Partial<LabConfig> | undefined): LabConfig {
  if (!partial) {
    return { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights }, acceptanceScoreMap: { ...DEFAULT_CONFIG.acceptanceScoreMap }, arena: mergeArena(DEFAULT_ARENA_CONFIG) };
  }
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    weights: { ...DEFAULT_CONFIG.weights, ...(partial.weights ?? {}) },
    acceptanceScoreMap: { ...DEFAULT_CONFIG.acceptanceScoreMap, ...(partial.acceptanceScoreMap ?? {}) },
    arena: mergeArena(DEFAULT_ARENA_CONFIG, partial.arena),
  };
}

function mergeArena(base: ArenaConfig, partial?: ArenaConfig): ArenaConfig {
  return {
    endowment: { ...base.endowment, ...(partial?.endowment ?? {}) },
    odds: { ...base.odds, ...(partial?.odds ?? {}) },
    settlement: { ...base.settlement, ...(partial?.settlement ?? {}) },
    cost: { ...base.cost, ...(partial?.cost ?? {}), toolWeights: { ...base.cost.toolWeights, ...(partial?.cost?.toolWeights ?? {}) } },
    bidding: { ...base.bidding, ...(partial?.bidding ?? {}) },
    market: { ...base.market, ...(partial?.market ?? {}) },
  };
}
```
（保留原 `mergeConfig` 的导出名；删除旧实现，替换为上面版本。）

- [ ] **Step 6: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/config.test.ts`
Expected: PASS（5 个：原 3 + 新 2）

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts src/arena/types.ts test/config.test.ts
git commit -m "feat(arena): types + arena config (mode, endowment/odds/settlement/cost/bidding/market)"
```

---

## Task 2: Ledger（记账/冻结/轮次/任务）

**Files:**
- Modify: `src/store/store.ts`（增 `get raw()`）
- Create: `src/arena/ledger.ts`
- Test: `test/arena-ledger.test.ts`

**Interfaces:**
- Consumes: `ModelInfo`, `EndowmentPolicy`, `Ledger`, `ArenaTask`, `CreditTx`, `MarketTaskRow`
- Produces: `class SqliteLedger implements Ledger { constructor(db: DatabaseSync, endowment: EndowmentPolicy) }`；`SqliteStore.raw`。

- [ ] **Step 1: 写失败测试 test/arena-ledger.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import type { ModelInfo } from "../src/types.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
function model(id: string): ModelInfo { return { id, provider: id.split("/")[0], name: id, accessRoute: "free" }; }
function mk() {
  const store = new SqliteStore(":memory:");
  const ledger = new SqliteLedger(store.raw, fixedEndow);
  return { store, ledger };
}

test("ensureEndowed grants initial credits once", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  assert.equal(ledger.balance("m/a"), 1000);
  ledger.ensureEndowed("m/a", model("m/a"));
  assert.equal(ledger.balance("m/a"), 1000);
});

test("credit/debit clamps at 0 (no debt)", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.credit("m/a", 500, "reward");
  assert.equal(ledger.balance("m/a"), 1500);
  ledger.debit("m/a", 2000, "loss");
  assert.equal(ledger.balance("m/a"), 0);
});

test("freeze/unfreeze conserves balance", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.freeze("m/a", 300, "t1");
  assert.equal(ledger.balance("m/a"), 700);
  assert.equal(ledger.unfreeze("m/a", "t1"), 300);
  assert.equal(ledger.balance("m/a"), 1000);
});

test("nextRound increments and persists", () => {
  const { ledger } = mk();
  assert.equal(ledger.currentRound(), 0);
  assert.equal(ledger.nextRound(), 1);
  assert.equal(ledger.nextRound(), 2);
  assert.equal(ledger.currentRound(), 2);
});

test("createTask/getTask/setTaskStatus + agentTurn", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.createTask({ id: "t1", role: "r", prompt: "p", difficulty: "easy", odds: 1.5, reward: 10 }, "m/a", 100, 1);
  const t = ledger.getTask("t1")!;
  assert.equal(t.winner, "m/a");
  assert.equal(t.status, "pending");
  assert.equal(ledger.agentTurn("m/a"), 0);
  ledger.setTaskStatus("t1", "settled");
  assert.equal(ledger.getTask("t1")!.status, "settled");
  assert.equal(ledger.agentTurn("m/a"), 1);
});

test("leaderboard ordered desc", () => {
  const { ledger } = mk();
  ledger.ensureEndowed("m/a", model("m/a"));
  ledger.ensureEndowed("m/b", model("m/b"));
  ledger.credit("m/b", 500, "x");
  assert.equal(ledger.leaderboard()[0].agent, "m/b");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/arena-ledger.test.ts`
Expected: FAIL（`SqliteLedger` / `store.raw` 不存在）

- [ ] **Step 3: 改 src/store/store.ts（在 SqliteStore 类内 constructor 之后加 accessor）**

在 `constructor(path: string) { ... }` 之后插入：
```ts
  get raw(): DatabaseSync { return this.db; }
```

- [ ] **Step 4: 创建 src/arena/ledger.ts**

```ts
import type { DatabaseSync } from "node:sqlite";
import type { ModelInfo } from "../types.ts";
import type { AgentId, ArenaTask, CreditTx, EndowmentPolicy, Ledger, MarketTaskRow } from "./types.ts";

const ARENA_SCHEMA = `
CREATE TABLE IF NOT EXISTS credits (
  agent TEXT PRIMARY KEY, balance REAL NOT NULL, frozen REAL NOT NULL DEFAULT 0, updated_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, delta REAL NOT NULL,
  reason TEXT, task_id TEXT, round INTEGER, agent_turn INTEGER
);
CREATE TABLE IF NOT EXISTS market_tasks (
  task_id TEXT PRIMARY KEY, round INTEGER, role TEXT, prompt TEXT, difficulty TEXT,
  odds REAL, reward REAL, winner TEXT, stake REAL, status TEXT, created_ts INTEGER
);
CREATE TABLE IF NOT EXISTS market_meta ( key TEXT PRIMARY KEY, value TEXT );
`;

export class SqliteLedger implements Ledger {
  private db: DatabaseSync;
  private endowment: EndowmentPolicy;
  constructor(db: DatabaseSync, endowment: EndowmentPolicy) {
    this.db = db;
    this.endowment = endowment;
    this.db.exec(ARENA_SCHEMA);
  }
  private now(): number { return Date.now(); }
  private ensureRow(a: AgentId): void {
    if (!this.db.prepare(`SELECT agent FROM credits WHERE agent = ?`).get(a)) {
      this.db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?, 0, 0, ?)`).run(a, this.now());
    }
  }
  private recordTx(a: AgentId, delta: number, reason: string, taskId?: string, round?: number): void {
    this.db.prepare(`INSERT INTO credit_tx (ts, agent, delta, reason, task_id, round, agent_turn) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(this.now(), a, delta, reason, taskId ?? null, round ?? null, this.agentTurn(a));
  }
  balance(a: AgentId): number {
    const row = this.db.prepare(`SELECT balance FROM credits WHERE agent = ?`).get(a) as { balance: number } | undefined;
    return row?.balance ?? 0;
  }
  ensureEndowed(a: AgentId, m: ModelInfo): void {
    if (this.db.prepare(`SELECT agent FROM credits WHERE agent = ?`).get(a)) return;
    const initial = this.endowment.initialCredits(m);
    this.db.prepare(`INSERT INTO credits (agent, balance, frozen, updated_ts) VALUES (?, ?, 0, ?)`).run(a, initial, this.now());
    this.recordTx(a, initial, "endowment", undefined, this.currentRound());
  }
  credit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void {
    this.ensureRow(a);
    this.db.prepare(`UPDATE credits SET balance = balance + ?, updated_ts = ? WHERE agent = ?`).run(amt, this.now(), a);
    this.recordTx(a, amt, reason, taskId, round);
  }
  debit(a: AgentId, amt: number, reason: string, taskId?: string, round?: number): void {
    this.ensureRow(a);
    const actual = Math.min(amt, Math.max(0, this.balance(a)));
    this.db.prepare(`UPDATE credits SET balance = balance - ?, updated_ts = ? WHERE agent = ?`).run(actual, this.now(), a);
    this.recordTx(a, -actual, reason, taskId, round);
  }
  freeze(a: AgentId, amt: number, _taskId: string): void {
    this.ensureRow(a);
    this.db.prepare(`UPDATE credits SET balance = balance - ?, frozen = frozen + ?, updated_ts = ? WHERE agent = ?`).run(amt, amt, this.now(), a);
  }
  unfreeze(a: AgentId, _taskId: string): number {
    const row = this.db.prepare(`SELECT frozen FROM credits WHERE agent = ?`).get(a) as { frozen: number } | undefined;
    const amt = row?.frozen ?? 0;
    if (amt > 0) this.db.prepare(`UPDATE credits SET balance = balance + ?, frozen = 0, updated_ts = ? WHERE agent = ?`).run(amt, this.now(), a);
    return amt;
  }
  leaderboard(): { agent: AgentId; balance: number }[] {
    const rows = this.db.prepare(`SELECT agent, balance FROM credits ORDER BY balance DESC, agent ASC`).all() as { agent: string; balance: number }[];
    return rows.map((r) => ({ agent: r.agent, balance: r.balance }));
  }
  history(a?: AgentId, limit = 100): CreditTx[] {
    const rows = a
      ? this.db.prepare(`SELECT id, ts, agent, delta, reason, task_id AS taskId, round, agent_turn AS agentTurn FROM credit_tx WHERE agent = ? ORDER BY id DESC LIMIT ?`).all(a, limit)
      : this.db.prepare(`SELECT id, ts, agent, delta, reason, task_id AS taskId, round, agent_turn AS agentTurn FROM credit_tx ORDER BY id DESC LIMIT ?`).all(limit);
    return rows as CreditTx[];
  }
  currentRound(): number {
    const row = this.db.prepare(`SELECT value FROM market_meta WHERE key = 'current_round'`).get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }
  nextRound(): number {
    const next = this.currentRound() + 1;
    this.db.prepare(`INSERT INTO market_meta (key, value) VALUES ('current_round', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
    return next;
  }
  agentTurn(a: AgentId): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM market_tasks WHERE winner = ? AND status = 'settled'`).get(a) as { n: number };
    return Number(row.n);
  }
  createTask(t: ArenaTask, winner: AgentId, stake: number, round: number): void {
    this.db.prepare(`INSERT INTO market_tasks (task_id, round, role, prompt, difficulty, odds, reward, winner, stake, status, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(t.id, round, t.role, t.prompt, String(t.difficulty), t.odds, t.reward, winner, stake, this.now());
  }
  getTask(taskId: string): MarketTaskRow | undefined {
    const row = this.db.prepare(`SELECT task_id AS taskId, role, prompt, difficulty, odds, reward, winner, stake, status, round FROM market_tasks WHERE task_id = ?`).get(taskId);
    return row as MarketTaskRow | undefined;
  }
  setTaskStatus(taskId: string, status: string): void {
    this.db.prepare(`UPDATE market_tasks SET status = ? WHERE task_id = ?`).run(status, taskId);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/arena-ledger.test.ts`
Expected: PASS（6 个）

- [ ] **Step 6: Commit**

```bash
git add src/store/store.ts src/arena/ledger.ts test/arena-ledger.test.ts
git commit -m "feat(arena): SqliteLedger (balances/freeze/rounds/tasks) + store.raw accessor"
```

---

## Task 3: 策略（纯函数）

**Files:**
- Create: `src/arena/policies.ts`
- Test: `test/arena-policies.test.ts`

**Interfaces:**
- Consumes: `ArenaConfig`, `ModelInfo`, `blendedPrice`, arena 类型
- Produces: `EndowmentPolicyV1`, `OddsPolicyV1`, `SettlementPolicyV1`, `CostModelV1`, `renderBidPrompt`, `parseBidResponse`, `DEFAULT_BID_PROMPT`。

- [ ] **Step 1: 写失败测试 test/arena-policies.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EndowmentPolicyV1, OddsPolicyV1, SettlementPolicyV1, CostModelV1, parseBidResponse, renderBidPrompt, DEFAULT_BID_PROMPT } from "../src/arena/policies.ts";
import { DEFAULT_ARENA_CONFIG } from "../src/config.ts";
import type { ModelInfo } from "../src/types.ts";
import type { ArenaTask, Outcome } from "../src/arena/types.ts";

const cfg = DEFAULT_ARENA_CONFIG;
function model(price?: { in: number; out: number }): ModelInfo {
  const free = price != null && price.in === 0 && price.out === 0;
  return { id: "x/y", provider: "x", name: "y", pricing: price, accessRoute: free ? "free" : "direct" };
}
const task: ArenaTask = { id: "t", role: "r", prompt: "p", difficulty: "medium", odds: 3.0, reward: 10 };
const clean: Outcome = { completion: 1, majorError: false, tokensIn: 0, tokensOut: 0, cost: 0, toolCalls: [], inferenceLatencyMs: 0 };

test("EndowmentPolicyV1 inverse price + floor cap", () => {
  const p = new EndowmentPolicyV1(cfg);
  assert.equal(p.initialCredits(model({ in: 0, out: 0 })), Math.round(100 / 0.05));
  assert.equal(p.initialCredits(model({ in: 0.27, out: 0.27 })), Math.round(100 / 0.27));
});

test("OddsPolicyV1 tiers + override", () => {
  const p = new OddsPolicyV1(cfg);
  assert.equal(p.odds({ ...task, difficulty: "easy", odds: 0 }), 1.5);
  assert.equal(p.odds({ ...task, difficulty: "hard", odds: 0 }), 5.0);
  assert.equal(p.odds({ ...task, difficulty: "medium", odds: 0 }), 3.0);
  assert.equal(p.odds({ ...task, odds: 7 }), 7);
});

test("SettlementPolicyV1 betting math", () => {
  const p = new SettlementPolicyV1(cfg);
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, completion: 1 }) - 200) < 1e-9);
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, completion: 0.5 }) - 0) < 1e-9);
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, completion: 0 }) - (-200)) < 1e-9);
  assert.ok(Math.abs(p.settle(task, 100, { ...clean, majorError: true }) - (-300)) < 1e-9);
});

test("CostModelV1 sums token+tool+inference", () => {
  const p = new CostModelV1(cfg);
  const o: Outcome = { completion: 1, majorError: false, tokensIn: 1_000_000, tokensOut: 0, cost: 0, toolCalls: [{ name: "bash", durationMs: 10 }], inferenceLatencyMs: 5 };
  const cost = p.usageCost(o, model({ in: 0.3, out: 0.3 }));
  assert.ok(Math.abs(cost - (0.3 + 10 + 5)) < 1e-9);
});

test("parseBidResponse caps and rejects", () => {
  assert.equal(parseBidResponse("150", 1000), 150);
  assert.equal(parseBidResponse("I stake 9999 credits", 1000), 1000);
  assert.equal(parseBidResponse("no idea", 1000), 0);
  assert.equal(parseBidResponse("-50", 1000), 0);
});

test("renderBidPrompt fills vars", () => {
  const s = renderBidPrompt(DEFAULT_BID_PROMPT, { prompt: "P", role: "R", difficulty: "easy", odds: 1.5, balance: 100 });
  assert.ok(s.includes("P") && s.includes("R") && s.includes("1.5") && s.includes("100"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/arena-policies.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 src/arena/policies.ts**

```ts
import type { ArenaConfig, ModelInfo } from "../types.ts";
import type { ArenaTask, CostModel, EndowmentPolicy, OddsPolicy, Outcome, SettlementPolicy } from "./types.ts";
import { blendedPrice } from "../catalog/parse.ts";

export class EndowmentPolicyV1 implements EndowmentPolicy {
  constructor(private cfg: ArenaConfig) {}
  initialCredits(m: ModelInfo): number {
    const price = blendedPrice(m);
    return Math.round(this.cfg.endowment.K / Math.max(price, this.cfg.endowment.floor));
  }
}

export class OddsPolicyV1 implements OddsPolicy {
  constructor(private cfg: ArenaConfig) {}
  odds(t: ArenaTask): number {
    if (t.odds && t.odds > 0) return t.odds;
    if (t.difficulty === "easy") return this.cfg.odds.easy;
    if (t.difficulty === "hard") return this.cfg.odds.hard;
    return this.cfg.odds.medium;
  }
}

export class SettlementPolicyV1 implements SettlementPolicy {
  constructor(private cfg: ArenaConfig) {}
  settle(t: ArenaTask, stake: number, o: Outcome): number {
    const O = t.odds;
    if (o.majorError) return this.cfg.settlement.errorMode === "stakeOnly" ? -stake : -stake * O;
    const c = Math.max(0, Math.min(1, o.completion));
    return stake * (O - 1) * (2 * c - 1);
  }
}

export class CostModelV1 implements CostModel {
  constructor(private cfg: ArenaConfig) {}
  usageCost(o: Outcome, m: ModelInfo): number {
    const priceIn = m.pricing?.in ?? 0;
    const priceOut = m.pricing?.out ?? 0;
    const tokenCost = ((o.tokensIn * priceIn + o.tokensOut * priceOut) / 1_000_000) * this.cfg.cost.tokenMult;
    let toolCost = 0;
    for (const tc of o.toolCalls) {
      const w = this.cfg.cost.toolWeights[tc.name] ?? 0.5;
      toolCost += w * tc.durationMs * this.cfg.cost.resourceFactor;
    }
    toolCost *= this.cfg.cost.toolMult;
    const inferenceCost = o.inferenceLatencyMs * this.cfg.cost.latencyMult;
    return tokenCost + toolCost + inferenceCost;
  }
}

export const DEFAULT_BID_PROMPT = "任务：{prompt}（角色 {role}），难度 {difficulty}，赔率 {odds}。你当前 credits：{balance}。可押不超过可用余额。你押多少 credits 接此任务？只回一个数字。";

export function renderBidPrompt(template: string, vars: { prompt: string; role: string; difficulty: string; odds: number; balance: number }): string {
  return template
    .replaceAll("{prompt}", vars.prompt)
    .replaceAll("{role}", vars.role)
    .replaceAll("{difficulty}", vars.difficulty)
    .replaceAll("{odds}", String(vars.odds))
    .replaceAll("{balance}", String(vars.balance));
}

export function parseBidResponse(reply: string, availableBalance: number): number {
  const match = reply.match(/-?\d+(\.\d+)?/);
  if (!match) return 0;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, Math.max(0, availableBalance));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/arena-policies.test.ts`
Expected: PASS（6 个）

- [ ] **Step 5: Commit**

```bash
git add src/arena/policies.ts test/arena-policies.test.ts
git commit -m "feat(arena): policies v1 (endowment/odds/settlement/cost) + bid parse/render"
```

---

## Task 4: Market 编排器

**Files:**
- Create: `src/arena/market.ts`
- Test: `test/arena-market.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `CatalogService`, `BiddingPolicy`, `OddsPolicy`, `SettlementPolicy`, `CostModel`, `LabConfig`, arena 类型
- Produces: `class MarketV1 implements Market { constructor(deps: MarketDeps) }`，`MarketDeps`。

- [ ] **Step 1: 写失败测试 test/arena-market.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { MarketV1 } from "../src/arena/market.ts";
import { EndowmentPolicyV1, OddsPolicyV1, SettlementPolicyV1, CostModelV1 } from "../src/arena/policies.ts";
import { mergeConfig } from "../src/config.ts";
import type { CatalogService } from "../src/catalog/catalog.ts";
import type { ModelInfo } from "../src/types.ts";
import type { AgentState, ArenaTask, Bid, BiddingPolicy, Outcome } from "../src/arena/types.ts";

const cfg = mergeConfig(undefined);
function model(id: string, price = { in: 0.3, out: 0.3 }): ModelInfo { return { id, provider: id.split("/")[0], name: id, pricing: price, accessRoute: "direct" }; }
function mockCatalog(models: ModelInfo[]): CatalogService { return { candidates: () => models } as unknown as CatalogService; }
function fixedBidding(stakes: Record<string, number>): BiddingPolicy {
  return { solicitBids: async (_t: ArenaTask, c: AgentState[]): Promise<Bid[]> => c.map((s) => ({ agent: s.agent, stake: stakes[s.agent] ?? 0 })) };
}
function mkMarket(models: ModelInfo[], bidding: BiddingPolicy) {
  const store = new SqliteStore(":memory:");
  const endow = new EndowmentPolicyV1(cfg.arena);
  const ledger = new SqliteLedger(store.raw, endow);
  const market = new MarketV1({ ledger, catalog: mockCatalog(models), bidding, odds: new OddsPolicyV1(cfg.arena), settlement: new SettlementPolicyV1(cfg.arena), costModel: new CostModelV1(cfg.arena), cfg });
  return { store, ledger, market };
}
const task: ArenaTask = { id: "t1", role: "r", prompt: "p", difficulty: "medium", odds: 3.0, reward: 10 };
const success: Outcome = { completion: 1, majorError: false, tokensIn: 0, tokensOut: 0, cost: 0, toolCalls: [], inferenceLatencyMs: 0 };
const ENDOW_0_3 = Math.round(100 / 0.3); // 333

test("allocate picks max stake, freezes, creates task", async () => {
  const { ledger, market } = mkMarket([model("m/a"), model("m/b")], fixedBidding({ "m/a": 100, "m/b": 300 }));
  const res = await market.allocate(task);
  assert.ok(res);
  assert.equal(res!.winner, "m/b");
  assert.equal(res!.stake, 300);
  assert.equal(ledger.balance("m/b"), ENDOW_0_3 - 300);
});

test("settle success credits winner (unfreeze + D)", async () => {
  const { ledger, market } = mkMarket([model("m/a"), model("m/b")], fixedBidding({ "m/a": 100, "m/b": 300 }));
  const res = await market.allocate(task);
  market.settle(res!.taskId, success); // O=3, stake=300 -> D=+600, U=0
  assert.equal(ledger.balance("m/b"), ENDOW_0_3 + 600);
  assert.equal(ledger.getTask(res!.taskId)!.status, "settled");
});

test("fail-open: bidding throws -> undefined", async () => {
  const throwing: BiddingPolicy = { solicitBids: async () => { throw new Error("boom"); } };
  const { market } = mkMarket([model("m/a")], throwing);
  assert.equal(await market.allocate(task), undefined);
});

test("no eligible bids -> undefined", async () => {
  const { market } = mkMarket([model("m/a")], fixedBidding({ "m/a": 0 }));
  assert.equal(await market.allocate(task), undefined);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/arena-market.test.ts`
Expected: FAIL（`MarketV1` 不存在）

- [ ] **Step 3: 创建 src/arena/market.ts**

```ts
import type { LabConfig } from "../types.ts";
import type { CatalogService } from "../catalog/catalog.ts";
import type { AgentState, ArenaTask, BiddingPolicy, CostModel, Ledger, Market, MarketAllocation, OddsPolicy, Outcome, SettlementPolicy } from "./types.ts";

export interface MarketDeps {
  ledger: Ledger;
  catalog: CatalogService;
  bidding: BiddingPolicy;
  odds: OddsPolicy;
  settlement: SettlementPolicy;
  costModel: CostModel;
  cfg: LabConfig;
}

export class MarketV1 implements Market {
  private deps: MarketDeps;
  constructor(deps: MarketDeps) { this.deps = deps; }

  async allocate(t: ArenaTask): Promise<MarketAllocation | undefined> {
    const { ledger, catalog, bidding, odds, cfg } = this.deps;
    const candidates = catalog.candidates();
    if (candidates.length === 0) return undefined;
    const round = ledger.nextRound();
    const task: ArenaTask = { ...t, odds: odds.odds(t) };
    const states: AgentState[] = candidates.map((m) => {
      ledger.ensureEndowed(m.id, m);
      return { agent: m.id, model: m, balance: ledger.balance(m.id) };
    });
    let bids;
    try {
      bids = await bidding.solicitBids(task, states);
    } catch {
      return undefined; // fail-open -> classic
    }
    const byAgent = new Map(states.map((s) => [s.agent, s]));
    const bidMap = new Map(bids.map((b) => [b.agent, b.stake]));
    // opt-out tax: 出价 0（弃接）者扣任务税
    if (cfg.arena.settlement.tax > 0) {
      for (const s of states) {
        if ((bidMap.get(s.agent) ?? 0) <= 0) ledger.debit(s.agent, cfg.arena.settlement.tax, "opt-out-tax", task.id, round);
      }
    }
    const eligible = bids
      .map((b) => {
        const st = byAgent.get(b.agent);
        if (!st) return undefined;
        const stake = Math.min(Math.max(0, b.stake), st.balance);
        return stake > 0 ? { agent: b.agent, stake, balance: st.balance } : undefined;
      })
      .filter((x): x is { agent: string; stake: number; balance: number } => !!x);
    if (eligible.length === 0) return undefined;
    eligible.sort((a, z) => (z.stake - a.stake) || (z.balance - a.balance) || (a.agent < z.agent ? -1 : 1));
    const winner = eligible[0];
    ledger.freeze(winner.agent, winner.stake, task.id);
    ledger.createTask(task, winner.agent, winner.stake, round);
    return { winner: winner.agent, model: winner.agent, stake: winner.stake, taskId: task.id, round };
  }

  settle(taskId: string, o: Outcome): void {
    const { ledger, catalog, settlement, costModel } = this.deps;
    const row = ledger.getTask(taskId);
    if (!row || row.status !== "pending") return;
    const model = catalog.candidates().find((m) => m.id === row.winner);
    const arenaTask: ArenaTask = { id: row.taskId, role: row.role, prompt: row.prompt, difficulty: row.difficulty as ArenaTask["difficulty"], odds: row.odds, reward: row.reward };
    const D = settlement.settle(arenaTask, row.stake, o);
    const U = model ? costModel.usageCost(o, model) : 0;
    ledger.unfreeze(row.winner, taskId);
    const net = D - U;
    if (net >= 0) ledger.credit(row.winner, net, "settle", taskId, row.round);
    else ledger.debit(row.winner, -net, "settle", taskId, row.round);
    ledger.setTaskStatus(taskId, "settled");
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/arena-market.test.ts`
Expected: PASS（4 个）

- [ ] **Step 5: Commit**

```bash
git add src/arena/market.ts test/arena-market.test.ts
git commit -m "feat(arena): MarketV1 orchestrator (allocate bids / settle) + fail-open"
```

---

## Task 5: BiddingPolicy v1（逐个问模型押注）

**Files:**
- Create: `src/arena/bidding.ts`
- Test: `test/arena-bidding.test.ts`

**Interfaces:**
- Consumes: `ArenaConfig`, arena 类型, `renderBidPrompt`, `parseBidResponse`
- Produces: `interface ModelCaller { complete(model, prompt, timeoutMs): Promise<string> }`，`class BiddingPolicyV1 implements BiddingPolicy { constructor(cfg, caller) }`。

- [ ] **Step 1: 写失败测试 test/arena-bidding.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BiddingPolicyV1, type ModelCaller } from "../src/arena/bidding.ts";
import { DEFAULT_ARENA_CONFIG } from "../src/config.ts";
import type { ModelInfo } from "../src/types.ts";
import type { AgentState, ArenaTask } from "../src/arena/types.ts";

const cfg = DEFAULT_ARENA_CONFIG;
function model(id: string): ModelInfo { return { id, provider: id.split("/")[0], name: id, accessRoute: "direct" }; }
const task: ArenaTask = { id: "t", role: "r", prompt: "p", difficulty: "medium", odds: 3.0, reward: 10 };

test("BiddingPolicyV1 queries each candidate and parses stakes", async () => {
  const caller: ModelCaller = { complete: async (m) => (m === "m/a" ? "150" : "garbage") };
  const bp = new BiddingPolicyV1(cfg, caller);
  const bids = await bp.solicitBids(task, [
    { agent: "m/a", model: model("m/a"), balance: 1000 },
    { agent: "m/b", model: model("m/b"), balance: 1000 },
  ]);
  assert.equal(bids.find((b) => b.agent === "m/a")!.stake, 150);
  assert.equal(bids.find((b) => b.agent === "m/b")!.stake, 0);
});

test("BiddingPolicyV1 caller error -> stake 0 (fail-open)", async () => {
  const caller: ModelCaller = { complete: async () => { throw new Error("net"); } };
  const bp = new BiddingPolicyV1(cfg, caller);
  const bids = await bp.solicitBids(task, [{ agent: "m/a", model: model("m/a"), balance: 1000 }]);
  assert.equal(bids[0].stake, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/arena-bidding.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 src/arena/bidding.ts**

```ts
import type { ArenaConfig } from "../types.ts";
import type { AgentState, ArenaTask, Bid, BiddingPolicy } from "./types.ts";
import { renderBidPrompt, parseBidResponse } from "./policies.ts";

export interface ModelCaller {
  complete(model: string, prompt: string, timeoutMs: number): Promise<string>;
}

export class BiddingPolicyV1 implements BiddingPolicy {
  constructor(private cfg: ArenaConfig, private caller: ModelCaller) {}
  async solicitBids(t: ArenaTask, candidates: AgentState[]): Promise<Bid[]> {
    const out: Bid[] = [];
    for (const c of candidates) {
      const available = c.balance;
      const prompt = renderBidPrompt(this.cfg.bidding.promptTemplate, {
        prompt: t.prompt, role: t.role, difficulty: String(t.difficulty), odds: t.odds, balance: available,
      });
      try {
        const reply = await this.caller.complete(c.model.id, prompt, this.cfg.bidding.timeoutMs);
        out.push({ agent: c.agent, stake: parseBidResponse(reply, available) });
      } catch {
        out.push({ agent: c.agent, stake: 0 });
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/arena-bidding.test.ts`
Expected: PASS（2 个）

- [ ] **Step 5: Commit**

```bash
git add src/arena/bidding.ts test/arena-bidding.test.ts
git commit -m "feat(arena): BiddingPolicyV1 (per-candidate model bid) + ModelCaller interface"
```

---

## Task 6: mode 感知钩子（interceptor + telemetry）

**Files:**
- Modify: `src/interceptor/register.ts`（market→Market.allocate，失败降级 classic）
- Modify: `src/telemetry/register.ts`（有 market_task 则 Market.settle）

**Interfaces:**
- Consumes: `Market`, `ArenaTask`, `Outcome`, `recommend`, `decideIntercept`, `modelAllowed`, `parseSubagentRun`
- Produces: `registerInterceptor(pi, store, catalog, cfg, market?)`、`registerTelemetry(pi, store, cfg, market?)`。

- [ ] **Step 1: 替换 src/interceptor/register.ts 全文**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import type { CatalogService } from "../catalog/catalog.ts";
import type { ArenaTask, Market } from "../arena/types.ts";
import { recommend } from "../scorer/scorer.ts";
import { decideIntercept, modelAllowed } from "./logic.ts";
import { loadModelScopeAllow } from "./model-scope.ts";

export function registerInterceptor(pi: ExtensionAPI, store: Store, catalog: CatalogService, cfg: LabConfig, market?: Market): void {
  const allowGlobs = loadModelScopeAllow();
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    try {
      const input = event.input as Record<string, unknown>;
      const role = typeof input.agent === "string" ? input.agent : undefined;
      if (!role) return;

      // Market 模式：竞价分配（失败则降级到下方 classic）
      if (cfg.mode === "market" && market) {
        const task: ArenaTask = {
          id: String((event as { toolCallId?: unknown }).toolCallId ?? `${role}-${Date.now()}`),
          role,
          prompt: typeof input.task === "string" ? input.task : "",
          difficulty: "medium",
          odds: 0,
          reward: 0,
        };
        const alloc = await market.allocate(task).catch(() => undefined);
        if (alloc && modelAllowed(alloc.model, allowGlobs)) {
          input.model = alloc.model;
          ctx.ui.setStatus("agent-lab", `Market: ${role} → ${alloc.model} (stake ${alloc.stake}, round ${alloc.round})`);
          return;
        }
        // alloc 失败 -> 落入 classic 兜底
      }

      // Classic 模式（M2）/ market 兜底
      const aggs = new Map(store.aggregateByRole(role).map((a) => [a.model, a]));
      const recs = recommend(catalog.candidates(), aggs, cfg, cfg.topN);
      const decision = decideIntercept({ role, pinnedModel: store.getPin(role), autoApply: cfg.autoApply, recommendation: recs[0], alternatives: recs.slice(1) });
      if (decision.action === "apply") {
        if (modelAllowed(decision.model, allowGlobs)) {
          input.model = decision.model;
          ctx.ui.setStatus("agent-lab", `${role} → ${decision.model} (pinned)`);
        }
      } else if (decision.action === "prompt") {
        const items = [decision.recommendation, ...decision.alternatives].map((s) => `${s.model.id} — ${s.reason} (score ${s.score.toFixed(3)})`);
        const KEEP = "（保持原模型）";
        items.push(KEEP);
        const chosen = await ctx.ui.select(`Agent Lab: 为角色 ${role} 选择模型`, items);
        if (chosen && chosen !== KEEP) {
          const model = chosen.split(" — ")[0];
          if (modelAllowed(model, allowGlobs)) input.model = model;
          const remember = await ctx.ui.confirm("Agent Lab", `记住 ${role} → ${model}？`);
          if (remember) store.setPin(role, model);
        }
      }
    } catch (err) {
      console.error("[agent-lab] interceptor failed (fail-open):", err);
    }
  });
}
```

- [ ] **Step 2: 替换 src/telemetry/register.ts 全文**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import type { Market, Outcome } from "../arena/types.ts";
import { parseSubagentRun } from "./parse.ts";

export function registerTelemetry(pi: ExtensionAPI, store: Store, cfg: LabConfig, market?: Market): void {
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "subagent") return;
    try {
      const raw = event.result as { details?: unknown } | undefined;
      const result = (raw?.details ?? event.result) as Record<string, unknown>;
      const rec = parseSubagentRun({ input: (event.args ?? {}) as Record<string, unknown>, result }, cfg);
      if (rec) store.appendRun(rec);
      if (market) {
        const taskId = String((event as { toolCallId?: unknown }).toolCallId ?? "");
        if (taskId) {
          const outcome: Outcome = {
            completion: rec?.completion ?? 0,
            majorError: Boolean((event as { isError?: unknown }).isError) || rec?.acceptance === "none",
            tokensIn: rec?.tokensIn ?? 0,
            tokensOut: rec?.tokensOut ?? 0,
            cost: rec?.cost ?? 0,
            toolCalls: [],          // v1: 工具明细待提取（spec §11.3）
            inferenceLatencyMs: 0,  // v1: 推理延迟待提取
          };
          market.settle(taskId, outcome); // 内部仅结算存在的 pending 任务
        }
      }
    } catch (err) {
      console.error("[agent-lab] telemetry failed:", err);
    }
  });
}
```

- [ ] **Step 3: 加载冒烟**

Run:
```bash
node --experimental-strip-types -e "Promise.all([import('./src/interceptor/register.ts'),import('./src/telemetry/register.ts')]).then(()=>console.log('hooks load')).catch(e=>{console.error(e);process.exit(1);})"
```
Expected: 打印 `hooks load`（pi import 为 type-only，被擦除）。

- [ ] **Step 4: 跑现有相关测试确保未回归**

Run: `node --experimental-strip-types --test test/*.test.ts`
Expected: 全部通过（至此 32 + 2 + 6 + 6 + 4 + 2 = 52）。

- [ ] **Step 5: Commit**

```bash
git add src/interceptor/register.ts src/telemetry/register.ts
git commit -m "feat(arena): mode-aware hooks (market allocate + settle, classic fallback)"
```

---

## Task 7: arena 命令 + /lab mode + config 路由

**Files:**
- Create: `src/arena/register.ts`（命令辅助 + applyArenaConfig）
- Modify: `src/commands/register.ts`（`/lab mode`、`/lab arena …`、applyConfig 支持 mode+arena 键；Deps 增 ledger/market/saveConfig）

**Interfaces:**
- Consumes: `Ledger`, `Market`, `LabConfig`
- Produces: `applyArenaConfig(cfg, key, val): boolean`、`renderLeaderboard(ledger)`、`renderHistory(ledger, agent?, limit?)`；`registerCommands` 新签名 `registerCommands(pi, { store, catalog, cfg, ledger, market, saveConfig })`。

- [ ] **Step 1: 创建 src/arena/register.ts**

```ts
import type { LabConfig } from "../types.ts";
import type { Ledger } from "./types.ts";

export function applyArenaConfig(cfg: LabConfig, key: string, val: string): boolean {
  const a = cfg.arena;
  const num = Number(val);
  switch (key) {
    case "endowment.K": a.endowment.K = num; return true;
    case "endowment.floor": a.endowment.floor = num; return true;
    case "odds.easy": a.odds.easy = num; return true;
    case "odds.medium": a.odds.medium = num; return true;
    case "odds.hard": a.odds.hard = num; return true;
    case "settlement.tax": a.settlement.tax = num; return true;
    case "settlement.errorMode":
      if (val !== "stakeOnly" && val !== "stakeTimesOdds") return false;
      a.settlement.errorMode = val; return true;
    case "cost.tokenMult": a.cost.tokenMult = num; return true;
    case "cost.toolMult": a.cost.toolMult = num; return true;
    case "cost.latencyMult": a.cost.latencyMult = num; return true;
    case "cost.resourceFactor": a.cost.resourceFactor = num; return true;
    case "bidding.timeoutMs": a.bidding.timeoutMs = num; return true;
    case "market.staleTaskTimeoutMs": a.market.staleTaskTimeoutMs = num; return true;
    case "market.eligibility": a.market.eligibility = val; return true;
    default: return false;
  }
}

export function renderLeaderboard(ledger: Ledger): string {
  const lb = ledger.leaderboard();
  if (lb.length === 0) return "暂无 agent credits。";
  return "Agent credits 排行:\n" + lb.map((r, i) => `${i + 1}. ${r.agent}  ${r.balance.toFixed(2)}`).join("\n");
}

export function renderHistory(ledger: Ledger, agent?: string, limit = 20): string {
  const h = ledger.history(agent, limit);
  if (h.length === 0) return "暂无流水。";
  return h.map((tx) => `[r${tx.round ?? "-"} t${tx.agentTurn ?? "-"}] ${tx.agent} ${tx.delta >= 0 ? "+" : ""}${tx.delta.toFixed(2)} (${tx.reason ?? ""})`).join("\n");
}
```

- [ ] **Step 2: 改 src/commands/register.ts**

(a) 顶部 import 增补：
```ts
import type { Ledger, Market } from "../arena/types.ts";
import { applyArenaConfig, renderLeaderboard, renderHistory } from "../arena/register.ts";
```
(b) `Deps` 接口改为：
```ts
interface Deps { store: Store; catalog: CatalogService; cfg: LabConfig; ledger: Ledger; market: Market; saveConfig: (cfg: LabConfig) => void; }
```
（并在解构处 `const { store, catalog, cfg, ledger, market, saveConfig } = deps;`）
(c) `applyConfig` 函数开头加 mode 与 arena 路由（在现有 weights 分支之前/之后均可）：
```ts
  function applyConfig(key: string, val: string): boolean {
    if (key === "mode") {
      if (val !== "classic" && val !== "market") return false;
      cfg.mode = val as LabConfig["mode"]; return true;
    }
    if (applyArenaConfig(cfg, key, val)) return true;
    if (key.startsWith("weights.")) {
      const k = key.slice("weights.".length) as keyof LabConfig["weights"];
      if (k in cfg.weights) { cfg.weights[k] = Number(val); return true; }
      return false;
    } else if (key === "autoApply") { cfg.autoApply = val === "true"; return true; }
    else if (key === "topN") { cfg.topN = Number(val); return true; }
    else if (key === "interruptedPenalty") { cfg.interruptedPenalty = Number(val); return true; }
    else if (key === "toolFailPenalty") { cfg.toolFailPenalty = Number(val); return true; }
    else if (key === "catalogTtlMs") { cfg.catalogTtlMs = Number(val); return true; }
    return false;
  }
```
(d) 在 `/lab` 命令 handler 的 `if/else if` 链中（`doctor` 分支之前）插入 `mode` 与 `arena` 子命令：
```ts
      } else if (cmd === "mode") {
        if (argv[1]) {
          if (argv[1] !== "classic" && argv[1] !== "market") ctx.ui.notify("mode 须为 classic 或 market", "error");
          else { cfg.mode = argv[1] as LabConfig["mode"]; saveConfig(cfg); ctx.ui.notify(`已切换 mode = ${argv[1]}`, "info"); }
        } else ctx.ui.notify(`当前 mode = ${cfg.mode}`, "info");
      } else if (cmd === "arena") {
        const sub = argv[1];
        if (sub === "credits" || sub === "leaderboard") ctx.ui.notify(renderLeaderboard(ledger), "info");
        else if (sub === "history") {
          const limitIdx = argv.indexOf("--limit");
          const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) || 20 : 20;
          const agent = argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined;
          ctx.ui.notify(renderHistory(ledger, agent, limit), "info");
        } else if (sub === "task") {
          const t = argv[2] ? ledger.getTask(argv[2]) : undefined;
          ctx.ui.notify(t ? JSON.stringify(t, null, 2) : "未找到任务", "info");
        } else if (sub === "doctor") {
          ctx.ui.notify(`Arena: mode=${cfg.mode} round=${ledger.currentRound()} agents=${ledger.leaderboard().length}`, "info");
        } else if (sub === "post") {
          ctx.ui.notify("Market 模式会自动把 subagent 派发转为市场任务：先 /lab mode market，再正常派发 subagent。（显式 post 自动派发见 spec §11.2，后续完善）", "info");
        } else {
          ctx.ui.notify("用法: /lab arena <credits|history|task|doctor|post> ...", "info");
        }
      } else if (cmd === "doctor") {
```

- [ ] **Step 3: 加载冒烟（typebox 离线失败属预期）**

Run:
```bash
node --experimental-strip-types -e "Promise.all([import('./src/arena/register.ts')]).then(()=>console.log('arena register loads')).catch(e=>console.error(e.message))"
node --experimental-strip-types -e "import('./src/commands/register.ts').then(()=>console.log('commands loads')).catch(e=>console.error('EXPECTED typebox:', e.message))"
```
Expected: `arena register loads`；commands 仅因 typebox 离线失败（非语法/本地模块错误）。

- [ ] **Step 4: Commit**

```bash
git add src/arena/register.ts src/commands/register.ts
git commit -m "feat(arena): /lab mode + /lab arena commands + arena config routing"
```

---

## Task 8: index.ts 装配 + 全量测试 + 端到端冒烟

**Files:**
- Modify: `index.ts`（装配 Ledger/Market，传入钩子与命令；ModelCaller）

**Interfaces:**
- Consumes: 全部 arena 模块 + `saveConfig`
- Produces: 扩展入口在 market 模式下启用经济闭环。

- [ ] **Step 1: 替换 index.ts 全文**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SqliteStore } from "./src/store/store.ts";
import { CatalogService } from "./src/catalog/catalog.ts";
import { loadConfig, ensureDataDir, dbPath, saveConfig } from "./src/config-io.ts";
import { registerTelemetry } from "./src/telemetry/register.ts";
import { registerInterceptor } from "./src/interceptor/register.ts";
import { registerCommands } from "./src/commands/register.ts";
import { SqliteLedger } from "./src/arena/ledger.ts";
import { MarketV1 } from "./src/arena/market.ts";
import { EndowmentPolicyV1, OddsPolicyV1, SettlementPolicyV1, CostModelV1 } from "./src/arena/policies.ts";
import { BiddingPolicyV1, type ModelCaller } from "./src/arena/bidding.ts";

const DIRECT_PREFIXES = ["deepseek", "moonshotai", "z-ai", "qwen"];

// v1: best-effort 原始模型调用（pi-ai）。运行时核对/适配签名（spec §11.1）；失败时 BiddingPolicy 回退 stake 0（fail-open）。
function makeModelCaller(_pi: ExtensionAPI): ModelCaller {
  return {
    async complete(model: string, prompt: string, timeoutMs: number): Promise<string> {
      const mod = await import("@earendil-works/pi-ai") as Record<string, unknown>;
      const fn = (mod.complete ?? mod.simpleComplete ?? mod.default) as ((arg: unknown) => Promise<unknown>) | undefined;
      if (typeof fn !== "function") throw new Error("pi-ai complete unavailable");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fn({ model, messages: [{ role: "user", content: prompt }], signal: ctrl.signal });
        if (typeof res === "string") return res;
        const r = res as { text?: string; content?: string };
        return r.text ?? r.content ?? String(res);
      } finally { clearTimeout(timer); }
    },
  };
}

export default async function (pi: ExtensionAPI) {
  ensureDataDir();
  const cfg = loadConfig();
  const store = new SqliteStore(dbPath());
  const catalog = new CatalogService({ directPrefixes: DIRECT_PREFIXES, ttlMs: cfg.catalogTtlMs });
  await catalog.refresh().catch((e: Error) => console.error("[agent-lab] initial catalog refresh failed:", e?.message ?? e));

  const endowment = new EndowmentPolicyV1(cfg.arena);
  const ledger = new SqliteLedger(store.raw, endowment);
  const market = new MarketV1({
    ledger, catalog,
    bidding: new BiddingPolicyV1(cfg.arena, makeModelCaller(pi)),
    odds: new OddsPolicyV1(cfg.arena),
    settlement: new SettlementPolicyV1(cfg.arena),
    costModel: new CostModelV1(cfg.arena),
    cfg,
  });

  registerTelemetry(pi, store, cfg, market);
  registerInterceptor(pi, store, catalog, cfg, market);
  registerCommands(pi, { store, catalog, cfg, ledger, market, saveConfig });

  pi.on("session_shutdown", async () => { try { store.close(); } catch { /* ignore */ } });
}
```

- [ ] **Step 2: 运行全量单元测试**

Run: `node --experimental-strip-types --test test/*.test.ts`
Expected: 全部通过（约 52 个：Core 32 + config 2 + ledger 6 + policies 6 + market 4 + bidding 2）。

- [ ] **Step 3: 扩展加载冒烟（pi -e，验证 jiti 下 typebox/pi-ai 可解析、factory 无异常）**

Run: `timeout 60 pi -e ~/.pi/agent/extensions/agent-lab/index.ts --list-models 2>&1 | grep -iE "agent-lab|error|cannot|exception" | head`
Expected: 无 agent-lab 相关报错；`~/.pi/agent/agent-lab/agent-lab.db` 生成（含 arena 表）。

- [ ] **Step 4: 端到端冒烟（在 pi TUI 内手动；由控制器/用户执行）**

1. `/reload` 加载扩展。
2. `/lab mode market` → 切到 Market 模式。
3. `/lab arena doctor` → 显示 mode=market、round、agents。
4. 派发一个真实 subagent（如 `subagent({ agent: "scout", task: "列出当前目录文件" })`）→ 观察征 bid（逐个问候选模型押注）→ 中标模型派发 → 状态栏显示 `Market: scout → <model> (stake …, round …)`。
5. `/lab arena credits` → 排行榜显示中标 agent 的 credits 变化（结算后）。
6. `/lab arena history` → 流水含 round/agent_turn。
7. `/lab mode classic` → 切回 Classic（恢复 M2 行为）。
（若 bid 模型调用因 pi-ai 签名不符失败，会 fail-open 降级 classic——核对 §11.1 后适配 makeModelCaller。）

- [ ] **Step 5: Commit**

```bash
git add index.ts
git commit -m "feat(arena): wire Market economy into extension entry (Core+M1+M2 + Arena-1 complete)"
```

---

## Self-Review（计划自检结论）

- **Spec 覆盖**：S1 账本+初始发放(Task 2/3)、S2 发布+出价接取(Task 4/5/6)、S3 结算(Task 3/4/6)、S7 最小编排(Task 6/7/8)、轮次 round/agent_turn(Task 2)、mode 切换(Task 1/6/7)、策略接口优先(Task 1/3)、CostModel 三类成本(Task 3)、fail-open 降级(Task 4/6)、命令 /lab mode + /lab arena(Task 7)。Arena-2..9 明确不在本计划。
- **占位符**：无 TBD/TODO；每个代码步骤含完整代码与确切命令/预期。`/lab arena post` 的"自动派发"按 spec §11.2 显式 defer（给出引导提示，非空实现）。
- **类型一致性**：`Ledger`/`Market`/`MarketAllocation`/`ArenaTask`/`Outcome`/`Bid`/策略接口在各任务签名一致；`registerInterceptor(pi,store,catalog,cfg,market?)`、`registerTelemetry(pi,store,cfg,market?)`、`registerCommands(pi,{store,catalog,cfg,ledger,market,saveConfig})` 在 Task 6/7/8 一致。
- **已知实现期验证点**（spec §11）：pi-ai 原始调用签名（Task 8 makeModelCaller，fail-open 兜底）；命令内派发 subagent（post，defer）；toolCalls/推理延迟提取（v1 置 0）；majorError 判定（isError || acceptance==="none"）。
