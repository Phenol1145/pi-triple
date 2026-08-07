# PTH kernel Spec A：解释器世界（多解释器 + llm 函数 + 能力注入）

- **日期**：2026-08-07
- **状态**：设计（总纲 spec §5 分 spec A，待用户审阅）
- **定位**：PTH kernel 的执行主体——三解释器（TS vm / bash / Python）+ llm 函数 + 能力注入模型 + 解释器抽象接口。
- **依赖**：总纲 spec（§4 裁决 3/5/6/8/23）+ Spec C（存储——数据世界访问接口）
- **执行顺序**：C → A（本 spec）→ B

---

## 1. 目标与非目标

### 目标（v1）

1. **解释器抽象接口**：`Interpreter` 统一接口（execute(program)、持久状态、数据世界访问、生命周期）
2. **TS 解释器**：node:vm 持久 context + stripTypeScriptTypes（零新依赖）
3. **bash 解释器**：持久 shell 会话（经 sandbox 隔离——不可信代码）
4. **Python 解释器**：Python 运行时集成（数据科学/ML 生态）
5. **llm 函数**：`llm.complete()` 注入数据世界（可函数式调用；多模型）
6. **能力注入模型**：context 默认空，只注入白名单（llm + 数据世界访问）；语言层面无能力
7. **worker 组装**：一个 worker = 三解释器实例 + llm 函数 + 数据世界连接（Spec B 消费）

### 非目标（明确不做）

- ⛔ 沙箱安全保证（官方：vm 非沙箱——安全 = 能力注入 + 步数/超时 + 来源可信）
- ⛔ top-level await 支持（vm.SourceTextModule 在 Node 24 不可用——v1 不支持，文档化）
- ⛔ 指令数限制（vm 只有 timeout 无指令数——v1 用 timeout + 步数检查 workaround）
- ⛔ Python 内核的完整 IPython 语义（v1 = 进程内子进程执行，非 Jupyter 内核）
- ⛔ skill 展开三通道（markdown→prompt/代码→context 函数/工具→方法）——skill 数据化后简化，v1 只做数据对象读取

## 2. 架构

```
src/pth/kernel/interpreter/
├── types.ts             Interpreter 抽象接口 + InterpreterResult + 执行上下文
├── ts-interpreter.ts    TS 解释器（vm context + stripTypeScriptTypes）
├── bash-interpreter.ts  bash 解释器（持久 shell 会话 + sandbox 转发）
├── python-interpreter.ts Python 解释器（子进程 + REPL 协议）
├── llm-fn.ts            llm.complete 函数（model-router 基础）
├── capability.ts        能力注入模型（白名单 + 数据世界访问注入）
└── index.ts             worker 组装（三解释器 + llm + 数据世界 → WorkerKernel）
```

## 3. 解释器抽象接口

```ts
/** 统一解释器接口（P5：所有解释器同构——语言 + 持久状态 + 数据世界访问） */
export interface Interpreter {
  /** 语言标识：ts | bash | python */
  readonly language: string;
  /** 执行一段程序（表达式/语句/脚本），返回结构化结果 */
  execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult>;
  /** 持久上下文状态（进程内热态；跨 execute 保留） */
  readonly state: Record<string, unknown>;
  /** 重置持久状态（新任务/会话） */
  reset(): void;
  /** 释放资源 */
  dispose(): void;
}

export interface ExecuteOptions {
  timeoutMs?: number;       // 默认 300_000（对齐 DEFAULT_EXECUTION_TIMEOUT_MS）
  stepLimit?: number;       // 步数上限（TS 解释器 workaround：注入计数器）
  cwd?: string;             // 工作目录（任务级工作区）
  env?: Record<string, string>;
}

export interface InterpreterResult {
  ok: boolean;
  value?: unknown;          // 求值结果（JSON 序列化友好）
  stdout?: string;
  stderr?: string;
  error?: { message: string; stack?: string };
  durationMs: number;
}
```

## 4. TS 解释器（ts-interpreter.ts）

### 4.1 核心机制

```ts
import { createContext, runInContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";

export class TsInterpreter implements Interpreter {
  readonly language = "ts";
  private context: vm.Context;

  constructor(deps: { capabilities: Record<string, unknown>; timeoutMs?: number }) {
    // context 默认空，只注入白名单能力（能力注入模型，PTH kernel 不变量 8）
    this.context = createContext({ ...deps.capabilities });
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    try {
      // TS → JS（strip types，Node 22.6+；Node 24 实测可用）
      const js = stripTypeScriptTypes(program);
      // 步数守卫 workaround（vm 无指令数限制）：注入计数器到程序前
      const guarded = withStepGuard(js, opts?.stepLimit ?? 1000);
      const result = runInContext(guarded, this.context, {
        timeout: opts?.timeoutMs ?? this.timeoutMs,
      });
      return { ok: true, value: normalize(result), durationMs: Date.now() - start };
    } catch (e) {
      return { ok: false, error: { message: (e as Error).message, stack: (e as Error).stack }, durationMs: Date.now() - start };
    }
  }

  reset() { /* 重建 context（清空状态，保留能力） */ }
  dispose() { /* 释放 */ }
}
```

### 4.2 能力注入模型（capability.ts）

```ts
/**
 * 能力注入：context 默认空，只注入白名单。
 * 不注入 fs/child_process/net——语言层面无能力（比运行时对抗更可靠）。
 * 安全 = 能力注入 + timeout + 步数守卫 + 来源可信（worker 只执行任务程序）。
 */
export function buildCapabilities(deps: {
  llm: LlmFn;                        // llm.complete
  dataWorld: DataWorldAccess;        // 记忆/skill/任务读写（Spec C）
  logger?: Logger;
}): Record<string, unknown> {
  return {
    llm: deps.llm,
    memory: deps.dataWorld.memory,   // 记忆读写（接口保留自 2026-08-02 spec）
    skills: deps.dataWorld.skills,   // skill 数据对象读取
    tasks: deps.dataWorld.tasks,     // 任务动词（peek/claim/reject/submit）
  };
}
```

### 4.3 步数守卫 workaround（vm 无指令数限制）

```ts
/** 注入步数计数器：包装程序为带计数循环的版本（v1 简化：仅顶层语句计数 + 超时兜底） */
function withStepGuard(js: string, stepLimit: number): string {
  // v1：不做语句插桩（复杂）——用 timeout 兜底 + 文档化限制。
  // 预留：未来可注入 __stepCounter 到每个语句（需要 AST 变换，v2）。
  return js;
}
```

**v1 诚实声明**：步数守卫 v1 = timeout 兜底（不做 AST 插桩）。指令数精确限制留 v2。

## 5. bash 解释器（bash-interpreter.ts）

### 5.1 核心机制

```ts
/**
 * bash 解释器：持久 shell 会话。
 * 隔离 = sandbox 容器（不可信代码经 sandbox /exec 转发，现状 SandboxExecClient 复用）。
 * 持久状态：会话内 cwd/env/历史（bash -lc 每次命令独立；持久 shell 用 tmux/pty 或
 *   状态传递（cd 链）——v1 用状态传递：每次执行前注入上次 cwd/env）。
 */
export class BashInterpreter implements Interpreter {
  readonly language = "bash";
  private state = { cwd: "/data/workspaces", env: {} as Record<string, string> };

  constructor(deps: { sandbox: SandboxExecClient; cwdWhitelist?: string[] }) {}

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    // 状态传递：注入上次 cwd + env（持久会话语义的 v1 近似）
    const cmd = `cd ${this.state.cwd} && ${program}`;
    const res = await this.deps.sandbox.exec(cmd, {
      cwd: opts?.cwd ?? this.state.cwd,
      timeoutMs: opts?.timeoutMs,
    });
    // 从输出提取新 cwd（pwd 探测）——v1 简化：不自动提取，cwd 由任务工作区决定
    this.state.cwd = opts?.cwd ?? this.state.cwd;
    return { ok: res.ok, stdout: res.stdout, stderr: res.stderr, durationMs: res.durationMs };
  }

  reset() { this.state = { cwd: "/data/workspaces", env: {} }; }
  dispose() {}
}
```

**v1 诚实声明**：持久 shell 会话（真 pty）v1 不实现——用"状态传递"近似（cwd/env 在命令间传递）。真 pty 留 v2（需要 tmux/pty 依赖）。

## 6. Python 解释器（python-interpreter.ts）

### 6.1 核心机制

```ts
/**
 * Python 解释器：子进程 + REPL 协议（v1 简化）。
 * 持久状态：进程内全局变量（单次执行进程存活期内）——v1 每次 execute 一个新子进程
 *   （无持久 REPL），持久会话 v2（如 python-shell/pyodide）。
 * 数据科学/ML 生态：子进程可 import numpy/pandas 等（容器内预装）。
 */
export class PythonInterpreter implements Interpreter {
  readonly language = "python";

  constructor(deps: { pythonBin?: string; timeoutMs?: number }) {}

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    // spawn python3 -c <program>（或 heredoc）；超时杀进程组
    // v1：无持久状态（每次新进程）；stdout/stderr 捕获；exit code → ok
  }

  reset() {}
  dispose() {}
}
```

**v1 诚实声明**：Python v1 = 无状态子进程（每次执行新进程）——持久 REPL 留 v2。Prime Agent 的 IPython 持久语义在 TS 解释器（vm context）上完整实现，Python 先求能跑。

## 7. llm 函数（llm-fn.ts）

```ts
/**
 * llm.complete —— LLM 作为数据处理算法（范式 P4）。
 * 基于 model-router（pi 保留，裁决 8）：provider 兼容/密钥/failover 全走 pi。
 */
export interface LlmFn {
  complete(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    opts?: {
      model?: string;           // 默认 = model-router 默认
      provider?: string;
      thinking?: "off" | "low" | "medium" | "high";
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ content: string; model: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
}

export function createLlmFn(deps: {
  modelRouter: ModelRouter;      // src/shared/model-router（pi 保留）
  logger?: Logger;
}): LlmFn {
  return async (messages, opts) => {
    const model = deps.modelRouter.resolve(opts?.provider, opts?.model);
    // 经 modelRouter.getRuntime() 调用（pi SDK ModelRuntime——provider 兼容层）
    // 可编程：调用方可在任意位置/任意次数调用（嵌套/链式/多模型并行）
    // withTimeout 包装（对齐 DEFAULT_EXECUTION_TIMEOUT_MS）+ AbortSignal 中止
  };
}
```

## 8. worker 组装（index.ts）

```ts
/**
 * WorkerKernel —— 一个 worker = 三解释器 + llm 函数 + 数据世界连接。
 * Spec B（执行层）消费：batch 进程内每个 worker 类型实例化一个 WorkerKernel。
 */
export interface WorkerKernel {
  ts: Interpreter;
  bash: Interpreter;
  python: Interpreter;
  llm: LlmFn;
  dataWorld: DataWorldAccess;    // Spec C 的存储访问
  reset(): void;                 // 新任务开始时重置（任务级状态隔离）
  dispose(): void;
}

export function createWorkerKernel(deps: {
  modelRouter: ModelRouter;
  dataWorld: DataWorldAccess;
  sandbox?: SandboxExecClient;
  pythonBin?: string;
}): WorkerKernel {
  const llm = createLlmFn({ modelRouter: deps.modelRouter });
  const capabilities = buildCapabilities({ llm, dataWorld: deps.dataWorld });
  return {
    ts: new TsInterpreter({ capabilities }),
    bash: new BashInterpreter({ sandbox: deps.sandbox! }),
    python: new PythonInterpreter({ pythonBin: deps.pythonBin }),
    llm,
    dataWorld: deps.dataWorld,
    reset() { this.ts.reset(); this.bash.reset(); this.python.reset(); },
    dispose() { this.ts.dispose(); this.bash.dispose(); this.python.dispose(); },
  };
}
```

## 9. 与 B spec 的接口

- **Spec B（执行层）** 消费：`WorkerKernel`（createWorkerKernel）、`Interpreter.execute`、`llm.complete`
- worker 生命周期：任务认领 → `kernel.reset()` → 执行 → 提交 → 归档（Spec B 管）

## 10. 不变量

1. context 默认空，只注入白名单能力（llm/memory/skills/tasks）——语言层面无能力
2. 不注入 fs/child_process/net 到 vm context（不可信代码能力边界）
3. 所有 execute 带 timeout（默认 300_000，对齐既有常量）
4. vm 非沙箱（官方）——安全 = 能力注入 + timeout + 来源可信（worker 只执行任务程序）
5. llm.complete 经 model-router（provider 兼容 pi 保留）
6. bash 经 sandbox 转发（不可信代码隔离）
7. Python v1 = 无状态子进程（持久 REPL v2）
8. TS 解释器 = 唯一持久上下文（vm context）；bash/python v1 状态传递/无状态
9. top-level await 不支持（Node 24 vm.SourceTextModule 不可用）——文档化
10. 零新依赖优先（Python 解释器可引 python-shell 类库，其余用 node 内置）

## 11. 相关参考

- 总纲：`docs/superpowers/specs/2026-08-07-pth-kernel-architecture.md`（裁决 3/5/6/8/23）
- Spec C：`docs/superpowers/specs/2026-08-07-pth-kernel-storage.md`（数据世界访问接口）
- model-router：`src/shared/model-router/router.ts`（ModelRouter.resolve/getRuntime）
- withTimeout：`extensions/agent-lab/src/scheduler/with-timeout.ts`（既有常量对齐）
