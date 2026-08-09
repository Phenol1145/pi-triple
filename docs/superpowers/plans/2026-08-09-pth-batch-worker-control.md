# PTH Batch 架构演进：单大 batch + worker 级控制面 + 资源分配策略接口

> 2026-08-09 · 目标：内存最优（node 基线不重复）+ 启停灵活性（进程内 worker 级）+ 分配算法可扩展
> 触发：用户洞察"所有 worker 放一个 batch 没有副作用"——单大 batch 省 40% 内存且池容量精确；
>       单 worker 启停（pause/resume/remove/add）成为主要扩缩容手段；batch 级 add/remove 降级为特殊手段。

## 背景与动机

- 现状：每 batch = 1 node 进程 + 7 角色 worker（PTH_WORKER_ROLES 已参数化构成）；多 batch 时 node 基线
  110MB 重复 + 池容量需求 7×batch
- 用户决策：**默认单大 batch**（全角色权重一个进程）+ **worker 级控制面**（进程内启停）+
  **BatchCompositionStrategy 接口**（未来分配算法扩展点）
- batch add/remove 保留为特殊手段（故障隔离/多租户/资源分片）

## 约束

- claim 原子性保持（SKIP LOCKED——同角色多副本安全）
- 正交化保持（assigned_role 路由不变）
- 池容量联动：PTH_KERNEL_POOL_SIZE ≥ 总 worker 数（文档提醒）
- 兼容：PTH_WORKER_ROLES 不设置 = 7×1

## 实施步骤

### P1 资源分配策略接口（worker-cluster.ts）
- `BatchProfile`（balanced{weights} | reinforced{role,copies}）
- `SchedulingContext`（pendingByRole / activeBatches / poolCapacity / limits）
- `BatchCompositionStrategy`（id + compose(ctx)）+ `COMPOSITION_STRATEGIES` 注册表
- `profileToWeights(profile)` → PTH_WORKER_ROLES env 序列化

### P2 TaskLoop 控制（task-loop.ts）
- `pause()` / `resume()`（暂停认领不终止）/ `stop()`（永久停止）
- runOnce 开头短路（stopped/paused 检查）

### P3 batch-process worker 控制面（batch-process.ts）
- 抽 `createWorker(role)`（现 map 回调——可动态复用）
- IPC 新增：`worker-pause` / `worker-resume` / `worker-remove` / `worker-add`（{role, copies}）
- worker 注册表：loops 数组可寻址 + 状态（active/paused/removed）
- remove：stop + kernel.dispose（python 进程回收）；add：动态创建并加入 tick

### P4 BatchManager 控制方法（batch-manager.ts）
- `pauseWorker(batchId, role)` / `resumeWorker` / `removeWorker` / `addWorker(batchId, role, copies)`
- IPC 转发 + batch 记录状态跟踪

### P5 默认单大 batch（assembly.ts）
- createKernelRuntime 启动即 spawnBatch（构成 = PTH_WORKER_ROLES 全量——替代手动 batch add 起步）
- autoscaler 默认 off（PTH_BATCH_AUTOSCALE 默认 off——多 batch 特殊手段显式开启）
- 注释/文档同步（autoscaler 语义变化）

### P6 API/CLI
- `POST /api/v1/kernel/batch/:id/workers` `{action, role, copies}`（pause/resume/remove/add）
- `ptl hub kernel batch worker <action> <batchId> <role> [copies]`

### P7 测试
- TaskLoop pause/stop 单测（暂停不认领/停止后 runOnce 短路）
- profileToWeights 解析单测（balanced/reinforced）
- fork 集成：worker-remove 后该角色不再认领；worker-add 后新角色开始认领
- API 测试（workers 控制端点）
- 全量回归（1149+）

### P8 文档
- deployment.md：单大 batch 默认 + worker 控制 + autoscaler off + 池容量联动 + batch 特殊手段
- kernel.md：batch 控制面小节

## 验收

- 启动自动 1 大 batch（可认领任务）——无需手动 batch add
- worker-pause 后该角色不认领（其他角色不受影响）
- worker-remove 后 python 进程释放 + 不再认领
- worker-add 后新角色开始认领
- autoscaler off 默认（PTH_BATCH_AUTOSCALE=on 显式开启才扩多 batch）
- 1149+ 全绿 + tsc 干净
