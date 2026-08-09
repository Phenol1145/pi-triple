# PTH Batch 架构演进与性能优化——近期讨论整理（2026-08-09）

> 脉络：性能优化三方面 → 任务分压验证 → batch 构成参数化 → 资源分配策略抽象 →
> 单大 batch + worker 控制面 → sandbox 资源实测 → 编译核 sandbox 集成 → 持久化与观测缺口。
> 本文件为讨论记录（决策/实测/遗留）——实施细节见对应 commit。

## 1. 性能优化（三方面 + 硬性限制）——已落地

| 方面 | 优化 | 实测 |
|------|------|------|
| 运行时间 | batch 自驱动（任务完成立即继续认领，空闲退避 timer） | 20 代码任务 avg 0.58s→0.39s（-33%）；单任务纯执行 0.01-0.1s |
| 运行时间 | resolver 空轮询退避（2s→15s）+ payload GIN 索引 | 无 flow 任务查询降频 7.5x |
| 内存 | PG 连接池 batch 10→8（PTH_PG_POOL_MAX）| - |
| 内存 | node 堆上限 NODE_OPTIONS 768M（防 OOM 主机）| - |
| CPU | 轮询全 unref（空闲 ~0%）| - |
| 硬性限制 | compose 全服务 limits（pi-platform 2cpu/2G/pids512 · sandbox 1cpu/1G/pids256 · postgres 1cpu/512M · redis 0.5cpu/256M）| 全补 |
| 硬性限制 | 任务发布体积（title ≤200/text ≤64KB——400 拒绝）| - |

## 2. 任务分压验证——正常

- 路由三段式：flow 显式 role → tags 语义匹配 → hash(taskId)%7 确定性分片
- 正交化后新任务 100% 有 assigned_role（80/80）；历史 77 个 NULL 全是旧版广播时代——已全部终结
- 角色负载差异（developer 66.7%）是语义路由的正常结果（code 类任务多）——非故障

## 3. batch 构成取消固定限制——已落地（PTH_WORKER_ROLES）

- `PTH_WORKER_ROLES="developer:3,analyst:2"` 角色:副本数；未列出默认 1；副本 0=禁用
- 约束：副本 0-8 / 总 worker ≤32
- 不设置 = 原 7×1（完全兼容）

## 4. 资源分配模式抽象——接口已落地（策略注册表可扩展）

- **BatchProfile**（balanced{weights} | reinforced{role,copies}）
- **SchedulingContext**（pendingByRole/activeBatches/poolCapacity/limits）
- **BatchCompositionStrategy** 接口 + COMPOSITION_STRATEGIES 注册表（balanced/reinforced 内置）
- reinforced 策略 v1：取积压最深角色 ×2（descheduler 思想）
- 未来新算法：实现接口 + 注册即可（调度器/批控/子进程零改动）

## 5. 单大 batch + worker 级控制面——已落地（用户关键洞察）

**洞察**：所有 worker 放一个 batch 没有副作用——node 基线 110MB 不重复 + 池容量精确（18 worker 场景省 40% 内存）。

- 默认启动即 1 个大 batch（全角色权重——assembly spawnBatch）——无需手动 batch add
- **worker 级控制**：pause/resume/remove/add（IPC 进程内启停——不影响其他 worker）
  - remove 回收 python 进程；add 动态新建（createWorker 复用）
  - tick 快照遍历防 splice 竞态
- API：`POST /batch/:id/workers {action,role,copies?}` · CLI：`ptl hub kernel batch worker`
- autoscaler 默认 off（batch 级扩缩降级特殊手段：故障隔离/多租户）
- **实测**：remove→pending / add→completed / pause 隔离其他角色（w-other-role completed）/ resume 恢复 / 启动自动拉批 ✓

## 6. Sandbox 资源实测（kernel 池开销——超预期轻）

| 核 | 空闲 | 每进程 | 全池 16 激活 | 单次执行 |
|----|------|--------|-------------|----------|
| python | 0 进程 | 10.5MB | ~246MB（24% of 1G）| 36ms |
| bash | 0 进程 | 2.7MB | +43MB | 13ms |
| 容器总空闲 | **78MB（7.6%）** | - | ~290MB（28%）| 链路 ~100ms |

- 懒 spawn 全验证：16 池条目零进程——内存自适应
- 余量巨大：32+32 池 ≈ 500MB（49%）仍安全——池容量扩展空间大
- **真正约束不是内存**：是 acquire 排队语义（池小→并发等待）和容器 CPU 配额（1 cpu）

## 7. C 编译核架构裁决 + sandbox 集成（Phase B）——已落地

**用户裁决**：ts 解释器在主容器；python/bash 在 sandbox 池；**C/Rust 等编译型只在 sandbox 编译运行**（主容器无编译器——当前 pi-platform 镜像只有 curl）。

- kernel-host `POST /kernel/compiled`（{code, cc?}——变体白名单 gcc/clang/tcc + 临时工作区 + 超时 + 事后清理）
- SandboxCompiledKernel 适配器（Interpreter 接口 HTTP 转发 + Bearer + 65s 超时 + 降级）
- kernel-manager c 路由 + 能力面 c.execute（ts 程序内调 C 核）
- **容器端到端**：ts 程序 → c.execute → HTTP → sandbox gcc 编译 → sum=5050 回传 ✓
- 容器内实测：gcc 16ms · clang 420ms · tcc 4ms（AArch64）

## 8. 编译速度与 colima——裁决：不切换

- 瓶颈层级：compose cpus 配额（1.0 单核）> 编译器选择 > 无缓存 > VM 层
- colima 提升 VM 层（可配 CPU/内存）——但容器级 cpus 配额不变——对编译速度提升有限
- **用户裁决：下版本（v0.7 容器抽象）统一做**——当前不切换运行时

## 9. 编译核持久化数据——方案已定（未实施）

现状：每次调用临时工作区全删——零跨调用持久化（每次冷编译）。

- ① 编译产物持久缓存：/data/compiled-cache 卷（独立于 workspaces——隔离安全）+ CCompiledKernel cacheDir 参数化 + LRU + 磁盘上限 200MB → 同代码 16ms→~1ms
- ② 源码代码库 v1：复用 toolstore 文件通道（fs.writeText/readText）+ refine 沉淀
- ③ 重计算单元（SPEC v2）：命名编译单元 + pg compiled_store + 增量重算——v0.7

## 10. 监视组件覆盖缺口——确认缺失（未补）

| 缺口 | 补全方案 |
|------|----------|
| c 执行不计量（case "c" 未过 metered）| ① 包 onKernelMetric 包装——一行改动进 /metrics |
| 编译核专属指标（耗时/缓存命中/变体）| ② CCompiledKernel onMetric 回调 + /kernel/status 聚合（obs.kernels 可查）|
| debug 指标（attach/断点/step）| ③ DebugSession 可选 onEvent 接口（预留——接线时生效）|

## 遗留 / backlog

- [ ] 编译核持久缓存（§9①）——本轮提议未实施
- [ ] 监视组件补全（§10 ①②③）
- [ ] 生产容器重建（新镜像含 /kernel/compiled——c.execute 生产可用 + 池容量/配额调整）——需维护窗口
- [ ] 分配策略自动调度（per-role 积压 → reinforced 自动选择——descheduler 完整化）
- [ ] batch add 支持 profile（--role 强化模式 API 面）
- [ ] 重计算单元（SPEC v2）+ 调试协议 Phase 2（sandbox debug 端点）
- [ ] colima/容器运行时抽象（v0.7——与容器后端接口统一做）

## 关键 commit 索引

```
352bd91  性能优化 + 硬性限制
5174a1e  resolver 退避 + GIN 索引 + 发布体积限制
f8479b9  PTH_WORKER_ROLES 构成参数化
c5094f5  单大 batch + worker 控制面 + 策略接口
2e44ace  编译核 sandbox 集成（Phase B）
```
