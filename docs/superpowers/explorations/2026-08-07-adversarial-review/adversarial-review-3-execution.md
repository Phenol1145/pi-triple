# 对抗性审核：PTH Kernel Spec A（解释器）+ Spec B（执行层）

- **审核日期**：2026-08-07
- **审核范围**：Spec A（解释器）、Spec B（执行层），交叉验证 Spec C（存储）、总纲、task-pool sorter spec
- **审核立场**：挑剔——主动找破绽，不顺着设计读
- **关键依赖核实**：`src/shared/model-router/router.ts`、`src/shared/sdk-adapter/index.ts`、pi-ai SDK `Context`/`Message`/`ModelRuntime` 类型

---

## 问题清单

| # | 严重度 | 类别 | 问题 | 建议修复 |
|---|---|---|---|---|
| 1 | **Blocker** | 接口不可行 | **llm.complete 实现路径缺失 — messages→Context 转换未定义**。Spec A §7 定义 `LlmFn.complete(messages: Array<{role, content}>, opts)` 为简单 `{role, content}` 数组。但 SDK `ModelRuntime.complete(model, context: Context, options?)` 的 `Context = { systemPrompt?, messages: Message[], tools? }`，其中 `Message = UserMessage \| AssistantMessage \| ToolResultMessage`，每个 message 必须带 `timestamp`、`content` 是复杂联合类型（`(TextContent \| ImageContent)[]` 或 `(TextContent \| ThinkingContent \| ToolCall)[]`）、`AssistantMessage` 还需 `usage`/`stopReason`/`api`/`provider` 等字段。**两种消息格式之间存在不可逾越的语义鸿沟**——不存在简单的 1:1 映射。此外 `ModelRouter.resolve()` 返回 `Model<Api>`（模型描述符），可喂给 `ModelRuntime.complete(model, context)`，但 Context 构造完全未设计。 | ① 在 `llm-fn.ts` 中实现 `messages→Context` 转换层：将 `{role, content}` → `UserMessage`（填充 `timestamp: Date.now()`）/ `AssistantMessage`（需从历史重建完整结构）。② 或改用 pi SDK 的 `AgentSession.prompt()` 路径（但其是为会话设计的，不是函数式调用）。③ 最务实的 v1 方案：Spec A 的 `LlmFn.complete()` 内部使用 `ModelRuntime.completeSimple(model, { messages: [...], systemPrompt?... })` —— `completeSimple` 也接受 `Context`，但至少避开了 `stream` 路径的复杂选项。转换层仍是必需的，需在 spec 中明确。 |
| 2 | **Blocker** | 架构断裂 | **Spec B 只使用 TS 解释器，bash/Python 解释器从未被调用**。Spec B §5 `TaskLoop.execute()` 只调用 `this.deps.kernel.ts.execute(task.program, { cwd: ws.dir })`。bash 和 Python 解释器在 `WorkerKernel`（Spec A §8）中实例化但完全未接入执行路径。更关键的是：Spec A §4.2 的 `buildCapabilities` 只注入 `{ llm, memory, skills, tasks }` —— **bash 和 Python 解释器实例未被注入 vm context**，因此 LLM 生成的 TS 代码连调用它们的途径都没有。`WorkerKernel` 有 `ts/bash/python` 三个字段，但 bash/python 是"死代码"——三解释器架构名存实亡。 | ① 明确 bash/Python 解释器的调用路径。选项 A：将它们注入 vm context（`capabilities.bash` / `capabilities.python`）使 LLM 代码可调用。选项 B：TaskLoop 先判断任务类型（如标签含 `shell`则用 bash，含 `python` 则用 Python），role-based dispatch。② 如果 v1 实际只用 TS（所有任务都是 TS 程序，TS 内部通过 `llm.complete()` 完成一切），**应在总纲 §3 和 Spec B §5 中诚实声明**："v1 仅 TS 解释器参与执行；bash/Python 解释器实例化但预留"——而非在 Spec A §8 中宣称 "worker = 三解释器"。 |
| 3 | **重要** | 接口不一致 | **Spec B 的 taskStore 接口与 task-pool sorter spec 的接口签名不兼容**。Spec B §5 使用：`peek({tags, limit})` / `claim(id, {agentId})` / `reject(id, {agentId, reason})` / `submit(id, {agentId, result})`。Task-pool sorter spec §6.2 定义：`candidates(agentId)` / `claimTopN(agentId, n)` / `reject(agentId, taskId, reason)` / `submit(agentId, taskId, outputRef)`。差异包括：① `peek` 按 tags 过滤 vs `candidates` 按 agentId 查 selector；② `claim` 单任务 vs `claimTopN` 批量认领；③ `submit` 的参数 `result`（解释器结果对象） vs `outputRef`（string）。Spec C §5 声称 "taskStore 接口保留自 taskpool v1"——但 Spec B 已经重定义了不同的接口。 | 统一接口：① 要么 Spec B 适配 task-pool sorter 的既有接口（`claimTopN` 返回数组，兼容 Spec B 的候选→判别→认领流程）；② 要么在 Spec C 中定义 `TaskStore` 接口为 Spec B 所需形状，并声明 task-pool sorter 实现需适配（或增加适配层）。关键：**两个 spec 不能各自定义同名但签名不同的接口而不声明适配关系**。同时 `result` vs `outputRef` 的语义差异需在 Spec C 的 `tasks` 表 schema 中解决（Spec C §2.2 的 tasks 表有 `artifact_path` 列但无 `result` JSONB 列）。 |
| 4 | **重要** | 运行风险 | **peek→assess 循环在 LLM 判定"无法执行"时空转烧钱**。Spec B §5 `TaskLoop.runOnce()`：peek 拿候选 → `assess()`（一次 llm.complete 调用）→ 若 `claimTaskIds: []`（LLM 判定所有候选都无法完成），则既不 claim 也不 reject → 循环回到 peek → **再次拿到同样的任务**（因未被 claim/reject，任务状态不变）→ 再次 assess → 无限空转。每次迭代消耗一次 LLM API 调用（有成本），且零进展。 | ① 当 `claimTaskIds` 和 `rejectTaskIds` 都为空时，对所有候选任务调用 `reject(id, {reason: "assessed-as-unfit"})`——表明 worker 已判定无法处理，将任务放回池供其他 worker 或升级。② 或者给peek加排除语义：assess 过的任务短期内不再返回给同一 worker。③ 至少加空转检测：连续 N 次 `runOnce` 无 claim 无 reject → 延长轮询间隔或告警。 |
| 5 | **重要** | 技术缺陷 | **TS strip 后 import/require 语句导致 vm 运行时崩溃**。Spec A §4.1 使用 `stripTypeScriptTypes(program)` 仅剥离类型注解。如果 LLM 生成的代码包含 `import { X } from '...'` 或 `const X = require('...')`，在 `runInContext` 中会抛出 `ReferenceError: require is not defined`（因为能力注入模型只注入了 `{llm, memory, skills, tasks}`，不含 `require`）。`node:vm` 的 context 默认没有模块系统。这意味着绝大多数非平凡程序（导入任何模块、使用任何外部库）都会直接崩溃。 | ① 文档化限制的同时，在 prompt template 中明确告知 LLM："不可使用 import/require，所有能力通过注入的全局变量（llm/memory/skills/tasks）访问"。② 在 `TsInterpreter.execute()` 中前置检测：扫描 JS 中的 `import`/`require` 关键字，提前拒绝并给出友好错误（而非让 vm 抛出难以理解的 ReferenceError）。③ 备选（v2）：使用 `vm.SourceTextModule` + `link` 回调限制性模块解析。 |
| 6 | **重要** | 可用性风险 | **Python v1 "每次新子进程" 严重限制数据科学场景可用性**。Spec A §6.1：每个 `execute()` spawn 新 `python3 -c` 进程。`import numpy` 冷启动 1-3 秒，`import pandas` 类似。如果 LLM agent 在一次任务中调用 Python 5-10 次（典型数据探索流程），仅 import 就消耗 5-30 秒。在 300 秒总超时下，导入开销占 1.5%-10%，但更重要的是**用户体验极差**——每次 Python 调用都有 1-3 秒的固定延迟。Spec 自身标注"v1 简化"，但 PTH 的核心使用场景包括数据科学/ML。 | ① 明确 v1 的使用边界：Python 解释器适用于"单次脚本执行"场景（一次 execute 完成完整分析），不适合"交互式逐行探索"——在 spec 中诚实声明。② 如 v1 必须支撑多次 Python 调用，考虑进程池预热（启动时 spawn 一个 `python3 -i` 进程保持存活，通过 stdin/stdout 传递代码）。③ 或者将 Python 解释器的 v1 定位降级为"可选实验特性"而非三解释器同权。 |
| 7 | **重要** | 接口缺失 | **Batch IPC 协议未定义，fork 的意义不明确**。Spec B §3 `BatchManager.spawnBatch()` 使用 `child_process.fork(batchProcessPath)`，声称"经 IPC 通信"。但 Spec B §4-5 的 `batch-process.ts` 内部，`TaskLoop` 直接调用 `taskStore.peek/claim/reject/submit`——即 batch 子进程自行轮询数据库。IPC channel 虽然建立了，但**没有任何协议定义**：pth 主进程怎么给 batch 下发任务？batch 怎么回报状态？如果 batch 完全自驱动，fork 的价值仅是 OS 级崩溃隔离（符合裁决 15），**但无法实现手动加减 batch 的优雅退出**（`/lab batch remove` 需要通知 batch 停止认领新任务——这条路径必须走 IPC）。 | ① 定义最小 IPC 协议：主进程→batch：`{type: "shutdown"}` / `{type: "pause"}` / `{type: "resume"}`；batch→主进程：`{type: "status", tasks: [...]}` / `{type: "error", ...}`。② 在 `BatchHandle` 上暴露 `signal` 方法，让 `TaskLoop` 在每轮循环前检查信号。③ 明确：taskStore 访问是 batch 直接连 pg（独立连接池），IPC 仅用于生命周期控制。 |
| 8 | 次要 | 运行风险 | **LLM 使用 top-level await 导致静默失败**。Spec A §10.9 诚实声明"top-level await 不支持"，但无检测/降级机制。现代 LLM（Claude 4、GPT-4o）生成含 `await` 的顶层代码属于默认行为。在 `vm.runInContext` 中，`await` 在非 async 上下文会抛 `SyntaxError`（或被 strip 后变成裸表达式）。用户看到的是"执行失败"但不知道原因是 await。 | ① 在 `TsInterpreter.execute()` 前置检测：扫描 JS 顶层是否有 `await` 关键字，若有则自动包装为 `(async () => { ... })()` 并 `.catch()` 处理。② 或者在 prompt 中显式禁止 top-level await，并在前置检测中给友好错误提示。③ 备选：评估 Node 24 的 `vm.SourceTextModule` 就绪状态——若可用，迁移到此路径原生支持 top-level await。 |
| 9 | 次要 | 接口边界 | **LLM 代码可通过注入的 `tasks.claim()` 从 vm 内认领任务，与 TaskLoop 的 claim 逻辑冲突**。Spec A §4.2 的 `buildCapabilities` 将 `tasks`（含 peek/claim/reject/submit）注入 vm context。这意味着 LLM 可以在程序执行期间调用 `tasks.claim(someTaskId)` —— 这与 Spec B §5 TaskLoop 的 claim 路径并行运行，可能导致：① 同一 batch 内的 worker 通过代码认领了本应由角色匹配的其他任务；② 绕过了 `assess()` 判定环节；③ 认领竞态（claimed-by-other）的判别式逻辑失效。 | ① 从 vm context 的 `tasks` 对象中移除 `claim` 和 `reject`，只保留 `peek`（只读）和 `submit`（提交自己的产出）——让任务认领完全由 TaskLoop 的机械逻辑控制。② 如果 LLM 需要"委派子任务"的能力，定义独立的 `tasks.delegate(subTask)` 动词而非复用 claim。 |
| 10 | 次要 | 一致性 | **总纲裁决 11 "认领即承诺" 与 Spec B 的 claim-failure 处理存在语义张力**。裁决 11 说"claim 即承诺"，但 Spec B §5 中 `if (claimed) await this.execute(claimed)`——执行失败后仅跳转到下一个，不触发 reject。如果 execute 抛异常（非 InterpreterResult 的 error 路径，而是 Node 级异常如 OOM/进程崩溃），claimed 任务既未被 submit 也未被 reject，进入 stale 回收等待。这违背了"承诺"语义——承诺了但执行失败理应显式 reject 而非静默依赖定时回收。 | 在 `execute()` 外包 try/catch：执行抛异常 → 调用 `taskStore.reject(id, {agentId, reason: "execution-crashed"})`。让 fail-fast 的语义与 claim=承诺一致。同时避免 stale 窗口期（staleMs=600s，期间任务对其他 worker 不可见）。 |

---

## 深入分析：llm.complete 实现路径（Spec A §7）——代码级可行性核实

### SDK 调用链

```
Spec A createLlmFn({modelRouter})
  → modelRouter.resolve(provider?, model?)  // 返回 Model<Api>（模型描述符）
  → modelRouter.getRuntime()                // 返回 ModelRuntimeInstance
  → runtime.complete(model, context)        // 需要 Model<Api> + Context
```

### 关键类型（pi-ai SDK）

```ts
// ModelRuntime.complete() 签名
complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ModelsApiStreamOptions<TApi>
): Promise<AssistantMessage>

// Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] }

// Message 联合类型
type Message = UserMessage | AssistantMessage | ToolResultMessage

// 每种消息的 mandatory 字段完全不同：
// UserMessage:      { role: "user", content: string | (TextContent|ImageContent)[], timestamp: number }
// AssistantMessage: { role: "assistant", content: (TextContent|ThinkingContent|ToolCall)[], api, provider, model, usage, stopReason, timestamp }
// ToolResultMessage:{ role: "toolResult", toolCallId, toolName, content, isError, timestamp }
```

### 结论

Spec A 定义的 `LlmFn.complete(messages: Array<{role, content}>, opts)` 中的简单 `{role, content}` 格式无法直接喂给 SDK。**必须实现 messages→Context 转换层**，至少需要：
1. 将 `{role: "user", content: "..."}` → `UserMessage`（填充 timestamp）
2. 历史 assistant 消息需要完整重建（usage/stopReason/api/provider 等）
3. 第一次调用时 `systemPrompt` 来自角色 prompt（Spec B §4 `WorkerRole.prompt`）

**这条路径可行但 spec 完全未涉及转换层设计**，是 v1 实现的最大单点风险。

---

## Bash 解释器的 Sandbox 转发核实

Spec A §5.1 使用的 `SandboxExecClient` 在 `src/pth/tools/sandbox-bash.ts` 中已有实现：
- `exec(req: SandboxExecRequest, signal?): Promise<SandboxExecResult>` —— HTTP POST 到 sandbox `/exec`
- 支持 `cmd`/`cwd`/`timeout` 参数
- 已有健康监控（`SandboxHealthMonitor`）和降级逻辑
- 默认工作目录：`/data/workspaces`

**接口签名与 Spec A §5.1 的 BashInterpreter.execute 兼容**，但以下问题需注意：
1. Sandbox 的白名单路径（`/data/workspaces`）与 Spec B §6 的任务工作区路径 `workspaces/<tenant>/tasks/<taskId>/` 的对齐——若 sandbox 仅允许 `/data/workspaces` 下的操作，而任务工作区在其子目录下，则需确认白名单包含该子路径。
2. Sandbox 超时/断连：`SandboxExecClient` 已有 `SANDBOX_ERROR_TIMEOUT` 和 `SANDBOX_ERROR_UNAVAILABLE` 两种错误类型，Spec A 应引用这些既有常量。

---

## 总结：两份 spec 可否批准？

### 不可批准。需修后重审。

**核心问题**：

1. **接口断裂**（Blocker #1, #2）：`llm.complete` 的实现到 SDK 的适配路径在 spec 层面未打通；bash/Python 解释器在架构上存在但从未连入执行路径——三解释器设计目前是纸面架构，实际只有 TS 一条通路。

2. **接口不一致**（重要 #3）：Spec B 的 taskStore 使用模式与 task-pool sorter spec 的接口签名直接冲突。如果两个模块按各自 spec 实现，将无法对接。

3. **运行风险未收敛**（重要 #4, #5, #6）：空转烧钱、import/require 崩溃、Python 性能——这些是 v1 上线后会立即暴露的问题，而非远期风险。

### 主要风险排序

| 风险 | 严重度 | 影响 |
|---|---|---|
| llm.complete 实现不可行 | Blocker | 核心 LLM 调用能力无法落地，整个 kernel 无 AI 能力 |
| bash/Python 解释器死代码 | Blocker | 宣称的多解释器架构不成立，Spec A 的架构图需重画 |
| taskStore 接口冲突 | 重要 | Spec B 无法消费 Spec C 的存储实现，集成必失败 |
| peek→assess 空转烧钱 | 重要 | 生产环境中持续消耗 API 费用而无产出 |
| import/require 崩溃 | 重要 | LLM 生成的大部分代码无法执行，任务失败率高 |
| Python 性能不可用 | 重要 | 数据科学场景体验极差，核心场景退化 |

### 建议下一步

1. **先修 Blocker #1**：在 Spec A §7 中补全 `messages→Context` 转换层的设计（含 `completeSimple` 路径评估）。
2. **先修 Blocker #2**：明确 bash/Python 解释器的调用路径——或诚实降级 v1 为 TS-only + 预留。
3. **统一 taskStore 接口**：Spec B + Spec C + task-pool sorter 三方对齐接口签名后重审。
4. **修复重要级运行风险**：#4（空转检测）、#5（import 前置拒绝）、#6（Python 使用边界声明）。
5. 次要问题可在实现阶段消化，不阻塞批准。
