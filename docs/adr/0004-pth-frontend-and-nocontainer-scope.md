# PTH 专属前端与无容器版本范围草案

状态：范围草案（Draft） · 日期：2026-08-15 · 承接：`docs/adr/0001-pth-ptl-scope-redefinition.md`

决定（2026-08-15）：承接 ADR-0001 的后续方向，PTH 专属前端与无容器版本本轮**只出范围草案 ADR，不进入实现**。本 ADR 不修改任何源码，仅划定范围、边界与触发条件。

## 背景与目标

- PTH 的定位是**自耦自然语言解释器（解释即执行）**，要独立成完整产品，除了内部任务池/角色路由/沙箱之外，还需要稳定的交互面与更轻量的运行形态。
- ADR-0001 已裁决 **PTL 不再是 PTH 的前端**：PTL 是基于 pi 的多环境共存平台，通过 PTH CLI 调用 PTH；现有 HTTP 桥降级为兼容通道。因此 PTH 需要自己的专属前端。
- 当前 PTH 生产部署是 Docker Compose 四服务（postgres/redis/pi-platform/sandbox），安全模型依赖 `SANDBOX_SHARED_SECRET`、`PTH_MEMORY_BRIDGE_TOKEN` 与 workload UID/GID。对无法运行 Docker 的环境，需要定义"无容器版本"的边界，而不是放任各环境自行裁剪。
- 目标：为 PTH 专属前端与无容器版本划定**范围草案**——前端形态选项与推荐方向、无容器版本的最小依赖矩阵与安全边界、与 PTH CLI 的关系；并明确非目标与进入实现的条件。本文不是实现计划，不排期、不拆任务。

## 范围草案（不是实现计划）

### a) 前端形态选项

| 形态 | 输入 | 输出 | 边界 | 推荐 |
|---|---|---|---|---|
| **CLI 增强**（当前 `pth submit/status/wait` 扩展） | 命令行参数、`--file`/`--concept`、stdin；env `PTH_API`/`PTH_TOKEN` | 任务 ID、状态、result JSON、trajectory/日志文本、退出码 | 纯文本交互，单用户本地 shell，无图形轨迹，无多租户 | **第一阶段基线（推荐）** |
| **本地 Web 控制台**（Fastify 静态页 + 任务/轨迹只读 + 提交） | 浏览器表单/文件上传、登录 token | HTML 页面、任务列表、轨迹只读视图、提交结果、SSE 流 | 只读 + 提交；不做 batch/kernel exec 等管理面；默认 loopback 绑定；需要登录态/CSRF 防护 | 第二阶段可选，仅在轨迹可视化需求出现时启动 |
| **桌面/TUI**（Ink TUI 或 Electron/Tauri 桌面） | 交互式键盘/鼠标操作 | 终端富文本或桌面窗口 | 打包与维护成本高，与 CLI/Web 能力重叠 | 本轮不做，仅记录选项 |

推荐方向：**CLI 增强为唯一第一阶段交互面**；本地 Web 控制台作为观察性补充，在 CLI 无法承载轨迹可视化时再议；桌面/TUI 不纳入本轮草案范围。

### b) 无容器版本边界

无容器版本的默认画像：**单租户、单机、可信任务负载、个人/开发/受限 CI 环境**。它不是生产多租户形态的替代。

**组件边界：**

- **PostgreSQL**：
  - 可省容器：是。改用本地 PostgreSQL（用户自装或系统服务），仅变更 `DATABASE_URL`，现有 schema、行锁（`FOR UPDATE SKIP LOCKED`）、JSONB GIN 语义不变，迁移成本最低。
  - 可替换为 SQLite：有条件。仅限单进程/单 batch/单租户；任务认领原子性可回退到 SQLite 单写者 + `changes()===1`（仓库早期 task-pool 有先例），但 JSONB GIN 检索需降级为 JSON1/FTS5 或 LIKE，且当前 `task-store-pg.ts`/`memory-store-pg.ts` 需要新增 SQLite 适配层。本轮只标注边界，不实现。
  - 不可省：任务/记忆/transcripts 的持久真相源必须保留。
- **Redis**：
  - 可禁用：在单进程/单 batch/单租户形态下可禁用；auth token 改为 env/文件静态 token；SessionStore 换为进程内实现（或文件持久化）；workflow TTL 锁、audit stream、组件注册表等热面降级为本地实现或关闭。
  - 不可省：多进程、多 batch、autoscale、多租户形态下 Redis 仍是热面（锁/流/会话），不可省。
- **sandbox 执行核**：
  - 可省容器：是。无容器版本使用本地 kernel 进程（`PTH_PYTHON_MODE`/`PTH_BASH_MODE` 切回本地 `kernel`，现有调试模式已具备），REPL 直接跑本地 python/bash。
  - 隔离弱化：失去 cgroup 资源限额、网络零出口、只读 rootfs 三重容器隔离；任务进程可触达宿主文件系统与网络，只能依赖 OS 用户与工作区权限隔离。
- **记忆桥**：
  - 容器形态：pi-platform ↔ sandbox HTTP loopback 桥 + `PTH_MEMORY_BRIDGE_TOKEN` + fail-closed。
  - 无容器形态：`packages/pth-memory` 进程内直连，无 token、无网络暴露，保持同一 Store 接口。

**最少依赖矩阵：**

| 组件 | 生产（容器） | 无容器最小形态 | 是否可省 | 说明 |
|---|---|---|---|---|
| PostgreSQL | 容器 PG 16 | 本地 PG（SQLite 仅实验性替代） | **不可省** | 任务/记忆/transcripts 持久真相；SQLite 仅单机受限场景 |
| Redis | 容器 Redis 7 | 禁用 / 进程内替代 | 单进程可省 | 多 batch/多租户不可省 |
| sandbox 容器 | 必需 | 本地 kernel 进程 | 容器可省 | 隔离降级；workload UID/GID 仍应保留 |
| Docker/容器后端 | 必需 | 不需要 | 可省 | Node 直接运行 pi-platform |
| LLM 端点 | 必需 | 必需 | **不可省** | 解释执行依赖模型 API |

**安全边界：**

- 共享密钥：`SANDBOX_SHARED_SECRET` 只在容器 sandbox 模式存在意义；无容器模式禁止要求该变量、禁止配置默认值，避免误用。两种形态互斥，启动时按形态校验。
- 记忆桥 token：`PTH_MEMORY_BRIDGE_TOKEN` 只属于容器 sandbox 模式的 loopback 桥；无容器模式改为进程内直连，不得暴露 HTTP 记忆桥。
- workload UID/GID：无容器模式仍应保留——POSIX 下以专用 OS 用户运行，子进程 setuid/gid，任务工作区保持 `0700`；不做容器级隔离承诺。
- 弱化风险：无容器 = 失去 cgroup/网络/文件系统三重隔离，必须限制为单租户、可信负载；不得用于多租户生产，文档中需显式标注"非生产形态"。

### c) 与 PTH CLI 关系

- **PTH CLI 是规范接口**（ADR-0001 已确立）。当前 `scripts/pth-cli.ts` 的 `submit/status/wait/handoff/roles/tags` 是规范接口的临时实现，后续可扩展 `list/logs/result/templates/batch` 等命令。
- 任何前端（CLI 增强、Web 控制台）都必须**调用 CLI 或与其等价的 API**；Web 控制台直接调 API 时，其操作语义必须与 CLI 命令一一对应，不引入私有 RPC。
- CLI 只依赖 `PTH_API` + `PTH_TOKEN`，不依赖 PTL 包（`packages/framework` 等）；PTL 只是 PTH CLI 的一个调用方，不享有特殊通道。
- 现有 HTTP 桥继续作为兼容通道保留；新前端不得与 PTL 耦合，不得以 PTL 为前端底座。

## 明确非目标与触发条件

**非目标（本轮不做）：**

- 不实现任何前端页面、CLI 扩展或无容器适配器；不修改 `src/pth`、`packages/`、`scripts/`。
- 不用无容器版本替代现有 Docker Compose 四服务生产拓扑。
- 不实施 SQLite 迁移；不复活 PTL 作为 PTH 前端；不做多租户 Web 控制台；不做桌面应用。
- 不定义具体 UI 视觉、路由、数据库 schema 与排期。

**触发条件（何时从草案进入实现）：**

- CLI 增强：出现真实使用者需要 `list`/`result`/`transcript` 中至少一项，且当前 `pth submit/status/wait` 无法满足时，先写实现级 ADR/计划，经评审后实施。
- 本地 Web 控制台：轨迹/任务结果需要可视化、文本流无法承载时启动；进入实现前须明确登录态、只读边界与 loopback 部署假设。
- 无容器版本：同时满足以下条件才进入实现——
  1. 存在无法运行 Docker 的真实环境（个人机/受限 CI/教学机）；
  2. 明确接受单租户、可信负载、隔离弱化的边界；
  3. spike 验证"本地 PG + 无 Redis + 本地 kernel"能通过核心任务池/记忆测试；SQLite 替代需另立 ADR。
- 桌面/TUI：仅在 CLI 与 Web 均不足、且维护者承诺长期打包维护时才启动。
- 任何实现都必须保持全量测试、lint、build 绿线，并单独提交，不混入无关改动。

## Consequences

- 本文档是 PTH 专属前端与无容器版本的**唯一范围依据**；后续任何相关工作先对照本文，超出范围另立 ADR。
- 现有 Docker Compose 四服务仍是生产默认拓扑；`docs/pth/deployment.md`、`docs/pth/architecture.md` 等文档无需改动，无容器形态仅在引用本文档边界时使用。
- 本轮零代码改动；`scripts/pth-cli.ts` 保持原样，继续作为规范接口的临时实现。
- PTL 不再作为 PTH 前端；PTH CLI 是唯一规范调用面，HTTP 桥维持兼容通道。
- 无容器形态被明确标记为**隔离弱化的单租户形态**，`SANDBOX_SHARED_SECRET` 与 `PTH_MEMORY_BRIDGE_TOKEN` 仅容器模式有效；该形态不得进入多租户生产。
- 本 ADR 不产生实现级技术债；进入实现时另立实现级 ADR（如 0005）或计划。
