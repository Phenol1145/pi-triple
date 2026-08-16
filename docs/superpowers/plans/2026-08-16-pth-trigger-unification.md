# PTH Trigger 统一化（全部流程收编为 trigger 调度指令）可执行计划

> **计划状态：可执行（2026-08-16 建立）**
>
> **用户裁决（2026-08-16，两条选择题）**：
> 1. 动作形态 = **原生 action 与任务 action 并存**——确定性控制环走原生 handler，治理类继续发布任务；
> 2. 事件桥 = **扩展现有 IPC + ActivityHub**——零新依赖，不引入 PG LISTEN/NOTIFY、不引入 Redis pub/sub。

## 目标

把当前散落在主进程与 batch 子进程里的**硬编码循环**全部收编为 `TriggerEngine` 的 **trigger 调度指令**（memory `kind='trigger'` 或代码内置 system trigger），使：

> 传统 workflow（事件链）与 loop（周期自触发）同构为一条 trigger 指令：
> `{event|schedule} + match → {task 发布 | 原生 action}`。

收编完成后，业务层不再有 `setInterval` 控制环；代码里只保留 **trigger 引擎底座**（一个 2s 调度心跳 + 30s 定义热重载）与**非控制环基础设施**（metrics 采样、任务 deadline、batch 认领心跳）。

## 现状盘点与目标映射

| 现状循环 | 位置 | 触发源 | 收编目标 |
|---|---|---|---|
| Origin 升级链（retask 链） | TriggerEngine system trigger | event `task.rejected` | ✅ 已收编（保留） |
| memory 巡检（B1/N7） | TriggerEngine system trigger | schedule 86400s | ✅ 已收编（保留） |
| optimizer `checkDeopt` 巡检 | batch 子进程 Optimizer 构造器内 30s `setInterval`（每角色一份） | schedule | `optimizer.deopt-sweep` 原生 action：主进程 schedule → IPC 下行 → 每 batch 只跑一次 sweep |
| PerfAutopilot R1–R4 | main.ts 30s `setInterval` | schedule | `perf-autopilot.tick` 原生 action（`PTH_AUTOPILOT_MODE=on` 才注册） |
| batch-scaler | assembly.ts 30s `setInterval` | schedule | `batch.scale` 原生 action（`PTH_BATCH_AUTOSCALE=on` 才注册） |
| claim reaper | assembly.ts 30s `setInterval` | schedule | `claim.reap` 原生 action |
| KernelWatchdog probe | assembly.ts 30s `setInterval` | schedule | `watchdog.probe` 原生 action |
| TaskResolver resolveLoop | assembly.ts 自适应 `setTimeout` 链 2s→15s | schedule | `resolver.resolve` 原生 action + handler 动态 `nextMs`（保留退避语义） |
| trigger 定义热重载 | TriggerEngine 30s `setInterval` | 引擎底座 | 保留（本计划不做 PG NOTIFY） |
| metrics 采样 | prom-client 5s | 采样器 | 保留（非控制环） |
| batch 认领心跳 tick | batch-process 1s `setInterval`（忙时自驱动） | 引擎底座 | 保留（执行器底座，非业务 loop） |
| 各任务 LLM/verify deadline | setTimeout | deadline | 保留（定时炸弹，非循环） |

## 设计定稿

### 1. TriggerDef v2（`trigger-engine.ts`）

```ts
interface TriggerDef {
  name: string;
  event?: string;                 // 事件触发（ActivityHub kind）
  schedule?: { everySec: number };// 定时触发（最小间隔）
  match?: { role?: string; detailContains?: string };
  task?: { ... };                 // 任务 action（现有语义不变）
  action?: { type: string; params?: Record<string, unknown> };  // 原生 action（新增）
  enabled?: boolean;
  once?: boolean;
  maxFires?: number;
}
```

- `task` 与 `action` **至少其一**；两者可并存（先 action 后发布任务，罕见）。
- 新增 `registerAction(type, handler)` 注册表；handler 签名
  `(ctx: { trigger; vars; event?; source: "event"|"schedule" }) => void | { nextMs?: number }`。
- **动态重排**：schedule trigger 的 handler 可返回 `{ nextMs }` 覆盖下一跳间隔
  （TaskResolver 用：有产出 → 2s；空转 → 2s→5s→10s→15s 退避）。
- `once` / `maxFires` / 链深 / 自触发阻断对 action trigger 与 task trigger **语义一致**。
- 新增 `listTriggers()`：`{ id, name, source: "system"|"memory", event?, schedule?, actionType?, fireCount, lastFiredAt }[]`，供运行时观测。

### 2. 统一事件词汇（IPC + ActivityHub 事件桥）

**上行（batch 子进程 → 主进程 ActivityHub）**：

| 通道 | 事件 |
|---|---|
| 现有 `kind:"activity"`（不变） | `task.claim` / `agent.step` / `agent.tool` / `task.done` / `task.failed` |
| 新增 `kind:"kernel-event"`（EventBus 转发） | `task.execute.start` / `task.execute.end` / `task.submit` / `task.reject` / `kernel.execute.start` / `kernel.execute.end` / `worker.add` / `worker.pause` / `worker.resume` / `worker.remove` |
| 主进程 EventBus（assembly 内桥接） | `batch.spawn` / `batch.kill` |

去重规则：`task.claim`/`task.done`/`task.failed` 只走既有 activity 通道，EventBus 不再重复转发——防止同一 trigger 双触发。

**下行（主进程 → batch 子进程）**：`BatchManager.broadcast(msg)` 通用广播（对齐已有 set-param/worker-add）；新增 `optimizer-sweep` 消息。

### 3. 原生 action 目录（system triggers）

| action type | 触发 | 周期 env | 注册条件 | handler 归属 |
|---|---|---|---|---|
| `claim.reap` | schedule | `PTH_CLAIM_REAP_MS`（30s） | 恒注册 | assembly/system-triggers |
| `watchdog.probe` | schedule | `PTH_WATCHDOG_INTERVAL_MS`（30s） | 恒注册 | assembly/system-triggers |
| `resolver.resolve` | schedule | `PTH_RESOLVER_INTERVAL_MS`（2s，动态退避） | 恒注册 | assembly/system-triggers |
| `optimizer.deopt-sweep` | schedule | `PTH_VERIFY_SWEEP_MS`（30s） | `PTH_OPTIMIZER !== "off"` | assembly/system-triggers → IPC 广播 |
| `batch.scale` | schedule | `PTH_BATCH_SCALE_INTERVAL_MS`（30s） | `PTH_BATCH_AUTOSCALE === "on"` | assembly/system-triggers |
| `perf-autopilot.tick` | schedule | `PTH_AUTOPILOT_INTERVAL_MS`（30s） | `PTH_AUTOPILOT_MODE === "on"` | main.ts（依赖 prom-client registry） |

### 4. 保留的引擎底座（明确不做）

- TriggerEngine 内部 2s schedule tick + 30s memory reload（心跳与定义源同步）。
- metrics sampler 5s（采样不是控制环）。
- batch 子进程认领 tick 1s（执行器拉取心跳；忙时已自驱动）。
- 每任务 deadline（LLM timeout / verify timeout / claim timeout）。

## 执行阶段（每个子项独立提交；先失败测试后实现）

### T1：TriggerEngine 原生 action + 动态重排
- [x] T1-1 `TriggerDef.action` 类型 + 校验（task/action 至少其一；坏定义跳过）
- [x] T1-2 `registerAction` + `fireAction`（event/schedule 共用 fire 路径；错误记日志不炸引擎）
- [x] T1-3 schedule 动态 `nextMs`（handler 返回值覆盖下一跳；reload 重置）
- [x] T1-4 `listTriggers()` 观测面
- [x] T1-5 测试：action event/schedule、ctx、once/maxFires、动态重排、坏定义

### T2：统一事件桥（上行）
- [x] T2-1 batch-process 订阅 EventBus → `kind:"kernel-event"` IPC（去重白名单）
- [x] T2-2 BatchManager 转发 kernel-event → ActivityHub（字段归一 + batchPid）
- [x] T2-3 assembly 桥接主进程 EventBus `batch.spawn`/`batch.kill` → ActivityHub（shutdown 退订）
- [x] T2-4 测试：kernel-event 转发、去重、batch 事件桥

### T3：下行通道 + optimizer sweep 去重
- [x] T3-1 `BatchManager.broadcast()` + `broadcastOptimizerSweep()`
- [x] T3-2 `Optimizer.sweep()` 公开（checkDeopt 包装）；batch-process 收 `optimizer-sweep` → 每 batch 首实例跑一次
- [x] T3-3 生产路径 `verifySweepMs: 0`（关闭子进程自巡检表——由主进程 trigger 驱动）
- [x] T3-4 测试：broadcast 发送/计数、optimizer-sweep 消息处理、sweep 幂等

### T4：收编 claim-reaper / watchdog / resolver / scaler
- [x] T4-1 新建 `kernel/execution/system-triggers.ts`：集中构建原生 action + system trigger 注册表
- [x] T4-2 assembly 移除 claim-reaper / scaler / watchdog.start / resolver setTimeout 链四个硬定时器
- [x] T4-3 origin-escalation / memory-sweep 注册迁入 system-triggers（行为不变）
- [x] T4-4 测试：注册表覆盖断言（6 个 action 齐全）+ assembly 现有用例回归

### T5：收编 PerfAutopilot
- [x] T5-1 main.ts：`registerAction("perf-autopilot.tick")` + system trigger；删除 `autopilot.start()` 定时器
- [x] T5-2 修复 rollback 接线：`tick()` 末尾执行 `checkRollback()`（原逻辑只有测试手动调用，生产从未回滚）
- [x] T5-3 测试：trigger 驱动 tick、R2 回滚在 tick 内闭环

### T6：文档 + 全量门禁
- [x] T6-1 新建 `docs/pth/trigger-runtime.md`：trigger 运行时总览（action 目录、事件词汇、观察/CRUD 面）
- [x] T6-2 `docs/README.md` 增加 trigger-runtime 行
- [ ] T6-3 全量 `npm test` + `npm run lint` + `npm run build` + `check:pth-boundaries` 全绿
- [ ] T6-4 收账：勾平本计划 checkbox，独立提交

## 退出门禁

- 全量 vitest 绿（不引入 skip，除非既有 hostile 集成 skip）；
- `npm run lint`（含 boundary checker）与 `npm run build` 干净；
- 行为兼容：`PTH_*` 环境变量语义不变；缺省行为不变（autopilot/scaler 默认仍关；其余环周期默认与现状一致）；
- 每个子项独立提交，阶段结束独立提交。

## 明确不做（范围外）

- 不引入 PG LISTEN/NOTIFY 或 Redis pub/sub（用户裁决）；
- 不把 claim-reaper/watchdog 改造成 agent 执行任务（安全环保持确定性原生 handler）；
- 不把 batch 认领心跳 / metrics 采样 / trigger 引擎心跳收编（底座，非业务 loop）。
