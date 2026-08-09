# PTH Kernel 容器运行与更新策略评估（2026-08-10）

> 类型：exploration / 维护建议
>
> 状态：讨论结论整理，不是已批准 SPEC，不表示本文所列机制已经实现。
>
> 核对基线：`7de7a7500381`；资源数据来自 2026-08-10 对当前 OrbStack 容器的一次性只读采样。
>
> 范围：PTH 主核心、Kernel batch、sandbox 及其更新路径。本文不引入新的产品能力，也不讨论 Rust/Go 重写。

## 1. 结论摘要

1. **生产核心继续运行在容器中。** 容器提供固定运行环境、非 root 用户、卷边界、网络拓扑和 CPU/内存/PID 限额；这些收益高于宿主直接运行带来的编辑便利。
2. **宿主运行适合作为开发模式，不宜直接替代生产模式。** Node 代码具备跨平台基础，但当前 Redis/PostgreSQL/sandbox 服务名、共享工作区路径和 Kernel 子进程入口仍依赖容器拓扑。
3. **容器不是不能热修改的根因。** 当前生产镜像运行固化的 `dist`，且未绑定挂载源码；开发模式可通过源码挂载和自动重启获得快速反馈。
4. **Kernel 代码不采用进程内热替换。** ESM 缓存、已有实例、定时器、数据库连接、batch 子进程和执行中任务会造成新旧代码混跑；可靠的更新单元应是进程、batch 代际或容器实例。
5. **近期优先采用“在线预构建、单实例快速替换”。** A 在构建期间继续服务，候选镜像完成后才排空并替换核心容器，把用户感知中断从“完整构建时间”缩短为“停止、启动和恢复时间”。
6. **需要近零中断时采用轻量 A/B，而不是完整双活。** B 在验证阶段保持 standby，不恢复会话、不领取任务、不启动默认 batch；切换窗口内才激活执行面。
7. **长期最贴合 Kernel 的更新方式是 batch 代际滚动。** 主进程和 Gateway 保持不变，只让旧 batch 完成存量任务、新 batch 领取新任务；该方向成本低于整个核心容器 A/B，但需要先补齐排空、代际绑定和 fencing。
8. **当前主要耗时和磁盘浪费来自镜像层，而非源码体积。** 核心镜像约 1.28 GB，其中生产依赖层约 408 MB，最后的递归 `chown -R /data /app` 产生约 374 MB 层；源码和 `dist` 合计仅约 3 MB。

## 2. 术语与边界

本文统一使用以下术语，避免把不同更新语义都称为“热修改”。

| 术语 | 本文定义 | 是否保留进程内状态 |
|---|---|---:|
| L1 热加载 | 运行中加载 skills、prompts、config 等资源覆盖层 | 是 |
| 自动重启 | 源码变化后终止旧 Node 进程并启动新进程，例如 `tsx watch` | 否，依赖外置状态恢复 |
| 进程内热替换 | 不重启进程，直接替换已加载的 Kernel 模块和实例 | 目标上是，但本文不建议 |
| 单实例替换 | 候选构件预先构建完成，排空旧实例后用新实例替换 | 否，依赖恢复 |
| A/B 更新 | A 继续服务时启动并验证 B，再切换 active 身份和入口 | A、B 状态外置共享，内存状态不共享 |
| standby | 已启动并可验证，但不接收业务流量、不恢复会话、不领取任务的候选实例 | 不适用 |
| 排空（drain） | 停止接收新工作，允许或显式处理执行中工作，完成 checkpoint 后退出 | 尽量转为外置状态 |
| fencing | 通过租约、epoch 或等价机制保证任一时刻只有一个 active 执行者 | 不适用 |
| Kernel 代际 | 同一主进程管理的不同版本 batch/worker 执行实现 | 按任务边界隔离 |

当前 `HotReloader` 只监听 `platform/skills`、`platform/prompts` 和 `platform/config`，不替换 `src/pth/kernel` 代码。`package.json` 中的 `pth:dev` 使用 `tsx watch src/pth/main.ts`，属于自动重启而非进程内热替换。

## 3. 为什么生产核心仍应保留容器边界

当前 `pth.deployment.json` 为核心声明了 2 CPU、2 GiB 内存和 512 PID 上限，并以 `node` 用户运行。核心与 PostgreSQL、Redis、sandbox 通过固定服务名连接，工作区通过 named volume 在 PTH 与 sandbox 之间以同一路径 `/data/workspaces` 共享。

这些边界带来：

- Node、系统库和依赖版本可复现；
- 主核心只获得明确挂载的数据面；
- sandbox 保持独立容器和内部网络；
- CPU、内存和 PID 有硬上限；
- 健康检查、日志和生命周期统一；
- 宿主 macOS、Windows、Linux 差异被 Linux 容器吸收。

宿主直接运行虽然可以复用 `detectPlatform()` 的 macOS/Windows/Linux 适配，也可以把 `DATA_DIR` 落到 `.pi-platform-data`，但当前并非零配置：

1. 宿主无法解析 `redis`、`postgres`、`sandbox` 等 Compose 服务名；当前这些服务也没有全部暴露到宿主。
2. 宿主工作区路径与 sandbox 的 `/data/workspaces` 不一致；现有 sandbox cwd 白名单会拒绝宿主绝对路径。
3. `resolveBatchProcessPath()` 默认仍固定到 `dist/pth/kernel/execution/batch-process.js`，主进程使用 `tsx watch` 不代表 batch 自动运行新源码。
4. `PTH_SOURCE_ROOT` 默认是容器路径 `/app/src`。
5. `NODE_OPTIONS=--max-old-space-size=768` 只限制单个 V8 old space，不等价于容器对整个进程树的 RSS、CPU 和 PID 限制。

因此建议保留两种明确模式：生产容器模式作为事实标准；宿主或源码挂载容器仅用于开发调试。

## 4. 当前资源基线

### 4.1 一次性实测

采样命令为一次性 `docker stats --no-stream` 与 `docker top`。数据只表示当时空闲/轻载状态，不是容量承诺。

| 服务 | 内存 | CPU | PID |
|---|---:|---:|---:|
| PTH 核心 | 213.5 MiB / 2 GiB | 1.14% | 22 |
| sandbox | 30.1 MiB / 1 GiB | 2.24% | 7 |
| PostgreSQL | 76.58 MiB / 512 MiB | 3.55% | 15 |
| Redis | 4.762 MiB / 256 MiB | 3.36% | 6 |
| PTH 四服务合计 | 约 325 MiB | 单点采样不可直接相加为容量结论 | 50 |

核心内部进程 RSS：

| 进程 | RSS | 说明 |
|---|---:|---|
| `node dist/pth/main.js` | 约 106 MiB | Gateway、会话、装配、监控等主进程 |
| `node dist/pth/kernel/execution/batch-process.js` | 约 99 MiB | 默认单大 batch 与角色 TaskLoop |

### 4.2 更新模式增量估算

| 更新模式 | 预计新增空闲内存 | 预计新增 PID | 极端资源边界 | 备注 |
|---|---:|---:|---:|---|
| 完整核心 A/B | 约 210–250 MiB | 约 22 | 第二核心仍可达到 2 GiB 上限 | B 完整恢复并启动 batch |
| 轻量 standby B | 约 105–140 MiB | 约 5–10 | 应另设较低候选上限 | 不恢复、不消费、不启动 batch |
| 仅 batch 代际 A/B | 约 100–130 MiB | 少量 | 受同一核心容器 2 GiB 总上限约束 | 以当前 batch 约 99 MiB 外推 |
| 预构建后单实例替换 | 运行时几乎无常驻增量 | 0 | 构建阶段另有瞬时资源 | 接受短暂停止/恢复窗口 |

按部署声明计算，当前四服务资源上限约为 3.75 GiB；完整复制一个 2 GiB 核心后，上限合计约 5.75 GiB。实际轻载占用远低于上限，但构建、模型调用、会话增长和 Kernel 执行可能显著抬高峰值。

构建阶段的 CPU/内存未在本次讨论中做受控实测。维护时应把“候选运行开销”和“构建器瞬时开销”分别计量，不能用空闲容器数据替代构建容量结论。

## 5. A/B 更新的适用方式

### 5.1 推荐的是容器级 A/B，不是容器内自重建

早期文档曾描述：`.rebuild-request` → `supervisor.sh` → A/B 符号链接切换。容器化设计随后明确废弃该机制，将核心代码更新重新定位为外部构建和部署；`Dockerfile` 也已移除 `supervisor.sh`。

这并不否定 A/B，而是否定“运行中的受管核心修改并重建自身运行环境”。推荐边界是：

```text
运行核心提出或产出候选构件
  → 外部构建器生成不可变镜像/构件并记录 digest
  → 外部更新协调器启动 B
  → 健康与兼容性验证
  → active 身份切换
  → 观察或回滚
```

### 5.2 B 必须是 standby，而不是第二个 active 核心

当前核心启动会执行多项有副作用的动作：

- 创建 BullMQ intent worker；
- `recoverAll()` 恢复 Redis 中的会话；
- 创建常驻系统会话和 watchdog；
- 装配 Kernel runtime；
- 默认立即 `spawnBatch()`；
- 启动 TaskResolver、claim reaper 和可选 autoscaler。

直接复制容器会形成双消费者，而不是主备。候选 B 在验证阶段应至少关闭：

| 能力 | A active | B standby |
|---|---:|---:|
| 进程存活、版本与构建信息 | 开 | 开 |
| PostgreSQL/Redis/sandbox 连通性检查 | 开 | 开 |
| 接收用户业务流量 | 开 | 关 |
| 恢复并占有会话 | 开 | 关 |
| 创建系统会话 | 开 | 关 |
| 领取任务 / BullMQ 消费 | 开 | 关 |
| 默认 batch / autoscaler / claim reaper | 开 | 关 |

### 5.3 建议切换顺序

```text
A active
  → 构建候选 B
  → B standby 启动
  → 深健康检查和冒烟验证
  → A 停止接收新请求与新任务
  → A 完成、超时转移或 checkpoint 执行中工作
  → B 获得唯一 active lease / epoch
  → B 恢复会话并启动执行面
  → 新流量切到 B
  → 观察窗口
      ├─ 正常：停止 A
      └─ 异常：停止 B 执行面，重新激活并切回 A
```

代理切流只能控制新 HTTP 请求，不能阻止旧核心继续从 PostgreSQL/BullMQ 取任务，因此 active lease/fencing 是执行正确性的必要条件，而不只是高可用增强项。

### 5.4 当前 A/B 缺口

1. **无 standby 启动模式。** 当前装配默认启动消费者、恢复会话和 batch。
2. **无唯一 active fencing。** 两个核心可同时领取任务并维护同一外置状态。
3. **drain 语义不够。** 当前 `AgentEngine.drain()` 会 abort busy 会话再 checkpoint，属于停机清理；还没有“停止接单、允许执行中工作完成”的完整状态机。
4. **健康检查过浅。** `/health` 存活不代表 Redis、PostgreSQL、sandbox、默认 batch、版本和迁移兼容均可用。
5. **Schema 重叠兼容未形成发布约束。** A 与 B 重叠时，N 和 N+1 必须共享可兼容 Schema；破坏性迁移不能在候选启动时直接实施。
6. **长连接需要单独排空。** SSE/WebSocket 已建立连接会继续停留在 A，入口切换只影响新连接。
7. **回滚镜像必须保留明确 digest。** 只覆盖 `latest` 而不保留旧版本标识，不能构成可靠回滚。

## 6. 可选更新模式比较

| 模式 | 中断 | 运行资源 | 实施复杂度 | 回滚 | 适用范围 | 结论 |
|---|---|---:|---:|---:|---|---|
| 在线预构建 + 单实例替换 | 数秒至十几秒，取决于恢复 | 低 | 低 | 快，需保留旧 digest | 当前全部核心更新 | **近期首选** |
| 轻量容器 A/B | 接近零；长连接仍需排空 | 中低 | 中高 | 快 | 对中断敏感的完整核心更新 | **第二阶段** |
| 完整双活 A/B | 可近零 | 高 | 高 | 复杂 | 需要双活路由和状态所有权的场景 | 当前不建议 |
| Kernel batch 代际滚动 | 任务边界近零 | 低 | 中高 | 快 | 主要修改 Kernel 执行代码 | **长期优先方向** |
| 版本化代码卷 + 进程重启 | 很短 | 低 | 中 | 快 | 受控单机、依赖变化少 | 可选，但弱化不可变镜像 |
| 开发容器源码挂载 + `tsx watch` | 开发会话自动重启 | 低 | 低 | Git 回退 | 开发调试 | **仅开发** |
| 宿主核心 + 容器依赖 | 开发会话自动重启 | 低 | 中 | Git 回退 | 深度调试/性能分析 | 可选开发模式 |
| 进程内 HMR | 理论上无 | 最低 | 极高 | 不可靠 | 纯函数或无状态插件 | **不用于 Kernel 核心** |
| K8s RollingUpdate | 取决于副本与探针 | 与 A/B 类似 | 高 | 平台提供 | 已采用 K8s 的部署目标 | 不解决构建慢本身 |

### 6.1 在线预构建 + 单实例替换

它解决的是“串行重建期间服务不可用”，而不是消灭构建时间：

```text
A 继续运行
  → 后台构建 candidate
  → candidate 离线/旁路验证
  → A 排空并 checkpoint
  → 仅替换 pi-platform 核心容器
  → 新核心 recoverAll、装配 batch、通过 readiness
```

PostgreSQL、Redis 和 sandbox 无需随核心重建。只要不先执行全栈 `down`，构建时间可以从服务中断窗口移出。

### 6.2 Kernel batch 代际滚动

该模式最符合“主要变更位于 Kernel”的维护现实：

```text
PTH 主进程保持运行
  ├─ batch A：旧 Kernel，只完成已领取任务
  └─ batch B：新 Kernel，只领取切换后的新任务
```

旧 batch 清空后退出。它避免重启 Gateway、SessionPool、主数据库连接和主进程，更新期实测外推只需额外约一份 batch 的 100–130 MiB。

该方向不能直接由现有 `worker add/remove` 等价替代，因为现有 worker 仍加载同一 batch 进程内的同一代码版本。要成立，至少需要版本化执行构件、停止认领语义、任务代际绑定、候选验证和失败回退。

### 6.3 版本化代码卷 + 进程重启

稳定 Node 运行时镜像可挂载版本化构件目录，例如 `/releases/A`、`/releases/B`，以原子指针选择当前版本并重启进程。更新包可以接近 `dist + src` 大小，适合单机快速更新。

代价是：运行镜像不再完整表达当前代码版本；依赖、构件、指针、签名和半写入需要单独治理。它可以作为受控单机方案，但不应与现有“不可变镜像为发布单元”混为一谈。

## 7. 镜像构建与磁盘瓶颈

### 7.1 当前镜像层实测

当前 `pi-platform-pi-platform:latest` 逻辑大小约 1.28 GB。`docker history` 中主要层为：

| 层 | 约大小 | 更新影响 |
|---|---:|---|
| `npm ci --omit=dev` | 408 MB | package/workspace 层失效时重新产生 |
| `mkdir ... && chown -R node:node /data /app` | 374 MB | 位于源码复制之后，源码变化也可能重新产生 |
| Node 运行时安装 | 149 MB | 基础镜像共享 |
| Debian 基础层 | 108 MB | 基础镜像共享 |
| `curl` 等系统依赖 | 18 MB | Dockerfile 前段稳定时共享 |
| `packages/` | 3.64 MB | workspace 源码变化会使后续依赖层失效 |
| `dist/` | 2.08 MB | Kernel 代码更新会变化 |
| `src/` | 0.909 MB | Kernel 代码更新会变化 |

镜像版本会共享未变化的基础层，因此 A/B 不等于磁盘固定增加 1.28 GB。但按当前顺序估算：

- 仅修改 `src/pth/kernel`：候选最终镜像仍可能新增约 377 MB，主要来自递归 chown 层；
- 修改 workspace package：可能同时新增约 408 MB 生产依赖层和 374 MB chown 层，增量接近 790 MB；
- builder 中间层与 BuildKit cache 还会产生额外磁盘占用，未计入上述最终镜像增量。

这些是基于当前层大小和失效关系的维护估算，不是每次构建的固定值。

### 7.2 优先优化项

1. **消除递归 chown 大层。** 使用 `COPY --chown=node:node`，或在创建目录时直接指定属主；避免在所有依赖、源码和构件复制完成后 `chown -R /app`。
2. **依赖清单与 workspace 源码分层。** 先复制根和各 workspace 的 package manifest，执行 `npm ci`，再复制实际源码；普通源码变化不应使依赖层失效。
3. **复用 BuildKit npm cache。** 降低重复下载和解包成本，但 cache 不进入最终镜像事实源。
4. **构建与切换分离。** 候选镜像使用明确版本 tag/digest；构建完成并验证后再重建核心服务。
5. **只重建受影响服务。** Kernel 变化不应重建 PostgreSQL、Redis、sandbox；sandbox 代码未变化时保留现有实例。
6. **记录构建指标。** 至少记录冷/热构建耗时、峰值内存、唯一新增层大小、启动到 readiness 时间和恢复时间。

## 8. 推荐演进顺序

### P0：先缩短中断窗口和构建耗时

- 保持 A 在线完成候选构建；不在构建前停止整套 Compose。
- 核心、sandbox、数据服务分开决定是否重建。
- 为旧镜像和 candidate 保留明确 tag/digest，确保能真正回滚。
- 调整 Dockerfile 所有权与依赖分层，优先消除 374 MB chown 层和无谓 `npm ci` 失效。
- 记录“构建完成 → 旧核心停止 → 新核心 readiness”的分段耗时。

该阶段不需要 A/B 状态机，就能把完整构建时间移出用户中断窗口。

### P1：建立可靠的单实例替换语义

- 把“停止接收新工作”和“中止所有 busy 会话”分开。
- 定义执行中任务的完成、超时、checkpoint 和 stale claim 恢复规则。
- readiness 覆盖 Redis、PostgreSQL、sandbox、Kernel 装配和版本信息。
- 发布迁移遵守 N/N+1 重叠兼容和 expand/contract 约束。
- 对 SSE/WebSocket 设定最大排空窗口。

### P2：按中断目标选择轻量 A/B

只有当 P0/P1 后的实测中断仍不可接受，再增加：

- standby 启动模式；
- 唯一 active lease / epoch；
- 固定入口代理；
- 切流、观察、自动或人工回滚状态机；
- 更新期间独立的资源预算。

候选阶段不启动 batch，可把常驻增量控制在约 105–140 MiB 的当前外推范围。

### P3：Kernel 稳定后演进 batch 代际滚动

- 将可滚动更新范围限制在 Kernel batch 执行实现；
- 新任务绑定新代际，旧任务留在旧代际完成；
- 代际生命周期由主进程管理，保留快速回退；
- 主进程、Gateway、会话和数据连接不随纯 Kernel 更新重启。

这是长期收益最高的方向，但不应抢在排空、fencing、恢复和发布指标之前实现。

## 9. 明确不建议的方向

- 不因开发热修改需求取消生产容器边界。
- 不把 `tsx watch` 描述成无状态损失的进程内热更新。
- 不让运行中的核心直接修改、编译和替换自己的生产运行目录。
- 不让 A、B 同时恢复同一批会话或无 fencing 地消费同一任务池。
- 不用 K8s 掩盖镜像构建慢；K8s 可自动化滚动发布，但不会降低 `npm ci`、TypeScript 编译或镜像层体积。
- 不把 `/health` 返回成功等同于候选版本已可安全接管。
- 不在 A/B 重叠窗口执行会让旧版本无法运行的破坏性数据库迁移。

## 10. 后续验证清单

在写实施 SPEC 前，建议先收集以下事实：

- [ ] 连续 10 次热缓存核心镜像构建耗时及 P50/P95；
- [ ] 一次冷缓存构建耗时、峰值 CPU/内存和磁盘增量；
- [ ] 仅改 `src/pth/kernel` 时实际失效的镜像层；
- [ ] 核心停止到新核心 `/health`、深 readiness、默认 batch ready 的分段耗时；
- [ ] `recoverAll()` 在 0、1、5、20 个会话下的恢复耗时；
- [ ] busy 会话被当前 drain abort 后的用户可见行为；
- [ ] 执行中 Kernel task 在优雅退出和强制退出下的恢复行为；
- [ ] SSE/WebSocket 最大自然结束时间；
- [ ] 轻量 standby 不产生会话、任务、reaper、autoscaler 副作用的负向测试；
- [ ] A/B 切换和回滚时任意时刻只有一个 active 执行者的证据。

## 11. 与既有文档的关系

- [PTH Batch 架构演进与性能优化](./2026-08-09-pth-batch-architecture-discussion.md)：提供当前单大 batch、worker 控制和资源优化背景。
- [PTH Kernel 设计综合总览](../specs/2026-08-09-pth-kernel-design-synthesis.md)：提供 Kernel 术语、分层和实施状态的维护入口。
- [容器化架构设计](../specs/2026-08-05-containerization-architecture-design.md)：明确容器语义、自修改构件化和 `.rebuild-request` 的废弃背景。
- [容器化实施计划](../plans/2026-08-05-containerization.md)：记录 `supervisor.sh` 移除、恢复和 sandbox 相关实施任务。
- `Dockerfile`：当前镜像构建层与运行入口事实源。
- `pth.deployment.json`：当前服务拓扑、卷、环境变量和资源限制事实源。
- `src/pth/main.ts`：主进程启动、恢复、消费者、Kernel 装配和停机顺序事实源。
- `src/pth/kernel/assembly.ts`：默认 batch、resolver、reaper、autoscaler 和子进程入口事实源。
- `src/pth/core/agent-engine.ts`：当前会话恢复、checkpoint 和 drain 语义事实源。

