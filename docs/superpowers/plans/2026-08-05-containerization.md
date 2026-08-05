# Implementation Plan: F 阶段——容器化 / PTL 架构更新 / 联邦触发机制

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将联邦骨架 v1.0 落成可运行的部署与运行架构——pth 容器生产可用（会话可恢复/数据不丢/构建可复现）、代码执行全沙箱化（唯一 sandbox 容器）、hub 扩展为完整联邦交互层（构件泛化/空位绑定/回退请求/观测/调试）、定时与事件触发机制（常驻系统会话承载）。

**Architecture:** 依据 `docs/superpowers/specs/2026-08-05-containerization-architecture-design.md`（v0.2，评审通过版）。技术栈惯例：**pth/ptl 侧（`src/`）`.js` + vitest（`test/unit/`）；agent-lab 侧（`extensions/agent-lab/`）`.ts` + node:test；零新增依赖**。基线：PTL 717/717 + agent-lab 1636 pass/2 pre-existing。

**用户裁决（不可推翻）**：单实例+会话外置（多副本=演进）/代码执行全沙箱化/PTL 保持 tmux+hub 渐进扩展/定时事件=常驻系统会话承载（选项 C）/legalAuth 声明式/手动建单先行/sandbox 不持 LLM 密钥/BullMQ 不引入。

**二轮评审残留（实现侧注意）**：①recoverAll 竞态→Task 6 加 Redis Epoch；②SDK 工具拦截必须**统一接口名**（不得 bash/sandbox-bash 两套 API）→Task 11；③常驻会话 watchdog 重建需"轻量状态化"→Task 20。

**执行顺序**：Spikes（S1-S3，与 WP1 并行先做）→ WP1（Task 1-3）→（WP2 ∥ WP3）→ WP4 → WP5。每个 Task 独立 commit、全程测试绿。

---

## Spike S1: SDK 会话持久化/revive 能力验证（WP2 前置）

**Files:**
- 新建: `/tmp/f-spikes/s1-sdk-revive.ts`（临时验证脚本，不入库）
- 参考: `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`、`src/shared/sdk-adapter/index.ts`、`src/pth/core/agent-engine.ts:115`

- [ ] **Step 1: 能力清单核实**——`SessionManager.create(cwd, sessionDir)` / `continueSession` 的确切签名与语义（读 `.d.ts` + 必要处读实现）；确认 JSONL 落盘结构与恢复入口
- [ ] **Step 2: 最小验证**——脚本建会话（持久化 SessionManager）→ prompt 一轮 → 模拟进程退出 → 新进程 revive → 验证上下文完整（历史消息在）
- [ ] **Step 3: 边界记录**——in-flight 状态/tool 调用中态/model fallback 在 revive 后的行为；checkpointSeq 对齐方式
- [ ] **Step 4: 产出结论**（写本 plan 下方"Spike 结论"节）：可行/受限/不可行 + WP2 设计调整点

**验收**：结论明确——若受限/不可行，WP2 降级为"会话元状态外置+接受上下文丢失"。

---

## Spike S2: SDK bash 工具拦截/替换点验证（WP3 前置）

**Files:**
- 新建: `/tmp/f-spikes/s2-sdk-tools.ts`
- 参考: `sdk.d.ts`（tools/excludeTools/customTools 类型）、`src/shared/sdk-adapter/index.ts`

- [ ] **Step 1: 核实 SDK 工具配置面**——`tools`/`excludeTools`/`customTools` 的组合语义；同名 custom tool 是否覆盖内建 bash（文档+实验）
- [ ] **Step 2: 最小验证**——excludeTools 排除内建 bash + customTools 注册同名 `bash`（转发 stub）→ 验证模型侧看到的工具名/schema 一致、调用被截获
- [ ] **Step 3: 产出结论**：同名替换可行 / 需异名（则 WP3 采用"统一接口名"方案——转发层内部路由，对外仍名 bash；二轮评审 Important 2 的硬约束）

**验收**：WP3 工具转发路径确定。

---

## Spike S3: SDK 会话扩展加载在 pth 侧验证（WP5 前置）

**Files:**
- 新建: `/tmp/f-spikes/s3-sdk-extensions.ts`
- 参考: `src/pth/core/agent-engine.ts:79`（DefaultResourceLoader）、`resource-loader.d.ts`（extensionsResult/extensionFactories/extensionsOverride）

- [ ] **Step 1: 路径 a 验证**——agentDir/extensions/ 下 symlink 一个最小测试扩展（注册一个 marker 命令）→ pth 方式创建 SDK 会话（DefaultResourceLoader）→ 验证扩展被加载
- [ ] **Step 2: 路径 b 验证**——`extensionFactories: [inlineExtension]` 编程注入同 marker → 验证加载
- [ ] **Step 3: agent-lab 适配评估**——agent-lab/index.ts 的入口依赖（pi.on 钩子/命令注册/SDK 版本）在 pth SDK 会话环境的兼容性；DB 路径（AGENT_LAB_DB_PATH env）注入点
- [ ] **Step 4: 产出结论**：路径 a/b 哪个可行（或皆可）→ WP5 选定；皆不可 → 退选项 B（pth 直接 import agent-lab 框架层——plan 附录 B 备用任务）

**验收**：WP5 扩展加载路径确定。

---

# WP1 Docker 基线修复（Task 1-3）

## Task 1: Dockerfile 多阶段构建 + 非 root + CMD 修正

**Files:**
- Modify: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: 多阶段构建**——builder 阶段：`npm ci`（含 devDeps）+ `npx tsc`；runtime 阶段：`npm ci --omit=dev` + 从 builder COPY `dist/`（修复"`--omit=dev` 后 tsc 缺失"疑点）
- [ ] **Step 2: CMD 修正**——`CMD ["node", "dist/pth/main.js"]`（评审新发现：与 package.json bin 一致）
- [ ] **Step 3: 非 root**——`USER node`（node:22-slim 内置用户）+ 卷目录属主调整
- [ ] **Step 4: .dockerignore**——node_modules/.git/data/tmp/docs/test
- [ ] **Step 5: 实证 `docker build` 成功 + 容器启动 /health 200**（本机 docker 实跑——若本机无 docker，改为静态审查+CI 标注）
- [ ] **Step 6: commit** `fix(pth): Dockerfile 多阶段构建+非 root+CMD 修正 dist/pth/main.js（F/WP1）`

## Task 2: 卷完备 + env 接线

**Files:**
- Modify: `docker-compose.yaml`

- [ ] **Step 1: 新增 4 卷**——`components`（/data/components）/`agent-dir`（/data/agent-dir）/`sessions`（/data/sessions）/`agent-lab`（/data/agent-lab）；programs 目录迁入 components（兼容：启动时检测旧 programs 目录并迁移——或声明 v1 直接切换无迁移，评审后定）
- [ ] **Step 2: env 接线**——`PI_CODING_AGENT_DIR=/data/agent-dir`、`AGENT_LAB_DB_PATH=/data/agent-lab/agent-lab.db`、`DATA_DIR=/data`
- [ ] **Step 3: 持久化不变量验证清单**（文档化进 compose 注释）：`docker compose down && up` 后——构件在/agent 能力在/会话可恢复（WP2 后）/认证不失效
- [ ] **Step 4: commit** `fix(pth): compose 卷完备（components/agent-dir/sessions/agent-lab）+ env 接线（F/WP1）`

## Task 3: Redis 驱逐策略 + 容量监控

**Files:**
- Modify: `docker-compose.yaml`（redis command）
- Modify: `src/pth/self/metrics.ts`（或 metrics 所在——先查证）

- [ ] **Step 1: 改 `noeviction`**（allkeys-lru 可淘汰 auth:token/audit——评审实证）
- [ ] **Step 2: 容量监控**——/metrics 增 redis 内存指标（INFO memory 周期性采集；告警阈值文档化进 runbook 注释）
- [ ] **Step 3: commit** `fix(pth): Redis 驱逐策略 noeviction+容量监控（auth/audit 防淘汰，F/WP1）`

---

# WP2 会话外置（Task 4-9）

## Task 4: SDK 持久化 SessionManager 接线

**Files:**
- Modify: `src/pth/core/agent-engine.ts`（:115 替换 inMemory）
- Modify: `src/shared/sdk-adapter/index.ts`（如需要透传 sessionDir 参数）
- Test: `test/unit/agent-engine-session-persist.test.js`（新建）

- [ ] **Step 1: 按 S1 结论接线**——`SessionManager.create(cwd, sessionsDir/<tenantId>/<sessionId>/)`（或 S1 确定的 API）；sessions 卷路径经 config/env 注入
- [ ] **Step 2: 测试**——创建会话→prompt（mock SDK 或最小真实会话）→会话目录 JSONL 落盘断言
- [ ] **Step 3: 全绿** `npx vitest run test/unit/agent-engine-session-persist.test.js` + PTL 基线
- [ ] **Step 4: commit** `feat(pth): 会话外置①——SDK 持久化 SessionManager 接线 sessions 卷（F/WP2）`

## Task 5: 池元状态入 Redis

**Files:**
- Modify: `src/pth/core/session-pool.ts`（PoolSession→Redis 双写/读穿透）
- Modify: `src/pth/storage/redis-session-store.ts`（复用其 key 模式或新增 pool:* 键）
- Test: `test/unit/session-pool-redis.test.js`（新建）

- [ ] **Step 1: PoolSession 字段 Redis 化**——`pool:{sid}:meta` JSON；状态迁移（busy/idle/refCount/lastCheckpointSeq/model）双写 Redis；内存 Map 降级为缓存（读穿透+写直通）
- [ ] **Step 2: recoverableIndex 死代码裁决**——启用（恢复索引）或删除（recoverAll 直扫 pool:* 键）——实现时二选一并文档化
- [ ] **Step 3: 测试**——池操作→Redis 键断言；模拟进程重启（新 pool 实例）→从 Redis 重建池视图
- [ ] **Step 4: commit** `feat(pth): 会话外置②——池元状态入 Redis（内存 Map 降级缓存，F/WP2）`

## Task 6: recoverAll 实现 + 竞态防护

**Files:**
- Modify: `src/pth/core/agent-engine.ts`（:319 空 stub 实现化）
- Test: `test/unit/agent-engine-recover.test.js`（新建）

- [ ] **Step 1: recoverAll 实现**——扫 Redis `pool:*` → 逐会话 revive（S1 结论的 SDK 恢复 API）→ 状态置 idle + `recovered-from-crash` 标记（原 busy 的）；失败会话标记 unrecoverable+审计
- [ ] **Step 2: 竞态防护（二轮评审 Important 1）**——Redis Epoch：`INCR pool:epoch` 启动时执行；recoverAll 期间新请求排队/拒绝（启动窗）；recoverAll 完成后才 listen HTTP（main.ts 启动顺序调整——先 recover 后 listen）
- [ ] **Step 3: 恢复清理（spec §3.1 第 5 条）**——workflow 锁过期重建/refCount 归零重计/pending dispatch 丢弃+审计标记（不重放）/stale busy→idle
- [ ] **Step 4: 测试**——制造崩溃现场（写入池元状态+会话目录后杀进程语义）→ recoverAll → 断言恢复结果与清理结果
- [ ] **Step 5: commit** `feat(pth): 会话外置③——recoverAll 实现+Epoch 竞态防护+恢复清理（F/WP2）`

## Task 7: 工作区分离

**Files:**
- Modify: `src/pth/workspace/manager.ts`
- Test: `test/unit/workspace-manager.test.js`（新建或扩充）

- [ ] **Step 1: 层级固化**——`workspaces/<tenantId>/<projectId>/`；program-run 延续 `program-run-<sessionId>`；路径推导单点（manager 提供 resolve 方法，消费方不得自拼）
- [ ] **Step 2: 清理策略**——program-run-* 随 evict/destroy 清理（现状 programRunDirs 机制延续+挂卷后验证）；sessions 卷目录随 destroy 清理
- [ ] **Step 3: 测试**——tenant 间路径隔离断言（A 不可见 B 的目录——路径级）
- [ ] **Step 4: commit** `feat(pth): 工作区分离——workspaces/<tenant>/<project> 层级+清理策略（F/WP2）`

## Task 8: HotReloader 注入修复（L1 热更闭环）

**Files:**
- Modify: `src/pth/platform/hot-reloader.ts`（:26-38）
- Modify: `src/pth/core/agent-engine.ts`（ResourceLoader 接线）

- [ ] **Step 1: 修复"只校验不注入"**——platform 卷 skills/prompts/config 变更校验通过后 → 注入后续会话的 ResourceLoader（agent-dir 卷为基准，platform 卷为覆盖层）
- [ ] **Step 2: L3 RebuildTrigger 废弃**——`.rebuild-request` 机制删除/注释（spec §3.4：容器语义下自修改=构件上传）；supervisor.sh 从 Dockerfile COPY 移除
- [ ] **Step 3: commit** `fix(pth): HotReloader L1 注入闭环+L3 rebuild-request 废弃（F/WP2）`

## Task 9: WP2 集成验证

**Files:**
- Test: `test/unit/f-wp2-integration.test.js`（新建）

- [ ] **Step 1: 持久化不变量端到端**——会话创建→prompt→模拟重启（新 engine 实例+同 Redis/卷）→recoverAll→会话可用（prompt 续跑）
- [ ] **Step 2: 全绿**（新增测试+PTL 717 基线）
- [ ] **Step 3: commit** `test(pth): WP2 集成验证——重启后会话可恢复（F/WP2）`

---

# WP3 sandbox 容器（Task 10-15）

## Task 10: sandbox 镜像 + 执行 API 服务

**Files:**
- Create: `Dockerfile.sandbox`、`src/sandbox/main.js`、`src/sandbox/exec-api.js`
- Modify: `docker-compose.yaml`（sandbox 服务）
- Test: `test/unit/sandbox-exec-api.test.js`（新建）

- [ ] **Step 1: 执行 API**——`POST /exec {cmd, cwd, env, timeout}`→`{stdout, stderr, exitCode}`；流式 SSE `GET /exec/:id/stream`；**共享密钥认证**（Authorization header，compose env 注入）；cwd 白名单（必须在 /data/workspaces/ 下）；超时强杀；非 root
- [ ] **Step 2: 健康检查**——`GET /health`；compose `healthcheck` + pth `depends_on: service_healthy`
- [ ] **Step 3: egress 锁定**——无外部网络（compose 内网 only）；资源限额（CPU/内存）
- [ ] **Step 4: 测试**——API 单测（mock 子进程）+ 认证拒绝+cwd 白名单拒绝+超时强杀断言
- [ ] **Step 5: commit** `feat(sandbox): sandbox 容器+执行 API（共享密钥/cwd 白名单/超时强杀/egress 锁定，F/WP3）`

## Task 11: pth 侧 SDK bash 工具转发（统一接口名）

**Files:**
- Modify: `src/shared/sdk-adapter/index.ts`（或新建 `src/pth/tools/sandbox-bash.ts`）
- Modify: `src/pth/core/agent-engine.ts`（工具配置接线）
- Test: `test/unit/sandbox-bash-forward.test.js`（新建）

- [ ] **Step 1: 按 S2 结论实现转发**——排除内建 bash+注册**同名 bash** custom tool（对外接口名统一为 bash——二轮评审硬约束）；转发客户端（HTTP→sandbox /exec，共享密钥，SSE 流式回传）
- [ ] **Step 2: 错误语义**——sandbox 不可达→类型化错误 `sandbox-unavailable`（不静默）；超时→`sandbox-timeout`
- [ ] **Step 3: 测试**——mock sandbox 服务→断言转发/错误/流式
- [ ] **Step 4: commit** `feat(pth): bash 工具全量转发 sandbox（统一接口名+类型化错误，F/WP3）`

## Task 12: workspaces 共享卷 + 路径约定统一

**Files:**
- Modify: `docker-compose.yaml`（pth 与 sandbox 同挂 workspaces 卷）
- Modify: `src/pth/workspace/manager.ts`（容器内路径约定 /data/workspaces/）

- [ ] **Step 1: 双容器同卷**——pth:/data/workspaces = sandbox:/data/workspaces（路径语义一致——转发 cwd 无需映射）
- [ ] **Step 2: 测试**——pth 写文件→sandbox exec 可读断言（compose 集成测试或 mock）
- [ ] **Step 3: commit** `feat(pth): workspaces 共享卷——pth/sandbox 路径约定统一（F/WP3）`

## Task 13: sandbox 失效降级

**Files:**
- Modify: `src/pth/self/routes-self.ts`（health 联动）
- Modify: `src/pth/tools/sandbox-bash.ts`（degraded 状态）
- Test: `test/unit/sandbox-degraded.test.js`（新建）

- [ ] **Step 1: 失效检测**——转发失败计数→连续 N 次（N=3 默认）置 degraded；`/health` 联动 unhealthy；审计事件
- [ ] **Step 2: 恢复**——sandbox 健康恢复→自动清除 degraded（定期探活）
- [ ] **Step 3: 测试**——mock sandbox 挂掉→degraded 断言；恢复→清除断言
- [ ] **Step 4: commit** `feat(pth): sandbox 失效降级——degraded 状态+health 联动+自动恢复（F/WP3）`

## Task 14: sandbox 内嵌 pi+PTL（自修改模式）

**Files:**
- Modify: `Dockerfile.sandbox`（安装 pi+PTL+扩展）
- Create: `scripts/sandbox-debug-entry.sh`（调试会话入口）

- [ ] **Step 1: 镜像内嵌**——pi 可执行+PTL（dist/ptl）+扩展（pit-communicate/pit-control）；不持 LLM 密钥（用户裁决——按需临时注入操作流文档化：docker exec 注入 env，用完即撤）
- [ ] **Step 2: 调试入口脚本**——启动 PTL 会话（tmux 在容器内）
- [ ] **Step 3: commit** `feat(sandbox): 内嵌 pi+PTL 自修改模式（不持密钥按需注入，F/WP3）`

## Task 15: WP3 集成验证

**Files:**
- Test: `test/unit/f-wp3-integration.test.js`（新建）

- [ ] **Step 1: 端到端**——pth 会话 bash 调用→sandbox 执行→结果回传（mock 或 compose 实跑）；sandbox 挂掉→degraded；恢复→正常
- [ ] **Step 2: 全绿**；**Step 3: commit** `test(pth): WP3 集成验证——代码执行全沙箱化（F/WP3）`

---

# WP4 hub 扩展（Task 16-22）

## Task 16: ComponentManifest 泛化

**Files:**
- Modify: `src/ptl/bridge/manifest.ts`（ProgramManifest→ComponentManifest+type 分派校验）
- Test: `test/unit/bridge-manifest.test.js`（扩充）

- [ ] **Step 1: ComponentManifest**——`type: agent-program|scheduler|optimizer|memory-pack|skeleton-update`；payload 类型相关；原 ProgramManifest 字段归入 agent-program 分支（**完全等价映射**——二轮评审 Minor：避免两套存储逻辑）
- [ ] **Step 2: 分派校验器**——按 type 校验 payload（agent-program 走原 validateManifest 逻辑；其余类型最小校验——name/type 合法，payload 结构骨架）
- [ ] **Step 3: 测试**——各 type 合法/非法断言+agent-program 兼容断言（旧 agent.json 原样通过）
- [ ] **Step 4: commit** `feat(ptl): ComponentManifest 泛化——5 类构件+agent-program 等价兼容（F/WP4）`

## Task 17: ComponentStore（pth 侧）

**Files:**
- Modify: `src/pth/programs/store.ts`→泛化（或新建 `src/pth/components/store.ts` 复用其模式）
- Modify: `src/pth/gateway/routes-programs.ts`（API 扩展/兼容别名）
- Test: `test/unit/components-store.test.js`（新建）

- [ ] **Step 1: 存储泛化**——`components` 卷 `<tenantId>/<type>/<name>/<version>/`；Redis 版本指针/原子 INCR/GC 沿用 ProgramStore 模式；agent-program 类型与旧 programs 路径的兼容映射（读侧双查或一次性迁移脚本——实现时定）
- [ ] **Step 2: API**——`POST /api/v1/components`；`/api/v1/programs` 保留为 agent-program 兼容别名
- [ ] **Step 3: 测试**——上传/版本/兼容断言
- [ ] **Step 4: commit** `feat(pth): ComponentStore——构件存储泛化+版本化+programs 兼容（F/WP4）`

## Task 18: targetSlot 空位绑定生效

**Files:**
- Modify: `src/pth/components/store.ts`（绑定登记）
- Modify: `src/pth/components/slot-binding.ts`（新建——生效逻辑）
- Test: `test/unit/slot-binding.test.js`（新建）

- [ ] **Step 1: 绑定登记**——上传携带 targetSlot → `slot:{slotId}:binding` Redis 键+审计事件
- [ ] **Step 2: 生效语义**——登记校验（字段良构 O(1)——spec：部署=登记，语义求值推迟）；scheduler/optimizer 类构件→注册进框架层 registry（经 WP5 常驻会话代理调用）；agent-program→可装配常驻标记
- [ ] **Step 3: 测试**——绑定/生效/无 targetSlot 仅存储断言
- [ ] **Step 4: commit** `feat(pth): targetSlot 空位绑定生效——登记语义+registry 接线（F/WP4）`

## Task 19: legalAuth 声明式登记

**Files:**
- Modify: `src/pth/components/store.ts`（legalAuth 字段登记）
- Test: 并入 Task 17/18 测试

- [ ] **Step 1: 声明式登记**——legalAuth 可选字段原样落盘+Redis；审计事件含 legalAuth（不拦截、不校验——spec §5.3）
- [ ] **Step 2: commit** `feat(pth): legalAuth 声明式登记（审计追溯，强制校验预留 E，F/WP4）`

## Task 20: fallback_requests 回退请求通道（手动建单先行）

**Files:**
- Create: `src/pth/fallback/requests.ts`（Redis 队列）
- Modify: `src/pth/gateway/`（路由：POST /api/v1/fallback-requests、GET 列表、POST /:id/close）
- Create: `src/ptl/bridge/request.ts`、`src/ptl/bridge/respond.ts`（pit hub request/requests/respond）
- Test: `test/unit/fallback-requests.test.js`（新建）

- [ ] **Step 1: pth 队列**——`fallback_requests` Redis 结构 `{requestId, slotHint, description, urgency, createdAt, status(open|closed), closedBy?}`
- [ ] **Step 2: 手动建单**——`POST /api/v1/fallback-requests`（自动生产者留 E——spec §5.4）
- [ ] **Step 3: PTL 命令**——`pit hub request`（建单）/`pit hub requests`（列表）/`pit hub respond <id> <dir>`（走 components 上传 API+requestId 关联→自动闭合）
- [ ] **Step 4: 测试**——建单/列表/respond 闭合/审计断言
- [ ] **Step 5: commit** `feat(pth,ptl): fallback_requests 回退请求通道——手动建单+respond 闭合闭环（F/WP4）`

## Task 21: hub observe（远程观测）

**Files:**
- Modify: `src/pth/gateway/`（只读路由：sessions/trace/events）
- Create: `src/ptl/bridge/observe.ts`（pit hub observe）
- Test: `test/unit/hub-observe.test.js`（新建）

- [ ] **Step 1: pth 只读路由**——`GET /api/v1/observe/sessions|sessions/:id|trace/:id|events`；EventLog 查询经**常驻系统会话代理**（pth 主进程不直读 agent-lab DB——spec §6.0；WP5 前可用 Redis 会话痕迹先行）
- [ ] **Step 2: PTL 命令**——`pit hub observe <what>`（print/json 双模式）
- [ ] **Step 3: 测试**——路由+权限（Bearer+tenant 隔离）断言
- [ ] **Step 4: commit** `feat(pth,ptl): hub observe——远程会话/trace/事件观测（F/WP4）`

## Task 22: hub debug（交互式调试接入）

**Files:**
- Create: `src/pth/gateway/routes-debug.ts`（WebSocket 接入 sandbox 调试会话）
- Create: `src/ptl/bridge/debug.ts`（pit hub debug）
- Test: `test/unit/hub-debug.test.js`（新建）

- [ ] **Step 1: WebSocket 交互通道**——pth 网关 ↔ sandbox 调试会话（Task 14 入口）；双向输入输出（vs hub run 的 SSE 单向）
- [ ] **Step 2: 接入控制**——Bearer+role 校验；会话审计
- [ ] **Step 3: 测试**——WS 握手/双向回显/权限拒绝断言（mock sandbox）
- [ ] **Step 4: commit** `feat(pth,ptl): hub debug——WebSocket 交互式接入 sandbox 调试区（F/WP4）`

---

# WP5 定时/事件机制（Task 23-28）

## Task 23: 常驻系统会话机制

**Files:**
- Modify: `src/pth/core/session-pool.ts`（RESERVED 标记+evict 豁免）
- Modify: `src/pth/core/agent-engine.ts`（常驻会话创建/recoverAll 优先/watchdog 重建）
- Test: `test/unit/reserved-session.test.js`（新建）

- [ ] **Step 1: RESERVED 标记**——池新状态/标记；evict 豁免（evictLRU 跳过）；recoverAll 优先恢复
- [ ] **Step 2: watchdog 重建**——常驻会话崩溃检测（health 探测/错误事件）→自动重建（**轻量状态化**——二轮评审 Important 3：常驻会话不持大状态，EventLog 查询按需，无大缓存）；重建次数审计
- [ ] **Step 3: 测试**——驱逐豁免/优先恢复/崩溃重建断言
- [ ] **Step 4: commit** `feat(pth): 常驻系统会话机制——RESERVED+豁免+优先恢复+watchdog（system-governor 雏形，F/WP5）`

## Task 24: agent-lab 扩展加载进常驻会话

**Files:**
- Modify: `src/pth/core/agent-engine.ts`（常驻会话的 ResourceLoader/extensionFactories 接线——按 S3 结论）
- Modify: `docker-compose.yaml`（agent-lab 扩展目录卷/symlink——若 S3 选路径 a）

- [ ] **Step 1: 按 S3 结论接线**（路径 a symlink 或路径 b extensionFactories）；`AGENT_LAB_DB_PATH` env 注入会话
- [ ] **Step 2: 验证**——常驻会话内 /lab 命令可用、SchedulerRunner.dispatch 可调（最小真实 dispatch 冒烟）
- [ ] **Step 3: commit** `feat(pth): agent-lab 扩展加载进常驻系统会话（S3 路径落地，F/WP5）`

## Task 25: scheduled_jobs 表 + 定时触发器

**Files:**
- Modify: `extensions/agent-lab/src/core/storage/schema.ts`（scheduled_jobs 表——**含 tenantId**）
- Create: `extensions/agent-lab/src/scheduler/timed-trigger.ts`
- Test: `extensions/agent-lab/test/timed-trigger.test.ts`（新建，node:test）

- [ ] **Step 1: 表结构**——`{id, tenantId, taskType, scheduleKind(cron|at|interval), scheduleSpec, payload, status, nextFireAt, lastFireAt, fireCount, createdBy}`；cron 解析**零新增依赖**（手写最小 cron 解析——分/时/日/月/周 5 段，或 interval/at 先行 cron 后置——实现时裁决并文档化）
- [ ] **Step 2: timed-trigger**——常驻会话进程内 unref 定时器扫描到期 job→构造 DispatchRequest→runner.dispatch→更新 nextFireAt/状态；missed-fire 补火一次（重启恢复时）
- [ ] **Step 3: 测试**——job CRUD/到期触发/nextFireAt 计算/missed-fire/tenantId 隔离断言
- [ ] **Step 4: commit** `feat(agent-lab): scheduled_jobs+定时触发器（常驻会话承载，含 tenantId，F/WP5）`

## Task 26: event_subscriptions 表 + 订阅派发器

**Files:**
- Modify: `extensions/agent-lab/src/core/storage/schema.ts`（event_subscriptions 表——**含 tenantId**）
- Modify: `extensions/agent-lab/src/core/events/event-log.ts`（append 旁路通知——不改 append-only 语义）
- Create: `extensions/agent-lab/src/core/events/subscription-dispatcher.ts`
- Test: `extensions/agent-lab/test/subscription-dispatcher.test.ts`（新建）

- [ ] **Step 1: 表+派发器**——订阅注册表（内存回调）；EventLog append 后同步通知；匹配（eventType+过滤条件）→构造 DispatchRequest→dispatch
- [ ] **Step 2: 测试**——订阅/匹配/派发/tenantId 隔离/append-only 语义不变断言
- [ ] **Step 3: commit** `feat(agent-lab): event_subscriptions+订阅派发器（EventLog 旁路，F/WP5）`

## Task 27: pth webhook 外部事件入口

**Files:**
- Modify: `src/pth/gateway/`（POST /api/v1/events 路由）
- Test: `test/unit/events-webhook.test.js`（新建）

- [ ] **Step 1: webhook 路由**——`{eventType, payload, source}`→转发常驻系统会话（pi.events emit 或 EventLog 写入——实现时定并文档化）→触发订阅派发
- [ ] **Step 2: 权限+审计**——Bearer+tenant 归属；事件落审计
- [ ] **Step 3: 测试**——push→订阅触发断言（mock 常驻会话）；权限拒绝断言
- [ ] **Step 4: commit** `feat(pth): webhook 外部事件入口——POST /api/v1/events→常驻会话（F/WP5）`

## Task 28: 管理面 + WP5 集成验证

**Files:**
- Modify: `extensions/agent-lab/src/commands/register.ts`（/lab schedule add/ls/pause/resume/rm）
- Test: `extensions/agent-lab/test/scheduled-integration.test.ts`（新建）+ `test/unit/f-wp5-integration.test.js`

- [ ] **Step 1: /lab schedule 命令**（常驻会话内扩展命令）
- [ ] **Step 2: hub observe 集成**——scheduled_jobs/subscriptions 只读可见（Task 21 路由扩展）
- [ ] **Step 3: DispatchRequest checkpointId 核实**（spec §6.5 小 spike——有则文档化"到点续跑"可用，无则标注后续）
- [ ] **Step 4: 集成测试**——建定时 job→到点 dispatch（时间压缩：interval=秒级）→审计事件断言；外部 webhook→订阅触发断言
- [ ] **Step 5: 全绿**（agent-lab 1636 基线+新增+PTL 基线）
- [ ] **Step 6: commit** `feat(agent-lab,pth): /lab schedule 管理面+WP5 集成验证（F/WP5）`

---

## 收尾 Task 29: 文档 + runbook + 全量验证

**Files:**
- Create: `docs/superpowers/runbooks/2026-08-05-containerized-federation.md`（启动/恢复/降级/自修改调试/构件上传/定时事件 操作手册）
- Modify: `docs/pth/deployment.md`（容器化部署更新）
- Modify: `ARCHITECTURE.md`（F 后架构图更新）

- [ ] **Step 1: runbook**——compose 启动顺序/持久化不变量验证步骤/会话恢复操作/sandbox 降级处理/自修改调试流程（含密钥临时注入）/hub 命令全表/定时事件管理
- [ ] **Step 2: 文档更新**——deployment.md 重写（多阶段构建/卷/env/Redis 策略）；ARCHITECTURE.md 容器拓扑图
- [ ] **Step 3: 全量验证**——PTL 717+agent-lab 1636 基线+全部新增测试绿；docker build 实证（若有 docker）
- [ ] **Step 4: commit** `docs(pth): F 阶段 runbook+部署文档+架构图更新`

---

## Spike 结论（执行时填写）

- S1（SDK revive）：
- S2（SDK bash 拦截）：
- S3（SDK 扩展加载）：

## 附录 B：S3 失败时的备用任务（选项 B——pth 直接 import agent-lab）

- B1：pth package 依赖声明 agent-lab 框架层（core/scheduler——不含 pi 扩展胶水层）；分层例外文档化（framework-vs-construction.md 修订——平台层可引框架层纯模块）
- B2：timed-trigger/订阅派发器改为 pth 进程内直接实例化（无常驻会话——RESERVED 机制保留用于其他用途或删除）
- B3：其余 Task（25-28）不变（触发源换成 pth 直接调用）
