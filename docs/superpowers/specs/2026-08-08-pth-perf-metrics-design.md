# PTH 性能计量设计草案（Kernel/REPL 层可观测性）

> 状态：DRAFT v0.2 —— 待评审（v0.2：分层指标 + ResourceProvider 跨 OS 抽象）
> 日期：2026-08-08
> 背景：工具链已具备多语言持久 REPL + refine 管线 + 任务链。性能计量是"仪表盘"——现有 prom-client 只覆盖会话层（prompt/token/tool），kernel/REPL/任务层零计量。本草案补齐。

## 0. 分层指标总览（自上而下）

| 层 | 关注 | 指标数 |
|---|---|---|
| **L3 业务产出** | refine 产出/记忆增长/召回命中 | ~6 |
| **L2 任务层** | 任务生命周期/状态流转/积压 | ~6 |
| **L1 Kernel/REPL** | 执行延迟/成功率/队列/进程 | ~8 |
| **L0 基础设施** | 运行时间/CPU/内存/GPU/网络/LLM token | ~14 |

**本草案 v0.2 聚焦 L0**（最底层），上层设计见 §3+。

## 0.1 跨 OS 抽象：ResourceProvider 接口（已裁决）

不同 OS 的具体实现不同（macOS 无 nvidia-smi、Linux 有 /proc、容器有 docker stats）——
**先定义接口，实现按环境选择**。

```ts
// src/pth/observability/resource-provider.ts
/** 跨 OS 资源计量抽象——实现按环境注册（darwin/linux/container/nvidia） */
export interface ResourceSnapshot {
  cpu: { usagePercent: number; userSeconds: number; systemSeconds: number };
  memory: { rssBytes: number; heapUsed: number; heapTotal: number; external: number };
  gpu: { available: boolean; utilizationPercent?: number; memoryBytes?: number };  // N/A = available:false
  network: Array<{ connType: "pg" | "redis" | "llm" | "other"; rxBytes: number; txBytes: number; active: number }>;
}

export interface ResourceProvider {
  readonly platform: string;   // "darwin" | "linux" | "linux-container" | ...
  collect(): Promise<ResourceSnapshot>;
  /** 周期采样（默认 5s）——prom-client 只消费接口返回 */
  start(intervalMs?: number): void;
  stop(): void;
}

/** 按环境创建 provider（env 可覆盖） */
export function createResourceProvider(opts?: {
  platform?: string;        // 强制指定（测试）
  container?: boolean;      // docker stats 模式
  nvidia?: boolean;         // nvidia-smi 模式
}): ResourceProvider;
```

**实现矩阵**：

| 能力 | darwin（macOS） | linux | linux-container | nvidia |
|---|---|---|---|---|
| CPU% | `ps` 差值 / os.cpus 差值 | /proc/stat 差值 | docker stats | 同 linux |
| 内存 RSS | process.memoryUsage | 同左 | 同左 + cgroup | 同左 |
| GPU | **N/A**（无 Node API） | N/A | N/A | **nvidia-smi** 解析 |
| 网络 | 按连接（pg/redis/llm 包装） | 同左 | docker stats + 连接 | 同左 |

**prom-client 消费**：metrics 层调 `provider.collect()` → 更新 Gauge（进程级指标内嵌 + 系统级走 provider）。

## 1. 现状与缺口

### 1.1 已有（会话层，prom-client）

| 指标 | 类型 | 覆盖 |
|---|---|---|
| pi_sessions_active | Gauge | 会话数 |
| pi_prompt_duration_seconds | Histogram | prompt 延迟 |
| pi_tokens_total | Counter | token 用量 |
| pi_tool_calls_total | Counter | 工具调用 |
| pi_workflow_steps_total | Counter | 工作流步骤 |
| pi_redis_used_memory_bytes | Gauge | Redis 内存 |
| /metrics 端点 | — | Prometheus 格式 |

### 1.2 缺口（kernel/REPL/任务层）

**完全无计量**：
- kernel 执行延迟（py/bash/ts 单次——实测 py 0.12ms/bash 0.04ms/ts 0.08ms vs 旧 spawn 12ms）
- kernel 进程数/内存（常驻进程池的资源）
- 任务生命周期（发布→认领→执行→refine→完成 各阶段耗时）
- refine 管线（LLM 调用耗时/提炼数量/降级率）
- 记忆区增长（条目数/命中率）
- 队列深度（kernel 并发竞争）
- 任务链（下游生成数/链深度）

## 2. 设计目标

1. **统一 prom-client**（沿用现有 Registry——/metrics 单端点聚合）
2. **分层计量**：kernel 层 / 任务层 / refine 层 / 存储层
3. **Histogram 优先**（延迟分布比均值有用——P95 是 LLM 场景关键）
4. **label 维度**：language（py/bash/ts）、role（7 角色）、kind（任务类型）、status
5. **零侵入**：计量点在既有组件内嵌（不重构），prom-client 已在依赖

## 3. 指标清单（分层）

### L0 基础设施资源层（已裁决——本草案重点）

#### ① 运行时间（3 项）

| 指标 | 类型 | 数据源 | 回答 |
|---|---|---|---|
| `pth_runtime_uptime_seconds` | Gauge | `process.uptime()` | 进程活了多久 |
| `pth_runtime_eventloop_lag_seconds` | Gauge | `monitorEventLoopDelay()` | 事件循环卡顿（Node 单线程健康） |
| `pth_runtime_handles_active` | Gauge | `process._getActiveHandles()` | 句柄数（连接/定时器泄漏） |

#### ② CPU/内存/GPU（6 项）

| 指标 | 类型 | 数据源 | 回答 |
|---|---|---|---|
| `pth_cpu_usage_percent` | Gauge | ResourceProvider（ps 差值 / /proc 差值 / docker stats） | 实时 CPU% |
| `pth_cpu_user_seconds_total` | Counter | collectDefaultMetrics（已有） | 累计 CPU |
| `pth_memory_rss_bytes` | Gauge | `memoryUsage().rss` | 常驻内存 |
| `pth_memory_heap_bytes` (label: used/total) | Gauge | `memoryUsage().heapUsed/Total` | 堆内存（泄漏检测） |
| `pth_memory_external_bytes` | Gauge | `memoryUsage().external` | Buffer/字符串外部内存（kernel 子进程场景） |
| `pth_gpu_*` (label: util/mem) | Gauge | ResourceProvider（darwin N/A / nvidia-smi） | GPU 利用率/显存（v1 N/A 标注） |

#### ③ 网络吞吐（3 项）——按连接类型分 label（已裁决）

| 指标 | 类型 | 数据源 | 回答 |
|---|---|---|---|
| `pth_network_rx_bytes_total` (label: connType) | Counter | pg_stat_activity / redis INFO clients / fetch 包装 | 各连接接收 |
| `pth_network_tx_bytes_total` (label: connType) | Counter | 同上 | 各连接发送 |
| `pth_network_connections_active` (label: connType) | Gauge | pg 连接数 / redis clients / LLM 并发 | 连接健康 |

**connType**: `pg` | `redis` | `llm` | `other`——能定位瓶颈是 DB 还是 LLM 出网。

#### ④ LLM token 消耗（3 项）——llm-fn 唯一入口包装

| 指标 | 类型 | 数据源 | 回答 |
|---|---|---|---|
| `pth_llm_tokens_total` (label: type=input/output) | Counter | llm-fn.complete 返回 usage | 累计 token |
| `pth_llm_calls_total` (label: provider, model) | Counter | 同上 | 调用次数 |
| `pth_llm_latency_seconds` | Histogram | 同上（计时） | LLM 调用 P95 |

**采集点**：`createLlmFn` 是唯一 LLM 入口（任务代码 llm.complete + refine 都走它）——包装一次全覆盖。

### L1 Kernel/REPL 层（8 项）——"执行引擎健康吗"（已裁决：全要）

| # | 指标 | 类型 | label | 回答的问题 | 采集点 |
|---|---|---|---|---|---|
| 1 | `pth_kernel_exec_duration_seconds` | Histogram | language | 单次 REPL 执行多快？P95 漂移？ | KernelManager.execute 包装 |
| 2 | `pth_kernel_exec_total` | Counter | language, ok | 成功率 | 同 1 |
| 3 | `pth_kernel_truncated_total` | Counter | language, field | Observation 截断频率 | 同 1（truncated 标记时） |
| 4 | `pth_kernel_processes` | Gauge | language | 常驻进程数？泄漏？ | PyKernel/BashKernel 构造/销毁 |
| 5 | `pth_kernel_queue_depth` | Gauge | language | 请求排队深度？并发竞争？ | kernel 内部 pending.length |
| 6 | `pth_kernel_timeout_kill_total` | Counter | language | 死循环/卡死频率？ | 超时 kill 路径 |
| 7 | `pth_kernel_restart_total` | Counter | language | 重启频率？ | kill 后 spawn |
| 8 | `pth_kernel_snapshot_duration_seconds` | Histogram | language | refine 快照采集耗时？ | snapshot() 包装 |

**叙事**：执行慢(P95↑) → 队列深度（排队？）vs 进程数（少 worker？）vs 超时 kill（卡死？）——三选一定位。

### L2 任务层（7 项）——"流水线通不通"（已裁决：全要）

| # | 指标 | 类型 | label | 回答的问题 | 采集点 |
|---|---|---|---|---|---|
| 9 | `pth_task_cycle_duration_seconds` | Histogram | — | 发布→completed 全周期？端到端 SLA | **created_at 差值**（已裁决——查库即可，无额外埋点） |
| 10 | `pth_task_stage_duration_seconds` | Histogram | stage | 瓶颈在哪段？claim/execute/submit/refine | TaskLoop.execute 各步打点 |
| 11 | `pth_task_status_total` | Counter | status | completed/rejected/escalated 分布？ | task-store submit/reject/escalate |
| 12 | `pth_task_claim_retry_total` | Counter | — | 认领重试（claims_count>1）？空转？ | claimTopN 竞态 |
| 13 | `pth_task_pending` | Gauge | — | 积压数？ | 周期 SQL（/kernel/status 复用） |
| 14 | `pth_batch_count` | Gauge | — | 运行中 batch 数？扩缩容依据 | BatchManager.listBatches |
| 15 | `pth_task_rejected_reason_total` | Counter | reason | 拒绝原因分布？ | **前缀分类归一**（已裁决：execution-failed/execution-crashed/assessed-unfit/timeout/other） |

**叙事**：rejected 率高 → reason 分布（代码坏 vs 超时 vs 分选误判）；周期长 → stage 分布。

### L3 业务产出层（6 项）——"体系在积累吗"（已裁决：全要）

| # | 指标 | 类型 | label | 回答的问题 | 采集点 |
|---|---|---|---|---|---|
| 16 | `pth_refine_duration_seconds` | Histogram | — | refine LLM 调用耗时？ | Refiner.refine |
| 17 | `pth_refine_yield` | Histogram | kind | 每任务提炼多少函数/洞察？提炼量=0 → 质量报警 | Refiner 完成时 |
| 18 | `pth_refine_degraded_total` | Counter | reason | 降级频率（LLM 失败/解析失败）？ | Refiner catch/降级路径 |
| 19 | `pth_memory_entries` | Gauge | kind | 记忆区增长（tool-function/insight）？ | 周期 SQL |
| 20 | `pth_memory_retrieve_total` | Counter | hit | 召回命中率？（recall 有效性） | state.recall 包装 |
| 21 | `pth_chain_generated_total` | Counter | — | 任务链下游生成数？ | **占位定义**（已裁决：TaskResolver 落地后填值，面板先建图） |

**叙事**：提炼量 0 → 降级率（模型问题？）vs 快照空（autoExport 失效？）；召回 miss 高 → 记忆增长（没沉淀 vs 锚点不匹配）。

#### L0 采集架构

```
进程级（内嵌，prom-client）：runtime/eventloop/memory/cpu/llm token
系统级（ResourceProvider 抽象）：GPU（按环境）/ 系统 CPU / 容器网络
连接级（周期采样）：pg/redis/llm 连接数 + 吞吐
```

**采样策略**：Counter/Histogram 事件驱动（零开销）；Gauge 周期 5s。

### 3.1 Kernel 层（kernel-metrics.ts 新）

```ts
// 执行延迟（Histogram，label: language）——REPL 性能核心
pth_kernel_exec_duration_seconds   // buckets: [0.0001, 0.001, 0.01, 0.1, 1, 5, 30]
// 执行次数（Counter，label: language, ok）——成功率
pth_kernel_exec_total
// 截断次数（Counter，label: language, field）——Observation 有界性
pth_kernel_truncated_total
// 常驻进程数（Gauge，label: language）——资源
pth_kernel_processes
// 队列深度（Gauge，label: language）——并发竞争
pth_kernel_queue_depth
// 超时 kill 次数（Counter，label: language）——僵尸防护
pth_kernel_timeout_kill_total
// 重启次数（Counter，label: language）——稳定性
pth_kernel_restart_total
```

**采集点**：KernelManager.execute 包裹（统一入口！）——延迟/成功/截断一次计量；PyKernel/BashKernel 构造/超时/kill 处计量进程数与重启。

### 3.2 任务层（task-metrics.ts 新）

```ts
// 任务生命周期阶段延迟（Histogram，label: stage）——瓶颈定位
pth_task_stage_duration_seconds    // stages: publish/claim/execute/submit/archive/refine
// 任务状态流转（Counter，label: status）——completed/rejected/escalated
pth_task_status_total
// 认领重试次数（Counter）——空转/竞争
pth_task_claim_retry_total
// 队列积压（Gauge）——pending 数量（/kernel/status 已有数据）
pth_task_pending
```

**采集点**：TaskLoop.execute（各阶段打点）+ task-store（status 变更）——**task-store 内嵌最小**（publish/claim/submit/reject 各 +1）。

### 3.3 Refine 层（refine-metrics.ts）

```ts
// refine 耗时（Histogram）
pth_refine_duration_seconds
// 提炼数量（Histogram，label: kind）——functions/insights
pth_refine_yield
// 降级率（Counter，label: reason）——LLM 失败/解析失败
pth_refine_degraded_total
// LLM token 用量（Counter，label: type）——成本
pth_refine_tokens_total
```

**采集点**：Refiner.refine 内嵌。

### 3.4 存储层（storage-metrics.ts）

```ts
// 记忆条目数（Gauge，label: kind）——增长
pth_memory_entries
// 记忆检索命中（Counter，label: hit）——hit/miss
pth_memory_retrieve_total
// 任务表积压（Gauge）——队列健康
pth_tasks_pending
```

**采集点**：memory-store 的 write/retrieve 内嵌（最少侵入）+ 周期性 SQL 统计（/kernel/status 已有逻辑复用）。

## 4. 聚合与暴露

```
全部注册到现有 registry → /metrics 单端点（Prometheus 格式）
可选：/api/v1/kernel/metrics（JSON 摘要——监控面板铺垫，与 /kernel/status 同族）
```

**监控面板消费**（铺垫）：P95 延迟 / 成功率 / 队列深度 / refine 成本——dashboard 数据源。

## 5. 与既有 /kernel/status 的关系

```
/kernel/status（运行状态全景——已实现）：瞬时快照（batches/tasks/watchdog）
/metrics（本草案）：时序聚合（延迟分布/计数/趋势）
互补：status 看"现在"，metrics 看"趋势"
```

## 6. 测试策略

| 层 | 覆盖 |
|---|---|
| 单测 | 各 metric 注册/标签正确；KernelManager 包裹计量（mock registry 断言） |
| 集成 | 真实执行 N 次 → histogram 计数正确；任务全链路打点齐全 |
| 端到端 | /metrics 端点含全部 pth_* 指标（curl 验证） |

## 7. 实施路线

**L0 基础设施（已详设）**
- **L0-T1**：ResourceProvider 抽象（接口 + createResourceProvider 环境选择 + darwin 实现 + 测试）
- **L0-T2**：运行时/CPU/内存 Gauge（uptime/eventloop/memory 内嵌 + provider CPU）+ 周期采样
- **L0-T3**：llm-fn 包装（token/calls/latency 计量——唯一 LLM 入口）
- **L0-T4**：网络连接计量（pg/redis/llm 连接数 + 吞吐 label）+ GPU 占位（N/A）

**L1 kernel（已详设）**
- **L1-T1**：KernelManager.execute 包装（#1-3 延迟/成功/截断）+ 进程/队列/超时/重启（#4-7）+ snapshot 耗时（#8）

**L2 任务（已详设）**
- **L2-T1**：TaskLoop 阶段打点（#9-10：created_at 差值 + stage）+ task-store 状态/原因（#11/15：前缀分类归一）+ 认领重试（#12）+ 周期 Gauge（#13-14）

**L3 产出（已详设）**
- **L3-T1**：Refiner 计量（#16-18）+ 记忆增长/召回命中（#19-20）+ 链占位（#21）

**T-fin**：/kernel/metrics JSON 摘要 + 端到端验证（curl /metrics 全指标）

## 8. 开放问题

1. **Histogram buckets**：kernel 延迟跨度大（0.1ms-30s）——分层 buckets？（kernel 细 [0.001,0.01,0.1,1,5] / 任务粗 [0.5,2,5,15,60,300]）
2. **采样 vs 全量**：全量计量（prom-client 内存可控）vs 采样？
3. **label 基数**：kind 白名单防爆炸（7 角色×3 语言×5 状态可控）
4. **计量侵入度**：包装器优先（KernelManager/TaskLoop/llm-fn 都是统一入口，天然包装点）
5. **告警阈值**：v1 只计量不告警，阈值留监控面板
6. **LLM 出网字节**（L0-③）：fetch 包装计量 tx 字节——llm-fn 内部 fetch 可包，但 web.fetchText 也出网？（v1 只计 llm-fn，web 留 v2）
7. **pg/redis 连接吞吐数据源**：pg_stat_activity 无字节数——v1 只计连接数（active），字节数从 fetch 包装拿 LLM 侧；pg/redis 字节留 v2（需要 pg_stat_database 差值）

**已裁决（本轮）**：
- 任务全周期起点 = created_at（查库差值，无额外埋点）
- 拒绝原因 label = 前缀分类归一（execution-failed/execution-crashed/assessed-unfit/timeout/other）
- 任务链指标 #21 = 现在定义占位（TaskResolver 落地后填）
- L1/L2/L3 共 21 项全要（总计 35 项含 L0）
