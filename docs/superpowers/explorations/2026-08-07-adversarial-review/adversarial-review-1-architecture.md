# PTH Kernel 架构总纲——对抗性审核报告

- **审核日期**：2026-08-07
- **审核对象**：`docs/superpowers/specs/2026-08-07-pth-kernel-architecture.md`（总纲）
- **交叉引用**：24 项裁决草案、任务池/分选器 spec、现状架构报告
- **审核立场**：挑剔——找破绽，不顺读

---

## 问题清单

| # | 严重度 | 类别 | 问题 | 建议修复 |
|---|---|---|---|---|
| 1 | **Blocker** | C（现状衔接） | **任务池 dispatch 模型与 kernel worker 循环存在不可兼容的推拉冲突。** 前序 task-pool-sorter spec（`2026-08-06-task-pool-sorter-design.md`）§6.3 定义 SorterCycle 为 push 模型：周期运行 → claimTopN → direct-execute 派发唤醒 agent。总纲 §3 执行层定义 worker 主动 pull 模型：`peek → claim → 执行 → submit → 转录归档`。两个模型在"谁来驱动任务认领"上互斥——SorterCycle 是中央调度器推任务给 agent，kernel worker 是 agent 自己拉任务。总纲声称 task-pool-sorter 是 PTH kernel "要兼容"的前序设计，但整个 task-pool-sorter spec（207 行）全文无 `postgres`、`pg`、`kernel` 任一关键词，完全没有为 kernel 架构预留接口。 | 在 Spec C（存储）中显式定义任务池从 SQLite→pg 迁移时 dispatch 模型的转换契约：SorterCycle 的 claimTopN+direct-execute 路径降级为任务池内部 peek/claim 原语（不再负责 dispatch），worker 循环取代 direct-execute 成为唯一执行触发路径。同步更新 task-pool-sorter spec 加兼容性声明。 |
| 2 | **Blocker** | C（现状衔接） | **SQLite→PostgreSQL 数据迁移路径完全缺失。** 总纲 §8 关键不变量 #4 规定"postgres = 执行层真相源"，§6 Spec C 标注"迁移路径（agent-lab.db → pg）"。但总纲未给出：① agent-lab.db 中 tasks/task_templates/lab_events/credit_tx 等表的 pg schema 设计；② 双写/停写窗口策略；③ 迁移期间任务池一致性保证。task-pool-sorter spec §5.1 的 tasks 表结构（含 claimed_by/claims_count/rejects/selector_json）全部基于 SQLite 设计，认领原子性依赖 `BEGIN IMMEDIATE + status 守卫 + changes()===1`——这些语义在 pg 下需重写。任务池是"两层唯一通道"，其迁移未定义 = 总纲不闭合。 | Spec C 中明确：① pg schema 草案（至少 tasks/task_templates/event_log 三表）；② 迁移策略（pg 为主、SQLite 桥接期只读、双写窗口判定）；③ 认领原子性在 pg 下的等价实现（`SELECT ... FOR UPDATE SKIP LOCKED`）。 |
| 3 | **Blocker** | D（遗漏） | **多租户模型未裁决。** 现状架构（`architecture-overview.md` §4.1）中 PTH 全面使用 tenant 维度：Redis key 全部含 `<tenant>` 前缀（`session:<tenant>:<sid>`、`components:<tenant>`、`settings:<tenant>`），FS 目录含 `workspaces/<tenant>/`、`tenants/<tenant>/`。总纲全文零次出现 `tenant` 或 `多租户`。24 项裁决亦无一项涉及。前序 task-pool-sorter spec §8.7（裁决 M11）明确"v1 单租户，不加 tenant_id 列"——这是前序 spec 的简化假设，总纲作为后序上位设计必须裁决是否延续。若 postgres 数据世界无 tenant 隔离，则记忆/账本/转录/审计全租户混合——这是安全灾难。 | 总纲新增裁决：PTH kernel v1 的租户模型（单租户延续 vs pg schema 预留 tenant_id）。若单租户，写入明确声明并标注 v2 风险。若需多租户，pg schema 所有表加 `tenant_id` 并定义 worker 的数据世界访问范围。 |
| 4 | **Blocker** | E（不变量） | **缺少任务不丢失/不重复执行的不变量。** 10 条不变量覆盖了"执行层无第二条路径"（#2）和"产物不自动清理"（#6），但没有覆盖最核心的执行语义保证：① 任务一旦 publish 不能静默丢失（持久性）；② 同一任务不能被两个 worker 同时执行（排他性）。task-pool-sorter spec §5.3 有认领原子性保证（`status=pending 守卫 + changes()===1`），但这是 SQLite 级实现细节，总纲没有提升为不变量。从 pg 迁移后，若实现不当，`SELECT ... FOR UPDATE` 不当使用可导致双认领。 | 新增不变量：**任务执行 exactly-once 投递**（publish 持久化、claim 排他、stale 回收不中断在途执行）。将 task-pool-sorter §5.3 的认领原子性提升为架构级保证。 |
| 5 | **Important** | A（范式矛盾） | **意图层 pi SDK 工具调用模式与 PTH 解释性语言范式在 PTH 内部共存，P2/P5 范式边界模糊。** 范式 P2 规定"PTH 用解释性语言（非工具调用）"，P5 宣称"工具概念从架构消失"。但裁决 19 明确意图层用"pi SDK 轻量会话（AgentSession）"，而 pi SDK AgentSession 天然运行在工具调用模式下——`ToolRegistry`、`ToolPlatform`、tool approvals 等全部存在。这意味着 PTH 自身内部存在两种交互范式：意图层用工具调用（与用户对话），执行层用解释性语言（执行任务）。这不是"双层次分离"的本意（P1 分离的是交互/执行职责，而非分离范式）。若意图层也要"工具消失"，AgentSession 如何只做意图理解而不触发工具？若非如此，则 P2/P5 需限定作用域。 | 在 P2/P5 中显式加限定词：**P2 作用于执行层，意图层保留 pi SDK 工具调用模式**。P5 改为"执行层中工具概念消失"。或在 §4 裁决表补充裁决 3/6 的作用域。 |
| 6 | **Important** | B（裁决冲突） | **裁决 8（保留 pi SessionManager）与裁决 21（全部收敛到 kernel）存在执行面冲突。** 裁决 8 保留 pi ModelRuntime/provider/SessionManager/eventbus/model-router，裁决 21 规定执行层全部收敛到 PTH kernel。但 SessionManager 和 ModelRuntime 是 pi SDK 回合循环的运行时依赖——它们管理 AgentSession 的生命周期和模型调用。若执行层全部走 kernel 的 `llm.complete` 函数，kernel 内部的模型调用是直接走 provider 还是经 ModelRuntime？若是前者，则 ModelRuntime 只在意图层有用——裁决 8 的"保留"实为意图层保留。若是后者，则 kernel 依赖 pi SDK 回合循环基础设施——与"自研回合循环主体"矛盾。 | 裁决 8 拆分：**ModelRuntime/provider/model-router 作为 llm.complete 的底层实现保留**（kernel 调用它们）；**SessionManager/eventbus 仅意图层保留**（不进入执行层）。Spec A 的 llm 函数设计需明确底层走 ModelRuntime 还是直连 provider。 |
| 7 | **Important** | B（裁决冲突） | **裁决 15（batch = pth 容器内 spawn 子进程）与裁决 8（保留 SessionManager/eventbus）存在进程边界冲突。** SessionManager 和 eventbus 是 pi SDK 的内存态对象（含会话池、事件订阅），在 Node 单进程中运行。若 batch worker 是独立子进程（child_process.fork），worker 无法访问父进程的 SessionManager 或 eventbus 实例。这意味着裁决 8 保留的组件在子进程中不可用——kernel worker 必须自建模型调用路径，裁决 8 的"保留"变为仅在意图层（主进程）有效。 | 裁决 15 的进程模型加注：**子进程 worker 不共享父进程 pi SDK 运行时状态**。裁决 8 的"保留"明确作用于主进程（意图层），worker 通过 IPC 或独立 pg 连接访问数据世界。 |
| 8 | **Important** | A（范式矛盾） | **P3（记忆=数据，skill=记忆一种）与"执行层运行 skill 作为解释性代码"之间存在"数据即代码"的模糊地带。** P3 将 skill 归约为数据对象——"描述如何完成特定工作的数据"。但执行层中 skill 的实际形态是 TS 模块/代码片段，由解释器执行。若 skill 是数据，它应可被动查询/读取；若 skill 是代码，它会被主动解释执行。这两者的读写模型不同：数据读写是 CRUD，代码执行是 eval。总纲未定义 skill 从"数据"到"可执行代码"的转换边界——是解释器从 pg 读 skill 文本后 eval，还是 skill 以某种预编译形态存在？ | Spec A 中定义 skill 加载生命周期：skill 以数据形态存储在 pg，worker 认领任务时注入 vm context 成为可执行模块（数据→代码的转换在注入点发生，一次转换、任务期间缓存）。明确 skill 的"数据面"（CRUD、版本、搜索）与"执行面"（vm.runInContext）的边界。 |
| 9 | **Important** | D（遗漏） | **Python 解释器集成方案完全未定义。** 裁决 23 纳入 Python 为三解释器之一。不变量 #10 声明"零新依赖优先（Python 解释器除外）"——这是唯一标注的例外。但总纲没有回答关键问题：① Python 解释器的进程模型（与 TS/bash 同进程？独立子进程通过 IPC？Pyodide WASM？）；② Python 解释器的能力注入模型（P5/bash 有 sandbox，Python 的安全边界是什么？）；③ Python 依赖管理（pip 包是否允许？白名单？预装集合？）；④ Python 与数据世界的接口（直接 pg 连接？通过 TS 桥接？）。"Python 解释器"作为名称出现在架构图和裁决表中，但无任何实质设计内容——这更像是愿望清单而非设计决策。 | 若 Python 解释器 v1 不实现，将其从裁决 23 降级为 v2。若 v1 实现，Spec A 中至少定义：进程边界、安全模型（至少与 bash 同级的 sandbox 约束）、数据世界访问方式。 |
| 10 | **Important** | D（遗漏） | **错误处理与容错模型缺失。** 总纲全文零次出现 `fault`、`crash`、`recovery`、`failure`、`error handling`。执行层是常驻 agent 集群——worker 必然 crash、batch 进程必然退出、pg 连接必然断开。当前唯一的相关机制是 task-pool-sorter §5.3 的 stale 回收（claimed 超时回 pending），但这仅是任务级兜底。缺失的设计面包括：① worker crash 后 batch 进程如何感知与重启？② batch 进程崩溃后谁负责重启（systemd？docker restart？compose？）；③ pg 连接断开后 worker 的任务循环行为（重连？标记故障？降级？）；④ 解释器状态（vm context、bash 会话）在 worker 重启后是否可恢复？ | 总纲 §3 基础设施层新增：**watchdog/健康检查**（batch supervisor 监控 worker 子进程，crash 自动重启，重启后 worker 从 pg 恢复任务状态重新 peek）。stale 回收的不变量（`staleMs > executionTimeoutMs`）提升为架构级保证。 |
| 11 | **Important** | C（现状衔接） | **Redis key 迁移范围未界定——"交互层瞬态"与现状不匹配。** 不变量 #4 规定"Redis 只存交互层瞬态"。但现状架构（`architecture-overview.md` §4.1）中 Redis 承载 8 个域：会话痕迹（可视为瞬态）、设置、组件元数据+二进制、回退请求、工作流锁/状态、审计日志流、认证 token、BullMQ。其中**组件存储**（components tar 的元数据与二进制引用）、**工作流状态**（workflow orchestrator 锁/状态）、**设置**（settings per tenant/project）不属于"交互层瞬态"——它们是持久化状态。若这些不迁 pg，则不变量 #4 需要细化；若迁 pg，需定义迁移路径和 Redis 降级后的配置热更新方案（组件通过 FS→pg 元数据，settings 迁 pg）。 | 不变量 #4 细化：列出现状 Redis 8 个域逐一归类。组件元数据→pg，二进制→FS（blob）。设置→pg。工作流状态→pg（或冻结为 PTL 功能不迁）。认证 token 保留 Redis（TTL 瞬态）。审计日志→pg（EventLog 合并）。 |
| 12 | **Important** | E（不变量） | **缺少向后兼容/共存期不变量。** 总纲 §8 关键不变量 #9 说"废弃代码不删"，但这只保证旧代码物理存在，不保证新旧系统能在同一进程中共存。现状 4 条执行路径中，PTH 主路径（gateway → AgentSession）仍然活跃服务生产流量。若 kernel worker 逐步接管执行，新旧两条执行路径会在同一任务池上竞态。task-pool-sorter spec §8.7（裁决 C7）声明"池路径与直派路径并行共存，不做优先级仲裁"——这是前序 spec 的设计决定，总纲作为上位架构必须裁决共存期的行为契约。 | 新增不变量：**迁移期双路径共存契约**——gateway 直派路径与 kernel worker 认领路径在任务池上互不干扰（基于 claimed_by 守卫的天然互斥已满足），但不变量需显式声明。明确共存期结束条件（何时 gateway 路径下线）。 |
| 13 | **Minor** | D（遗漏） | **配置管理未涉及。** batch 数量、worker 类型配比、解释器超时、pg 连接串、sandbox 策略——这些全部是运行时配置，但总纲未提及配置面。裁决 24 的"手动扩缩容 + 统计建议"隐含了配置变更机制（`/lab` 命令），但未定义配置的持久化位置（pg？FS？环境变量？）。 | §6 演进路线或 Spec B 中明确配置管理方案（至少声明配置存储位置和热更新范围）。 |
| 14 | **Minor** | B（裁决冲突） | **裁决 9（WM 挂会话非任务）与裁决 18（任务级工作区）的日志/转录边界模糊。** 裁决 9 说"WM 是机械托底的状态载体"挂会话，裁决 18 说任务执行结果"转录入 pg"。若 WM 挂会话但转录在 pg 中按任务记录，则一个会话内的多个任务的转录是分条独立还是聚合在会话 WM 下？若会话级 WM 与任务级转录分离，认证/审计链路会断裂。 | Spec C 中明确 WM/转录的数据模型：WM 表与会话关联（session_id），转录表与任务关联（task_id + session_id 外键），保证链路可追溯。 |
| 15 | **Minor** | E（不变量） | **不变量 #8（能力注入模型）仅覆盖 TS 解释器，未覆盖 bash 和 Python。** 不变量 #8："context 默认空，只注入白名单（llm.complete/数据世界访问），不注入 fs/child_process/net——语言层面无能力"。这是 vm.createContext() 的 TS 特定能力模型。bash 解释器如何做到"语言层面无能力"？bash 天然有 fs/进程/网络能力。Python 同理。sandbox（§3 基础设施）被提及但未与不变量 #8 关联。 | 不变量 #8 拆分为：**TS 解释器**：context 白名单；**bash/Python 解释器**：sandbox 强制隔离（文件系统白名单、网络限制、进程限制），非"语言层面"而是运行时沙箱。 |
| 16 | **Minor** | C（现状衔接） | **agent-lab 的 interceptor（subagent 模型选择/竞价）归位模糊。** 裁决 20 说 taskpool/sorter/ingest/memory 保留迁 pg，scheduler/arena/economy/assembly/workloop 被 kernel 取代。但 interceptor 不在上述任何一类中——它是 agent-lab `index.ts` 中的 `agent-lab-interceptor`，运行时注入常驻会话做模型选择。kernel 的 llm.complete 函数是否还要走 interceptor 的模型竞价？若是，interceptor 应保留并接入 kernel；若否，总纲需明确 kernel 的模型选择机制。 | 裁决 20 补充：interceptor 保留（kernel llm.complete 调用时走 interceptor 做模型选择/竞价），或明确 kernel 有独立模型路由。 |
| 17 | **Minor** | D（遗漏） | **日志/可观测性体系未设计。** 现状有 audit log（Redis Stream）和 EventLog（agent-lab SQLite）。kernel 架构中 pg 承载"审计"，但日志级别、结构化日志格式、分布式追踪（跨 batch worker 的 task 追踪）均未涉及。常驻集群的可观测性是运维必需项。 | Spec C 中定义 audit 表结构（至少 event_type/timestamp/task_id/worker_id/session_id/payload）和日志级别约定。 |

---

## 审查总结

### 总体评估：**不可批准（Needs major revision）**

这份总纲在范式层（5 条）和裁决层（24 项）做出了大量正确的方向性决策——双层次分离、解释性语言执行、postgres 统一存储、任务池作为两层唯一通道、执行路径收敛——这些大方向没有根本性错误。

但总纲有 **4 个 Blocker 级别缺口**必须修复后才能进入分层 spec 阶段：

### 三个最危险的破绽

1. **任务池是"两层唯一通道"，但总纲与 task-pool-sorter spec 之间是零引用的两个平行宇宙**。SorterCycle 的 push 模型与 kernel worker 的 pull 模型互斥，而 task-pool-sorter 全文无 `postgres`/`kernel` 任一关键词。这不是细节缺失，是两个 spec 没有对话。若分别按这两个 spec 实现，产出的代码无法对接。

2. **多租户静默缺失**。现状 PTH 全线使用 tenant 维度做数据隔离（Redis keys、FS 目录），总纲和 24 项裁决却无一触及。postgres 统一存储若不加 tenant_id，将产生跨租户数据泄露——这不是"v2 再说"的问题，是 schema 设计第一天就要裁决的结构性决策。

3. **容错模型零覆盖**。执行层是"常驻 agent 集群"——worker crash、进程退出、pg 断连是必然事件。总纲没有 crash recovery、没有健康检查、没有重启语义。唯一相关机制是 task-pool-sorter 的 stale 回收，但那解决的是"agent 不可用"而非"kernel 自身故障"。

### 修正优先级

| 优先级 | 修复项 |
|---|---|
| P0（合入前必修） | #1（推拉冲突）、#3（多租户）、#4（任务不丢失不变量）、#2（SQLite→pg 迁移路径） |
| P1（Spec A/B/C 前必修） | #5（范式作用域）、#6（SessionManager 边界）、#8（skill 数据/代码边界）、#10（容错模型）、#11（Redis 迁移范围） |
| P2（v1 实现前必修） | #7（进程边界）、#9（Python 集成）、#12（共存不变量）、#15（bash/Python 能力模型）、#16（interceptor 归位） |
| P3（可延期） | #13（配置管理）、#14（WM/转录边界）、#17（可观测性） |

### 如果只修 P0 四项

这份总纲可以批准进入分层 spec——但必须带着这 4 个 Blocker 的明确修复方案（不只是一个 TODO 行）。其他 13 项可以在 Spec A/B/C 中逐层消化。

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Returned 17 concrete findings with exact file paths, section references, ruling numbers, and severity levels. Each finding cites specific spec sections (e.g., '总纲 §3 执行层' vs 'task-pool-sorter spec §6.3'), cross-references between documents, and proposed fixes."
    }
  ],
  "changedFiles": [
    "docs/superpowers/explorations/2026-08-07-adversarial-review/adversarial-review-1-architecture.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "grep tenant|多租户 in kernel spec",
      "result": "passed",
      "summary": "Zero matches confirmed—multi-tenancy is entirely absent from the architecture spec"
    },
    {
      "command": "grep postgres|pg|kernel in task-pool-sorter spec",
      "result": "passed",
      "summary": "Zero matches confirmed—the two specs have no cross-references despite claimed compatibility requirement"
    },
    {
      "command": "grep fault|crash|recover|failure in kernel spec",
      "result": "passed",
      "summary": "Zero matches confirmed—no fault tolerance or error recovery design"
    },
    {
      "command": "grep Python|python|child_process in kernel spec",
      "result": "passed",
      "summary": "Python only mentioned as a name/label; no integration mechanism defined"
    },
    {
      "command": "grep model-router|ModelRuntime in kernel spec",
      "result": "passed",
      "summary": "Mentioned in ruling 8 (retain) and architecture diagram but no integration detail with llm.complete"
    },
    {
      "command": "grep SorterCycle|direct-execute|push|pull in kernel spec",
      "result": "passed",
      "summary": "Only peek/claim mentioned; no resolution of SorterCycle push vs worker pull conflict"
    }
  ],
  "validationOutput": [
    "Cross-referenced 4 documents (kernel spec, rulings draft, task-pool-sorter spec, architecture overview)",
    "Identified 4 blockers, 8 important, 5 minor issues across all 5 review axes",
    "Verified claims through targeted grep searches (6 commands, all confirming gaps)",
    "All findings cite specific sections, ruling numbers, and line-level evidence"
  ],
  "residualRisks": [
    "The Blocker list may expand after Spec A/B/C are drafted—this review only covers the architecture blueprint (总纲), not the sub-specs",
    "Findings #9 (Python) and #16 (interceptor) could become blockers during Spec A design depending on implementation choices",
    "The task-pool-sorter spec was published 2026-08-06 (one day before kernel spec) and didn't have kernel in scope—the incompatibility may be a timing artifact rather than a design error"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created adversarial review document with 17 findings (4 blockers, 8 important, 5 minor) covering paradigm contradictions, ruling conflicts, migration gaps, missing decisions, and invariant completeness",
  "reviewFindings": [
    "blocker: task-pool-sorter spec (push dispatch) vs kernel spec (pull worker loop) - incompatible dispatch models with zero cross-references",
    "blocker: SQLite→PostgreSQL migration path for task pool undefined (no pg schema, no migration strategy, no consistency guarantee)",
    "blocker: multi-tenancy entirely absent from kernel spec despite current PTH architecture using tenant isolation everywhere",
    "blocker: missing invariant for task durability and exactly-once execution guarantee",
    "important: intent layer uses tool-calling (pi SDK) while PTH paradigm mandates interpreted languages — paradigm scope undefined",
    "important: ruling 8 (retain SessionManager) vs ruling 21 (all converge to kernel) — SessionManager's role in kernel unclear",
    "important: ruling 15 (child_process batch) vs ruling 8 (in-process SessionManager) — process boundary conflict",
    "important: P3 'skill = data' vs execution layer running skills as interpreted code — data/code boundary undefined",
    "important: Python interpreter integration completely undefined (process model, security, dependencies, data world access)",
    "important: zero fault tolerance design (worker crash, batch exit, pg disconnect all unhandled)",
    "important: Redis key migration scope unclear — components/settings/workflow don't fit 'interaction transient'",
    "important: missing backward compatibility invariant for dual-path coexistence during migration",
    "minor: configuration management unaddressed",
    "minor: WM/transcript boundary fuzzy between session and task granularity",
    "minor: capability model (invariant 8) only covers TS interpreter, not bash/Python",
    "minor: agent-lab interceptor (model selection) fate unclear in kernel architecture",
    "minor: observability and structured logging unaddressed"
  ],
  "manualNotes": "Overall assessment: NOT APPROVABLE. The 5 paradigms and 24 rulings are directionally sound, but 4 blockers must be resolved before entering sub-spec phase. The most dangerous gap is the task pool dispatch model conflict (#1) — the kernel spec and task-pool-sorter spec are parallel universes with zero cross-references. If only P0 items are fixed, the spec can proceed to Spec A/B/C with P1-P3 items deferred."
}
```
