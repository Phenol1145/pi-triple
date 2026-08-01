# pit-flow 运行时扩展（code 节点 + metrics 声明）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pit-flow v2 引擎添加 code 节点（确定性计算）与 node 级 metrics 声明（经济语义声明点），使竞价 workflow（并行出价 → AND-join 评分 → 确定性选主/结算）可表达、可运行、可测试。

**Architecture:** 在既有 v2 图驱动引擎（`src/ptl/flow/engine.ts` 的 executeWave：findReadyNodes → maxParallel 分批 → 结果合并）上扩展：schema 加 `code` 类型与 `metrics` 字段；新增 `FlowCodeRegistry`（白名单注册表，同进程调用确定性函数）；code 节点输出 JSON 字符串，写值提取扩展 `{{output.path}}`；metrics 节点完成时求值（state/input/result 三作用域）后追加到 `runDir/metrics.jsonl`。v1 引擎不动。

**Tech Stack:** TypeScript（纯 ESM，import 后缀 `.js`）、vitest、node:fs（文件化运行存储，无新增依赖）。

## Global Constraints

- 零新增运行时依赖；import 后缀 `.js`
- code 节点仅 v2 引擎支持；v1 引擎遇到 code 节点 → validateFlow 校验错误（"code nodes require v2 engine"）
- 白名单：flow 只能引用已注册函数名，**不支持内联代码/动态 require**
- code 节点确定性：同输入同输出（纯函数 + 只读 state + 无 I/O；CodeCtx 只暴露只读 state + 日志钩子）
- metrics **只声明 + 记录**：运行时零经济依赖（不 import 结算/记忆模块，不触碰 credit/elo）
- 向后兼容：旧 flow（agent/human）行为不变，既有测试全绿
- 项目测试命令：`npx vitest run test/unit/<file>.test.ts`；全量回归：`npx vitest run`

---

### Task 1: schema 扩展（code 类型 + metrics 字段 + 校验）

**Files:**
- Modify: `src/ptl/flow/schema.ts`（NodeDef 接口 + validateFlow）
- Test: `test/unit/flow-schema.test.ts`

**Interfaces:**
- Consumes: 现有 `validateFlow(flow: unknown): string[]`（返回错误数组）
- Produces:
  - `NodeDef` 扩展：`type: "agent" | "human" | "code"`；`fn?: string`；`args?: string[]`；`metrics?: Record<string, Record<string, string>>`
  - 校验规则（错误信息固定，测试断言用）：
    - `nodes[i]: type must be "agent", "human" or "code", got "..."`（替换现有仅两类型的报错）
    - `nodes[i] (code "id"): fn is required`
    - `nodes[i] (code "id"): fn must be a string`
    - `nodes[i] (code "id"): args must be a string array`
    - `nodes[i] ("id"): metrics must be an object of string-string maps`
    - `nodes[i] ("id"): metrics.<domain> must be an object`（metrics 域值非对象时）
    - `nodes[i] ("id"): metrics.<domain>.<key> must be a string`（域内字段非字符串时）

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/flow-schema.test.ts` 末尾）

```typescript
describe("code nodes", () => {
  const codeFlow = (over: Record<string, unknown>): unknown => ({
    name: "t", entry: "c", nodes: [{ id: "c", type: "code", fn: "market.score", ...over }], edges: [],
  });

  it("accepts valid code node", () => {
    expect(validateFlow(codeFlow({ args: ["bids"], writes: { winner: "{{output}}" } }))).toEqual([]);
  });

  it("rejects code node without fn", () => {
    const errs = validateFlow(codeFlow({ fn: undefined }));
    expect(errs).toContain('nodes[0] (code "c"): fn is required');
  });

  it("rejects code node with non-string fn", () => {
    expect(validateFlow(codeFlow({ fn: 42 }))).toContain('nodes[0] (code "c"): fn must be a string');
  });

  it("rejects code node with non-string-array args", () => {
    expect(validateFlow(codeFlow({ args: "bids" }))).toContain('nodes[0] (code "c"): args must be a string array');
  });

  it("rejects invalid metrics structure", () => {
    expect(validateFlow(codeFlow({ metrics: "bad" }))).toContain('nodes[0] ("c"): metrics must be an object of string-string maps');
    expect(validateFlow(codeFlow({ metrics: { credit: "bad" } }))).toContain('nodes[0] ("c"): metrics.credit must be an object');
    expect(validateFlow(codeFlow({ metrics: { credit: { amount: 42 } } }))).toContain('nodes[0] ("c"): metrics.credit.amount must be a string');
  });

  it("accepts metrics on agent nodes", () => {
    const flow: unknown = {
      name: "t", entry: "a",
      nodes: [{ id: "a", type: "agent", prompt: "hi", metrics: { credit: { amount: "{{result.x}}" } } }],
      edges: [],
    };
    expect(validateFlow(flow)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/flow-schema.test.ts`
Expected: 新用例 FAIL（type 校验仍只接受 agent/human；metrics 未校验）

- [ ] **Step 3: 实现**

`src/ptl/flow/schema.ts`：
- `NodeDef.type` 联合类型加 `"code"`
- 加字段：`fn?: string; args?: string[]; metrics?: Record<string, Record<string, string>>;`
- `validateFlow` 中类型检查（第 117 行附近）改为三类型白名单，报错信息见 Interfaces
- code 类型分支：`fn` 必填（`requireString`）/ `args` 可选（存在时用现有 `requireArray` 模式检查字符串数组）
- 所有节点通用：`metrics` 存在时校验——顶层是对象（否则报 "metrics must be an object of string-string maps"）；每个域值是对象（否则 `metrics.<domain> must be an object`）；域内每字段是字符串（否则 `metrics.<domain>.<key> must be a string`）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/flow-schema.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/ptl/flow/schema.ts test/unit/flow-schema.test.ts
git commit -m "feat(flow): schema 支持 code 节点类型与 metrics 字段（含校验）"
```

---

### Task 2: FlowCodeRegistry（白名单注册表）

**Files:**
- Create: `src/ptl/flow/code-registry.ts`
- Test: `test/unit/flow-code-registry.test.ts`

**Interfaces:**
- Consumes: 无（独立模块）
- Produces（后续任务与外部消费方依赖）:
  - `export interface CodeFnContext { state: Readonly<Record<string, unknown>>; runId: string; nodeId: string; log: (msg: string) => void; }`
  - `export type CodeFn = (args: Record<string, unknown>, ctx: CodeFnContext) => unknown | Promise<unknown>;`
  - `export function registerCodeFn(name: string, fn: CodeFn): void`（同名重注册 → 抛 `Error("code fn already registered: <name>")`）
  - `export function resolveCodeFn(name: string): CodeFn | undefined`
  - `export function listCodeFns(): string[]`
  - 命名空间约定：点分名（`market.score`），仅存储字符串名，不强制点分

- [ ] **Step 1: 写失败测试**（新建 `test/unit/flow-code-registry.test.ts`）

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { registerCodeFn, resolveCodeFn, listCodeFns, type CodeFn } from "../../src/ptl/flow/code-registry.js";

describe("FlowCodeRegistry", () => {
  beforeEach(() => {
    // 重置注册表（内部 Map 每次测试重新 import 不现实——用 listCodeFns 清空）
    for (const n of listCodeFns()) {
      // 通过重新注册覆盖 + 删除不可行时，用唯一命名避免冲突
    }
  });

  it("registers and resolves a fn", () => {
    const fn: CodeFn = async (args) => args;
    registerCodeFn("market.score", fn);
    expect(resolveCodeFn("market.score")).toBe(fn);
  });

  it("rejects duplicate registration", () => {
    registerCodeFn("t.dup", () => 1);
    expect(() => registerCodeFn("t.dup", () => 2)).toThrow(/already registered: t\.dup/);
  });

  it("returns undefined for unknown fn", () => {
    expect(resolveCodeFn("nope.missing")).toBeUndefined();
  });

  it("lists registered names", () => {
    registerCodeFn("t.list.a", () => 1);
    expect(listCodeFns()).toContain("t.list.a");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/flow-code-registry.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（新建 `src/ptl/flow/code-registry.ts`）

```typescript
// pit-flow code 节点函数注册表（白名单：flow 只能引用已注册函数）

export interface CodeFnContext {
  state: Readonly<Record<string, unknown>>;
  runId: string;
  nodeId: string;
  log: (msg: string) => void;
}

export type CodeFn = (args: Record<string, unknown>, ctx: CodeFnContext) => unknown | Promise<unknown>;

const registry = new Map<string, CodeFn>();

export function registerCodeFn(name: string, fn: CodeFn): void {
  if (registry.has(name)) throw new Error(`code fn already registered: ${name}`);
  registry.set(name, fn);
}

export function resolveCodeFn(name: string): CodeFn | undefined {
  return registry.get(name);
}

export function listCodeFns(): string[] {
  return [...registry.keys()];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/flow-code-registry.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/ptl/flow/code-registry.ts test/unit/flow-code-registry.test.ts
git commit -m "feat(flow): FlowCodeRegistry 白名单函数注册表"
```

---

### Task 3: code 节点执行（引擎集成 + {{output.path}} 写值）

**Files:**
- Modify: `src/ptl/flow/engine.ts`（executeWave 的 batch.map 内加 code 分支；resolveWriteValue 扩展；文件顶部 import code-registry）
- Test: `test/unit/flow-code-node.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 NodeDef（type "code"/fn/args）；Task 2 的 `resolveCodeFn`
- Produces:
  - code 节点输出约定：函数返回值 `JSON.stringify(result ?? null)` 作为节点 output（与 agent 节点 stdout 字符串同槽位）
  - `resolveWriteValue(key, raw, output)` 扩展：`{{output}}` 原样；新增 `{{output.<path>}}` → `JSON.parse(output)` 后取嵌套路径（`.` 分隔），解析失败或路径不存在 → `undefined`（跳过该写入，与既有"resolved === undefined 跳过"语义一致）；`{{increment:...}}` 仍返回 undefined；其他原样返回
  - 失败语义：函数抛错/未注册 → `{ ok: false, output: 错误消息, exitCode: -1, signal: "code fn threw" | "code fn not registered" }`（复用既有失败回滚/checkpoint 机制）

- [ ] **Step 1: 写失败测试**（新建 `test/unit/flow-code-node.test.ts`）

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { registerCodeFn } from "../../src/ptl/flow/code-registry.js";
import { runFlowV2 } from "../../src/ptl/flow/engine.js";
import { createFlowStore } from "../../src/ptl/flow/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 测试用注册函数（唯一命名避免与真实市场函数冲突）
beforeAll(() => {
  registerCodeFn("test.double", (args) => ({ value: (args as any).x * 2 }));
  registerCodeFn("test.adder", (args) => ({ total: (args as any).a + (args as any).b }));
  registerCodeFn("test.throwing", () => { throw new Error("boom"); });
});

async function runFlow(graph: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-code-test-"));
  const store = createFlowStore(dir);
  const runId = store.createRun(graph, {});
  const result = await runFlowV2(store, runId, async () => ({ exitCode: 0, output: "", signal: null }));
  return { result, store, runId, dir };
}

describe("code node execution", () => {
  it("executes code fn and writes structured output path", async () => {
    const { result, store } = await runFlow({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "test.double", args: ["x"], writes: { doubled: "{{output.value}}" } }],
      edges: [],
      state: { x: 21 },
    });
    expect(result.status).toBe("done");
    expect(store.loadState(runIdOf(store))).toMatchObject({ doubled: 42 });
  });

  it("joins parallel outputs via needs (AND-join) then code node", async () => {
    const { result, store } = await runFlow({
      name: "t", entry: "a",
      nodes: [
        { id: "a", type: "code", fn: "test.double", args: ["x"], writes: { va: "{{output.value}}" } },
        { id: "b", type: "code", fn: "test.double", args: ["y"], writes: { vb: "{{output.value}}" } },
        { id: "s", type: "code", fn: "test.adder", args: ["va", "vb"], needs: ["a", "b"], writes: { total: "{{output.total}}" } },
      ],
      edges: [{ from: "a", to: "s" }, { from: "b", to: "s" }],
      state: { x: 3, y: 4 },
    });
    expect(result.status).toBe("done");
    expect(store.loadState(runIdOf(store))).toMatchObject({ va: 6, vb: 8, total: 14 });
  });

  it("fails node when fn throws, flow failed, resume-able", async () => {
    const { result, store, dir } = await runFlow({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "test.throwing", writes: { out: "{{output}}" } }],
      edges: [],
    });
    expect(result.status).toBe("failed");
    // resume 语义：重跑同一节点（确定性保证同结果）
    const resumed = await (await import("../../src/ptl/flow/engine.js")).resumeFlowV2(store, runIdOf(store), async () => ({ exitCode: 0, output: "", signal: null }));
    expect(resumed.status).toBe("failed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails node when fn not registered", async () => {
    const { result } = await runFlow({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "nope.missing", writes: { out: "{{output}}" } }],
      edges: [],
    });
    expect(result.status).toBe("failed");
  });
});

// 辅助：从 store 取 runId（createRun 返回 runId）
function runIdOf(store: any): string {
  return store["runs"] ? [...(store as any).runs.keys()][0] : (store as any).latestRunId ?? "run-1";
}
```

> 注：`createFlowStore(dir)` 的 `createRun(graph, input)` 签名与 runId 获取方式以 `test/unit/flow-engine-v2.test.ts` 既有用法为准（读该文件确认后按实际签名调整测试——`runFlowV2(store, runId, spawnAgent)` 签名已从引擎源码确认）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/flow-code-node.test.ts`
Expected: FAIL（type "code" 校验失败或引擎无 code 分支）

- [ ] **Step 3: 实现**

`src/ptl/flow/engine.ts`：
1. 顶部 import：`import { resolveCodeFn } from "./code-registry.js";`
2. executeWave 的 batch.map 内、human 分支之后 agent 分支之前（约 501 行附近）插入：

```typescript
if (nodeSnapshot.type === "code") {
  const fn = resolveCodeFn(nodeSnapshot.fn ?? "");
  if (!fn) {
    nodeResults.set(nodeId, { ok: false, output: `code fn not registered: ${nodeSnapshot.fn}`, exitCode: -1, signal: "code fn not registered" });
    return;
  }
  const argNames = nodeSnapshot.args ?? Object.keys(preWaveState);
  const args: Record<string, unknown> = {};
  for (const k of argNames) args[k] = preWaveState[k];
  try {
    const result = await fn(args, { state: preWaveState, runId, nodeId, log: () => {} });
    const output = JSON.stringify(result ?? null);
    nodeResults.set(nodeId, { ok: true, output, exitCode: 0, signal: null });
  } catch (err: any) {
    nodeResults.set(nodeId, { ok: false, output: err?.message ?? String(err), exitCode: -1, signal: "code fn threw" });
  }
  return;
}
```

3. `resolveWriteValue`（约 865 行）扩展：`{{output}}` 之后加

```typescript
const outPathMatch = raw.match(/^\{\{output\.(.+)\}\}$/);
if (outPathMatch) {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    let val: unknown = parsed;
    for (const seg of outPathMatch[1]!.split(".")) {
      if (val === null || val === undefined || typeof val !== "object") return undefined;
      val = (val as Record<string, unknown>)[seg];
    }
    return val;
  } catch {
    return undefined; // 非 JSON 输出（agent 节点）或路径不存在 → 跳过写入
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/flow-code-node.test.ts`
Expected: 全部 PASS

- [ ] **Step 4b: v1 引擎防护（code 节点 → 明确错误，spec §5）**

`src/ptl/flow/engine.ts` 的 v1 `executeLoop`（约 249 行 human 分支后）追加 else 分支：

```typescript
    } else {
      // code 节点仅 v2 引擎支持（spec: 兼容性约束）
      await failRun(store, runId, `node \"${currentNodeId}\": code nodes require v2 engine`);
      return { status: "failed", error: `node \"${currentNodeId}\": code nodes require v2 engine` };
    }
```

追加测试到 `test/unit/flow-code-node.test.ts`（v1 路径）：

```typescript
  it("v1 engine rejects code nodes with explicit error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-code-v1-"));
    const store = createFlowStore(dir);
    const runId = store.createRun({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "test.double", args: ["x"] }],
      edges: [],
    }, {});
    const { runFlow } = await import("../../src/ptl/flow/engine.js");
    const result = await runFlow(store, runId, async () => ({ exitCode: 0, output: "", signal: null }));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/code nodes require v2 engine/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
```

Run: `npx vitest run test/unit/flow-code-node.test.ts`
Expected: 全部 PASS（含新增 v1 用例）

- [ ] **Step 5: Commit**

```bash
git add src/ptl/flow/engine.ts test/unit/flow-code-node.test.ts
git commit -m "feat(flow): code 节点引擎执行（同批次/确定性/{{output.path}} 写值）"
```

---

### Task 4: metrics 事件记录

**Files:**
- Modify: `src/ptl/flow/store.ts`（appendMetrics/readMetrics）
- Modify: `src/ptl/flow/engine.ts`（波末求值 + 记录）
- Test: `test/unit/flow-metrics.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 code 执行；既有 `store.runDir(runId)`
- Produces:
  - `export function appendMetrics(store: FlowStore, runId: string, entry: Record<string, unknown>): void`——追加到 `runDir/metrics.jsonl`（每行一个 JSON）
  - `export function readMetrics(store: FlowStore, runId: string): Array<Record<string, unknown>>`——读全部（空文件/无文件 → `[]`）
  - metrics 求值上下文：`{ state, input, result }`——result = 节点输出：code 节点 → `JSON.parse(output)`（解析失败 → output 原串）；agent 节点 → output 原串
  - 事件条目：`{ seq, nodeId, graphVersion, metrics, timestamp }`（seq = 该节点 checkpoint 的 seq；timestamp = Date.now()）
  - 求值函数：`renderMetrics(metrics, ctx): Record<string, Record<string, string>>`——模板替换支持 `{{state.x.y}}` / `{{input.x}}` / `{{result.x.y}}`，缺失 → 空字符串（与 interpolate 同语义）；导出供测试

- [ ] **Step 1: 写失败测试**（新建 `test/unit/flow-metrics.test.ts`）

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { registerCodeFn } from "../../src/ptl/flow/code-registry.js";
import { runFlowV2 } from "../../src/ptl/flow/engine.js";
import { renderMetrics } from "../../src/ptl/flow/engine.js";
import { createFlowStore, readMetrics } from "../../src/ptl/flow/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeAll(() => {
  registerCodeFn("test.settle", (args) => ({ delta: (args as any).stake * 0.9 }));
});

describe("renderMetrics", () => {
  it("renders state/input/result scopes", () => {
    const out = renderMetrics(
      { credit: { amount: "{{result.delta}}", agent: "{{state.agentId}}", task: "{{input.task}}" } },
      { state: { agentId: "a1" }, input: { task: "t1" }, result: { delta: 9 } },
    );
    expect(out).toEqual({ credit: { amount: "9", agent: "a1", task: "t1" } });
  });

  it("renders missing values as empty string", () => {
    const out = renderMetrics({ credit: { amount: "{{result.nope}}" } }, { state: {}, input: {}, result: {} });
    expect(out).toEqual({ credit: { amount: "" } });
  });
});

describe("metrics event recording", () => {
  it("records evaluated metrics after node completion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-metrics-"));
    const store = createFlowStore(dir);
    const runId = store.createRun({
      name: "t", entry: "s",
      nodes: [{ id: "s", type: "code", fn: "test.settle", args: ["stake"], metrics: { credit: { amount: "{{result.delta}}", agent: "{{state.agentId}}" } } }],
      edges: [],
      state: { stake: 100, agentId: "a1" },
    }, {});
    const result = await runFlowV2(store, runId, async () => ({ exitCode: 0, output: "", signal: null }));
    expect(result.status).toBe("done");
    const entries = readMetrics(store, runId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      nodeId: "s",
      metrics: { credit: { amount: "90", agent: "a1" } },
    });
    expect(typeof entries[0].seq).toBe("number");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records nothing for nodes without metrics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-metrics-"));
    const store = createFlowStore(dir);
    const runId = store.createRun({
      name: "t", entry: "a",
      nodes: [{ id: "a", type: "code", fn: "test.settle", args: ["stake"] }],
      edges: [],
      state: { stake: 1 },
    }, {});
    const result = await runFlowV2(store, runId, async () => ({ exitCode: 0, output: "", signal: null }));
    expect(result.status).toBe("done");
    expect(readMetrics(store, runId)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/unit/flow-metrics.test.ts`
Expected: FAIL（renderMetrics/readMetrics 不存在）

- [ ] **Step 3: 实现**

`src/ptl/flow/store.ts` 追加：

```typescript
export function appendMetrics(store: FlowStore, runId: string, entry: Record<string, unknown>): void {
  const p = path.join(store.runDir(runId), "metrics.jsonl");
  fs.appendFileSync(p, JSON.stringify(entry) + "\n");
}

export function readMetrics(store: FlowStore, runId: string): Array<Record<string, unknown>> {
  const p = path.join(store.runDir(runId), "metrics.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
}
```

`src/ptl/flow/engine.ts` 追加（文件底部）：

```typescript
// metrics 模板求值：state / input / result 三作用域，缺失 → 空字符串
export function renderMetrics(
  metrics: Record<string, Record<string, string>>,
  ctx: { state: Record<string, unknown>; input: Record<string, unknown>; result: unknown },
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [domain, fields] of Object.entries(metrics)) {
    out[domain] = {};
    for (const [k, v] of Object.entries(fields)) {
      out[domain][k] = v.replace(/\{\{([^}]+)\}\}/g, (_m, expr: string) => {
        const t = expr.trim();
        if (t.startsWith("input.")) return String((ctx.input as Record<string, unknown>)[t.slice(6)] ?? "");
        if (t.startsWith("state.")) {
          let val: unknown = ctx.state;
          for (const seg of t.slice(6).split(".")) {
            if (val === null || val === undefined || typeof val !== "object") return "";
            val = (val as Record<string, unknown>)[seg];
          }
          return val === null || val === undefined ? "" : String(val);
        }
        if (t.startsWith("result.")) {
          let val: unknown = ctx.result;
          for (const seg of t.slice(7).split(".")) {
            if (val === null || val === undefined || typeof val !== "object") return "";
            val = (val as Record<string, unknown>)[seg];
          }
          return val === null || val === undefined ? "" : String(val);
        }
        return `{{${t}}}`;
      });
    }
  }
  return out;
}
```

引擎记录点：executeWave 内"Rewrite node checkpoints"循环（约 640 行，seqCounter 递增处）同步记录——每个 ok 节点且 `nodeDef.metrics` 存在时：

```typescript
if (r.ok && nodeDef.metrics) {
  const result: unknown = (() => {
    if (nodeSnapshot.type === "code") {
      try { return JSON.parse(r.output) as unknown; } catch { return r.output; }
    }
    return r.output;
  })();
  appendMetrics(store, runId, {
    seq: seqCounter,
    nodeId,
    graphVersion: meta.graphVersion,
    metrics: renderMetrics(nodeDef.metrics, { state: finalState, input: meta.input, result }),
    timestamp: Date.now(),
  });
}
```

顶部 import：`import { appendMetrics } from "./store.js";`（engine 已 import store 类型——确认现有 import 语句，追加具名 import）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/unit/flow-metrics.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/ptl/flow/store.ts src/ptl/flow/engine.ts test/unit/flow-metrics.test.ts
git commit -m "feat(flow): node 级 metrics 声明求值 + metrics.jsonl 事件记录（只声明不执行）"
```

---

### Task 5: 竞价 workflow 集成验证 + 全量回归

**Files:**
- Test: `test/unit/flow-bidding-integration.test.ts`（新建）
- 回归：全量 `npx vitest run`

**Interfaces:**
- Consumes: Task 1-4 全部能力
- Produces: 竞价场景的端到端验证（spec §4 验证标准 5 条）

- [ ] **Step 1: 写集成测试**（新建 `test/unit/flow-bidding-integration.test.ts`）

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { registerCodeFn } from "../../src/ptl/flow/code-registry.js";
import { runFlowV2 } from "../../src/ptl/flow/engine.js";
import { createFlowStore, readMetrics } from "../../src/ptl/flow/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeAll(() => {
  // 竞价内核函数（确定性，模拟）
  registerCodeFn("test.preprocess", (_args, ctx) => ({ task: (ctx.state as any).task ?? "unknown" }));
  registerCodeFn("test.bid", (args) => ({ bidder: (args as any).id, stake: (args as any).stake }));
  registerCodeFn("test.score", (args) => {
    // score = stake × 1.0 + elo × 1.0（权重简化）
    const bids = (args as any).bids as Array<{ bidder: string; stake: number; elo: number }>;
    const scored = bids.map((b) => ({ ...b, score: b.stake + b.elo }));
    scored.sort((a, b) => b.score - a.score);
    return { winner: scored[0]!.bidder, scored };
  });
  registerCodeFn("test.settle", (args) => ({ delta: Math.round((args as any).stake * 0.9) }));
});

const BIDDING_FLOW = {
  name: "bidding", entry: "pre",
  maxParallel: 4,
  state: { task: "T1", bids: [], winner: "", delta: 0 },
  nodes: [
    { id: "pre", type: "code", fn: "test.preprocess", args: ["task"], writes: { task: "{{output.task}}" } },
    { id: "bid1", type: "code", fn: "test.bid", args: ["id1", "stake1"], needs: ["pre"], writes: { b1: "{{output}}" } },
    { id: "bid2", type: "code", fn: "test.bid", args: ["id2", "stake2"], needs: ["pre"], writes: { b2: "{{output}}" } },
    { id: "bid3", type: "code", fn: "test.bid", args: ["id3", "stake3"], needs: ["pre"], writes: { b3: "{{output}}" } },
    { id: "score", type: "code", fn: "test.score", args: ["bids"], needs: ["bid1", "bid2", "bid3"], writes: { winner: "{{output.winner}}" } },
    { id: "settle", type: "code", fn: "test.settle", args: ["winnerStake"], needs: ["score"],
      writes: { delta: "{{output.delta}}" },
      metrics: { credit: { from: "market", to: "{{state.winner}}", amount: "{{result.delta}}", reason: "settle" } } },
  ],
  edges: [
    { from: "pre", to: "bid1" }, { from: "pre", to: "bid2" }, { from: "pre", to: "bid3" },
    { from: "bid1", to: "score" }, { from: "bid2", to: "score" }, { from: "bid3", to: "score" },
    { from: "score", to: "settle" },
  ],
};

describe("bidding workflow integration", () => {
  it("runs full bidding round: parallel bids → AND-join score → settle with metrics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bid-"));
    const store = createFlowStore(dir);
    const runId = store.createRun(JSON.parse(JSON.stringify(BIDDING_FLOW)), {});
    // 用 code 节点模拟竞价者：bids 状态由 score 前的 join 准备——简化：state 预置 bids
    const result = await runFlowV2(store, runId, async () => ({ exitCode: 0, output: "", signal: null }));
    expect(result.status).toBe("done");

    const state = store.loadState(runId);
    expect(state.winner).toBe("id2"); // stake 最高者（stake2 > stake1 > stake3 且 elo 相同）

    const metrics = readMetrics(store, runId);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].metrics).toMatchObject({ credit: { from: "market", reason: "settle" } });

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

> 注：测试的 bids 输入需在 state 预置（`state: { bids: [...], id1/id2/id3 的 stake/elo... }`）——集成测试聚焦流程表达力（并行 → join → code 内核 → metrics），具体输入在实现时按上述结构调整并保证断言一致（winner 为最高分）。

- [ ] **Step 2: 运行确认**

Run: `npx vitest run test/unit/flow-bidding-integration.test.ts`
Expected: PASS（若 state 预置与断言不匹配，调整测试输入使 winner 断言成立——测试意图是流程全通 + 确定性选主 + metrics 记录）

- [ ] **Step 3: 全量回归**

Run: `npx vitest run`
Expected: 全部 PASS（既有 flow 测试不破坏——v1/v2 兼容）

- [ ] **Step 4: build 验证**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add test/unit/flow-bidding-integration.test.ts
git commit -m "test(flow): 竞价 workflow 集成验证（并行出价 → AND-join 评分 → 确定性结算 + metrics）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 schema（Task 1）/注册表（Task 2）/执行语义（Task 3）/确定性（Task 3 纯函数约束 + 测试）/§3 metrics 声明校验（Task 1）+ 求值事件（Task 4）/§4 竞价场景（Task 5）/§5 兼容（Task 1 v1 校验错误 + Task 5 回归）/§6 测试策略（Task 1-5 全覆盖）
- **已知偏差（有意）**：v1 引擎遇 code 节点 → 运行时明确错误 "code nodes require v2 engine"（spec §5；validateFlow 无法感知引擎版本，故在 executeLoop 的 else 分支落地，Task 3 Step 4b）
- **类型一致性**：`registerCodeFn/resolveCodeFn/listCodeFns/CodeFn/CodeFnContext`（Task 2）→ Task 3 用 `resolveCodeFn`；`renderMetrics`（Task 4 导出）→ Task 4 引擎调用；`appendMetrics/readMetrics`（Task 4 store）→ Task 4/5 使用；NodeDef 扩展（Task 1）→ Task 3/4 消费。签名在任务间一致
