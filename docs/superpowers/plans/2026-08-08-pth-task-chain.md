# PTH 任务池即工作流（Pool-as-Workflow）实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务池变成可重写的归约系统——任务完成触发"编译"（重写规则），自动生成下游任务（验收/拆分/修复），实现流程管理的自动化，无 orchestrator 实体。流程定义 = 记忆区文档（扁平化），规则 = 数据。

**Architecture:**

```
任务（payload.deps = 依赖列表，payload.chain = 下游规则）
  │
  ├─ 就绪检测（candidates 只返回 deps 全部 completed 的任务）—— DAG 调度语义
  │
  ├─ TaskLoop 执行（现有）
  │
  ├─ submit/reject 完成事件
  │     ↓
  └─ 重写钩子 afterComplete（新）：
       payload.chain 直接规则  或  从记忆召回 flow 定义文档
       → 生成下游任务（带 deps=[当前任务]）→ publish 二次投放
       → 循环防护（chainDepth 上限）
```

**Tech Stack:** pg（既有）、TaskStore（既有）、零新依赖。

## Global Constraints

- 不破坏现有直接发布（无 chain 的任务行为不变）
- 循环防护：`payload.chainDepth`，默认上限 3——防 A→B→A 死循环
- 就绪过滤只影响 `candidates()`（认领视角）；`publish`/`list` 不变
- 规则数据化：chain 是 JSON 数组（不是代码）；flow 文档可放记忆区（memory-maintain 已能维护）
- 测试：TaskStore 就绪过滤单测（mock pool）+ TaskLoop 重写钩子单测（mock store）+ 集成（真实 pg）
- 提交风格：`feat(pth): 中文摘要`

---

### Task 1: 任务依赖语义（deps 就绪过滤）

**Files:**
- Modify: `src/pth/kernel/storage/task-store-pg.ts`（candidates 加就绪过滤）
- Test: `test/pth-kernel-storage/task-store-pg.test.ts` 或新增 `test/pth-kernel-storage/deps.test.ts`

**Interfaces:**
- Consumes: Task.payload.deps（`string[]`——上游任务 id）
- Produces: `candidates()` 只返回"deps 全部 completed"的 pending 任务

- [ ] **Step 1: 写失败测试**

```ts
// 三个任务：T1(无 deps)、T2(deps=[T1])、T3(deps=[T1]) 且 T1 completed → candidates 返回 T2/T3
// T1 pending 时 → candidates 只返回 T2（就绪的）
```

- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 写实现**

```ts
// candidates SQL：
//   WHERE status='pending'
//     AND NOT EXISTS (
//       SELECT 1 FROM jsonb_array_elements_text(payload->'deps') d
//       LEFT JOIN tasks t ON t.id = d
//       WHERE t.id IS NULL OR t.status != 'completed'
//     )
// 注：payload->'deps' 缺失 = 无依赖 = 就绪（jsonb_array_elements_text 空集 = NOT EXISTS 真）
```

- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

---

### Task 2: 重写钩子（afterComplete）

**Files:**
- Create: `src/pth/kernel/execution/chainer.ts`（rewriteOnComplete 纯函数 + 循环防护）
- Modify: `src/pth/kernel/execution/task-loop.ts`（execute 完成分支调链钩子）
- Modify: `src/pth/kernel/execution/batch-process.ts`（BatchTaskLoop 接 chainer）
- Test: `test/pth-kernel-execution/chainer.test.ts`

**Interfaces:**
- Consumes: `taskStore.publish`、Task.payload.chain / payload.flow
- Produces: 下游任务 publish（带 deps=[上游] + chainDepth+1）

- [ ] **Step 1: 写失败测试**

```ts
// 纯函数：
//   buildDownstreamTasks(task, { flowDoc? }): PublishInput[]
//   - payload.chain 数组 → 每个元素生成一个下游任务（title/text/tags/role 标签）
//   - payload.flow 引用 → 从 flowDoc 按规则生成（v1：flowDoc.chain 同构）
//   - chainDepth 达到上限 → 不再生成
//   - deps 自动注入 [task.id]
//   - 循环防护：下游任务 id 生成含上游 id 前缀（可追踪）
```

- [ ] **Step 2: 跑测试验证失败**
- [ ] **Step 3: 写实现**

```ts
// chainer.ts:
//   interface ChainRule { role?: string; template?: string; title: string; text: string; tags?: string[] }
//   buildDownstreamTasks(task, opts: { flowDoc?: { chain: ChainRule[] }; maxDepth?: number })
//     → PublishInput[]
//   rewriteOnComplete(taskStore, task, opts) → Promise<PublishInput[]>（publish 并返回）

// task-loop.ts execute() 完成分支：
//   await this.afterComplete?.(task, result)   // 注入的钩子（默认 no-op）
//   BatchTaskLoop 覆写 → chainer.rewriteOnComplete
```

- [ ] **Step 4: 验证通过**
- [ ] **Step 5: 提交**

---

### Task 3: 验收闭环实测（developer → acceptor）

**Files:**
- 试运行：发布带 chain 的开发任务（payload.chain = [{role:"acceptor", title:"验收..."}]）
- 验证：developer 完成 → 自动 publish 验收任务（deps=[开发任务]）→ acceptor worker 接取 → 验收完成

**验证点:**
- [ ] 发布任务 A（payload.chain 含验收规则）
- [ ] batch 运行 → A completed → 池中出现 B（验收，deps=[A]）
- [ ] B 被 acceptor worker 认领执行 → completed
- [ ] 无死循环（chainDepth 停止）
- [ ] 任务链可追踪（payload 记录上下游）

- [ ] **Step 1: 发布带 chain 任务**
- [ ] **Step 2: 观察自动生成下游**
- [ ] **Step 3: 验证闭环 + 提交**

---

### Task 4（可选后续）: flow 文档驱动（记忆区召回）

**设计:** payload.flow 引用记忆区文档（kind=workflow-def），worker 或 chainer 召回文档 → 按文档规则编译下游任务。流程定义完全扁平化（文档即流程），可被 memory-maintain 模板维护。

- [ ] flow 文档召回路径（memory.retrieve → 解析 chain 规则）
- [ ] 发布时只给 flow 引用 + 参数

---

## 自审（Self-Review）

**1. Spec coverage：**
- 用户愿景"developer 完成自动生成 acceptor 任务" ✅ Task 2/3
- 用户方案"编译后二次投放（任务池重写系统）" ✅ Task 1（DAG 就绪）+ Task 2（重写）
- "经典算法"（Make/Petri/数据流）✅ Task 1 就绪检测 = DAG 调度；Task 2 重写 = Petri 变迁
- 扁平化（规则=数据，无 orchestrator 实体）✅ chain 是 JSON；flow 文档在记忆区

**2. Placeholder scan：** 无 TBD；v1 flow 文档 = chain 同构（Task 4 完整化）。

**3. Type consistency：** PublishInput 已含 payload/tags（Task 1 消费 payload.deps）；TaskLoop 新钩子 afterComplete 可选注入（向后兼容）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-08-pth-task-chain.md`. Two execution options:

1. **Subagent-Driven (recommended)** - fresh subagent per task + review
2. **Inline Execution** - executing-plans with checkpoints

**Which approach?**
