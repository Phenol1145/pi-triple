# 开发循环①（PTH-PTL 异步委托工作流）

> 2026-08-09 · v0.8 循环①——v0.9 PTL 主会话升级（不自己开发任务、job 提交后脱手）的基础。

## 用意

v0.9 升级 PTL 的工作方式：**PTL 主会话不自己执行开发任务**（占用主会话）——一次完成 job 提交后**继续处理其他事物**。开发任务交给 PTH 异步解释执行（任务池为内部机制），PTL 侧需要时取结果。性能数据伴随采集（V8 引擎专项优化的铺垫）。

## 工作流

```
┌─ PTL 主会话（多环境共存平台）───────────────────────┐
│ ① 写计划（按行切分为任务）                          │
│ ② ptl hub job submit "<计划>" [--tasks n] [--tags] │
│    → 立即返回 jobId【脱手】——主会话继续处理其他事物  │
│ ③ 需要时：ptl hub job status <id>  进度             │
│            ptl hub job fetch <id>  产物             │
│    → fetch 顺带性能归档（.perf-bench/jobs/）         │
└─────────────────────────────────────────────────────┘
        ↓ 提交（HTTP POST /api/v1/kernel/jobs——兼容通道）
┌─ PTH（自耦自然语言解释器）──────────────────────────┐
│ 批量 publish（tasks.job_id 关联）→ 角色路由（flow/   │
│ tags/hash）→ worker 异步执行 → 结果 outputRef        │
│ 多 job 并行（每 job 独立任务集）                     │
└─────────────────────────────────────────────────────┘
```

## 命令

```
ptl hub job submit "<计划文本>" [--tasks n] [--tags a,b]   # 计划按行→任务；立即返回 jobId
ptl hub job status [jobId]                                 # 列表（聚合进度） / 单 job 任务明细
ptl hub job fetch <jobId>                                  # 产物汇总（值+exec 耗时）+ 性能归档
```

## 性能数据（V8 优化铺垫）

- `ptl hub bench`：7 类基准任务（ts/py/bash/c 编译/记忆/扩展/agent）——全执行路径基准——归档 `.perf-bench/bench-*.json` + `--compare` 跨轮 diff
- `ptl hub job fetch`：每 job 执行耗时 → `.perf-bench/jobs/<jobId>.json`
- 数据面：任务 exec 耗时（outputRef.durationMs）+ 系统快照（/kernel/status）——V8 引擎专项优化（v0.9）的实测依据

## 多 job 并行

PTL 侧可同时提交多个 job（不同计划）——每个独立 jobId——PTH 任务池并行执行——PTL 侧按需逐个 fetch（主会话零阻塞）。

## 相关

- 任务分配：正交角色谱系（docs/pth/kernel.md）——flow/tags/hash 三段路由
- 性能自愈：PerfAutopilot（循环②——参数自动优化）
- v0.9 方向：PTL 主会话升级（不自己开发任务）+ V8 引擎专项优化
