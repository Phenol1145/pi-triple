# Scout-3：src/ 结构 + 设计文档意图架构 侦察报告

> 日期：2026-08-07 · 侦察范围：`src/{pth,ptl,shared,sandbox}` + `docs/superpowers/specs/`（13 specs）
> 上游总览：根 `ARCHITECTURE.md`（自称"单一真相源"），分产品 `docs/pth/architecture.md`、`docs/ptl/architecture.md`

---

## (A) src/ 四个目录职责

| 目录 | 一行职责 | 证据入口 |
|---|---|---|
| **`src/ptl/`** | **Pi-Triple-Lite**——轻量开发/调试工具链；不实现 agent runtime，而是用 tmux 启动真实 pi 进程（模板隔离），并提供 pit CLI + 双 TUI + ptl-flow 波次引擎 + hub 联邦交互桥 | `src/ptl/pit.ts`（CLI 入口，bin: pit）；`src/ptl/launcher.ts`（pi 启动参数构建）；`docs/ptl/architecture.md` |
| **`src/pth/`** | **Pi-Triple-Heavy**——agent 联邦平台服务器（**模块化单体**，单进程、接口隔离：Gateway→Core→Platform→Infrastructure）；Fastify 网关 + AgentEngine 会话管理 + Redis/BullMQ 编排 + 工具治理 + sandbox 转发 | `src/pth/main.ts`（装配点）；`docs/pth/architecture.md`（明言"模块化单体"） |
| **`src/shared/`** | 双产品共享层——`sdk-adapter/`（**唯一** SDK 导入点，硬约束）、`model-router/`（模型路由+failover）、`workspace/`（工作目录隔离）、`platform/`（跨 OS 适配）、`observability/`（pino 日志）、`credential-provider.ts` | `src/shared/sdk-adapter/index.ts`（头部注释：所有 SDK import 必须且只能在此文件） |
| **`src/sandbox/`** | sandbox 容器内执行 API 服务——在隔离容器中执行任意命令（bash）回传结果；共享密钥认证 + cwd 白名单 + 超时强杀 + egress 内网锁定 | `src/sandbox/main.ts`、`src/sandbox/exec-api.ts`（头部注释 F/WP3 Task 10） |

> 注：src 各目录**无 README**（唯一 README 在 `src/ptl/tui-shared/README.md`）；职责描述来自根 `ARCHITECTURE.md` + 各入口文件头部注释。

### PTH 到底是什么
**模块化单体服务器 + 联邦宿主**，不是纯网关。`docs/pth/architecture.md` 明言："pi-platform 采用**模块化单体**架构。所有模块在单一 Node.js 进程中运行，但通过明确的接口（DTO + AsyncIterable）实现逻辑隔离…可以独立拆分到微服务"。分层：Gateway（Fastify+auth+SSE）→ Core（AgentEngine/SessionPool/AsyncIterableBridge）→ Platform（ModelRouter/ToolPlatform/WorkflowOrchestrator/WorkspaceManager/HotReloader）→ Infrastructure（Redis/BullMQ/pino/prom-client）。
**入口/装配点**：`src/pth/main.ts`（组合装配全部组件：Redis、sessionStore、settingsStore、credential、audit、workspaceMgr、modelRouter、toolPlatform、sessionPool、sandboxClient、agent-lab 动态注入、AgentEngine、WorkflowOrchestrator、HotReloader、intentWorker、createSystemSession、ProgramStore、FallbackRequestStore、Fastify server）。

### PTH ↔ agent-lab 关系（重点）
**agent-lab 是独立子系统，以 pi 扩展形态被 PTH 以"常驻系统会话"托管——不是 PTH 的代码模块。**

- **形态**：`extensions/agent-lab/` 是独立包（独立 package.json/README/src/docs/test，monorepo 内），default export 为 `(pi: ExtensionAPI) => …`（`extensions/agent-lab/index.ts:80`），是标准 **pi 扩展**（ExtensionAPI/ExtensionContext 来自 `@earendil-works/pi-coding-agent`）。
- **加载方式**：`src/pth/main.ts:96-108` —— 动态 `import("../../extensions/agent-lab/index.ts")`，取 `default` export（InlineExtension 裸 factory）push 进 `systemExtensionFactories`，传给 AgentEngine（main.ts:108）。注释明言："S3 路径 b：agent-lab 经 extensionFactories 编程注入常驻系统会话（F/WP5 Task 24）"；"非字面量 import specifier——tsc rootDir=src 不能静态 import extensions/ 下的 .ts（TS5097）"；**失败放行（fail-open）**。
- **承载处**：`src/pth/core/agent-engine.ts:563-602` —— 常驻系统会话（tenantId="system"、RESERVED 标记、evict 豁免、recoverAll 优先恢复、watchdog 崩溃重建，agent-engine.ts:54/513/746）构建时 `noExtensions: true` + `extensionFactories: systemExtensionFactories` + 显式 `resourceLoader.reload()`（agent-engine.ts:597-602）。
- **定位语义**：常驻系统会话 = 联邦骨架 "system-governor 的实例化雏形"（F 阶段 spec §6.0）；agent-lab 保持其原生 pi 扩展形态、**零适配**（spec 选项 C），PTH 主进程对其**零静态引用**（仅动态 specifier 字符串）。
- 同类扩展：`extensions/agent-lab-bidder/`（市场竞价工具 place_bid，已标 deprecated-for-bidding 保留兼容）、`extensions/ptl-communicate|ptl-control|ptl-providers|workflow`（PTL 侧扩展，共享层 symlink 注入模板）。

---

## (B) 设计文档意图架构（13 specs）

### 13 specs 一览（日期·主题·状态）
| spec | 主题 | 状态 |
|---|---|---|
| 08-01 ptl-communicate-control-consolidation | ptl-communicate/ptl-control 扩展整合 | 已确认 |
| 08-01 ptl-update-release | 发行版更新机制 | 已确认 |
| 08-02 workflow-runtime-extension | 子项目 A：ptl-flow code 节点+metrics 声明 | 已合并 |
| 08-02 memory-system | 子项目 B：L3 语义记忆系统 | 已合并 |
| 08-02 agent-assembly | 子项目 C：装配层 assembleAgent | 设计（待评审）→ 已实施 |
| 08-03 economy-layer | 经济层（市场闭环） | 定稿（5 轮评审收敛）→ 已实施 |
| 08-05 **federation-skeleton** | **联邦骨架 v1.0：计算图/治理/信任抽象模型** | **可用（概念锚点）** |
| 08-05 **containerization-architecture** | **F 阶段：容器化/PTL 架构更新/联邦触发机制** | **✅ 已实施** |
| 08-05 dev-container | G 阶段：dev 容器 | ✅ 已实施 |
| 08-06 cli-template-migration | CLI 化迁移 Roadmap（扩展退场） | 设计待评审 |
| 08-06 info-ingestion-loop | 信息摄入循环 v1（联邦地基一） | 已交付 |
| 08-06 ptl-agent-lab-polish | PTL 认知注入 + 调度模式打磨 | 草案待审 |
| 08-06 task-pool-sorter | 任务模板+任务池+分选器（联邦地基二） | 设计→已部分实施 |

### 意图架构（三层视图）

**① 联邦骨架概念模型**（`2026-08-05-federation-skeleton-design.md`，v1.0 可用版）：
联邦 = 在资源限制下自组织计算结构完成任务的系统。核心结构：**系统计算图**（静态骨架/治理顶层/可序列化/**存 PTH**）→ 生成 → **实例计算图**（动态运行层）。宽度=每层水平展开，深度=治理嵌套（图即节点递归）。本体：节点（责任⇄权利，权利=权限⊆+额度≤）、图、构件（上传填槽生效）、空位、通路（相位/数据）、法律（宪法预置、不可系统内修改）、治理节点+回退节点（**分离禁令**，根回退终点=**PTL 人类**）。五公理 A1 资源限制 / A2 责任⇄权利平衡 / A3 治理是计算任务 / A4 顶层自治理（宪法预置）/ A5 图生图。**诚实标注的遗留**：信任链暂缓、法律算法强制侧未实现、治理/回退节点未实例化、org 仅平面垫付（嵌套市场树待实现）、operator 不在 RESERVED_IDS。

**② F 阶段容器化目标架构**（`2026-08-05-containerization-architecture-design.md`，§2 目标架构总览）：
```
开发者机器：PTL CLI（本机 tmux 工具）+ ptl hub <…>（HTTP/SSE/WS）
   ↓
Docker Compose 联邦态：
  ├─ pth 容器（联邦宿主，单实例）：网关/会话池/SDK 会话/
  │    【常驻系统会话】= system-governor 雏形（加载 agent-lab 扩展）
  │    ComponentStore（ProgramStore 泛化）/ 空位绑定 / 回退请求队列
  ├─ sandbox 容器（唯一）：所有代码执行（bash 等全转发）+ 自修改调试区
  └─ redis 容器：池元状态/锁/队列/审计/构件版本指针
  卷：workspaces / platform / tenants / components / agent-dir / sessions / agent-lab
```
核心不变量：**单实例 pth**；**pth 进程内只有会话/推理/编排，任何代码执行转发 sandbox**；**一切持久状态在卷或 Redis**（容器可随意重建）。§6.0 接线选项 C：agent-lab 零适配、常驻系统会话承载（pth 主进程零 agent-lab 引用，spike 兜底退 pth 直接 import）。

**③ PTL 架构更新 + 联邦落地路径**（同 spec §5 + 08-06 specs）：
- PTL 保持本机 tmux 工具不变，hub 从"程序包上传"扩展为完整联邦交互层：ComponentManifest 泛化（§5.1）、targetSlot 空位绑定（§5.2）、legalAuth 声明式登记（§5.3）、fallback_requests 回退通道 + `ptl hub request/requests/respond`（§5.4）、`hub observe/debug`（§5.5）。
- 定时/事件机制落**框架层**（agent-lab scheduler/ + core/）：scheduled_jobs 表 + timed-trigger + event_subscriptions + pth webhook 路由；v0.1 **不引入 BullMQ**（§6.4 裁决）。
- 联邦地基（08-06）：任务投递 → 任务池（SQLite tasks 表+状态机）→ 分选器（agents.selector_json）→ agent 自检执行 → 坏任务回流 → escalated → PTL；领域状态→SQLite 自持表（agent-lab.db），Redis=PTH 网关热状态。
- CLI 化终局（08-06）：扩展机制退场 → CLI + 操作技能；root 模板=唯一保留扩展的控制面（P1-P4，设计待评审）。
- 经济/记忆/装配（08-02/03）：市场经济体制（方案 A）三阶段 = ptl-flow 运行时扩展(A) → 记忆系统(B) → 装配层(C) → 经济层(D)，economy 域=**框架**（framework-vs-construction.md 三层划分：框架/构造/平台，ptl CLI 属平台层不进容器）。

---

## 意图架构 vs 实际代码组织：偏离点

| # | 偏离点 | 设计意图 | 实际代码 | 严重度 |
|---|---|---|---|---|
| 1 | **BullMQ 实际启用** | spec §6.4 裁决 "v0.1 **不引入** BullMQ——常驻会话内定时器+订阅派发器满足单实例；worker 仅保留 no-op 标注演进路径" | `src/pth/workflow/bullmq-worker.ts` + `orchestrator.ts` 被 main.ts **主动创建使用**（`createIntentWorker` + `new WorkflowOrchestrator`，main.ts:36/110/133）；ARCHITECTURE.md 也列为 PTH 核心子系统 | 中（实现超量，非冲突） |
| 2 | **扩展加载路径选定 (b)** | spec §6.0 spike 二选一：(a) agentDir/extensions symlink vs (b) extensionFactories 编程注入；失败退选项 B（pth 直接 import） | 走 (b)：main.ts:96-108 动态 import agent-lab default factory → systemExtensionFactories → agent-engine.ts:599 `extensionFactories`；**保留了动态 specifier 字符串引用**（"零引用"=零静态 import，非字面零引用） | 低（有意为之，注释完整） |
| 3 | **空位绑定 registry 接线未生效** | spec §5.2：scheduler/optimizer 构件上传 → targetSlot 绑定 → **填槽注册进框架层 registry** | `src/pth/components/slot-binding.ts:16-21` 注释自认：WP5 前**仅绑定登记+审计**，registry 接线子项并入 Task 28（依赖常驻会话代理调用）；agent-program 仅可装配常驻标记 | 中（spec 标注的部分落地降级） |
| 4 | **CLI 化迁移未开始** | 08-06 cli-template-migration：P1 试点（cli-dev 模板 + 通用排除机制 + 双技能 + local→root 更名） | 无 cli-dev/ptl-agent 痕迹（find 无结果）；`src/ptl/shared-layer.ts` symlink 扩展注入机制仍活跃；spec 状态=设计待评审 | 低（计划内，未启动） |
| 5 | **联邦骨架概念未实例化** | federation-skeleton §8 遗留：治理/回退节点、法律算法强制、信任链、嵌套 org、operator 身份 | 实际：常驻系统会话=首个 system-governor 雏形（agent-engine.ts:563-602）；`src/pth/components/slot-binding.ts` legalAuth 字段=声明式登记（§5.3 落地）；无回退节点 watchdog 链 | 符合设计（spec 自身诚实标注为实现侧遗留） |
| 6 | **任务池/摄入已提前实施** | 08-06 task-pool-sorter/info-ingestion 状态="brainstorming 定稿，待用户审阅" | agent-lab 已实现 `src/ingest/`（cycle/pipeline/docs-source）与 `src/taskpool/`（cycle/engine/semantic-split/templates/tasks，git log 1da5f42 全链路验证） | 低（设计后快速实施，正常迭代） |
| 7 | **PTH 与 agent-lab 代码隔离** | spec §6.0 选项 C：pth 主进程零引用、agent-lab 零适配 | 隔离保持（PTH 无静态 import agent-lab；唯一接触点是 main.ts 动态 specifier + systemExtensionFactories 参数 + AGENT_LAB_DB_PATH/CONFIG_DIR env 注入，agent-engine.ts:675-677） | 符合设计 |
| 8 | **会话外置/沙箱化** | §3.1 会话外置（SDK sessionDir + Redis 池元 + recoverAll）；§4 代码执行全量转发 sandbox | 已实现：agent-engine.ts:84/114-115/208（sessionDir 显式落盘）、session-pool.ts:62-69（Redis pool:{sid}:meta 写直通/读穿透 + loadAllFromRedis）、agent-engine.ts:740 recoverAll、main.ts sandboxBash（统一接口名 bash 平台级替换内建）+ sandbox degraded 监控 + 共享密钥 | 符合设计 |

**结构性判断**：意图架构（联邦骨架→F 容器化→hub 交互层→常驻系统会话承载 agent-lab）与代码组织**高度一致**——`src/pth/` 各子目录（components/fallback/programs/self-modify/sandbox-bash）与 F 阶段 WP1-WP5 一一对应；主要偏差是"设计裁决 vs 实施细节"层面的（BullMQ 保留、slot-binding 降级、CLI 迁移未启动），无架构级冲突。

---

## 给后续 agent 的关键文件

- **`src/pth/main.ts`**（189 行）— PTH 装配点全貌，PTH↔agent-lab 注入逻辑（96-108 行）
- **`src/pth/core/agent-engine.ts`**（~900 行）— 常驻系统会话/RESERVED/watchdog/extensionFactories 接线（54/513/563-602/675-677/740）
- **根 `ARCHITECTURE.md`** — 双产品全景 + 数据流 + 硬约束（自称单一真相源）
- **`docs/superpowers/specs/2026-08-05-containerization-architecture-design.md`**（300 行）— F 阶段目标架构 + §6.0 接线选项 C
- **`docs/superpowers/specs/2026-08-05-federation-skeleton-design.md`**（344 行）— 概念模型 + §6 语义锚定表 + §8 遗留清单
- **`extensions/agent-lab/docs/framework-vs-construction.md`**（86 行）— 框架/构造/平台三层归属，economy 域=框架
