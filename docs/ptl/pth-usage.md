# PTH 使用说明（PTL 侧用户手册）

> 适用对象：PTL（Pi-Triple 运维框架）侧用户——通过 `ptl hub` 与 REST API 使用 PTH 任务池。
> 相关文档：`docs/pth/orchestration.md`（编排分工）、`docs/pth/agent-construction.md`（构建体系）。
> 文中 `$PTH_API` 为 PTH 网关地址占位符（示例用 `http://localhost:8787`——请替换为你的网关地址；`ptl hub` 命令自动使用已配置的网关）。

---

## 0. 一分钟认识 PTH

PTH（Pi-Triple-Heavy）= **服务器端任务内核**：任务池 → 角色路由 → worker 执行 → 产物提交 → 应用。

对 PTL 侧用户，PTH 是一台**异步任务机器**：你提交任务（指定角色或标签）→ PTH 自动路由到合适角色、
分配 worker 执行 → 你查询状态 / 收取产物。角色可以**分化生长**（树状谱系），事件可以**链式触发**下游任务。

核心概念：
- **角色（role）**：任务的执行者——每个角色有职责、标签语义、推理深度、验收角色、能力白名单
- **谱系（lineage）**：角色从 Origin 根按任务分化出的树状结构——叶子角色=专门化执行者
- **任务（task）**：`{title, text, tags?, payload?}`——发布后经 role-router 确定性路由
- **trigger**：事件→任务的映射——`task.done` 等事件自动发布下游任务（链式编排）
- **refine**：任务完成后的自动提炼——沉淀工具函数/经验/角色分化建议

---

## 1. 角色谱系（lineage）

### 1.1 谱系树结构：origin → 中间层 → 叶子

所有角色从 **Origin（generation 0，全能起点）** 分化而来。内置 13 个角色：

```text
origin (gen 0 · 全能 · tags ["origin"] · thinking high · accepter writer)
├── human-interface (gen 1 · human/interact · writer)
├── explorer (gen 1 · explore/survey · 信息类任务族 · medium)
│   ├── analyst (gen 2 · analysis/research · medium)
│   └── scout  (gen 2 · recon/investigate · thinking low——快侦察)
├── governor (gen 1 · govern/oversight · 治理类任务族 · high · read-only)
│   ├── planner (gen 2 · plan/design · high · read-only)
│   ├── memory-keeper (gen 2 · memory/organize · medium)
│   └── acceptor (gen 2 · accept/verify · high · read-only)
│       └── verifier (gen 3 · 独立验证/结果计算 · high · writer)  ← 谱系分化的实例
└── executor (gen 1 · execute/deliver · 执行类任务族 · high · writer)
    ├── developer (gen 2 · implement/code/fix · high · writer)
    └── tester   (gen 2 · test/qa/verify-func · high · writer)
```

角色元数据（每角色一份，存 memory `kind='role-doc'`）：
- `谱系代数`：从 Origin 起的层数（0=根，叶子可到 3+）
- `父角色`：分化来源（树边）
- `任务类型`：该角色负责的任务标签语义（路由依据之一）
- `推理深度`：`high | medium | low`——传给 LLM 的 thinking 档位
- `验收角色`：`writer`（可写产物）或 `read-only`（只读审查）
- `访问权限`：PTC 能力白名单（fs/memory/readSource/…）

### 1.2 查看谱系（ptl hub lineage tree / REST）

```bash
# ptl hub（推荐——自动用配置的网关）
ptl hub lineage tree

# REST：直接拿 JSON 树
curl -s $PTH_API/api/v1/kernel/lineage
```

响应结构（每个节点）：`{ id, generation, thinking, acceptanceRole, differentiation, children: [...] }`。

### 1.3 分化建议（proposals / show）

分化建议由 **refine 任务 3**（见 §3）在任务完成后自动产出，存 memory `kind='differentiation-proposal'`，
状态为 **draft（待审核）**——**不会自动执行分化**（有监督自动化）。

```bash
# ptl hub
ptl hub lineage proposals                 # 列出全部建议
ptl hub lineage show <proposalId>         # 查看单条建议详情

# REST：按 kind + draft 过滤查 memory
curl -s "$PTH_API/api/v1/kernel/memory?kind=differentiation-proposal&status=draft"
```

建议内容示例（真实案例——verifier 角色的由来）：
```json
{
  "taskId": "d2a571af-...",
  "parent": "acceptor",
  "subtasks": [
    { "type": "独立验证", "description": "采用独立于原始算法的方法交叉校验结果",
      "capabilityNeeds": ["验证能力", "基础算术"], "frequency": "每次计算结果后出现" },
    { "type": "结果计算", "description": "执行基础算术运算得到结果" }
  ],
  "suggestedRole": { "id": "verifier", "parent": "acceptor",
    "specialization": "独立结果验证", "rationale": "验证步骤体现验收者核心价值" },
  "confidence": "high"
}
```

### 1.4 批准 / 拒绝（角色分化上线）

```bash
# 批准：注册新角色 → batch 热上线 → role-doc 注入
ptl hub lineage approve <proposalId>
# 可选 overrides：指定角色 id / 标签 / prompt / thinking / 能力 / 验收角色
ptl hub lineage approve <proposalId> --id my-role --label-patterns "code,implement"

# REST
curl -s -X POST $PTH_API/api/v1/kernel/lineage/approve -H "content-type: application/json" -d '
  {"proposalId": "diff-xxxx", "overrides": {
     "id": "my-role",
     "tags": ["code", "implement"],
     "thinking": "high",
     "acceptanceRole": "writer"
  }}'

# 拒绝：draft → archived
ptl hub lineage reject <proposalId>
curl -s -X POST $PTH_API/api/v1/kernel/lineage/reject -H "content-type: application/json" -d '{"proposalId":"diff-xxxx"}'
```

**批准后的上线动作（系统自动完成）**：
1. 校验 proposal 为 `draft`（否则 409）；角色 id 冲突返回 409
2. 构造新角色：`generation = 父角色代数 + 1`；固定 tags 从 subtasks 派生（缺省 `[roleId]`）；prompt 自动生成
3. 主进程注册（`registerWorkerRole`——即刻可路由）
4. 广播 batch（`registerRoleToBatches`——batch 内注册 + 创建 worker——**热上线，即刻接任务**）
5. 注入 role-doc（worker 读自己文档）
6. proposal 状态 `draft → official`（approved）；reject 则 `draft → archived`

### 1.5 给任务指定角色（flow role 定向 / tags）

提交任务时路由规则（role-router v2，**确定性路由到唯一角色**——2026-08-10 任务池纯化）：

```text
① payload.flow 显式 role（flow 任务自带路由）→ 最高优先
② tags 精确匹配角色固定标签（tag-registry——分选器唯一标准）
③ 无匹配 → publish 拒绝（400——hash 分片兜底已废止；未知/歧义标签同样 400）
```

严格校验（publish 唯一入口）：未知标签 → 400 带已注册标签表；无角色标签且无 flow → 400；
多角色歧义 → 400。任务池只面向自然语言（agent 循环）——代码级直连执行走 `POST /api/v1/kernel/exec`。

```bash
# 直接发布（tags 语义路由——"code" → developer）
curl -s -X POST $PTH_API/api/v1/kernel/tasks -H "content-type: application/json" -d '
  {"title": "实现用户登录", "text": "实现登录接口并写测试",
   "createdBy": "ptl", "tags": ["code", "implement"]}'

# flow 显式定向（body.flow 顶层并入 payload——API 友好）
curl -s -X POST $PTH_API/api/v1/kernel/tasks -H "content-type: application/json" -d '
  {"title": "验收侦察结果", "text": "检查侦察产物质量", "createdBy": "ptl",
   "flow": { "stages": [{ "task": { "role": "acceptor" } }] }}'

# 任务模板发布（recon-doc / memory-maintain / dev-task / dev-task-ts）
curl -s -X POST $PTH_API/api/v1/kernel/tasks -H "content-type: application/json" -d '
  {"template": "recon-doc", "params": {"url": "https://example.com/doc", "section": "安装"}, "createdBy": "ptl"}'
curl -s $PTH_API/api/v1/kernel/templates        # 模板列表
```

常用标签 → 角色映射（角色固定标签——tag-registry 精确匹配）：

| 标签 | 路由角色 | 推理深度 | 验收角色 |
|---|---|---|---|
| `code` / `implement` / `fix` | developer | high | writer |
| `plan` / `design` | planner | high | read-only |
| `test` / `qa` / `verify-func` | tester | high | writer |
| `recon` / `investigate` | scout | low | — |
| `analysis` / `research` | analyst | medium | — |
| `accept` / `verify` | acceptor | high | read-only |
| `memory` / `organize` | memory-keeper | medium | — |
| `execute` / `deliver` | executor | high | writer |
| `explore` / `survey` | explorer | medium | — |
| `govern` / `oversight` | governor | high | read-only |
| `*` | origin（全能兜底） | high | writer |

任务体积限制：`title ≤ 200 字符`、`text ≤ 64KB`（超限 400）。

---

## 2. trigger（事件触发任务）

Trigger = **事件 → 任务** 的映射：订阅 batch 活动事件，匹配成功即自动发布下游任务（链式编排的**系统级**形态）。
定义存 memory（`kind='trigger'`——数据化，CRUD 经 API，不改代码）。

### 2.1 CRUD

```bash
# 列表
curl -s $PTH_API/api/v1/kernel/triggers

# 创建（示例：scout 任务完成后自动派验收任务）
curl -s -X POST $PTH_API/api/v1/kernel/triggers -H "content-type: application/json" -d '
  {
    "name": "侦察后验收",
    "event": "task.done",
    "match": { "role": "scout" },
    "task": { "title": "验收侦察结果 {{taskId}}", "text": "检查 {{taskId}} 的侦察产物质量",
              "role": "acceptor", "tags": ["auto-chain"] },
    "enabled": true,
    "once": false,
    "maxFires": 10
  }'

# 启用 / 禁用
curl -s -X POST $PTH_API/api/v1/kernel/triggers/<id>/toggle -H "content-type: application/json" -d '{"enabled": false}'

# 删除
curl -s -X DELETE $PTH_API/api/v1/kernel/triggers/<id>

# 立即重载（引擎默认 30s 周期从 memory 重载——reload 为即时生效通道）
curl -s -X POST $PTH_API/api/v1/kernel/triggers/reload
```

### 2.2 事件类型（event）

trigger 订阅的是 **ActivityEvent.kind**（batch 子进程经 IPC 上报主进程的活动事件）：

```text
task.claim   任务被 worker 认领
agent.step   agent 循环单步（含 token 用量）
agent.tool   agent 工具调用
task.done    任务完成（ok=true）
task.failed  任务失败（ok=false，detail=错误摘要）
```

### 2.3 match / 模板变量 / once / maxFires

**match**（可选，都满足才触发）：
- `match.role`：事件 `role` 精确匹配
- `match.detailContains`：事件 `detail` 子串包含（如错误摘要、结果预览）

**模板变量**（`{{xxx}}` 渲染进 task.title / task.text）：`{{taskId}}`、`{{role}}`、`{{detail}}`

**once**（防链式爆炸）：触发一次后自动 `enabled=false`（内存移除 + 持久层同步写回）

**maxFires**（防链式爆炸）：最大触发次数上限，达到后跳过（`fireCount >= maxFires`）；缺省不限

**发布任务附加信息**：`createdBy = trigger:<name>`、`tags` 缺省 `["triggered"]`、`payload` 带 `triggeredBy` + `chainDepth`

### 2.4 防链爆规则（内置三道防线）

```text
① 自触发阻断：trigger 发布的任务完成 → 事件带 triggerId → 同 trigger 不因自己的下游再触发
② 全局深度限制：triggeredBy 链长 > 5（MAX_CHAIN_DEPTH）不再触发
③ 上限兜底：once / maxFires 由用户按需配置
```

即：`A → B → C → …` 的触发链最长 5 层；同一 trigger 不会形成自我循环。

### 2.5 与 flow 的分工（编排分工）

- **trigger**：**系统级**链式编排——依据运行时事件（task.done 等）自动发下游任务，在任务池内部闭环
- **flow**：**用户级**工作流编排——交互层（PTL）声明 stages，发布时 `payload.flow` 显式指定角色路由
- 二者互补：flow 定"这次任务怎么走"，trigger 定"系统事件发生后自动做什么"
- 详见 `docs/pth/orchestration.md`（编排分工）与 `docs/pth/agent-construction.md`（构建体系）

---

## 3. refine（任务后自动提炼）

默认 **auto**：任务完成后自动对解释器快照做 LLM 提炼 → 双通道持久化 → 写 refine-report。

### 3.1 三任务默认行为

refine 任务清单存 memory `kind='refine-task'`（真相源；缺失时 fallback 内置默认）。默认三任务：

| # | 任务 id | 干什么 | 产出（memory kind） | 状态 |
|---|---|---|---|---|
| 1 | `functions` | 提炼可复用工具函数（source 与快照一致 + spec 构造文档——pickle 哲学：迁移环境按 spec 重建） | `tool-function` | official |
| 2 | `insights` | 提炼任务经验/洞察 | `task-insight` | official |
| 3 | `differentiation` | 角色分化分析：分析执行轨迹中反复出现的子任务模式 → 建议分化（subtasks + suggestedRole） | `differentiation-proposal` | **draft（待审核）** |

任务 3 的产物**不自动执行分化**——仅记录待确认；由监督层（你）经 `ptl hub lineage approve/reject` 流转（见 §1.4）。

**降级**：LLM 输出解析失败 → 函数源码原样保存（无 spec）——不 crash、不阻塞任务完成。

### 3.2 refine-task 清单演化（禁用 / 自定义）

refine 任务"分析什么 / 输出什么 / 存到哪"全部**数据化**：新增任务 = memory 加一条定义，**不改代码**。

RefineTaskDef 结构：
```json
{
  "id": "my-task",
  "promptRules": ["- my-task: 分析快照中的 xxx，输出 yyy"],
  "outputField": "myField",
  "outputSchema": "\"myField\": [\"<值>\"]",
  "persistKind": "my-kind",
  "persistAs": "raw",
  "enabled": true
}
```

- **禁用某个任务**：把该条 `enabled` 改为 `false`（加载时跳过）
- **新增自定义任务**：向 memory 写入一条 `kind='refine-task'` 定义（`persistAs="raw"`）——输出按 `outputField` 原样提取，
  写入 `persistKind`，默认状态 **draft**（与分化建议同治理——监督层审）
- **管理面**：
  - REST：`GET /api/v1/kernel/memory?kind=refine-task`、`GET /api/v1/kernel/memory/:id`
  - 直接 PG：`memory_entries` 表（kind/status/anchors/content/meta JSONB）

### 3.3 PTH_REFINE=off（关闭自动提炼）

```bash
# 启动 PTH 时设置——关闭任务完成后的自动 refine
PTH_REFINE=off pth start        # 默认（不设）= auto
```

`batch-process` 读取 `process.env.PTH_REFINE !== "off"` 决定是否实例化 Refiner。
关闭后任务照常执行/提交产物，只是不自动沉淀 memory。

**refine 管线全貌**：任务完成 → 快照（ts/py/c 三 kernel）→ LLM 提炼 → 解析（容错）→ 双通道持久化
（functions→`tool-function`、insights→`task-insight`、diff→`differentiation-proposal`）→ 写 `refine-report`
（内容形如"提炼 X 个工具函数 + Y 条经验"）→ 性能计量 IPC 上报。

---

## 4. 观测（ptl hub console / REST）

### 4.1 ptl hub console

```bash
ptl hub console --follow        # 实时活动流（task.claim / agent.step / task.done ...）
ptl hub console --kernel        # kernel 状态（batches + 任务状态计数 + watchdog crashLog）
ptl hub console --sandbox       # sandbox 状态（kernel 池 inFlight/idle/capacity + 编译统计 + debug 会话）
```

数据面（REST 等价）：
- `--follow` ← `GET /api/v1/kernel/events`（SSE 流——activityHub 广播，新订阅者先补回放再实时）
- `--kernel` ← `GET /api/v1/kernel/status`（batches 列表 + `SELECT status, count(*) FROM tasks GROUP BY status` + watchdog.crashLog）
- `--sandbox` ← `GET /api/v1/kernel/sandbox`（代理 `sandbox:8080`，可用 `PTH_SANDBOX_KERNEL_URL` 覆盖）

### 4.2 任务状态查询

```bash
# 任务列表（?limit= 默认 50，最大 200）
curl -s "$PTH_API/api/v1/kernel/tasks?limit=50"

# 单任务详情（DB 行：status / assigned_role / claimed_by / tags / payload / job_id ...）
curl -s $PTH_API/api/v1/kernel/tasks/<taskId>

# 状态总览
curl -s $PTH_API/api/v1/kernel/status
```

任务状态机（DB CHECK 约束）：
```text
pending → claimed → submitted → completed
                  ↘ rejected / escalated
```

### 4.3 transcript 获取（agent 执行轨迹）

```bash
curl -s $PTH_API/api/v1/kernel/tasks/<taskId>/transcript

# 返回：{ taskId, transcripts: [
#   { id, agentId, summary, events: [
#       {type:"llm-call"|"tool-call"|"tool-result"|"finish", step, tool, contentPreview, resultPreview, ...}
#   ]}] }
```

用于审计：任务是怎么被执行的、调了哪些工具、每步结果预览、是否成功（finish.ok）。

### 4.4 job 委托（一次提交多任务，脱手收取）

```bash
# 提交 job（计划 → 多任务批量发布）→ 立即返回 jobId，主会话不阻塞
curl -s -X POST $PTH_API/api/v1/kernel/jobs -H "content-type: application/json" -d '
  {"name": "调研批次", "plan": "三步调研", "tasks": [
     {"title": "调研 A", "text": "……", "tags": ["analysis"]},
     {"title": "调研 B", "text": "……", "tags": ["analysis"]}
  ]}'

curl -s $PTH_API/api/v1/kernel/jobs          # job 列表（job_id → 任务数/完成数/状态聚合）
curl -s $PTH_API/api/v1/kernel/jobs/<jobId>  # job 详情（任务明细 + 产物 outputRef）
```

### 4.5 memory 查询（沉淀层）

```bash
# 按 kind/status/anchor 过滤（逗号分隔多值）
curl -s "$PTH_API/api/v1/kernel/memory?kind=task-insight,differentiation-proposal&status=draft"
curl -s $PTH_API/api/v1/kernel/memory/<id>
```

---

## 5. REST API 速查索引

```text
POST   /api/v1/kernel/tasks                     提交任务（{title,text,createdBy,tags?,payload?,flow?} 或 {template,params}）
GET    /api/v1/kernel/tasks                     任务列表（?limit=）
GET    /api/v1/kernel/tasks/:id                 任务详情
GET    /api/v1/kernel/tasks/:id/transcript      任务执行轨迹
GET    /api/v1/kernel/templates                 任务模板列表

POST   /api/v1/kernel/jobs                      提交 job（多任务批量）
GET    /api/v1/kernel/jobs                       job 列表
GET    /api/v1/kernel/jobs/:id                   job 详情（含产物 outputRef）

GET    /api/v1/kernel/lineage                   谱系树
POST   /api/v1/kernel/lineage/approve           批准分化建议（注册新角色）
POST   /api/v1/kernel/lineage/reject            拒绝分化建议

GET    /api/v1/kernel/triggers                   trigger 列表
POST   /api/v1/kernel/triggers                   创建 trigger
POST   /api/v1/kernel/triggers/:id/toggle        启用/禁用
DELETE /api/v1/kernel/triggers/:id               删除
POST   /api/v1/kernel/triggers/reload            立即重载

GET    /api/v1/kernel/status                     kernel 状态（batches + 任务计数 + watchdog）
GET    /api/v1/kernel/events                     SSE 活动事件流
GET    /api/v1/kernel/sandbox                    sandbox 状态（kernel 池/编译/debug）
GET    /api/v1/kernel/batch                      batch 列表
POST   /api/v1/kernel/batch/add                  启动 batch（?role=&copies=&count=）
POST   /api/v1/kernel/batch/:id/workers          worker 级控制（pause/resume/remove/add）
POST   /api/v1/kernel/batch/remove               移除 batch
GET    /api/v1/kernel/memory                      memory 查询（?kind=&status=&anchor=&limit=）
GET    /api/v1/kernel/memory/:id                 单条 memory
```

## 6. 相关环境变量

```text
PTH_REFINE                off 关闭任务后自动 refine（默认 auto）
PTH_SANDBOX_KERNEL_URL    默认 http://sandbox:8080（--sandbox 数据面代理目标）
SANDBOX_SHARED_SECRET     网关→sandbox 调用共享密钥
PTH_WORKER_ROLES          启用后可配置 worker 角色集
PTH_BATCH_TS              batch 进程 TS 运行时
PTH_TOOLSTORE_PATH        toolstore 路径
PTH_SOURCE_ROOT           源码根
PTH_CLAIM_TIMEOUT_MS / PTH_CLAIM_REAP_MS   认领超时/回收周期
PTH_AUTOSCALE_MODE / PTH_AUTOSCALE_ROLE_THRESHOLD / PTH_AUTOSCALE_REINFORCE_COPIES   batch 自动伸缩
```

---

## 7. 常见操作组合（场景速查）

**场景 A：跑一个开发任务并确认它被正确路由**
```bash
ptl hub lineage tree                       # 认识角色
curl -s -X POST $PTH_API/api/v1/kernel/tasks -H "content-type: application/json" \
  -d '{"title":"实现X","text":"……","createdBy":"ptl","tags":["code"]}'
curl -s $PTH_API/api/v1/kernel/tasks/<taskId>          # 看 assigned_role=developer
curl -s $PTH_API/api/v1/kernel/tasks/<taskId>/transcript   # 看执行轨迹
```

**场景 B：事件驱动链式编排（侦察 → 自动验收）**
```bash
curl -s -X POST $PTH_API/api/v1/kernel/triggers -H "content-type: application/json" -d '
  {"name":"侦察后验收","event":"task.done","match":{"role":"scout"},
   "task":{"title":"验收 {{taskId}}","text":"检查 {{taskId}} 产物","role":"acceptor","tags":["auto-chain"]},'
  ' "once":true}'
ptl hub console --follow                    # 观察触发链
```

**场景 C：角色分化治理**
```bash
ptl hub lineage proposals                   # 看 refine 任务3 产出的 draft 建议
ptl hub lineage show <proposalId>
ptl hub lineage approve <proposalId> --id new-role --label-patterns "new-tag"   # 上线
ptl hub lineage tree                        # 确认新节点
```

**场景 D：关掉自动提炼**：启动时 `PTH_REFINE=off`；或禁用单个任务：把 `refine-task` 条目 `enabled=false`。

### 2.6 trigger CLI（ptl hub trigger——v0.8 新增）

PTH 侧已提供命令族（`ptl hub trigger`），与上面 API 等价：

```bash
ptl hub trigger ls                                # 列表（id/name/event/match/enabled）
ptl hub trigger add --name "侦察后验收" --event task.done \
    --role scout --task-title "验收 {{taskId}}" --task-text "检查侦察产物" \
    --json '{"task":{"role":"acceptor"}}' --once   # --role=匹配条件；任务角色 task.role 经 --json 合并
ptl hub trigger add --json '{"name":"x","event":"task.failed","task":{"title":"告警","text":"分析"}}'
ptl hub trigger toggle <id> [--on|--off]          # 启用/禁用（缺省翻转）
ptl hub trigger rm <id>                           # 删除（archived）
ptl hub trigger reload                            # 立即重载（引擎 30s 周期外的即时生效）
```

> 注意：`--role` 在 trigger add 中 = **匹配条件**（match.role——谁完成触发）；
> 触发任务的执行角色写在 `task.role`（可经 `--json` 携带完整 task 对象）。
