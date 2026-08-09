# Agent Lab — Core + 遥测(M1) + 选择优化器(M2, MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 pi 扩展 `agent-lab`：枚举 {OpenRouter 免费模型 + 直连厂商模型}，自动记录每次 subagent 运行的完成度/成本/性能信号，并基于加权融合在派发前推荐+应用最优模型。

**Architecture:** 模块化目录扩展。纯逻辑模块（store/scorer/completion/catalog-parse/telemetry-parse/interceptor-logic）不依赖 pi、可单测；pi 胶水层（index/telemetry-register/interceptor-register/commands）薄封装，通过事件钩子接入。SQLite（`node:sqlite` DatabaseSync）持久化运行遥测、角色 pin、配置。

**Tech Stack:** TypeScript（pi 经 jiti 加载，免编译；测试经 `node --experimental-strip-types`）；`node:sqlite`（DatabaseSync，Node≥22.5，已验证 v24.14.1 无需 flag）；`node:test` + `node:assert/strict`；pi 扩展 API（`@earendil-works/pi-coding-agent`）与 `typebox`（仅胶水层 import）。

## Global Constraints

- **Node 版本**：≥ 22.5（实测 v24.14.1）。`node:sqlite` 无需 flag（仅 ExperimentalWarning，可忽略）。
- **相对导入一律带 `.ts` 扩展名**（兼容 node strip-types 与 jiti）。
- **纯逻辑模块禁止 import pi 内部**（`@earendil-works/pi-coding-agent` / `typebox` 只允许出现在 `index.ts` 与 `src/*/register.ts`、`src/commands/register.ts`），保证其可用 `node --test` 独立运行。
- **fail-open**：拦截器/遥测内任何异常都不得阻断 subagent 派发或拖垮宿主，必须 try/catch 后放行。
- **隐私**：遥测只存元数据，默认不存 prompt 正文/任务内容。
- **定价口径**：OpenRouter `pricing.prompt/completion` 是“每 token 美元”，转“每百万”需 `× 1e6`；免费模型二者皆为 `"0"`。
- **测试命令**：`node --experimental-strip-types --test test/*.test.ts`（在 `~/.pi/agent/extensions/agent-lab/` 下运行）。
- **提交**：每个任务结尾单独 commit（仓库已 `git init`，local 身份 `Agent Lab <agent-lab@localhost>`）。
- **直连厂商 → OpenRouter provider 前缀映射**：`deepseek→deepseek`、`kimi/kimi-coding→moonshotai`、`zai→z-ai`、`qwen-token-plan-cn→qwen`。即 `DIRECT_PREFIXES = ["deepseek","moonshotai","z-ai","qwen"]`。

---

## File Structure

```
~/.pi/agent/extensions/agent-lab/
├── package.json                  # pi 清单 + test 脚本（无运行时依赖）
├── index.ts                      # 扩展入口：装配 store/catalog/钩子/命令
├── src/
│   ├── types.ts                  # 全部共享类型
│   ├── config.ts                 # DEFAULT_CONFIG + mergeConfig（纯）
│   ├── config-io.ts              # 数据目录/DB/配置路径 + load/save（fs）
│   ├── store/
│   │   ├── schema.ts             # SQL DDL
│   │   └── store.ts              # Store 接口 + SqliteStore（node:sqlite）
│   ├── catalog/
│   │   ├── parse.ts              # 纯：OR JSON → ModelInfo[]，过滤免费/直连
│   │   ├── sources.ts            # URL + fetchJson（超时/可注入 fetch）
│   │   └── catalog.ts            # CatalogService：refresh + candidates + TTL
│   ├── scorer/
│   │   ├── completion.ts         # 纯：完成度派生
│   │   └── scorer.ts             # 纯：打分 + recommend
│   ├── telemetry/
│   │   ├── parse.ts              # 纯：subagent 结果 → RunRecord
│   │   └── register.ts           # pi 钩子（tool_execution_end）
│   ├── interceptor/
│   │   ├── logic.ts              # 纯：派发决策 + modelAllowed/glob
│   │   ├── model-scope.ts        # 读 settings 的 modelScope.allow
│   │   └── register.ts           # pi 钩子（tool_call）
│   └── commands/
│       └── register.ts           # /lab 命令 + agent_lab 工具
├── test/
│   ├── config.test.ts
│   ├── store.test.ts
│   ├── completion.test.ts
│   ├── catalog-parse.test.ts
│   ├── catalog.test.ts
│   ├── scorer.test.ts
│   ├── telemetry-parse.test.ts
│   └── interceptor-logic.test.ts
└── docs/{specs,plans}/
```

---

## Task 1: 项目脚手架 + 类型 + 配置

**Files:**
- Create: `package.json`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `DEFAULT_CONFIG: LabConfig`、`mergeConfig(partial?: Partial<LabConfig>): LabConfig`；类型 `ModelInfo / RunRecord / Aggregate / Weights / LabConfig / ScoredModel / AccessRoute`。后续所有任务依赖这些名字。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "agent-lab",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Agent Lab: telemetry-driven model selection for pi (Core + M1 + M2 MVP)",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "node --experimental-strip-types --test test/*.test.ts" },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "typebox": { "optional": true }
  }
}
```

- [ ] **Step 2: 写 src/types.ts**

```ts
export type AccessRoute = "free" | "direct" | "both";

export interface ModelPricing { in: number; out: number; }
export interface ModelPerf { throughputP50?: number; latencyP50?: number; uptime7d?: number; }

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  contextWindow?: number;
  pricing?: ModelPricing;
  perf?: ModelPerf;
  benchmarks?: Record<string, number>;
  modalities?: string[];
  accessRoute: AccessRoute;
}

export interface RunRecord {
  ts: number;
  role: string;
  model: string;
  taskCategory?: string;
  acceptance?: string;
  completion: number;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  toolSuccess?: number;
  turns?: number;
  interrupted?: number;
  signals?: Record<string, unknown>;
  source: "auto" | "manual";
}

export interface Aggregate {
  model: string;
  role: string;
  runs: number;
  avgCompletion: number;
  avgCost: number;
  successRate: number;
}

export interface Weights { completion: number; costEffectiveness: number; performance: number; benchmark: number; }

export interface LabConfig {
  weights: Weights;
  autoApply: boolean;
  acceptanceScoreMap: Record<string, number>;
  interruptedPenalty: number;
  toolFailPenalty: number;
  topN: number;
  catalogTtlMs: number;
}

export interface ScoreBreakdown { completion: number; costEffectiveness: number; performance: number; benchmark: number; }

export interface ScoredModel {
  model: ModelInfo;
  score: number;
  breakdown: ScoreBreakdown;
  reason: string;
  coldStart: boolean;
}
```

- [ ] **Step 3: 写 src/config.ts**

```ts
import type { LabConfig } from "./types.ts";

export const DEFAULT_CONFIG: LabConfig = {
  weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
  autoApply: true,
  acceptanceScoreMap: { reviewed: 1.0, verified: 0.9, checked: 0.7, attested: 0.5, auto: 0.4, none: 0.2 },
  interruptedPenalty: 0.3,
  toolFailPenalty: 0.2,
  topN: 3,
  catalogTtlMs: 21_600_000,
};

export function mergeConfig(partial: Partial<LabConfig> | undefined): LabConfig {
  if (!partial) {
    return { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights }, acceptanceScoreMap: { ...DEFAULT_CONFIG.acceptanceScoreMap } };
  }
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    weights: { ...DEFAULT_CONFIG.weights, ...(partial.weights ?? {}) },
    acceptanceScoreMap: { ...DEFAULT_CONFIG.acceptanceScoreMap, ...(partial.acceptanceScoreMap ?? {}) },
  };
}
```

- [ ] **Step 4: 写失败测试 test/config.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";

test("mergeConfig returns defaults when no partial", () => {
  const cfg = mergeConfig(undefined);
  assert.equal(cfg.weights.completion, 0.5);
  assert.equal(cfg.autoApply, true);
  assert.equal(cfg.topN, 3);
});

test("mergeConfig deep-merges weights and keeps others", () => {
  const cfg = mergeConfig({ weights: { completion: 0.8 } as LabConfig["weights"], topN: 5 });
  assert.equal(cfg.weights.completion, 0.8);
  assert.equal(cfg.weights.costEffectiveness, 0.25);
  assert.equal(cfg.topN, 5);
});

test("default weights sum to 1", () => {
  const w = DEFAULT_CONFIG.weights;
  assert.ok(Math.abs(w.completion + w.costEffectiveness + w.performance + w.benchmark - 1) < 1e-9);
});
```
（在文件顶部 `import type { LabConfig } from "../src/types.ts";` 以使用 `LabConfig["weights"]` 类型。）

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/config.test.ts`
Expected: PASS（3 个测试通过）

- [ ] **Step 6: Commit**

```bash
git add package.json src/types.ts src/config.ts test/config.test.ts
git commit -m "feat(agent-lab): scaffold + types + config defaults"
```

---

## Task 2: 存储层（SQLite）

**Files:**
- Create: `src/store/schema.ts`
- Create: `src/store/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `RunRecord`, `Aggregate`（来自 types.ts）
- Produces: `interface Store { appendRun(r): void; aggregateByRole(role): Aggregate[]; listRoles(): string[]; getPin(role): string|undefined; setPin(role, model): void; clearPin(role): void; getConfig(): Record<string,string>; setConfig(key, value): void; close(): void }`；`class SqliteStore implements Store { constructor(path: string) }`（`path` 可为 `":memory:"`）。

- [ ] **Step 1: 写 src/store/schema.ts**

```ts
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  task_category TEXT,
  acceptance TEXT,
  completion REAL NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  tool_success REAL,
  turns INTEGER,
  interrupted INTEGER,
  signals TEXT,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_role_model ON runs(role, model);
CREATE TABLE IF NOT EXISTS role_pin (
  role TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
```

- [ ] **Step 2: 写失败测试 test/store.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/store/store.ts";
import type { RunRecord } from "../src/types.ts";

function mkStore() { return new SqliteStore(":memory:"); }
function run(p: Partial<RunRecord>): RunRecord {
  return { ts: Date.now(), role: "reviewer", model: "deepseek/deepseek-v3.2", completion: 0.7, source: "auto", ...p };
}

test("appendRun + aggregateByRole computes avg completion/cost/success", () => {
  const s = mkStore();
  s.appendRun(run({ model: "m1", completion: 1.0, cost: 0.10, toolSuccess: 1 }));
  s.appendRun(run({ model: "m1", completion: 0.5, cost: 0.30, toolSuccess: 1 }));
  s.appendRun(run({ model: "m2", completion: 0.8, cost: 0.00, toolSuccess: 0.5 }));
  const aggs = s.aggregateByRole("reviewer");
  const m1 = aggs.find((a) => a.model === "m1")!;
  assert.equal(m1.runs, 2);
  assert.ok(Math.abs(m1.avgCompletion - 0.75) < 1e-9);
  assert.ok(Math.abs(m1.avgCost - 0.20) < 1e-9);
  const m2 = aggs.find((a) => a.model === "m2")!;
  assert.ok(Math.abs(m2.successRate - 0.5) < 1e-9);
  s.close();
});

test("pin get/set/overwrite/clear", () => {
  const s = mkStore();
  assert.equal(s.getPin("worker"), undefined);
  s.setPin("worker", "qwen/qwen3.7-max");
  assert.equal(s.getPin("worker"), "qwen/qwen3.7-max");
  s.setPin("worker", "deepseek/deepseek-v4-pro");
  assert.equal(s.getPin("worker"), "deepseek/deepseek-v4-pro");
  s.clearPin("worker");
  assert.equal(s.getPin("worker"), undefined);
  s.close();
});

test("config get/set roundtrip", () => {
  const s = mkStore();
  s.setConfig("weights.completion", "0.8");
  assert.equal(s.getConfig()["weights.completion"], "0.8");
  s.close();
});

test("listRoles distinct + sorted", () => {
  const s = mkStore();
  s.appendRun(run({ role: "reviewer" }));
  s.appendRun(run({ role: "worker" }));
  s.appendRun(run({ role: "reviewer" }));
  assert.deepEqual(s.listRoles(), ["reviewer", "worker"]);
  s.close();
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/store.test.ts`
Expected: FAIL（`Cannot find module '../src/store/store.ts'`）

- [ ] **Step 4: 写 src/store/store.ts**

```ts
import { DatabaseSync } from "node:sqlite";
import type { Aggregate, RunRecord } from "../types.ts";
import { SCHEMA } from "./schema.ts";

export interface Store {
  appendRun(r: RunRecord): void;
  aggregateByRole(role: string): Aggregate[];
  listRoles(): string[];
  getPin(role: string): string | undefined;
  setPin(role: string, model: string): void;
  clearPin(role: string): void;
  getConfig(): Record<string, string>;
  setConfig(key: string, value: string): void;
  close(): void;
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }
  appendRun(r: RunRecord): void {
    this.db.prepare(
      `INSERT INTO runs (ts, role, model, task_category, acceptance, completion, tokens_in, tokens_out, cost, tool_success, turns, interrupted, signals, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      r.ts, r.role, r.model, r.taskCategory ?? null, r.acceptance ?? null, r.completion,
      r.tokensIn ?? null, r.tokensOut ?? null, r.cost ?? null, r.toolSuccess ?? null,
      r.turns ?? null, r.interrupted ?? null, JSON.stringify(r.signals ?? {}), r.source
    );
  }
  aggregateByRole(role: string): Aggregate[] {
    const rows = this.db.prepare(
      `SELECT model, role, COUNT(*) AS runs, AVG(completion) AS avgCompletion,
              AVG(COALESCE(cost, 0)) AS avgCost, AVG(COALESCE(tool_success, 1)) AS successRate
       FROM runs WHERE role = ? GROUP BY model, role`
    ).all(role) as Array<Record<string, number | string>>;
    return rows.map((row) => ({
      model: String(row.model),
      role: String(row.role),
      runs: Number(row.runs),
      avgCompletion: Number(row.avgCompletion),
      avgCost: Number(row.avgCost),
      successRate: Number(row.successRate),
    }));
  }
  listRoles(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT role FROM runs ORDER BY role`).all() as Array<{ role: string }>;
    return rows.map((r) => r.role);
  }
  getPin(role: string): string | undefined {
    const row = this.db.prepare(`SELECT model FROM role_pin WHERE role = ?`).get(role) as { model: string } | undefined;
    return row?.model;
  }
  setPin(role: string, model: string): void {
    this.db.prepare(
      `INSERT INTO role_pin (role, model, updated_ts) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET model = excluded.model, updated_ts = excluded.updated_ts`
    ).run(role, model, Date.now());
  }
  clearPin(role: string): void {
    this.db.prepare(`DELETE FROM role_pin WHERE role = ?`).run(role);
  }
  getConfig(): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM config`).all() as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }
  setConfig(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }
  close(): void { this.db.close(); }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/store.test.ts`
Expected: PASS（4 个测试通过）

- [ ] **Step 6: Commit**

```bash
git add src/store/schema.ts src/store/store.ts test/store.test.ts
git commit -m "feat(agent-lab): sqlite store (runs/aggregate/pin/config)"
```

---

## Task 3: 完成度派生（纯函数）

**Files:**
- Create: `src/scorer/completion.ts`
- Test: `test/completion.test.ts`

**Interfaces:**
- Produces: `clamp01(x): number`、`acceptanceBase(level, map): number`、`deriveCompletion(i: CompletionInput): number`，其中 `CompletionInput = { acceptance?; interrupted?; toolSuccess?; manualRating?; map; interruptedPenalty; toolFailPenalty }`。

- [ ] **Step 1: 写失败测试 test/completion.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCompletion, acceptanceBase, clamp01 } from "../src/scorer/completion.ts";

const MAP = { reviewed: 1.0, verified: 0.9, checked: 0.7, attested: 0.5, auto: 0.4, none: 0.2 };
const base = { map: MAP, interruptedPenalty: 0.3, toolFailPenalty: 0.2 };

test("acceptance maps to base score", () => {
  assert.equal(acceptanceBase("verified", MAP), 0.9);
  assert.equal(acceptanceBase(undefined, MAP), 0.4);
  assert.equal(acceptanceBase("unknown", MAP), 0.4);
});

test("clean verified run => 0.9", () => {
  assert.equal(deriveCompletion({ ...base, acceptance: "verified", toolSuccess: 1 }), 0.9);
});

test("interrupted subtracts penalty", () => {
  assert.ok(Math.abs(deriveCompletion({ ...base, acceptance: "verified", interrupted: 1, toolSuccess: 1 }) - 0.6) < 1e-9);
});

test("low tool success subtracts", () => {
  assert.ok(Math.abs(deriveCompletion({ ...base, acceptance: "checked", toolSuccess: 0.5 }) - 0.6) < 1e-9);
});

test("manual rating overrides", () => {
  assert.equal(deriveCompletion({ ...base, acceptance: "verified", manualRating: 0.2 }), 0.2);
});

test("clamps to [0,1]", () => {
  assert.equal(deriveCompletion({ ...base, acceptance: "none", interrupted: 1, toolSuccess: 0 }), 0);
  assert.equal(clamp01(1.5), 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/completion.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 写 src/scorer/completion.ts**

```ts
export function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export function acceptanceBase(level: string | undefined, map: Record<string, number>): number {
  if (level && level in map) return map[level];
  return map.auto ?? 0.4;
}

export interface CompletionInput {
  acceptance?: string;
  interrupted?: number;
  toolSuccess?: number;
  manualRating?: number;
  map: Record<string, number>;
  interruptedPenalty: number;
  toolFailPenalty: number;
}

export function deriveCompletion(i: CompletionInput): number {
  if (i.manualRating != null && !Number.isNaN(i.manualRating)) return clamp01(i.manualRating);
  const base = acceptanceBase(i.acceptance, i.map);
  const interruptPen = i.interrupted ? i.interruptedPenalty : 0;
  const tsr = clamp01(i.toolSuccess ?? 1);
  const failPen = (1 - tsr) * i.toolFailPenalty;
  return clamp01(base - interruptPen - failPen);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/completion.test.ts`
Expected: PASS（6 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/scorer/completion.ts test/completion.test.ts
git commit -m "feat(agent-lab): completion derivation (acceptance + signal penalties)"
```

---

## Task 4: 目录解析（纯函数）

**Files:**
- Create: `src/catalog/parse.ts`
- Test: `test/catalog-parse.test.ts`

**Interfaces:**
- Produces: `providerPrefix(id): string`、`toPerMillion(usdPerToken): number`、`isFreeModel(e): boolean`、`blendedPrice(m: ModelInfo): number`、`parseORModels(json: ORModelsJson, directPrefixes: string[]): ModelInfo[]`；类型 `ORModelEntry / ORModelsJson`。

- [ ] **Step 1: 写失败测试 test/catalog-parse.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseORModels, isFreeModel, toPerMillion, providerPrefix, blendedPrice } from "../src/catalog/parse.ts";
import type { ORModelsJson } from "../src/catalog/parse.ts";

const DIRECT = ["deepseek", "moonshotai", "z-ai", "qwen"];
const json: ORModelsJson = {
  data: [
    { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", context_length: 163840, pricing: { prompt: "0.00000027", completion: "0.0000004" } },
    { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-oss-20b:free", name: "gpt-oss-20b (free)", context_length: 131072, pricing: { prompt: "0", completion: "0" } },
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
  ],
};

test("providerPrefix", () => {
  assert.equal(providerPrefix("deepseek/deepseek-v3.2"), "deepseek");
  assert.equal(providerPrefix("noslash"), "noslash");
});

test("toPerMillion converts per-token to per-million", () => {
  assert.ok(Math.abs(toPerMillion("0.00000027") - 0.27) < 1e-9);
  assert.equal(toPerMillion("0"), 0);
  assert.equal(toPerMillion(undefined), 0);
});

test("isFreeModel", () => {
  assert.equal(isFreeModel({ id: "x", pricing: { prompt: "0", completion: "0" } }), true);
  assert.equal(isFreeModel({ id: "x", pricing: { prompt: "0.00000027", completion: "0" } }), false);
});

test("parseORModels keeps only free + direct candidates and tags route", () => {
  const models = parseORModels(json, DIRECT);
  const ids = models.map((m) => m.id).sort();
  assert.deepEqual(ids, ["deepseek/deepseek-v3.2", "google/gemma-4-31b-it:free", "openai/gpt-oss-20b:free"]);
  const ds = models.find((m) => m.id === "deepseek/deepseek-v3.2")!;
  assert.equal(ds.accessRoute, "direct");
  assert.ok(Math.abs(ds.pricing!.in - 0.27) < 1e-9);
  const gemma = models.find((m) => m.id === "google/gemma-4-31b-it:free")!;
  assert.equal(gemma.accessRoute, "free");
  assert.equal(blendedPrice(gemma), 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/catalog-parse.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 写 src/catalog/parse.ts**

```ts
import type { ModelInfo } from "../types.ts";

export interface ORModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}
export interface ORModelsJson { data: ORModelEntry[]; }

export function providerPrefix(id: string): string {
  const idx = id.indexOf("/");
  return idx >= 0 ? id.slice(0, idx) : id;
}

export function toPerMillion(usdPerToken: string | undefined): number {
  const n = Number(usdPerToken);
  if (!Number.isFinite(n)) return 0;
  return n * 1_000_000;
}

export function isFreeModel(e: ORModelEntry): boolean {
  const p = e.pricing;
  if (!p) return false;
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

export function blendedPrice(m: ModelInfo): number {
  if (!m.pricing) return 0;
  return (m.pricing.in + m.pricing.out) / 2;
}

export function parseORModels(json: ORModelsJson, directPrefixes: string[]): ModelInfo[] {
  const direct = new Set(directPrefixes);
  const out: ModelInfo[] = [];
  for (const e of json.data) {
    const free = isFreeModel(e);
    const isDirect = direct.has(providerPrefix(e.id));
    if (!free && !isDirect) continue;
    const accessRoute = free && isDirect ? "both" : free ? "free" : "direct";
    const modalities = [
      ...(e.architecture?.input_modalities ?? []),
      ...(e.architecture?.output_modalities ?? []),
    ];
    out.push({
      id: e.id,
      provider: providerPrefix(e.id),
      name: e.name ?? e.id,
      contextWindow: e.context_length,
      pricing: { in: toPerMillion(e.pricing?.prompt), out: toPerMillion(e.pricing?.completion) },
      modalities: modalities.length ? modalities : undefined,
      accessRoute,
    });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/catalog-parse.test.ts`
Expected: PASS（4 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/catalog/parse.ts test/catalog-parse.test.ts
git commit -m "feat(agent-lab): catalog parse (free + direct candidates, per-million pricing)"
```

---

## Task 5: 目录服务（抓取 + 缓存 + TTL）

**Files:**
- Create: `src/catalog/sources.ts`
- Create: `src/catalog/catalog.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Consumes: `parseORModels`, `ORModelsJson`, `ModelInfo`
- Produces: `fetchJson<T>(url, opts?): Promise<T>`（`opts.fetchImpl` 可注入）、`OR_MODELS_URL`、`class CatalogService { constructor(deps: CatalogDeps); refresh(): Promise<void>; candidates(): ModelInfo[]; readonly isFresh: boolean; readonly lastFetched: number }`，`CatalogDeps = { directPrefixes; ttlMs; fetchImpl?; headers?; now? }`。

- [ ] **Step 1: 写 src/catalog/sources.ts**

```ts
export const OR_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface FetchJsonOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    const res = await f(url, { signal: ctrl.signal, headers: opts.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onParentAbort);
  }
}
```

- [ ] **Step 2: 写失败测试 test/catalog.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CatalogService } from "../src/catalog/catalog.ts";

const OR_JSON = {
  data: [
    { id: "google/gemma-4-31b-it:free", name: "Gemma (free)", context_length: 262144, pricing: { prompt: "0", completion: "0" } },
    { id: "deepseek/deepseek-v3.2", name: "DS V3.2", context_length: 163840, pricing: { prompt: "0.00000027", completion: "0.0000004" } },
    { id: "anthropic/claude-sonnet-4", name: "Sonnet", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" } },
  ],
};

function mockFetch(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

test("refresh parses free + direct candidates only", async () => {
  const cat = new CatalogService({ directPrefixes: ["deepseek"], ttlMs: 1000, fetchImpl: mockFetch(OR_JSON) });
  await cat.refresh();
  const ids = cat.candidates().map((m) => m.id).sort();
  assert.deepEqual(ids, ["deepseek/deepseek-v3.2", "google/gemma-4-31b-it:free"]);
});

test("isFresh reflects ttl", async () => {
  let t = 1000;
  const cat = new CatalogService({ directPrefixes: ["deepseek"], ttlMs: 500, fetchImpl: mockFetch(OR_JSON), now: () => t });
  await cat.refresh();
  assert.equal(cat.isFresh, true);
  t = 1600;
  assert.equal(cat.isFresh, false);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/catalog.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 4: 写 src/catalog/catalog.ts**

```ts
import type { ModelInfo } from "../types.ts";
import { fetchJson, OR_MODELS_URL } from "./sources.ts";
import { parseORModels, type ORModelsJson } from "./parse.ts";

export interface CatalogDeps {
  directPrefixes: string[];
  ttlMs: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  now?: () => number;
}

export class CatalogService {
  private cache: ModelInfo[] = [];
  private fetchedAt = 0;
  private deps: CatalogDeps;
  constructor(deps: CatalogDeps) { this.deps = deps; }

  async refresh(): Promise<void> {
    const json = await fetchJson<ORModelsJson>(OR_MODELS_URL, {
      fetchImpl: this.deps.fetchImpl,
      headers: this.deps.headers,
    });
    this.cache = parseORModels(json, this.deps.directPrefixes);
    this.fetchedAt = (this.deps.now ?? Date.now)();
  }

  candidates(): ModelInfo[] { return this.cache; }
  get lastFetched(): number { return this.fetchedAt; }
  get isFresh(): boolean { return (this.deps.now ?? Date.now)() - this.fetchedAt < this.deps.ttlMs; }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/catalog.test.ts`
Expected: PASS（2 个测试通过）

- [ ] **Step 6: Commit**

```bash
git add src/catalog/sources.ts src/catalog/catalog.ts test/catalog.test.ts
git commit -m "feat(agent-lab): catalog service (fetch + TTL cache, injectable fetch)"
```

---

## Task 6: 打分引擎（纯函数）

**Files:**
- Create: `src/scorer/scorer.ts`
- Test: `test/scorer.test.ts`

**Interfaces:**
- Consumes: `ModelInfo`, `Aggregate`, `LabConfig`, `ScoredModel`, `blendedPrice`
- Produces: `minmax(values, invert?): number[]`、`representativeBenchmark(m): number`、`staticProxy(m): number`、`scoreCandidates(candidates, aggsByModel, cfg): ScoredModel[]`、`recommend(candidates, aggsByModel, cfg, topN): ScoredModel[]`。

- [ ] **Step 1: 写失败测试 test/scorer.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { recommend, scoreCandidates, minmax } from "../src/scorer/scorer.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Aggregate, ModelInfo } from "../src/types.ts";

function model(id: string, pricing?: { in: number; out: number }, perf?: number): ModelInfo {
  const free = pricing != null && pricing.in === 0 && pricing.out === 0;
  return { id, provider: id.split("/")[0], name: id, pricing, perf: perf != null ? { throughputP50: perf } : undefined, accessRoute: free ? "free" : "direct" };
}

test("minmax normalizes and inverts", () => {
  assert.deepEqual(minmax([0, 5, 10]), [0, 0.5, 1]);
  assert.deepEqual(minmax([0, 5, 10], true), [1, 0.5, 0]);
  assert.deepEqual(minmax([3, 3, 3]), [0.5, 0.5, 0.5]);
});

test("free model gets cost advantage", () => {
  const scored = scoreCandidates([model("a/free", { in: 0, out: 0 }), model("b/paid", { in: 1, out: 1 })], new Map(), DEFAULT_CONFIG);
  const sFree = scored.find((s) => s.model.id === "a/free")!;
  const sPaid = scored.find((s) => s.model.id === "b/paid")!;
  assert.ok(sFree.breakdown.costEffectiveness > sPaid.breakdown.costEffectiveness);
});

test("empirical completion beats cold start when high", () => {
  const m1 = model("x/m1", { in: 0.5, out: 0.5 });
  const m2 = model("x/m2", { in: 0.5, out: 0.5 });
  const aggs = new Map<string, Aggregate>([
    ["x/m1", { model: "x/m1", role: "r", runs: 5, avgCompletion: 0.95, avgCost: 0.5, successRate: 1 }],
  ]);
  const top = recommend([m1, m2], aggs, DEFAULT_CONFIG, 1);
  assert.equal(top[0].model.id, "x/m1");
  assert.equal(top[0].coldStart, false);
});

test("recommend respects topN and sorts desc", () => {
  const ms = [model("a/a", { in: 0, out: 0 }), model("b/b", { in: 1, out: 1 }), model("c/c", { in: 2, out: 2 })];
  const top = recommend(ms, new Map(), DEFAULT_CONFIG, 2);
  assert.equal(top.length, 2);
  assert.ok(top[0].score >= top[1].score);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/scorer.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 写 src/scorer/scorer.ts**

```ts
import type { Aggregate, LabConfig, ModelInfo, ScoredModel } from "../types.ts";
import { blendedPrice } from "../catalog/parse.ts";

export function minmax(values: number[], invert = false): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => {
    const n = (v - min) / (max - min);
    return invert ? 1 - n : n;
  });
}

export function representativeBenchmark(m: ModelInfo): number {
  if (!m.benchmarks) return 0;
  const vals = Object.values(m.benchmarks).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function staticProxy(m: ModelInfo): number {
  const b = representativeBenchmark(m);
  return b > 0 ? Math.min(1, b / 100) : 0.5;
}

export function scoreCandidates(candidates: ModelInfo[], aggsByModel: Map<string, Aggregate>, cfg: LabConfig): ScoredModel[] {
  const completionRaw = candidates.map((m) => {
    const agg = aggsByModel.get(m.id);
    return agg ? agg.avgCompletion : staticProxy(m);
  });
  const costRaw = candidates.map((m) => blendedPrice(m));
  const perfRaw = candidates.map((m) => m.perf?.throughputP50 ?? 0);
  const benchRaw = candidates.map((m) => representativeBenchmark(m));

  const costNorm = minmax(costRaw, true);
  const perfNorm = minmax(perfRaw);
  const benchNorm = minmax(benchRaw);
  const w = cfg.weights;

  return candidates.map((m, i) => {
    const agg = aggsByModel.get(m.id);
    const coldStart = !agg;
    const breakdown = {
      completion: w.completion * completionRaw[i],
      costEffectiveness: w.costEffectiveness * costNorm[i],
      performance: w.performance * perfNorm[i],
      benchmark: w.benchmark * benchNorm[i],
    };
    const score = breakdown.completion + breakdown.costEffectiveness + breakdown.performance + breakdown.benchmark;
    return { model: m, score, breakdown, coldStart, reason: buildReason(m, coldStart, breakdown, costRaw[i]) };
  });
}

function buildReason(m: ModelInfo, coldStart: boolean, b: { completion: number; costEffectiveness: number; performance: number; benchmark: number }, cost: number): string {
  const parts: string[] = [];
  if (coldStart) parts.push("冷启动(静态特征)");
  if (cost === 0) parts.push("免费");
  const dominant = (Object.entries(b) as Array<[string, number]>).sort((a, c) => c[1] - a[1])[0];
  const label: Record<string, string> = { completion: "完成度高", costEffectiveness: "性价比高", performance: "性能高", benchmark: "基准高" };
  if (dominant) parts.push(label[dominant[0]] ?? dominant[0]);
  return parts.join(" · ");
}

export function recommend(candidates: ModelInfo[], aggsByModel: Map<string, Aggregate>, cfg: LabConfig, topN: number): ScoredModel[] {
  return scoreCandidates(candidates, aggsByModel, cfg).sort((a, b) => b.score - a.score).slice(0, topN);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/scorer.test.ts`
Expected: PASS（4 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/scorer/scorer.ts test/scorer.test.ts
git commit -m "feat(agent-lab): scoring engine (weighted fusion + cold start)"
```

---

## Task 7: 遥测解析（纯函数）

**Files:**
- Create: `src/telemetry/parse.ts`
- Test: `test/telemetry-parse.test.ts`

**Interfaces:**
- Consumes: `LabConfig`, `RunRecord`, `deriveCompletion`
- Produces: `parseSubagentRun(call: SubagentCallLike, cfg: LabConfig, now?: number): RunRecord | undefined`，`SubagentCallLike = { input: Record<string, unknown>; result?: Record<string, unknown> }`。

- [ ] **Step 1: 写失败测试 test/telemetry-parse.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubagentRun } from "../src/telemetry/parse.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("parses a full subagent result", () => {
  const rec = parseSubagentRun({
    input: { agent: "reviewer" },
    result: { model: "deepseek/deepseek-v3.2", acceptance: { status: "verified" }, usage: { input: 1000, output: 500, cost: { total: 0.012 } }, turns: 4 },
  }, DEFAULT_CONFIG, 12345);
  assert.ok(rec);
  assert.equal(rec!.role, "reviewer");
  assert.equal(rec!.model, "deepseek/deepseek-v3.2");
  assert.equal(rec!.acceptance, "verified");
  assert.equal(rec!.tokensIn, 1000);
  assert.equal(rec!.tokensOut, 500);
  assert.ok(Math.abs(rec!.cost! - 0.012) < 1e-9);
  assert.equal(rec!.turns, 4);
  assert.ok(Math.abs(rec!.completion - 0.9) < 1e-9);
  assert.equal(rec!.source, "auto");
});

test("skips when no agent role", () => {
  assert.equal(parseSubagentRun({ input: {}, result: {} }, DEFAULT_CONFIG), undefined);
});

test("interrupted result lowers completion", () => {
  const rec = parseSubagentRun({ input: { agent: "worker" }, result: { acceptance: "checked", state: "stopped" } }, DEFAULT_CONFIG)!;
  assert.equal(rec.interrupted, 1);
  assert.ok(Math.abs(rec.completion - 0.4) < 1e-9);
});

test("acceptance as plain string", () => {
  const rec = parseSubagentRun({ input: { agent: "scout" }, result: { acceptance: "attested" } }, DEFAULT_CONFIG)!;
  assert.equal(rec.acceptance, "attested");
  assert.ok(Math.abs(rec.completion - 0.5) < 1e-9);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/telemetry-parse.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 写 src/telemetry/parse.ts**

```ts
import type { LabConfig, RunRecord } from "../types.ts";
import { deriveCompletion } from "../scorer/completion.ts";

export interface SubagentCallLike {
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseSubagentRun(call: SubagentCallLike, cfg: LabConfig, now: number = Date.now()): RunRecord | undefined {
  const role = typeof call.input.agent === "string" ? call.input.agent : undefined;
  if (!role) return undefined;
  const r = call.result ?? {};

  const acceptanceRaw = r.acceptance as unknown;
  const acceptance =
    typeof acceptanceRaw === "string"
      ? acceptanceRaw
      : acceptanceRaw && typeof acceptanceRaw === "object" && typeof (acceptanceRaw as { status?: unknown }).status === "string"
        ? (acceptanceRaw as { status: string }).status
        : undefined;

  const usage = (r.usage ?? {}) as Record<string, unknown>;
  const costObj = usage.cost as Record<string, unknown> | undefined;
  const tokensIn = num(usage.input) ?? num(usage.inputTokens);
  const tokensOut = num(usage.output) ?? num(usage.outputTokens);
  const cost = num(costObj?.total) ?? num(usage.cost) ?? num(usage.totalCost);

  const model =
    (typeof r.model === "string" && r.model) ||
    (typeof call.input.model === "string" && call.input.model) ||
    "unknown";

  const toolSuccess = num(r.toolSuccessRate) ?? 1;
  const turns = num(r.turns) ?? num(r.numTurns);
  const interrupted = r.interrupted === true || r.state === "stopped" || r.state === "interrupted" ? 1 : 0;

  const completion = deriveCompletion({
    acceptance, interrupted, toolSuccess,
    map: cfg.acceptanceScoreMap,
    interruptedPenalty: cfg.interruptedPenalty,
    toolFailPenalty: cfg.toolFailPenalty,
  });

  return {
    ts: now, role, model, acceptance, completion,
    tokensIn, tokensOut, cost, toolSuccess, turns, interrupted,
    signals: { acceptance, state: r.state },
    source: "auto",
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/telemetry-parse.test.ts`
Expected: PASS（4 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/parse.ts test/telemetry-parse.test.ts
git commit -m "feat(agent-lab): telemetry parse (subagent result -> RunRecord)"
```

---

## Task 8: 拦截器决策（纯函数）

**Files:**
- Create: `src/interceptor/logic.ts`
- Test: `test/interceptor-logic.test.ts`

**Interfaces:**
- Produces: `decideIntercept(i: InterceptInput): InterceptDecision`、`modelAllowed(model, allowGlobs?): boolean`、`globMatch(pattern, value): boolean`；类型 `InterceptDecision / InterceptInput`。

- [ ] **Step 1: 写失败测试 test/interceptor-logic.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideIntercept, modelAllowed, globMatch } from "../src/interceptor/logic.ts";
import type { ScoredModel } from "../src/types.ts";

function scored(id: string): ScoredModel {
  return { model: { id, provider: id.split("/")[0], name: id, accessRoute: "free" }, score: 0.5, breakdown: { completion: 0, costEffectiveness: 0, performance: 0, benchmark: 0 }, reason: "r", coldStart: true };
}

test("autoApply off => skip", () => {
  assert.deepEqual(decideIntercept({ role: "r", autoApply: false, alternatives: [] }), { action: "skip" });
});

test("pinned => silent apply", () => {
  assert.deepEqual(decideIntercept({ role: "r", autoApply: true, pinnedModel: "m/pin", alternatives: [] }), { action: "apply", model: "m/pin", silent: true });
});

test("recommendation => prompt", () => {
  const d = decideIntercept({ role: "r", autoApply: true, recommendation: scored("m/rec"), alternatives: [scored("m/alt")] });
  assert.equal(d.action, "prompt");
});

test("no recommendation, no pin => skip", () => {
  assert.deepEqual(decideIntercept({ role: "r", autoApply: true, alternatives: [] }), { action: "skip" });
});

test("modelAllowed with globs", () => {
  assert.equal(modelAllowed("deepseek/deepseek-v3.2", undefined), true);
  assert.equal(modelAllowed("deepseek/deepseek-v3.2", ["deepseek/*"]), true);
  assert.equal(modelAllowed("anthropic/claude", ["deepseek/*"]), false);
  assert.equal(globMatch("*/kimi-*", "moonshotai/kimi-k3"), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test test/interceptor-logic.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 写 src/interceptor/logic.ts**

```ts
import type { ScoredModel } from "../types.ts";

export type InterceptDecision =
  | { action: "skip" }
  | { action: "apply"; model: string; silent: boolean }
  | { action: "prompt"; recommendation: ScoredModel; alternatives: ScoredModel[] };

export interface InterceptInput {
  role: string;
  pinnedModel?: string;
  autoApply: boolean;
  recommendation?: ScoredModel;
  alternatives: ScoredModel[];
}

export function decideIntercept(i: InterceptInput): InterceptDecision {
  if (!i.autoApply) return { action: "skip" };
  if (i.pinnedModel) return { action: "apply", model: i.pinnedModel, silent: true };
  if (i.recommendation) return { action: "prompt", recommendation: i.recommendation, alternatives: i.alternatives };
  return { action: "skip" };
}

export function modelAllowed(model: string, allowGlobs?: string[]): boolean {
  if (!allowGlobs || allowGlobs.length === 0) return true;
  return allowGlobs.some((g) => globMatch(g, model));
}

export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$", "i");
  return re.test(value);
}
function escapeRe(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --experimental-strip-types --test test/interceptor-logic.test.ts`
Expected: PASS（5 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/interceptor/logic.ts test/interceptor-logic.test.ts
git commit -m "feat(agent-lab): interceptor decision logic + modelScope glob match"
```

---

## Task 9: 配置 I/O + 数据目录

**Files:**
- Create: `src/config-io.ts`

**Interfaces:**
- Consumes: `LabConfig`, `mergeConfig`
- Produces: `dataDir(): string`、`dbPath(): string`、`configPath(): string`、`ensureDataDir(): void`、`loadConfig(): LabConfig`、`saveConfig(cfg): void`。数据目录 = `~/.pi/agent/agent-lab/`。

- [ ] **Step 1: 写 src/config-io.ts**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LabConfig } from "./types.ts";
import { mergeConfig } from "./config.ts";

export function dataDir(): string { return join(homedir(), ".pi", "agent", "agent-lab"); }
export function dbPath(): string { return join(dataDir(), "agent-lab.db"); }
export function configPath(): string { return join(dataDir(), "config.json"); }

export function ensureDataDir(): void { mkdirSync(dataDir(), { recursive: true }); }

export function loadConfig(): LabConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    return mergeConfig(JSON.parse(raw));
  } catch {
    return mergeConfig(undefined);
  }
}

export function saveConfig(cfg: LabConfig): void {
  ensureDataDir();
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
```

- [ ] **Step 2: 冒烟验证（不写单测，因依赖 homedir/fs）**

Run:
```bash
node --experimental-strip-types -e "import('./src/config-io.ts').then(m=>{console.log('dataDir=',m.dataDir());console.log('cfg.topN=',m.loadConfig().topN);})"
```
Expected: 打印 `dataDir= ~/.pi/agent/agent-lab`（绝对路径）与 `cfg.topN= 3`，无报错。

- [ ] **Step 3: Commit**

```bash
git add src/config-io.ts
git commit -m "feat(agent-lab): config I/O + data dir (~/.pi/agent/agent-lab)"
```

---

## Task 10: 遥测钩子（pi 胶水）

**Files:**
- Create: `src/telemetry/register.ts`

**Interfaces:**
- Consumes: `Store`, `LabConfig`, `parseSubagentRun`
- Produces: `registerTelemetry(pi: ExtensionAPI, store: Store, cfg: LabConfig): void`（订阅 `tool_execution_end`，仅处理 `toolName === "subagent"`，fail-open）。

- [ ] **Step 1: 写 src/telemetry/register.ts**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import { parseSubagentRun } from "./parse.ts";

export function registerTelemetry(pi: ExtensionAPI, store: Store, cfg: LabConfig): void {
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "subagent") return;
    try {
      const raw = event.result as { details?: unknown } | undefined;
      const result = (raw?.details ?? event.result) as Record<string, unknown>;
      const rec = parseSubagentRun(
        { input: (event.args ?? {}) as Record<string, unknown>, result },
        cfg
      );
      if (rec) store.appendRun(rec);
    } catch (err) {
      console.error("[agent-lab] telemetry failed:", err);
    }
  });
}
```

- [ ] **Step 2: 类型/语法冒烟（经 jiti 不可离线校验，做 node 解析检查）**

Run:
```bash
node --experimental-strip-types -e "import('./src/telemetry/register.ts').then(()=>console.log('register.ts loads')).catch(e=>{console.error(e);process.exit(1);})"
```
Expected: 打印 `register.ts loads`（`@earendil-works/pi-coding-agent` 为 type-only import，strip-types 会擦除，故离线可加载）。若报缺少模块，确认 import 用了 `import type`。

- [ ] **Step 3: Commit**

```bash
git add src/telemetry/register.ts
git commit -m "feat(agent-lab): telemetry hook (tool_execution_end -> appendRun)"
```

---

## Task 11: 拦截器钩子 + modelScope 读取（pi 胶水）

**Files:**
- Create: `src/interceptor/model-scope.ts`
- Create: `src/interceptor/register.ts`

**Interfaces:**
- Consumes: `Store`, `CatalogService`, `LabConfig`, `recommend`, `decideIntercept`, `modelAllowed`
- Produces: `loadModelScopeAllow(): string[] | undefined`、`registerInterceptor(pi, store, catalog, cfg): void`（订阅 `tool_call`，fail-open；已 pin 静默应用，未 pin 弹 `ctx.ui.select` 确认并可记住）。

- [ ] **Step 1: 写 src/interceptor/model-scope.ts**

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadModelScopeAllow(): string[] | undefined {
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { subagents?: { modelScope?: { enforce?: boolean; allow?: unknown } } };
    const scope = settings?.subagents?.modelScope;
    if (scope?.enforce && Array.isArray(scope.allow)) return scope.allow as string[];
    return undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: 写 src/interceptor/register.ts**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import type { CatalogService } from "../catalog/catalog.ts";
import { recommend } from "../scorer/scorer.ts";
import { decideIntercept, modelAllowed } from "./logic.ts";
import { loadModelScopeAllow } from "./model-scope.ts";

export function registerInterceptor(pi: ExtensionAPI, store: Store, catalog: CatalogService, cfg: LabConfig): void {
  const allowGlobs = loadModelScopeAllow();
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    try {
      const input = event.input as Record<string, unknown>;
      const role = typeof input.agent === "string" ? input.agent : undefined;
      if (!role) return;

      const aggs = new Map(store.aggregateByRole(role).map((a) => [a.model, a]));
      const recs = recommend(catalog.candidates(), aggs, cfg, cfg.topN);
      const decision = decideIntercept({
        role,
        pinnedModel: store.getPin(role),
        autoApply: cfg.autoApply,
        recommendation: recs[0],
        alternatives: recs.slice(1),
      });

      if (decision.action === "apply") {
        if (modelAllowed(decision.model, allowGlobs)) {
          input.model = decision.model;
          ctx.ui.setStatus("agent-lab", `${role} → ${decision.model} (pinned)`);
        }
      } else if (decision.action === "prompt") {
        const items = [decision.recommendation, ...decision.alternatives].map(
          (s) => `${s.model.id} — ${s.reason} (score ${s.score.toFixed(3)})`
        );
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

- [ ] **Step 3: 加载冒烟**

Run:
```bash
node --experimental-strip-types -e "import('./src/interceptor/register.ts').then(()=>console.log('interceptor register loads')).catch(e=>{console.error(e);process.exit(1);})"
```
Expected: 打印 `interceptor register loads`。

- [ ] **Step 4: Commit**

```bash
git add src/interceptor/model-scope.ts src/interceptor/register.ts
git commit -m "feat(agent-lab): interceptor hook (auto-apply with confirm + modelScope guard)"
```

---

## Task 12: 命令与 LLM 工具（pi 胶水）

**Files:**
- Create: `src/commands/register.ts`

**Interfaces:**
- Consumes: `Store`, `CatalogService`, `LabConfig`, `recommend`, `saveConfig`
- Produces: `registerCommands(pi, deps: { store; catalog; cfg }): void`，注册 `/lab` 命令（子命令 recommend/stats/models/log/pin/unpin/config/doctor）与 `agent_lab` 工具（action: recommend/stats/models）。

- [ ] **Step 1: 写 src/commands/register.ts**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LabConfig } from "../types.ts";
import type { Store } from "../store/store.ts";
import type { CatalogService } from "../catalog/catalog.ts";
import { recommend } from "../scorer/scorer.ts";
import { saveConfig } from "../config-io.ts";

interface Deps { store: Store; catalog: CatalogService; cfg: LabConfig; }

export function registerCommands(pi: ExtensionAPI, deps: Deps): void {
  const { store, catalog, cfg } = deps;

  const aggsFor = (role: string) => new Map(store.aggregateByRole(role).map((a) => [a.model, a]));

  function renderRecommend(role: string, topN: number): string {
    const recs = recommend(catalog.candidates(), aggsFor(role), cfg, topN);
    if (recs.length === 0) return `角色 ${role}: 无候选模型（目录为空？试 /lab models --refresh）`;
    return `角色 ${role} 推荐:\n` + recs.map((s, i) => `${i + 1}. ${s.model.id}  score=${s.score.toFixed(3)}  ${s.reason}`).join("\n");
  }

  function renderStats(role?: string): string {
    const roles = role ? [role] : store.listRoles();
    if (roles.length === 0) return "暂无遥测数据。";
    const out: string[] = [];
    for (const r of roles) {
      out.push(`# ${r}`);
      for (const a of store.aggregateByRole(r)) {
        out.push(`  ${a.model}: runs=${a.runs} avgCompletion=${a.avgCompletion.toFixed(2)} avgCost=${a.avgCost.toFixed(4)} success=${a.successRate.toFixed(2)}`);
      }
    }
    return out.join("\n");
  }

  function applyConfig(key: string, val: string): void {
    if (key.startsWith("weights.")) {
      const k = key.slice("weights.".length) as keyof LabConfig["weights"];
      if (k in cfg.weights) cfg.weights[k] = Number(val);
    } else if (key === "autoApply") cfg.autoApply = val === "true";
    else if (key === "topN") cfg.topN = Number(val);
    else if (key === "interruptedPenalty") cfg.interruptedPenalty = Number(val);
    else if (key === "toolFailPenalty") cfg.toolFailPenalty = Number(val);
    else if (key === "catalogTtlMs") cfg.catalogTtlMs = Number(val);
  }

  pi.registerCommand("lab", {
    description: "Agent Lab: recommend/stats/models/log/pin/unpin/config/doctor",
    handler: async (args, ctx) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = argv[0];
      if (cmd === "recommend") {
        const role = argv[1];
        if (!role) { ctx.ui.notify("用法: /lab recommend <role> [--top N]", "error"); return; }
        const topIdx = argv.indexOf("--top");
        const topN = topIdx >= 0 ? Number(argv[topIdx + 1]) || cfg.topN : cfg.topN;
        ctx.ui.notify(renderRecommend(role, topN), "info");
      } else if (cmd === "stats") {
        ctx.ui.notify(renderStats(argv[1]), "info");
      } else if (cmd === "models") {
        if (argv.includes("--refresh")) await catalog.refresh().catch((e: Error) => ctx.ui.notify(`刷新失败: ${e.message}`, "error"));
        const ms = catalog.candidates();
        const lines = ms.slice(0, 50).map((m) => `${m.id} [${m.accessRoute}] in=$${m.pricing?.in ?? "?"}/M out=$${m.pricing?.out ?? "?"}/M ctx=${m.contextWindow ?? "?"}`);
        ctx.ui.notify(`候选模型 ${ms.length} 个:\n` + lines.join("\n"), "info");
      } else if (cmd === "log") {
        const role = argv[1]; const model = argv[2];
        if (!role || !model) { ctx.ui.notify("用法: /lab log <role> <model> [--rating N] [--task CAT]", "error"); return; }
        const ratingIdx = argv.indexOf("--rating");
        const taskIdx = argv.indexOf("--task");
        const rating = ratingIdx >= 0 ? Number(argv[ratingIdx + 1]) : undefined;
        const task = taskIdx >= 0 ? argv[taskIdx + 1] : undefined;
        const manual = rating != null && !Number.isNaN(rating) ? Math.max(0, Math.min(1, rating > 1 ? rating / 5 : rating)) : undefined;
        store.appendRun({
          ts: Date.now(), role, model, taskCategory: task,
          acceptance: manual != null ? "manual" : "auto",
          completion: manual ?? 0.5, toolSuccess: 1, interrupted: 0,
          signals: { manual }, source: "manual",
        });
        ctx.ui.notify(`已记录 ${role}/${model}${manual != null ? ` rating=${manual.toFixed(2)}` : ""}`, "info");
      } else if (cmd === "pin") {
        const role = argv[1]; const model = argv[2];
        if (role && model) { store.setPin(role, model); ctx.ui.notify(`已固定 ${role} → ${model}`, "info"); }
        else ctx.ui.notify("用法: /lab pin <role> <model>", "error");
      } else if (cmd === "unpin") {
        const role = argv[1];
        if (role) { store.clearPin(role); ctx.ui.notify(`已取消固定 ${role}`, "info"); }
        else ctx.ui.notify("用法: /lab unpin <role>", "error");
      } else if (cmd === "config") {
        if (argv.length >= 3) { applyConfig(argv[1], argv[2]); saveConfig(cfg); ctx.ui.notify(`已设置 ${argv[1]} = ${argv[2]}`, "info"); }
        else ctx.ui.notify(JSON.stringify(cfg, null, 2), "info");
      } else if (cmd === "doctor") {
        ctx.ui.notify(`Agent Lab 状态:\n候选模型: ${catalog.candidates().length}\n目录新鲜: ${catalog.isFresh}\n角色数: ${store.listRoles().length}\nautoApply: ${cfg.autoApply}`, "info");
      } else {
        ctx.ui.notify("用法: /lab <recommend|stats|models|log|pin|unpin|config|doctor> ...", "info");
      }
    },
  });

  pi.registerTool({
    name: "agent_lab",
    label: "Agent Lab",
    description: "Query Agent Lab model recommendations, telemetry stats, and candidate models for a role.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("recommend"), Type.Literal("stats"), Type.Literal("models")]),
      role: Type.Optional(Type.String()),
      top: Type.Optional(Type.Number()),
    }),
    async execute(_id, params: { action: "recommend" | "stats" | "models"; role?: string; top?: number }) {
      if (params.action === "recommend") {
        if (!params.role) return { content: [{ type: "text", text: "role required for recommend" }], details: {} };
        return { content: [{ type: "text", text: renderRecommend(params.role, params.top ?? cfg.topN) }], details: {} };
      }
      if (params.action === "stats") return { content: [{ type: "text", text: renderStats(params.role) }], details: {} };
      const ms = catalog.candidates();
      return { content: [{ type: "text", text: `候选模型 ${ms.length} 个:\n` + ms.map((m) => `${m.id} [${m.accessRoute}] $${m.pricing?.in ?? "?"}/$${m.pricing?.out ?? "?"}/M`).join("\n") }], details: {} };
    },
  });
}
```

- [ ] **Step 2: 加载冒烟**

Run:
```bash
node --experimental-strip-types -e "import('./src/commands/register.ts').then(()=>console.log('commands register loads')).catch(e=>{console.error(e);process.exit(1);})"
```
Expected: 打印 `commands register loads`。（`typebox` 为运行时 import；离线环境若无 typebox 会报错——在 pi 运行时由 jiti 提供。此步若因缺 typebox 失败，属预期，留待 pi 内验证；不要因此改代码。）

- [ ] **Step 3: Commit**

```bash
git add src/commands/register.ts
git commit -m "feat(agent-lab): /lab command + agent_lab tool"
```

---

## Task 13: 扩展入口装配 + 全量测试 + 端到端冒烟

**Files:**
- Create: `index.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: 所有模块
- Produces: 默认导出 `async function(pi: ExtensionAPI)`，装配 store/catalog/钩子/命令，并在 `session_shutdown` 关库。

- [ ] **Step 1: 写 index.ts**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SqliteStore } from "./src/store/store.ts";
import { CatalogService } from "./src/catalog/catalog.ts";
import { loadConfig, ensureDataDir, dbPath } from "./src/config-io.ts";
import { registerTelemetry } from "./src/telemetry/register.ts";
import { registerInterceptor } from "./src/interceptor/register.ts";
import { registerCommands } from "./src/commands/register.ts";

const DIRECT_PREFIXES = ["deepseek", "moonshotai", "z-ai", "qwen"];

export default async function (pi: ExtensionAPI) {
  ensureDataDir();
  const cfg = loadConfig();
  const store = new SqliteStore(dbPath());
  const catalog = new CatalogService({ directPrefixes: DIRECT_PREFIXES, ttlMs: cfg.catalogTtlMs });
  await catalog.refresh().catch((e: Error) => console.error("[agent-lab] initial catalog refresh failed:", e?.message ?? e));

  registerTelemetry(pi, store, cfg);
  registerInterceptor(pi, store, catalog, cfg);
  registerCommands(pi, { store, catalog, cfg });

  pi.on("session_shutdown", async () => { try { store.close(); } catch { /* ignore */ } });
}
```

- [ ] **Step 2: 运行全部单元测试**

Run: `node --experimental-strip-types --test test/*.test.ts`
Expected: 全部 PASS（config 3 + store 4 + completion 6 + catalog-parse 4 + catalog 2 + scorer 4 + telemetry-parse 4 + interceptor-logic 5 = 32 个测试）。

- [ ] **Step 3: 写 README.md（使用文档）**

```markdown
# Agent Lab

 telemetry 驱动的 pi 模型选择扩展（Core + M1 遥测 + M2 选择优化器 MVP）。

## 数据位置
- DB / 配置：`~/.pi/agent/agent-lab/`（`agent-lab.db`、`config.json`）

## 命令
- `/lab recommend <role> [--top N]` — 该角色 Top-N 模型推荐
- `/lab stats [role]` — (model, role) 遥测聚合
- `/lab models [--refresh]` — 候选目录（免费 + 直连）
- `/lab log <role> <model> [--rating N] [--task CAT]` — 手动补录
- `/lab pin <role> <model>` / `/lab unpin <role>`
- `/lab config [key value]` — 查看/修改权重与开关
- `/lab doctor` — 健康检查

## 行为
- 自动记录每次 subagent 运行的完成度/成本/性能信号。
- `autoApply`（默认开）：派发 subagent 前按角色推荐模型；已 pin 静默应用，未 pin 弹确认（可记住）。任何异常都 fail-open，不阻断派发。

## 测试
`node --experimental-strip-types --test test/*.test.ts`
```

- [ ] **Step 4: 端到端冒烟（在 pi 内手动验证）**

在 pi TUI 中 `/reload` 加载扩展，然后：
1. `/lab doctor` → 应显示候选模型数 > 0、autoApply: true。
2. `/lab models` → 列出免费 + 直连模型（含定价）。
3. 派发一个真实 subagent（如 `subagent({ agent: "scout", task: "列出当前目录文件" })`）→ 派发前应弹出 Agent Lab 模型选择（首次无 pin）。
4. `/lab stats scout` → 应出现一行该次运行记录（role=scout，含 completion/cost）。
5. `/lab recommend scout` → 应返回排序后的推荐列表。

Expected: 上述各步符合描述；DB 文件 `~/.pi/agent/agent-lab/agent-lab.db` 生成。

- [ ] **Step 5: Commit**

```bash
git add index.ts README.md
git commit -m "feat(agent-lab): wire extension entry + README (Core+M1+M2 MVP complete)"
```

---

## Self-Review（计划自检结论）

- **Spec 覆盖**：目录层(Task 4/5)、存储(Task 2)、完成度(Task 3)、打分(M2 Task 6)、遥测(M1 Task 7/10)、拦截器自动应用(Task 8/11)、命令与工具(Task 12)、配置(Task 1/9)、入口(Task 13)、fail-open/隐私/定价口径（Global Constraints + 各 glue 的 try/catch）均有对应任务。M3/M4/M5/Arena 明确不在本计划（spec 已声明）。
- **占位符**：无 TBD/TODO；每个代码步骤均含完整代码与确切命令/预期输出。
- **类型一致性**：`Store`/`CatalogService`/`recommend`/`decideIntercept`/`parseSubagentRun`/`deriveCompletion`/`mergeConfig`/`LabConfig`/`ModelInfo`/`RunRecord`/`Aggregate`/`ScoredModel` 在各任务签名一致。
- **已知实现期验证点**（spec §10）：subagent 结果中“所用模型/usage/acceptance”的确切字段需在 Task 13 端到端冒烟时核对；`ctx.ui.select` 返回字符串、`confirm` 返回布尔（已按 extensions.md 文档假设）；`typebox`/pi 类型在 pi 运行时由 jiti 提供。
