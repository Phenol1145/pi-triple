import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FlowStore } from "../../src/ptl/flow/store.js";
import { makeRunFlowV2 } from "../../src/ptl/flow/engine.js";
import { validateFlow } from "../../src/ptl/flow/schema.js";
import { registerCodeFn } from "../../src/ptl/flow/code-registry.js";
import {
  registerSubflow,
  resolveSubflow,
  hasSubflow,
  type SubflowRegistry,
} from "../../src/ptl/flow/subflow-registry.js";

// Register test code functions globally
beforeAll(() => {
  registerCodeFn("double", (args) => ({ result: (args.x as number) * 2 }));
  registerCodeFn("sum", (args) => ({ result: (args.a as number) + (args.b as number) }));
  registerCodeFn("boom", () => {
    throw new Error("child boom");
  });
  registerCodeFn("identity", () => ({ ok: true }));
});

function runFlow(graph: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-subflow-test-"));
  const store = new FlowStore(dir);
  const runId = store.createRun(graph as any, {});
  const run = makeRunFlowV2(async () => ({ exitCode: 0, output: "", signal: null }));
  return { run, store, runId, dir };
}

describe("subflow node schema validation", () => {
  it("accepts subflow node with inline FlowDef", () => {
    const child = {
      name: "child",
      entry: "c1",
      nodes: [{ id: "c1", type: "code", fn: "double" }],
      edges: [],
    };
    const r = validateFlow({
      name: "parent",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: child, out: { result: "final" } }],
      edges: [],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts subflow node with registered name", () => {
    registerSubflow("schema.child", {
      name: "child",
      entry: "c1",
      nodes: [{ id: "c1", type: "code", fn: "double" }],
      edges: [],
    });
    const r = validateFlow({
      name: "parent",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: "schema.child", in: { x: "x" }, out: { result: "final" } }],
      edges: [],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects subflow node missing flow field", () => {
    const r = validateFlow({
      name: "parent",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", out: { result: "final" } }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("flow") && e.includes("required"))).toBe(true);
    }
  });

  it("rejects unknown subflow name", () => {
    const r = validateFlow({
      name: "parent",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: "not.registered.ever", out: { result: "final" } }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("not.registered.ever"))).toBe(true);
    }
  });
});

describe("subflow node execution scenarios", () => {
  // ① 子 flow 执行 + out 映射回父 state
  it("scenario 1: child flow executes and out mapping writes parent state", async () => {
    const child = {
      name: "child1",
      entry: "c1",
      nodes: [{ id: "c1", type: "code", fn: "double", args: ["x"], writes: { result: "{{output.result}}" } }],
      edges: [],
      state: { x: 5 },
    };
    const { run, store, runId, dir } = runFlow({
      name: "parent1",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: child, out: { result: "final" } }],
      edges: [],
      state: {},
    });
    try {
      const result = await run(store, runId);
      expect(result.status).toBe("done");
      expect(store.loadState(runId)).toMatchObject({ final: 10 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ② in 映射注入
  it("scenario 2: in mapping injects parent state into child state", async () => {
    const child = {
      name: "child2",
      entry: "c1",
      nodes: [{ id: "c1", type: "code", fn: "double", args: ["x"], writes: { result: "{{output.result}}" } }],
      edges: [],
      state: { x: 0 },
    };
    const { run, store, runId, dir } = runFlow({
      name: "parent2",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: child, in: { inputVal: "x" }, out: { result: "output" } }],
      edges: [],
      state: { inputVal: 7 },
    });
    try {
      const result = await run(store, runId);
      expect(result.status).toBe("done");
      expect(store.loadState(runId)).toMatchObject({ output: 14, inputVal: 7 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ③ 子 flow 失败 → 父节点 failed
  it("scenario 3: child flow failure fails parent subflow node", async () => {
    const child = {
      name: "child3",
      entry: "c1",
      nodes: [{ id: "c1", type: "code", fn: "boom" }],
      edges: [],
    };
    const { run, store, runId, dir } = runFlow({
      name: "parent3",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: child, out: {} }],
      edges: [],
    });
    try {
      const result = await run(store, runId);
      expect(result.status).toBe("failed");
      const cp = store.listCheckpoints(runId).find((c) => c.nodeId === "p1" && c.status === "failed");
      expect(cp).toBeTruthy();
      expect(cp!.output).toContain("child boom");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ④ 嵌套两层
  it("scenario 4: nested two-layer subflow with in/out mappings", async () => {
    const inner = {
      name: "inner",
      entry: "i1",
      nodes: [{ id: "i1", type: "code", fn: "sum", args: ["a", "b"], writes: { result: "{{output.result}}" } }],
      edges: [],
      state: { a: 0, b: 0 },
    };
    const outer = {
      name: "outer",
      entry: "o1",
      nodes: [
        { id: "o1", type: "subflow", flow: inner, in: { xv: "a", yv: "b" }, out: { result: "mid" } },
      ],
      edges: [],
      state: { xv: 0, yv: 0 },
    };
    const { run, store, runId, dir } = runFlow({
      name: "parent4",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: outer, in: { inputA: "xv", inputB: "yv" }, out: { mid: "total" } }],
      edges: [],
      state: { inputA: 3, inputB: 4 },
    });
    try {
      const result = await run(store, runId);
      expect(result.status).toBe("done");
      expect(store.loadState(runId)).toMatchObject({ total: 7, inputA: 3, inputB: 4 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⑤ 未知子 flow 名 → validateFlow 报错 (covered in schema section, execution path also safe)
  it("scenario 5: runtime execution with registered subflow name", async () => {
    registerSubflow("runtime.child", {
      name: "runtime_child",
      entry: "c1",
      nodes: [{ id: "c1", type: "code", fn: "double", args: ["x"], writes: { result: "{{output.result}}" } }],
      edges: [],
      state: { x: 0 },
    });
    const { run, store, runId, dir } = runFlow({
      name: "parent5",
      entry: "p1",
      nodes: [{ id: "p1", type: "subflow", flow: "runtime.child", in: { n: "x" }, out: { result: "answer" } }],
      edges: [],
      state: { n: 6 },
    });
    try {
      const result = await run(store, runId);
      expect(result.status).toBe("done");
      expect(store.loadState(runId)).toMatchObject({ answer: 12 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
