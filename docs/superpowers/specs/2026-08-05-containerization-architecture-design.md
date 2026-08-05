# F 阶段架构设计：容器化 / PTL 架构更新 / 联邦触发机制

**版本**：v0.1（草案——待对抗性评审迭代，约定 >1.0 方为可用版本）
**状态**：设计草案
**日期**：2026-08-05
**前置**：`docs/superpowers/specs/2026-08-05-federation-skeleton-design.md`（联邦骨架 v1.0——概念锚点）、`docs/pth/architecture.md`、`docs/ptl/architecture.md`、`extensions/agent-lab/docs/framework-vs-construction.md`
**输入裁决**（2026-08-05 用户确认）：①单实例优先+会话外置设计（多副本列为演进路径）+工作区分离；②**所有代码执行全部沙箱化**（唯一 sandbox 容器）；自修改=沙箱内跑 PTL 调试；③PTL 保持本机 tmux 工具+hub 渐进扩展为完整联邦交互层；④定时/事件=架构+框架层最小实现。

---

## §1 范围与目标

F 阶段回答一个问题：**联邦骨架 v1.0 的概念（构件/空位/回退/机制通路）如何落成可运行的部署与运行架构**。

三件事（同一整体的三面）：

1. **容器化**：联邦（PTH）在容器中生产可用——会话可恢复、数据不丢失、构建可复现。
2. **PTL 架构更新**：PTL 从"本机 tmux 壳"演进为"本地构建 → 远程联邦"的完整交互层——构件上传泛化、远程观测、回退响应。
3. **联邦触发机制**：联邦的机制性通路扩展——定时触发与事件驱动（框架层最小实现）。

**非目标**（本 spec 不覆盖）：多副本水平扩展（演进路径，见 §3.6）；信任链（概念暂缓）；法律引擎（v1.x）；E 联邦引导的业务种子（种子任务类型/初始货币发行——在 F 的架构就绪后另行 plan）。

---

## §2 目标架构总览

```
┌─ 开发者机器（本机态）──────────────────────────────┐
│  PTL CLI（保持本机 tmux 工具——本地构建/调试）        │
│   └─ pit hub <...> ─────────────┐                  │
└──────────────────────────────────┼────────────────┘
                                    │ HTTP/SSE/WS（Bearer auth）
┌─ Docker Compose（联邦态）─────────▼────────────────┐
│  ┌─ pth 容器（联邦宿主，单实例）──────────────────┐ │
│  │ 网关（HTTP/SSE/WS）/ 会话池 / SDK 会话          │ │
│  │ ComponentStore（构件存储+版本化——ProgramStore    │ │
│  │   泛化）/ 空位绑定生效                          │ │
│  │ 调度器框架（dispatch 唯一入口）                 │ │
│  │ 定时触发器 + 事件订阅（§6）                     │ │
│  │ 根回退节点 → 构件请求队列（→PTL 透传，§5.4）    │ │
│  └───────┬────────────────────────────────────────┘ │
│          │ 代码执行转发（compose 内部网络，§4）       │
│          ▼                                          │
│  ┌─ sandbox 容器（唯一——所有代码执行）─────────────┐ │
│  │ 执行 API（bash/文件操作等全部代码工具）          │ │
│  │ 自修改模式：镜像内嵌 pi+PTL+扩展（联邦内调试区） │ │
│  └────────────────────────────────────────────────┘ │
│  ┌─ redis 容器 ───────────────────────────────────┐ │
│  │ 会话池元状态 / 锁 / 队列 / 审计 / 构件版本指针   │ │
│  └────────────────────────────────────────────────┘ │
│  卷（全部持久化）：workspaces / platform / tenants /  │
│    components / agent-dir / sessions                 │
└──────────────────────────────────────────────────────┘
```

**核心不变量**：
- **单实例 pth**（联邦=单一自治体）；多副本仅为性能演进路径（§3.6）。
- **pth 进程内只有会话/推理/编排**——任何代码执行（bash 等）转发 sandbox（§4）。
- **一切持久状态在卷或 Redis**——容器可随意重建（§3.3）。

---

## §3 容器化部署架构

### 3.1 会话外置（G1 blocker 的解）

**现状**：`SessionManager.inMemory(cwd)`（agent-engine.ts:115）——会话上下文不落盘；`recoverAll()` 空 stub；池元状态（`PoolSession`）纯内存 Map。

**目标设计**：

1. **SDK 会话持久化**：改用 SDK 的文件持久化 SessionManager（PTL 的 pi CLI 已用 `--session-dir` 落盘 JSONL——SDK 能力存在，pth 仅未启用）。会话上下文落 `sessions` 卷：`<tenantId>/<sessionId>/`。
2. **池元状态入 Redis**：`PoolSession` 字段（sessionId/tenantId/project/state/refCount/lastCheckpointSeq/versionSnapshot/model）写 Redis `pool:{sid}:meta`；内存 Map 降级为缓存。
3. **recoverAll 实现**：启动时扫 Redis 池元状态 → 逐会话 revive（SDK 从 sessions 卷恢复上下文）→ 状态置 idle；`recoverableIndex` 死代码启用或删除。
4. **恢复边界（接受并文档化）**：恢复以**最后 checkpoint** 为界——in-flight tool 调用/订阅回调的中态不可恢复；busy 中崩溃的会话恢复为 idle + 标记 `recovered-from-crash`（审计可见）。
5. **开放点（需技术调研）**：SDK revive 的完整性边界（pi SDK 会话恢复 API 的确切语义）——实施前 spike 验证。

### 3.2 工作区分离

- **层级**：`workspaces/<tenantId>/<projectId>/`；program 运行会话用 `workspaces/<tenantId>/program-run-<sessionId>/`（现状延续）。
- **隔离边界**：tenant 间路径级隔离（WorkspaceManager 已有雏形）；**pth 与 sandbox 共享挂载同一 workspaces 卷**（agent 代码执行的 cwd 对两者可见——沙箱转发的文件前提，见 §4.2）。
- **清理策略**：program-run-* 目录随会话 evict/destroy 清理（现状 programRunDirs 机制延续）；sessions 卷随会话 destroy 清理。

### 3.3 持久化完备性（现有缺口修复）

| 缺口（调研实证） | 修复 |
|---|---|
| G4：`DATA_DIR/programs` 未挂卷 | 新增 `components` 卷（ProgramStore 泛化为 ComponentStore 后迁此，§5.2） |
| G2：agent dir 硬编码 `~/.pi/agent` 未挂卷 | 新增 `agent-dir` 卷 + compose 设置 `PI_CODING_AGENT_DIR=/data/agent-dir` |
| G8：Redis `allkeys-lru` 可淘汰 auth/audit | 改 `noeviction` + 容量监控告警（或拆两实例——v0.1 取改策略，拆实例留演进） |
| G9：Dockerfile 构建疑点（`npm ci --omit=dev` 后 `npx tsc` 缺 typescript）+ root 运行 + 无 .dockerignore | 改**多阶段构建**（builder 阶段全量 devDeps 编译 → runtime 阶段仅 dist+prod node_modules）+ 非 root 用户 + .dockerignore |
| G5：BullMQ no-op | 保留为定时/事件机制的队列基础（§6.4 接线）或移除——§6 裁决后定 |

**不变量**：`docker compose down && up` 后——会话可恢复（§3.1）、构件不丢（components 卷）、agent 能力不漂移（agent-dir 卷）、认证不失效（Redis 驱逐策略）。

### 3.4 self-modify 容器语义（G3）

- **L1 HotReloader**（skills/prompts/config 热更）：保留——监听 platform 卷，校验+注入（修复"只校验不注入"缺口：接线 ResourceLoader 指向 agent-dir 卷）。
- **L3 RebuildTrigger**（写 `.rebuild-request` 由容器外 supervisor A/B 重建）：**重新定位**——容器语义下"自修改"= **构件上传**（新代码作为构件经 §5 通道上传填槽生效），而非容器内自重建。`.rebuild-request` 机制废弃；需要容器级更新时由人类经 PTL/compose 重建（非联邦自治行为）。
- **自修改调试**：在 sandbox 容器内进行（§4.3）——与骨架"PTL=builder's workbench"对齐。

### 3.5 平台层归位（ptl CLI 不进容器）

`framework-vs-construction.md` 已定：ptl CLI 属平台层（开发态接入）。compose 只含 **pth / sandbox / redis** 三容器；PTL 留在开发者机器，经 hub（HTTP/SSE/WS）交互。

### 3.6 演进路径（多副本——非本阶段）

触发条件：单实例性能瓶颈实测。届时需：亲和路由（sticky session）/ 分布式限额（Redis 计数替代进程本地 canCreate）/ 会话外置已完成（§3.1 是前置）。spec 不展开。

---

## §4 代码执行沙箱（sandbox 容器）

### 4.1 定位

**所有代码执行全部在 sandbox 容器**（用户裁决 2026-08-05）：pth 进程内 SDK 会话的 bash/代码类工具调用，一律转发 sandbox 执行。pth 进程本身不持有任何代码执行能力（攻击面收敛 + 资源隔离 + 联邦宿主稳定性）。

### 4.2 执行转发机制

- **转发边界**：pi SDK 的 bash 工具（及等价代码执行工具）——在 sdk-adapter 层（SDK 唯一导入点）拦截/替换为远程执行客户端。
- **传输**：compose 内部网络——sandbox 暴露**执行 API**（HTTP：POST /exec {cmd, cwd, env, timeout} → {stdout, stderr, exitCode}；流式输出走 SSE/WebSocket）。
- **文件前提**：cwd 必须在共享 workspaces 卷内（§3.2）——sandbox 挂载同一卷，路径语义一致（容器内路径约定统一为 `/data/workspaces/...`）。
- **安全**：sandbox 容器无外部网络（或白名单 egress）；资源限额（CPU/内存/进程数）；非 root 运行；执行超时强杀。
- **开放点（需技术调研）**：pi SDK bash 工具的拦截/替换点（SDK 是否支持工具覆盖或需自定义工具注入）——实施前 spike 验证；若 SDK 不支持，备选=自定义 `bash` 工具经 SDK 工具注册替换内建。

### 4.3 自修改模式（sandbox = 联邦内调试区）

- sandbox 镜像内嵌 **pi + PTL + 扩展**（pit-communicate/pit-control 等）。
- 自修改/构件开发场景：在 sandbox 内启动 PTL 会话（tmux 在 sandbox 容器内——本机语义在容器内成立），人类经 `pit hub debug`（§5.5）接入或治理节点经回退通道触发；调试产物 = **构件**，经 §5 构件上传通道回流 pth 填槽生效。
- 与骨架对齐：sandbox 是"系统内的构建区"——根回退节点透传的构件请求，人类在 sandbox（或本机 PTL）中补全。

---

## §5 PTL 架构更新（hub 扩展为联邦交互层）

**原则**：PTL 保持本机 tmux 工具不变（本地构建/调试路径不动）；**hub 从"程序包上传"扩展为完整联邦交互层**。hub submit 现状 = 构件上传的"agent 程序包"特例原型（打包/校验/版本化/远程部署骨架已具备）。

### 5.1 构件类型泛化（Component）

`ProgramManifest` 泛化为 `ComponentManifest`：

```
ComponentManifest = {
  type: "agent-program" | "scheduler" | "optimizer" | "memory-pack" | "skeleton-update" | ...,
  name, version-pin?, description,
  payload: <类型相关——程序包目录 / 定义 JSON / 记忆文件集 / 骨架变更描述>,
  targetSlot?: string,        // 空位绑定（§5.2）
  legalAuth?: string,         // 治理授权引用（§5.3）
  ...原 ProgramManifest 字段（type=agent-program 时）
}
```

- 打包/校验/上限机制沿用 pack.ts 骨架（按 type 分派校验器）。
- 上传 API：`POST /api/v1/components`（ProgramStore 的 `/api/v1/programs` 保留为 agent-program 的兼容别名）。

### 5.2 ComponentStore + 空位绑定生效

- **ComponentStore**（ProgramStore 泛化）：`components` 卷 `<tenantId>/<type>/<name>/<version>/`；Redis 版本指针/原子 INCR 分配/GC——全部沿用 ProgramStore 模式。
- **空位绑定**：上传携带 `targetSlot` → ComponentStore 登记"构件→空位"绑定 → **生效**（填槽：调度器/优化器类构件注册进框架层 registry；agent-program 可装配为常驻节点而非仅临时 run）。
- **生效语义对齐骨架 §4.2**：部署=登记校验（构件记录字段良构——O(1) 检查），语义求值推迟（信任链暂缓期间：无前置验证，仅登记+审计）。
- **无 targetSlot** 的上传 = 仅存储（现状行为，兼容）。

### 5.3 法律约束（最小强制——骨架 v1.0 裁决）

- 上传需携带 `legalAuth`（治理授权引用）；v0.1 最小实现：**RESERVED_IDS 扩展**（root-governor/root-fallback 身份）+ **装配层身份校验**（ComponentStore 校验上传者 token 对应的身份是否有该空位所属图的治理权限）。
- 完整法律引擎（法律文件解析/条款校验）留 v1.x——接口预留。

### 5.4 回退响应通道（PTH → PTL 方向——新增）

骨架 v1.0：根回退节点把"图无法自处理的构件缺口"透传给人类（PTL 补全）。落地：

- **pth 侧**：`fallback_requests` 队列（Redis）——根回退节点触发时 push `{requestId, slotHint, description, urgency, createdAt, status}`。
- **PTL 侧**：`pit hub requests`（拉取待补全请求列表）/ `pit hub respond <requestId> <dir>`（构建构件→上传→关联 requestId 闭合）。
- **通道复用**：respond 走 §5.1 构件上传 API + requestId 关联（非新协议）。
- 人类补全流程闭环：根回退透传 → `pit hub requests` 可见 → 本地/sandbox 构建 → `pit hub respond` 上传填槽 → 请求闭合（审计）。

### 5.5 远程观测与调试接入

- **`pit hub observe`**：远程会话列表/会话详情/trace 时间线/事件查询（PTH 网关新增只读路由——复用 Redis 会话痕迹 + agent-lab EventLog 查询能力）。
- **`pit hub debug <target>`**：接入 sandbox 自修改模式（§4.3）——WebSocket 交互式会话（vs 现 hub run 的 SSE 单向）。
- 现有 `hub submit/run/programs/dev` 保留（run 语义升级为"以最新版本临时运行"，长期定位被"装配常驻"替代——见 §8 演进）。

---

## §6 定时与事件机制（框架层最小实现）

**原则**（framework-vs-construction）：机制落**框架层**（agent-lab `scheduler/`+`core/`），pth 做部署与外部入口。全部复用现有唯一入口 `SchedulerRunner.dispatch`（fallback/settle/审计事件免费获得）。

### 6.1 ScheduledJobs（定时触发）

- **存储**：agent-lab SQLite 新表 `scheduled_jobs`：
  `{id, taskType, scheduleKind(cron|at|interval), scheduleSpec, payload(json), status(active|paused|done|cancelled), nextFireAt, lastFireAt, fireCount, createdBy, legalRef?}`
- **触发器**：框架层 `scheduler/timed-trigger.ts`——周期扫描（interval，pth 进程内 unref 定时器）到期 job → 构造 `DispatchRequest` → `runner.dispatch` → 更新 nextFireAt/状态。
- **持久性**：SQLite 落表——重启后扫描恢复（missed-fire 策略：立即补火一次 vs 跳过——配置项，默认补火一次）。
- **管理面**：`/lab schedule add/ls/pause/resume/rm`（agent 侧扩展命令）+ pth 网关只读路由（hub observe 可见）。

### 6.2 事件订阅（事件驱动）

- **订阅表**：`event_subscriptions`：`{id, eventPattern(事件类型/过滤条件 json), taskType, payload模板, status, createdBy}`。
- **订阅机制**：EventLog 之上加**订阅派发器**——`core/events/event-log.ts` append 后同步通知订阅派发器（内存回调注册表），匹配订阅 → dispatch。EventLog append-only 语义不变（订阅是旁路，不改日志）。
- **与既有三层事件的关系**：EventLog（框架通用——本次加订阅）/ EconomyEventBus（economy 专用，不动）/ DelegationEventBus（pi.events——pth 侧 agent in-process 场景的外部事件入口，见 §6.3）。

### 6.3 外部事件入口（pth 网关 webhook）

- **新增路由**：`POST /api/v1/events`（Bearer auth）——外部系统/人类 push 事件 `{eventType, payload, source}` → pth 映射为 agent-lab 事件（写入 EventLog + 触发订阅派发）。
- **事件→任务映射**：订阅表（§6.2）即映射声明——联邦内任何节点可注册"何种事件触发何种任务类型"。

### 6.4 与 BullMQ 的关系（G5 裁决）

- v0.1：**不引入 BullMQ**——定时器+订阅派发器在 pth 进程内即可满足单实例；BullMQ worker（no-op）保留代码但标注"多副本/跨进程队列时启用"（演进路径）。
- 理由：单实例下 SQLite+内存派发足够；引入 BullMQ 徒增运维复杂度（与"单实例优先"裁决一致）。

### 6.5 workloop 续跑（可复用基础）

workloop checkpoint/resume 能力已存在（`workloop/runner.ts`）——定时/事件触发的 dispatch 若指向 checkpoint 恢复（payload 携带 checkpointId），即得"到点续跑/事件续跑"能力（E6 缺口的解，v0.1 仅声明该组合可行，具体任务类型留给构造层）。

---

## §7 与联邦骨架 v1.0 的锚定

| 骨架概念 | 本 spec 落点 |
|---|---|
| 构件（更新包） | §5.1 ComponentManifest 泛化（多类型构件上传） |
| 空位 / 填槽生效 | §5.2 targetSlot 绑定 + ComponentStore 登记生效 |
| 骨架存 PTH（可序列化） | §3 pth 容器单实例 + 卷持久化（骨架=system-graph 构件，经 skeleton-update 类型上传） |
| 根回退节点 → PTL | §5.4 fallback_requests 队列 + `pit hub requests/respond` |
| PTL = builder's workbench | §5 全部（本机 PTL + hub 交互层）+ §4.3 sandbox 自修改模式 |
| 机制性通路（扩展） | §6 定时触发/事件驱动（通路的新触发源——dispatch 唯一入口复用） |
| 治理节点/回退节点实例化 | §5.3 RESERVED_IDS 扩展 + 身份校验（最小强制）；完整实例化留 E |
| 法律约束（构件生效） | §5.3 legalAuth 最小实现（接口预留法律引擎 v1.x） |
| A1 资源限制（容器层投影） | §4.2 sandbox 资源限额/egress 白名单 |

---

## §8 实施路线图（工作包划分——供 plan 细化）

| WP | 内容 | 关键依赖 | 规模估计 |
|---|---|---|---|
| **WP1** Docker 基线修复 | 多阶段构建/非 root/.dockerignore/卷完备（components/agent-dir/sessions）/Redis 驱逐策略/G4 G2 G8 G9 | 无 | 小（2-3 任务） |
| **WP2** 会话外置 | SDK 持久化 SessionManager 接线/池元状态入 Redis/recoverAll 实现/工作区分离清理/恢复边界文档化 | WP1；SDK revive spike | 中（4-6 任务） |
| **WP3** sandbox 容器 | sandbox 镜像（pi+PTL+扩展）/执行 API/pth 侧 SDK 工具转发（spike：SDK 工具拦截点）/workspaces 共享卷/资源限额 | WP1；SDK 工具拦截 spike | 中（4-5 任务） |
| **WP4** hub 扩展 | ComponentManifest 泛化/ComponentStore/targetSlot 绑定生效/legalAuth 最小强制/fallback_requests+hub requests/respond/hub observe/hub debug | WP1；WP3（debug） | 中大（5-7 任务） |
| **WP5** 定时/事件 | scheduled_jobs 表+定时触发器/event_subscriptions+订阅派发器/pth webhook 路由/管理面命令 | WP1（SQLite 在 pth——注意：agent-lab SQLite 单文件，pth 进程内嵌 OK） | 中（4-5 任务） |

**顺序建议**：WP1 →（WP2 ∥ WP3）→ WP4 → WP5。WP4 依赖 WP3 的 sandbox（debug 通道）；WP5 相对独立可提前。
** Spike 前置**：两个技术开放点（SDK revive 完整性 / SDK bash 工具拦截点）建议在 WP2/WP3 开工前各安排一次 spike 验证。

---

## §9 范围与非目标 / 遗留

**非目标**：多副本架构（§3.6 演进）；信任链（暂缓）；法律引擎（v1.x）；E 业务种子（架构就绪后另行 plan）；agent 容器化隔离（用户裁决：唯一 sandbox 即可，非每 agent 一容器）。

**遗留/开放点**：
- SDK revive 完整性边界（spike——WP2 前置）。
- SDK bash 工具拦截/替换点（spike——WP3 前置）。
- missed-fire 策略默认值（补火一次——实施时可调）。
- Redis 拆双实例（数据/队列分离）——演进路径。
- sandbox egress 白名单内容（实施时按构造层需要定）。
- hub debug 的交互协议（WebSocket 会话语义——WP4 细化）。

---

*本 spec 为 F 阶段架构设计草案，待对抗性评审迭代收敛（沿用联邦骨架 spec 的评审方法论）。*
