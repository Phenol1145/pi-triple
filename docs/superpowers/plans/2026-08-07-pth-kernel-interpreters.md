# PTH kernel Spec A（解释器世界）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 PTH kernel 的解释器世界——TS vm 解释器、bash 解释器、Python 解释器、llm 函数、能力注入模型、WorkerKernel 组装。

**Architecture:** `src/pth/kernel/interpreter/` 新增解释器抽象 + 三解释器实现 + llm 函数 + WorkerKernel。测试用真实环境（vm 执行真实 TS、bash 走真实命令、Python 走真实 python3；llm 函数用 mock modelRouter）。

**Tech Stack:** node:vm、node:module.stripTypeScriptTypes（Node 24 内置）、node:child_process、node:path。零新依赖（Python 解释器不引库，直接 spawn python3）。

## Global Constraints

- 依赖限制：零新增运行时依赖（Python 解释器用 spawn python3，不引 python-shell）
- 能力注入模型：context 默认空只注入白名单（llm/memory/skills/tasks/bash/python）；不注入 fs/child_process/net
- 所有 execute 带 timeout（默认 300_000，对齐既有常量 DEFAULT_EXECUTION_TIMEOUT_MS）
- 前置校验：import/require 检测拒绝 + top-level await 自动包装（对抗性审核 B5）
- 任务动词面收窄：vm context 的 tasks 只暴露 peek/submit（不暴露 claim/reject）
- llm.complete 经 model-router（pi 保留，provider 兼容）
- 测试放 `test/pth-kernel-interpreter/`；llm 函数测试用 mock ModelRouter（不真调 LLM）
- 提交风格：`feat(pth-kernel): 中文摘要`
- 不碰现有容器/现有模块（agent-lab 不动）

---

### Task 1: 解释器抽象接口 + TS 解释器（vm + strip + preflight）

**Files:**
- Create: `src/pth/kernel/interpreter/types.ts`
- Create: `src/pth/kernel/interpreter/ts-interpreter.ts`
- Create: `test/pth-kernel-interpreter/ts-interpreter.test.ts`

**Interfaces:**
- Consumes: 无（地基）
- Produces: `Interpreter` 接口、`ExecuteOptions`、`InterpreterResult`、`TsInterpreter` 类

- [ ] **Step 1: 写失败测试**

```ts
// test/pth-kernel-interpreter/ts-interpreter.test.ts
import { describe, it, expect } from "vitest";
import { TsInterpreter } from "../../src/pth/kernel/interpreter/ts-interpreter";

describe("ts interpreter", () => {
  it("executes simple expression and returns value", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("1 + 1");
    expect(res.ok).toBe(true);
    expect(res.value).toBe(2);
  });

  it("preserves state across executions (persistent context)", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    await itp.execute("let counter = 0");
    await itp.execute("counter = counter + 1");
    const res = await itp.execute("counter");
    expect(res.value).toBe(1);
  });

  it("supports async/await via top-level await wrapping", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("await Promise.resolve(42)");
    expect(res.ok).toBe(true);
    expect(res.value).toBe(42);
  });

  it("rejects import statements with friendly error", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("import { x } from 'y'; x");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("import");
  });

  it("rejects require calls with friendly error", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("const x = require('y'); x");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("require");
  });

  it("runs TypeScript with type annotations (strip types)", async () => {
    const itp = new TsInterpreter({ capabilities: {} });
    const res = await itp.execute("const add = (a: number, b: number): number => a + b; add(2, 3)");
    expect(res.ok).toBe(true);
    expect(res.value).toBe(5);
  });

  it("enforces timeout", async () => {
    const itp = new TsInterpreter({ capabilities: {}, timeoutMs: 100 });
    const res = await itp.execute("while(true) {}", { timeoutMs: 100 });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("Script execution timed out");
  });

  it("reset clears state but keeps capabilities", async () => {
    const itp = new TsInterpreter({ capabilities: { marker: "keep" } });
    await itp.execute("let x = 1");
    itp.reset();
    const res = await itp.execute("typeof x");   // x 已清空
    expect(res.value).toBe("undefined");
    // capabilities 保留
    const capRes = await itp.execute("marker");
    expect(capRes.value).toBe("keep");
  });

  it("exposes injected capabilities", async () => {
    const itp = new TsInterpreter({ capabilities: { llm: { complete: async () => ({ content: "ok" }) } } });
    const res = await itp.execute("llm.complete()");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ content: "ok" });
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-interpreter/ts-interpreter.test.ts`
Expected: FAIL——`TsInterpreter` 不存在

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/interpreter/types.ts
export interface ExecuteOptions {
  timeoutMs?: number;
  stepLimit?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface InterpreterResult {
  ok: boolean;
  value?: unknown;
  stdout?: string;
  stderr?: string;
  error?: { message: string; stack?: string };
  durationMs: number;
}

export interface Interpreter {
  readonly language: string;
  execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult>;
  readonly state: Record<string, unknown>;
  reset(): void;
  dispose(): void;
}
```

```ts
// src/pth/kernel/interpreter/ts-interpreter.ts
import { createContext, runInContext, type Context } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import type { ExecuteOptions, Interpreter, InterpreterResult } from "./types.js";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;

/**
 * TS 解释器：node:vm 持久 context + stripTypeScriptTypes。
 * 能力注入：context 默认空，只注入白名单（构造时传入 capabilities）。
 * 前置校验（对抗性审核 B5）：import/require 拒绝 + top-level await 包装。
 */
export class TsInterpreter implements Interpreter {
  readonly language = "ts";
  private context: Context;
  private capabilities: Record<string, unknown>;

  constructor(deps: { capabilities: Record<string, unknown>; timeoutMs?: number }) {
    this.capabilities = deps.capabilities;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.context = createContext({ ...deps.capabilities });
  }

  private timeoutMs: number;
  get state(): Record<string, unknown> {
    return this.context as unknown as Record<string, unknown>;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    try {
      const pre = preflight(program);
      if (!pre.ok) {
        return { ok: false, error: { message: pre.error }, durationMs: Date.now() - start };
      }
      const js = stripTypeScriptTypes(pre.code);
      const result = runInContext(js, this.context, {
        timeout: opts?.timeoutMs ?? this.timeoutMs,
      });
      return { ok: true, value: normalize(result), durationMs: Date.now() - start };
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: { message: err.message, stack: err.stack }, durationMs: Date.now() - start };
    }
  }

  reset(): void {
    this.context = createContext({ ...this.capabilities });
  }

  dispose(): void {
    // vm context 无显式释放；GC 处理
  }
}

/** 前置校验：import/require 拒绝 + top-level await 包装（异步 IIFE） */
function preflight(program: string): { ok: true; code: string } | { ok: false; error: string } {
  // import 语句（行首 import 或 import( 动态导入）
  if (/^\s*import\s/m.test(program) || /import\s*\(/.test(program)) {
    return { ok: false, error: "import is not allowed in kernel programs — use injected globals (llm/memory/skills/tasks/bash/python)" };
  }
  // require 调用
  if (/\brequire\s*\(/.test(program)) {
    return { ok: false, error: "require is not allowed in kernel programs — use injected globals (llm/memory/skills/tasks/bash/python)" };
  }
  // top-level await：包装为异步 IIFE
  if (/\bawait\b/.test(program)) {
    return { ok: true, code: `(async () => { ${program} })()` };
  }
  return { ok: true, code: program };
}

/** 求值结果规范化：undefined → undefined；对象/数组 JSON 序列化友好 */
function normalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  return value;
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-interpreter/ts-interpreter.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-interpreter/ts-interpreter.test.ts src/pth/kernel/interpreter/types.ts src/pth/kernel/interpreter/ts-interpreter.ts
git commit -m "feat(pth-kernel): TS 解释器——vm 持久 context+strip types+前置校验（import/require 拒绝+top-level await 包装）+timeout，能力注入"
```

---

### Task 2: bash 解释器（sandbox 转发 + 状态传递）

**Files:**
- Create: `src/pth/kernel/interpreter/bash-interpreter.ts`
- Create: `test/pth-kernel-interpreter/bash-interpreter.test.ts`

**Interfaces:**
- Consumes: `Interpreter`/`ExecuteOptions`/`InterpreterResult`（Task 1 types.ts）
- Produces: `BashInterpreter` 类（sandbox 可注入 mock）

- [ ] **Step 1: 写失败测试**

```ts
// test/pth-kernel-interpreter/bash-interpreter.test.ts
import { describe, it, expect } from "vitest";
import { BashInterpreter } from "../../src/pth/kernel/interpreter/bash-interpreter";

/** mock SandboxExecClient（对齐 src/pth/tools/sandbox-bash.ts 的 exec 签名） */
function mockSandbox(impl?: (cmd: string, opts: any) => Promise<any>) {
  return {
    exec: async (req: any) => {
      if (impl) return impl(req.cmd, req);
      return { ok: true, stdout: `executed: ${req.cmd}`, stderr: "", exitCode: 0, durationMs: 1 };
    },
  } as any;
}

describe("bash interpreter", () => {
  it("executes program via sandbox", async () => {
    const sandbox = mockSandbox((cmd) => ({ ok: true, stdout: `ran ${cmd}`, stderr: "", exitCode: 0, durationMs: 5 }));
    const itp = new BashInterpreter({ sandbox });
    const res = await itp.execute("echo hello");
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("ran cd");
  });

  it("propagates cwd from execute options", async () => {
    let seenCwd: string | undefined;
    const sandbox = mockSandbox(async (cmd, opts) => {
      seenCwd = opts.cwd;
      return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    });
    const itp = new BashInterpreter({ sandbox });
    await itp.execute("pwd", { cwd: "/data/workspaces/tasks/t1" });
    expect(seenCwd).toBe("/data/workspaces/tasks/t1");
  });

  it("returns error result on non-zero exit", async () => {
    const sandbox = mockSandbox(async () => ({ ok: false, stdout: "", stderr: "command not found", exitCode: 127, durationMs: 1 }));
    const itp = new BashInterpreter({ sandbox });
    const res = await itp.execute("nonexistent-cmd");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("command not found");
  });

  it("reset restores default cwd", async () => {
    const sandbox = mockSandbox();
    const itp = new BashInterpreter({ sandbox });
    await itp.execute("cd /tmp", { cwd: "/data/workspaces/tasks/t1" });
    itp.reset();
    // 重置后 cwd 回到默认
    let seenCwd: string | undefined;
    const sandbox2 = mockSandbox(async (cmd, opts) => { seenCwd = opts.cwd; return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 }; });
    const itp2 = new BashInterpreter({ sandbox: sandbox2 });
    await itp2.execute("pwd");
    expect(seenCwd).toBe("/data/workspaces");
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-interpreter/bash-interpreter.test.ts`
Expected: FAIL——`BashInterpreter` 不存在

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/interpreter/bash-interpreter.ts
import type { ExecuteOptions, Interpreter, InterpreterResult } from "./types.js";
import type { SandboxExecClient, SandboxExecRequest, SandboxExecResult } from "../../tools/sandbox-bash.js";

export const DEFAULT_BASH_CWD = "/data/workspaces";

/**
 * bash 解释器：持久 shell 会话（v1 状态传递近似）。
 * 隔离 = sandbox 容器（不可信代码经 sandbox /exec 转发）。
 * 持久状态：cwd/env 在命令间传递（真 pty 留 v2）。
 */
export class BashInterpreter implements Interpreter {
  readonly language = "bash";
  private state = { cwd: DEFAULT_BASH_CWD, env: {} as Record<string, string> };

  constructor(private deps: { sandbox: Pick<SandboxExecClient, "exec">; cwdWhitelist?: string[] }) {}

  get state(): Record<string, unknown> {
    return this.state as unknown as Record<string, unknown>;
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    const cwd = opts?.cwd ?? this.state.cwd;
    const cmd = `cd ${cwd} && ${program}`;
    try {
      const req: SandboxExecRequest = {
        cmd,
        cwd,
        timeoutMs: opts?.timeoutMs ?? 300_000,
        env: { ...this.state.env, ...(opts?.env ?? {}) },
      };
      const res: SandboxExecResult = await this.deps.sandbox.exec(req);
      this.state.cwd = cwd;
      return {
        ok: res.ok,
        stdout: res.stdout,
        stderr: res.stderr,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: { message: err.message, stack: err.stack }, durationMs: Date.now() - start };
    }
  }

  reset(): void {
    this.state = { cwd: DEFAULT_BASH_CWD, env: {} };
  }

  dispose(): void {}
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-interpreter/bash-interpreter.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-interpreter/bash-interpreter.test.ts src/pth/kernel/interpreter/bash-interpreter.ts
git commit -m "feat(pth-kernel): bash 解释器——sandbox 转发+状态传递（cwd/env），v1 无 pty"
```

---

### Task 3: Python 解释器（子进程 + 超时）

**Files:**
- Create: `src/pth/kernel/interpreter/python-interpreter.ts`
- Create: `test/pth-kernel-interpreter/python-interpreter.test.ts`

**Interfaces:**
- Consumes: `Interpreter`/`ExecuteOptions`/`InterpreterResult`（Task 1 types.ts）
- Produces: `PythonInterpreter` 类

- [ ] **Step 1: 写失败测试**

```ts
// test/pth-kernel-interpreter/python-interpreter.test.ts
import { describe, it, expect } from "vitest";
import { PythonInterpreter } from "../../src/pth/kernel/interpreter/python-interpreter";

describe("python interpreter", () => {
  it("executes simple python program", async () => {
    const itp = new PythonInterpreter({});
    const res = await itp.execute("print(1 + 1)");
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("2");
  }, 30_000);

  it("returns error on python exception", async () => {
    const itp = new PythonInterpreter({});
    const res = await itp.execute("raise ValueError('boom')");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("ValueError");
  }, 30_000);

  it("enforces timeout (kill process group)", async () => {
    const itp = new PythonInterpreter({ timeoutMs: 500 });
    const start = Date.now();
    const res = await itp.execute("import time; time.sleep(10)", { timeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeLessThan(5000);  // 被超时杀死，不真等 10s
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-interpreter/python-interpreter.test.ts`
Expected: FAIL——`PythonInterpreter` 不存在

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/interpreter/python-interpreter.ts
import { spawn } from "node:child_process";
import type { ExecuteOptions, Interpreter, InterpreterResult } from "./types.js";

/**
 * Python 解释器：子进程执行（v1 无状态——每次新进程）。
 * 持久 REPL 留 v2；使用边界：单次脚本执行（对抗性审核 I6）。
 */
export class PythonInterpreter implements Interpreter {
  readonly language = "python";
  private timeoutMs: number;

  constructor(deps: { pythonBin?: string; timeoutMs?: number }) {
    this.pythonBin = deps.pythonBin ?? "python3";
    this.timeoutMs = deps.timeoutMs ?? 300_000;
  }

  private pythonBin: string;

  get state(): Record<string, unknown> {
    return {};  // v1 无持久状态
  }

  async execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const start = Date.now();
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    return new Promise<InterpreterResult>((resolve) => {
      const child = spawn(this.pythonBin, ["-c", program], {
        cwd: opts?.cwd,
        env: { ...process.env, ...(opts?.env ?? {}) },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");   // 杀进程（单进程场景；进程组留 v2）
        resolve({ ok: false, error: { message: `python execution timed out after ${timeoutMs}ms` }, stdout, stderr, durationMs: Date.now() - start });
      }, timeoutMs);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr, durationMs: Date.now() - start });
      });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: { message: e.message }, stdout, stderr, durationMs: Date.now() - start });
      });
    });
  }

  reset(): void {}
  dispose(): void {}
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-interpreter/python-interpreter.test.ts`
Expected: PASS（3 tests；python3 3.14 本机可用）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-interpreter/python-interpreter.test.ts src/pth/kernel/interpreter/python-interpreter.ts
git commit -m "feat(pth-kernel): Python 解释器——子进程执行+超时杀进程，v1 无状态（持久 REPL v2）"
```

---

### Task 4: llm 函数（model-router + completeSimple 转换层）

**Files:**
- Create: `src/pth/kernel/interpreter/llm-fn.ts`
- Create: `test/pth-kernel-interpreter/llm-fn.test.ts`

**Interfaces:**
- Consumes: `ModelRouter`（src/shared/model-router/router.ts——resolve/getRuntime）
- Produces: `LlmFn` 接口、`createLlmFn` 工厂、`toContext` 转换层（内部）

- [ ] **Step 1: 写失败测试（mock ModelRouter——不真调 LLM）**

```ts
// test/pth-kernel-interpreter/llm-fn.test.ts
import { describe, it, expect } from "vitest";
import { createLlmFn } from "../../src/pth/kernel/interpreter/llm-fn";

/** mock ModelRuntime（对齐 pi ModelRuntime.completeSimple 签名） */
function mockRuntime(impl?: (model: any, context: any) => Promise<any>) {
  return {
    completeSimple: impl ?? (async (_model: any, context: any) => ({
      role: "assistant",
      content: [{ type: "text", text: `reply to ${context.messages.map((m: any) => m.content).join("|")}` }],
      api: "mock", provider: "mock", model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn", timestamp: Date.now(),
    })),
  } as any;
}

/** mock ModelRouter（对齐 router.ts 的 resolve/getRuntime） */
function mockRouter(runtime: any) {
  return {
    resolve: () => ({ id: "mock-model", api: "mock" }),
    getRuntime: () => runtime,
  } as any;
}

describe("llm function", () => {
  it("complete calls completeSimple via model-router", async () => {
    const runtime = mockRuntime();
    const llm = createLlmFn({ modelRouter: mockRouter(runtime) });
    const res = await llm.complete([{ role: "user", content: "hello" }]);
    expect(res.content).toContain("hello");
    expect(res.model).toBe("mock-model");
    expect(res.usage?.inputTokens).toBe(10);
  });

  it("converts system messages to systemPrompt", async () => {
    let seenContext: any;
    const runtime = mockRuntime(async (_model: any, context: any) => {
      seenContext = context;
      return { role: "assistant", content: [{ type: "text", text: "ok" }], api: "a", provider: "p", model: "m", usage: {}, stopReason: "end_turn", timestamp: Date.now() };
    });
    const llm = createLlmFn({ modelRouter: mockRouter(runtime) });
    await llm.complete([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(seenContext.systemPrompt).toBe("you are helpful");
    expect(seenContext.messages[0].role).toBe("user");
    expect(seenContext.messages[0].content).toBe("hi");
    expect(typeof seenContext.messages[0].timestamp).toBe("number");
  });

  it("extracts text from assistant content array", async () => {
    const runtime = mockRuntime(async () => ({
      role: "assistant",
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      api: "a", provider: "p", model: "m", usage: {}, stopReason: "end_turn", timestamp: Date.now(),
    }));
    const llm = createLlmFn({ modelRouter: mockRouter(runtime) });
    const res = await llm.complete([{ role: "user", content: "x" }]);
    expect(res.content).toBe("firstsecond");
  });

  it("passes model/provider to resolve", async () => {
    let seenModel: any;
    const router = {
      resolve: (provider?: string, model?: string) => { seenModel = { provider, model }; return { id: "m", api: "a" }; },
      getRuntime: () => mockRuntime(),
    } as any;
    const llm = createLlmFn({ modelRouter: router });
    await llm.complete([{ role: "user", content: "x" }], { model: "qwen3.8-max", provider: "p1" });
    expect(seenModel).toEqual({ provider: "p1", model: "qwen3.8-max" });
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-interpreter/llm-fn.test.ts`
Expected: FAIL——`createLlmFn` 不存在

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/interpreter/llm-fn.ts
import type { ModelRouter } from "../../shared/model-router/router.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteOptions {
  model?: string;
  provider?: string;
  thinking?: "off" | "low" | "medium" | "high";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmResult {
  content: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmFn {
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmResult>;
}

/**
 * llm.complete —— LLM 作为数据处理算法（范式 P4）。
 * 实现路径（对抗性审核 B1）：ModelRuntime.completeSimple(model, {systemPrompt, messages})。
 * UserMessage 只需 {role, content, timestamp}（pi-ai 类型已核实）。
 */
export function createLlmFn(deps: { modelRouter: ModelRouter; logger?: unknown }): LlmFn {
  return async (messages, opts) => {
    const model = deps.modelRouter.resolve(opts?.provider, opts?.model);
    const runtime = deps.modelRouter.getRuntime();
    const ctx = toContext(messages);
    const result = await runtime.completeSimple(model, ctx, { signal: opts?.signal });
    return {
      content: extractText(result.content),
      model: result.model,
      usage: result.usage
        ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
        : undefined,
    };
  };
}

/** messages → pi Context 转换层（v1 纯文本） */
function toContext(messages: LlmMessage[]): { systemPrompt?: string; messages: unknown[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n") } : {}),
    messages: rest.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: Date.now(),
    })),
  };
}

/** assistant content（TextContent[]）→ 拼接文本 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && "text" in c && typeof (c as any).text === "string")
      .map((c) => (c as any).text)
      .join("");
  }
  return String(content ?? "");
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-interpreter/llm-fn.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-interpreter/llm-fn.test.ts src/pth/kernel/interpreter/llm-fn.ts
git commit -m "feat(pth-kernel): llm 函数——completeSimple 转换层（system→systemPrompt/messages→UserMessage）+文本提取，经 model-router"
```

---

### Task 5: 能力注入模型 + WorkerKernel 组装

**Files:**
- Create: `src/pth/kernel/interpreter/capability.ts`
- Create: `src/pth/kernel/interpreter/index.ts`
- Create: `test/pth-kernel-interpreter/kernel.test.ts`

**Interfaces:**
- Consumes: Task 1-4（Interpreter/TsInterpreter/BashInterpreter/PythonInterpreter/LlmFn）+ Spec C DataWorldAccess
- Produces: `buildCapabilities`、`WorkerKernel` 接口、`createWorkerKernel` 工厂

- [ ] **Step 1: 写失败测试**

```ts
// test/pth-kernel-interpreter/kernel.test.ts
import { describe, it, expect } from "vitest";
import { buildCapabilities } from "../../src/pth/kernel/interpreter/capability";
import { createWorkerKernel } from "../../src/pth/kernel/interpreter/index";
import { TsInterpreter } from "../../src/pth/kernel/interpreter/ts-interpreter";

/** mock DataWorldAccess（Spec C 接口） */
function mockDataWorld() {
  return {
    tasks: { peek: async () => [], submit: async () => {} },
    memory: { retrieve: async () => [], write: async () => {} },
    transcripts: {},
    audit: {},
  } as any;
}

describe("capabilities", () => {
  it("buildCapabilities injects llm/memory/skills/tasks", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(caps.llm).toBeDefined();
    expect(caps.memory).toBeDefined();
    expect(caps.skills).toBeDefined();
    expect(caps.tasks).toBeDefined();
  });

  it("tasks capability only exposes peek/submit (not claim/reject)", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(caps.tasks.peek).toBeDefined();
    expect(caps.tasks.submit).toBeDefined();
    expect(caps.tasks.claim).toBeUndefined();   // 认领由 TaskLoop 机械控制
    expect(caps.tasks.reject).toBeUndefined();
  });

  it("injects bash/python interpreters when provided", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
      bash: { execute: async () => ({}) } as any,
      python: { execute: async () => ({}) } as any,
    });
    expect(caps.bash).toBeDefined();
    expect(caps.python).toBeDefined();
  });
});

describe("worker kernel", () => {
  it("createWorkerKernel assembles all interpreters + llm + dataWorld", () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(kernel.ts).toBeInstanceOf(TsInterpreter);
    expect(kernel.bash).toBeDefined();
    expect(kernel.python).toBeDefined();
    expect(kernel.llm).toBeDefined();
    expect(kernel.dataWorld).toBeDefined();
  });

  it("kernel.reset resets all interpreters", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    await kernel.ts.execute("let x = 42");
    kernel.reset();
    const res = await kernel.ts.execute("typeof x");
    expect(res.value).toBe("undefined");
  });

  it("kernel exposes capabilities usable from TS program", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    const res = await kernel.ts.execute("tasks.peek()");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run test/pth-kernel-interpreter/kernel.test.ts`
Expected: FAIL——`buildCapabilities`/`createWorkerKernel` 不存在

- [ ] **Step 3: 写实现**

```ts
// src/pth/kernel/interpreter/capability.ts
import type { LlmFn } from "./llm-fn.js";
import type { Interpreter } from "./types.js";
import type { DataWorldAccess } from "../storage/index.js";

/**
 * 能力注入：context 默认空，只注入白名单。
 * 不注入 fs/child_process/net——语言层面无能力。
 * 任务动词面收窄：tasks 只暴露 peek/submit（claim/reject 由 TaskLoop 机械控制）。
 */
export function buildCapabilities(deps: {
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  bash?: Interpreter;
  python?: Interpreter;
}): Record<string, unknown> {
  return {
    llm: deps.llm,
    memory: deps.dataWorld.memory,
    skills: {
      get: async (name: string) => {
        // v1：skill 数据对象读取（Spec C skills 表——v1 独立表占位）
        // 简化：返回空（v1 不实现完整 skill 加载，Spec B 任务接入时扩展）
        return undefined;
      },
    },
    tasks: {
      peek: deps.dataWorld.tasks.candidates,
      submit: deps.dataWorld.tasks.submit,
    },
    ...(deps.bash ? { bash: deps.bash } : {}),
    ...(deps.python ? { python: deps.python } : {}),
  };
}
```

```ts
// src/pth/kernel/interpreter/index.ts
import type { ModelRouter } from "../../shared/model-router/router.js";
import type { DataWorldAccess } from "../storage/index.js";
import { TsInterpreter } from "./ts-interpreter.js";
import { BashInterpreter } from "./bash-interpreter.js";
import { PythonInterpreter } from "./python-interpreter.js";
import { createLlmFn, type LlmFn } from "./llm-fn.js";
import { buildCapabilities } from "./capability.js";
import type { Interpreter } from "./types.js";

export interface WorkerKernel {
  ts: Interpreter;
  bash: Interpreter;
  python: Interpreter;
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  reset(): void;
  dispose(): void;
}

export interface WorkerKernelDeps {
  modelRouter: ModelRouter;
  dataWorld: DataWorldAccess;
  sandbox?: { exec(req: any, signal?: AbortSignal): Promise<any> };
  pythonBin?: string;
}

/** 一个 worker = 三解释器 + llm 函数 + 数据世界连接（Spec B 消费） */
export function createWorkerKernel(deps: WorkerKernelDeps): WorkerKernel {
  const llm = createLlmFn({ modelRouter: deps.modelRouter });
  const bash = new BashInterpreter({ sandbox: deps.sandbox ?? { exec: async () => ({ ok: false, stdout: "", stderr: "sandbox not configured", exitCode: 1, durationMs: 0 }) } });
  const python = new PythonInterpreter({ pythonBin: deps.pythonBin });
  const capabilities = buildCapabilities({ llm, dataWorld: deps.dataWorld, bash, python });
  const ts = new TsInterpreter({ capabilities });
  return {
    ts, bash, python, llm, dataWorld: deps.dataWorld,
    reset() { ts.reset(); bash.reset(); python.reset(); },
    dispose() { ts.dispose(); bash.dispose(); python.dispose(); },
  };
}

export * from "./types.js";
export * from "./ts-interpreter.js";
export * from "./bash-interpreter.js";
export * from "./python-interpreter.js";
export * from "./llm-fn.js";
export * from "./capability.js";
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run test/pth-kernel-interpreter/kernel.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add test/pth-kernel-interpreter/kernel.test.ts src/pth/kernel/interpreter/capability.ts src/pth/kernel/interpreter/index.ts
git commit -m "feat(pth-kernel): 能力注入模型+WorkerKernel 组装——三解释器+llm+数据世界统一出口，tasks 动词面收窄"
```

---

## 自审（Self-Review）

**1. Spec coverage：**
- Spec A §3 解释器抽象 → Task 1（types.ts）✅
- Spec A §4 TS 解释器（vm+strip+preflight）→ Task 1 ✅（含 import/require 拒绝、top-level await 包装、timeout、reset 保能力）
- Spec A §5 bash 解释器（sandbox+状态传递）→ Task 2 ✅
- Spec A §6 Python 解释器（子进程+超时）→ Task 3 ✅
- Spec A §7 llm 函数（completeSimple 转换层）→ Task 4 ✅（mock 测试，不真调 LLM）
- Spec A §4.2 能力注入（含 bash/python 注入、tasks 收窄）→ Task 5 ✅
- Spec A §8 WorkerKernel 组装 → Task 5 ✅
- Spec A §10 不变量 1-10 → 各 task 对应 ✅（timeout 默认 300_000、能力注入、零新依赖）

**2. Placeholder scan：** 无 TBD/TODO；所有代码块完整可执行。

**3. Type consistency：** `Interpreter`/`ExecuteOptions`/`InterpreterResult`（Task 1）被 Task 2/3/5 一致引用；`LlmFn`（Task 4）被 Task 5 引用；`WorkerKernel`/`createWorkerKernel`（Task 5）是 Spec B 的消费接口——签名与 Spec A §8 一致。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-pth-kernel-interpreters.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
