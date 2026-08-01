import { describe, it, expect, beforeAll } from "vitest";
import { registerCodeFn } from "../../src/ptl/flow/code-registry.js";
import { makeRunFlow, makeRunFlowV2, makeResumeFlowV2 } from "../../src/ptl/flow/engine.js";
import { FlowStore } from "../../src/ptl/flow/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 测试用注册函数（唯一命名避免与真实市场函数冲突）
beforeAll(() => {
  registerCodeFn("test.double", (args) => ({ value: (args as any).x * 2 }));
  registerCodeFn("test.adder", (args) => ({ total: (args as any).a + (args as any).b }));
  registerCodeFn("test.throwing", () => { throw new Error("boom"); });
  // 恶意/违规 fn：运行时篡改 ctx.state（修复前会污染波状态）
  registerCodeFn("test.mutator", (_args, ctx) => { (ctx.state as any).x = 999; return { ok: true }; });
});

// mock spawnAgent：仅 agent 节点触发；code 节点同进程执行不 spawn
const mockSpawnAgent = async () => ({ exitCode: 0, output: "", signal: null });

async function runFlow(graph: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-code-test-"));
  const store = new FlowStore(dir);
  const runId = store.createRun(graph as any, {});
  const run = makeRunFlowV2(mockSpawnAgent);
  const result = await run(store, runId);
  return { result, store, runId, dir };
}

describe("code node execution", () => {
  it("executes code fn and writes structured output path", async () => {
    const { result, store, runId } = await runFlow({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "test.double", args: ["x"], writes: { doubled: "{{output.value}}" } }],
      edges: [],
      state: { x: 21 },
    });
    expect(result.status).toBe("done");
    expect(store.loadState(runId)).toMatchObject({ doubled: 42 });
  });

  it("joins parallel outputs via needs (AND-join) then code node", async () => {
    // 注册 fn 参数名硬编码（double 读 args.x，adder 读 args.a/args.b）→
    // 产出节点直接把结果写到 join fn 可读的键：p1 写 a=6，p2 读 a+b=8 写 b，join 读 a+b=14
    const { result, store, runId } = await runFlow({
      name: "t", entry: "p1",
      nodes: [
        { id: "p1", type: "code", fn: "test.double", args: ["x"], writes: { a: "{{output.value}}" } },
        { id: "p2", type: "code", fn: "test.adder", args: ["a", "b"], writes: { b: "{{output.total}}" } },
        { id: "join", type: "code", fn: "test.adder", args: ["a", "b"], needs: ["p1", "p2"], writes: { total: "{{output.total}}" } },
      ],
      edges: [{ from: "p1", to: "p2" }, { from: "p1", to: "join" }, { from: "p2", to: "join" }],
      state: { x: 3, b: 2 },
    });
    expect(result.status).toBe("done");
    expect(store.loadState(runId)).toMatchObject({ a: 6, b: 8, total: 14 });
  });

  it("fails node when fn throws, flow failed, resume-able", async () => {
    const { result, store, runId, dir } = await runFlow({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "test.throwing", writes: { out: "{{output}}" } }],
      edges: [],
    });
    expect(result.status).toBe("failed");
    // resume 语义：重跑同一节点（确定性保证同结果）
    const resume = makeResumeFlowV2(mockSpawnAgent);
    const resumed = await resume(store, runId);
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

  it("isolates ctx.state from in-place mutation by code fn", async () => {
    const { result, store, runId } = await runFlow({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "test.mutator", args: ["x"] }],
      edges: [],
      state: { x: 1 },
    });
    expect(result.status).toBe("done");
    expect(store.loadState(runId)).toMatchObject({ x: 1 });
  });

  it("v1 engine rejects code nodes with explicit error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-code-v1-"));
    const store = new FlowStore(dir);
    const runId = store.createRun({
      name: "t", entry: "c",
      nodes: [{ id: "c", type: "code", fn: "test.double", args: ["x"] }],
      edges: [],
    } as any, {});
    const runFlow = makeRunFlow(mockSpawnAgent);
    const result = await runFlow(store, runId);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/code nodes require v2 engine/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
