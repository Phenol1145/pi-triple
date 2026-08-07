# 任务模板 + 任务池 + 分选器 设计（联邦地基二）

- **日期**：2026-08-06
- **状态**：设计（brainstorming 定稿，待用户审阅）
- **定位**：联邦地基第二阶段——任务从"投递"到"被 agent 接取执行"的完整环路。前序：信息摄入循环 v1（地基一，已交付：摄入管道 + 周期流 + 语义分解任务派发）。
- **战略背景**：已裁决"先做到自持状态、后尝试冷启动"（冷启动是受控实验，需设计态做参照系/保底/回退）。本设计是自持态基础设施的一部分——任务池+分选器+模板是两条路径（设计态建造 / 冷启动实验）共用的地基。

---

## 1. 背景：联邦架构语境

以下语境约束本设计（来自联邦设计讨论的收敛结论）：

1. **任务投递窗口**：任务进入系统的入口，两种投递策略——定时投递（timed-trigger/摄入周期流）与 PTL 投递（人工）。"窗口开闭"（池空关窗拒收新输入）属未来语义，v1 不做硬门。
2. **分选器（Sorter）**：每个 agent 一个，用正则+标签筛选任务池中的任务。工作循环：分选器把符合标签的前 n 个任务压入 agent 任务栈 → agent 自检"能否用现有权限/工具完成" → 能则进入工作会话执行提交；不能则任务+原因进坏任务栈（公共）→ 下一循环。
3. **坏任务回流**：任务池空时，坏任务重新流回任务池，且不派给已知不能执行的 agent；若某任务对所有能接受它的 agent 都无法解决 → 推送到 PTL。
4. **任务模板**：任务类型定义增强——标签方案 + 执行协议 + 输入参数 + 验收标准 + **成果契约（呈现方式 + 提交位置）**。任务池里的任务都是某模板的实例。
5. **机械/智能分工**（既有裁决）：摄入/匹配/认领/回流/升级 = 机械行为（系统代码，sqlite 事务）；自检/执行 = 智能层（agent 工作会话内）；agent 真实执行依赖模型可用性（环境前置项）。
6. **持久化惯例**（既有核实）：联邦领域状态 → SQLite 自持表（agent-lab.db，WAL，同 task_types/scheduled_jobs 模式）；记忆 → 文件模式；Redis = PTH 网关热状态（非领域真相源）。

## 2. 目标与非目标

### 目标（v1 = 完整机械环路）

1. **任务模板注册表**：task_templates 表 + register/get/list（幂等）+ 实例化（占位符填充）；注册"semantic-split"为首个模板
2. **任务池**：tasks 表 + 完整状态机（pending/claimed/submitted/completed/rejected/escalated）+ 回流轮 + stale 回收 + 全事件入账本
3. **分选器**：agents.selector_json 列 + SorterEngine（匹配 + 事务原子认领）+ SorterCycle（周期驱动）
4. **智能层工具**：workloop SDK 可选扩展 `sorter?` 端口（rejectTask/submitTask），防御性挂载
5. **投递接线**：摄入周期流迁移（direct dispatch → 池 publish）+ PTL 命令（task publish/list/status）

### 非目标（明确不做）

- ⛔ 验收者角色（v1 提交即完成；acceptance 字段人读，验收随自持态角色建造）
- ⛔ selector 的 AND 语义/优先级/权重（v1 仅 labelPatterns OR + textPattern 可选）
- ⛔ 投递窗口硬门（池空拒收新输入）——未来任务池语义
- ⛔ 经济联动（elo 赛道/市场竞价与任务的对接）——经济域既定工作
- ⛔ PTL 硬通道（escalated 任务 v1 只发事件，不建人工审批 UI）
- ⛔ 冷启动实验本体（自持态建造之后的事）
- ⛔ 改动任何既有文件的行为语义（新增表/列/模块；仅 cycle.ts 的 dispatch→publish 是计划内迁移 + contracts 可选字段扩展）

## 3. 架构总览

```
┌─ 任务投递 ──────────────────────────────┐
│  PTL 命令（模板实例化 → 池）              │
│  摄入周期流（改为向池 publish 语义分解任务）│
└──────┬──────────────────────────────────┘
       ↓ publish
┌─ 任务池（sqlite tasks 表 + 状态机）─────┐
│  pending → claimed → submitted → completed│
│  claimed → rejected（原因+排除名单）→ 回流 │
│  无可接者 → escalated（事件 → PTL）      │
│  stale 超时回收（claimed 卡死防堵）       │
└──────┬──────────────────────────────────┘
       ↓ 分选器（SorterEngine + SorterCycle）
  agents.selector_json × pending → 匹配 → 事务认领 → 任务栈(claimed 视图)
       ↓ 唤醒执行（复用既有 direct-execute 派发路径）
  agent 工作会话：自检 → 执行 → submit_task / reject_task（sorter? SDK 端口）
```

## 4. 任务模板（task_templates 表 + 注册表）

### 4.1 表结构

```
task_templates {
  id            TEXT PRIMARY KEY   -- 模板 id = 任务类型 id（未来与经济 elo 赛道联动）
  name          TEXT NOT NULL
  description   TEXT NOT NULL
  labels        TEXT NOT NULL      -- JSON string[]：实例自动携带的固定标签（分选器匹配面）
  params        TEXT NOT NULL      -- JSON ParamSpec[]：[{ name, description, required }]
  protocol      TEXT NOT NULL      -- 执行协议，含 <param> 占位符，实例化填充
  acceptance    TEXT NOT NULL      -- 验收标准文本（v1 人读，未来验收者角色消费）
  output        TEXT NOT NULL      -- JSON OutputContract：{ kind: "memory"|"file"|"report", target }
  registered_by TEXT NOT NULL
  created_at    INTEGER NOT NULL
}
```

### 4.2 注册表语义（同 TaskTypeRegistry 模式）

- `register(template)`：重复 id 幂等（首次生效，后续 no-op，createdAt 不变）
- `get(id)` / `list()`
- **实例化** `instantiate(template, params, extraLabels?)`：把 `<param>` 占位符按传入值填充 → 任务文本；实例标签 = 模板标签 + extraLabels；缺失必填参数 → 报错

### 4.3 首个模板：semantic-split

| 字段 | 值 |
|---|---|
| id | `semantic-split` |
| labels | `["memory-maintenance", "semantic-split"]` |
| params | `[{ name: "relPath", description: "待分解文档的相对路径", required: true }]` |
| protocol | 现 `semanticSplitTask(relPath)` 文本（含"经 sdk.memory.write 写 MemoryEntry、不改写原文档、不删除指针条目"协议），`<relPath>` 占位符 |
| output | `{ kind: "memory", target: "记忆库（锚点=文档标签+主题锚点）" }` |
| acceptance | 产出条目≥1；全部锚点非空；指针条目未被破坏 |

## 5. 任务池（tasks 表 + 状态机）

### 5.1 表结构

```
tasks {
  id           TEXT PRIMARY KEY
  template_id  TEXT NOT NULL
  labels       TEXT NOT NULL      -- JSON string[]（模板标签 + 实例标签）
  text         TEXT NOT NULL      -- 实例化后的任务文本（agent 看到的完整任务）
  params       TEXT NOT NULL      -- JSON：具体参数值
  status       TEXT NOT NULL      -- pending|claimed|submitted|completed|rejected|escalated
  claimed_by   TEXT               -- 当前认领 agent（claimed 时非空）
  claimed_at   INTEGER            -- 认领时刻（stale 回收判定）
  claims_count INTEGER NOT NULL DEFAULT 0
  rejects      TEXT NOT NULL DEFAULT '[]'  -- JSON [{ agentId, reason, at }]；排除名单 = 从中推导
  created_by   TEXT NOT NULL
  created_at   INTEGER NOT NULL
  completed_at INTEGER
}
```

### 5.2 状态机与转移（全部发事件入 EventLog）

```
pending ──分选器事务认领──→ claimed     [task.claimed，claims_count++]
claimed ──submit_task──→ submitted     [task.submitted，记录成果引用]
submitted ──自动──→ completed          [task.completed，v1 提交即完成]
claimed ──reject_task──→ rejected      [task.rejected，+reason +排除]
rejected ──回流轮──→ pending           [task.reflowed，排除名单保留]
rejected ──回流轮（无未排除匹配者）──→ escalated  [task.escalated，→ PTL 事件]
claimed ──stale 超时──→ pending        [task.stale_reclaim，默认 10 分钟]
```

### 5.3 关键语义

- **认领原子性**：`claimed_by` 写入必须带 `status=pending` 守卫（事务；两条分选器同时认领同一任务只有一个成功）——sqlite 事务保证
- **排除名单**：任务记录 `rejects[]` 推导——回流后分选器匹配时排除已拒绝过的 agent（`claimed_by` 不会落到名单内 agent）
- **回流轮触发**：SorterCycle 检测池中无 pending+claimed 任务时执行——全部 rejected → 判定：剩余"标签匹配且未排除"的 agent 数 = 0 → escalated；否则 → pending
- **stale 回收**：周期扫描 claimed_at < now - timeout → 回 pending（防"认领了但执行端不可用"永久卡死；v1 不区分拒绝原因）
- **成果引用**：submit_task 携带 outputRef（按成果契约 kind 的不同形态——memory 条目 id / 文件路径 / 报告文本），记入 submitted 事件的 payload 与 tasks 表（v1 可复用 params 之外的轻量字段，或仅事件留痕——实现时定，以不扩表为准）

## 6. 分选器（agents.selector_json + 引擎 + 周期）

### 6.1 selector 规则（agents 表加列）

```
lab_agent_instances.selector_json  TEXT  -- 可空 JSON：{ labelPatterns: string[], textPattern?: string }
```

- `labelPatterns`：正则数组，**OR 语义**——任一命中任务的任一标签 → 标签匹配通过；空数组 = 标签不设限
- `textPattern`：可选正则，给了则还需命中任务文本
- 两者都过 → 候选。accepts（经济承接声明）保留不动、用途分离

### 6.2 SorterEngine（机械层，sqlite）

- `candidates(agentId): Task[]`——该 agent selector 匹配的 pending 任务，created_at 升序
- `claimTopN(agentId, n): Task[]`——事务原子认领前 n 个（逐条 status=pending 守卫，认领即压栈 = claimed 视图）
- `reject(agentId, taskId, reason)`——校验 claimed_by=agentId → rejected + 排除记录
- `submit(agentId, taskId, outputRef)`——校验 claimed_by=agentId → submitted → completed
- `reflowRound(): { reflowed, escalated }`——回流轮（§5.3）
- `reclaimStale(timeoutMs)`——stale 回收

### 6.3 SorterCycle（驱动层，同 startIngestCycle 模式）

- `startSorterCycle({ engine, dispatch, intervalMs, claimN, ... })` → `{ stop() }`，setInterval + unref
- 每轮：① 对每个有 selector 的 agent 跑 claimTopN(claimN) ② 新认领任务经既有 direct-execute 派发唤醒执行（复用 polish 计划已建路径：direct + agentId + mode=execute）③ 池空（无 pending+claimed）→ reflowRound ④ stale 回收
- 单轮失败不破坏周期（幂等重试）

## 7. 智能层工具 + 投递接线

### 7.1 workloop SDK 扩展（sorter? 端口，同 memory?/comms? 模式）

```
interface SorterSdkPort {
  rejectTask(taskId: string, reason: string): void;   // 自检不能完成 → 坏任务回流
  submitTask(taskId: string, outputRef: unknown): void; // 完成 → 提交成果
}
```

- contracts.ts 加可选字段 `sorter?`；防御性挂载（引擎缺失 → 不挂）
- 装配层接线：SorterEngine 注入，同 MemoryHost.attachSdk 先例

### 7.2 摄入周期流迁移（唯一计划内行为迁移）

- cycle.ts：`runIngestCycleOnce` 从"直接 dispatch（labels.strategy=weighted）"改为"向池 publish semantic-split 任务（模板实例化，params={relPath}）"
- 路由职责交给分选器（memory-maintenance 角色的 agent 注册匹配 selector 后自然接取）
- 现有 ingest 测试同步迁移（cycle 单测改为断言 publish 调用形状）

### 7.3 PTL 命令（src/ptl 侧，open-db 先例）

- `pit lab task publish <templateId> --param k=v [--label x]`——实例化 + 入池
- `pit lab task list [--status pending]` / `pit lab task status <id>`
- 命令层复用既有 lab-data 命令注册模式

## 8. 边界与诚实声明

1. **模型可用性前置**：agent 真实执行（自检/执行/submit）依赖 workloop 会话模型可用（已知环境前置）。验收分两级：**机械链路**（模板注册/实例化、状态机全转移、匹配/认领原子性、回流/升级、stale 回收、命令参数）必须实测绿；**agent 执行链路**用 mock 覆盖，真实执行标注为环境前置项
2. **零行为变更**（除已声明的 cycle.ts 迁移）：新增表/列/模块；contracts 只加可选字段；memory/、scheduler/ 既有语义不动
3. **回流轮判定是 v1 简化**："无未排除的匹配 agent"基于 selector 规则静态推导，不做 agent 离线/能力动态评估——能力评估随自持态角色建造
4. **stale 回收不区分原因**：认领超时一律回 pending（不判 agent 离线、不打分）——简化，后续演进

## 9. 测试策略

- **单测**（node:test）：模板注册幂等/实例化（占位符/缺必填参数/标签合并）；状态机全转移（含守卫失败路径：非本人认领的 reject/submit 拒绝）；匹配规则（OR/空数组/textPattern/排除名单）；认领原子性（并发双认领单成功）；回流/升级判定；stale 回收
- **集成测**：真实 sqlite 池全链路（publish → 匹配 → 认领 → mock 执行 → submit/reject → 回流/升级 → 命令层），PI 风格隔离目录
- **回归**：agent-lab 全量 `npm test`（weighted-scorer-bootstrap 2 个既有失败忽略）+ 根仓库 `npx vitest run` + `npm run lint`

## 10. 后续演进路线（已讨论、不在 v1）

| 阶段 | 内容 |
|---|---|
| 自持态角色建造 | 分析者/计划者/开发者/侦查者/记忆维护者/工作验收者/人类交互专员——显式建造 + 维护回路闭合 + 扰动验证 |
| 验收者角色 | acceptance 字段消费、对抗性多模型评审、submitted → 真验收 |
| 分选器精化 | AND/优先级/权重、selector 学习（分析者从使用统计修正）、窗口硬门 |
| 经济联动 | 任务赏金/结算、elo 赛道与任务模板对接、破产样本审计 |
| 冷启动实验 | 以设计态为参照系，从"全能+分析"种子观察收敛 |
