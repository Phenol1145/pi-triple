# PTH 解释器持久化层设计草案（Refine 模式）

> 状态：SPEC v1.0 —— 已裁决（2026-08-08：pickle 哲学 + protobuf 数据层 + 函数构造文档 + 双通道 + refine 默认 auto）
> 日期：2026-08-08
> 背景：agent 完成一轮工作后进入 refine 模式，把本轮可能有用的信息/工具函数持久化；agent 持久化状态通过解释器召回。扁平化设计——状态不驻留在 agent 实体，全部落入记忆系统。

## 0. 设计原则：pickle 哲学映射

参考 Python `pickle` 库的设计取舍（统一化数据存储）：

| pickle | 本设计 | 说明 |
|---|---|---|
| 数据可 pickle（跨版本/跨环境复用） | **数据用 protobuf 编码**（`.proto` schema 定义，跨语言复用） | 数据结构通用，任何语言可解 |
| 函数/模块**不可 pickle**（只存模块路径+名字，环境需有同样定义） | **函数存源码 + 构造文档**：当前语言实现保留（可直接重放）；构造文档描述签名/逻辑——迁移环境后据此重新实现 | 环境迁移不丢能力 |
| `pickle.dumps/loads` | `encode/decode`（protobuf）+ `recall`（记忆检索） | 对称的存取接口 |
| unpicklable → TypeError | 函数 → 源码+文档；不可序列化数据 → oversized 标记 | 容错降级 |

**核心：数据跨语言、函数跨环境、实现保留当前语言。**

## 0.5 存储通道二：文件系统（可饮用的文件）

pickle 原教旨：**数据/函数存成文件，需要时 load**。用户提出"存储为可饮用的文件，需要时让 LLM import"——已实测可行：

```ts
// 工具函数 → .ts 文件（含 spec 注释头）
// toolstore/add.ts
// spec: { signature: "add(a,b): number", purpose: "两数相加", deps: [] }
export function add(a: number, b: number): number { return a + b; }

// 数据 → .json 文件
// toolstore/turing-data.json
{ "aabb": { "accepted": true, "steps": 13 } }

// 任务代码（vm 内）：受控读取能力 + stripTypeScriptTypes（与解释器同一机制）→ 等效 import
const src = await fs.readText("add.ts");          // 新增白名单能力
const body = strip(src).replace(/^export\s+/m, "");
runInContext(body, ctx);                            // 函数可用
const data = JSON.parse(await fs.readText("turing-data.json"));  // 数据可用
```

**实测结果**：`add(1,2)=3`、JSON 数据解析成功（probe 验证）。

**文件通道 vs 记忆表通道**（双通道互补）：

| 维度 | 文件通道（toolstore/） | 记忆表通道（memory_entries） |
|---|---|---|
| 形态 | 文件系统（pickle 原教旨） | 结构化表（protobuf 编码值） |
| 可读性 | 直接可读/审计/版本控制 | 需查询 |
| import | `fs.readText` + strip + eval | `state.recall*`（anchors 检索） |
| 适合 | 工具函数、结构化数据、模块 | 经验、洞察、可检索知识 |
| 跨语言 | .ts 源码 + spec（重建）；.json 通用 | protobuf 编码值（JSON 中间格式） |

**LLM import 语义**：任务代码由 LLM 生成——LLM 根据任务需要（结合记忆索引/工具目录）**决定 import 哪些文件**（写 `fs.readText` 调用）。即"LLM 自主决定需要什么"，文件系统是知识源。

**目录规划**：`<dataDir>/toolstore/`（持久化工具/数据，随 PTH 部署移动）；任务工作区 `<dataDir>/workspaces/<taskId>/` 可临时落文件（任务间不共享）。

**安全**：`fs.readText` 白名单限制——只读 `<dataDir>/toolstore/`（路径前缀校验，防越权读系统文件）；只读不写（写走既有 workspace/artifacts 机制）。

## 1. 问题与目标

### 1.1 现状

| 解释器 | 状态 | 任务后 |
|---|---|---|
| TS（vm context） | 进程内 context（capabilities + 任务声明的 var/function） | `kernel.reset()` 全量丢弃 |
| Python | 每次新进程 | 自然消失 |
| Bash | session {cwd, env} | 重置 |

跨任务知识只能靠任务代码**主动** `memory.write`——没有自动提炼，没有工具函数复用，agent 无"记忆"。

### 1.2 目标

1. **refine 模式**：任务完成后自动提炼（LLM 筛选）本轮 context 中的**有用信息**与**工具函数**，持久化到记忆系统
2. **解释器召回**：后续任务可通过解释器能力召回持久化状态（变量值 / 函数源码重定义）
3. **扁平化**：agent 状态 = 记忆区文档；无实体持有状态
4. **跨环境可移植**（pickle 哲学）：数据 protobuf 编码（任何语言可读）；函数带构造文档（迁移后可重建）

## 2. 关键技术事实（已实测）

| 事实 | 影响 |
|---|---|
| vm context 中 `var`/`function` 声明可见（`Object.keys` 可枚举），`const`/`let`/`class` **不可见**（词法绑定） | refine 只能持久化 var/function 声明；const/let 需任务主动注册 |
| `function.toString()` 可得完整源码（可存可重放） | 工具函数持久化 = 存源码字符串 |
| 含函数的对象 JSON.stringify 会**静默丢弃函数**（`{fn, nested} → {nested}`） | 序列化需自定义（函数转源码，对象递归） |
| Python 每次新进程 | v1 refine 聚焦 TS 解释器；python 产物走 transcripts/artifacts 既有通道 |

## 3. 核心设计：Refine 管线

```
任务执行完成（execute ok）
  │
  ├─ 1. 快照（snapshot）：枚举 context 全局 var/function，分类
  │      data（可 JSON） / functions（toString 源码） / large（超限标记）
  │
  ├─ 2. 提炼（refine）：LLM（deepseek）审阅快照 + 任务信息，
  │      筛选"对后续任务可能有用的"：
  │      - 工具函数（保留源码）
  │      - 关键数据（值/摘要）
  │      - 经验教训（任务过程中发现的知识）
  │      输出结构化 JSON：{ functions: [{name, source, desc}], data: [{key, value}], lessons: [string] }
  │
  ├─ 3. 持久化（persist）：写 memory_entries（kind 分型）：
  │      kind="tool-function"  → content=函数源码（附描述）
  │      kind="task-insight"   → content=提炼的数据/经验
  │      anchors=[任务 tags + 角色 + 关键词]，meta={taskId, role, model}
  │
  └─ 4. 挂载（attach）：把持久化句柄挂到任务 payload（refined=true）
       → 后续任务可经解释器能力召回
```

## 4. 数据模型

### 4.0 protobuf schema（跨语言数据层）

```proto
// proto/pth_snapshot.proto —— 快照数据结构（跨语言复用）
syntax = "proto3";
package pth;

// 单条数据：key + JSON 编码值（JSON 是跨语言通用中间格式）
message SnapshotData {
  string key = 1;
  bytes  value = 2;          // JSON.stringify 后的字节（任何语言可 JSON.parse）
  bool   serializable = 3;
}

// 工具函数：源码（当前语言实现）—— 函数不可跨语言 pickle，
// 但源码+构造文档（spec_json）可在迁移后重建
message SnapshotFunction {
  string key = 1;
  string source = 2;         // 当前语言实现（eval 可重放）
  string spec_json = 3;      // 构造文档（JSON：签名/用途/逻辑/示例——迁移重建依据）
  string language = 4;       // "typescript" | "python" | ...
}

// 一轮任务后解释器状态快照
message Snapshot {
  repeated SnapshotData    variables = 1;
  repeated SnapshotFunction functions = 2;
  repeated string          oversized = 3;   // 超限值仅记 key
}
```

实现：`protobufjs`（已在 node_modules，7.6.5——dockerode 传递依赖；验证可直接 import）。
`protoc 35.1` 本机可用（生成静态代码可选；运行时 parse schema 亦可）。

### 4.1 快照（内存态，protobuf 编码）

```ts
interface ContextSnapshot {
  variables: Array<{ key: string; value: Buffer; serializable: boolean }>;  // value = JSON 编码字节
  functions: Array<{ key: string; source: string; specJson: string; language: string }>;
  oversized: string[];
}
// 编解码：encodeSnapshot(snap) → Buffer；decodeSnapshot(buf) → ContextSnapshot
```

### 4.2 记忆条目（持久化形态）

```jsonc
// kind="tool-function"（工具函数——源码 + 构造文档双轨）
{ "id": "fn-add-<hash>", "kind": "tool-function",
  "anchors": ["add", "math", "dev-task-xxx"],
  // content = 当前语言实现（pickle 哲学：保留当前实现）
  "content": "function add(a,b){ return a+b; }",
  "meta": {
    "spec": {                              // 构造文档（迁移重建依据）
      "signature": "add(a: number, b: number): number",
      "purpose": "两数相加",
      "logic": "返回 a+b",
      "examples": [["1,2", "3"]]
    },
    "language": "typescript",
    "taskId": "...", "role": "developer", "model": "deepseek-v4-flash"
  } }

// kind="task-insight"（关键数据/经验——protobuf 编码的数据摘要）
{ "id": "insight-<hash>", "kind": "task-insight",
  "anchors": ["turing-machine", "steps"],
  "content": "aabb 识别用时 13 步；aⁿbⁿ 判定状态机 5 状态",
  "meta": { "taskId": "...", "role": "developer", "dataJson": "{...}" } }  // 原始数据 protobuf→JSON 存 meta

// kind="refine-report"（本轮提炼摘要——溯源）
{ "id": "refine-<taskId>", "kind": "refine-report",
  "content": "提炼 2 个工具函数 + 3 条经验",
  "meta": { "taskId": "...", "functions": ["fn-add"], "insights": ["insight-..."] } }
```

### 4.3 召回能力（解释器新增）

```ts
// capabilities 新增（vm 白名单）：
state: {
  /** 召回工具函数：返回 {key, source, spec}[]——当前环境 eval source 重定义；
   *  迁移环境读 spec 重建 */
  recallFunctions(anchors: string[]): Promise<Array<{ key: string; source: string; spec: unknown }>>;
  /** 召回经验/数据 */
  recallInsights(anchors: string[]): Promise<string[]>;
}
```

**任务代码用法（后续任务）**：
```ts
const fns = await state.recallFunctions(["turing", "machine"]);
for (const f of fns) eval(f.source);          // 当前环境：直接重放源码
// 迁移环境（不同语言）：读 f.spec 按构造文档重新实现
const insights = await state.recallInsights(["turing"]);
```

## 5. Refine 挂载点（TaskLoop 集成）

```ts
// task-loop.ts execute() 完成分支（submit + archive 之后）：
if (this.refiner) {
  await this.refiner.refine({ task, kernel, result });   // 注入的 refine 钩子（默认 no-op）
}
// BatchTaskLoop 注入真实 refiner（batch-process.ts）
```

**关键**：refine 在 `archive` 之后、context 仍存活时执行（kernel.reset 在**下一个任务**开始时才调——顺序安全）。

## 6. 快照序列化器（纯函数，可测）

```ts
// snapshot.ts
export function snapshotContext(ctx: Record<string, unknown>): ContextSnapshot {
  const out: ContextSnapshot = { variables: [], functions: [], oversized: [] };
  for (const key of Object.keys(ctx)) {
    if (RESERVED_CAPABILITIES.has(key)) continue;      // llm/memory/web/tasks/state 白名单能力不持久化
    const v = ctx[key];
    if (typeof v === "function") { out.functions.push({ key, source: v.toString() }); continue; }
    try { JSON.stringify(v); out.variables.push({ key, value: v, serializable: true }); }
    catch { out.oversized.push(key); }
  }
  return out;
}

export function serializeSnapshot(snap: ContextSnapshot): string  // refine 的 LLM 输入
export function parseRefineResult(text: string): RefineResult       // LLM 输出 → 结构化（容错 parse）
```

## 7. 安全边界

1. **能力白名单**：`state.recall*` 只读（检索记忆），无写；`eval` 由任务代码自己决定（工具函数源码本身是任务自己定义的）
2. **函数源码重放风险**：recall 返回的 source 是**本任务池历史任务的代码**——信任边界 = 池内任务（与执行任务代码同级信任）。v1 接受；v2 可加"函数签名校验"（meta 记 hash）
3. **体积控制**：单值 >1KB 不持久化（oversized 标记）；每任务 refine 输出上限（默认 5 函数 + 10 条经验）
4. **不持久化能力对象**：llm/memory/web/tasks/state 本身不进快照（防递归/泄漏）
5. **LLM 输出容错**：refine 结果 parse 失败 → 降级为"快照原样摘要"（仍持久化函数源码）

## 8. 测试策略

| 层 | 覆盖 |
|---|---|
| snapshot 纯函数 | var/function/const 分类；能力白名单排除；oversized；含函数对象序列化 |
| parseRefineResult | 合法 JSON / 带 ``` 围栏 / 非法 → 容错 |
| refiner 组件（mock LLM+memory） | 提炼流程：快照→LLM→持久化→report |
| 集成（真实 pg + deepseek） | 任务 A 定义工具函数 → refine 持久化 → 任务 B 经 state.recallFunctions 召回并复用 |
| 回归 | 无 refiner 注入时行为不变；全量 1148 保持绿 |

## 9. 实施路线

- **T1**：protobuf 快照层 —— `.proto` schema（variables/functions/oversized）+ protobufjs 编解码 + snapshot 序列化器（纯函数 + 测试）
- **T1b**：文件通道 —— `fs.readText` 白名单能力（toolstore 路径前缀校验）+ toolstore 目录规划（batch-process 装配传 toolstore 路径）
- **T2**：refine 提炼器 —— LLM 调用（筛选函数 + 生成构造文档 spec + 决策：写文件通道 vs 记忆表通道）+ 结果解析容错（组件测试）
- **T3**：TaskLoop refiner 钩子 + BatchTaskLoop 接线（batch-process 装配）
- **T4**：召回能力 `state.recallFunctions/recallInsights` + `fs.readText`（capability 注入 + 测试）
- **T5**：端到端实测——任务 A（定义工具函数）→ refine（文件通道落 toolstore + 记忆表索引）→ 任务 B（LLM import：fs.readText + eval 重放）闭环
- **T6**（v2）：refine 策略可配置、工具函数版本化、python 产物 refine、spec 跨语言示例、toolstore 目录列表能力（LLM 浏览可用工具）

## 10. 开放问题（展开分析）

### P1. protobuf 依赖策略

**背景**：protobufjs 7.6.5 已在 node_modules（dockerode 传递依赖，实测可直接 import）。

**为什么重要**：① 直接 import 传递依赖依赖 npm 提升（hoisting）稳定性——未来某次 `npm install` 拓扑变化可能导致 `ERR_MODULE_NOT_FOUND`；② 发行包（npm pack）只含 files 白名单 + dependencies 声明——传递依赖不在声明里，消费者安装时可能拿不到；③ 发行门禁（check-release-clean）验证 pack 内容。

**选项**：
| 方案 | 优点 | 缺点 |
|---|---|---|
| a. 直接 import（零改动） | 无 package.json 变更 | npm 提升风险；发行不自包含 |
| b. 显式加入 dependencies | 版本钉死、发行自包含、npm 自动安装 | 需验证门禁（node_modules 不进 pack，声明即可） |
| c. 自研迷你编码（JSON 就够） | 零依赖 | 失去 protobuf 标准性/演进能力 |

**建议**：b——显式 `"protobufjs": "^7.6.5"` 加入根包 + framework 包。纯 JS 包体积可控；发布门禁需确认 pack 不含 node_modules（files 白名单已保证）。

### P2. .proto 文件管理

**背景**：schema 需要版本化、可评审。

**选项**：
| 方案 | 优点 | 缺点 |
|---|---|---|
| a. 运行时 parse（protobufjs.load/parse） | 零构建步骤；schema 演进灵活（改 .proto 即生效） | 启动解析开销（可缓存）；无静态类型 |
| b. protoc 生成静态 TS | 类型安全；零运行时解析 | 构建链加步骤；schema 改动需重新生成 |

**建议**：a——`proto/pth_snapshot.proto` 作为源码提交，首次 import 时 parse 一次并缓存。类型用 TS interface 手写对齐（编译期校验由单测覆盖）。

### P3. 函数依赖捕获（新——实测发现的硬约束）

**背景**：实测 `derived(y){ return base(y)+1 }`——只存 derived 源码，孤立 eval 时 `base is not defined`（ReferenceError）。函数 toString **不含**闭包捕获的变量值。

**影响**：工具函数持久化必须记录**依赖图**，否则召回重放必然失败。

**方案**：
1. **依赖闭包**：快照时对每个函数做标识符引用提取（正则粗扫）→ 若引用的标识符也在快照中 → 依赖列表 `deps: ["base"]`，召回时**先重放依赖**（拓扑序）
2. **闭包值注入**（const 捕获的场景）：`function f(){ return config }` 的 config 是 const（不可枚举）——快照看不到，重放必失败。需**任务主动注册**机制（见 P4）
3. **spec 补充**：构造文档 spec.deps 列出依赖名 + spec.captures 列出闭包捕获（任务手动声明或 LLM 分析）

**建议**：v1 做 ①依赖闭包（自动拓扑）+ ③spec 记录；② 由 P4 的注册机制解决。

### P4. const/let 可见性与主动注册机制

**背景**：实测 const/let 声明不进 context 全局对象（`config` 不可见；`globalThis.config2` 可见）。任务代码常用 const 定义配置/数据。

**方案**：给解释器加**显式导出能力**（vm 白名单）：
```ts
// capabilities 新增：
state: {
  export(key: string, value: unknown): void;   // 注册到 context 全局（var 语义）
  ...recall 系列
}
// 任务代码：
const config = { max: 10 };
state.export("config", config);               // 主动注册 → 快照可见
```

**替代**：refine 时用 LLM 分析源码文本提取 const 声明（不可靠）。

**建议**：新增 `state.export` 能力 + 文档引导（skill 教任务代码用 `state.export` 注册关键数据/函数）。v1 同时保留"仅 var/function 自动捕获"作为兜底。

### P5. spec 构造文档粒度

**背景**：函数跨环境重建依据（pickle 哲学：函数不可 pickle → 文档重建）。

**最小可用（v1）**：`{ signature, purpose, logic, examples, deps, language }`——签名/用途/逻辑/示例/依赖/语言。

**扩展（v2）**：伪代码、类型标注、依赖版本、测试用例、性能特征。

**生成方式**：与 refine 筛选同轮 LLM 输出（prompt 要求每个函数附带 spec_json）——不额外调用。

**建议**：v1 最小集；spec 生成质量由 refine prompt 约束（后续可用 P6 的验收任务校验 spec 可重建性）。

### P6. refine 自动/可选策略

**成本**：每任务一次 deepseek 调用（~1-2s + token 费）。

**选项**：
| 方案 | 适用 |
|---|---|
| a. 默认全量 auto | 简单；小规模够用 |
| b. 任务声明控制（`payload.refine: false/"minimal"/"full"`） | 精细；模板可带默认 |
| c. 启发式（产出多/函数多才 refine） | 省成本；规则复杂 |

**建议**：b——默认 auto（模板默认 refine: "auto"），发布时可关；后续可加 c 降本。refine 失败（LLM 超时/解析失败）**不阻塞任务完成**（旁路降级——任务已 completed，refine 失败仅记 warn）。

### P7. eval 重放信任边界

**背景**：recall 返回的历史任务函数源码，eval 到当前 context 执行。

**信任模型**：与"执行任务代码"同信任级（池内任务代码本身就能调用能力）。v1 直接 eval；不需要额外沙箱（沙箱反而会让函数无法访问 llm/memory 等能力）。

**风险**：历史函数可能引用已不存在的全局（P3 依赖缺失）→ eval 后调用时 ReferenceError——由调用方 try/catch。

**建议**：v1 直接 eval（同信任级）；记录来源（meta.taskId）供审计。v2 可加"函数白名单签名校验"。

### P8. 与 TaskResolver 联动

**背景**：两个新组件都在"任务完成后"动作——refine（知识沉淀）vs resolver（流程路由）。

**关系**：
```
任务完成
  ├─ refine：快照 → 提炼 → 记忆（知识层）
  └─ resolver：路由 → 变形/分解（流程层）
```

**联动点（v2）**：
1. refine 产出的 insight 可作为 resolver 分支条件的数据源（`output.insights` 引用）
2. resolver 的 decompose 子任务可带 `refine: false`（中间任务不沉淀，终态任务 refine）
3. spec 可被"验收任务"校验（重建函数 → 跑 examples → 通过才算验收）——refine 与 acceptor 闭环

**建议**：v1 两者独立实现；接口留好（refine 输出进 payload，resolver 条件可读 payload）。

### P9. 记忆条目幂等与冲突（新）

**背景**：多个任务可能 refine 出同名函数（都定义 add）→ 记忆区多版本。

**机制**（memory-store 已有）：`write` 同 id → version+1（CAS）。

**方案**：id 用**内容 hash**（`fn-<sha256(source) 前 12>`）——相同源码幂等（重复 refine 不产生新条目）；不同源码同 key → 各自独立（anchors 检索时最新优先）。

**建议**：id = 内容 hash；recall 返回按 version 降序（最新优先）。

### P10. 规模与性能（新）

**快照上限**：单值 >1KB → oversized（只记 key）；每任务函数上限 10 个；insight 上限 5 条。

**记忆条目增长**：每任务最多 ~7 条（函数+insight+report）——按任务量线性增长，anchors 检索 + GIN 索引可控。

**refine 延迟**：LLM 调用 1-2s——TaskLoop 每任务完成时串行等待（可接受；v2 可异步旁路）。

### P11. 召回策略细节（新）

**anchors 语义**：现有 `?|`（任一包含）——函数名/任务 tags/角色 都做 anchors。

**排序**：多命中时按 version 降序 + hit_count 降序（最常用的优先）。

**上限**：recall 默认返回前 5 个函数（防 context 膨胀）。

**建议**：v1 简单实现（?| + limit）；排序优化 v2。

### P12. 文件通道 vs 记忆表通道：refine 落盘决策（新）

**背景**：用户提出文件存储思路后，双通道并存——refine 产出去哪？

**决策规则（v1）**：
| 产物 | 通道 | 理由 |
|---|---|---|
| 工具函数（源码+spec） | **文件通道**（toolstore/*.ts） | 可 import、可审计、版本控制；记忆表存索引（anchors → 文件名） |
| 结构化数据（可 JSON） | **文件通道**（toolstore/*.json） | 跨语言；LLM 直接读 |
| 经验/洞察（文本） | **记忆表**（task-insight） | 检索式知识（?| 匹配）比文件扫描高效 |
| 快照全量（未提炼） | protobuf 编码（记忆表 meta 或 toolstore/*.pb） | 归档/追溯 |

**LLM 的角色**：refine 时 LLM 决定每项产物走哪个通道（prompt 约束规则）+ 生成 spec。

**建议**：v1 按上表硬编码规则（LLM 只选内容，通道由规则定）；v2 LLM 可覆盖。

### P13. 任务代码如何"知道"有哪些工具（新）

**背景**：LLM import 需要知道 toolstore 里有什么——否则不知道调 `fs.readText("add.ts")`。

**方案**：
1. **toolstore 索引**：refine 写文件时同步写 `toolstore/index.json`（文件名→spec 摘要）——任务代码先读 index 再决定 import
2. **记忆表索引**：anchors 检索（recallFunctions）返回文件名——文件内容再 fs.readText

**建议**：双索引并行（index.json 供浏览，记忆表供语义检索）。v1 至少实现一个（index.json 最简）。
