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
5. **投递接线**：摄入周期流迁移（direct dispatch → 池 publish）+ /lab 命令（task publish/list/status/requeue + agent selector）

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
│  /lab 命令（模板实例化 → 池）             │
│  摄入周期流（改为向池 publish 语义分解任务）│
└──────┬──────────────────────────────────┘
       ↓ publish
┌─ 任务池（sqlite tasks 表 + 状态机）─────┐
│  pending → claimed → submitted → completed│
│  claimed → rejected（原因+排除名单）→ 回流 │
│  pending/rejected 无候选 → escalated      │
│  派发失败 → 自动 reject；claims_count≥3 → 升级│
│  stale 超时回收（staleMs > execution 超时）│
└──────┬──────────────────────────────────┘
       ↓ 分选器（SorterEngine + SorterCycle）
  agents.selector_json × pending → 匹配 → 事务认领 → 任务栈(claimed 视图)
       ↓ 唤醒执行（direct-execute；任务文本前缀注入 [task:<id>]）
  agent 工作会话：自检 → 执行 → submit_task / reject_task（sorter? SDK 端口，判别式返回）
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
- **裁决（对抗性审核 I3）**：模板注册**不联动** task_types（economy 侧注册表）。两表独立，id 同域纯为未来 elo 赛道联动预留；当前 task_types 无任何注册调用方，联动规则留待经济对接时定义。

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
  text         TEXT NOT NULL      -- 实例化后的任务文本；派发时前缀注入 [task:<id>]（agent 识别自身 id 的机制，见 §7.1）
  params       TEXT NOT NULL      -- JSON：具体参数值
  status       TEXT NOT NULL      -- pending|claimed|submitted|completed|rejected|escalated
  claimed_by   TEXT               -- 当前认领 agent（claimed 时非空）
  claimed_at   INTEGER            -- 认领时刻（stale 回收判定）
  claims_count INTEGER NOT NULL DEFAULT 0
  rejects      TEXT NOT NULL DEFAULT '[]'  -- JSON [{ agentId, reason, at }]；排除名单 = 按 agentId 去重推导
  created_by   TEXT NOT NULL
  created_at   INTEGER NOT NULL
  completed_at INTEGER
}
-- 索引：CREATE INDEX ON tasks(status, created_at)；CREATE INDEX ON tasks(status, claimed_at)
```

**裁决（对抗性审核 I4）**：成果引用（outputRef）**仅事件留痕，tasks 表不存 output_ref 列**（与"不扩表"一致）；submit_task 的 outputRef 形状 v1 钉死为 string（memory 条目 id / 文件路径 / 报告文本的字符串表示）。集成测试断言 submitted 事件的 payload。

### 5.2 状态机与转移（全部发事件入 EventLog，事件 id 用 uuid 型唯一 id——撞 content_hash 会抛错）

```
pending ──分选器事务认领──→ claimed     [task.claimed，claims_count++]
claimed ──submit_task──→ submitted     [task.submitted，成果引用入事件 payload]
submitted ──自动──→ completed          [task.completed，v1 提交即完成；submitted 为瞬态恒同步转移]
claimed ──reject_task──→ rejected      [task.rejected，+reason +排除]
claimed ──派发失败──→ rejected         [task.rejected，reason="dispatch-failed"，+排除]（裁决 I2）
rejected ──回流轮──→ pending           [task.reflowed，排除名单保留]
rejected ──回流轮（无未排除匹配者）──→ escalated  [task.escalated，→ PTL 事件]
pending ──回流轮（无任何未排除候选且 age>阈值）──→ escalated  [task.escalated，→ PTL 事件]（裁决 B2）
claimed ──stale 超时──→ pending        [task.stale_reclaim，默认 10 分钟]
```

**裁决（对抗性审核 I2）**：派发返回 failed（agent 不存在/run 抛错/execution-timeout）→ 记自动 reject（reason="dispatch-failed"，进排除名单）——不再 stale 循环。claims_count 达 3 → 强制 escalated（防单 agent 反复认领-失败-回流转圈）。claims_count 由此成为升级判据之一，非死字段。

### 5.3 关键语义

- **认领原子性**：`claimed_by` 写入必须带 `status=pending` 守卫（事务；两条分选器同时认领同一任务只有一个成功）——sqlite 事务保证（建议 `changes()===1` 判定逐条成功）
- **排除名单**：任务记录 `rejects[]` 推导（按 agentId 去重）——回流后分选器匹配时排除已拒绝过的 agent（`claimed_by` 不会落到名单内 agent）
- **回流轮触发（裁决 I1，双触发并存）**：
  - 池空触发：池中无 pending+claimed 任务时执行
  - **时间维触发**：rejected 任务 age（最后活动/拒绝时刻）超阈值（默认 10 分钟）即纳入回流判定——**防持续有新 publish 时 rejected 永久滞留**
- **升级判定**（reflow 时）：对每个 rejected/pending 任务——剩余"标签匹配且未排除"的 agent 数 = 0 → escalated；否则 → pending
- **pending 无候选升级（裁决 B2）**：从未被认领过的 pending 任务，若 age > 阈值（默认 30 分钟）且无任何"标签匹配且未排除"的 agent → escalated（补 §3 架构图"无可接者 → escalated"与 §5.2 的缺口）
- **stale 回收**：周期扫描 claimed_at < now - timeout → 回 pending（防"认领了但执行端不可用"永久卡死；不判 agent 离线、不打分）；**不变量：staleMs > execution.timeoutMs + 裕量**（裁决 I5——防合法长执行中被 stale 回收导致双会话重复执行）
- **成果引用**：submit_task 携带 outputRef（string），仅记入 submitted 事件 payload（裁决 I4，tasks 表不存）

## 6. 分选器（agents.selector_json + 引擎 + 周期）

### 6.1 selector 规则（agents 表加列）

```
lab_agent_instances.selector_json  TEXT  -- 可空 JSON：{ labelPatterns: string[], textPattern?: string }
```

- `labelPatterns`：正则数组，**OR 语义**——任一命中任务的任一标签 → 标签匹配通过；空数组 = 标签不设限
- `textPattern`：可选正则，给了则还需命中任务文本
- 两者都过 → 候选。accepts（经济承接声明）保留不动、用途分离

### 6.2 SorterEngine（机械层，sqlite）

- `candidates(agentId): Task[]`——该 agent selector 匹配的 pending 任务（**已排除该 agent 的任务不含在内**，created_at 升序）
- `claimTopN(agentId, n): Task[]`——事务原子认领前 n 个（逐条 status=pending 守卫，认领即压栈 = claimed 视图；栈 = claimed 有序视图，执行按认领序 FIFO——裁决 M7）
- `reject(agentId, taskId, reason)`——校验 claimed_by=agentId → rejected + 排除记录
- `submit(agentId, taskId, outputRef)`——校验 claimed_by=agentId → submitted → completed
- `reflowRound(): { reflowed, escalated }`——回流轮（§5.3，双触发）
- `reclaimStale(timeoutMs)`——stale 回收
- `escalate(taskId, reason)`——升级（claims_count 阈值 / 无候选 / 无未排除匹配者共用）
- **selector 配置面（裁决 B2）**：`setSelector(agentId, selector)` / `getSelector(agentId)`——供 /lab agent selector 命令与测试使用

### 6.3 SorterCycle（驱动层，同 startIngestCycle 模式）

- `startSorterCycle({ engine, dispatch, intervalMs, claimN, ... })` → `{ stop() }`，setInterval + unref（v1 单运行时假设——M10；装配宿主与配置面在计划阶段定，参照 startIngestCycle 现状：目前无运行时调用方，接线随 PTH 运行时）
- 每轮：① 对每个有 selector 的 agent 跑 claimTopN(claimN)（claimN 默认 3）② 新认领任务经既有 direct-execute 派发唤醒执行（复用 polish 计划已建路径：direct + agentId + mode=execute；派发时**任务文本前缀注入 `[task:<id>]`**——见 §7.1）③ 派发返回 failed → 记自动 reject（reason="dispatch-failed"，裁决 I2）④ 回流轮（池空触发或时间维触发，§5.3）⑤ stale 回收（staleMs 默认 10 分钟，不变量：> execution.timeoutMs + 裕量）⑥ claims_count≥3 → escalate
- 单轮失败不破坏周期（幂等重试）
- **并行格局声明（裁决 C7）**：池路径（publish→分选器→认领）与直派路径（/lab scheduler dispatch 人工直派）并行共存；weighted/market 策略继续服务直派通道。v1 不做两通道的优先级仲裁。

## 7. 智能层工具 + 投递接线

### 7.1 workloop SDK 扩展（sorter? 端口，同 memory?/comms? 模式）

```
interface SorterSdkPort {
  rejectTask(taskId: string, reason: string): { ok: true } | { ok: false; error: string };  // 自检不能完成 → 坏任务回流；守卫失败可见
  submitTask(taskId: string, outputRef: string): { ok: true } | { ok: false; error: string }; // 完成 → 提交成果
}
```

- contracts.ts 加可选字段 `sorter?`；防御性挂载（引擎缺失 → 不挂）；装配层接线同 MemoryHost.attachSdk 先例
- **taskId 传递机制（裁决 B1）**：派发时 SorterCycle 在任务文本前缀注入 `[task:<id>]`（先例：agent-runtime.ts drainInbox 的 `task:` 前缀拼接）——agent 从任务文本解析 taskId 调用工具；§4.2 instantiate 不填 taskId（它是运行时注入，非模板参数）
- **裁决（对抗性审核 I5）**：端口返回判别式结果（`{ok:true} | {ok:false,error}`）——守卫失败（stale 已回收/任务被重新认领）对 agent 可见，不静默丢成果；SDK 形状 string（裁决 I4）

### 7.2 摄入周期流迁移（唯一计划内行为迁移）

- cycle.ts：`runIngestCycleOnce` 从"直接 dispatch（labels.strategy=weighted）"改为"向池 publish semantic-split 任务（模板实例化，params={relPath}）"
- 路由职责交给分选器（memory-maintenance 角色的 agent 注册匹配 selector 后自然接取）
- 现有 ingest 测试同步迁移（cycle 单测改为断言 publish 调用形状）

### 7.3 /lab 命令（落点裁决 I6：slash 命令，非 pit CLI）

**落点修正**：仓库无 `pit lab` 命令树（pit 只有 tui 面板）；既有 lab 命令先例 = agent-lab 扩展内的 `/lab` slash 命令（`extensions/agent-lab/src/commands/register.ts`，`/lab scheduler dispatch` 同款）。命令走 slash 命令 + engine 注入（与 §7.1 引擎一致，避免第二份状态机 SQL 实现）。

- `/lab task publish <templateId> --param k=v [--label x]`——实例化 + 入池
- `/lab task list [--status pending]` / `/lab task status <id>`
- `/lab task requeue <id>`——escalated/rejected → pending，清 rejects[]（裁决 I7：最小运维出口，人工看到 escalated 后能处置）
- `/lab agent selector <agentId> --labels <regex...> [--text <regex>]`——selector 配置面（裁决 B2）

## 8. 边界与诚实声明

1. **模型可用性前置**：agent 真实执行（自检/执行/submit）依赖 workloop 会话模型可用（已知环境前置）。验收分两级：**机械链路**（模板注册/实例化、状态机全转移、匹配/认领原子性、回流/升级、stale 回收、命令参数）必须实测绿；**agent 执行链路**用 mock 覆盖，真实执行标注为环境前置项。派发失败已有收敛路径（自动 reject + claims_count 阈值升级——裁决 I2），模型不可用不再产生无限空转
2. **零行为变更**（除已声明的 cycle.ts 迁移与 contracts 可选字段）：新增表/列/模块。触点清单（对抗性审核 M2）：schema.ts、core/storage/repository.ts（迁移+按 selector 列查询）、core/contracts.ts、src/ingest/cycle.ts（dispatch→publish）、assembly 装配（sorter 端口接线）、commands/register.ts（/lab task 命令）
3. **回流轮判定是 v1 简化**："无未排除的匹配 agent"基于 selector 规则静态推导，不做 agent 离线/能力动态评估——能力评估随自持态角色建造
4. **stale 回收不区分原因**：认领超时一律回 pending（不判 agent 离线、不打分）——简化，后续演进；**不变量 staleMs > execution.timeoutMs + 裕量**（裁决 I5）
5. **escalated = v1 终态**：人工处置经 `/lab task requeue`（裁决 I7）；PTL 硬通道（推送 UI）留后续
6. **selector 空数组 = 不设限**（catch-all，裁决 M9）：一个空 selector agent 会吞全池——v1 声明风险，多 agent 场景需治理
7. **v1 单租户**（裁决 M11）：tasks/task_templates 不加 tenant_id 列（scheduled_jobs 有多租户先例，任务池单租户假设写入注释）；单运行时假设（M10）
8. **规模假设**（裁决 M8）：全表扫描 + JSON 匹配在 v1 规模（数十任务）可接受；已建 (status, created_at)/(status, claimed_at) 索引；性能问题随规模演进

## 9. 测试策略

- **单测**（node:test）：模板注册幂等/实例化（占位符/缺必填参数/标签合并）；状态机全转移（含守卫失败路径：非本人认领的 reject/submit 拒绝——端口返回 {ok:false,error}、派发失败自动 reject、claims_count 阈值升级、stale 不变量）；匹配规则（OR/空数组/textPattern/排除名单去重）；认领原子性（并发双认领单成功）；回流轮双触发（池空 + 时间维）；pending 无候选升级；stale 回收
- **集成测**：真实 sqlite 池全链路（publish → 匹配 → 认领 → [task:id] 前缀 → mock 执行 → submit/reject → 回流/升级 → /lab 命令层），PI 风格隔离目录；事件 payload（submitted 含 outputRef、escalated 含原因）断言
- **回归**：agent-lab 全量 `npm test`（weighted-scorer-bootstrap 2 个既有失败忽略）+ 根仓库 `npx vitest run` + `npm run lint`

## 10. 对抗性审核记录（qwen-token-plan-cn/qwen3.8-max，2026-08-06）

审核结论：**Needs changes（修后再审）**——2 Blocker + 7 Important + 13 Minor，全部落到代码核实。

### Blocker（必修，已全部修订）

| # | 发现 | 修订 |
|---|---|---|
| B1 | taskId 传递路径不存在：DispatchRequest 无 taskId 字段，agent 会话侧唯一可见面是任务文本 | §7.1 钉死：派发时任务文本前缀注入 `[task:<id>]`（先例 agent-runtime drainInbox `task:` 前缀） |
| B2 | selector 无配置面 + pending 无候选任务永不升级（§3 与 §5.3 矛盾） | §6.2 加 setSelector/getSelector + /lab agent selector 命令（§7.3）；§5.2/5.3 pending 无候选 age>阈值 → escalated |

### Important（已裁决/修复）

| # | 发现 | 裁决 |
|---|---|---|
| I1 | 回流轮仅池空触发：持续 publish 时 rejected 永久滞留 | 双触发：池空 + 时间维（rejected age>10min） |
| I2 | 派发失败无转移：stale 回收→同 agent 再认领死循环；claims_count 死字段 | 派发 failed → 自动 reject（dispatch-failed）+ claims_count≥3 → escalated |
| I3 | task_templates 与 task_types 同键双注册表无同步规则 | 裁决：v1 不联动，两表独立，id 同域纯为未来预留 |
| I4 | outputRef "实现时定"自相矛盾 | 裁决：仅事件留痕，tasks 表不存；SDK 形状 string |
| I5 | void 返回守卫失败不可见；stale 与执行超时无关系不变量 | 端口返回判别式 {ok}/ {ok:false,error}；钉死 staleMs > execution.timeoutMs + 裕量 |
| I6 | §7.3 落点错（pit lab 命令树不存在） | 改 /lab slash 命令（commands/register.ts 既有模式 + engine 注入） |
| I7 | escalated 纯终态黑洞无运维出口 | /lab task requeue（escalated/rejected → pending 清 rejects[]） |

### Minor（13 项，计划阶段消化）

M1 双路径迁移（CORE_SCHEMA + ALTER）；M2 触点清单（§8.2 已补）；M3 事件 id 用 uuid 型（§5.2 已注）；M4 装配宿主（§6.3 声明）；M5 rejects 去重（§5.1 已注）；M6 candidates 排除契约（§6.2 已补）；M7 栈语义 FIFO（§6.2 已注）；M8 索引（§5.1 已建）；M9 catch-all selector（§8.6 声明）；M10 单运行时（§8.7）；M11 单租户（§8.7）；M12 lab-data 抄录（计划阶段处理）；M13 submitted 瞬态（§5.2 已注）

### 攻击未命中（已核实正确的部分）

C1 selector_json 加列可行（5 个同型迁移先例）；C2 EventLog 可承载全事件；C3 direct-execute 复用属实（getAgent 全局单查）；C4 认领原子性成立（BEGIN IMMEDIATE + status 守卫 + changes()===1）；C5 §7.2 迁移基线准确；C6 sorter? 端口先例链完整；C7 表名 tasks 无冲突（库内是 market_tasks）

## 11. 后续演进路线（已讨论、不在 v1）

| 阶段 | 内容 |
|---|---|
| 自持态角色建造 | 分析者/计划者/开发者/侦查者/记忆维护者/工作验收者/人类交互专员——显式建造 + 维护回路闭合 + 扰动验证 |
| 验收者角色 | acceptance 字段消费、对抗性多模型评审、submitted → 真验收 |
| 分选器精化 | AND/优先级/权重、selector 学习（分析者从使用统计修正）、窗口硬门 |
| 经济联动 | 任务赏金/结算、elo 赛道与任务模板对接、破产样本审计 |
| 冷启动实验 | 以设计态为参照系，从"全能+分析"种子观察收敛 |
