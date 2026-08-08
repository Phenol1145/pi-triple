# PTH 环境生命周期设计（会话绑定 + kernel 状态 + 编号 + GC）SPEC v1.0

> 日期：2026-08-08 · 状态：已批准（用户裁决） · 关联：[LLM agent 执行设计](./2026-08-08-pth-llm-agent-execution-design.md) · [kernel sandbox 设计](./2026-08-08-pth-kernel-sandbox-design.md)

> **整理说明（2026-08-09）**
>
> 文档性质：已批准的目标设计。
>
> 实施映射：当前代码未观察到 Environment 注册表、`payload.route.env`、引用计数、环境快照目录或 GC 循环的主体实现。
>
> 阅读关系：本文组合此前的 agent loop、TaskResolver、REPL snapshot 与 sandbox 目标；不是当前运行链已经具备的能力。参见[Kernel 设计综合总览](./2026-08-09-pth-kernel-design-synthesis.md)。

## 1. 背景与动机

递归调用（rlm 式）需要 fresh/fork 两种模式，统一在**环境（Environment）**概念下：

```
fresh：任务路由"新建环境" → 全新上下文 + kernel 状态（现有任务池循环）
fork：任务路由"指定环境编号" → 该环境接手（上下文 + kernel 状态延续——rlm 等价）
GC：环境不可用/空闲超时 → refine 抽取价值 → 内存释放 → 环境快照写入工作空间
```

**核心设计**：会话与 REPL kernel 的临时持久化状态绑定并分配编号；任务路由可指定
"哪个上下文接手"或"启动新环境"；环境生命周期终结走 GC（价值抽取 + 快照落盘），
工作空间的 GC 一并处理。

## 2. 环境模型

### 2.1 定义

```
环境（env）= 编号 + 绑定的 kernel 临时持久化状态（会话的 RAM）
  编号：env-<uuid>（创建时分配，全局唯一）
  状态：ts vm context + PyKernel 命名空间 + BashKernel cwd/env（三 REPL 聚合）
  载体：持有该状态的 worker 实例（batch 内 kernel 三件套）——物理层
  生命周期：创建（fresh）→ 活跃/延续（fork）→ 空闲 → GC（回收）
```

### 2.2 状态机

```
┌─────────────────────────────────────────────┐
│  Environment（env-id + kernel 状态）         │
│                                             │
│  创建（fresh）──▶ 活跃（active：任务绑定）    │
│                     │                        │
│                     ├── 延续（fork：任务路由  │
│                     │    指定本编号）──▶ 活跃  │
│                     │                        │
│                     └── 空闲（idle：无任务    │
│                          引用/超时）          │
└──────────────────────┬──────────────────────┘
                       │ GC 触发：
                       │   空闲超时 / worker 崩溃 / 链终止 / 显式销毁
                       ▼
┌─────────────────────────────────────────────┐
│ GC 流程（三步）                              │
│ ① refine 抽取有价值信息 → 持久层             │
│    （tool-function 源码+spec / task-insight）│
│ ② 内存释放：kernel 状态丢弃（reset/进程回收）│
│ ③ 环境快照 → 工作空间文件                    │
│    workspace/envs/env-<id>.json             │
└──────────────────────┬──────────────────────┘
                       ▼
               workspace GC（文件级回收）
```

## 3. 任务路由扩展（分选规则的会话维度）

```
payload.route = { env: "env-<id>" }   → 指定环境接手（fork：延续上下文 + kernel 状态）
payload.route = { env: "new" }        → 新环境（fresh：全新状态）——缺省等价
payload.route = { env: "<id>", reset: true } → 指定环境但重置（复用编号的新会话，可选）

分选器执行链：
  1. kind 判定（intent/code/chain/ops——任务分化先于角色）
  2. 环境分配：route.env
     ├─ 指定编号 → 定位持有该环境的 worker/kernel 实例 → 交付（不 reset）
     ├─ 新建 → 分配编号 + worker 认领（绑定新环境）
     └─ 指定编号不可达（worker 死/已 GC）→ 降级策略：
          a. 从快照文件重建（workspace/envs/env-<id>.json → eval 重放/按 spec 重建）
          b. 新建 fresh（PTH_ENV_UNREACHABLE=rebuild|new，默认 rebuild）
  3. 角色/正交化路由照旧（kind/标签维度不变）
```

### 递归投递与环境的结合

```
LLM done.next 携带路由：
  { "action": { "tool": "done", "args": {
      "result": {...},
      "next": { "task": {...}, "route": { "env": "env-<当前>" } }   ← fork（延续）
      // 或 "route": { "env": "new" }                              ← fresh
  } } }

→ 递归 = 环境的延续/新建投递（同一环境编号 = 会话内分支；新编号 = 新会话）
```

## 4. GC 流程（详细）

### 4.1 触发条件
```
- 环境空闲超时：PTH_ENV_IDLE_MS（默认 5min，复用 kernel 空闲回收语义）
- worker 实例崩溃/被扩缩容回收：持有环境不可达
- 任务链终止：父环境不再被任何 next 引用（引用计数归零）
- 显式销毁：任务完成时 payload 指定 env.release=true（LLM/发布者可控制）
```

### 4.2 三步流程
```
① refine 抽取：
   - snapshot 聚合三 kernel 状态（现有协议）
   - LLM 提炼 tool-function（源码+spec）/ task-insight（现有 refine 管线复用）
   - 失败降级：快照原样保存（不丢——现有降级语义）
② 内存释放：
   - kernel reset（ns 清空）/ 进程回收（懒 spawn 下直接杀——空闲回收已有）
   - 环境从活跃表移除
③ 环境快照文件：
   - workspace/envs/env-<id>.json
   - 内容：三 kernel snapshot（变量/函数源码+spec）+ 环境元数据
     （env-id / parent-env / 任务链 ids / 创建与最后活动时间 / 引用计数）
   - 格式：与 toolstore/记忆双通道兼容（eval 重放/按 spec 重建可恢复）
```

### 4.3 workspace GC（文件级）
```
- 保留策略：PTH_ENV_SNAPSHOT_TTL（默认 7 天）/ 大小上限 PTH_ENV_SNAPSHOT_MAX_MB（默认 500MB）
- 清理规则：过期快照删除；子环境 GC 后父快照引用计数减一（引用归零且过期 → 可删）
- 与工作空间其他文件统一管理（产物/transcript 的 GC 一并处理——复用同一回收循环）
- 参数：PTH_WS_GC_INTERVAL_MS（默认 1h 扫描）
```

## 5. 与现有机制的映射（全部复用/扩展）

| 现有机制 | 环境模型中的角色 |
|---------|----------------|
| snapshot 协议（三 kernel 聚合） | GC 价值抽取 + 快照文件内容 |
| refine 管线 | GC 第①步（提炼 tool-function/insight） |
| kernel-config（懒 spawn/空闲回收/ns reset） | 环境分配的物理层（idle → 回收触发 GC） |
| 正交化路由（assigned_role/kind） | 扩展 route.env 维度（kind 仍是基础） |
| 递归投递（done.next） | next 携带 route.env（fork/fresh） |
| toolstore/workspace 目录 | 环境快照文件存放地（workspace/envs/） |
| 召回机制（eval 重放/按 spec 重建） | 快照重建（env 不可达降级） |
| transcript/artifact | 环境任务链的审计记录（parent-env 关联） |

## 6. 参数化（仿 PG 风格）

```
PTH_ENV_IDLE_MS            默认 300000（环境空闲回收触发 GC）
PTH_ENV_UNREACHABLE        rebuild|new（默认 rebuild——快照重建）
PTH_ENV_SNAPSHOT_TTL       默认 7 天（workspace 快照保留）
PTH_ENV_SNAPSHOT_MAX_MB    默认 500
PTH_WS_GC_INTERVAL_MS      默认 3600000（workspace GC 扫描）
PTH_FORK_MAX_DEPTH         默认 5（fork 链深度上限——防失控递归）
```

## 7. 安全与边界

- 环境快照含任务代码/变量——写入 workspace 卷（与现有产物同级权限）
- 快照重建 eval 重放：在 vm 沙箱/白名单内（不引入新执行面）
- sandbox 侧 kernel（kernel sandbox 设计）：环境编号映射到 sandbox 池内 kernel——GC 即池回收
- 环境编号不暴露给 sandbox（路由在 PTH 侧执行）

## 8. 落地阶段

```
Phase 1：环境编号与路由
  - env 表/字段：tasks.payload.route.env 解析 + 环境注册表（活跃 env 表：env-id → worker/kernel 句柄）
  - 分选器扩展：route.env 处理（指定/新建/不可达降级）
  - TaskLoop：延续任务跳过 kernel.reset（fork 语义）
  - done.next 携带 route（agent-loop 扩展）
Phase 2：GC 流程
  - 空闲超时/引用计数 → GC 三步（refine 抽取 + 内存释放 + 快照文件）
  - workspace GC 循环（TTL/大小/引用清理）
Phase 3：重建与恢复
  - 快照文件 → 新环境恢复（eval 重放/按 spec 重建）
  - sandbox 池集成（环境编号 ↔ sandbox kernel 池）
  - 端到端验证：fork 链（状态延续）/ fresh / GC 后重建 全闭环
```

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| 延续任务绑定 worker 实例（进程死则状态死） | 快照降级重建（PTH_ENV_UNREACHABLE=rebuild）+ 空闲回收前先快照 |
| fork 链失控（无限延续） | PTH_FORK_MAX_DEPTH + 引用计数 + 任务池既有治理 |
| 快照膨胀（workspace 文件堆积） | workspace GC（TTL/大小上限/引用归零清理） |
| 状态串味（环境编号误复用） | 编号唯一性 + route.env 显式指定 + reset 选项 |
| GC 与执行竞态（任务正用环境时回收） | 引用计数保护（active 引用中不 GC）+ 回收前二次确认 |
| 快照含敏感信息 | 与产物同级权限；sandbox 快照在 PTH 侧生成（无密钥侧不落盘敏感） |

## 10. 裁决记录

| # | 裁决 |
|---|------|
| 1 | 会话与 REPL kernel 临时持久化状态绑定并分配编号（env-id） |
| 2 | 任务路由（payload.route.env）可指定"哪个上下文接手"（fork）或"新建环境"（fresh） |
| 3 | 环境不可用 → GC：refine 抽取价值 → 内存释放 → 快照文件入工作空间 |
| 4 | 工作空间 GC 一并处理（TTL/大小/引用计数） |
| 5 | fresh 保持存在（常规路由等价新建环境）——fork/fresh 统一于环境分配 |
| 6 | 快照重建（eval 重放/按 spec 重建）作为环境不可达的降级 |
| 7 | 递归投递（done.next）携带 route.env——递归 = 环境延续/新建 |
