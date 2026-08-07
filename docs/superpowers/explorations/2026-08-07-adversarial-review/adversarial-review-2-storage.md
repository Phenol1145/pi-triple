# 对抗性审核：PTH kernel Spec C（postgres 存储）

**审核日期**：2026-08-07  
**审核员立场**：对抗性（找破绽，不顺读）  
**审核范围**：Spec C 全文 + 总纲 §4 裁决 16/17/18 + 现有 SQLite schema（15 表）+ 记忆系统 FS 实现 + scout-8 存储全景

---

## 问题清单

| # | 严重度 | 类别 | 问题 | 建议修复 |
|---|---|---|---|---|
| 1 | **B** | Schema / 任务池 | **`tasks` 表 DDL 缺少 `claimed_by`、`text`、`created_by`、`rejects` 列——与任务池 spec 和现有 SqliteTaskStore 实现完全断裂。** Spec C §2.2 的 `tasks` DDL 只有 `title`/`description`/`payload`/`tags`/`rejected_reasons`，但任务池 spec（`2026-08-06-task-pool-sorter-design.md` §5.1）和现有 `SqliteTaskStore`（`taskpool/tasks.ts:75-76`）强依赖 `claimed_by`（认领守卫 `WHERE status='pending' AND claimed_by IS NULL` + reject/submit 的 `AND claimed_by=?` 校验）、`text`（任务文本——非 title/description 而是完整实例化文本）、`rejects`（`[{agentId, reason, at}]` 数组，用于排除名单推导）、`created_by`。**没有 `claimed_by` 列，peek/claim/submit/reject 全部不可实现。** | `tasks` 表必须保留 `claimed_by TEXT`、`text TEXT NOT NULL`、`created_by TEXT NOT NULL` 列；`rejected_reasons JSONB` 必须包含 `agentId` 字段（等同于现有 `rejects` 的 `RejectRecord[]` 语义）。`title`/`description` 不应替代 `text`——`text` 是实例化后的完整任务文本，与 `title`/`description` 是不同字段。 |
| 2 | **B** | Schema / 任务池 | **peek/claim 的并发原子性机制完全缺失——spec 没有任何关于 pg 并发控制的描述。** 现有 `SqliteTaskStore.claim()`（`taskpool/tasks.ts:72-77`）用 `UPDATE tasks SET ... WHERE id=? AND status='pending'` + `changes()===1` 利用 SQLite 单写者锁实现原子认领。pg 是多连接并发——同样的 SQL 在 `READ COMMITTED` 默认隔离级别下可被两个连接同时 UPDATE 同一条 pending 行（两连接都可能看到 changes=1），需要 `SELECT ... FOR UPDATE` 或 `SERIALIZABLE` 隔离级别。spec §2.2 和 §5 均未提及 `FOR UPDATE`、行锁、隔离级别、或 advisory lock。 | 明确认领并发方案：① `SELECT id FROM tasks WHERE status='pending' ORDER BY created_at LIMIT N FOR UPDATE SKIP LOCKED`（peek + claim 原子化，推荐）；② 或在 `claim()` 方法内用 pg 事务 + `FOR UPDATE` 逐条锁定。在 spec 中显式记录并发隔离级别和锁策略。此缺口不修 = claim 可被竞态重复认领 → 两个 agent 同时执行同一任务。 |
| 3 | **B** | Schema / 记忆 | **`memory_entries` 表把 `meta` 全部字段（version/hitCount/sourceTraces/notWriteBack/versions[]）塞入单一 JSONB 列——破坏了关键语义。** 记忆系统 spec（`2026-08-02-memory-system-design.md` §2 不变量 6）规定 `hitCount` 是"旁路计数器（独立存储，不触发版本化、不参与 CAS、崩溃回退可接受）"。现有 FS 实现 (`store.ts:175`) 用独立的 `counters/<id>.json` 文件实现，`bumpHitCount()` 零版本化开销。放进 `meta JSONB` 后：① 每次 `bumpHitCount` = 整行 JSONB 反序列化 → 修改 → UPDATE 全行 → 触发行级锁和 WAL 写入；② `meta.notWriteBack`（审核链拒绝标记，`entry.ts:25` + `pipeline.ts:267-273`）藏在 JSONB 深处无法高效索引/查询；③ `meta.version` 虽可从 JSONB 提取但丧失了列级约束。 | 将 `hitCount` 提为独立列 `hit_count INTEGER DEFAULT 0`（旁路语义保留）；将 `version` 提为独立列 `version INTEGER NOT NULL DEFAULT 1`（CAS 判定可走 `WHERE version = ?`）；将 `not_write_back BOOLEAN DEFAULT FALSE` 提为独立列（审核链查询可走索引）。`sourceTraces`、`versions[]` 等低频字段可以留 JSONB。 |
| 4 | **B** | 数据归位 / 引用 | **"引用而非复制"的指针方案缺少悬空引用防护。** Spec C §3 规定 `artifact_path TEXT`（如 `artifacts/<tenant>/<taskId>/`），pg 只存指针、FS 存 blob。但 spec 没有定义：① 如果 FS 路径被手动删除/磁盘故障，pg 中的 `artifact_path` 如何被发现是悬空引用？② 产物归档（任务级工作区整目录 rename → `artifacts/`）的原子性——rename 成功但 pg UPDATE 失败（或反过来）怎么处理？③ 转录表的 `artifact_path` 同样悬空。总纲裁决 17"产物不自动清理——推清理提示到交互层"只回答了"不主动删"，没有回答"被意外删了怎么办"。 | 悬空引用至少需要：① `tasks.artifact_path` 上的周期性健康检查/校验（或 pg 触发器在路径非空时做 `pg_stat_file` 等效检查）；② 归档操作的事务边界声明（FS rename + pg UPDATE 非原子 → 需补偿/重试/幂等策略）；③ 文档化：悬空引用 = 数据丢失（不可恢复）——诚实声明风险。 |
| 5 | **重要** | Schema / 完整性 | **12 表清单中 8 个表无 DDL——特别是 `memory_pipeline` 和 `memory_index` 这两个记忆管道核心表。** Spec C §2.3 说"结构与上表同风格（id + JSONB + 时间戳 + GIN/btree 索引）"，但对于 `memory_pipeline` 这是不充分的。现有 `MemoryPipeline` 管理 5 种独立数据结构：`buffer.jsonl`（{key, content, anchors, kind?, ts}）、`idem.jsonl`（{key, entryId, watermark}）、`buffer-consumed.jsonl`（{key}）、`retry-count.jsonl`（{key, count}）、`not-write-back.jsonl`（{entryId}）。这些在 pg 中如何建模？是一个 `memory_pipeline` 多态表（用 `record_type` 列区分）还是 3-4 个独立表？`pruneIdem(seq)`（`pipeline.ts:233`）的"丢弃 watermark > seq 的 idem 行"语义在 pg 是 DELETE，但 spec 未定义。`observe()` 追加缓冲（原 `appendFileSync`）在 pg 是 INSERT，语义对但需 DDL。 | 给出 `memory_pipeline` 和 `memory_index` 的完整 DDL。建议：`memory_buffer (id, key, content, anchors JSONB, kind, created_at)` + `memory_idem (key TEXT UNIQUE, entry_id TEXT, watermark INT)` + `memory_retry (key TEXT UNIQUE, count INT)` + `memory_index (anchor TEXT, entry_id TEXT, PRIMARY KEY(anchor, entry_id))`。`not-write-back` 若已提升为 `memory_entries.not_write_back BOOLEAN` 列（见问题 3 建议）则可消解。 |
| 6 | **重要** | 迁移路径 | **记忆系统迁移声明"MemoryStore 接口保留、实现替换"忽略了 `MemoryPipeline` 的直接 FS 依赖。** Spec C §4.2 和 §5 明确说 MemoryStore 接口保留，但 `MemoryPipeline`（`pipeline.ts`）不通过 MemoryStore 接口——它用自己的 `appendJsonl()/readJsonl()/rewriteJsonl()` 方法直接操作 `buffer.jsonl`、`idem.jsonl`、`buffer-consumed.jsonl`、`retry-count.jsonl`、`not-write-back.jsonl` 五个文件（`pipeline.ts:109,141,150,250`）。这些内部文件 I/O 必须全部改为 pg 访问。**迁移成本被低估**——不是"接口保留实现替换"，而是 pipeline 内部实现需全部重写。 | 扩展迁移路径，明确列出 `MemoryPipeline` 的迁移项：`observe()` → INSERT INTO memory_buffer；`write()` → pg 事务内幂等检查 + 重试计数 upsert + MemoryStore 写入；`flushBuffer()` → DELETE consumed rows；`pruneIdem()` → DELETE WHERE watermark > S；`notWriteBackIds()` → SELECT FROM memory_entries WHERE not_write_back = TRUE。 |
| 7 | **重要** | Schema / 记忆 | **`memory_entries.anchors` 允许空数组——违反"锚点非空"不变量。** 记忆系统 spec §2 不变量 5："锚点非空——写入即校验；无锚点拒绝"。现有 `validateEntryStructure()`（`entry.ts:79-81`）显式检查 `anchors.length === 0` 并报错。但 spec C §2.2 的 `memory_entries` DDL 写的是 `anchors JSONB NOT NULL DEFAULT '[]'`——允许空数组入库。pg 没有原生 JSONB 数组非空约束（需写 CHECK 触发器或 `CHECK(jsonb_array_length(anchors) > 0)`）。 | 添加 `CHECK (jsonb_array_length(anchors) > 0)` 约束，并在注释中标注此为不变量 5 的实现面。 |
| 8 | **重要** | Schema / 任务池 | **`tasks` 表缺少 `status` 的 CHECK 约束——六状态机无数据库层守卫。** 现有 SQLite 有 `CHECK(status IN (...))` 的前例（如 `lab_scheduler_drafts` 和 `scheduled_jobs`），spec C 的 `tasks` DDL 只用 `status TEXT NOT NULL DEFAULT 'pending'`，没有 CHECK。任何代码 bug 写出非法状态（如 `'calimed'` 拼写错误）将静默写入。 | 添加 `CHECK (status IN ('pending','claimed','submitted','completed','rejected','escalated'))`。同理 `memory_entries.status` 应为 `CHECK (status IN ('draft','official','archived'))`。 |
| 9 | **重要** | 数据归位 / 边界 | **Redis/FS 边界划分存在 split-brain 风险。** Spec C §3 说"锁 workflow:\* lock/token 留 Redis"，但 `workflow/orchestrator.ts` 的 `WorkflowOrchestrator` 同时操作 Redis 锁（`workflow:<id>:lock` + `workflow:<id>:token`）和 Redis 状态（`workflow:<id>:state`）。若 v1 把任务/审计/转录全部迁到 pg，workflow 状态却留在 Redis（无持久化保证），pg 中的 `tasks` 和 Redis 中的 `workflow:<id>:state` 将不同步——Redis 重启后 workflow 状态丢失，但 pg 中的 task 状态还在，形成"任务已完成但 workflow 等待中"的僵尸态。 | 裁决：workflow 状态是否也迁 pg？若留 Redis，必须声明 Redis 重启后 workflow 状态的恢复策略/空窗期处理。至少文档化此次级风险。 |
| 10 | 重要 | 迁移路径 | **`agent-lab.db` 迁移范围缺失 scheduler/optimizer/agent-instance 表。** Spec C §4.1 迁移表只列了 tasks/task_templates + lab_events + credit_tx。但现有 schema.ts 有 15 个表，包括 `lab_scheduler_drafts`、`lab_scheduler_instances`、`lab_optimization_rounds`、`lab_agent_instances`、`lab_routing_bindings`、`lab_optimizer_instances`、`lab_proposals`、`scheduled_jobs`、`event_subscriptions`、`lab_namespace_kv`。哪些迁 pg？哪些留 SQLite？哪些废弃？spec 和总纲裁决 20（"选择性迁移"）都没有明细。如果这些表留在 SQLite 而 tasks/events 进 pg，会造成跨库查询（如"agent X 的历史任务与 selector 配置"需要 join SQLite 的 `lab_agent_instances` 和 pg 的 `tasks`）——查询被拆垮。 | 明确 agent-lab.db 中每个表的归属：迁 pg / 留 SQLite / 废弃。若选定"留 SQLite"，需声明跨库查询限制及未来统一计划。 |
| 11 | 次要 | Schema / 语义 | **`memory_entries.status` 默认 `'draft'` 与 MemoryEntry 构造默认 `'official'` 冲突。** Spec C DDL 设置 `status TEXT NOT NULL DEFAULT 'draft'`，但 `createEntry()`（`entry.ts:38`）默认 `status: input.status ?? "official"`。这意味着如果代码调用 `createEntry({...})` 不传 status，内存中的 entry 是 `official`，INSERT 到 pg 时若未显式写 status 列，pg 会默认成 `draft`——数据不一致。 | 对齐默认值。建议 pg DDL 默认 `'official'`，与 MemoryEntry 构造一致。`draft` 状态应由调用方显式设置（通常来自 pipeline 的 `sinkDraft()`）。 |
| 12 | 次要 | Schema / 索引 | **缺少 `idx_tasks_claimed_by` 和 `idx_tasks_claimed_at` 索引。** `SqliteTaskStore.list({ claimedBy })`（`taskpool/tasks.ts:63`）和 stale 回收扫描 (`taskpool/engine.ts:107` WHERE status='claimed') 都需要按 `claimed_by` 和 `claimed_at` 查询。pg DDL 只有 `idx_tasks_status`、`idx_tasks_tags`、`idx_tasks_created`，缺少 claimed 相关索引。 | 添加 `CREATE INDEX idx_tasks_claimed_by ON tasks(claimed_by, status)` 和 `CREATE INDEX idx_tasks_claimed_at ON tasks(claimed_at) WHERE status='claimed'`（部分索引）。 |
| 13 | 次要 | 迁移路径 | **`memory_entries` DDL 缺少 `meta.createdAt` 和 `meta.updatedAt` 的独立时间戳列映射。** 现有 `MemoryEntry.meta.createdAt` 和 `meta.updatedAt` 是毫秒时间戳（`Date.now()`），而 pg DDL 只提供了 `created_at TIMESTAMPTZ` 和 `updated_at TIMESTAMPTZ`。迁移时需明确：`meta.createdAt` → `created_at`（毫秒 → TIMESTAMPTZ）的转换，以及 `meta.updatedAt` → `updated_at` 的映射。但这些在 meta JSONB 中也有副本——会产生"meta.createdAt 和 created_at 列谁是真的"这种双源模糊。 | 删除 `meta` JSONB 中的 `createdAt`/`updatedAt` 字段，仅使用 `created_at`/`updated_at` 列作为真相源。迁移脚本需做数据转换。 |
| 14 | 次要 | 完整清单 | **`skills` 表和 `component_meta` 表的 DDL 完全空白。** Spec C §2.3 只说"结构与上表同风格"，但 skills 作为"记忆的一种"（总纲裁决 4），其表结构是否应与 `memory_entries` 同构？是否也走同一套 status/anchors/version 语义？`component_meta` 要替代 Redis 的 `components:*` 全家桶（scout-8 §4.1），如果只是"id + JSONB + 时间戳"，能否承载 component GC 的 `bytes` 追踪和 `next` 计数器？ | 给出 skills 和 component_meta 的初始 DDL。建议 skills 可以就是 `memory_entries` 的 `kind='skill'` 视图（不建独立表——总纲裁决 3"skill 是记忆的一种"），避免冗余存储和同步问题。component_meta 需能支持现有的版本管理/GC/列表语义。 |

---

## 补充：Spec C 与现有实现的关键不匹配速查

| Spec C 的 tasks DDL | 现有 SqliteTaskStore 依赖 | 后果 |
|---|---|---|
| `title TEXT` / `description TEXT` | `text TEXT NOT NULL`（完整任务文本） | 任务内容丢失——`text` 列承载了实例化后的完整执行指令 |
| 无 `claimed_by` 列 | `claimed_by TEXT`（认领者 + submit/reject 守卫） | claim/submit/reject/stale 回收全部不可实现 |
| `tags TEXT[]` + GIN | `labels TEXT`（JSON string[] 解析为 `string[]`） | sorter 的 `labelPatterns` 正则需要适配 TEXT[] 匹配 |
| `rejected_reasons JSONB` | `rejects TEXT`（`RejectRecord[]` 含 agentId） | 排除名单推导依赖 `rejects[].agentId`——`rejected_reasons` 必须保留 agentId |
| 无 `created_by` | `created_by TEXT NOT NULL` | 审计断链——不知道谁发布了任务 |
| `payload JSONB` 替代 `params` | `params TEXT`（`Record<string,unknown>`） | 语义等价但字段名不兼容 |
| 无并发控制声明 | WAL + 单写者 `changes()===1` | pg 多连接下 claim 可能被竞态 |

---

## 总结：是否可批准

**不可批准（有 4 个 Blocker）。**

这份 spec 的正确部分（数据归位边界、引用而非复制、MemoryStore 接口保留）被关键遗漏严重削弱：

### 主要风险

1. **`tasks` DDL 与任务池 spec/实现断裂**（Blocker #1）——spec C 的 tasks 表不是任务池 spec 的"迁移到 pg"，而是"重新设计了一张不同的表"。缺少 `claimed_by`、`text`、`created_by`、`rejects` 四列意味着所有任务池机械层代码（`SqliteTaskStore` 的 claim/submit/reject/reflow/requeue/escalate）需要重写而非简单迁移。**修复成本远高于作者估计。**

2. **并发控制真空**（Blocker #2）——spec 对 pg 的并发语义零描述。SQLite 单写者模型默默被替换为 pg 多连接模型，但所有 `UPDATE ... WHERE status='pending'` 的原子性假设需要显式的锁策略才能延续。

3. **`meta JSONB` 压缩破坏记忆语义**（Blocker #3）——hitCount 旁路、notWriteBack 查询、version CAS 这三个核心语义被压入单一 JSONB 列，直接影响实现复杂度、性能和正确性。

4. **memory_pipeline 无 DDL**（Blocker #4）——管道是记忆系统的写入入口，5 种文件结构需全部映射到表，但 spec 只有一句"从略"。

### 修复优先级

- **修 Blocker #1 和 #2 后** → tasks 表可以承载现有任务池语义
- **修 Blocker #3 和 #4 后** → 记忆系统可以安全迁移到 pg
- **修 Important #5-10 后** → spec 可以进入实现阶段
- **Minor #11-14** → 实现阶段逐项消化

### 建议

在重新提交审批前：① 对照 `SqliteTaskStore` 逐列验证 tasks DDL；② 明确并发方案（推荐 `SELECT ... FOR UPDATE SKIP LOCKED`）；③ 给出 memory_pipeline 和 memory_index 完整 DDL；④ 将 hitCount/version/notWriteBack 提为独立列。
