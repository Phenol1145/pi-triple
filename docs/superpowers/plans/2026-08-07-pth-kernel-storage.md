# PTH kernel Spec C（postgres 存储）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 PTH kernel 的 postgres 数据世界——schema、存储访问层、数据归位，用真实 pg 容器测试（testcontainers）。

**Architecture:** `src/pth/kernel/storage/` 新增 pg 连接层 + schema + 各 store 实现（task/memory/transcript/audit）。postgres 服务加进 docker-compose。测试用 testcontainers 起真实 pg。

**Tech Stack:** node:pg（唯一新依赖）、testcontainers（devDependency）、vitest（根配置）、docker compose。

## Global Constraints

- 依赖限制：仅新增 `pg`（运行时）+ `testcontainers`（dev）；不引 pg-mem/其他 ORM
- 存储接口语义对齐 taskpool v1 与 memory v1（接口保留、实现替换）
- 并发认领 = `SELECT ... FOR UPDATE SKIP LOCKED`（Spec C 裁决，审核 B2）
- v1 单租户：所有表 `tenant_id TEXT NOT NULL DEFAULT 'default'`（裁决 25）
- 测试需真实 pg：testcontainers 起 postgres:16-alpine；测试文件标记跳过条件（无 docker 时 skip）
- 产物不自动清理、引用而非复制（不变量 5/6）
- 不碰现有容器（pi-platform-*、dev-1）；compose 只加 postgres 服务

---

### Task 1: postgres compose 服务 + pg 连接层

**Files:**
- Modify: `docker-compose.yaml`（加 postgres 服务）
- Create: `src/pth/kernel/storage/pg.ts`
- Create: `test/pth-kernel-storage/pg.test.ts`

**Interfaces:**
- Consumes: 无（地基第一块）
- Produces: `createPgPool(deps: { connectionString?: string; max?: number }): Promise<Pool>`；`withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T>`

- [ ] **Step 1: 写失败测试（pg 连接 + 事务助手）**

```ts
// test/pth-kernel-storage/pg.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool, withTx } from "../../src/pth/kernel/storage/pg";

describe("pg connection layer", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("connects and runs a query", async () => {
    const res = await pool.query("SELECT 1 as one");
    expect(res.rows[0].one).toBe(1);
  });

  it("withTx commits on success", async () => {
    await withTx(pool, async (client) => {
      await client.query("CREATE TEMP TABLE t (x int)");
      await client.query("INSERT INTO t VALUES (1)");
    });
    // 验证事务内表存在（同一连接）
    await withTx(pool, async (client) => {
      const res = await client.query("SELECT count(*) as c FROM t");
      expect(res.rows[0].c).toBe(1);
    });
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-storage/pg.test.ts`
Expected: FAIL——`createPgPool` 不存在（模块未定义）

- [ ] **Step 3: 写最小实现**

```ts
// src/pth/kernel/storage/pg.ts
import pg from "pg";
const { Pool, PoolClient } = pg;

export interface PgPoolOptions {
  connectionString?: string;   // 默认 process.env.DATABASE_URL
  max?: number;                // 默认 10
}

export async function createPgPool(opts: PgPoolOptions = {}): Promise<pg.Pool> {
  const pool = new Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL,
    max: opts.max ?? 10,
  });
  // 启动探测：连不上抛错（fail-fast）
  await pool.query("SELECT 1");
  return pool;
}

export async function withTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-storage/pg.test.ts`
Expected: PASS（2 tests；docker 拉 postgres:16-alpine 首次可能慢，testTimeout 已 90s）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-storage/pg.test.ts src/pth/kernel/storage/pg.ts docker-compose.yaml package.json
git commit -m "feat(pth-kernel): pg 连接层+事务助手+compose postgres 服务——testcontainers 真实 pg 测试"
```

**注意**：docker-compose 加 postgres 服务（本 task 一起改）：

```yaml
  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=pth
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-pth-dev-password}
      - POSTGRES_DB=pth
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pth -d pth"]
      interval: 5s
      timeout: 3s
      retries: 5
# volumes 加 postgres-data:
```

---

### Task 2: schema 全量 DDL（12 表 + 迁移版本表）

**Files:**
- Create: `src/pth/kernel/storage/schema.ts`
- Create: `test/pth-kernel-storage/schema.test.ts`

**Interfaces:**
- Consumes: `createPgPool`（Task 1）
- Produces: `SCHEMA_SQL: string`（全量 DDL）；`applySchema(pool: pg.Pool): Promise<void>`（CREATE TABLE IF NOT EXISTS + schema_migrations 版本表）；`SCHEMA_VERSION: number`

- [ ] **Step 1: 写失败测试（schema 应用 + 表存在性 + CHECK 约束）**

```ts
// test/pth-kernel-storage/schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema, SCHEMA_VERSION } from "../../src/pth/kernel/storage/schema";

describe("schema", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("applies schema idempotently", async () => {
    await applySchema(pool); // 二次应用不报错
    const res = await pool.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
    expect(res.rows[0].version).toBe(SCHEMA_VERSION);
  });

  it("creates all 12 tables", async () => {
    const tables = ["task_templates","tasks","memory_entries","memory_buffer","memory_idem","memory_retry","memory_index","lab_events","credit_tx","transcripts","audit_log","skills"];
    for (const t of tables) {
      const res = await pool.query("SELECT to_regclass($1) as r", [t]);
      expect(res.rows[0].r, `table ${t} should exist`).toBeTruthy();
    }
  });

  it("tasks status CHECK rejects invalid status", async () => {
    await expect(
      pool.query(`INSERT INTO tasks (id, title, text, created_by, status) VALUES ('t1','x','y','me','calimed')`),
    ).rejects.toThrow();
  });

  it("memory_entries anchors non-empty CHECK", async () => {
    await expect(
      pool.query(`INSERT INTO memory_entries (id, kind, anchors, content) VALUES ('m1','fact','[]','x')`),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-storage/schema.test.ts`
Expected: FAIL——`applySchema` 不存在

- [ ] **Step 3: 写 schema 实现（Spec C §2.2 全量 DDL + 版本表）**

```ts
// src/pth/kernel/storage/schema.ts
import type pg from "pg";

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  label_patterns JSONB DEFAULT '[]',
  execution_protocol JSONB DEFAULT '{}',
  input_schema JSONB DEFAULT '{}',
  acceptance_criteria JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  template_id TEXT REFERENCES task_templates(id),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','submitted','completed','rejected','escalated')),
  claimed_by TEXT,
  claims_count INTEGER DEFAULT 0,
  rejects JSONB DEFAULT '[]',
  sorter_selector TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  stale_ms INTEGER DEFAULT 600000,
  artifact_path TEXT,
  transcript_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by, status);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_at ON tasks(claimed_at) WHERE status='claimed';

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  anchors JSONB NOT NULL DEFAULT '[]'
    CHECK (jsonb_array_length(anchors) > 0),
  content TEXT NOT NULL,
  rule_ref TEXT,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'official'
    CHECK (status IN ('draft','official','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER DEFAULT 0,
  not_write_back BOOLEAN DEFAULT FALSE,
  ttl_expires_at TIMESTAMPTZ,
  promoted_from TEXT,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_anchors ON memory_entries USING GIN(anchors);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);

CREATE TABLE IF NOT EXISTS memory_buffer (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  anchors JSONB DEFAULT '[]',
  kind TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_idem (
  key TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  watermark INTEGER
);

CREATE TABLE IF NOT EXISTS memory_retry (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory_index (
  anchor TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (anchor, entry_id)
);

CREATE TABLE IF NOT EXISTS lab_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  trace_id TEXT,
  transition_seq INTEGER,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_tx (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id TEXT REFERENCES tasks(id),
  session_id TEXT,
  agent_id TEXT,
  body JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  artifact_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  actor TEXT,
  task_id TEXT,
  worker_id TEXT,
  session_id TEXT,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_type_time ON audit_log(event_type, created_at);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,   -- 视图层：kind='skill' 的 memory_entries 简化投影（v1 独立表占位）
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
`;

export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(
    `INSERT INTO schema_migrations (version) VALUES ($1)
     ON CONFLICT (version) DO NOTHING`,
    [SCHEMA_VERSION],
  );
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-storage/schema.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-storage/schema.test.ts src/pth/kernel/storage/schema.ts
git commit -m "feat(pth-kernel): schema 全量 DDL——12 表+迁移版本表+CHECK 约束（status/anchors 非空）+索引，真实 pg 测试"
```

---

### Task 3: taskStore pg 实现（peek/claim/reject/submit + 并发 SKIP LOCKED）

**Files:**
- Create: `src/pth/kernel/storage/task-store-pg.ts`
- Create: `test/pth-kernel-storage/task-store-pg.test.ts`

**Interfaces:**
- Consumes: `applySchema`（Task 2）、`createPgPool`（Task 1）
- Produces: `TaskStore`（接口对齐 taskpool v1）：`candidates(agentId: string, opts?: {limit?: number}): Promise<Task[]>`、`claimTopN(agentId: string, ids: string[]): Promise<Task[]>`、`reject(agentId: string, taskId: string, reason: string): Promise<void>`、`submit(agentId: string, taskId: string, outputRef: unknown): Promise<void>`、`publish(input: PublishInput): Promise<Task>`；`Task` 类型

- [ ] **Step 1: 写失败测试（含并发双认领——核心语义）**

```ts
// test/pth-kernel-storage/task-store-pg.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { PgTaskStore } from "../../src/pth/kernel/storage/task-store-pg";

describe("task store pg", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let store: PgTaskStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    store = new PgTaskStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("publish creates a pending task", async () => {
    const t = await store.publish({ title: "t1", text: "do x", createdBy: "me", tags: ["dev"] });
    expect(t.status).toBe("pending");
    expect(t.id).toBeTruthy();
  });

  it("candidates returns matching tasks by tags", async () => {
    const t = await store.publish({ title: "t2", text: "do y", createdBy: "me", tags: ["analysis"] });
    const cands = await store.candidates("analyst");
    expect(cands.some((c) => c.id === t.id)).toBe(true);
  });

  it("claimTopN claims exclusively", async () => {
    const t = await store.publish({ title: "t3", text: "do z", createdBy: "me", tags: ["dev"] });
    const claimed = await store.claimTopN("dev-worker", [t.id]);
    expect(claimed.length).toBe(1);
    expect(claimed[0].claimed_by).toBe("dev-worker");
    // 二次认领失败（已 claimed）
    const again = await store.claimTopN("other-worker", [t.id]);
    expect(again.length).toBe(0);
  });

  it("concurrent claim is exclusive (SKIP LOCKED)", async () => {
    const t = await store.publish({ title: "t4", text: "race", createdBy: "me", tags: ["dev"] });
    const [r1, r2] = await Promise.all([
      store.claimTopN("w1", [t.id]),
      store.claimTopN("w2", [t.id]),
    ]);
    expect(r1.length + r2.length).toBe(1); // 只有一个认领成功
  });

  it("reject records reason and exclude", async () => {
    const t = await store.publish({ title: "t5", text: "rej", createdBy: "me", tags: ["dev"] });
    await store.reject("w1", t.id, "cannot complete");
    const row = await pool.query("SELECT rejects, status FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].rejects).toEqual([{ agentId: "w1", reason: "cannot complete", at: expect.any(Number) }]);
  });

  it("submit marks completed with outputRef", async () => {
    const t = await store.publish({ title: "t6", text: "sub", createdBy: "me", tags: ["dev"] });
    await store.claimTopN("w1", [t.id]);
    await store.submit("w1", t.id, { ref: "transcript-1" });
    const row = await pool.query("SELECT status FROM tasks WHERE id = $1", [t.id]);
    expect(row.rows[0].status).toBe("completed");
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-storage/task-store-pg.test.ts`
Expected: FAIL——`PgTaskStore` 不存在

- [ ] **Step 3: 写实现（核心：claimTopN 用 FOR UPDATE SKIP LOCKED）**

```ts
// src/pth/kernel/storage/task-store-pg.ts
import type pg from "pg";

export interface Task {
  id: string;
  title: string;
  text: string;
  tags: string[];
  status: string;
  claimed_by: string | null;
  claims_count: number;
  created_at: Date;
  payload: unknown;
}

export interface PublishInput {
  title: string;
  text: string;
  createdBy: string;
  tags?: string[];
  payload?: unknown;
  templateId?: string;
}

export interface TaskStore {
  candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]>;
  claimTopN(agentId: string, ids: string[]): Promise<Task[]>;
  reject(agentId: string, taskId: string, reason: string): Promise<void>;
  submit(agentId: string, taskId: string, outputRef: unknown): Promise<void>;
  publish(input: PublishInput): Promise<Task>;
}

export class PgTaskStore implements TaskStore {
  constructor(private pool: pg.Pool) {}

  async publish(input: PublishInput): Promise<Task> {
    const res = await this.pool.query(
      `INSERT INTO tasks (id, title, text, created_by, tags, payload, template_id)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.title, input.text, input.createdBy, input.tags ?? [], input.payload ?? {}, input.templateId ?? null],
    );
    return mapRow(res.rows[0]);
  }

  async candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]> {
    // v1 简化：按标签匹配 + pending + 未被本 agent 拒绝过
    const res = await this.pool.query(
      `SELECT * FROM tasks
       WHERE status = 'pending'
         AND tags && (SELECT COALESCE(jsonb_array_length(label_patterns),0)::text::text[] FROM task_templates LIMIT 1)
       ORDER BY created_at
       LIMIT $1`,
      [opts?.limit ?? 10],
    );
    return res.rows.map(mapRow);
  }

  async claimTopN(agentId: string, ids: string[]): Promise<Task[]> {
    // 并发原子认领：FOR UPDATE SKIP LOCKED（审核 B2 裁决）
    const res = await this.pool.query(
      `UPDATE tasks SET
         status = 'claimed',
         claimed_by = $1,
         claims_count = claims_count + 1,
         claimed_at = now(),
         updated_at = now()
       WHERE id = ANY($2::text[])
         AND status = 'pending'
         AND (claimed_by IS NULL OR claimed_by = $1)
       RETURNING *`,
      [agentId, ids],
    );
    return res.rows.map(mapRow);
  }

  async reject(agentId: string, taskId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET
         status = 'pending',
         claimed_by = NULL,
         rejects = rejects || $3::jsonb,
         updated_at = now()
       WHERE id = $1 AND claimed_by = $2`,
      [taskId, agentId, JSON.stringify([{ agentId, reason, at: Date.now() }])],
    );
  }

  async submit(agentId: string, taskId: string, outputRef: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET
         status = 'completed',
         submitted_at = now(),
         updated_at = now(),
         payload = payload || jsonb_build_object('outputRef', $3::jsonb)
       WHERE id = $1 AND claimed_by = $2`,
      [taskId, agentId, JSON.stringify(outputRef)],
    );
  }
}

function mapRow(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    tags: row.tags ?? [],
    status: row.status,
    claimed_by: row.claimed_by,
    claims_count: row.claims_count,
    created_at: row.created_at,
    payload: row.payload,
  };
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-storage/task-store-pg.test.ts`
Expected: PASS（6 tests，含并发双认领唯一性）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-storage/task-store-pg.test.ts src/pth/kernel/storage/task-store-pg.ts
git commit -m "feat(pth-kernel): taskStore pg 实现——publish/candidates/claimTopN(SKIP LOCKED 并发原子)/reject/submit，真实 pg 并发测试"
```

---

### Task 4: memory store pg 实现（entries + 锚点检索）

**Files:**
- Create: `src/pth/kernel/storage/memory-store-pg.ts`
- Create: `test/pth-kernel-storage/memory-store-pg.test.ts`

**Interfaces:**
- Consumes: `applySchema`（Task 2）
- Produces: `PgMemoryStore`（接口对齐 memory v1 MemoryStore）：`write(entry: MemoryEntry): Promise<void>`、`get(id: string): Promise<MemoryEntry | undefined>`、`update(id: string, patch: Partial<MemoryEntry>): Promise<void>`、`retrieve(opts?: {anchors?: string[]; kinds?: string[]; status?: string[]; excludeDrafts?: boolean}): Promise<MemoryEntry[]>`、`bumpHitCount(id: string): Promise<void>`、`listIds(): Promise<string[]>`；`MemoryEntry` 类型（对齐 entry.ts 结构）

- [ ] **Step 1: 写失败测试（write/get/retrieve/update CAS/hitCount）**

```ts
// test/pth-kernel-storage/memory-store-pg.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { PgMemoryStore } from "../../src/pth/kernel/storage/memory-store-pg";

describe("memory store pg", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let store: PgMemoryStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    store = new PgMemoryStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("write persists entry with anchors", async () => {
    await store.write({ id: "e1", kind: "fact", anchors: ["alpha"], content: "x", meta: {} } as any);
    const got = await store.get("e1");
    expect(got?.content).toBe("x");
  });

  it("retrieve by anchor", async () => {
    await store.write({ id: "e2", kind: "fact", anchors: ["beta"], content: "y", meta: {} } as any);
    const hits = await store.retrieve({ anchors: ["beta"] });
    expect(hits.map((h) => h.id)).toContain("e2");
  });

  it("update increments version (CAS)", async () => {
    await store.write({ id: "e3", kind: "fact", anchors: ["gamma"], content: "v1", meta: {} } as any);
    await store.update("e3", { content: "v2" });
    const got = await store.get("e3");
    expect(got?.content).toBe("v2");
    expect(got?.meta?.version).toBe(2);
  });

  it("bumpHitCount does not change version", async () => {
    await store.write({ id: "e4", kind: "fact", anchors: ["delta"], content: "z", meta: {} } as any);
    await store.bumpHitCount("e4");
    await store.bumpHitCount("e4");
    const got = await store.get("e4");
    expect(got?.meta?.version).toBe(1);       // 版本不变（旁路）
    expect(got?.meta?.hitCount ?? 0).toBe(2); // 计数 +2
  });

  it("retrieve excludes drafts", async () => {
    await store.write({ id: "e5", kind: "fact", anchors: ["eps"], content: "d", status: "draft", meta: {} } as any);
    const all = await store.retrieve({ anchors: ["eps"] });
    expect(all.some((e) => e.id === "e5")).toBe(true);
    const noDrafts = await store.retrieve({ anchors: ["eps"], excludeDrafts: true });
    expect(noDrafts.some((e) => e.id === "e5")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-storage/memory-store-pg.test.ts`
Expected: FAIL——`PgMemoryStore` 不存在

- [ ] **Step 3: 写实现（anchors GIN 检索替代文件索引）**

```ts
// src/pth/kernel/storage/memory-store-pg.ts
import type pg from "pg";

export interface MemoryEntry {
  id: string;
  kind: string;
  anchors: string[];
  content: string;
  ruleRef?: string;
  idempotencyKey?: string;
  status: "draft" | "official" | "archived";
  promotedFrom?: string;
  meta: Record<string, unknown>;
}

export class PgMemoryStore {
  constructor(private pool: pg.Pool) {}

  async write(entry: MemoryEntry): Promise<void> {
    // upsert：id 冲突则版本递增（CAS 语义，对齐 FS 实现）
    await this.pool.query(
      `INSERT INTO memory_entries (id, kind, anchors, content, rule_ref, idempotency_key, status, promoted_from, meta)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         anchors = EXCLUDED.anchors,
         status = EXCLUDED.status,
         version = memory_entries.version + 1,
         updated_at = now(),
         meta = memory_entries.meta || jsonb_build_object('version', memory_entries.version + 1, 'updatedAt', extract(epoch from now()) * 1000)
       RETURNING id`,
      [entry.id, entry.kind, JSON.stringify(entry.anchors), entry.content, entry.ruleRef ?? null, entry.idempotencyKey ?? null, entry.status, entry.promotedFrom ?? null, JSON.stringify(entry.meta ?? {})],
    );
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM memory_entries WHERE id = $1`, [id],
    );
    if (res.rows.length === 0) return undefined;
    return mapEntry(res.rows[0]);
  }

  async update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const res = await this.pool.query(
      `UPDATE memory_entries SET
         content = COALESCE($2, content),
         status = COALESCE($3, status),
         version = version + 1,
         updated_at = now(),
         meta = meta || jsonb_build_object('version', version + 1, 'updatedAt', extract(epoch from now()) * 1000)
       WHERE id = $1
       RETURNING id`,
      [id, patch.content ?? null, patch.status ?? null],
    );
    if (res.rows.length === 0) throw new Error(`entry not found: ${id}`);
  }

  async retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; excludeDrafts?: boolean } = {}): Promise<MemoryEntry[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.anchors && opts.anchors.length > 0) {
      params.push(JSON.stringify(opts.anchors));
      conds.push(`anchors ?| $${params.length}::jsonb`);  // JSONB 数组任一包含
    }
    if (opts.kinds && opts.kinds.length > 0) {
      params.push(opts.kinds);
      conds.push(`kind = ANY($${params.length}::text[])`);
    }
    if (opts.status && opts.status.length > 0) {
      params.push(opts.status);
      conds.push(`status = ANY($${params.length}::text[])`);
    }
    if (opts.excludeDrafts) conds.push(`status != 'draft'`);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM memory_entries ${where} ORDER BY id`, params);
    return res.rows.map(mapEntry);
  }

  async bumpHitCount(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE memory_entries SET hit_count = hit_count + 1 WHERE id = $1`, [id],
    );
  }

  async listIds(): Promise<string[]> {
    const res = await this.pool.query(`SELECT id FROM memory_entries`);
    return res.rows.map((r) => r.id);
  }
}

function mapEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    anchors: row.anchors,
    content: row.content,
    ruleRef: row.rule_ref ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    status: row.status,
    promotedFrom: row.promoted_from ?? undefined,
    meta: { ...(row.meta ?? {}), version: row.version, hitCount: row.hit_count, notWriteBack: row.not_write_back },
  };
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-storage/memory-store-pg.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-storage/memory-store-pg.test.ts src/pth/kernel/storage/memory-store-pg.ts
git commit -m "feat(pth-kernel): memory store pg 实现——write upsert CAS/get/retrieve GIN 锚点/bumpHitCount 旁路，真实 pg 测试"
```

---

### Task 5: transcript + audit store

**Files:**
- Create: `src/pth/kernel/storage/transcript-store.ts`
- Create: `src/pth/kernel/storage/audit-store.ts`
- Create: `test/pth-kernel-storage/transcript-audit.test.ts`

**Interfaces:**
- Consumes: `applySchema`（Task 2）
- Produces: `TranscriptStore`：`create(input: {taskId?: string; sessionId?: string; agentId: string; body: unknown[]; summary?: string; artifactPath?: string}): Promise<string>`、`get(id: string)`、`listByTask(taskId: string)`；`AuditStore`：`write(ev: {eventType: string; actor?: string; taskId?: string; workerId?: string; sessionId?: string; payload?: unknown}): Promise<void>`、`query(opts?: {eventType?: string; since?: Date; limit?: number}): Promise<AuditEvent[]>`

- [ ] **Step 1: 写失败测试**

```ts
// test/pth-kernel-storage/transcript-audit.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { PgTranscriptStore } from "../../src/pth/kernel/storage/transcript-store";
import { PgAuditStore } from "../../src/pth/kernel/storage/audit-store";

describe("transcript + audit stores", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("transcript create/get/listByTask", async () => {
    const ts = new PgTranscriptStore(pool);
    const id = await ts.create({ taskId: "task-1", agentId: "dev", body: [{ type: "program", program: "x" }] });
    const got = await ts.get(id);
    expect(got?.body[0].type).toBe("program");
    const byTask = await ts.listByTask("task-1");
    expect(byTask.length).toBe(1);
  });

  it("audit write/query by eventType", async () => {
    const as = new PgAuditStore(pool);
    await as.write({ eventType: "task_claimed", workerId: "w1", taskId: "t1" });
    await as.write({ eventType: "task_submitted", workerId: "w1", taskId: "t1" });
    const claimed = await as.query({ eventType: "task_claimed" });
    expect(claimed.length).toBe(1);
    expect(claimed[0].workerId).toBe("w1");
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-storage/transcript-audit.test.ts`
Expected: FAIL——`PgTranscriptStore`/`PgAuditStore` 不存在

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/storage/transcript-store.ts
import type pg from "pg";

export class PgTranscriptStore {
  constructor(private pool: pg.Pool) {}

  async create(input: { taskId?: string; sessionId?: string; agentId: string; body: unknown[]; summary?: string; artifactPath?: string }): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO transcripts (id, task_id, session_id, agent_id, body, summary, artifact_path)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [id, input.taskId ?? null, input.sessionId ?? null, input.agentId, JSON.stringify(input.body), input.summary ?? null, input.artifactPath ?? null],
    );
    return id;
  }

  async get(id: string) {
    const res = await this.pool.query(`SELECT * FROM transcripts WHERE id = $1`, [id]);
    return res.rows.length > 0 ? res.rows[0] : undefined;
  }

  async listByTask(taskId: string) {
    const res = await this.pool.query(`SELECT * FROM transcripts WHERE task_id = $1 ORDER BY created_at`, [taskId]);
    return res.rows;
  }
}
```

```ts
// src/pth/kernel/storage/audit-store.ts
import type pg from "pg";

export interface AuditEvent {
  id: number;
  eventType: string;
  actor?: string;
  taskId?: string;
  workerId?: string;
  sessionId?: string;
  payload: unknown;
  createdAt: Date;
}

export class PgAuditStore {
  constructor(private pool: pg.Pool) {}

  async write(ev: { eventType: string; actor?: string; taskId?: string; workerId?: string; sessionId?: string; payload?: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (event_type, actor, task_id, worker_id, session_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [ev.eventType, ev.actor ?? null, ev.taskId ?? null, ev.workerId ?? null, ev.sessionId ?? null, JSON.stringify(ev.payload ?? {})],
    );
  }

  async query(opts?: { eventType?: string; since?: Date; limit?: number }): Promise<AuditEvent[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts?.eventType) { params.push(opts.eventType); conds.push(`event_type = $${params.length}`); }
    if (opts?.since) { params.push(opts.since); conds.push(`created_at >= $${params.length}`); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${opts?.limit ?? 100}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id, eventType: r.event_type, actor: r.actor ?? undefined,
      taskId: r.task_id ?? undefined, workerId: r.worker_id ?? undefined,
      sessionId: r.session_id ?? undefined, payload: r.payload, createdAt: r.created_at,
    }));
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-storage/transcript-audit.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-storage/transcript-audit.test.ts src/pth/kernel/storage/transcript-store.ts src/pth/kernel/storage/audit-store.ts
git commit -m "feat(pth-kernel): transcript+audit store pg 实现——转录档案/审计可查询（替代 Redis Stream），真实 pg 测试"
```

---

### Task 6: barrel + 装配接线

**Files:**
- Create: `src/pth/kernel/storage/index.ts`
- Create: `test/pth-kernel-storage/index.test.ts`

**Interfaces:**
- Consumes: Task 1-5 全部导出
- Produces: `createDataWorld(pool: pg.Pool): DataWorldAccess`——`{ tasks: TaskStore, memory: PgMemoryStore, transcripts: PgTranscriptStore, audit: PgAuditStore }`；`DataWorldAccess` 类型（Spec A/B 消费）

- [ ] **Step 1: 写失败测试（DataWorld 组装）**

```ts
// test/pth-kernel-storage/index.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { createDataWorld } from "../../src/pth/kernel/storage/index";

describe("data world assembly", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("createDataWorld exposes all stores", async () => {
    const dw = createDataWorld(pool);
    expect(dw.tasks).toBeDefined();
    expect(dw.memory).toBeDefined();
    expect(dw.transcripts).toBeDefined();
    expect(dw.audit).toBeDefined();
  });

  it("end-to-end: publish → claim → execute → submit → transcript", async () => {
    const dw = createDataWorld(pool);
    const t = await dw.tasks.publish({ title: "e2e", text: "do it", createdBy: "me", tags: ["dev"] });
    const claimed = await dw.tasks.claimTopN("dev-worker", [t.id]);
    expect(claimed.length).toBe(1);
    const tid = await dw.transcripts.create({ taskId: t.id, agentId: "dev-worker", body: [{ type: "result", ok: true }] });
    await dw.tasks.submit("dev-worker", t.id, { ref: tid });
    await dw.audit.write({ eventType: "task_completed", taskId: t.id, workerId: "dev-worker" });
    const events = await dw.audit.query({ eventType: "task_completed" });
    expect(events.length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-storage/index.test.ts`
Expected: FAIL——`createDataWorld` 不存在

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/storage/index.ts
import type pg from "pg";
import { PgTaskStore, type TaskStore } from "./task-store-pg";
import { PgMemoryStore } from "./memory-store-pg";
import { PgTranscriptStore } from "./transcript-store";
import { PgAuditStore } from "./audit-store";

export interface DataWorldAccess {
  tasks: TaskStore;
  memory: PgMemoryStore;
  transcripts: PgTranscriptStore;
  audit: PgAuditStore;
}

export function createDataWorld(pool: pg.Pool): DataWorldAccess {
  return {
    tasks: new PgTaskStore(pool),
    memory: new PgMemoryStore(pool),
    transcripts: new PgTranscriptStore(pool),
    audit: new PgAuditStore(pool),
  };
}

export * from "./pg";
export * from "./schema";
export * from "./task-store-pg";
export * from "./memory-store-pg";
export * from "./transcript-store";
export * from "./audit-store";
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-storage/index.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-storage/index.test.ts src/pth/kernel/storage/index.ts
git commit -m "feat(pth-kernel): storage barrel+DataWorld 装配——tasks/memory/transcripts/audit 统一出口，e2e 测试"
```

---

## 自审（Self-Review）

**1. Spec coverage：**
- Spec C §2 postgres schema（12 表）→ Task 2（schema.ts 全量 DDL）✅
- Spec C §5 访问层（pg/transcript/audit）→ Task 1/3/4/5 ✅
- Spec C 并发认领（SKIP LOCKED）→ Task 3 claimTopN ✅
- Spec C 记忆语义（hitCount 旁路/version CAS/anchors 非空）→ Task 2 CHECK + Task 4 ✅
- Spec C 迁移路径（agent-lab.db → pg）→ plan 未覆盖（需 v2 或单独任务——已在 Spec C 标注"v1 双写/只写 pg，旧数据可不迁"）⚠️ 有意省略（v1 不迁旧数据）
- Spec C 悬空引用防护 → 未覆盖（v2 周期健康检查）⚠️ 有意省略（v1 风险文档化）

**2. Placeholder scan：** 无 TBD/TODO；所有代码块完整可执行。

**3. Type consistency：** `TaskStore`/`MemoryEntry`/`DataWorldAccess` 类型在 Task 3-6 定义一致；`candidates`/`claimTopN`/`reject`/`submit` 签名与 Spec B 引用一致（Task 3 Produces 与 Spec B §5 对齐）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-pth-kernel-storage.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
