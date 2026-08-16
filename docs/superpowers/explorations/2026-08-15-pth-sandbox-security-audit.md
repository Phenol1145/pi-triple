# PTH Sandbox 安全与运行时审计（2026-08-15）

> 范围：`packages/pth-sandbox`，以及它的 PTH 调用链、Compose 部署与记忆桥接端。
>
> 方法：源码与配置只读审计；未修改运行代码或部署配置。`pth-sandbox` 包的 TypeScript 检查通过，包内测试在可绑定本地临时端口的环境中通过（113 项）。未启动 Docker、未做高并发或逃逸动态测试。
>
> 注意：工作树正处于 `pth-sandbox` / `dev-container` / mailbox 拆分迁移中；以下结论以 2026-08-15 磁盘状态为准。

## 结论

当前 sandbox 具备网络、非 root 和资源限制等纵深防护，但**还不能作为多租户或不可信代码的安全边界投入生产**。问题核心不是单个 API，而是下列边界没有闭合：

1. 公网 PTH 网关与 sandbox 控制面共用已知默认密钥；
2. 不可信工作负载可以读取该控制面密钥；
3. kernel 和工作区都没有租约或租户级的强制隔离；
4. 当前 sandbox 镜像无法在干净构建环境中可靠产出。

在默认 Compose 配置且宿主机 3000 端口对外可达时，记忆数据应按“可能已泄露”处置。

## P0：上线阻断项

### P0-1：默认部署可通过公开 PTH 入口读取全部记忆

**链路**：PTH 发布 `3000:3000`；`/api/v1/kernel/memory-bridge` 被排除在常规 Redis bearer 鉴权之外；Compose 为共享密钥提供 `sandbox-dev-secret` 默认值。请求未带 `space` 时，路由不做可见性过滤；`retrieve({})` 最终生成无 `WHERE` 的全表查询。

**影响**：若端口可从外部访问，未持有平台登录 token 的调用方可读取 memory entries 及元数据。

**证据**：

- `deploy/docker-compose.yaml:7-8, 30-32, 108`
- `src/pth/gateway/auth.ts:17`
- `src/pth/gateway/routes-kernel.ts:38-61`
- `packages/pth-memory/src/memory-store-pg.ts:127-145`

**处置**：移除默认密钥、立即轮换既有密钥；不要把桥接端点放在公开 listener 上；由服务端从不可伪造的身份派生 scope，缺少 scope 一律拒绝。

**状态（2026-08-15）**：已处置。compose/描述符改为 `${SANDBOX_SHARED_SECRET:?}`（无默认值，缺省拒绝启动）；`memory-bridge` 取消 auth 豁免，tenant/space 只能来自 Redis token 声明；body 自报 space 返回 400；sandbox 上游改用 `PTH_MEMORY_BRIDGE_TOKEN`，缺失 fail-closed 503。新增测试：`test/pth-gateway/auth.test.ts`、`test/pth-gateway/kernel-routes.test.ts`、`packages/pth-sandbox/test/kernel-host-bridge.test.ts`。

### P0-2：不可信代码持有 sandbox 控制面凭据

`/exec`、Python REPL 和 Bash REPL 都将完整 `process.env` 传给工作负载。Compose 注入的 `SANDBOX_SHARED_SECRET` 因而可由不可信代码读取。该密钥可调用全部 `/kernel/*` 和 memory bridge 控制面，而不是仅授权当前任务。

**影响**：即使运营方替换默认密钥，任意可运行 sandbox 代码的主体仍可以获得全局控制能力；`/app` 也被同一执行用户拥有，可被工作负载篡改。

**证据**：

- `packages/pth-sandbox/src/exec-api.ts:125-131`
- `packages/pth-sandbox/src/py-kernel.ts:357-361`
- `packages/pth-sandbox/src/bash-kernel.ts:169-174`
- `packages/pth-sandbox/Dockerfile.sandbox:76-78`

**处置**：工作负载使用严格环境白名单；不向其暴露服务身份凭据；改为短期、单用途、绑定任务和租户的 capability。服务 API 与工作负载应使用不同 UID 或不同容器，并将应用根文件系统设为只读（必要写入使用专用挂载）。

**状态（2026-08-15）**：已处置核心项。新增 `workload/environment.ts`：/exec、PyKernel、BashKernel 一律 allowlist 构造 env，`SANDBOX_SHARED_SECRET`/`PTH_MEMORY_BRIDGE_TOKEN`/数据库/LLM key 强制剔除；Dockerfile 创建 workload UID/GID 2001，控制器 root 仅用于 setuid，/app 归 root 只读，工作区暂 0777（P0-3 收窄）。sandbox 内 loopback 记忆桥免共享密钥且 body.space 被剥除，上游由 controller 持有的 bridge token 鉴权。残留：grant 化的单用途 capability 属 P0-4 lease 一并落地；sandbox 镜像干净构建因 registry TLS 超时未能在本机验证（改动已过 `docker compose config` 与全量测试）。

### P0-3：共享工作区不是租户隔离

PTH 和 sandbox 同时以同一用户挂载全局 `workspaces` 卷。`validateCwd()` 仅确保启动目录位于该卷下，不能限制 `bash -lc` 在运行后访问绝对路径、切换目录或读取其他租户子树。

**影响**：只要平台承诺 `tenantId` 是隔离边界，一个租户的 shell 任务即可读写其他租户工作区。

**证据**：

- `deploy/docker-compose.yaml:9-10, 104-105`
- `packages/infra/src/workspace/manager.ts:23-42`
- `packages/pth-sandbox/src/exec-api.ts:125-131, 198-221`

**处置**：每任务/租户使用独立容器或只挂载该任务的工作区子目录；以 UID/ACL 或挂载命名空间强制约束，而非把初始 cwd 当作授权边界。

**状态（2026-08-15）**：已处置核心项。PTH 侧租户/项目/任务目录 0700（workload UID 无法读其他租户）；外部任务发布的 tenant 只能来自 auth token（body 覆盖无效，`routes-kernel`/`routes-jobs` 透传）；sandbox `/exec` 在容器内启用私有工作区（`PTH_EXEC_PRIVATE_ROOT=/srv/workload`）：执行前拷贝任务 cwd、chown workload、执行后回拷，workload 不直接接触共享卷。残留：Python/Bash REPL 尚未绑定任务工作区 broker（依赖 0700 权限拒绝读共享卷）；容器内跨租户负向测试待 clean-build 环境补跑。

### P0-4：kernel 没有安全租约，TTL 还会重分配活跃 REPL

kernel ID 是递增、可预测的 `py-N` / `sh-N`；`execute/reset/snapshot/release` 只按 ID 操作，既不验证 owner，也不检查当前租约。Compose 默认开启 30 分钟 entry TTL；sweep 会 dispose 一个仍被持有的 entry 并直接标记为空闲，旧客户端持有的 ID 不会失效，新客户端可获得同一个 ID。

**影响**：状态泄露、会话劫持、并发执行同一 REPL、结果错配和子进程残留。P0-2 使这一缺陷无需猜测凭据即可被 sandbox 工作负载利用。

**证据**：

- `deploy/docker-compose.yaml:110-114`
- `packages/pth-sandbox/src/kernel-pool.ts:72-80, 87-90, 99-105, 123-142`
- `packages/pth-sandbox/src/kernel-host.ts:85-118`
- `packages/pth-sandbox/src/sandbox-kernel.ts:109-140`

**处置**：`acquire` 返回高熵、一次性的 lease capability；所有操作校验 lease、tenant、generation 与 in-flight 状态。TTL 到期时原子失效旧租约、终止并回收 entry，绝不能仅置为 idle。

**状态（2026-08-15）**：已处置。新增 `kernel-lease.ts`：acquire 返回 UUID lease；execute/reset/snapshot/release 全部校验 lease id+generation；release 同 lease 幂等、旧 lease 拒绝；TTL 到期 `active → cancelling → disposed` 并移出池，绝不复用旧租约；HTTP 协议退役 `kernelId`（旧字段 400）；SandboxKernel 客户端只持有 opaque lease。测试：`sandbox-kernel-host.test.ts`（lease 协议、TTL 竞态、stale lease）、`sandbox-kernel.test.ts`、`sandbox-kernel-abort.test.ts`。

### P0-5：当前 sandbox 镜像不能从干净源码可靠构建

builder 只复制 `tsconfig.json`，但 pth-memory 和 pth-sandbox 的 tsconfig 都继承根 `tsconfig.base.json`。构建阶段会因缺失该文件而报 TypeScript `TS5083`。此外 runtime 复制 framework `dist`，但 builder 没有构建 framework；它还复制了已迁移、当前不存在的 `extensions/mailbox` 目录。

**证据**：

- `packages/pth-sandbox/Dockerfile.sandbox:6-13, 45-48, 60-65`
- `packages/pth-memory/tsconfig.json:2`
- `packages/pth-sandbox/tsconfig.json:2`

**处置**：复制根 base tsconfig；明确 workspace 构建顺序或使用 root build；在 CI 中执行无缓存 Docker build，禁止依赖开发机残留 `dist`。

**状态（2026-08-15）**：已处置并验证。`docker build --no-cache` 成功（builder 补齐 `tsconfig.base.json` 与 shared→infra→framework 构建顺序；`useradd` 先建 group；pi-platform runtime 的 package.json 以 node 属主拷入，修复 `ERR_MODULE_NOT_FOUND`）。容器 smoke：health 200、`/exec` 以 UID 2001 运行、跨租户目录读被拒、私有工作区回拷属主为 node 1000。`docker compose` 全拓扑（含 dev/jupyter）六服务 healthy。

## P1：修复 P0 后仍须解决的高风险问题

| 编号 | 问题与影响 | 证据 | 修复方向 |
|---|---|---|---|
| P1-1 | 客户端 HTTP 默认 10 秒，但内核执行默认可达 300 秒。abort 只中止 fetch，随后 release；服务端代码可能仍在运行并被重新分配。 | `sandbox-kernel.ts:53, 115-140, 190-197` | 服务端提供取消并确认完成的 API；release 必须等待无 in-flight 请求；transport deadline 覆盖执行预算。 |
| P1-2 | 任务启动的 `kernel.reset()` 未 await；sandbox reset 是异步 HTTP。Python/Bash 又在通道级全局共享，任务级状态隔离存在竞态。 | `src/pth/kernel/execution/task-loop.ts:130-141`; `src/pth/impls/kernels/kernel-manager.ts:162`; `src/pth/kernel/exec-channel.ts:12-14` | 将 reset 纳入异步 Interpreter 契约，等待完成；按任务/租户分配 kernel 或显式不可共享。 |
| P1-3 | `/exec` 无 stdout/stderr 字节上限、无全局或租户级并发阈值，完成任务仍缓存 60 秒；持续输出可耗尽 1 GiB 容器的 Node 堆。 | `exec-api.ts:64-105, 135-144, 291-300`; `docker-compose.yaml:128-134` | 以字节上限截断并杀进程组；限制并发、排队和重放缓存；处理 SSE backpressure。 |
| P1-4 | Python/Bash/C/gdb 的超时或取消路径不能一致地杀掉整个进程组，后代可能残留直至耗尽 PID 配额。 | `py-kernel.ts:384`; `bash-kernel.ts:219`; `compiled-kernel.ts:64`; `gdb-mi.ts:433` | 所有执行核创建独立进程组/cgroup，timeout/abort 后 kill、wait、reap 整棵进程树。 |
| P1-5 | `/health` 无条件返回 200，即使共享密钥缺失、所有执行端点均为 503，Compose 会错误放行依赖。 | `exec-api.ts:253-271`; `docker-compose.yaml:72-77, 123-127` | 拆分 liveness 与 readiness；readiness 检查密钥、内核池和必要目录。 |
| P1-6 | `ptl hub deploy` 的声明式描述文件路径与 schema/渲染器脱节；即使读取成功也会丢失 PTH 的双网络，使它无法访问 sandbox。 | `packages/framework/src/bridge/containers.ts:20`; `packages/framework/src/containers/deployment.ts:16`; `packages/framework/src/containers/docker-backend.ts:62` | 修正 descriptor 定位、schema 与 renderer；添加实际渲染后的连通性测试。在完成前以手写 Compose 为唯一部署路径。 |

> **处置去向（2026-08-16 补账，执行入口 `docs/superpowers/plans/2026-08-16-pth-sandbox-hardening.md`）**：
> P1-1 → v2 `pth-modularization-v2.md` P2-3（cancel-ack-release）；P1-2 → v2 P1-4（runner 侧 await reset）；
> P1-3/P1-4 → v2 P2-4（输出上限 + 进程组收割）；P1-5 → v2 P2-6（liveness/readiness + check-sandbox-env.sh 路径）；
> P1-6 → 已落地（`2f97600`）。下方 P2 五条：Bash 标记竞态/StreamJob/shutdown → 加固计划 S1-4；
> gdb 上限+idle 已部分落地、ID 竞态与 pending 关联 → S1-3；编译 cache key 缺 compiler 身份 → S1-2；
> `check-sandbox-env.sh` 路径 → v2 P2-6。

## P2：应纳入后续加固

- Bash 使用固定完成标记，用户输出和 stdout/stderr 跨流时序可导致响应提前结束或错配：`packages/pth-sandbox/src/bash-kernel.ts:246-286`。
- debug session 上限与 ID 生成存在并发竞态；GDB MI pending 请求没有可靠关联：`kernel-host.ts:280-291`、`gdb-mi.ts:217, 289, 323`。
- 编译缓存 key 未包含 compiler identity，gcc/clang/tcc 可能命中同一产物：`compiled-kernel.ts:60, 154`。
- `StreamJob` 只有一个 `onDone`，多 SSE 订阅可使较早连接无法结束；host shutdown 未完整 dispose pools/debug 会话：`exec-api.ts:69, 352`、`kernel-host.ts:267`。
- `scripts/check-sandbox-env.sh` 仍扫描仓库根的 `Dockerfile.sandbox`，真实文件已迁入 `packages/pth-sandbox/`；缺文件错误被吞掉，脚本可给出“镜像无凭据”的假阳性：`scripts/check-sandbox-env.sh:10-18`。

## 已有防护与其边界

- sandbox 没有宿主机端口映射，只加入 `sandbox-internal` 网络；
- 工作负载以非 root `workload`（UID/GID 2001）运行，并设置 1 CPU、1 GiB、256 PID 限额；控制器容器内 root 仅用于 setuid；
- `/exec` 的正常 timeout 路径使用 detached 进程组并 `kill(-pid)`；
- cwd 校验能阻止启动路径的 `..` 与 symlink 逃逸。

这些是有价值的纵深防护，但不能替代身份、租约、文件系统和租户边界。

## 建议的处置顺序

1. **立即减缓暴露**：关闭或内网化 memory bridge，移除默认密钥并轮换已用密钥；公网入口仅经明确的认证反向代理暴露。
2. **暂停不可信/多租户执行**：在 workspace 和 kernel lease 隔离完成前，不应将 sandbox 暴露给相互不信任的租户。
3. **重建 capability 模型**：服务身份不进入工作负载；使用短期、绑定 tenant/task/generation 的 lease，所有状态转换原子化。
4. **修复可交付性**：修正 Dockerfile 和声明式部署，再建立 clean-build、Compose 连通性、取消/超时、跨租户隔离、输出配额的集成测试。
