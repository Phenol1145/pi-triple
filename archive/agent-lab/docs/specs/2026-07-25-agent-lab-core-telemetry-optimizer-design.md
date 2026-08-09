# Agent Lab — Core + 遥测(M1) + 选择优化器(M2, MVP) 设计稿

- **日期**：2026-07-25
- **状态**：设计已确认（待实现规划）
- **子项目范围**：Agent Lab 平台的第一个子项目 = **共享核心(Core) + 遥测追踪(M1) + 模型选择优化器(M2, MVP)**
- **扩展名**：`agent-lab`
- **项目根**：`~/.pi/agent/extensions/agent-lab/`
- **明确不在本子项目范围**：Prompt 库(M3)、实验运行器(M4)、因素归因/分析(M5)、Agent Arena（市场/生态游戏层）。它们是后续独立子项目，均构建在本子项目交付的核心之上。

---

## 1. 概述与目标

Agent Lab 是一个 pi 扩展平台，用于**用数据驱动的方式选择模型**。本子项目交付其地基与第一个闭环：

1. **枚举候选模型** = {OpenRouter 免费模型} ∪ {用户持 key 的直连厂商自家模型}，并整合每个模型的**成本 / 性能 / 基准**。
2. **遥测(M1)**：自动记录每次 subagent 运行的 `(角色, 模型, 完成度, token, 成本, 工具成功与否, …)`，信号集合**可扩展**。
3. **选择优化器(M2, MVP)**：基于"实测完成度 + 性价比 + 性能 + 基准"的**加权融合**为某角色推荐模型（冷启动回退静态特征），并能在 subagent **派发前自动应用**推荐模型（带确认、可记住角色）。

平台远景（后续子项目）：版本化 Prompt 库、受控实验（拆解 模型/Prompt/工具 各自影响）、因素归因分析，以及 Agent Arena（credits 市场经济 + 涌现生态）。

## 2. 关键决策记录（brainstorming 结论）

| 维度 | 决策 |
|------|------|
| 形态 | **C** — 持久化扩展/工具（非一次性脚本/咨询）|
| 数据源 | **A** — 以 **OpenRouter 结构化数据为主**（实测确认 deepseek/qwen/kimi/glm 等直连厂商均被 OR 收录且带定价）；官网抓取**不**作为主力（脆弱、需额外 key），仅作可选备注 |
| 候选范围 | `{OR 免费模型: pricing=0 或 :free}` ∪ `{直连厂商自家模型}`。直连厂商 = `deepseek, kimi, kimi-coding, zai, qwen-token-plan-cn`（**排除** `openrouter, artificialanalysis` 这两个数据源 provider）|
| 角色维度 | **可扩展**：以 pi-subagents 子 agent 角色为主 + 自定义任务类别；角色**自动发现**、新角色**冷启动友好**（非写死枚举）|
| 反馈信号 | **可扩展信号集合（稀疏向量）**；`acceptance` 为默认信号；**混合采集**：自动 acceptance 基线 + 手动评分覆盖 + 后期可选 LLM-judge |
| 选择策略 | **D** — **加权融合(MVP) → multi-armed bandit(进阶)**；含**性价比**项；冷启动回退静态特征 |
| M1 采集范围 | **D** — 自动追踪**所有 subagent 运行**（acceptance 信号干净）；主会话/自定义类别经 `/lab log` 手动或后期启发式补充 |
| M2 呈现/应用 | **C** — **派发前自动应用（带确认）** + "记住该角色"；设 `autoApply` **总开关**可降级为仅建议或关闭 |
| 存储架构 | **乙** — **SQLite 持久化**，藏在 `Store` 接口后（日后可换 JSONL/混合而不动上层）|

## 3. 架构

### 3.1 扩展布局（目录扩展）

```
~/.pi/agent/extensions/agent-lab/
├── index.ts            # 装配模块、注册钩子/命令/工具；异步 factory
├── package.json        # 声明依赖（SQLite 驱动等）
├── catalog/            # 模型目录层
├── store/              # SQLite 存储（Store 接口）
├── scorer/             # 纯函数打分引擎
├── telemetry/          # M1 观测钩子 + 手动补录
├── interceptor/        # M2 派发前自动应用
├── commands/           # 斜杠命令 + LLM 工具 agent_lab
└── docs/specs/         # 本设计稿等
```

### 3.2 模块职责

| 模块 | 职责 |
|------|------|
| `catalog/` | 枚举候选模型；拉取 成本/上下文/模态(OR 目录) + 性能(第三方表 throughput/latency/uptime) + 基准(Artificial Analysis)；本地 TTL 缓存 + 带超时的连通性探测。产出 `ModelInfo` |
| `store/` | SQLite 存储（`Store` 接口）：运行记录、角色→模型 pin、配置；提供 `(模型,角色)` 聚合查询（`GROUP BY`）|
| `scorer/` | **纯函数**打分：加权融合、冷启动回退、`recommend(role, topN)` 带理由；**无 I/O、可单测** |
| `telemetry/` | **M1**：钩 `tool_execution_end`/`tool_result`（`toolName === "subagent"`）解析信号写库；`/lab log` 手动补录 |
| `interceptor/` | **M2**：钩 `tool_call`（`subagent`），按角色推荐 → 已 pin 静默应用 / 未 pin 弹确认（可记住）→ 注入 `event.input.model`；受 `autoApply` 总开关控制 |
| `commands/` | 斜杠命令 + LLM 工具 `agent_lab` |
| `index.ts` | 装配；异步 factory 载入配置、开库、刷新目录缓存 |

### 3.3 `ModelInfo`（目录层产出）

```ts
interface ModelInfo {
  id: string;                 // provider/model（OpenRouter 风格 id）
  provider: string;
  name: string;
  contextWindow?: number;
  pricing?: { in: number; out: number };   // 每百万 token 美元；免费为 0
  perf?: { throughputP50?: number; latencyP50?: number; uptime7d?: number };
  benchmarks?: Record<string, number>;
  modalities?: string[];
  accessRoute: "free" | "direct" | "both"; // 免费(OR) / 直连(自家API) / 两者
}
```

### 3.4 SQLite Schema（核心表）

```sql
-- 每次运行一条（M1 遥测真源）
CREATE TABLE runs (
  id INTEGER PRIMARY KEY, ts INTEGER,
  role TEXT,            -- subagent 角色 / 自定义类别
  model TEXT,           -- 实际使用的模型 (provider/id)
  task_category TEXT,   -- 可选自定义任务标签
  acceptance TEXT,      -- auto|attested|checked|verified|reviewed|none|...
  completion REAL,      -- 由信号聚合出的完成度 (0..1)
  tokens_in INTEGER, tokens_out INTEGER, cost REAL,
  tool_success INTEGER, turns INTEGER, interrupted INTEGER,
  signals TEXT,         -- 可扩展信号 JSON（稀疏）；未来新信号往这里加
  source TEXT           -- auto | manual
);
CREATE INDEX idx_runs_role_model ON runs(role, model);

CREATE TABLE role_pin ( role TEXT PRIMARY KEY, model TEXT, updated_ts INTEGER );
CREATE TABLE config   ( key TEXT PRIMARY KEY, value TEXT );   -- 权重/开关等
-- 目录缓存表（可选）：catalog(id TEXT PRIMARY KEY, info TEXT, fetched_ts INTEGER)
```

> 聚合（完成率 / 平均成本 / 成功率 per `(model, role)`）用 `GROUP BY role, model` 视图/查询即可——这是选 SQLite 的主要理由。

### 3.5 SQLite 驱动

优先 `node:sqlite`（Node ≥ 22.5 内置、免原生构建）；不可用时回退 `better-sqlite3`。两者均封在 `Store` 接口后，日后可换 JSONL(方案甲)/混合(方案丙) 而上层不动。

## 4. 数据流

### 4.1 遥测采集（M1，自动）

```
subagent 运行结束
  → tool_execution_end / tool_result (toolName === "subagent")
  → telemetry 解析:
       role         ← 工具入参 input.agent
       model        ← subagent 结果里的已解析模型（缺失则回退到该角色解析模型）
       acceptance   ← result.acceptance.status
       tokens/cost  ← result.usage
       tool_success ← 子运行工具结果是否含 isError
       turns / interrupted ← 结果状态
  → completion = 完成度聚合（见 4.6）
  → store.appendRun({..., source:"auto"})
```

### 4.2 推荐（命令 / LLM 工具 / 拦截器共用）

```
recommend(role, topN)
  → catalog.candidates()      # 免费 + 直连模型（带成本/性能/基准）
  → store.aggregate(role)     # GROUP BY model: 完成率/平均成本/成功率/样本数
  → scorer.score(每个候选)    # 加权融合；无遥测 → 冷启动用静态特征
  → 排序 → Top-N + 每项理由（完成度↑ / 性价比↑ / 性能↑ / 冷启动）
```

### 4.3 派发前自动应用（M2）

```
tool_call (toolName === "subagent")
  → 若 autoApply 关 → 放行（可选仅 notify 建议）
  → role = input.agent
  → 若 role_pin 有记录 → input.model = pin（状态栏提示），放行
  → 否则 recommend(role, 1)
       → ctx.ui.confirm/select: 推荐模型 + 理由 + 备选 + [记住该角色]
       → 确认 → input.model = 推荐值；勾选记住 → store.setPin(role, model)
       → 取消/超时 → 不改动，放行原模型
```

### 4.4 目录刷新

异步 factory 启动时拉一次 + TTL 过期 / `/lab models --refresh` 手动刷新；结果缓存到本地（`catalog` 表或缓存文件），离线时用缓存。

### 4.5 手动补录

`/lab log <role> <model> [--rating N] [--task 类别]` → `appendRun(source:"manual")`，覆盖主会话 / 自定义类别。

### 4.6 完成度派生（默认，可配置）

- `acceptance` 等级映射为基础分：`reviewed 1.0 / verified 0.9 / checked 0.7 / attested 0.5 / auto 0.4 / none 0.2`（映射表可配置）。
- 其它信号修正（公式，系数可配置）：
  `completion = clamp( base(acceptance) − (interrupted ? interruptedPenalty : 0) − (1 − toolSuccessRate) × toolFailPenalty, 0, 1 )`
  其中 `toolSuccessRate` = 成功工具调用占比（无工具调用时记为 1）。
- **手动评分（`/lab log --rating`，1–5 归一化到 0–1）若存在则覆盖上式自动值**。
- 新信号类别只需写入 `signals` JSON 并在聚合函数中注册即可，无需迁移旧记录（稀疏）。

## 5. 错误处理（核心原则：fail-open，绝不拖垮宿主或阻断派发）

| 场景 | 处理 |
|------|------|
| **拦截器内任何报错**（打分/目录/库）| **放行原始 subagent 调用、不改动 model**，仅记日志——绝不阻断派发 |
| 遥测写库失败 | 记日志并跳过，绝不影响子 agent 运行或宿主 |
| 目录抓取失败 | 用本地缓存；无缓存则降级为本地注册表的直连模型（数据不全者标记）；抓取前做带超时的连通性探测 |
| acceptance/usage 解析缺失 | 记录**稀疏**信号，不丢弃该运行 |
| SQLite 打开/读写失败 | 经 `/lab doctor` 暴露；优雅禁用 agent-lab，命令报错提示，不崩溃宿主 |
| 确认超时/取消 | 不改动，按原模型放行 |
| 注入安全 | 仅当推荐模型在候选集且可解析时才注入；若违反 pi-subagents 已强制的 `modelScope` 允许列表 → 不注入（否则会使运行中止），降级为仅建议 |
| 并发写 | SQLite 串行写 + WAL |
| **隐私** | 遥测**只存元数据**（角色/模型/信号/token/成本），**默认不存 prompt 正文或任务内容**，全程本地；目录抓取仅访问用户已 `/login` 的 OpenRouter / Artificial Analysis。Prompt 内容留待 M3 单独处理 |

## 6. 配置（`config` 表 / `config.json`）

| 键 | 默认 | 说明 |
|----|------|------|
| `weights.completion` | 0.50 | 实测完成度权重 |
| `weights.costEffectiveness` | 0.25 | 性价比权重。成本口径 = 模型 **catalog 标价**（预测，按候选集归一化），非单次运行实测成本；免费模型成本=0 → 该项满分。实测 `runs.cost` 用于统计/报表，并可在进阶阶段反哺该估计 |
| `weights.performance` | 0.15 | 性能权重（吞吐/延迟）|
| `weights.benchmark` | 0.10 | 基准权重 |
| `autoApply` | `true` | M2 派发前自动应用总开关（可降级为仅建议/关闭）|
| `acceptanceScoreMap` | 见 4.6 | acceptance 等级 → 基础分映射 |
| `interruptedPenalty` | 0.30 | 运行被中断时从完成度扣除的量 |
| `toolFailPenalty` | 0.20 | 工具失败率 `(1 − toolSuccessRate)` 的惩罚系数 |
| `topN` | 3 | 推荐默认返回数 |
| `catalogTtlMs` | 21600000 | 目录缓存 TTL（默认 6 小时）|

> 权重与惩罚系数全部可配置；冷启动（某 `(model,role)` 无遥测）时，完成度项回退到静态代理（基准/归一化性能）并重新分配权重。

## 7. 命令与工具面

**斜杠命令：**
- `/lab recommend <role> [--top N]` — 该角色 Top-N 模型 + 分数 + 理由
- `/lab stats [role]` — `(model, role)` 遥测聚合（完成率/均成本/样本数）
- `/lab models [--refresh]` — 候选目录（免费 + 直连，含成本/性能）
- `/lab log <role> <model> [--rating N] [--task 类别]` — 手动补录
- `/lab pin <role> <model>` / `/lab unpin <role>` — 角色模型固定
- `/lab config [key value]` — 查看/修改权重与开关
- `/lab doctor` — 健康检查（库/目录/钩子状态）

**LLM 工具 `agent_lab`**（供主 agent 程序化调用）：
`action ∈ { recommend, stats, models, log, pin, config }`，参数与上述命令对应。

## 8. 测试策略

- **scorer 单测（纯函数）**：加权计算、冷启动回退（无遥测→静态特征 + 权重再分配）、免费模型性价比满分、排序与理由生成。无 I/O、确定性。
- **store 单测（临时 SQLite）**：`appendRun`、`GROUP BY role,model` 聚合正确性（完成率/均成本/样本数）、`role_pin` 读写、`config` 读写、稀疏 `signals` JSON 往返、建表/迁移。
- **catalog 单测（mock fetch）**：免费模型过滤（`pricing=0` / `:free`）、直连模型枚举（排除 `openrouter`/`artificialanalysis`）、`accessRoute` 标记（free/direct/both）、定价/上下文解析、TTL 缓存。
- **完成度派生单测**：acceptance→基础分映射、`interrupted`/`tool_success` 修正、手动评分覆盖。
- **telemetry 集成**：喂入伪造的 subagent `tool_result` 事件 → 断言写入正确的运行行。
- **interceptor 集成**：mock `ctx.ui.confirm` → 确认时 `input.model` 被改、取消不改、已 pin 静默应用、`autoApply` 关不改、`modelScope` 冲突不注入。
- **命令冒烟**：`/lab recommend|stats|models` 对 seeded 临时库返回格式正确的输出。
- **手动端到端**：装扩展 → 跑一个真实 subagent → 验证 `runs` 有新行 → `/lab recommend reviewer` 出排行榜 → 下次派发触发自动应用并确认注入。
- **测试框架**：`node --test`（与 pi-subagents 自身测试风格一致）；临时目录放 SQLite；catalog 用 mock fetch。

## 9. 与未来子项目的衔接

本子项目交付的核心是后续所有子项目的地基：

| 后续子项目 | 复用核心 |
|------------|----------|
| **M3 Prompt 库** | `store`（新增 prompts 表）、命令框架 |
| **M4 实验运行器** | `catalog`、`store`、运行舱概念、`scorer`（对比不同因素下的完成度/token）|
| **M5 因素归因/分析** | `store` 聚合、`scorer`、遥测信号 |
| **Agent Arena**（市场经济 + 涌现生态）| credits 账本=`store` 新表；完成度奖惩=`telemetry` 的 acceptance；每 token 成本=`catalog` 定价；赔率=`store` 历史完成率聚合；换模型=`interceptor`/M2 的 apply 机制；per-agent 记忆=`store` 新表 |

## 10. 实现期需验证的开放问题 / 风险

1. **subagent 结果中的"所用模型"字段**：需在实现时确认 `subagent` 工具结果是否直接含已解析模型；若无，回退到该角色的解析模型（`agent.model` / `modelSource`）。
2. **SQLite 驱动选择**：实现时探测 Node 版本决定 `node:sqlite` 或 `better-sqlite3`。
3. **turns / interrupted 来源**：确认 `tool_execution_end` 是否提供足够信息，或需读取异步运行工件（`status.json` / `events.jsonl`）。
4. **读取 `/login` 凭据**：经 `ctx.modelRegistry.getProviderAuth('openrouter' | 'artificialanalysis')` 取 key（复用 `openrouter.ts` 的做法）。
5. **第三方性能表 / AA 基准端点**：复用 `openrouter.ts` 中的 URL 与抓取逻辑（`https://openroutermodeltable.crashthatch.com/`、`/api/v1/benchmarks`、`artificialanalysis.ai`）。
6. **`modelScope` 交互**：注入前校验推荐模型不违反 pi-subagents 已强制的允许列表。
7. **Goodhart 风险（前瞻 Arena）**：虚拟 credits 与真实 token 成本之间的奖励对齐，是 Arena 子项目的核心设计点，本子项目暂不涉及，但遥测应保留足够信号（token/cost/完成度）以支撑后续对齐。

## 11. 本子项目内的分期交付建议

- **1a**：`store` + `catalog`（只读）+ `/lab models`
- **1b**：`telemetry` 钩子 + `/lab stats`
- **1c**：`scorer` + `/lab recommend`
- **1d**：`interceptor`（自动应用）+ `pin` + `config` + `/lab doctor`

每期可独立验证（见第 8 节测试），逐步交付闭环。
