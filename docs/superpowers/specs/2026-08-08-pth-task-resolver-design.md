# PTH TaskResolver 设计草案（任务池即工作流 v2）

> 状态：SPEC v1.0 —— 已裁决（2026-08-08：嵌套表达式/默认跳过+wait:true/子任务不继承/payload 标记 verified）
> 日期：2026-08-08
> 关联：docs/superpowers/plans/2026-08-08-pth-task-chain.md（v1 钩子方案，本草案取代其架构部分）

## 1. 背景与目标

### 1.1 问题

当前任务池是"平"的：任务发布 → 任意 worker 机械认领 → 执行 → completed。没有流程概念：
- developer 完成任务后，不会自动产生验收任务
- 任务类型（recon/dev/verify）与角色（scout/developer/acceptor）无关联
- 无法表达"先 A 后 B"、"B 依赖 A"、"失败则重试"等流程语义

### 1.2 目标

把任务池变成**可重写的归约系统**（term rewriting system），实现：
1. **任务链**：任务完成后自动生成下游任务（developer → acceptor 验收闭环）
2. **类型变形**：任务按流程阶段改变类型/角色（pending → claimed → verify → verified）
3. **分解**：一个任务拆分为多个子任务（带依赖）
4. **循环与分支**：验收失败重试、按输出选择路径
5. **扁平化**：无 orchestrator 实体；流程定义 = 任务自带的路由声明（数据），规则可被记忆系统召回/维护

### 1.3 非目标（v1 不包含）

- 不实现完整工作流语言（BPMN 等）——只做最小算子集
- 不做分布式事务/补偿
- 不做跨任务池编排（单池 v1）

## 2. 核心概念：任务 = 自带路由的数据包

类比 DNS：域名解析服务。任务像携带路由信息的数据包，TaskResolver 像路由器/解析器——按任务自带的**有序阶段表**逐跳解析，每跳注销已完成阶段，递归进入下一阶段，直到终止或分解出子任务。

```
任务（payload.flow = 路由表）
   │
   ├── 阶段1: 匹配 → 算子（transform/decompose/branch/loop）→ 注销阶段1
   ├── 阶段2: 匹配 → 算子 → 注销阶段2
   ├── ...    （递归）
   └── 阶段N: 执行 → 终止（terminal）或产出子任务（各带自己的路由）
```

**关键设计决策（对用户要求的映射）：**

| 用户要求 | 设计落点 |
|---|---|
| 任务/模板在开头处声明路由规则 | `payload.flow`（或任务 text 首部声明，见 §5.3） |
| 每次收回到流程器注销完成的部分 | `payload.resolvedStages[]` 追加已执行阶段 id |
| 依次递归 | `resolve()` 递归：取下一活跃阶段 → 执行 → 注销 → 再入 |
| 循环和分支判断 | `loop` / `branch` 算子 + 条件表达式（§4.2） |

## 3. 数据模型

### 3.1 路由声明（payload.flow）

```jsonc
// 任务 payload 内嵌路由表。全部字段可选；stages 为有序数组。
{
  "flow": {
    "version": 1,
    "stages": [
      { "id": "s1", "match": {...}, "transform": {...} },
      { "id": "s2", "match": {...}, "branch": [...] },
      { "id": "s3", "match": {...}, "decompose": [...], "loop": {...} }
    ]
  },
  "resolvedStages": ["s1"],     // 已执行并注销的阶段（递归进度）
  "loopCount": 0,               // 当前循环计数（loop 防死循环）
  "parent": "task-abc",         // 分解来源（溯源）
  "outputRef": {...}            // （已有）上游产物引用
}
```

### 3.2 阶段（Stage）

```ts
interface Stage {
  id: string;                    // 阶段唯一 id（注销用）
  match?: MatchRule;             // 触发条件（JSON 匹配，见 §4.1）；缺省 = 恒真
  transform?: TransformSpec;     // 变形算子
  decompose?: DecomposeSpec[];   // 分解算子（产出子任务）
  branch?: BranchCase[];         // 分支算子（按条件选路径）
  loop?: LoopSpec;               // 循环算子（重复本阶段直到条件满足）
  terminal?: boolean;            // 终止标记（执行后不再递归）
}
```

### 3.3 算子规格

```ts
type MatchRule = {              // JSON 匹配：字段精确相等（支持通配 "*"）
  status?: string;
  kind?: string;                // 任务类型（payload.kind 或 tags 推断）
  role?: string;                // 目标角色（labelPatterns 匹配用）
  [k: string]: unknown;
};

interface TransformSpec {
  kind?: string;                // 变形：改类型（payload.kind）
  role?: string;                // 变形：改目标角色（payload.role）
  status?: string;              // 变形：改状态（pending/claimed/...）
  reason?: string;              // 变形：附加说明（payload.reason）
}

interface DecomposeSpec {       // 每个元素 = 一个子任务
  kind?: string;
  role?: string;
  title: string;                // 支持 {upstream.title} 模板插值
  text: string;                 // 支持 {upstream.outputRef...} 插值
  tags?: string[];
  flow?: FlowSpec;              // 子任务自带路由（递归）
}

interface BranchCase {
  if?: string;                  // 条件表达式（§4.2）；缺省 = else
  transform?: TransformSpec;
  decompose?: DecomposeSpec[];
}

interface LoopSpec {
  until: string;                // 条件表达式；满足则退出循环
  max?: number;                 // 最大迭代（默认 3）
}
```

## 4. 条件与匹配

### 4.1 match：JSON 匹配（零依赖，安全）

```ts
// 精确匹配 payload 顶层字段；值 "*" 通配任意；缺省字段不参与。
match: { status: "completed", kind: "dev" }
// 等价 SQL/JS：task.payload.kind === "dev" && task.status === "completed"
```

实现：纯函数 `matchesRule(task, rule)`，**不做任意代码求值**（防注入）。嵌套字段用点路径（`"output.ok"`）。

### 4.2 条件表达式（branch.if / loop.until）

最小表达式语言（零第三方依赖，白名单操作符）：

```
<expr>  ::= <cmp> ( "&&" <cmp> )*
<cmp>   ::= <path> <op> <literal>
<op>    ::= "==" | "!=" | "<" | ">" | "<=" | ">="
<path>  ::= "output." <ident>   // 引用 outputRef 内字段
          | "loopCount"
          | "claimsCount"
<literal> ::= number | "true" | "false" | "null" | '"' string '"'
```

示例：
- `output.ok == true`（验收输出通过）
- `loopCount < 3`（重试未超限）
- `output.score >= 0.8`（质量阈值）

实现：tokenizer + 递归下降解析 → 求值器（~100 行纯函数）。**不 eval、不 new Function**——解释器白名单原则同源（能力最小化）。

### 4.3 插值（decompose.title/text）

`{upstream.title}`、`{upstream.id}`、`{output.<path>}`——发布前替换。实现：简单 `str.replace(/\{([^}]+)\}/g, resolver)`，未知路径 → 原样保留 + 标记。

## 5. 解析算法（TaskResolver 组件）

### 5.1 组件形态

```
独立于 TaskLoop 的组件（非钩子）。
运行位置：PTH 主进程装配（kernel runtime 内，与 watchdog 平级）。
触发：周期轮询（间隔可配，默认 2s）"待解析任务"。
```

**待解析任务判定**（任一路由状态需要处理）：
```sql
-- payload 含 flow 且存在未注销阶段：
SELECT * FROM tasks
WHERE payload ? 'flow'
  AND jsonb_array_length(payload->'flow'->'stages')
      > coalesce(jsonb_array_length(payload->'resolvedStages'), 0)
```

### 5.2 解析循环（每轮）

```
resolve(task):
  stages = task.payload.flow.stages
  done = task.payload.resolvedStages ?? []
  active = stages[done.length]            # 下一个活跃阶段
  if !active: return TERMINAL             # 阶段耗尽 → 完成
  if active.terminal: mark finished; return

  if active.match && !matchesRule(task, active.match):
      # 条件不满足——该阶段未触发：
      #   loop? → 等待（下轮重试，loopCount 不变）
      #   否则 → 跳过并注销（进入下一阶段）
      if !active.loop: done.push(active.id)
      persist; return WAIT

  # 执行算子（按优先级：branch > decompose > transform > loop）
  if active.branch: path = evalBranch(active.branch, task)   # 选一个 case
  if active.decompose: children = buildChildren(task, spec)  # publish 子任务
  if active.transform: applyTransform(task, spec)            # 更新任务
  if active.loop:
      if evalExpr(active.loop.until, task): done.push(active.id)  # 条件满足 → 退出循环
      else if (task.payload.loopCount ?? 0) >= (active.loop.max ?? 3):
          done.push(active.id); task.payload.reason = "loop-max" # 超限 → 放弃该阶段
      else: task.payload.loopCount += 1                        # 继续循环（不注销）
  else:
      done.push(active.id)               # 非循环阶段执行后注销

  persist(task)                            # 更新 payload（resolvedStages/loopCount/变形）
  publish(children)                        # 子任务投池（各带自己的 flow）
  return resolve(task)                     # 递归下一阶段（同一轮内串行）
```

**递归深度防护**：`flow.stages.length` 天然有界；`loop.max` 有界；子任务递归有 `flow.version` + 全局最大深度（默认 8，`payload.flowDepth` 累计）。

### 5.3 路由声明位置（用户要求：开头声明）

双通道（v1 实现通道 1，通道 2 预留）：

1. **payload.flow**（推荐，结构化）：发布 API / 模板发布时注入。模板自带默认路由（§6）。
2. **任务 text 首部声明**（可选，扁平化极致形态）：任务代码开头 `// @flow <json>` 注释，TaskResolver 解析 text 首部提取路由——让"代码即路由"，worker 与 resolver 读同一份文本。v2 实现（需 text 解析器）。

## 6. 模板集成（自带默认路由）

每个任务模板发布时**自动注入默认路由**（用户可覆盖）：

| 模板 | 默认路由（stages） |
|---|---|
| `recon-doc` | ① match {kind: recon} → transform {kind: recon, role: scout} → ② match {status: completed} → terminal |
| `dev-task` | ① match {kind: dev} → transform {role: developer} → ② match {status: completed} → branch: [if output.ok → decompose [验收任务(role:acceptor, flow: verify)]，else → transform {status: rejected, reason: output.error}] → ③ 验收任务自带 flow: ① verify → ② match {status: completed} → transform {status: verified} → terminal |
| `memory-maintain` | ① match → transform {role: memory-keeper} → ② terminal |

**验收闭环（用户场景）完整流程：**

```
发布 dev-task（payload.flow = 上表 dev 路由）
  → 阶段①: transform role=developer → 注销
  → worker(developer) 认领执行 → completed
  → 阶段②: branch 命中 output.ok==true → decompose 验收任务（deps=[dev任务], flow=verify路由）
  → 验收任务投池（pending）
  → 阶段③（验收任务自己解析）: transform role=acceptor → 注销
  → worker(acceptor) 认领 → 执行验收 → completed
  → 验收任务阶段②: match {status:completed} → transform {status:verified} → terminal
```

## 7. 与现有组件的关系

| 组件 | 职责 | 变更 |
|---|---|---|
| TaskLoop / batch-process | 认领→执行→提交（执行器） | **不变**（不感知 flow） |
| TaskResolver（新） | 解析路由→变形/分解→投池（流程器） | 新增 |
| TaskStore.candidates | 认领候选 | 可选增强：deps 就绪过滤（v1.5） |
| tasks 表 | 任务存储 | **无 schema 变更**（全走 payload jsonb） |
| gateway /kernel/tasks | 发布 | payload 透传（已支持）；模板发布注入默认 flow |
| pth-tasks extension / ptl CLI | 交互层 | 发布时可选 --flow 参数（透传 payload） |

## 8. 安全与边界

1. **无任意代码执行**：match = JSON 匹配；条件 = 白名单表达式解析器；插值 = 白名单路径。不 eval。
2. **循环防护**：loop.max（默认 3）+ loopCount 持久化 + 全局 flowDepth（默认 8）。
3. **重复解析防护**：resolvedStages 持久化 + "待解析"SQL 只选未注销任务；resolver 崩溃重启后从进度继续（幂等）。
4. **孤儿子任务**：父任务 deleted/escalated → 子任务仍独立存活（v1 不级联）。
5. **空转**：无待解析任务 → 轮询空转（unref 定时器）。

## 9. 测试策略

| 层 | 覆盖 |
|---|---|
| 纯函数单测 | matchesRule / evalExpr / buildChildren / 插值 / 注销进度 |
| 组件测试 | TaskResolver 循环：transform/decompose/branch/loop 各算子 + 递归 + 终止 |
| 集成测试 | 真实 pg：发布 dev-task → developer 完成 → 自动生成验收 → acceptor 完成 → verified 闭环；循环重试（验收失败 → 重试 → 通过）|
| 回归 | 无 flow 任务行为不变（全量 1148 测试保持绿）|

## 10. 实施路线（建议拆分）

- **T1**：路由声明与匹配 —— `matchesRule` + payload.flow 校验器 + 待解析 SQL（纯函数 + 存储）
- **T2**：条件表达式 —— tokenizer + parser + eval（纯函数）
- **T3**：TaskResolver 组件 —— 轮询循环 + 注销进度 + transform/decompose 算子 + 递归（组件测试）
- **T4**：branch/loop 算子 + 插值（纯函数 + 组件测试）
- **T5**：模板默认路由注入 + 验收闭环集成实测（真实 pg 端到端）
- **T6**（v2）：text 首部路由声明 + deps 就绪过滤 + flow 文档召回（记忆区）

## 11. 开放问题（待评审）

1. **条件表达式语法**：§4.2 白名单表达式是否够用？是否需要 `and/or/not` 嵌套（v1 只做 `&&` 平级）？
2. **阶段跳过语义**：match 不满足且非 loop 时——"跳过注销" vs "等待"（v1 草案：跳过。但"等待"更适合依赖未就绪场景，可加 `wait: true` 字段切换）
3. **子任务 flow 继承**：decompose 子任务未显式给 flow 时——继承父 flow 剩余阶段？还是无路由？(v1：无路由，独立)
4. **模板默认路由的覆盖优先级**：发布时显式 payload.flow > 模板默认 > 无路由
5. **verified 状态**：需不需要独立 status 值（现在 CHECK 约束是 fixed 枚举）——v1 用 payload.status=verified 避免 schema 变更；或加列（schema_migrations 支持）
