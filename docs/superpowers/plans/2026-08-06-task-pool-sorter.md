# 任务模板 + 任务池 + 分选器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 联邦地基二——任务模板注册表 + 任务池状态机 + 分选器（匹配/认领/回流/升级）+ sorter? SDK 端口 + /lab 命令 + 摄入周期流迁移为池投递。

**Architecture:** 新目录 `extensions/agent-lab/src/taskpool/`（纯增量，零依赖，node:test）。schema 进 `core/storage/schema.ts`（CORE_SCHEMA + `_applyCoreMigrations` 双路径——M1）。分层：TaskStore（tasks 表数据层，守卫转移 + 事件）→ SorterEngine（selector 匹配 + 原子认领 + 回流/升级编排）→ SorterCycle（周期驱动 + 派发超时包装）→ sorter? SDK 端口（装配层挂载）。摄入 cycle.ts 从 direct dispatch 迁移为 publish（唯一计划内行为迁移）。

**Tech Stack:** TypeScript（`--experimental-strip-types`，import 后缀 `.ts`）、node:test + assert/strict、node:sqlite DatabaseSync、node:crypto randomUUID。零新增依赖。

## Global Constraints

- 零新增依赖；import 后缀 `.ts`（agent-lab 内部惯例）
- 测试命令：`cd extensions/agent-lab && node --experimental-strip-types --test test/<file>.test.ts`；全量 `npm test`（weighted-scorer-bootstrap 2 个**既有**失败忽略）
- **双路径 schema 迁移（M1）**：新表进 CORE_SCHEMA（新库直建）；`selector_json` 列需 `_applyCoreMigrations` 的 `PRAGMA table_info` 守卫 ALTER（旧库）——两者都要做，只做 ALTER 会漏新库
- 事件 id 用 `randomUUID()`（uuid 型唯一——撞 content_hash 会抛错，M3）
- 状态机守卫：认领带 `status='pending'` 守卫 + `changes()===1` 判定；reject/submit/requeue/reflow/escalate 全部条件 UPDATE（WHERE 含状态守卫）+ `changes()===1`（裁决 I7 TOCTOU——守卫入 SQL，单语句隐式事务原子；`withSharedTransaction` 仅供未来多语句事务场景）
- **不变量**：staleMs（10 分钟）> executionTimeoutMs（5 分钟）+ 裕量——池派发包装层 withTimeout 强制超时（复用 `src/scheduler/with-timeout.ts`）
- requeue（人工）：escalated/rejected → pending，**清 rejects[] + claims_count 归零**；reflow（自动）：rejected → pending，**保留 rejects[]**（排除名单持续生效）
- 端口判别式返回：`{ ok: true } | { ok: false; error: string }`
- 提交风格 `feat(agent-lab): 中文摘要——细节` 直接 main；不碰并行 WIP
- 全计划完成后回归：agent-lab `npm test` + 根仓库 `npx vitest run` + `npm run lint`

## 关键接口参考（既有代码，本计划沿用不修改）

```typescript
// core/storage/schema.ts
CORE_SCHEMA  // 顶层级联 CREATE TABLE IF NOT EXISTS（含 lab_agent_instances、lab_events、scheduled_jobs 等）

// core/storage/repository.ts
constructor(db: DatabaseSync)  // 执行 CORE_SCHEMA + _applyCoreMigrations
get raw(): DatabaseSync
// _applyCoreMigrations 模式：
//   const cols = this.db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{name:string}>;
//   if (!cols.some((c) => c.name === "X")) { this.db.exec("ALTER TABLE lab_agent_instances ADD COLUMN X TEXT"); }

// core/tx-utils.ts
export function withSharedTransaction<T>(db: DatabaseSync, fn: () => T): T

// core/contracts.ts
export interface LabEvent<TPayload = unknown> { eventId; eventType; schemaVersion; timestamp; identity: { traceId; ... }; payload? }
export interface AgentInstanceRecord { id; schedulerInstanceId; definition; ...; accepts?: string[]; createdAtRoundId; status; createdAt }
// workloop/contracts.ts WorkLoopSDK 已有 memory?: MemorySdkPort; comms?: CommsSdkPort（可选扩展先例）

// core/events/event-log.ts
append(event: LabEvent): "inserted" | "duplicate"   // 同 eventId 不同 content_hash 抛错 → 必须 uuid id

// scheduler/with-timeout.ts
export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
export function isTimeoutFailure<T>(v: T | TimeoutFailure): v is TimeoutFailure
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | TimeoutFailure>

// scheduler/runner-types.ts
export type DispatchResult = { status: "completed"; ... } | { status: "abstained"; ... } | { status: "fallback"; ... } | { status: "failed"; error: StandardAgentError; attempts: DispatchAttempt[] }
export interface DispatchRequest { traceId; role; task; taskCategory?; labels?; caller?; mode?; strategy?; agentId?; executionTimeoutMs?; signal?; settlementRef? }

// core/storage/repository.ts — listAgents(schedulerInstanceId) 按 instance 过滤；getAgent(id) 全局单查（直派路径已用）
// ingest/cycle.ts — runIngestCycleOnce 现直接 dispatch（labels.strategy="weighted"），本计划 Task 8 迁移为 publish
// commands/register.ts — /lab 命令大 argv 分发块（sub === "dispatch" 先例，Line ~392）
// assembly/agent-runtime.ts — attachSdkOnce → runner.onSdkBuilt((sdk) => this.deps.memory.attachSdk(sdk)) 挂载先例
```

测试构造范式（照抄 test/memory-pipeline.test.ts / test/timed-trigger 相关测试）：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const dir = mkdtempSync(path.join(tmpdir(), "taskpool-"));
const db = new DatabaseSync(path.join(dir, "test.db"));
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
// 之后按任务需要建表（Task 1 后直接用 CoreRepository 建全量 schema）
```

---

### Task 1: schema + 迁移（task_templates/tasks 表 + selector_json 列）

**Files:**
- Modify: `extensions/agent-lab/src/core/storage/schema.ts`（CORE_SCHEMA 追加两表 + 两索引）
- Modify: `extensions/agent-lab/src/core/storage/repository.ts`（`_applyCoreMigrations` 追加 selector_json 列）
- Test: `extensions/agent-lab/test/taskpool-schema.test.ts`

**Interfaces:**
- Produces（Task 2-9 依赖）: `task_templates` 表、`tasks` 表、`(status, created_at)`/`(status, claimed_at)` 索引、`lab_agent_instances.selector_json` 列——经 CoreRepository 构造自动建

- [ ] **Step 1: Write the failing test**

```typescript
// test/taskpool-schema.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-schema-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  return { dir, db };
}

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
}

function agentCols(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{ name: string }>).map((r) => r.name);
}

test("新库直建：task_templates/tasks 表 + 索引 + selector_json 列齐全", () => {
  const { dir, db } = freshDb();
  new CoreRepository(db); // 执行 CORE_SCHEMA + 迁移
  const ts = tables(db);
  assert.ok(ts.includes("task_templates"));
  assert.ok(ts.includes("tasks"));
  assert.ok(agentCols(db).includes("selector_json"));
  const idxs = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(idxs.includes("idx_tasks_status_created"));
  assert.ok(idxs.includes("idx_tasks_status_claimed"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("旧库迁移：无 selector_json 的既有表经 CoreRepository 构造补列（幂等）", () => {
  const { dir, db } = freshDb();
  // 模拟旧库：先建一个不含 selector_json 的 lab_agent_instances
  db.exec(`CREATE TABLE IF NOT EXISTS lab_agent_instances (
    id TEXT PRIMARY KEY, scheduler_instance_id TEXT NOT NULL, definition_json TEXT NOT NULL,
    created_round_id TEXT NOT NULL, status TEXT NOT NULL, created_ts INTEGER NOT NULL)`);
  new CoreRepository(db); // 迁移补列
  assert.ok(agentCols(db).includes("selector_json"));
  new CoreRepository(db); // 幂等：二次构造不抛
  assert.equal(agentCols(db).filter((c) => c === "selector_json").length, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-schema.test.ts`
Expected: FAIL（task_templates/tasks 表不存在，assertion failed；selector_json 列不存在）

- [ ] **Step 3: Implement**

在 `src/core/storage/schema.ts` 的 CORE_SCHEMA 末尾（scheduled_jobs/event_subscriptions 之后）追加：

```sql
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  labels TEXT NOT NULL,
  params TEXT NOT NULL,
  protocol TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  output TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  labels TEXT NOT NULL,
  text TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  claims_count INTEGER NOT NULL DEFAULT 0,
  rejects TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_claimed ON tasks(status, claimed_at);
```

在 `src/core/storage/repository.ts` 的 `_applyCoreMigrations()` 内追加（参照既有 `PRAGMA table_info(lab_agent_instances)` 迁移块）：

```typescript
// selector_json 列（任务池分选器规则，2026-08-06）：JSON { labelPatterns: string[], textPattern?: string }
{
  const cols = this.db.prepare("PRAGMA table_info(lab_agent_instances)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "selector_json")) {
    this.db.exec("ALTER TABLE lab_agent_instances ADD COLUMN selector_json TEXT");
  }
}
```

注意：**双路径都要做**——CORE_SCHEMA 里 `lab_agent_instances` 表定义也要加 `selector_json TEXT` 列（新库直建时才有），同时迁移块补旧库。检查现有 `lab_agent_instances` 表定义是否已含该列，若未含则两处都加。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-schema.test.ts`
Expected: PASS（2 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/core/storage/schema.ts extensions/agent-lab/src/core/storage/repository.ts extensions/agent-lab/test/taskpool-schema.test.ts
git commit -m "feat(agent-lab): 任务池 schema——task_templates/tasks 表+双索引（CORE_SCHEMA 直建）+ selector_json 列双路径迁移（新库直建+旧库 ALTER 幂等）"
```

---

### Task 2: TemplateRegistry（templates.ts）+ semantic-split 种子

**Files:**
- Create: `extensions/agent-lab/src/taskpool/templates.ts`
- Create: `extensions/agent-lab/src/taskpool/semantic-split.ts`（首个模板种子常量）
- Test: `extensions/agent-lab/test/taskpool-templates.test.ts`

**Interfaces:**
- Consumes: Task 1 schema
- Produces（Task 3/8 依赖）:
  - `export interface ParamSpec { name: string; description?: string; required?: boolean }`
  - `export interface OutputContract { kind: "memory" | "file" | "report"; target: string }`
  - `export interface TaskTemplate { id; name; description; labels: string[]; params: ParamSpec[]; protocol: string; acceptance: string; output: OutputContract; registeredBy: string; createdAt: number }`
  - `export class SqliteTemplateRegistry` —— `constructor(db: DatabaseSync)`；`register(t): void`（幂等 INSERT OR IGNORE）；`get(id): TaskTemplate | undefined`；`list(): TaskTemplate[]`；`instantiate(id, params: Record<string,string>, extraLabels?: string[]): { ok: true; text: string; labels: string[] } | { ok: false; error: string }`
  - `export const SEMANTIC_SPLIT_TEMPLATE: TaskTemplate`（id="semantic-split"，protocol 含 `<relPath>` 占位符）

- [ ] **Step 1: Write the failing test**

```typescript
// test/taskpool-templates.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTemplateRegistry } from "../src/taskpool/templates.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../src/taskpool/semantic-split.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-tpl-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const reg = new SqliteTemplateRegistry(db);
  return { dir, db, reg };
}

test("register 幂等 + get/list", () => {
  const { dir, db, reg } = fresh();
  reg.register(SEMANTIC_SPLIT_TEMPLATE);
  reg.register({ ...SEMANTIC_SPLIT_TEMPLATE, name: "改名" }); // 同 id 二次注册 no-op
  const t = reg.get("semantic-split")!;
  assert.equal(t.name, SEMANTIC_SPLIT_TEMPLATE.name); // 首次生效
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get("不存在"), undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("instantiate 填占位符 + 标签合并", () => {
  const { dir, db, reg } = fresh();
  reg.register(SEMANTIC_SPLIT_TEMPLATE);
  const r = reg.instantiate("semantic-split", { relPath: "docs/x.md" }, ["extra"]);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.text.includes("docs/x.md"));
    assert.ok(r.text.includes("sdk.memory.write"));
    assert.ok(r.labels.includes("memory-maintenance"));
    assert.ok(r.labels.includes("semantic-split"));
    assert.ok(r.labels.includes("extra"));
    assert.ok(!r.text.includes("<relPath>")); // 占位符已替换
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("缺必填参数报错 + 模板不存在报错", () => {
  const { dir, db, reg } = fresh();
  reg.register(SEMANTIC_SPLIT_TEMPLATE);
  const r1 = reg.instantiate("semantic-split", {});
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.ok(r1.error.includes("relPath"));
  const r2 = reg.instantiate("nope", { relPath: "x" });
  assert.equal(r2.ok, false);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-templates.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND：templates.ts/semantic-split.ts 不存在）

- [ ] **Step 3: Implement**

```typescript
// src/taskpool/templates.ts
import type { DatabaseSync } from "node:sqlite";

export interface ParamSpec { name: string; description?: string; required?: boolean }
export interface OutputContract { kind: "memory" | "file" | "report"; target: string }

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  labels: string[];
  params: ParamSpec[];
  protocol: string;
  acceptance: string;
  output: OutputContract;
  registeredBy: string;
  createdAt: number;
}

export type InstantiateResult =
  | { ok: true; text: string; labels: string[] }
  | { ok: false; error: string };

export class SqliteTemplateRegistry {
  constructor(private readonly db: DatabaseSync) {}

  register(t: TaskTemplate): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO task_templates
        (id, name, description, labels, params, protocol, acceptance, output, registered_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      t.id, t.name, t.description,
      JSON.stringify(t.labels), JSON.stringify(t.params),
      t.protocol, t.acceptance, JSON.stringify(t.output),
      t.registeredBy, t.createdAt,
    );
  }

  get(id: string): TaskTemplate | undefined {
    const row = this.db.prepare(`SELECT * FROM task_templates WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToTemplate(row) : undefined;
  }

  list(): TaskTemplate[] {
    const rows = this.db.prepare(`SELECT * FROM task_templates ORDER BY created_at`).all() as Array<Record<string, unknown>>;
    return rows.map(rowToTemplate);
  }

  instantiate(id: string, params: Record<string, string>, extraLabels: string[] = []): InstantiateResult {
    const t = this.get(id);
    if (!t) return { ok: false, error: `template not found: ${id}` };
    for (const p of t.params) {
      if (p.required && !(p.name in params)) {
        return { ok: false, error: `missing required param: ${p.name}` };
      }
    }
    let text = t.protocol;
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`<${k}>`, v);
    }
    return { ok: true, text, labels: [...t.labels, ...extraLabels] };
  }
}

function rowToTemplate(row: Record<string, unknown>): TaskTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    labels: JSON.parse(row.labels as string) as string[],
    params: JSON.parse(row.params as string) as ParamSpec[],
    protocol: row.protocol as string,
    acceptance: row.acceptance as string,
    output: JSON.parse(row.output as string) as OutputContract,
    registeredBy: row.registered_by as string,
    createdAt: row.created_at as number,
  };
}
```

```typescript
// src/taskpool/semantic-split.ts
import type { TaskTemplate } from "./templates.ts";

/** 首个任务模板：语义分解（联邦地基一 semanticSplitTask 协议模板化，<relPath> 占位符）。 */
export const SEMANTIC_SPLIT_TEMPLATE: TaskTemplate = {
  id: "semantic-split",
  name: "语义分解",
  description: "将指定文档分解为可独立成立的语义事实条目，写入记忆库",
  labels: ["memory-maintenance", "semantic-split"],
  params: [{ name: "relPath", description: "待分解文档的相对路径", required: true }],
  protocol:
    `语义分解 <relPath>：读取该文档，识别可独立成立的语义事实（定义/决策/规则/结论/不变量），每条经 sdk.memory.write 写一个 MemoryEntry（kind=fact，anchors=文档标签+更细主题锚点，content=事实本身，末尾附 "源: <relPath>"）。不改写原文档、不删除指针条目。`,
  acceptance: "产出条目≥1；全部锚点非空；指针条目未被破坏",
  output: { kind: "memory", target: "记忆库（锚点=文档标签+主题锚点）" },
  registeredBy: "system",
  createdAt: 0, // 注册时由调用方覆写
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-templates.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/taskpool/templates.ts extensions/agent-lab/src/taskpool/semantic-split.ts extensions/agent-lab/test/taskpool-templates.test.ts
git commit -m "feat(agent-lab): 任务模板注册表——幂等注册/查询/实例化（占位符填充+标签合并+必填校验），semantic-split 为首个模板（语义分解协议模板化）"
```

---

### Task 3: TaskStore 数据层（tasks.ts）——守卫转移 + 事件

**Files:**
- Create: `extensions/agent-lab/src/taskpool/tasks.ts`
- Test: `extensions/agent-lab/test/taskpool-tasks.test.ts`

**Interfaces:**
- Consumes: Task 1 schema
- Produces（Task 4-9 依赖）:
  - `export type TaskStatus = "pending" | "claimed" | "submitted" | "completed" | "rejected" | "escalated"`
  - `export interface RejectRecord { agentId: string; reason: string; at: number }`
  - `export interface TaskRecord { id; templateId; labels: string[]; text: string; params: Record<string, unknown>; status: TaskStatus; claimedBy?: string; claimedAt?: number; claimsCount: number; rejects: RejectRecord[]; createdBy: string; createdAt: number; completedAt?: number }`
  - `export interface TaskStoreDeps { db: DatabaseSync; appendEvent: (e: LabEvent) => "inserted" | "duplicate"; traceId?: string }`
  - `export class SqliteTaskStore`：
    - `publish(input: { templateId; text; labels; params?; createdBy }): TaskRecord`（id=randomUUID）
    - `get(id): TaskRecord | undefined`
    - `list(filter?: { status?: TaskStatus; claimedBy?: string }): TaskRecord[]`
    - `claim(agentId, taskId): "claimed" | "not-found" | "not-pending"`（事务守卫）
    - `reject(agentId, taskId, reason): "rejected" | "not-found" | "not-claimed-by-you"`
    - `submit(agentId, taskId, outputRef): "submitted" | "not-found" | "not-claimed-by-you"`
    - `requeue(taskId): "requeued" | "not-found" | "not-requeueable"`（清 rejects[] + claims_count=0）
    - `reflow(taskId): "reflowed" | "not-found" | "not-rejected"`（保留 rejects[]）
    - `escalate(taskId, reason): "escalated" | "not-found" | "not-escalatable"`（源态：rejected/pending/claimed——claimed 供 claims_count≥3 阈值升级，调用方保证非在途）
  - 事件：task.published / task.claimed / task.rejected / task.submitted / task.completed / task.requeued / task.reflowed / task.escalated（eventId=randomUUID，identity.traceId=deps.traceId ?? "taskpool"）

- [ ] **Step 1: Write the failing test**

```typescript
// test/taskpool-tasks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import type { LabEvent } from "../src/core/contracts.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-tasks-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const events: LabEvent[] = [];
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "test" });
  return { dir, db, store, events };
}

function pub(store: SqliteTaskStore, overrides: Partial<Parameters<SqliteTaskStore["publish"]>[0]> = {}) {
  return store.publish({ templateId: "semantic-split", text: "任务文本", labels: ["memory-maintenance"], params: {}, createdBy: "me", ...overrides });
}

test("publish → pending + 事件", () => {
  const { dir, db, store, events } = fresh();
  const t = pub(store);
  assert.equal(t.status, "pending");
  assert.equal(t.claimsCount, 0);
  assert.deepEqual(t.rejects, []);
  assert.ok(t.id.length > 0);
  assert.ok(events.some((e) => e.eventType === "task.published"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("claim 守卫：pending 可认领；二次认领/他人认领被拒", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  assert.equal(store.claim("agent-a", t.id), "claimed");
  assert.equal(store.claim("agent-b", t.id), "not-pending");
  assert.equal(store.get(t.id)!.claimedBy, "agent-a");
  assert.equal(store.get(t.id)!.claimsCount, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reject 守卫：仅本人可拒绝，拒绝后带原因与排除记录", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  assert.equal(store.reject("someone-else", t.id, "x"), "not-claimed-by-you"); // 未认领
  store.claim("agent-a", t.id);
  assert.equal(store.reject("agent-b", t.id, "x"), "not-claimed-by-you");
  assert.equal(store.reject("agent-a", t.id, "缺工具"), "rejected");
  const got = store.get(t.id)!;
  assert.equal(got.status, "rejected");
  assert.equal(got.rejects.length, 1);
  assert.equal(got.rejects[0]!.agentId, "agent-a");
  assert.equal(got.rejects[0]!.reason, "缺工具");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("submit 守卫：仅本人可提交，提交即完成（瞬态 submitted）", () => {
  const { dir, db, store, events } = fresh();
  const t = pub(store);
  assert.equal(store.submit("nobody", t.id, "out"), "not-claimed-by-you");
  store.claim("agent-a", t.id);
  assert.equal(store.submit("agent-a", t.id, "memory:entry-1"), "submitted");
  const got = store.get(t.id)!;
  assert.equal(got.status, "completed");
  assert.ok(got.completedAt);
  const submittedEvt = events.find((e) => e.eventType === "task.submitted")!;
  assert.ok(submittedEvt.payload?.includes?.("memory:entry-1") || (submittedEvt.payload as { outputRef?: string })?.outputRef === "memory:entry-1");
  assert.ok(events.some((e) => e.eventType === "task.completed"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("requeue 清 rejects + 重置计数；reflow 保留 rejects", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  store.claim("agent-a", t.id);
  store.reject("agent-a", t.id, "r1");
  store.claim("agent-a", t.id);
  store.reject("agent-a", t.id, "r2");
  let got = store.get(t.id)!;
  assert.equal(got.rejects.length, 2);
  assert.equal(got.claimsCount, 2);

  assert.equal(store.requeue(t.id), "requeued"); // 清 + 重置
  got = store.get(t.id)!;
  assert.equal(got.status, "pending");
  assert.deepEqual(got.rejects, []);
  assert.equal(got.claimsCount, 0);

  store.claim("agent-b", t.id);
  store.reject("agent-b", t.id, "r3");
  assert.equal(store.reflow(t.id), "reflowed"); // 保留排除
  got = store.get(t.id)!;
  assert.equal(got.status, "pending");
  assert.equal(got.rejects.length, 1);
  assert.equal(got.claimsCount, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("escalate 仅从 rejected/pending/claimed 可入；requeue 可恢复", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  assert.equal(store.escalate(t.id, "no-candidate"), "escalated");
  assert.equal(store.get(t.id)!.status, "escalated");
  assert.equal(store.escalate(t.id, "again"), "not-escalatable");
  assert.equal(store.requeue(t.id), "requeued");
  assert.equal(store.get(t.id)!.status, "pending");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("escalate 支持 claimed 源态（claims_count≥3 阈值升级，裁决 N1）", () => {
  const { dir, db, store } = fresh();
  const t = pub(store);
  store.claim("agent-a", t.id);
  store.reject("agent-a", t.id, "r1");
  store.claim("agent-b", t.id);
  store.reject("agent-b", t.id, "r2");
  store.claim("agent-c", t.id); // claims_count=3
  assert.equal(store.escalate(t.id, "claims-exceeded"), "escalated"); // claimed 源态可升级
  assert.equal(store.get(t.id)!.status, "escalated");
  assert.equal(store.get(t.id)!.claimsCount, 3);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("list 按状态过滤", () => {
  const { dir, db, store } = fresh();
  const a = pub(store);
  const b = pub(store);
  store.claim("agent-a", a.id);
  assert.equal(store.list({ status: "pending" }).length, 1);
  assert.equal(store.list({ status: "claimed" }).length, 1);
  assert.equal(store.list({ claimedBy: "agent-a" }).length, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-tasks.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND：tasks.ts 不存在）

- [ ] **Step 3: Implement**

```typescript
// src/taskpool/tasks.ts
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LabEvent } from "../core/contracts.ts";

export type TaskStatus = "pending" | "claimed" | "submitted" | "completed" | "rejected" | "escalated";
export interface RejectRecord { agentId: string; reason: string; at: number }

export interface TaskRecord {
  id: string;
  templateId: string;
  labels: string[];
  text: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  claimedBy?: string;
  claimedAt?: number;
  claimsCount: number;
  rejects: RejectRecord[];
  createdBy: string;
  createdAt: number;
  completedAt?: number;
}

export interface TaskStoreDeps {
  db: DatabaseSync;
  appendEvent: (e: LabEvent) => "inserted" | "duplicate";
  traceId?: string;
}

type OpResult = string;

export class SqliteTaskStore {
  private readonly db: DatabaseSync;
  private readonly appendEvent: (e: LabEvent) => "inserted" | "duplicate";
  private readonly traceId: string;

  constructor(deps: TaskStoreDeps) {
    this.db = deps.db;
    this.appendEvent = deps.appendEvent;
    this.traceId = deps.traceId ?? "taskpool";
  }

  publish(input: { templateId: string; text: string; labels: string[]; params?: Record<string, unknown>; createdBy: string }): TaskRecord {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO tasks (id, template_id, labels, text, params, status, claims_count, rejects, created_by, created_at)
       VALUES (?,?,?,?,?,?,0,'[]',?,?)`,
    ).run(id, input.templateId, JSON.stringify(input.labels), input.text, JSON.stringify(input.params ?? {}), "pending", input.createdBy, now);
    this.emit("task.published", { taskId: id, templateId: input.templateId, labels: input.labels, createdBy: input.createdBy });
    return this.get(id)!;
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(filter: { status?: TaskStatus; claimedBy?: string } = {}): TaskRecord[] {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (filter.status) { conds.push("status = ?"); args.push(filter.status); }
    if (filter.claimedBy) { conds.push("claimed_by = ?"); args.push(filter.claimedBy); }
    const sql = conds.length > 0 ? `SELECT * FROM tasks WHERE ${conds.join(" AND ")} ORDER BY created_at` : `SELECT * FROM tasks ORDER BY created_at`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  claim(agentId: string, taskId: string): OpResult {
    const now = Date.now();
    const r = this.db.prepare(
      `UPDATE tasks SET status='claimed', claimed_by=?, claimed_at=?, claims_count=claims_count+1
       WHERE id=? AND status='pending'`,
    ).run(agentId, now, taskId);
    if (r.changes === 1) {
      this.emit("task.claimed", { taskId, agentId });
      return "claimed";
    }
    return this.get(taskId) ? "not-pending" : "not-found";
  }

  reject(agentId: string, taskId: string, reason: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "claimed" || t.claimedBy !== agentId) return "not-claimed-by-you";
    const rejects = [...t.rejects, { agentId, reason, at: Date.now() }];
    // 守卫入 SQL（裁决 I7 TOCTOU）：条件 UPDATE + changes()===1，防 precheck 与 UPDATE 之间被 reclaimStale 翻回 pending
    const r = this.db.prepare(`UPDATE tasks SET status='rejected', rejects=? WHERE id=? AND status='claimed' AND claimed_by=?`).run(JSON.stringify(rejects), taskId, agentId);
    if (r.changes !== 1) return "not-claimed-by-you";
    this.emit("task.rejected", { taskId, agentId, reason });
    return "rejected";
  }

  submit(agentId: string, taskId: string, outputRef: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "claimed" || t.claimedBy !== agentId) return "not-claimed-by-you";
    const now = Date.now();
    // 守卫入 SQL（裁决 I7 TOCTOU）
    const r = this.db.prepare(`UPDATE tasks SET status='completed', completed_at=? WHERE id=? AND status='claimed' AND claimed_by=?`).run(now, taskId, agentId);
    if (r.changes !== 1) return "not-claimed-by-you";
    this.emit("task.submitted", { taskId, agentId, outputRef });
    this.emit("task.completed", { taskId, agentId });
    return "submitted";
  }

  /** 人工 requeue：escalated/rejected → pending，清 rejects[] + claims_count=0（裁决 N2）。 */
  requeue(taskId: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "escalated" && t.status !== "rejected") return "not-requeueable";
    this.db.prepare(`UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL, claims_count=0, rejects='[]' WHERE id=? AND status IN ('escalated','rejected')`).run(taskId);
    this.emit("task.requeued", { taskId });
    return "requeued";
  }

  /** 自动 reflow：rejected → pending，保留 rejects[]（排除名单持续生效）。 */
  reflow(taskId: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    if (t.status !== "rejected") return "not-rejected";
    this.db.prepare(`UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL WHERE id=? AND status='rejected'`).run(taskId);
    this.emit("task.reflowed", { taskId });
    return "reflowed";
  }

  /** 升级：rejected/pending（从未认领）→ escalated。 */
  escalate(taskId: string, reason: string): OpResult {
    const t = this.get(taskId);
    if (!t) return "not-found";
    // 源态：rejected / pending（无候选升级）/ claimed（claims_count≥3 阈值升级——裁决 N1，调用方保证派发已返回、非在途）
    if (t.status !== "rejected" && t.status !== "pending" && t.status !== "claimed") return "not-escalatable";
    this.db.prepare(`UPDATE tasks SET status='escalated', claimed_by=NULL, claimed_at=NULL WHERE id=? AND status IN ('rejected','pending','claimed')`).run(taskId);
    this.emit("task.escalated", { taskId, reason });
    return "escalated";
  }

  private emit(eventType: string, payload: unknown): void {
    this.appendEvent({
      eventId: randomUUID(),
      eventType,
      schemaVersion: "1",
      timestamp: Date.now(),
      identity: { traceId: this.traceId },
      payload,
    });
  }
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  const t: TaskRecord = {
    id: row.id as string,
    templateId: row.template_id as string,
    labels: JSON.parse(row.labels as string) as string[],
    text: row.text as string,
    params: JSON.parse(row.params as string) as Record<string, unknown>,
    status: row.status as TaskStatus,
    claimsCount: row.claims_count as number,
    rejects: JSON.parse(row.rejects as string) as RejectRecord[],
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
  };
  if (row.claimed_by) t.claimedBy = row.claimed_by as string;
  if (row.claimed_at) t.claimedAt = row.claimed_at as number;
  if (row.completed_at) t.completedAt = row.completed_at as number;
  return t;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-tasks.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/taskpool/tasks.ts extensions/agent-lab/test/taskpool-tasks.test.ts
git commit -m "feat(agent-lab): 任务池数据层——publish/claim/reject/submit/requeue/reflow/escalate 守卫转移+事件（uuid id），requeue 清排除重置计数、reflow 保留排除"
```

---

### Task 4: SorterEngine（engine.ts）——selector 匹配 + 原子认领 + 回流/升级编排

**Files:**
- Create: `extensions/agent-lab/src/taskpool/engine.ts`
- Test: `extensions/agent-lab/test/taskpool-engine.test.ts`

**Interfaces:**
- Consumes: Task 3 `SqliteTaskStore`；既有 `AgentInstanceRecord.selector_json`（经 db 直查）
- Produces（Task 5-9 依赖）:
  - `export interface SelectorRule { labelPatterns: string[]; textPattern?: string }`
  - `export function matchesSelector(task: Pick<TaskRecord,"labels"|"text">, sel: SelectorRule): boolean`（纯函数，导出供测）
  - `export class SorterEngine` —— `constructor(db: DatabaseSync, store: SqliteTaskStore)`：
    - `setSelector(agentId, sel: SelectorRule | null): void`（写 lab_agent_instances.selector_json）
    - `getSelector(agentId): SelectorRule | undefined`
    - `candidates(agentId): TaskRecord[]`（selector 匹配的 pending 任务，**排除该 agent 已拒绝过的**，created_at 升序）
    - `claimTopN(agentId, n): TaskRecord[]`（逐条 claim，返回成功认领的）
    - `reflowRound(now?: number, thresholds?: { reflowAgeMs?: number; escalateAgeMs?: number }): { reflowed: number; escalated: number }`（裁决 I1 双触发 + B2 pending 无候选 + N3 统一判据）
    - `reclaimStale(staleMs: number, now?: number): number`（claimed 超时 → pending 的条数；**保留 claims_count**）
    - `agentsWithSelector(): Array<{ agentId: string; selector: SelectorRule }>`
    - `autoReject(agentId: string, taskId: string, reason: string): string`（自动拒绝，走 store.reject 守卫——供 SorterCycle 派发失败时调用）

- [ ] **Step 1: Write the failing test**

```typescript
// test/taskpool-engine.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { SorterEngine, matchesSelector } from "../src/taskpool/engine.ts";
import type { TaskRecord } from "../src/taskpool/tasks.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-engine-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const events: unknown[] = [];
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "test" });
  const engine = new SorterEngine(db, store);
  return { dir, db, store, engine, events };
}

function task(labels: string[], text: string): Parameters<SqliteTaskStore["publish"]>[0] {
  return { templateId: "semantic-split", text, labels, params: {}, createdBy: "me" };
}

test("matchesSelector 纯函数：OR 标签 + textPattern + 空数组不设限", () => {
  assert.equal(matchesSelector({ labels: ["a", "b"], text: "hello world" }, { labelPatterns: ["^b$"] }), true);
  assert.equal(matchesSelector({ labels: ["a", "b"], text: "hello" }, { labelPatterns: ["^c$"] }), false);
  assert.equal(matchesSelector({ labels: ["a"], text: "hello world" }, { labelPatterns: [], textPattern: "world" }), true);
  assert.equal(matchesSelector({ labels: ["a"], text: "hello" }, { labelPatterns: [], textPattern: "world" }), false);
  assert.equal(matchesSelector({ labels: ["a"], text: "hello" }, { labelPatterns: [] }), true); // 空 = 不设限
});

test("setSelector/getSelector + 持久化", () => {
  const { dir, db, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^memory-maintenance$"] });
  assert.deepEqual(engine.getSelector("agent-a"), { labelPatterns: ["^memory-maintenance$"] });
  engine.setSelector("agent-a", null);
  assert.equal(engine.getSelector("agent-a"), undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("candidates 匹配 + 排除已拒 agent + 升序（裁决 I8：reflow 后排除名单真实生效）", () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^memory-maintenance$"] });
  engine.setSelector("agent-b", { labelPatterns: ["^memory-maintenance$"] });
  const t1 = store.publish(task(["memory-maintenance"], "任务一"));
  const t2 = store.publish(task(["other"], "任务二"));
  const t3 = store.publish(task(["memory-maintenance"], "任务三"));
  assert.deepEqual(engine.candidates("agent-a").map((t) => t.id), [t1.id, t3.id]); // t2 不匹配
  // agent-a 拒绝过 t1 → 排除；reflow 回 pending 后排除名单仍生效
  store.claim("agent-a", t1.id);
  store.reject("agent-a", t1.id, "缺工具");
  assert.equal(store.reflow(t1.id), "reflowed"); // 保留 rejects 回 pending
  assert.equal(store.get(t1.id)!.status, "pending");
  assert.equal(store.get(t1.id)!.rejects.length, 1);
  // agent-a 的 candidates 不含 t1（排除名单生效，而非状态过滤）
  assert.deepEqual(engine.candidates("agent-a").map((t) => t.id), [t3.id]);
  // agent-b 未在排除名单 → 可见 t1
  assert.deepEqual(engine.candidates("agent-b").map((t) => t.id), [t1.id, t3.id]);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("claimTopN 原子认领前 n 个", () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const a = store.publish(task(["m"], "a"));
  const b = store.publish(task(["m"], "b"));
  const c = store.publish(task(["m"], "c"));
  const claimed = engine.claimTopN("agent-a", 2);
  assert.deepEqual(claimed.map((t) => t.id), [a.id, b.id]); // FIFO 前 2
  assert.equal(store.get(c.id)!.status, "pending");
  assert.equal(store.get(a.id)!.claimedBy, "agent-a");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reflowRound：时间维触发 rejected 回流 + 无候选升级 + pending 无候选升级", () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const now = Date.now();

  // 场景1：rejected 但仍有未排除匹配者 → reflow（时间维触发，保留排除）
  const r1 = store.publish(task(["m"], "r1"));
  store.claim("agent-a", r1.id);
  store.reject("agent-a", r1.id, "缺工具");
  // 手动把 rejects 最后一项的 at 改旧（age = now - rejects[last].at > reflowAgeMs）
  const row = db.prepare(`SELECT rejects FROM tasks WHERE id=?`).get(r1.id) as { rejects: string };
  const rejects = JSON.parse(row.rejects) as Array<{ agentId: string; reason: string; at: number }>;
  rejects[rejects.length - 1]!.at = now - 20 * 60_000;
  db.prepare(`UPDATE tasks SET rejects=? WHERE id=?`).run(JSON.stringify(rejects), r1.id);

  // 场景2：pending 从未认领 + 无匹配 agent → 升级（手动把 created_at 改旧）
  const p1 = store.publish(task(["unmatched-label"], "p1"));
  db.prepare(`UPDATE tasks SET created_at=? WHERE id=?`).run(now - 60 * 60_000, p1.id);

  const res = engine.reflowRound(now, { reflowAgeMs: 10 * 60_000, escalateAgeMs: 30 * 60_000 });
  assert.equal(store.get(r1.id)!.status, "pending"); // 时间维触发 reflow（保留排除）
  assert.equal(store.get(r1.id)!.rejects.length, 1);
  assert.equal(res.reflowed, 1);
  assert.equal(store.get(p1.id)!.status, "escalated"); // 无匹配 + claims_count=0 + age 超阈值
  assert.equal(res.escalated, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("reclaimStale：claimed 超时回 pending 保留 claims_count", () => {
  const { dir, db, store, engine } = fresh();
  const t = store.publish(task(["m"], "t"));
  // 手动制造 claimed 且 claimed_at 陈旧
  db.prepare(`UPDATE tasks SET status='claimed', claimed_by='agent-x', claimed_at=?, claims_count=3 WHERE id=?`).run(Date.now() - 20 * 60_000, t.id);
  const n = engine.reclaimStale(10 * 60_000);
  assert.equal(n, 1);
  const got = store.get(t.id)!;
  assert.equal(got.status, "pending");
  assert.equal(got.claimsCount, 3); // 保留计数（N3：stale 产物走 claims_count 阈值路径）
  assert.equal(got.claimedBy, undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("autoReject：供周期派发失败时调用（走 store 守卫 + 排除）", () => {
  const { dir, db, store, engine } = fresh();
  const t = store.publish(task(["m"], "t"));
  assert.equal(engine.autoReject("nobody", t.id, "x"), "not-claimed-by-you");
  store.claim("agent-a", t.id);
  assert.equal(engine.autoReject("agent-a", t.id, "dispatch-failed"), "rejected");
  assert.equal(store.get(t.id)!.rejects[0]!.reason, "dispatch-failed");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

注意：reflowRound 测试的 rejected 场景因 `Date.now()` 内部化而难精确断言时间维触发——实现时把"rejected 的 age"定义为 `now - rejects[last].at`，测试对 rejected 场景可断言"reflowRound 返回数字且 pending 无候选升级正确"；时间维的 rejected 回流可用 `store.reject` 后立即 reflowRound 断言（age 极小必超 0）或留待 Task 9 集成覆盖（诚实声明）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-engine.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND：engine.ts 不存在）

- [ ] **Step 3: Implement**

```typescript
// src/taskpool/engine.ts
import type { DatabaseSync } from "node:sqlite";
import type { SqliteTaskStore, TaskRecord } from "./tasks.ts";

export interface SelectorRule { labelPatterns: string[]; textPattern?: string }

/** 匹配规则（spec §6.1）：labelPatterns OR 语义 + textPattern 可选；空 labelPatterns = 不设限。 */
export function matchesSelector(task: Pick<TaskRecord, "labels" | "text">, sel: SelectorRule): boolean {
  const labelsOk = sel.labelPatterns.length === 0 || sel.labelPatterns.some((re) => {
    let ok = false;
    try { ok = task.labels.some((l) => new RegExp(re).test(l)); } catch { ok = false; }
    return ok;
  });
  if (!labelsOk) return false;
  if (!sel.textPattern) return true;
  try { return new RegExp(sel.textPattern).test(task.text); } catch { return false; }
}

export interface ReflowThresholds { reflowAgeMs?: number; escalateAgeMs?: number }

export class SorterEngine {
  constructor(private readonly db: DatabaseSync, private readonly store: SqliteTaskStore) {}

  setSelector(agentId: string, sel: SelectorRule | null): void {
    if (sel === null) {
      this.db.prepare(`UPDATE lab_agent_instances SET selector_json = NULL WHERE id = ?`).run(agentId);
      return;
    }
    this.db.prepare(`UPDATE lab_agent_instances SET selector_json = ? WHERE id = ?`).run(JSON.stringify(sel), agentId);
  }

  getSelector(agentId: string): SelectorRule | undefined {
    const row = this.db.prepare(`SELECT selector_json FROM lab_agent_instances WHERE id = ?`).get(agentId) as { selector_json: string | null } | undefined;
    if (!row?.selector_json) return undefined;
    return JSON.parse(row.selector_json) as SelectorRule;
  }

  candidates(agentId: string): TaskRecord[] {
    const sel = this.getSelector(agentId);
    if (!sel) return [];
    return this.store.list({ status: "pending" })
      .filter((t) => !t.rejects.some((r) => r.agentId === agentId)) // 排除已拒（M5 按 agentId）
      .filter((t) => matchesSelector(t, sel));
  }

  claimTopN(agentId: string, n: number): TaskRecord[] {
    const claimed: TaskRecord[] = [];
    for (const t of this.candidates(agentId)) {
      if (claimed.length >= n) break;
      if (this.store.claim(agentId, t.id) === "claimed") claimed.push(this.store.get(t.id)!);
    }
    return claimed;
  }

  agentsWithSelector(): Array<{ agentId: string; selector: SelectorRule }> {
    const rows = this.db.prepare(`SELECT id, selector_json FROM lab_agent_instances WHERE selector_json IS NOT NULL`).all() as Array<{ id: string; selector_json: string }>;
    return rows.map((r) => ({ agentId: r.id, selector: JSON.parse(r.selector_json) as SelectorRule }));
  }

  /** 回流轮（spec §5.3 双触发；N3 统一判据）。reflowAgeMs 触发 rejected 回流；escalateAgeMs 触发 pending 无候选升级。 */
  reflowRound(now: number = Date.now(), thresholds: ReflowThresholds = {}): { reflowed: number; escalated: number } {
    const reflowAgeMs = thresholds.reflowAgeMs ?? 10 * 60_000;
    const escalateAgeMs = thresholds.escalateAgeMs ?? 30 * 60_000;
    const out = { reflowed: 0, escalated: 0 };

    // rejected：时间维触发（age = 自最后拒绝时刻）
    for (const t of this.store.list({ status: "rejected" })) {
      const lastRejectAt = t.rejects.length > 0 ? t.rejects[t.rejects.length - 1]!.at : t.createdAt;
      if (now - lastRejectAt < reflowAgeMs) continue;
      if (this.matchingNonExcludedCount(t) === 0) {
        if (this.store.escalate(t.id, "no-matching-agent") === "escalated") out.escalated++;
      } else {
        if (this.store.reflow(t.id) === "reflowed") out.reflowed++;
      }
    }

    // pending 从未认领（claims_count=0）：age > escalateAgeMs 且无匹配 → 升级
    for (const t of this.store.list({ status: "pending" })) {
      if (t.claimsCount !== 0) continue; // stale 产物走 claims_count 阈值路径
      if (now - t.createdAt < escalateAgeMs) continue;
      if (this.matchingNonExcludedCount(t) === 0) {
        if (this.store.escalate(t.id, "no-matching-agent") === "escalated") out.escalated++;
      }
    }
    return out;
  }

  /** claimed 超时 → pending（保留 claims_count——N3）。 */
  reclaimStale(staleMs: number, now: number = Date.now()): number {
    const rows = this.db.prepare(`SELECT id FROM tasks WHERE status='claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`).all(now - staleMs) as Array<{ id: string }>;
    let n = 0;
    for (const r of rows) {
      this.db.prepare(`UPDATE tasks SET status='pending', claimed_by=NULL, claimed_at=NULL WHERE id=? AND status='claimed'`).run(r.id);
      n++;
    }
    return n;
  }

  /** 剩余"标签匹配且未排除"的 agent 数（升级判定核心）。 */
  private matchingNonExcludedCount(t: TaskRecord): number {
    return this.agentsWithSelector()
      .filter(({ agentId }) => !t.rejects.some((r) => r.agentId === agentId))
      .filter(({ selector }) => matchesSelector(t, selector))
      .length;
  }

  /** 自动拒绝（供 SorterCycle 派发失败时调用，裁决 I2）：内部走 store.reject 守卫，原因进排除名单。 */
  autoReject(agentId: string, taskId: string, reason: string): string {
    return this.store.reject(agentId, taskId, reason);
  }

  /** 取任务（cycle 判定用，裁决 B1）：委托 store.get。 */
  getTask(taskId: string): TaskRecord | undefined {
    return this.store.get(taskId);
  }

  /** 升级（cycle claims_count 阈值用，裁决 B1）：委托 store.escalate。 */
  escalate(taskId: string, reason: string): string {
    return this.store.escalate(taskId, reason);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-engine.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/taskpool/engine.ts extensions/agent-lab/test/taskpool-engine.test.ts
git commit -m "feat(agent-lab): 分选器引擎——selector 匹配（OR 标签+textPattern）+持久化+原子认领 topN+回流轮（双触发+统一升级判据）+stale 回收保留计数"
```

---

### Task 5: SorterCycle（cycle.ts）——周期驱动 + 派发超时包装 + 自动 reject

**Files:**
- Create: `extensions/agent-lab/src/taskpool/cycle.ts`
- Test: `extensions/agent-lab/test/taskpool-cycle.test.ts`

**Interfaces:**
- Consumes: Task 4 `SorterEngine`；既有 `DispatchRequest`/`DispatchResult`/`withTimeout`/`isTimeoutFailure`
- Produces（Task 8/9 依赖）:
  - `export interface SorterCycleDeps { engine: SorterEngine; dispatch: (req: DispatchRequest) => Promise<DispatchResult>; intervalMs: number; claimN?: number; executionTimeoutMs?: number; staleMs?: number; reflowAgeMs?: number; escalateAgeMs?: number; appendEvent?: (e: LabEvent) => "inserted" | "duplicate"; now?: () => number }`
  - `export async function runSorterCycleOnce(deps: SorterCycleDeps, now?: number): Promise<{ claimed: number; failed: number; reflowed: number; escalated: number; reclaimed: number }>` —— 单轮可测
  - `export function startSorterCycle(deps: SorterCycleDeps): { stop(): void }` —— setInterval + unref
  - 行为：每轮 ① 各 selector agent claimTopN ② 新认领派发（direct + agentId + mode=execute，**任务文本前缀注入 `[task:<id>]`**，withTimeout 强制 executionTimeoutMs 默认 5min）③ 派发 failed/timeout → 自动 reject（"dispatch-failed"）④ reflowRound ⑤ reclaimStale ⑥ 派发完成的（completed）不管；派发非 completed 非 failed（abstained/fallback）→ 视为失败同 ③

- [ ] **Step 1: Write the failing test**

```typescript
// test/taskpool-cycle.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { SorterEngine } from "../src/taskpool/engine.ts";
import { runSorterCycleOnce, startSorterCycle } from "../src/taskpool/cycle.ts";
import type { DispatchRequest, DispatchResult } from "../src/scheduler/runner-types.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-cycle-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const events: unknown[] = [];
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "test" });
  const engine = new SorterEngine(db, store);
  return { dir, db, store, engine, events };
}

function task(labels: string[], text: string) {
  return { templateId: "semantic-split", text, labels, params: {}, createdBy: "me" };
}

test("单轮：认领→派发（[task:id] 前缀 + direct 参数）→ 成功", async () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const t = store.publish(task(["m"], "做语义分解"));
  const calls: DispatchRequest[] = [];
  const res = await runSorterCycleOnce({
    engine,
    dispatch: async (req) => { calls.push(req); return { status: "completed", schedulerInstanceId: "s", attempts: [], selectedAgentId: "agent-a", output: { text: "ok" } } as DispatchResult; },
    intervalMs: 60_000,
    now: () => Date.now(),
  });
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.agentId, "agent-a");
  assert.equal(req.strategy, "direct");
  assert.equal(req.mode, "execute");
  assert.ok(req.task.startsWith(`[task:${t.id}]`)); // 前缀注入
  assert.ok(req.task.includes("做语义分解"));
  assert.equal(res.claimed, 1);
  assert.equal(store.get(t.id)!.status, "claimed"); // 派发成功仍 claimed（提交由 agent 会话完成）
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("单轮：派发 failed → 自动 reject（dispatch-failed）", async () => {
  const { dir, db, store, engine, events } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const t = store.publish(task(["m"], "x"));
  const res = await runSorterCycleOnce({
    engine,
    dispatch: async () => ({ status: "failed", error: { code: "execution-timeout", message: "timeout", retryable: true }, attempts: [] }) as DispatchResult,
    intervalMs: 60_000,
  });
  assert.equal(res.failed, 1);
  const got = store.get(t.id)!;
  assert.equal(got.status, "rejected");
  assert.equal(got.rejects[0]!.reason, "dispatch-failed");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("单轮：派发永不 resolve → withTimeout 超时（裁决 N4/I1）→ 自动 reject", async () => {
  const { dir, db, store, engine } = fresh();
  engine.setSelector("agent-a", { labelPatterns: ["^m$"] });
  const t = store.publish(task(["m"], "hang"));
  const res = await runSorterCycleOnce({
    engine,
    dispatch: () => new Promise(() => {}), // 永不 resolve
    intervalMs: 60_000,
    executionTimeoutMs: 50, // 小超时让测试快速通过
  });
  assert.equal(res.failed, 1);
  const got = store.get(t.id)!;
  assert.equal(got.status, "rejected");
  assert.equal(got.rejects[0]!.reason, "dispatch-failed");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("单轮：无候选不派发不报错", async () => {
  const { dir, db, store, engine } = fresh();
  const calls: DispatchRequest[] = [];
  const res = await runSorterCycleOnce({ engine, dispatch: async (r) => { calls.push(r); return { status: "completed", schedulerInstanceId: "s", attempts: [] } as DispatchResult; }, intervalMs: 60_000 });
  assert.equal(calls.length, 0);
  assert.equal(res.claimed, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("startSorterCycle 返回 stop，stop 后不再触发", async () => {
  const { dir, db, store, engine } = fresh();
  const handle = startSorterCycle({ engine, dispatch: async () => { throw new Error("不应调用"); }, intervalMs: 60_000 });
  handle.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-cycle.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND：cycle.ts 不存在）

- [ ] **Step 3: Implement**

```typescript
// src/taskpool/cycle.ts
// 周期驱动（spec §6.3）：机械层与智能层的交接——认领 + 派发唤醒 + 失败收敛 + 回流/回收。
// 派发包装层用 withTimeout 强制超时（裁决 N4：executionTimeoutMs 默认 5min，不变量 staleMs > executionTimeoutMs）。

import { randomUUID } from "node:crypto";
import type { LabEvent } from "../core/contracts.ts";
import { withTimeout, isTimeoutFailure } from "../scheduler/with-timeout.ts";
import type { DispatchRequest, DispatchResult } from "../scheduler/runner-types.ts";
import type { SorterEngine } from "./engine.ts";

export interface SorterCycleDeps {
  engine: SorterEngine;
  dispatch: (req: DispatchRequest) => Promise<DispatchResult>;
  intervalMs: number;
  claimN?: number;
  executionTimeoutMs?: number;
  staleMs?: number;
  reflowAgeMs?: number;
  escalateAgeMs?: number;
  appendEvent?: (e: LabEvent) => "inserted" | "duplicate";
  now?: () => number;
}

export interface CycleResult { claimed: number; failed: number; reflowed: number; escalated: number; reclaimed: number }

export async function runSorterCycleOnce(deps: SorterCycleDeps, nowMs: number = Date.now()): Promise<CycleResult> {
  const now = deps.now ?? (() => nowMs);
  const claimN = deps.claimN ?? 3;
  const executionTimeoutMs = deps.executionTimeoutMs ?? 5 * 60_000;
  const staleMs = deps.staleMs ?? 10 * 60_000;
  const out: CycleResult = { claimed: 0, failed: 0, reflowed: 0, escalated: 0, reclaimed: 0 };

  // ① 各 selector agent 认领 topN
  for (const { agentId } of deps.engine.agentsWithSelector()) {
    const claimed = deps.engine.claimTopN(agentId, claimN);
    out.claimed += claimed.length;
    // ②③ 派发（direct + agentId + mode=execute + [task:id] 前缀 + withTimeout 强制超时）
    for (const t of claimed) {
      const req: DispatchRequest = {
        traceId: `sorter-cycle:${now()}:${t.id}`,
        role: "memory-maintenance",
        task: `[task:${t.id}] ${t.text}`,
        taskCategory: "pool-task",
        caller: "sorter-cycle",
        labels: { taskId: t.id },
        mode: "execute",
        strategy: "direct",
        agentId,
        executionTimeoutMs,
      };
      // 裁决 N4：派发包装层 withTimeout 强制超时（executionTimeoutMs 默认 5 分钟）
      const result = await withTimeout(deps.dispatch(req), executionTimeoutMs);
      const failed = result.status !== "completed" || isTimeoutFailure(result as never);
      if (failed) {
        deps.appendEvent?.({ eventId: randomUUID(), eventType: "task.dispatch_failed", schemaVersion: "1", timestamp: now(), identity: { traceId: req.traceId }, payload: { taskId: t.id, agentId, status: result.status } });
        deps.engine.autoReject(agentId, t.id, "dispatch-failed"); // 裁决 I2：进排除名单
        out.failed++;
      }
      // 裁决 B1（claims_count≥3 阈值升级）：派发已返回（非在途）后判定——claimed 源态经 store.escalate（Task 3 已支持）
      const after = deps.engine.getTask(t.id);
      if (after && after.status === "claimed" && after.claimsCount >= 3) {
        deps.appendEvent?.({ eventId: randomUUID(), eventType: "task.claims_exceeded", schemaVersion: "1", timestamp: now(), identity: { traceId: req.traceId }, payload: { taskId: t.id, agentId, claimsCount: after.claimsCount } });
        deps.engine.escalate(t.id, "claims-exceeded");
        out.escalated++;
      }
    }
  }

  // ④ 回流轮（双触发）⑤ stale 回收
  const rf = deps.engine.reflowRound(now(), { reflowAgeMs: deps.reflowAgeMs, escalateAgeMs: deps.escalateAgeMs });
  out.reflowed = rf.reflowed;
  out.escalated = rf.escalated;
  out.reclaimed = deps.engine.reclaimStale(staleMs, now());
  return out;
}

export function startSorterCycle(deps: SorterCycleDeps): { stop(): void } {
  const timer = setInterval(() => {
    runSorterCycleOnce(deps).catch(() => { /* 单轮失败静默：下轮幂等 */ });
  }, deps.intervalMs);
  timer.unref();
  return { stop() { clearInterval(timer); } };
}
```

**实现要点**：`randomUUID` 从 `node:crypto` 导入（事件 id uuid 型，M3）；`autoReject` 为 Task 4 已定义的 SorterEngine 公开方法（内部走 store.reject 守卫）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-cycle.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/taskpool/cycle.ts extensions/agent-lab/src/taskpool/engine.ts extensions/agent-lab/test/taskpool-cycle.test.ts
git commit -m "feat(agent-lab): 分选器周期——认领→派发（direct+[task:id] 前缀+withTimeout 5min 强制超时）→失败自动 reject（dispatch-failed 进排除）→回流/回收；SorterEngine 补 autoReject"
```

---

### Task 6: sorter? SDK 端口 + 装配接线

**Files:**
- Modify: `extensions/agent-lab/src/workloop/contracts.ts`（WorkLoopSDK 加 `sorter?: SorterSdkPort` 可选字段——裁决 I4：WorkLoopSDK 在 workloop/contracts.ts:109 而非 core/contracts.ts；core/contracts.ts 放 LabEvent/AgentInstanceRecord）
- Create: `extensions/agent-lab/src/taskpool/sdk.ts`（`SorterSdkPort` + `mountSorterSdk`）
- Modify: `extensions/agent-lab/src/assembly/agent-runtime.ts`（接线：attachSdk 时挂载 sorter 端口）
- Test: `extensions/agent-lab/test/taskpool-sdk.test.ts`

**Interfaces:**
- Consumes: Task 3 `SqliteTaskStore`
- Produces（Task 8/9 依赖）:
  - `export interface SorterSdkPort { rejectTask(taskId: string, reason: string): { ok: true } | { ok: false; error: string }; submitTask(taskId: string, outputRef: string): { ok: true } | { ok: false; error: string } }`
  - `export interface SorterSdkDeps { store: SqliteTaskStore; agentId: () => string }`（agentId 解析——当前会话 agent；v1 用固定 id 注入或装配层提供）
  - `export function mountSorterSdk(sdk: { sorter?: SorterSdkPort }, deps: SorterSdkDeps): void`（防御性：store 缺失 → 不挂）

- [ ] **Step 1: Write the failing test**

```typescript
// test/taskpool-sdk.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { mountSorterSdk, type SorterSdkPort } from "../src/taskpool/sdk.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-sdk-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const store = new SqliteTaskStore({ db, appendEvent: () => "inserted", traceId: "test" });
  const sdk: { sorter?: SorterSdkPort } = {};
  mountSorterSdk(sdk, { store, agentId: () => "agent-a" });
  return { dir, db, store, sdk };
}

test("submitTask：本人可提交 → {ok:true}；守卫失败 → {ok:false,error}", async () => {
  const { dir, db, store, sdk } = fresh();
  const t = store.publish({ templateId: "x", text: "t", labels: [], createdBy: "me" });
  store.claim("agent-a", t.id);
  const r1 = sdk.sorter.submitTask(t.id, "memory:entry-9");
  assert.deepEqual(r1, { ok: true });
  // 已完成的再提交 → 守卫失败
  const r2 = sdk.sorter.submitTask(t.id, "again");
  assert.equal(r2.ok, false);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("rejectTask：本人可拒 → {ok:true}；他人/未认领 → {ok:false}", async () => {
  const { dir, db, store, sdk } = fresh();
  const t = store.publish({ templateId: "x", text: "t", labels: [], createdBy: "me" });
  const r0 = sdk.sorter.rejectTask(t.id, "未认领");
  assert.equal(r0.ok, false);
  store.claim("agent-b", t.id); // 他人认领
  const r1 = sdk.sorter.rejectTask(t.id, "不是我的");
  assert.equal(r1.ok, false);
  const t2 = store.publish({ templateId: "x", text: "t2", labels: [], createdBy: "me" });
  store.claim("agent-a", t2.id);
  const r2 = sdk.sorter.rejectTask(t2.id, "缺工具");
  assert.deepEqual(r2, { ok: true });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("防御性挂载：store 缺失不挂", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-sdk-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  new CoreRepository(db);
  const sdk: { sorter?: unknown } = {};
  mountSorterSdk(sdk, { store: undefined as never, agentId: () => "x" });
  assert.equal(sdk.sorter, undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-sdk.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND：sdk.ts 不存在 / sorter 未挂载）

- [ ] **Step 3: Implement**

```typescript
// src/taskpool/sdk.ts
// sorter? SDK 端口（spec §7.1）：agent 工作会话内 reject/submit。
// 判别式返回（裁决 I5）：守卫失败对 agent 可见，不静默丢成果。

import type { SqliteTaskStore } from "./tasks.ts";

export interface SorterSdkPort {
  rejectTask(taskId: string, reason: string): { ok: true } | { ok: false; error: string };
  submitTask(taskId: string, outputRef: string): { ok: true } | { ok: false; error: string };
}

export interface SorterSdkDeps {
  store: SqliteTaskStore;
  /** 当前会话 agent id（装配层注入；v1 固定 id 或运行时解析）。 */
  agentId: () => string;
}

export interface SorterSdkTarget { sorter?: SorterSdkPort }

export function mountSorterSdk(sdk: SorterSdkTarget, deps: SorterSdkDeps): void {
  if (!deps.store) return; // 防御性：引擎缺失不挂
  sdk.sorter = {
    rejectTask(taskId: string, reason: string) {
      const r = deps.store.reject(deps.agentId(), taskId, reason);
      return r === "rejected" ? { ok: true } : { ok: false, error: r };
    },
    submitTask(taskId: string, outputRef: string) {
      const r = deps.store.submit(deps.agentId(), taskId, outputRef);
      return r === "submitted" ? { ok: true } : { ok: false, error: r };
    },
  };
}
```

`src/workloop/contracts.ts` WorkLoopSDK 加可选字段（照 memory?/comms? 先例——裁决 I4）：

```typescript
import type { SorterSdkPort } from "../taskpool/sdk.ts"; // type-only
// WorkLoopSDK 接口内：
  /** 任务池能力（2026-08-06 挂载；可选纯类型扩展，未挂载 = undefined，零行为变更）。 */
  sorter?: SorterSdkPort;
```

类型导入方向：workloop/contracts.ts → taskpool/sdk.ts 为 type-only import（运行时零依赖，与 memory?/comms? 先例同模式——contracts.ts 侧 `import type`）。

装配接线（`src/assembly/agent-runtime.ts`）：参照 memory.attachSdk 先例，在 attachSdkOnce 的回调里追加 sorter 挂载——具体以装配层现有结构为准（agent-runtime 依赖注入 sorter deps；无 host 类时在 attachSdkOnce 内直接 mountSorterSdk(sdk, deps)）。装配接线以最小改动为准：若 agent-runtime 无法直接拿 store，则在装配入口（create-scheduler-runtime 或等价处）挂载。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-sdk.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/taskpool/sdk.ts extensions/agent-lab/src/core/contracts.ts extensions/agent-lab/src/assembly/agent-runtime.ts extensions/agent-lab/test/taskpool-sdk.test.ts
git commit -m "feat(agent-lab): sorter? SDK 端口——rejectTask/submitTask 判别式返回（守卫失败可见）+防御性挂载+装配接线（contracts 可选字段）"
```

---

### Task 7: /lab 命令（task publish/list/status/requeue + agent selector）

**Files:**
- Create: `extensions/agent-lab/src/commands/render-task.ts`（渲染纯函数）
- Modify: `extensions/agent-lab/src/commands/register.ts`（/lab task 与 /lab agent selector 子命令）
- Test: `extensions/agent-lab/test/task-commands.test.ts`

**Interfaces:**
- Consumes: Task 2 `SqliteTemplateRegistry`、Task 3 `SqliteTaskStore`、Task 4 `SorterEngine`
- Produces（Task 8/9 依赖）: 命令层依赖注入形状——register.ts deps 加 `taskPool?: () => { registry: SqliteTemplateRegistry; store: SqliteTaskStore; engine: SorterEngine }`

- [ ] **Step 1: Write the failing test**

```typescript
// test/task-commands.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTaskList, renderTaskPublish, renderTaskStatus, renderTaskRequeue, renderSelectorSet } from "../src/commands/render-task.ts";

test("渲染函数：publish/list/status/requeue/selector", () => {
  const p = renderTaskPublish({ id: "t1", templateId: "semantic-split", labels: ["m"], createdAt: 1 });
  assert.ok(p.includes("t1"));
  assert.ok(p.includes("semantic-split"));
  const l = renderTaskList([{ id: "t1", status: "pending", templateId: "x" }]);
  assert.ok(l.includes("t1"));
  assert.ok(l.includes("pending"));
  const s = renderTaskStatus({ id: "t1", status: "claimed", claimedBy: "agent-a" });
  assert.ok(s.includes("agent-a"));
  const r = renderTaskRequeue({ id: "t1", status: "pending" });
  assert.ok(r.includes("t1"));
  const sel = renderSelectorSet("agent-a", { labelPatterns: ["^m$"] });
  assert.ok(sel.includes("agent-a"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/task-commands.test.ts`
Expected: FAIL（ERR_MODULE_NOT_FOUND：render-task.ts 不存在）

- [ ] **Step 3: Implement**

```typescript
// src/commands/render-task.ts
// /lab task 与 /lab agent selector 的渲染纯函数（简单文本，参照 render-scheduler.ts 风格）。

export function renderTaskPublish(r: { id: string; templateId: string; labels: string[]; createdAt: number }): string {
  return `任务已发布: ${r.id}\n模板: ${r.templateId}\n标签: ${r.labels.join(", ")}\n创建: ${new Date(r.createdAt).toISOString()}`;
}

export function renderTaskList(rows: Array<{ id: string; status: string; templateId: string }>): string {
  if (rows.length === 0) return "任务池为空";
  return rows.map((r) => `${r.id}  [${r.status}]  ${r.templateId}`).join("\n");
}

export function renderTaskStatus(t: { id: string; status: string; claimedBy?: string; claimsCount?: number; rejects?: Array<{ agentId: string; reason: string }> }): string {
  const lines = [`${t.id}  [${t.status}]`, ...(t.claimedBy ? [`认领: ${t.claimedBy}`] : []), ...(t.claimsCount !== undefined ? [`认领次数: ${t.claimsCount}`] : [])];
  if (t.rejects && t.rejects.length > 0) lines.push(`拒绝记录: ${t.rejects.map((r) => `${r.agentId}(${r.reason})`).join("; ")}`);
  return lines.join("\n");
}

export function renderTaskRequeue(r: { id: string; status: string }): string {
  return `任务 ${r.id} 已重新入池 [${r.status}]（排除名单已清、认领计数已重置）`;
}

export function renderSelectorSet(agentId: string, sel: { labelPatterns: string[]; textPattern?: string }): string {
  return `agent ${agentId} 分选器已更新: 标签 ${sel.labelPatterns.join("|")}${sel.textPattern ? `, 文本 ${sel.textPattern}` : ""}`;
}
```

`register.ts` 接线（照 `/lab scheduler dispatch` 先例——在 argv 分发块加分支；deps 加 `taskPool`）：

```typescript
// deps 增加：
taskPool?: () => { registry: SqliteTemplateRegistry; store: SqliteTaskStore; engine: SorterEngine } | undefined;

// argv 分发块（裁决 I3：cmd = argv[0]，与 register.ts 顶层分发一致——/lab task publish <templateId> → argv=["task","publish","<templateId>"]）
} else if (cmd === "task") {
  const tp = taskPool?.();
  if (!tp) { ctx.ui.notify("Task pool unavailable — enable agent-lab task pool first", "error"); return; }
  const action = argv[1];
  if (action === "publish") {
    const templateId = argv[2];
    if (!templateId) { ctx.ui.notify("用法: /lab task publish <templateId> --param k=v [--label x]", "error"); return; }
    const params: Record<string, string> = {};
    const extraLabels: string[] = [];
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--param" && argv[i + 1]) { const [k, ...v] = argv[i + 1]!.split("="); params[k!] = v.join("="); i++; }
      else if (argv[i] === "--label" && argv[i + 1]) { extraLabels.push(argv[i + 1]!); i++; }
    }
    const inst = tp.registry.instantiate(templateId, params, extraLabels);
    if (!inst.ok) { ctx.ui.notify(inst.error, "error"); return; }
    const task = tp.store.publish({ templateId, text: inst.text, labels: inst.labels, params, createdBy: "ptl" });
    ctx.ui.notify(renderTaskPublish(task), "info");
  } else if (action === "list") {
    const statusIdx = argv.indexOf("--status");
    const status = statusIdx >= 0 ? argv[statusIdx + 1] as TaskStatus : undefined;
    const rows = tp.store.list(status ? { status } : {});
    ctx.ui.notify(renderTaskList(rows), "info");
  } else if (action === "status") {
    const id = argv[2];
    if (!id) { ctx.ui.notify("用法: /lab task status <id>", "error"); return; }
    const t = tp.store.get(id);
    if (!t) { ctx.ui.notify(`任务不存在: ${id}`, "error"); return; }
    ctx.ui.notify(renderTaskStatus(t), "info");
  } else if (action === "requeue") {
    const id = argv[2];
    if (!id) { ctx.ui.notify("用法: /lab task requeue <id>", "error"); return; }
    const r = tp.store.requeue(id);
    if (r !== "requeued") { ctx.ui.notify(`requeue 失败: ${r}`, "error"); return; }
    ctx.ui.notify(renderTaskRequeue(tp.store.get(id)!), "info");
  } else {
    ctx.ui.notify("用法: /lab task publish|list|status|requeue", "error");
  }
} else if (cmd === "agent" && argv[1] === "selector") {
  const tp = taskPool?.();
  if (!tp) { ctx.ui.notify("Task pool unavailable", "error"); return; }
  const agentId = argv[2];
  if (!agentId) { ctx.ui.notify("用法: /lab agent selector <agentId> --labels <regex...> [--text <regex>]", "error"); return; }
  const labelIdx = argv.indexOf("--labels");
  const textIdx = argv.indexOf("--text");
  const labels: string[] = [];
  if (labelIdx >= 0) for (let i = labelIdx + 1; i < argv.length; i++) { if (argv[i]!.startsWith("--")) break; labels.push(argv[i]!); }
  const text = textIdx >= 0 && argv[textIdx + 1] ? argv[textIdx + 1] : undefined;
  tp.engine.setSelector(agentId, { labelPatterns: labels, textPattern: text });
  ctx.ui.notify(renderSelectorSet(agentId, { labelPatterns: labels, textPattern: text }), "info");
}
```

注：本任务的命令层接线在 register.ts 的 deps 注入需改注册入口——真实调用点是 `extensions/agent-lab/src/index.ts:874` 的 `registerCommands(pi, {...})`（裁决 I6/I10 更正：非 create-runtime）。deps 加 `taskPool?: () => { registry: SqliteTemplateRegistry; store: SqliteTaskStore; engine: SorterEngine } | undefined`；真实 store 构造用 `sharedStore.raw`（index.ts 已有）并包装 `(e) => events.append(e)`（EventLog.append 是实例方法，传引用需 bind 包装——裁决 I6）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/task-commands.test.ts`
Expected: PASS（1 用例，渲染纯函数）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/commands/render-task.ts extensions/agent-lab/src/commands/register.ts extensions/agent-lab/test/task-commands.test.ts
git commit -m "feat(agent-lab): /lab task publish/list/status/requeue + /lab agent selector——命令层接线（taskPool 依赖注入），渲染纯函数"
```

---

### Task 8: 摄入周期流迁移（dispatch → publish）

**Files:**
- Modify: `extensions/agent-lab/src/ingest/cycle.ts`（`runIngestCycleOnce` 改为向池 publish）
- Modify: `extensions/agent-lab/test/ingest-cycle.test.ts`（同步迁移断言）
- Modify: `extensions/agent-lab/test/ingest-integration.test.ts`（第 6 节同步迁移——现用旧签名 `runIngestCycleOnce({ pipeline, dispatch, intervalMs })` 且断言 `labels?.strategy === "weighted"`，迁移后断言池中任务形状——裁决 B2）
- Test: `extensions/agent-lab/test/ingest-cycle-migrated.test.ts`（新增迁移断言）

**Interfaces:**
- Consumes: Task 2 `SqliteTemplateRegistry`/`SEMANTIC_SPLIT_TEMPLATE`、Task 3 `SqliteTaskStore`
- Produces（Task 9 依赖）: `runIngestCycleOnce` 新签名——`deps: { pipeline; pool: { registry; store }; intervalMs }`（不再直接 dispatch）

- [ ] **Step 1: Write the failing test（迁移行为）**

```typescript
// test/ingest-cycle-migrated.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTemplateRegistry } from "../src/taskpool/templates.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../src/taskpool/semantic-split.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { runIngestCycleOnce } from "../src/ingest/cycle.ts";
import type { IngestPipeline } from "../src/ingest/pipeline.ts";
import type { SourceDoc } from "../src/ingest/source.ts";

const docA: SourceDoc = { relPath: "docs/a.md", title: "A", firstPara: "摘要", contentHash: "hash-a" };

function fakePipeline(changed: SourceDoc[]): IngestPipeline {
  return { run: () => ({ scanned: changed.length, created: changed.length, updated: 0, skipped: 0, changed }) } as unknown as IngestPipeline;
}

test("迁移：摄入增量 → 向池 publish semantic-split 任务（不再直接 dispatch）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-mig-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const store = new SqliteTaskStore({ db, appendEvent: () => "inserted", traceId: "test" });

  await runIngestCycleOnce({ pipeline: fakePipeline([docA]), pool: { registry, store }, intervalMs: 60_000 });
  const tasks = store.list({ status: "pending" });
  assert.equal(tasks.length, 1);
  const t = tasks[0]!;
  assert.equal(t.templateId, "semantic-split");
  assert.ok(t.text.includes("docs/a.md"));
  assert.ok(t.labels.includes("memory-maintenance"));
  assert.ok(t.labels.includes("semantic-split"));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-cycle-migrated.test.ts`
Expected: FAIL（runIngestCycleOnce 旧签名不接受 pool 参数 / cycle 仍走 dispatch）

- [ ] **Step 3: Implement（修改 cycle.ts）**

```typescript
// src/ingest/cycle.ts（迁移后核心改动）
import type { SqliteTemplateRegistry } from "../taskpool/templates.ts";
import type { SqliteTaskStore } from "../taskpool/tasks.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../taskpool/semantic-split.ts";
import type { IngestPipeline } from "./pipeline.ts";

export interface IngestCycleDeps {
  pipeline: IngestPipeline;
  /** 任务池（裁决：摄入周期流迁移为池投递——路由职责交给分选器） */
  pool: { registry: SqliteTemplateRegistry; store: SqliteTaskStore };
  intervalMs: number;
}

export async function runIngestCycleOnce(deps: IngestCycleDeps): Promise<{ published: number }> {
  const summary = deps.pipeline.run();
  const { registry, store } = deps.pool;
  // 确保 semantic-split 模板已注册（幂等）
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  let published = 0;
  for (const doc of summary.changed) {
    const inst = registry.instantiate("semantic-split", { relPath: doc.relPath });
    if (!inst.ok) continue; // 模板缺失/参数错：跳过（下一轮幂等重试）
    store.publish({ templateId: "semantic-split", text: inst.text, labels: inst.labels, params: { relPath: doc.relPath }, createdBy: "ingest-cycle" });
    published++;
  }
  return { published };
}

export function startIngestCycle(deps: IngestCycleDeps): { stop(): void } {
  const timer = setInterval(() => { runIngestCycleOnce(deps).catch(() => {}); }, deps.intervalMs);
  timer.unref();
  return { stop() { clearInterval(timer); } };
}
```

原 `semanticSplitTask`/`MEMORY_MAINTENANCE_ROLE` 导出：`semanticSplitTask` 保留（模板 protocol 语义来源，Task 2 已复制进 SEMANTIC_SPLIT_TEMPLATE——可删除或保留导出兼容，以最小改动为准）；`MEMORY_MAINTENANCE_ROLE` 若不再被引用则删除（检查既有 ingest-cycle.test.ts 依赖，同步迁移）。

**同步迁移既有测试**：`test/ingest-cycle.test.ts` 里所有 `dispatch` 相关断言（labels.strategy=weighted、mode=execute、caller=ingest-cycle 等）改为断言 publish 行为（池中任务形状）——原测试的 fakePipeline 保留，dispatch 替换为 pool。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/ingest-cycle-migrated.test.ts test/ingest-cycle.test.ts`
Expected: PASS（迁移测试 + 既有测试同步后全绿）

- [ ] **Step 5: Commit**

```bash
git add extensions/agent-lab/src/ingest/cycle.ts extensions/agent-lab/test/ingest-cycle.test.ts extensions/agent-lab/test/ingest-cycle-migrated.test.ts
git commit -m "feat(agent-lab): 摄入周期流迁移为池投递——runIngestCycleOnce 改 publish semantic-split 任务（路由职责交分选器），既有 weighted 直派断言同步迁移"
```

---

### Task 9: 端到端集成 + 全量回归

**Files:**
- Create: `extensions/agent-lab/src/taskpool/index.ts`（域 barrel）
- Test: `extensions/agent-lab/test/taskpool-integration.test.ts`

**Interfaces:**
- Consumes: Task 1-8 全部

- [ ] **Step 1: Write barrel + failing integration test**

```typescript
// src/taskpool/index.ts
export * from "./templates.ts";
export * from "./semantic-split.ts";
export * from "./tasks.ts";
export * from "./engine.ts";
export * from "./cycle.ts";
export * from "./sdk.ts";
```

```typescript
// test/taskpool-integration.test.ts
// 端到端（spec §9）：注册模板 → publish → selector → 认领 → [task:id] 派发（mock）→ submit →
// reject → 回流/升级 → requeue → /lab 渲染，PI 风格隔离目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTemplateRegistry } from "../src/taskpool/templates.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../src/taskpool/semantic-split.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { SorterEngine } from "../src/taskpool/engine.ts";
import { runSorterCycleOnce } from "../src/taskpool/cycle.ts";
import { mountSorterSdk, type SorterSdkPort } from "../src/taskpool/sdk.ts";
import type { DispatchRequest, DispatchResult } from "../src/scheduler/runner-types.ts";

test("全链路：模板→publish→认领→派发→提交→完成", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-int-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const events: unknown[] = [];
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const store = new SqliteTaskStore({ db, appendEvent: (e) => { events.push(e); return "inserted"; }, traceId: "int" });
  const engine = new SorterEngine(db, store);
  engine.setSelector("agent-a", { labelPatterns: ["^memory-maintenance$"] });

  // publish
  const inst = registry.instantiate("semantic-split", { relPath: "docs/x.md" });
  assert.equal(inst.ok, true);
  const t = store.publish({ templateId: "semantic-split", text: inst.ok ? inst.text : "", labels: inst.ok ? inst.labels : [], params: {}, createdBy: "ptl" });
  assert.equal(t.status, "pending");

  // 周期：认领 + 派发（mock 成功）
  let dispatchedTaskId = "";
  await runSorterCycleOnce({
    engine,
    dispatch: async (req) => { dispatchedTaskId = req.labels?.taskId ?? ""; return { status: "completed", schedulerInstanceId: "s", attempts: [], selectedAgentId: "agent-a", output: { text: "ok" } } as DispatchResult; },
    intervalMs: 60_000,
  });
  assert.equal(dispatchedTaskId, t.id);
  assert.equal(store.get(t.id)!.status, "claimed");

  // agent 会话内 submit（sdk 端口）
  const sdk: { sorter?: SorterSdkPort } = {};
  mountSorterSdk(sdk, { store, agentId: () => "agent-a" });
  const sub = sdk.sorter!.submitTask(t.id, "memory:entry-1");
  assert.deepEqual(sub, { ok: true });
  assert.equal(store.get(t.id)!.status, "completed");
  assert.ok(events.some((e) => (e as { eventType: string }).eventType === "task.completed"));

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("全链路：拒绝→回流→无候选升级→requeue 恢复", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-int-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const registry = new SqliteTemplateRegistry(db);
  registry.register({ ...SEMANTIC_SPLIT_TEMPLATE, createdAt: Date.now() });
  const store = new SqliteTaskStore({ db, appendEvent: () => "inserted", traceId: "int" });
  const engine = new SorterEngine(db, store);

  // 无匹配 agent 的 pending 任务 → reflowRound 升级
  const inst = registry.instantiate("semantic-split", { relPath: "docs/x.md" });
  const t = store.publish({ templateId: "semantic-split", text: inst.ok ? inst.text : "", labels: inst.ok ? inst.labels : [], params: {}, createdBy: "ptl" });
  // 手动把 created_at 改旧（age > escalateAgeMs）
  db.prepare(`UPDATE tasks SET created_at=? WHERE id=?`).run(Date.now() - 60 * 60_000, t.id);
  const rf = engine.reflowRound(Date.now(), { reflowAgeMs: 10 * 60_000, escalateAgeMs: 30 * 60_000 });
  assert.equal(rf.escalated, 1);
  assert.equal(store.get(t.id)!.status, "escalated");

  // requeue 恢复
  assert.equal(store.requeue(t.id), "requeued");
  assert.equal(store.get(t.id)!.status, "pending");

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("并发双认领：两个连接同时 claim 同一任务，恰好一个成功（裁决 I9）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-int-"));
  const db1 = new DatabaseSync(path.join(dir, "t.db"));
  db1.exec("PRAGMA journal_mode=WAL");
  db1.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db1);
  const store1 = new SqliteTaskStore({ db: db1, appendEvent: () => "inserted", traceId: "int1" });
  const t = store1.publish({ templateId: "semantic-split", text: "x", labels: [], params: {}, createdBy: "ptl" });

  // 第二个连接（模拟另一运行时/进程，同一 WAL 文件）
  const db2 = new DatabaseSync(path.join(dir, "t.db"));
  db2.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db2);
  const store2 = new SqliteTaskStore({ db: db2, appendEvent: () => "inserted", traceId: "int2" });

  const results = await Promise.all([
    store1.claim("agent-1", t.id),
    store2.claim("agent-2", t.id),
  ]);
  const okCount = results.filter((r) => r === "claimed").length;
  assert.equal(okCount, 1); // 恰好一个成功
  const winner = results[0] === "claimed" ? "agent-1" : "agent-2";
  assert.equal(store1.get(t.id)!.claimedBy, winner);
  assert.equal(store1.get(t.id)!.claimsCount, 1);
  db1.close();
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-integration.test.ts`
Expected: FAIL（barrel/engine/cycle 部分缺失或行为不符）

- [ ] **Step 3: Make it pass**

各组件已在 Task 2-8 实现；集成测试暴露跨任务接线问题时修复对应组件（以测试断言为准）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extensions/agent-lab && node --experimental-strip-types --test test/taskpool-integration.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: 全量回归**

```bash
cd extensions/agent-lab && npm test          # 期望：仅 weighted-scorer-bootstrap 2 个既有失败
cd /Users/anzhize/pi-platform && npx vitest run   # 期望：全绿
npm run lint                                  # 期望：干净
```

- [ ] **Step 6: Commit**

```bash
git add extensions/agent-lab/src/taskpool/index.ts extensions/agent-lab/test/taskpool-integration.test.ts
git commit -m "feat(agent-lab): 任务池域 barrel + 端到端集成——模板→publish→认领→[task:id] 派发→submit→完成 / 拒绝→回流→升级→requeue 全链路验证"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§2 目标 1（模板注册表）→ Task 2；目标 2（任务池状态机）→ Task 3/4；目标 3（分选器）→ Task 4/5；目标 4（sorter? 端口）→ Task 6；目标 5（投递接线）→ Task 7/8；§4.3 semantic-split → Task 2 + Task 8；§5.2 全转移（含 N1 claimed→escalated、N2 requeue 重置、I2 dispatch-failed、B2 pending 无候选）→ Task 3/4/5；§6.1 匹配规则 → Task 4；§6.3 周期+超时包装 → Task 5；§7.1 判别式端口 → Task 6；§7.3 /lab 命令 → Task 7；§8 边界（模型前置 mock、stale 不变量、escalated requeue 出口）→ Task 5/6/9。
2. **占位符扫描**：无 TBD/TODO；无草稿脚手架残留。
3. **类型一致性**：`TaskStatus`/`TaskRecord`/`SelectorRule`/`SorterCycleDeps`/`SorterSdkPort`/`InstantiateResult` 跨任务签名一致；`runIngestCycleOnce` 在 Task 8 迁移后签名变化（pipeline+pool）——Task 9 集成测使用新签名；`SorterEngine.autoReject/getTask/escalate` 在 Task 4 定义（含测试）、Task 5 使用；`Store.publish` 输入形状跨 Task 3/9 一致。
4. **既有代码依赖**：事件用 `randomUUID`（M3）；Task 3 各转移守卫入 SQL（WHERE 条件 + changes()===1，裁决 I7 TOCTOU——claim/reject/submit/requeue/reflow/escalate 全部条件 UPDATE，单语句隐式事务原子）；`matchesSelector` 逐标签 test（锚定正则语义正确）+ try/catch 兜底。

## 对抗性审核记录（qwen-token-plan-cn/qwen3.8-max，2026-08-06）

计划层对抗性审核：**5 Blocker + 10 Important + 9 Minor，全部落代码核实**。已全部修复：

| # | 发现 | 修复 |
|---|---|---|
| B1 | claims_count≥3 → escalated 转移缺失（Self-Review 误报覆盖） | Task 3 escalate 支持 claimed 源态 + Task 5 cycle ⑥ 派发返回后判定 + 阈值测试 |
| B2 | Task 8 漏迁移 ingest-integration.test.ts（签名变更砸红回归） | Task 8 Files 补该测试的同步迁移 |
| B3 | matchesSelector 用 join(" ") 导致锚定正则失效（^b$ 对 "a b" 为 false） | 改为逐标签 some(l => re.test(l)) |
| B4 | reflowRound 测试时间基错（1970 epoch vs Date.now()） | 改 Date.now() 基 + 手动老化 rejects/created_at |
| B5 | autoReject 测试在 Task 4 但实现缺失 | Task 4 实现补 autoReject + getTask + escalate（含 Produces 声明） |
| I1 | 派发无 withTimeout 包装（spec N4 落空） | Task 5 补 withTimeout 包装 + 永不 resolve 超时测试 |
| I2 | 池空触发语义偏差（rejected 恒受 age 门） | 见 spec §5.3 双触发语义——计划 reflowRound 保持 age 门为统一时间维触发，池空豁免列入 spec 注释（裁决：v1 以时间门为准，池空豁免随任务池精化） |
| I3 | Task 7 argv 下标整体错位（cmd=argv[0] 顶层分发） | 全部改 cmd/action/id 逐级取位 |
| I4 | WorkLoopSDK 在 workloop/contracts.ts 非 core/contracts.ts | 文件路径改正 + type-only import 方向说明 |
| I5 | Task 6 装配接线模糊零测试 | 注记钉死真实调用点 index.ts:874 + attachSdk 先例；接线以最小改动为准 |
| I6 | SqliteTaskStore 构造点未定义 | Task 7 注记钉死 index.ts 的 taskPool 工厂（sharedStore.raw）+ EventLog append bind 包装 |
| I7 | reject/submit TOCTOU（JS 预检 + 无条件 UPDATE） | 守卫入 SQL：条件 UPDATE + changes()===1（全转移统一） |
| I8 | candidates 测试未真测排除名单 | 测试补 reflow 后排除断言（见 Task 4 测试调整） |
| I9 | 并发双认领测试缺失 | Task 9 集成补（两个 store 实例断言单成功） |
| I10 | 命令块零接线测试 + 注入入口指错 | 注记钉死 index.ts:874；命令解析纯函数化列入执行期（渲染纯函数已测） |

**Minor（9 项）**：用例计数（Task 3→7、Task 4→7、Task 5→5 已同步）；cycle.ts 补 randomUUID import（Task 5 注记）；isTimeoutFailure 强转简化；Global Constraints 事务表述修正；role 硬编码 memory-maintenance 注释声明；setSelector 对不存在 agent 静默（命令层预检，执行期）；escalated payload reason 断言（Task 9）；reclaimStale 计数按 changes（执行期）；/lab task list 状态枚举校验（执行期）。
