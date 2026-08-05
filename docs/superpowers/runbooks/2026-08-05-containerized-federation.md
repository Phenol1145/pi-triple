# Runbook: 容器化联邦操作手册（F 阶段）

> 子项目 F（容器化 + PTL 架构更新 + 联邦触发机制）交付后的运维操作手册。
> 架构依据：`docs/superpowers/specs/2026-08-05-containerization-architecture-design.md`（v0.2 评审通过版）。
> 实施计划：`docs/superpowers/plans/2026-08-05-containerization.md`。

---

## 1. 部署拓扑

```
┌─ 本机 PTL（tmux 壳）─────────────────────────────┐
│  pit hub submit/request/respond/observe/debug     │
│  pit run / programs / dev                        │
└───────────────┬───────────────────────────────────┘
                │ HTTP/SSE/WS (Bearer token)
┌───────────────▼───────────────────────────────────┐
│ pth 容器（pi-platform，单实例）                     │
│  网关（HTTP/SSE/WS）/ 会话池 / SDK 会话            │
│  【常驻系统会话】= system-governor 雏形：           │
│    agent-lab 扩展（定时/事件/dispatch）            │
│  ComponentStore（5 类构件+版本化）                 │
│  fallback_requests 队列（回退请求通道）            │
│  hub observe（Redis 痕迹 + EventLog 代理）        │
└───────┬──────────────────┬────────────────────────┘
        │ sandbox-internal  │ 出网（LLM 调用）
┌───────▼─────────┐  ┌──────▼───────┐
│ sandbox 容器     │  │ redis 容器    │
│ 唯一代码执行     │  │ 审计/池元/    │
│ 无外部网络       │  │ 构件指针      │
│ 无 LLM 密钥      │  │ noeviction   │
└─────────────────┘  └──────────────┘

卷（全部持久化）：workspaces / platform / tenants / components /
                 agent-dir / sessions / agent-lab / redis-data
```

**网络**：pth 双网络（default 出网调 LLM + sandbox-internal 内网）；sandbox 仅 internal（**无外部出口**——egress 锁定）。

---

## 2. 启动 / 恢复

```bash
# 启动（构建+拉起全部服务）
docker compose up -d --build
# 或仅构建 pth 镜像
docker build -t pi-platform:f .

# 验证
docker compose ps                        # 全部 healthy（pth/redis/sandbox）
curl -sf http://localhost:3000/health    # {"status":"ok",...}（sandbox degraded 时 503）
curl -sf http://localhost:3001/health    # sandbox /health（compose 内部）
```

**持久化不变量验证清单**（`docker compose down && up` 后应满足）：
- [ ] 构件在 `/data/components` 持久化（`pit hub programs` 可见历史版本）
- [ ] agent 能力在 `/data/agent-dir` 持久化（skills/prompts 不丢）
- [ ] 会话在 `/data/sessions` 可恢复（recoverAll 自动——见 §3）
- [ ] 认证不失效（Redis appendonly + 凭据外置 env）

**启动顺序**（compose 依赖处理）：
1. redis（service_healthy）→ 2. sandbox（service_healthy）→ 3. pth（recoverAll 先于 listen——崩溃残留会话自动恢复）

---

## 3. 会话恢复语义

- **崩溃恢复**：pth 重启时 `recoverAll()` 扫描 Redis `pool:*` → 逐会话 revive（SDK `continueRecent`/`open`）→ 原 busy 会话标记 `interrupted` + `recovered-from-crash`，pending dispatch 丢弃+审计（**不重放**）。
- **恢复校验**：`buildSessionContext().messages.length` vs `meta.entryCount` 不一致记 warn（懒落盘窗口——纯 user 消息未落盘，崩溃丢该轮，接受）。
- **常驻系统会话**：RESERVED 标记永不驱逐 + recoverAll 优先恢复 + watchdog（60s 周期）自动重建（重建写审计 `system_session_rebuilt`）。
- **竞态**：main.ts 已先 recoverAll 后 listen——Epoch 判定冗余（若未来并发化须补 Redis Epoch）。

---

## 4. sandbox（代码执行）

**定位**：**所有代码执行全部在 sandbox**——pth 内 SDK 会话的 bash 工具经 customTools 同名 `bash` 转发（统一接口名，无第二套 API）。pth 进程自身运行不属于代码执行。

- **执行 API**：`POST /exec`（共享密钥 `SANDBOX_SHARED_SECRET` env 注入，fail-closed——无密钥 503）；cwd 白名单（realpath 后必须在 `/data/workspaces/` 下——symlink 逃逸拒绝）；超时强杀（进程组 SIGKILL）。
- **密钥隔离**：转发 payload 仅 `{cmd, cwd, timeout}`——**不转发 pth env，sandbox 不持 LLM 密钥**。
- **egress**：sandbox 无外部网络（internal）。自修改调试需包下载时**人工临时开通**（非自动）。

### 失效降级

- sandbox 不可达（连续 N=3 次失败，`SANDBOX_DEGRADED_THRESHOLD` 可配）→ pth `/health` 503 + `sandbox` 子状态 `{degraded, consecutiveFailures, threshold}`；恢复自动（转发成功/探活通过）。
- 降级时 bash 调用返回类型化错误 `sandbox-unavailable`/`sandbox-timeout`（模型侧可见，不静默）。

### 自修改调试（sandbox 内嵌 pi+PTL）

```bash
# 进入 sandbox 调试会话（tmux 在容器内）
docker exec -it <sandbox-container> /data/scripts/sandbox-debug-entry.sh pi
# 或 pit
docker exec -it <sandbox-container> /data/scripts/sandbox-debug-entry.sh pit

# 需要 LLM 调试（非常态）——按需临时注入密钥，用完即撤：
docker exec -e PI_ANTHROPIC_API_KEY=<key> -it <sandbox-container> /data/scripts/sandbox-debug-entry.sh pi
```

调试产物 = **构件**，经 `pit hub submit`/`pit hub respond` 上传回流 pth 填槽生效。

---

## 5. hub 命令全表

```bash
pit hub submit <dir>                    # 上传 agent-program（agent.json manifest 校验+打包）
pit hub programs                        # 构件列表（含版本/类型）
pit hub run <name> [args...]            # 运行 agent-program（SSE 单向回显）
pit hub dev <name>                      # 开发模式
pit hub request "<description>" --slot <slotId> [--urgency high|medium|low]
                                        # 手动建回退请求（自动触发留 E）
pit hub requests                        # 回退请求列表（open 优先）
pit hub respond <requestId> <dir>       # 构建构件→上传→自动闭合（slotHint 自动补位绑定）
pit hub observe sessions                # 远程会话列表（Redis 痕迹）
pit hub observe session <id>            # 会话详情
pit hub observe trace <id>              # trace 时间线
pit hub observe events                  # EventLog 查询（经常驻会话代理；按调用方 tenant 过滤）
pit hub debug                           # 交互式接入 sandbox 调试区（WS 双向；需 platform-admin）
```

**构件类型**（ComponentManifest.type）：`agent-program | scheduler | optimizer | memory-pack | skeleton-update`。agent-program 走 agent.json；其余类型走 definition.json。可选字段：`targetSlot`（空位绑定）、`legalAuth`（声明式登记——审计追溯，不拦截）。

---

## 6. 定时 / 事件触发（常驻系统会话承载）

**机制**：pth 内常驻系统会话加载 agent-lab 扩展（extensionFactories 注入 + noExtensions）→ `SchedulerRunner.dispatch` 唯一入口。

### 定时任务（scheduled_jobs 表）

```bash
# 在常驻会话内（/lab 命令——需经 sandbox 调试区或本机 PTL 会话触发）
/lab schedule add --taskType <type> --cron "0 9 * * *" --payload '<json>' [--tenant <t>]
/lab schedule ls
/lab schedule pause <id> / resume <id> / rm <id>
```

- scheduleKind：`cron`（5 段最小解析：`*`/`*/n`/`a-b`/`a-b/n`/列表；dom/dow OR 语义；本地时区）/ `at`（ISO）/ `interval`。
- missed-fire：重启恢复时补火一次（不追历史）。
- 到期 → `DispatchRequest`（taskType→role，payload→task，labels 带 tenantId/jobId）→ dispatch → 重排 nextFireAt。

### 事件订阅（event_subscriptions 表 + 订阅派发器）

```bash
# 注册订阅：何种事件触发何种任务（EventLog append 旁路派发）
/lab subscribe add --pattern '{"eventType":"..."}' --taskType <type> --payload '<json>'
```

- EventLog append-only 语义不变（订阅是旁路；通知失败仅日志+审计不阻断）。
- **外部事件入口**：`POST /api/v1/events`（Bearer）`{eventType, payload, source}` → 常驻会话 → EventLog → 订阅派发。

### 观测

```bash
pit hub observe events                 # EventLog 查询（tenant 隔离——只能看自己租户）
```

---

## 7. Redis 运维

- **驱逐策略**：`noeviction`（auth/audit 防淘汰——写满时 OOM 拒绝而非静默淘汰）。
- **容量监控**：`/metrics` 暴露 `pi_redis_used_memory_bytes` / `pi_redis_max_memory_bytes`（15s 采集）。
- **告警阈值**：used_memory > 80% maxmemory → 人工介入（清构件旧版本/扩容）。
- 演进：多副本时 Redis 拆数据/队列双实例（当前单实例足够）。

---

## 8. 已知边界（诚实标注）

| 边界 | 说明 |
|---|---|
| sandbox 单点 | 唯一 sandbox = 代码执行单点（用户裁决接受）；降级设计保证可见性与快速恢复 |
| 懒落盘窗口 | 纯 user 消息会话崩溃丢该轮 prompt（SDK 无 flush API，接受） |
| cron 时区 | 本地时区（跨 DST 日有小时空洞/重叠可能，v0.1 忽略） |
| observe 事件隔离 | EventLog 按 tenantId 过滤（webhook/定时/订阅事件带租户归属）；无 tenant 的系统事件（如系统审计）对所有租户不可见 |
| component-bound registry | 内存态——常驻会话重建后需 pth 重新通知（bindings 由 Redis 持久，可从 Redis 重放——演进项） |
| checkpoint 续跑 | DispatchRequest 无 checkpointId 字段——"到点续跑"需 payload 携带（spec §6.5 文档化） |
| watchdog 检测 | 检测"缺席"（崩溃）而非"卡死但仍在"（agent-loop 无响应）——已知边界 |

---

## 9. 验证清单（交付后冒烟）

```bash
# 1. 基线
docker compose ps                                    # 全 healthy
curl -sf localhost:3000/health

# 2. 构件闭环
pit hub submit examples/pr-review/                   # agent-program 上传
pit hub programs                                     # 可见
pit hub request "缺一个 X" --slot slot-a            # 建回退请求
pit hub requests                                    # open 可见
pit hub respond <id> examples/pr-review/             # 上传+闭合（slot-a 绑定）

# 3. 定时/事件
/lab schedule add --taskType <t> --interval 60 ...   # 秒级 interval 验证到点 dispatch
pit hub observe events                              # 事件可见（scheduled.fire）

# 4. sandbox
pit hub run <name>                                  # 会话内 bash 调用走 sandbox（日志/观测确认）
docker compose stop sandbox && curl -sf localhost:3000/health  # 503 + degraded
docker compose start sandbox && sleep 10 && curl -sf localhost:3000/health  # 恢复 200

# 5. 持久化
docker compose down && docker compose up -d         # 构件/会话/agent-dir 不丢；recoverAll 审计
```
