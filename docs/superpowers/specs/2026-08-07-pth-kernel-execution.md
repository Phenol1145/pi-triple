# PTH kernel Spec B：执行层（batch + worker 簇 + 任务循环 + 工作区）

- **日期**：2026-08-07
- **状态**：设计（总纲 spec §5 分 spec B，待用户审阅）
- **定位**：PTH kernel 的执行组装层——batch 进程管理、worker 簇、任务认领循环、任务级工作区、归档。
- **依赖**：总纲 spec（§4 裁决 9/10/11/14/17/18/21/24）+ Spec C（存储）+ Spec A（解释器）
- **执行顺序**：C → A → B（本 spec）

---

## 1. 目标与非目标

### 目标（v1）

1. **batch 进程管理**：pth 容器内 spawn batch 子进程（方案 C）；手动加减（/lab 命令）+ 统计建议
2. **worker 簇**：每 batch = 全角色 worker（每类型 ×1，v1）；worker = WorkerKernel（Spec A）
3. **任务认领循环**：peek → claim → 执行 → submit → 转录归档（六状态机消费 Spec C taskStore）
4. **任务级工作区**：认领分配（workspaces/<tenant>/tasks/<taskId>/）、提交归档、清理
5. **转录归档**：执行记录 → pg transcripts；产物 → artifacts 卷（整目录 rename，v1 简化）
6. **扩缩容命令**：/lab batch add/remove/status（手动）；统计建议（负载采集）

### 非目标（明确不做）

- ⛔ 自动扩缩容（v1 手动 + 统计建议；自动留 v2）
- ⛔ 动态 batch 构成（v1 全角色 ×1；开发者×2 留 v2）
- ⛔ 产物提炼归档（v1 整目录 rename；提炼留 v2）
- ⛔ 多机部署（v1 单机；batch 进程与容器边界解耦为多机留路）
- ⛔ 经济闭环（经济闸门缓行）
- ⛔ 验收者角色（v1 提交即完成；acceptance 字段人读）

## 2. 架构

```
src/pth/kernel/execution/
├── batch-manager.ts      batch 进程管理（spawn/回收/状态/手动加减）
├── batch-process.ts      batch 子进程入口（worker 簇组装 + 任务循环）
├── worker-cluster.ts     worker 簇（每类型 ×1 的 WorkerKernel 注册表）
├── task-loop.ts          任务认领循环（peek → claim → 执行 → submit → 归档）
├── workspace.ts          任务级工作区（认领分配/归档/清理）
├── archive.ts            转录归档（pg transcripts + artifacts 卷）
├── stats.ts              负载统计（pending 队列/worker 空闲率 → 建议）
└── index.ts              barrel + /lab 命令注册
```

## 3. batch 进程管理（batch-manager.ts）

```ts
/**
 * batch 管理：pth 主进程 spawn batch 子进程（方案 C，裁决 15）。
 * 子进程 = node 脚本（batch-process.ts），经 IPC 通信（child_process.fork 或 spawn+stdio）。
 * v1 手动加减：/lab batch add [n] / /lab batch remove [n] / /lab batch status。
 * 统计建议（stats.ts 采集）：pending 队列长度/worker 空闲率 → /lab batch suggest。
 */
export interface BatchManager {
  spawnBatch(): Promise<BatchHandle>;        // 加一个 batch（全角色 worker ×1）
  killBatch(id: string): Promise<void>;      // 减一个 batch（优雅：完成当前任务后退出）
  listBatches(): BatchStatus[];              // 状态（id/进程 pid/worker 数/当前任务/空闲率）
  suggest(): BatchSuggestion;                // 统计建议（加/减/维持 + 理由）
}

export interface BatchHandle {
  id: string;
  pid: number;
  workers: string[];                         // worker 类型列表（v1 = 全角色）
  currentTasks: Map<string, string>;         // workerId → taskId（当前认领）
  idleRatio: number;                         // 空闲率（统计）
}

export interface BatchSuggestion {
  action: "add" | "remove" | "keep";
  reason: string;                            // 基于 pending 队列长度/空闲率
  data: { pendingCount: number; idleRatio: number; batchCount: number };
}
```

**子进程模型**：`child_process.fork(batchProcessPath)`（IPC channel）——batch 崩溃不影响 pth 主进程（OS 进程隔离，裁决 15 方案 C）；pth 侧 watchdog 检测崩溃 → 自动重启（裁决 26）。

**最小 IPC 协议（对抗性审核 I7）**：
```
主进程 → batch: {type: "shutdown"} | {type: "pause"} | {type: "resume"}
batch → 主进程: {type: "status", tasks: [{workerId, taskId}]} | {type: "error", message}
```
- batch 自驱动任务循环（直接连 pg 独立连接池）；IPC 仅用于生命周期控制（/lab batch remove = 发 shutdown → batch 完成当前任务后退出）
- `BatchHandle.signal()` 暴露；TaskLoop 每轮循环前检查信号（pause 停止认领新任务）

## 4. worker 簇（worker-cluster.ts）

```ts
/**
 * worker 簇：每 batch = 全角色 worker ×1（v1，裁决 14）。
 * 角色集（自持态设计）：分析者/计划者/开发者/侦查者/记忆维护者/验收者/人类交互者。
 * v1 实现：角色 = WorkerKernel + 角色 prompt 模板（描述任务处理方式）+ 标签匹配。
 * 每个 worker 独立 task-loop 实例（并发认领）。
 */
export interface WorkerRole {
  id: string;                    // analyst | planner | developer | scout | memory-keeper | acceptor | human-interface
  labelPatterns: string[];       // 认领标签（sorter 匹配）
  prompt: string;                // 角色 prompt（注入 llm.complete 的 system）
}

export const DEFAULT_ROLES: WorkerRole[] = [
  { id: "analyst", labelPatterns: ["analysis", "research"], prompt: "你是分析者……" },
  { id: "planner", labelPatterns: ["plan", "design"], prompt: "你是计划者……" },
  { id: "developer", labelPatterns: ["implement", "code", "fix"], prompt: "你是开发者……" },
  { id: "scout", labelPatterns: ["recon", "investigate"], prompt: "你是侦查者……" },
  { id: "memory-keeper", labelPatterns: ["memory", "organize"], prompt: "你是记忆维护者……" },
  { id: "acceptor", labelPatterns: ["accept", "verify"], prompt: "你是验收者……" },
  { id: "human-interface", labelPatterns: ["human", "interact"], prompt: "你是人类交互者……" },
];

export function createWorkerCluster(deps: {
  kernelFactory: (role: WorkerRole) => WorkerKernel;   // Spec A createWorkerKernel
  taskStore: TaskStore;                                // Spec C
  workspaceMgr: TaskWorkspaceManager;                  // §6
}): Map<string, WorkerKernel>;  // roleId → WorkerKernel
```

## 5. 任务认领循环（task-loop.ts）

```ts
/**
 * 任务循环：peek → claim → 执行 → submit → 转录归档。
 * 循环语义（裁决 10/11）：
 *   - peek（只读不锁定）先于 claim——"认领即承诺"（裁决 11）
 *   - claim 后执行；执行失败 → reject（评估后明确不做）或重试
 *   - 逐条判别式失败不中断（裁决 10：原子批 = ACID 幻觉）
 *   - 认领竞态（claimed-by-other）为正常——由判别式处理，不特殊处理
 * 接口统一（对抗性审核 I3）：适配 taskpool v1 既有接口
 *   candidates(agentId) / claimTopN(agentId, n) / reject(agentId, taskId, reason) / submit(agentId, taskId, outputRef)
 */
export class TaskLoop {
  constructor(deps: { kernel: WorkerKernel; role: WorkerRole; taskStore: TaskStore; workspaceMgr: TaskWorkspaceManager; intervalMs?: number }) {}

  async runOnce(): Promise<void> {
    // 1. peek：只读获取符合标签的前 n 个任务（不锁定）——适配 candidates(agentId)
    const candidates = await this.deps.taskStore.candidates(this.role.id);

    // 2. 模型判断：自检"能否用现有能力完成"（llm.complete 一次调用）
    const decision = await this.assess(candidates);   // { claimTaskIds: string[], rejectTaskIds: string[] }

    // 3. 认领（claim 即承诺）+ 拒绝（reject 带原因）
    for (const id of decision.claimTaskIds) {
      const claimed = await this.deps.taskStore.claimTopN(this.role.id, [id]);
      if (claimed.length > 0) await this.execute(claimed[0]);
      // claimed=false = 竞态（已被他人认领）——正常，跳过
    }
    for (const id of decision.rejectTaskIds) {
      await this.deps.taskStore.reject(this.role.id, id, "assessed-as-unfit");
    }
    // 空转防护（对抗性审核 I4）：assess 全拒且无 claim/reject → 对全部候选 reject（放回池供他 worker）
    if (decision.claimTaskIds.length === 0 && decision.rejectTaskIds.length === 0 && candidates.length > 0) {
      for (const t of candidates) {
        await this.deps.taskStore.reject(this.role.id, t.id, "assessed-as-unfit");
      }
    }
  }

  private async execute(task: Task): Promise<void> {
    // 任务级工作区分配（§6）→ kernel.reset() → 执行 → submit/归档
    // try/catch 外包（对抗性审核 I10）：执行抛异常 → reject（claim=承诺，失败显式拒绝，不等 stale）
    const ws = await this.deps.workspaceMgr.allocate(task.id);
    this.deps.kernel.reset();                          // 任务级状态隔离
    try {
      // 执行入口：任务程序是 TS（v1 主路径）——bash/Python 经 vm context 的
      // capabilities.bash / capabilities.python 由 LLM 代码调用（对抗性审核 B2 裁决：
      // 注入 vm context 而非任务类型分发——三解释器真实接入执行路径）
      const result = await this.deps.kernel.ts.execute(task.program, { cwd: ws.dir });
      await this.deps.taskStore.submit(this.role.id, task.id, { ref: result });
      await archiveTask(task, ws, result);             // 转录 + 产物归档（§7）
    } catch (e) {
      await this.deps.taskStore.reject(this.role.id, task.id, `execution-crashed: ${(e as Error).message}`);
    }
  }
}
```

> **v1 裁剪标注（fix wave 评审确认）**：v1 裁剪：机械认领全部候选（无 assess 智能判断）——空转防护（整批零认领 → reject assessed-as-unfit）兜底；assess（llm.complete 自检候选是否可完成）留 v2 注入。

## 6. 任务级工作区（workspace.ts）

```ts
/**
 * 任务级工作区（裁决 18）：认领分配 → 提交归档 → 清理。
 * 路径：workspaces/<tenant>/tasks/<taskId>/（sandbox 白名单）
 * 分配：认领时创建目录；batch worker 无固定 cwd（每次认领切换）
 * 归档：提交后整个任务工作区 rename 到 artifacts/<tenant>/<taskId>/（v1 简化，不提炼）
 * 清理：归档后工作区即 artifacts（rename 语义——无需额外清理）
 */
export interface TaskWorkspaceManager {
  allocate(taskId: string): Promise<{ dir: string; tenant: string }>;
  archive(taskId: string, dir: string): Promise<{ artifactPath: string }>;
}

export class DefaultTaskWorkspaceManager implements TaskWorkspaceManager {
  constructor(deps: { basePath: string; artifactPath: string }) {}

  async allocate(taskId: string) {
    const dir = join(this.deps.basePath, "tasks", taskId);
    await mkdir(dir, { recursive: true });
    return { dir, tenant: "default" };
  }

  async archive(taskId: string, dir: string) {
    const artifactPath = join(this.deps.artifactPath, taskId);
    await rename(dir, artifactPath);    // 整目录 rename（v1；产物指针入 pg）
    return { artifactPath };
  }
}
```

## 7. 转录归档（archive.ts）

```ts
/**
 * 转录归档（裁决 16/17/18）：执行记录 → pg transcripts；产物 → artifacts 卷。
 * v1：转录 = 任务程序 + 执行结果 + 摘要（结构化 JSONB）；产物 = 整目录 rename（指针入 pg）。
 * 清理策略（裁决 17）：产物不自动清理——推送清理提示到交互层（gateway 事件），人工/策略决定。
 */
export async function archiveTask(task: Task, ws: { dir: string }, result: InterpreterResult): Promise<void> {
  const artifactPath = await workspaceMgr.archive(task.id, ws.dir);   // 产物整目录 rename
  await transcriptStore.create({                                     // pg transcripts
    taskId: task.id,
    agentId: task.claimedBy,
    body: [                                                          // 事件序列
      { type: "program", program: task.program },
      { type: "result", result: result.value, stdout: result.stdout, stderr: result.stderr },
      { type: "summary", summary: summarize(result) },              // v1 简单摘要
    ],
    artifactPath,
  });
  // 清理提示（不自动删）：emit 事件 → 意图层 gateway（交互层可见）
  emitCleanupSuggestion({ artifactPath, taskId: task.id });
}
```

## 8. 负载统计与建议（stats.ts）

```ts
/**
 * 负载统计（裁决 24）：采集 pending 队列长度 + worker 空闲率 → /lab batch suggest。
 * v1：手动执行建议（不自动扩缩）；数据为统计优化器 v2 的基础。
 */
export interface LoadStats {
  pendingCount: number;        // tasks 表 pending 总数（按标签分组）
  idleRatio: number;           // batch 空闲率（无当前任务 worker / 总 worker）
  batchCount: number;
  collectedAt: number;
}

export function collectStats(deps: { taskStore: TaskStore; batches: BatchStatus[] }): LoadStats;

export function suggest(stats: LoadStats): BatchSuggestion {
  // 判据（v1 简单规则）：
  //   pendingCount > 10 && idleRatio < 0.3 → add（任务积压，worker 忙）
  //   idleRatio > 0.7 && batchCount > 1 → remove（普遍空闲）
  //   否则 keep
  // 阈值可配置（env/配置）；v2 由统计优化器自适应
}
```

## 9. /lab 命令（index.ts 注册）

```
/lab batch add [n]         手动加 n 个 batch（默认 1）
/lab batch remove [n]      手动减 n 个 batch（优雅退出：完成当前任务后）
/lab batch status          列出 batch（id/pid/worker/当前任务/空闲率）
/lab batch suggest         统计建议（加/减/维持 + 理由 + 数据）
/lab batch stats           负载统计原始数据
```

> **v1 交付范围标注（fix wave 评审确认）**：v1 交付底层原语（BatchManager.spawnBatch/killBatch/listBatches/suggest + stats.collectStats/suggest）；/lab 命令注册（batch add/remove/status/suggest/stats）移交 PTH 装配层。

## 10. 与 C/A spec 的接口

- **消费 Spec C**：`taskStore`（peek/claim/reject/submit——接口保留自 taskpool v1）、`transcriptStore`、`DataWorldAccess`
- **消费 Spec A**：`createWorkerKernel`（WorkerKernel）、`Interpreter.execute`、`llm.complete`
- **生产给上层**：batch 生命周期管理（pth 主进程装配）、/lab 命令、统计建议

## 11. 不变量

1. 执行层全部收敛到 PTH kernel（裁决 21）——无第二条执行路径
2. peek 先于 claim（只读不锁定）；claim 即承诺（裁决 11）
3. 逐条判别式失败不中断（裁决 10）
4. 认领竞态（claimed-by-other）= 正常（判别式处理，不特殊）
5. 任务级工作区（认领分配、归档、清理；batch worker 无固定 cwd）（裁决 18）
6. 产物不自动清理——推送清理提示到交互层（裁决 17）
7. batch 崩溃不影响 pth 主进程（child_process 隔离，方案 C）；不自动重启 v1
8. 手动扩缩容 + 统计建议（裁决 24）；自动留 v2
9. 全角色 worker ×1（裁决 14）；动态构成留 v2
10. 转录归档（pg）+ 产物整目录 rename（v1，不提炼）；提炼留 v2

## 12. 相关参考

- 总纲：`docs/superpowers/specs/2026-08-07-pth-kernel-architecture.md`（裁决 9/10/11/14/17/18/21/24）
- Spec C：`docs/superpowers/specs/2026-08-07-pth-kernel-storage.md`（taskStore/transcriptStore 接口）
- Spec A：`docs/superpowers/specs/2026-08-07-pth-kernel-interpreters.md`（WorkerKernel）
- 任务池 v1：`docs/superpowers/specs/2026-08-06-task-pool-sorter-design.md`（六状态机/peek/claim/reject 语义）
