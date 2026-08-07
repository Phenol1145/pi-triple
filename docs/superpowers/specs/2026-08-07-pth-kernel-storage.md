# PTH kernel Spec C：postgres 数据世界 + 数据归位

- **日期**：2026-08-07
- **状态**：设计（总纲 spec §5 分 spec C，待用户审阅）
- **定位**：PTH kernel 存储地基——postgres 统一数据世界 schema + 数据归位（pg/Redis/FS 边界）+ 迁移路径。
- **依赖**：总纲 spec `2026-08-07-pth-kernel-architecture.md`（§4 裁决 16/17/18 为本 spec 的约束来源）
- **执行顺序**：C（本 spec）→ A（解释器）→ B（执行层）

---

## 1. 目标与非目标

### 目标（v1）

1. **postgres 服务接入**：docker-compose 加 postgres 服务 + pth 侧 pg 连接层（连接池）
2. **数据世界 schema**：任务池/记忆/账本/转录/审计/skill/组件元数据 全部落 pg 表
3. **数据归位边界**：pg = 执行层真相；Redis = 交互层瞬态；FS = blob（引用而非复制）
4. **迁移路径**：agent-lab.db（SQLite）既有数据 → pg（任务/事件/账本）；记忆 FS → pg
5. **访问层**：统一数据访问接口（MemoryStore 接口保留、实现换 pg；taskStore 接口保留、实现换 pg）

### 非目标（明确不做）

- ⛔ 向量检索（记忆 v1 锚点精确；不建向量列/索引）
- ⛔ 产物自动清理（只推清理提示到交互层）
- ⛔ Redis 全面迁移（会话痕迹/认证/锁/队列留 Redis——交互层瞬态）
- ⛔ FS 全面迁移（工作区/artifacts/blob 留 FS）
- ⛔ 多租户隔离的深度设计（v1 沿用 tenantId 列约定）
- ⛔ 分库分表/读写分离（v1 单库单实例）

## 2. postgres schema 设计

### 2.1 表清单（12 表）

```
── 任务池域 ──
task_templates    任务模板（标签/执行协议/输入参数/验收标准/成果契约）
tasks             任务六状态机（pending/claimed/submitted/completed/rejected/escalated）

── 记忆域 ──
memory_entries    记忆条目（MemoryEntry 结构：id/kind/anchors/content/ruleRef/status/meta JSONB）
memory_index      锚点索引（anchor → entry_id 列表；替代 FS anchors.json）
memory_pipeline   沉淀管道状态（buffer/idem/retry——替代 FS jsonl 三件套）

── 经济/事件域 ──
lab_events        事件账本（时间线；替代 agent-lab.db lab_events）
credit_tx         经济账本（替代 agent-lab.db credit_tx）

── 转录/审计域 ──
transcripts       任务转录（任务执行完整记录：程序/结果/决策；JSONB 或行）
audit_log         审计（替代 Redis Stream audit:log；可查询）

── 知识/组件域 ──
skills            skill 条目（= 记忆一种；描述如何完成特定工作的数据）
component_meta    组件元数据（components:* Redis 索引替代；blob 留 FS 卷）

── 系统域 ──
settings          设置（替代 Redis settings:*；或留 Redis——待裁决）
```

### 2.2 关键表 DDL 草案

```sql
-- 任务池：对齐 taskpool v1 语义（SqliteTaskStore 逐列验证，对抗性审核）
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                    -- UUID
  tenant_id TEXT NOT NULL DEFAULT 'default',  -- 多租户预留（v1 单租户，裁决 25）
  template_id TEXT REFERENCES task_templates(id),
  title TEXT NOT NULL,
  text TEXT NOT NULL,                     -- 实例化后完整任务文本（认领注入用，非 title 替代）
  description TEXT,
  created_by TEXT NOT NULL,               -- 发布者（审计链）
  payload JSONB DEFAULT '{}',             -- 输入参数（模板实例化产物）
  tags TEXT[] DEFAULT '{}',               -- 标签数组（sorter 匹配用，GIN 索引）
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','submitted','completed','rejected','escalated')),
  claimed_by TEXT,                        -- 认领者 agentId（claim/submit/reject/stale 守卫）
  claims_count INTEGER DEFAULT 0,
  rejects JSONB DEFAULT '[]',             -- RejectRecord[]：{agentId, reason, at}（排除名单推导）
  sorter_selector TEXT,                   -- 认领者 selector_json 快照
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  stale_ms INTEGER DEFAULT 600000,        -- stale 回收阈值（> 执行超时 300s）
  artifact_path TEXT,                     -- 产物指针（引用而非复制）
  transcript_id TEXT REFERENCES transcripts(id)
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_tags ON tasks USING GIN(tags);
CREATE INDEX idx_tasks_created ON tasks(created_at);
CREATE INDEX idx_tasks_claimed_by ON tasks(claimed_by, status);
CREATE INDEX idx_tasks_claimed_at ON tasks(claimed_at) WHERE status='claimed';

-- 并发认领（对抗性审核 B2）：peek+claim 原子化
-- SELECT id FROM tasks WHERE status='pending' ORDER BY created_at LIMIT N FOR UPDATE SKIP LOCKED
-- （SQLite 单写者 changes()===1 在 pg 多连接下不可靠——必须显式行锁）

-- 记忆条目：MemoryEntry 结构 → pg（hitCount/version/notWriteBack 独立列，对抗性审核 B3）
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,                    -- UUID（不可变）
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,                     -- axiom|rule|fact|experience|preference|<方言>
  anchors JSONB NOT NULL DEFAULT '[]'
    CHECK (jsonb_array_length(anchors) > 0),  -- 锚点非空不变量（写入即校验）
  content TEXT NOT NULL,                  -- 规则约束的构成
  rule_ref TEXT,
  idempotency_key TEXT UNIQUE,            -- 沉淀幂等键
  status TEXT NOT NULL DEFAULT 'official'
    CHECK (status IN ('draft','official','archived')),  -- 默认对齐 createEntry（对抗性审核）
  version INTEGER NOT NULL DEFAULT 1,     -- CAS 判定列（WHERE version = ?）
  hit_count INTEGER DEFAULT 0,            -- 旁路计数器（独立列，不触发版本化）
  not_write_back BOOLEAN DEFAULT FALSE,   -- 审核链拒绝标记（可索引查询）
  ttl_expires_at TIMESTAMPTZ,
  promoted_from TEXT,
  meta JSONB DEFAULT '{}',                -- 低频字段：sourceTraces/versions[]/dialectVersion
  created_at TIMESTAMPTZ DEFAULT now(),   -- 真相源（meta 内不重复存 createdAt/updatedAt）
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_memory_anchors ON memory_entries USING GIN(anchors);
CREATE INDEX idx_memory_status ON memory_entries(status);

-- 沉淀管道（对抗性审核 B4）：5 种 jsonl → 表
CREATE TABLE memory_buffer (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,               -- 预分配 idempotencyKey
  content TEXT NOT NULL,
  anchors JSONB DEFAULT '[]',
  kind TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE memory_idem (
  key TEXT PRIMARY KEY,                   -- 幂等键（UNIQUE 替代线性扫描）
  entry_id TEXT NOT NULL,
  watermark INTEGER                        -- 水位（pruneIdem: DELETE WHERE watermark > S）
);
CREATE TABLE memory_retry (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0        -- 重试计数（封顶 2）
);
CREATE TABLE memory_index (
  anchor TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (anchor, entry_id)          -- 锚点索引（替代 FS anchors.json）
);

-- 转录：任务执行完整档案
CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id TEXT REFERENCES tasks(id),
  session_id TEXT,                        -- 会话关联（WM 链路可追溯，对抗性审核）
  agent_id TEXT,                          -- 执行者
  body JSONB NOT NULL DEFAULT '[]',       -- 事件序列（程序/结果/决策）
  summary TEXT,                           -- 结构化提炼（v2）
  artifact_path TEXT,                     -- 产物指针
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 审计：可查询（替代 Redis Stream 只写不读）
CREATE TABLE audit_log (
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
CREATE INDEX idx_audit_type_time ON audit_log(event_type, created_at);
```

### 2.3 schema 完整清单（其余表从略，分层 spec 细化时补全）

memory_index / memory_pipeline / lab_events / credit_tx / skills / component_meta / settings / task_templates —— 结构与上表同风格（id + JSONB + 时间戳 + GIN/btree 索引）。

**skills 表 = memory_entries 的 kind='skill' 视图**（不建独立表——裁决 4 "skill 是记忆的一种"，避免冗余存储和同步问题）。

**迁移补充（对抗性审核）**：
- MemoryPipeline 的直接 FS 依赖（buffer/idem/retry/consumed/not-write-back 五件套）全部改为 pg 访问：`observe()` → INSERT INTO memory_buffer；`write()` → pg 事务内幂等检查 + 重试计数 upsert + MemoryStore 写入；`flushBuffer()` → DELETE consumed rows；`pruneIdem()` → DELETE FROM memory_idem WHERE watermark > S；`notWriteBackIds()` → SELECT FROM memory_entries WHERE not_write_back = TRUE
- agent-lab.db 全部 15 表归属：tasks/task_templates/lab_events/credit_tx → pg（kernel 域）；lab_agent_instances/lab_scheduler_instances/lab_optimizer_instances/lab_routing_bindings/scheduled_jobs/event_subscriptions → 留 SQLite（agent-lab 遗留域，kernel 不读）或随对应模块迁移；lab_scheduler_drafts/lab_optimization_rounds/lab_proposals/lab_namespace_kv → 废弃（对应模块被 kernel 取代）
- workflow 状态 → 迁 pg（防 Redis 重启僵尸态；不变量 #4 细化）
- 悬空引用防护（对抗性审核）：artifact_path 周期性健康检查（任务归档时验证 FS 存在）；FS rename + pg UPDATE 非原子 → 归档操作声明"FS rename 先行，pg 指针后写，失败重试"（幂等）；文档化悬空引用 = 数据丢失（诚实声明）

## 3. 数据归位边界（硬约束）

```
postgres = 执行层持久真相（可查询/事务/跨 batch 共享）
  tasks/task_templates/memory_*/lab_events/credit_tx/transcripts/audit_log/skills/component_meta/settings

Redis = 交互层瞬态（短生命周期高频）
  会话痕迹 session:*（用户对话 JSONL）——留
  认证 auth:token:* ——留
  锁 workflow:* lock/token ——留
  队列（BullMQ intents）——留

FS = blob 存储（大文件/二进制）
  workspaces/ 任务工作区（临时；提交后归档清理）
  artifacts/<tenant>/<taskId>/ 产物归档（不自动清理）
  components/ 组件 tar.gz（现状保留）
  platform/{prompts,config} 配置原文（skills 迁 pg 后 prompts/config 留 FS）
```

**引用而非复制**：pg 存 taskId/artifactPath 指针，大文件只留一份在 FS。

## 4. 迁移路径

### 4.1 agent-lab.db（SQLite）→ pg

| 数据 | 源表 | 目标 | 迁移方式 |
|---|---|---|---|
| 任务池 | tasks/task_templates | pg tasks/task_templates | 一次性 ETL（启动时检测空库 → 导入） |
| 事件 | lab_events | pg lab_events | 同上（或从 v1 起只写 pg，旧数据可弃） |
| 账本 | credit_tx | pg credit_tx | 同上 |

**裁决建议**：v1 起**双写或只写 pg**（旧 SQLite 数据可不迁——联邦地基刚建，数据量小、价值低）。迁移脚本提供但非必须。

### 4.2 记忆 FS → pg

| 现状 | 目标 | 语义保持 |
|---|---|---|
| entries/<id>.json | memory_entries 行 | 原子性（pg 事务）、版本化 CAS（行更新）、锚点检索（GIN） |
| index/anchors.json | memory_entries.anchors GIN 索引 | 索引构建（pg 自动维护，替代启动 rebuildIndex） |
| counters/<id>.json | meta JSONB 内 hitCount | 旁路计数器（不触发版本化——pg 可独立 UPDATE 列） |
| buffer/idem/retry jsonl | memory_pipeline 表 | 幂等键表（UNIQUE 约束替代线性扫描） |

**MemoryStore 接口保留、实现替换**：`write/update/retrieve/bumpHitCount/rebuildIndex` 签名不变，内部从 FS 换 pg。**迁移成本低**（接口干净，且记忆系统当前休眠——无线上迁移负担）。

## 5. 访问层设计

```
src/pth/kernel/storage/
├── pg.ts                  pg 连接池（Pool 单例）+ 事务助手
├── schema.ts              DDL 全量（CREATE TABLE IF NOT EXISTS + 迁移版本表）
├── memory-store-pg.ts     MemoryStore 接口的 pg 实现
├── task-store-pg.ts       taskStore 接口的 pg 实现
├── transcript-store.ts    转录读写
├── audit-store.ts         审计写读（替代 Redis Stream）
└── index.ts               barrel
```

**依赖**：`pg` npm 包（唯一新依赖；node:sqlite 是内置但 pg 客户端必须引）。连接配置经 env（DATABASE_URL，compose 注入）。

## 6. 与 A/B spec 的接口

- **Spec A（解释器）** 消费：`dataWorld` 访问接口（记忆读写/技能加载经 storage 层）
- **Spec B（执行层）** 消费：taskStore（认领/提交/回流）、transcriptStore（归档）、workspace 路径（任务级）

## 7. 不变量

1. pg = 执行层真相源；Redis 只存交互层瞬态；FS 只存 blob
2. 引用而非复制（pg 存指针，FS 存大文件）
3. 产物不自动清理（清理提示走交互层）
4. MemoryStore/taskStore 接口保留、实现换 pg（消费方无感）
5. 零新依赖优先（唯一新依赖 = pg 客户端）
6. 旧 SQLite 数据不强制迁移（v1 双写/只写 pg；迁移脚本可选）

## 8. 相关参考

- 总纲：`docs/superpowers/specs/2026-08-07-pth-kernel-architecture.md`
- 存储全景：`docs/superpowers/explorations/2026-08-07-structure-recon/scout-8-pth-rest.md`（§4 存储面全清单）
- agent-lab schema：`extensions/agent-lab/src/core/storage/schema.ts`（15 表）
- 记忆系统：`extensions/agent-lab/src/memory/store.ts` + `pipeline.ts`（FS 实现，接口保留）
- 记忆 spec：`docs/superpowers/specs/2026-08-02-memory-system-design.md`
