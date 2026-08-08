# PTH 日志体系设计（分层 + 结构化 + 链路追踪）

> 状态：SPEC v1.0 —— 已裁决（2026-08-08）
>
> **整理说明（2026-08-09）**
>
> 文档性质：已裁决的日志设计。
>
> 实施映射：KernelLogger、组件 child logger、batch IPC 转发和 Kernel stderr 接线已存在；本文仍保留实施时的原始路线描述。
>
> 阅读关系：日志负责事件叙事，性能计量 SPEC 负责时序聚合。参见[Kernel 设计综合总览](./2026-08-09-pth-kernel-design-synthesis.md)。
> 背景：体系复杂度提升（PTH 主进程/batch 子进程/kernel 子进程/TaskResolver/Refiner/PTL），
> 当前日志非结构化混流（console.error 裸文本 + stdio inherit + kernel stderr 忽略）——排障困难。

## 1. 现状诊断

| 组件 | 现状 | 问题 |
|---|---|---|
| PTH 主进程 | pino JSON（结构化 ✅） | — |
| batch 子进程 | console.error 裸文本 + stdio inherit | 非结构化，混进主进程流 |
| TaskLoop/Resolver/Refiner | console.error 无上下文 | 无组件标记/链路 |
| PyKernel/BashKernel | stderr 忽略 | kernel 自身故障不可见 |
| agent-lab | [agent-lab] 前缀混流 | 自成一派 |

**四问题**：①非结构化混流 ②无组件标记 ③无链路追踪（taskId）④kernel 错误丢失。

## 2. 统一日志接口（kernel-logger.ts）

```ts
interface KernelLogger {
  info(component: string, msg: string, ctx?: Record<string, unknown>): void;
  warn(component: string, msg: string, ctx?: Record<string, unknown>): void;
  error(component: string, msg: string, ctx?: Record<string, unknown>): void;
  debug(component: string, msg: string, ctx?: Record<string, unknown>): void;
  child(component: string, baseCtx?: Record<string, unknown>): KernelLogger;
}

// 组件白名单（label 基数可控）
export const LOG_COMPONENTS = [
  "gateway", "engine", "kernel", "batch", "worker", "taskloop",
  "resolver", "refiner", "pykernel", "bashkernel", "tskernel",
  "toolstore", "watchdog", "chain", "recall",
] as const;

// 格式切换（已裁决：JSON 默认 + pretty 可切）
//   PTH_LOG_FORMAT=json   → pino 兼容 JSON 行（生产默认）
//   PTH_LOG_FORMAT=pretty → 人类可读彩色（开发）
// 级别：PTH_LOG_LEVEL=debug|info|warn|error（默认 info）
```

**JSON 行形态**（pino 兼容）：
```json
{ "ts": "2026-08-08T12:00:01.234Z", "level": "info",
  "component": "taskloop", "taskId": "t-123", "batchId": "b-1", "role": "developer",
  "msg": "task completed", "durationMs": 120 }
```

**pretty 形态**（控制台）：
```
[12:00:01.234] [taskloop] [t-123] ✅ task completed (120ms)
[12:00:02.000] [resolver]  [b-1]   → generated verify task (t-456)
```

## 3. 组件接入点

| 组件 | 改法 |
|---|---|
| batch 子进程 | KernelLogger（component=batch，自动带 pid）——替换 console.error |
| TaskLoop | child("taskloop", {taskId, role, batchId})——claimed/completed/rejected 生命周期 |
| TaskResolver | component=resolver（chain generated/loop/branch 决策） |
| Refiner | component=refiner（提炼量/降级原因） |
| PyKernel/BashKernel | **stderr 转发 warn**（已裁决：component=pykernel/bashkernel）——kernel 自身错误可见 |
| 主进程 | 保留 pino——kernel logger 输出格式对齐（JSON 兼容） |

## 4. 日志分级（防噪音）

```
error —— 任务 reject 原因 / resolver 异常 / kernel 崩溃 / refine 失败
warn  —— 降级（stub router / refine off）/ 超时 kill / 截断 / kernel stderr
info  —— 生命周期（task claimed/completed、batch spawn、chain generated）
debug —— 每步执行细节（kernel exec 每次调用——默认关）
```

## 5. batch 日志通道（已裁决：IPC 转发）

```
batch 子进程                    PTH 主进程
  kernelLogger.log(...)  ──IPC──▶  收日志消息 → 统一打标（component/pid/taskId）
                                       → 写入主进程日志流
```

- 子进程经 `process.send({type:"log", level, component, msg, ctx})` 发日志
- 主进程 BatchManager 收 `message.type==="log"` → 转发 logger
- 保留 stdio inherit 作为**兜底**（IPC 不可用时 console 仍可见）
- 协议扩展：batch-process 的 IPC 消息（现有 shutdown/pause/resume/status）加 log 类型

## 6. 任务 stdout 策略（已裁决：保持分离）

- 任务代码 console.log/stdout → **Observation 捕获**（进 transcripts）——系统日志严格分离
- 不镜像系统日志（防刷屏）；调试任务输出走 transcripts 查询

## 7. 与监控指标的关系（互补）

```
log    = 事件叙事（为什么/发生了什么）——排障
metrics = 趋势聚合（P95/成功率/积压）——告警
日志带 taskId/batchId/component → 监控面板"日志下钻"（metrics 发现问题 → 日志查细节）
```

## 8. 实施路线

- **T1**：kernel-logger.ts（接口 + JSON/pretty 双格式 + 级别过滤 + 组件白名单）——纯函数可测
- **T2**：各组件接入（batch/TaskLoop/Resolver/Refiner 替换 console）——链路 ctx（taskId/role）
- **T3**：batch IPC 日志转发（BatchManager 收 log 消息 → 主进程统一写入）+ 兜底
- **T4**：kernel stderr 转发 warn（PyKernel/BashKernel 错误事件 → logger）
- **T-fin**：端到端验证（发布任务 → 各组件日志带 taskId 可追踪；pretty/json 切换）

## 9. 测试策略

| 层 | 覆盖 |
|---|---|
| 单测 | logger 格式（json/pretty）、级别过滤、child 继承 ctx、组件白名单校验 |
| 组件 | TaskLoop/Resolver 日志调用（mock logger 断言 taskId 携带） |
| 集成 | batch IPC 日志（fork 子进程 → 主进程收到 log 消息） |
| 端到端 | 任务全生命周期日志链（claimed→completed→chain→refine 各组件） |
