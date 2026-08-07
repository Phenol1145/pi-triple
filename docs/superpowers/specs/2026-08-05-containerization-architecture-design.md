# F 阶段架构设计：容器化 / PTL 架构更新 / 联邦触发机制

**版本**：v0.2（评审通过版——首轮对抗性评审修订后收敛）
**状态**：✅ **已实施**（2026-08-05 F 阶段完成——WP1-WP5 全部落地；见 runbook `docs/superpowers/runbooks/2026-08-05-containerized-federation.md`）
**日期**：2026-08-05（v0.2 修订 + 实施完成）
**前置**：`docs/superpowers/specs/2026-08-05-federation-skeleton-design.md`（联邦骨架 v1.0——概念锚点）、`docs/pth/architecture.md`、`docs/ptl/architecture.md`、`extensions/agent-lab/docs/framework-vs-construction.md`
**输入裁决**（2026-08-05 用户确认）：①单实例优先+会话外置设计（多副本列为演进路径）+工作区分离；②**所有代码执行全部沙箱化**（唯一 sandbox 容器）；自修改=沙箱内跑 PTL 调试；③PTL 保持本机 tmux 工具+hub 渐进扩展为完整联邦交互层；④定时/事件=架构+框架层最小实现。**首轮评审后补充裁决**：⑤legalAuth=声明式（仅登记+审计，不拦截）；⑥回退请求=手动建单先行（自动触发留 E）；⑦sandbox 不持 LLM 密钥（自修改调试按需临时注入）；⑧定时/事件接线=**常驻系统会话承载**（选项 C——agent-lab 零适配，system-governor 实例化雏形；SDK 会话扩展加载 spike 兜底退 pth 直接 import）。

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
│   └─ ptl hub <...> ─────────────┐                  │
└──────────────────────────────────┼────────────────┘
                                    │ HTTP/SSE/WS（Bearer auth）
┌─ Docker Compose（联邦态）─────────▼────────────────┐
│  ┌─ pth 容器（联邦宿主，单实例）──────────────────┐ │
│  │ 网关（HTTP/SSE/WS）/ 会话池 / SDK 会话          │ │
│  │ 【常驻系统会话】= system-governor 雏形：         │ │
│  │   加载 agent-lab 扩展（定时/事件/dispatch）      │ │
│  │ ComponentStore（构件存储+版本化——ProgramStore    │ │
│  │   泛化）/ 空位绑定生效                          │ │
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
│    components / agent-dir / sessions / agent-lab      │
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
5. **恢复清理（崩溃残留处理）**：recoverAll 时同步清理——①Redis 锁（workflow/session 锁全部过期重建）；②refCount 归零重计；③in-flight SSE 订阅者已断连（无需处理，新请求新建订阅）；④Redis 队列中 pending dispatch：**默认丢弃+审计标记**（不重放——幂等性不可保证的任务重放风险大于丢失）；⑤stale busy 会话强制置 idle。
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
| G9：Dockerfile 构建疑点（`npm ci --omit=dev` 后 `npx tsc` 缺 typescript）+ root 运行 + 无 .dockerignore + **`CMD dist/main.js` 与 package.json bin `dist/pth/main.js` 不符**（评审新发现） | 改**多阶段构建**（builder 阶段全量 devDeps 编译 → runtime 阶段仅 dist+prod node_modules）+ 非 root 用户 + .dockerignore + CMD 修正为 `dist/pth/main.js` |
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

**所有代码执行全部在 sandbox 容器**（用户裁决 2026-08-05）：pth 进程内 SDK 会话的 bash/代码类工具调用，一律转发 sandbox 执行。**边界澄清**：这是**工具面收敛**（SDK 工具层的 bash/代码执行能力转发）——pth 进程自身运行（Node 运行时/扩展加载）不属于"代码执行"范畴。

### 4.2 执行转发机制

- **转发边界**：pi SDK 的 bash 工具（及等价代码执行工具）——在 sdk-adapter 层（SDK 唯一导入点）拦截/替换为远程执行客户端。SDK 能力已实证：`tools`/`excludeTools`/`customTools` 选项存在（exclude 内建 bash + 注册 sandbox 转发 custom tool 可行）；未证点=同名替换是否被 SDK 特殊对待（spike）。
- **传输**：compose 内部网络——sandbox 暴露**执行 API**（HTTP：POST /exec {cmd, cwd, env, timeout} → {stdout, stderr, exitCode}；流式输出走 SSE/WebSocket）。
- **认证**：pth↔sandbox **共享密钥**（compose 内网不足以防伪——Redis/他容器被破时不能直接调 exec；密钥经 compose secrets/env 注入，非镜像硬编码）。
- **egress 白名单最小集（v0.2 裁决，不推给实施）**：sandbox 默认**无外部网络**（`network_mode: internal` 或等价）；自修改调试需要包下载时按需临时开通（人工操作，非自动）。
- **文件前提**：cwd 必须在共享 workspaces 卷内（§3.2）——sandbox 挂载同一卷，路径语义一致（容器内路径约定统一为 `/data/workspaces/...`）。
- **资源限额**：CPU/内存/进程数限额 + 执行超时强杀 + 非 root 运行。
- **开放点（spike）**：SDK bash 工具的拦截/替换点——备选=自定义 `sandbox-bash` 异名工具+系统提示重写（侵入但可行）。

### 4.3 自修改模式（sandbox = 联邦内调试区）

- sandbox 镜像内嵌 **pi + PTL + 扩展**（ptl-communicate/ptl-control 等）。
- **密钥策略（v0.2 裁决）**：sandbox **不持 LLM 密钥**——代码执行不需要 LLM；自修改调试需要 pi 调 LLM 时，**按需临时注入**（人工 `docker exec` 注入或 compose 临时 env，用完即撤——非常态持有）。
- 自修改/构件开发场景：在 sandbox 内启动 PTL 会话（tmux 在 sandbox 容器内——本机语义在容器内成立），人类经 `ptl hub debug`（§5.5）接入或治理节点经回退通道触发；调试产物 = **构件**，经 §5 构件上传通道回流 pth 填槽生效。
- 与骨架对齐：sandbox 是"系统内的构建区"——根回退节点透传的构件请求，人类在 sandbox（或本机 PTL）中补全。

### 4.4 sandbox 失效降级（I1——必须设计，非 happy path）

- **启动依赖**：compose `depends_on: sandbox (service_healthy)` + sandbox healthcheck（exec API 探活）；sandbox 未就绪时 pth 不启动/不接收新会话。
- **运行时失效**：bash 转发失败 → **类型化错误**（`sandbox-unavailable`）返回 SDK 会话（agent 可见"代码执行暂不可用"而非静默失败）；会话不崩溃——标记 `degraded`（审计事件）；pth `/health` 降级为 unhealthy（运维可见）。
- **恢复**：sandbox 重启后健康检查通过 → 转发自动恢复（无状态转发，无会话级残留需清理）。
- **定位认知**：sandbox 失效 = 联邦代码执行全瘫（单点——用户裁决接受唯一 sandbox）；降级设计的价值是**可见性与快速恢复**，非规避单点。

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

### 5.3 法律约束（声明式——v0.2 裁决）

- **legalAuth = 声明式字段**（可选，仅登记+审计，**不拦截**——与 §5.2 登记语义一致）：上传可携带 `legalAuth`（治理授权引用——如发起治理会话的 sessionId/traceId），ComponentStore 原样登记；审计时可追溯"谁在何授权下上传了何构件"。
- **无强制校验**：v0.1 不做身份-权限校验（"图→治理者"映射未实例化——骨架 §8 遗留；网关 token 仅含 {tenantId, role}，无校验对象）。
- **演进**：图→治理者映射实例化后（E 阶段），legalAuth 可升级为强制校验（接口已预留）；完整法律引擎留 v1.x。

### 5.4 回退响应通道（PTH → PTL 方向——新增）

骨架 v1.0：根回退节点把"图无法自处理的构件缺口"透传给人类（PTL 补全）。落地：

- **pth 侧**：`fallback_requests` 队列（Redis）——`{requestId, slotHint, description, urgency, createdAt, status}`。
- **生产者（v0.2 裁决：手动建单先行）**：`ptl hub request`——**人工创建构件请求**（模拟根回退节点的透传行为；自动触发判定[watchdog/T 参数]未实例化——骨架 §8 遗留，留 E 阶段接线）。通道先可用、可演示、可验收；dispatch routing.failed 自动挂钩列为 E 候选。
- **PTL 侧**：`ptl hub requests`（拉取待补全请求列表）/ `ptl hub respond <requestId> <dir>`（构建构件→上传→关联 requestId 闭合）。
- **通道复用**：respond 走 §5.1 构件上传 API + requestId 关联（非新协议）。
- 人类补全流程闭环：（手动/未来自动）建单 → `ptl hub requests` 可见 → 本地/sandbox 构建 → `ptl hub respond` 上传填槽 → 请求闭合（审计）。

### 5.5 远程观测与调试接入

- **`ptl hub observe`**：远程会话列表/会话详情/trace 时间线/事件查询（PTH 网关新增只读路由——复用 Redis 会话痕迹 + **agent-lab EventLog 查询**[经常驻系统会话代理——DB 在 agent-lab 卷，pth 主进程不直接读，§6.0]）。
- **`ptl hub debug <target>`**：接入 sandbox 自修改模式（§4.3）——WebSocket 交互式会话（vs 现 hub run 的 SSE 单向）。
- 现有 `hub submit/run/programs/dev` 保留（run 语义升级为"以最新版本临时运行"，长期定位被"装配常驻"替代——见 §8 演进）。

---

## §6 定时与事件机制（框架层最小实现——常驻系统会话承载）

**原则**（framework-vs-construction）：机制落**框架层**（agent-lab `scheduler/`+`core/`）。**接线方式（v0.2 裁决=选项 C）**：agent-lab 保持其原生 **pi 扩展形态**（零适配），由 pth 内的**常驻系统会话**加载承载——pth 主进程维持对 agent-lab 零引用（隔离不动）。

### 6.0 接线架构（选项 C）

```
┌─ pth 容器（主进程零 agent-lab 引用）─────────────────┐
│ 【常驻系统会话】（SDK 会话，加载 agent-lab 扩展）      │
│   = 骨架 system-governor 的实例化雏形                 │
│   ·SchedulerRunner（dispatch 唯一入口）               │
│   ·timed-trigger 扫 scheduled_jobs（进程内定时器）    │
│   ·订阅派发器（event_subscriptions）                  │
│   ·agent-lab.db（卷：/data/agent-lab/）               │
│ 普通 SDK 会话：照常创建/驱逐（定时器不依赖它们）        │
└───────────────────────────────────────────────────────┘
```

- **扩展加载（两条路径，spike 定）**：(a) agentDir/extensions symlink（与 PTL 本机同机制——`DefaultResourceLoader(agentDir)` 实证会加载扩展）；(b) `extensionFactories: InlineExtension[]` 编程注入（SDK 类型定义实证存在——更显式、无文件依赖）。
- **常驻会话机制**（新增概念）：会话池加 `RESERVED` 标记——永不驱逐（evict 豁免）+ recoverAll 时**优先恢复**+ 崩溃时 **watchdog 自动重建**（定时器生命周期=常驻会话生命周期，需保活）。
- **与骨架对齐**：常驻系统会话 = system-governor 实例化的第一步（骨架 v1.0：治理节点骨架自带、代码未实例化——此处补第一个实例化）；后续 E 阶段在此会话上叠加治理能力。
- **spike 兜底**：若 SDK 会话扩展加载在 pth 侧验证失败 → 退**选项 B**（pth 直接 import agent-lab 框架层模块——链路同进程但破零引用隔离，需重议分层）。

### 6.1 ScheduledJobs（定时触发）

- **存储**：agent-lab SQLite 新表 `scheduled_jobs`：
  `{id, tenantId, taskType, scheduleKind(cron|at|interval), scheduleSpec, payload(json), status(active|paused|done|cancelled), nextFireAt, lastFireAt, fireCount, createdBy, legalRef?}`
  ——**含 tenantId**（评审 C2：多租户共享 DB 必须租户隔离）。
- **触发器**：框架层 `scheduler/timed-trigger.ts`——常驻系统会话进程内周期扫描（unref 定时器）到期 job → 构造 `DispatchRequest` → `runner.dispatch` → 更新 nextFireAt/状态。
- **DB 挂卷**：`AGENT_LAB_DB_PATH=/data/agent-lab/agent-lab.db`（compose 显式设置——评审 C2：DB 默认路径不受 PI_CODING_AGENT_DIR 覆盖，必须显式挂卷，否则违反持久化不变量）。
- **持久性**：SQLite 落表——重启后扫描恢复（missed-fire 策略：默认**补火一次**）。
- **管理面**：`/lab schedule add/ls/pause/resume/rm`（常驻会话内扩展命令）+ pth 网关只读路由（hub observe 可见）。

### 6.2 事件订阅（事件驱动）

- **订阅表**：`event_subscriptions`：`{id, tenantId, eventPattern(类型/过滤 json), taskType, payload模板, status, createdBy}`——**含 tenantId**。
- **订阅机制**：EventLog 之上加**订阅派发器**——`core/events/event-log.ts` append 后同步通知订阅派发器（内存回调注册表），匹配订阅 → dispatch。EventLog append-only 语义不变（订阅是旁路）。
- **与既有三层事件的关系**：EventLog（框架通用——本次加订阅）/ EconomyEventBus（economy 专用，不动）/ DelegationEventBus（pi.events——常驻会话内的外部事件入口）。

### 6.3 外部事件入口（pth 网关 webhook）

- **新增路由**：`POST /api/v1/events`（Bearer auth）——外部系统/人类 push 事件 `{eventType, payload, source}` → pth 转发常驻系统会话（经 pi.events 或 DB 写入）→ 触发订阅派发。
- **事件→任务映射**：订阅表（§6.2）即映射声明——联邦内任何节点可注册"何种事件触发何种任务类型"。

### 6.4 与 BullMQ 的关系（G5 裁决）

- v0.1：**不引入 BullMQ**——常驻会话内定时器+订阅派发器满足单实例；BullMQ worker（no-op）保留代码但标注"多副本/跨进程队列时启用"（演进路径）。

### 6.5 workloop 续跑（可复用基础）

workloop checkpoint/resume 能力已存在——定时/事件触发的 dispatch 若指向 checkpoint 恢复（payload 携带 checkpointId），即得"到点续跑/事件续跑"。**已核实（WP5 Task 28d）**：`DispatchRequest`（agent-lab scheduler/runner-types.ts）**无 `checkpointId` 字段**——checkpoint 续跑需走 payload 携带（subscription-task 模板 / task JSON 透传）或后续扩展字段；**不新增字段**（避免超范围——证据：runner-types.ts DispatchRequest 接口仅含 traceId/dispatchId/schedulerInstanceId/role/task/taskCategory/labels/caller/mode/signal/settlementRef）。

---

## §7 与联邦骨架 v1.0 的锚定

| 骨架概念 | 本 spec 落点 |
|---|---|
| 构件（更新包） | §5.1 ComponentManifest 泛化（多类型构件上传） |
| 空位 / 填槽生效 | §5.2 targetSlot 绑定 + ComponentStore 登记生效 |
| 骨架存 PTH（可序列化） | §3 pth 容器单实例 + 卷持久化（骨架=system-graph 构件，经 skeleton-update 类型上传） |
| 根回退节点 → PTL | §5.4 fallback_requests 队列 + `ptl hub requests/respond` |
| PTL = builder's workbench | §5 全部（本机 PTL + hub 交互层）+ §4.3 sandbox 自修改模式 |
| 机制性通路（扩展） | §6 定时触发/事件驱动（通路的新触发源——常驻系统会话承载，dispatch 唯一入口复用） |
| 治理节点/回退节点实例化 | §6.0 **常驻系统会话 = system-governor 实例化雏形**（首个实例化）；legalAuth 声明式预留（强制校验待图→治理者映射，E 阶段） |
| 法律约束（构件生效） | §5.3 legalAuth 声明式（登记+审计不拦截）；强制升级预留（法律引擎 v1.x） |
| A1 资源限制（容器层投影） | §4.2 sandbox 资源限额/egress 白名单（**物理上限先行**；凭证映射留经济层——economy 凭证与容器限额零接线，诚实标注） |

---

## §8 实施路线图（工作包划分——供 plan 细化）

| WP | 内容 | 关键依赖 | 规模估计 |
|---|---|---|---|
| **WP1** Docker 基线修复 | 多阶段构建/非 root/.dockerignore/卷完备（components/agent-dir/sessions）/Redis 驱逐策略/G4 G2 G8 G9 | 无 | 小（2-3 任务） |
| **WP2** 会话外置 | SDK 持久化 SessionManager 接线/池元状态入 Redis/recoverAll 实现/工作区分离清理/恢复边界文档化 | WP1；SDK revive spike | 中（4-6 任务） |
| **WP3** sandbox 容器 | sandbox 镜像（pi+PTL+扩展）/执行 API/pth 侧 SDK 工具转发（spike：SDK 工具拦截点）/workspaces 共享卷/资源限额 | WP1；SDK 工具拦截 spike | 中（4-5 任务） |
| **WP4** hub 扩展 | ComponentManifest 泛化/ComponentStore/targetSlot 绑定生效/legalAuth 声明式登记/fallback_requests+hub request/requests/respond/hub observe（常驻会话代理 EventLog 查询）/hub debug | WP1；WP3（debug）；WP5（observe 的 EventLog 代理） | 中大（5-7 任务） |
| **WP5** 定时/事件 | **常驻系统会话机制**（RESERVED 标记/evict 豁免/recoverAll 优先/watchdog 重建）+ **扩展加载 spike**（agentDir symlink vs extensionFactories）+ scheduled_jobs（**含 tenantId**）+定时触发器+event_subscriptions+订阅派发器+pth webhook 路由/管理面命令/**AGENT_LAB_DB_PATH 挂卷** | WP1；扩展加载 spike（与 WP1 并行先做） | 中（5-6 任务） |

**顺序建议**：WP1 →（WP2 ∥ WP3）→ WP4 → WP5。WP4 依赖 WP3 的 sandbox（debug 通道）与 WP5 的常驻会话（observe 的 EventLog 代理）；WP5 的扩展加载 spike 提到 WP1 并行先做（排期强依赖）。
**Spike 前置**（三个，全部提到 WP1 并行）：①SDK revive 完整性（WP2 前置）；②SDK bash 工具拦截点（WP3 前置）；③SDK 会话扩展加载在 pth 侧验证（WP5 前置——失败则退选项 B：pth 直接 import agent-lab）。另 WP5 小 spike：DispatchRequest 的 checkpointId 字段核实。

---

## §9 范围与非目标 / 遗留

**非目标**：多副本架构（§3.6 演进）；信任链（暂缓）；法律引擎（v1.x）；E 业务种子（架构就绪后另行 plan）；agent 容器化隔离（用户裁决：唯一 sandbox 即可，非每 agent 一容器）。

**遗留/开放点**：
- SDK revive 完整性边界（spike——WP2 前置）。
- SDK bash 工具拦截/替换点（spike——WP3 前置；备选=异名 sandbox-bash+提示重写）。
- SDK 会话扩展加载在 pth 侧验证（spike——WP5 前置；失败退选项 B=pth 直接 import）。
- DispatchRequest 的 checkpointId 字段核实（WP5 小 spike）。
- missed-fire 策略默认值（补火一次——实施时可调）。
- Redis 拆双实例（数据/队列分离）——演进路径。
- 自修改调试时的 LLM 密钥临时注入操作流（WP3/WP4 细化）。
- hub debug 的交互协议（WebSocket 会话语义——WP4 细化）。
- fallback_requests 自动触发（watchdog/T 参数判定/dispatch routing.failed 挂钩）——E 阶段。
- legalAuth 强制校验升级（图→治理者映射实例化后——E 阶段）。

---

*本 spec 为 F 阶段架构设计草案，待对抗性评审迭代收敛（沿用联邦骨架 spec 的评审方法论）。*
