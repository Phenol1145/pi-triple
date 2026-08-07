# PTH kernel 设计草案（进行中，未定稿）

- 日期：2026-08-07
- 状态：**草案**（brainstorming 进行中，范式已收敛、结构待设计——勿作为 spec 依据）
- 触发：Prime Agent 启发 + 交叉 brainstorm panel（deepseek-v4-flash / deepseek-v4-pro / qwen3.8-max）+ 结构审计（9 scout）

---

## 1. 范式（用户裁决，已确认）

### 1.1 双层次分离：用户交互 ≠ 任务执行

**PTL（开发工具）**：不严格区分——本地开个 pi 一边聊一边干活很自然。

**PTH（持久化 agent 集群）**：**必须分离**。两个层次：

```
层次 1：意图层（交互/撰写）
  用户 ↔ agent 对话 → 理解意图 → 撰写结构化任务（task authoring）
  特征：需要用户在场、对话上下文、低频、思考用于"把模糊意图变成明确任务"
  生命周期：短命（对话结束即消失）

层次 2：执行层（任务执行）
  从任务池认领任务 → 执行 → 提交结果 → 转录归档
  特征：不需要用户在场、持久运行、高频、思考用于"把任务做好"
  生命周期：常驻（任务随时来随时认领）

PTH 内部结构 = 交互层（短命）+ 任务池（两层接口）+ 执行层（常驻）
```

**推论**：vm 内核本质是**执行层**的运行时——任务驱动、无用户交互、持久。交互层（用户对话）是轻量机制（意图理解 + 任务撰写），不执行。

### 1.2 交互模式：解释性语言，不是工具调用

- **PTL**：无状态的单个工具形态操作计算机是可取的（工具调用模式 OK）
- **PTH**：不可取——需要**不同的编程语言和平台协同、持久的工作**。LLM 与计算机的交互模式**不应该是工具调用，而应该是一种解释性语言**（Python 和 TypeScript 都能实现）

**含义**：LLM 进入一个持久环境持续工作（像 IPython）——定义变量、加载模块、写函数、执行、迭代，状态一直活着。**工具调用 = "问一下答一下"；解释性语言 = "进入环境持续工作"**。

### 1.3 记忆 = 数据；skill = 记忆的一种

- **记忆 = 数据的一种存在形式**（可读写、可查询、可演化）
- **skill = 记忆的一种**，用来描述如何完成特定工作的数据（程序/知识）
- 统一：**记忆系统、skill 库、代码库、任务——全是同一个东西：解释性语言世界里的数据**

### 1.4 LLM = 数据处理算法，可函数式调用

LLM 不是对话对等体，而是数据世界里的**一个函数**：

```ts
const result = await llm.complete(messages, { model: "qwen3.8-max", thinking: "medium" });
```

- 可任意位置/任意次数调用（嵌套/链式/多模型并行）
- 多模型协作 = 程序里函数式调用不同模型（规划 A 模型、执行 B 模型、评审 C 模型）
- LLM 调用流可编程（循环/条件/管道组织）

### 1.5 bash/shell 也是解释型语言

bash 不是工具，而是**和 vm 并列的持久解释环境**：

```
PTH kernel = 多解释器世界（每个都是持久环境，有状态/历史/上下文）
├── TS 解释器（vm context）—— 数据变换/程序逻辑
├── bash 解释器（持久 shell 会话）—— 文件/进程/管道/系统操作
└── （未来）Python 解释器 —— 数据科学/ML 生态
       ↕ 共享同一个数据世界（postgres：记忆/skill/任务/转录）
LLM = 这个世界里的数据处理函数
```

**"工具"概念从架构里消失**：没有工具调用/工具列表——有"解释性语言会话"（每种语言一个环境）。所有解释器同构：(语言, 持久上下文, 数据世界访问)。

## 2. 已收敛的形态

```
PTH kernel = 解释性语言运行时（多解释器世界）
  ├─ TS 解释器：vm.createContext() 持久上下文 + stripTypeScriptTypes()
  ├─ bash 解释器：持久 shell 会话
  ├─ LLM 函数：llm.complete（数据处理算法，可函数式调用）
  ├─ 数据世界（postgres 统一存储）：
  │    · 记忆条目（= 数据对象）
  │    · skill（= 描述如何完成工作的数据对象）
  │    · 任务（六状态机）
  │    · 转录/WM（会话级/任务级档案）
  └─ pi 的 extension/skill → 改写为数据/TS 模块（代码库，不再经 ExtensionAPI 加载）
```

**关键范式转变**：extension 机制从"独立加载的扩展"退场为"数据世界里的可复用 TS 片段"，由 PTH kernel 统一解释执行。这与结构审计发现的"CLI 化迁移路线（扩展机制退场）"方向一致。

## 3. 技术底座（已确认可行）

- **vm 模块**（node:vm）：`vm.createContext()` 持久上下文（= IPython kernel 等价物），`vm.runInContext(code, context)` 反复执行，状态保留在 context 对象
- **TypeScript 执行**：`stripTypeScriptTypes()`（Node 22.6+）TS→JS 后喂给 vm——零新依赖
- **能力注入模型**：context 默认空，只注入白名单（llm.complete/数据世界访问），不注入 fs/child_process/net——语言层面无能力，而非运行时对抗
- **多解释器抽象**：`TSInterpreter` / `BashInterpreter` / 未来 `PythonInterpreter`——统一接口（execute(program)、持久状态、数据世界访问）

## 4. 已裁决的设计点

| # | 决策 | 内容 |
|---|---|---|
| 1 | 命名 | **PTH kernel**（用户裁决 2026-08-07） |
| 2 | 双层次分离 | 意图层（交互/撰写）≠ 执行层（任务执行）；PTH 必须分离，PTL 不必 |
| 3 | 交互模式 | 解释性语言（非工具调用）；PTH 用、PTL 保持工具调用 |
| 4 | 记忆/skill 统一 | 记忆 = 数据；skill = 记忆的一种（描述如何完成工作） |
| 5 | LLM 即函数 | llm.complete 可函数式调用；LLM = 数据处理算法 |
| 6 | bash 即解释器 | bash = 与 vm 并列的持久解释环境；工具概念消失 |
| 7 | 统一存储 | **postgres 为目标后端**（2026-08-07；出处 framework-vs-construction:81 悬置问题） |
| 8 | 会话层（方案 C） | 保留 pi ModelRuntime/provider/SessionManager/eventbus/model-router；自研回合循环主体 |
| 9 | 生命周期载体 | WM 挂会话（非任务）——"WM 是机械托底的状态载体，不是思考本身" |
| 10 | C 执行语义 | 逐条判别式失败不中断（原子批 = 跨时间尺度 ACID 幻觉） |
| 11 | peek 前置 | peek（只读不锁定）先于 claim/reject——"认领即承诺" |
| 12 | 经济闸门 | 缓行（只做动词族不做计费） |
| 13 | 定位 | **给 PTH 用**（非 PTL）；在 pi-platform 内运行 |
| 14 | 执行层形态（worker 簇 batch，用户确认 2026-08-07） | **batch = 进程单元**：按比例搭配的 worker 簇独享一个进程；高峰多开/低谷回收（多退少补）；sandbox 正常作用（bash 隔离）。**v1 简化**：每种 worker 类型各 1 个 → batch = 全角色 batch，弹性只加减 batch 数量，不分类型路由；动态构成调整（如开发者×2）留 v2，统计优化器 v1 只采集负载建议加减 batch（可手动执行） |
| 15 | 容器化拓扑（用户确认 2026-08-07） | **方案 C**：batch = pth 容器内 spawn 子进程（child_process 级隔离）；compose 只加 postgres 服务；sandbox 继续管不可信代码。B（独立容器）留作多机演进路径（batch 进程与容器边界解耦，C→B 迁移成本低） |
| 16 | 数据域归位（用户确认 2026-08-07） | **postgres = 执行层持久真相**（任务池/记忆/账本/转录/审计/skill/组件元数据）；**Redis = 交互层瞬态**（会话痕迹/认证/锁/队列）；**FS = blob 存储**（任务工作区临时/artifacts 产物归档/components tar/配置原文）；**引用而非复制**（pg 存 taskId/artifactPath 指针） |
| 17 | 产物清理策略（用户确认 2026-08-07） | 产物归档**不自动清理**——推送到清理提示到交互层，人工/策略决定；防止产物丢失 |
| 18 | 工作区形态（用户确认 2026-08-07） | **任务级工作区**：认领分配（workspaces/<tenant>/tasks/<taskId>/，sandbox 白名单）、提交后提炼归档（转录入 pg + 产物入 artifacts 卷 + 指针引用）、清理；batch worker 无固定 cwd。v1 简化：整个任务工作区 rename 到 artifacts 卷（不提炼），转录入 pg，先让系统运行起来 |

## 5. 未裁决的开放问题（brainstorming 待继续）

1. **PTH 架构重想**：postgres 目标后端 + 双层次分离 + 多解释器——PTH 的模块结构、执行路径、agent-lab 归位全部要重新设计（用户指示"重新考虑，感觉走偏了"）
2. **容器化拓扑**：pth + postgres + sandbox + redis？dev 容器？各服务职责？
3. **数据域归位**：记忆/转录/任务/账本/会话痕迹/审计 → postgres 各表？Redis 还留什么？FS 还留什么？
4. **交互层形态**：用户对话用 pi SDK 轻量会话（意图理解+任务撰写）？还是 PTH kernel 的轻量模式？
5. **agent-lab 归位**：28530 行的 taskpool/memory/scheduler/economy——进 PTH kernel 数据世界/原生进 PTH/废弃？
6. **执行路径收敛**：SDK 会话/workloop/PTL 本地三条路径 → 新架构收敛成什么？
7. **挂载点**：PTH kernel 挂 PTH 会话层（agent-engine.ts:613-621）？代码落 src/pth（或 src/shared）？
8. **语言 v1 范围**：TS 解释器 + bash 解释器？Python 留后？
9. **扩缩容判据**：v1 手动加减 batch（统计优化器只建议）？还是自动？——待裁决

## 6. 相关参考

- 结构审计：`docs/superpowers/explorations/2026-08-07-structure-recon/structure-audit.md`（6 scout 综合）
- 架构梳理：`docs/superpowers/explorations/2026-08-07-structure-recon/architecture-overview.md`（9 scout 完整全景）
- 侦察报告：`docs/superpowers/explorations/2026-08-07-structure-recon/scout-1..9-*.md`
- Prime Agent 会话：`/tmp/chatgpt-6a75a876.md`
- 交叉 brainstorm panel：`docs/superpowers/explorations/2026-08-07-prime-agent-panel/`（proposal-*.md / cross-*.md / alignment.md / adjudication.md）
- 记忆系统 spec：`docs/superpowers/specs/2026-08-02-memory-system-design.md`
