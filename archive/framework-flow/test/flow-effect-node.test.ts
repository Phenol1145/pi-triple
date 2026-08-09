import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EffectRegistry, registerEffect, type EffectFn } from "../../packages/framework/src/flow/effect-registry.js";
import { makeRunFlowV2, makeResumeFlowV2 } from "../../packages/framework/src/flow/engine.js";
import { FlowStore } from "../../packages/framework/src/flow/store.js";
import { validateFlow } from "../../packages/framework/src/flow/schema.js";

// mock spawnAgent：仅 agent 节点触发；effect 节点同进程执行不 spawn
const mockSpawnAgent = async () => ({ exitCode: 0, output: "", signal: null });

async function runFlow(graph: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-effect-test-"));
  const store = new FlowStore(dir);
  const runId = store.createRun(graph as any, {});
  const run = makeRunFlowV2(mockSpawnAgent);
  const result = await run(store, runId);
  return { result, store, runId, dir };
}

describe("EffectRegistry", () => {
  it("registers, resolves and reports has()", () => {
    const r = new EffectRegistry();
    const fn: EffectFn = () => ({ ok: true });
    r.register("reg.resolve", fn);
    expect(r.has("reg.resolve")).toBe(true);
    expect(r.get("reg.resolve")).toBe(fn);
    expect(r.has("reg.missing")).toBe(false);
  });

  it("rejects duplicate registration", () => {
    const r = new EffectRegistry();
    r.register("reg.dup", () => 1);
    expect(() => r.register("reg.dup", () => 2)).toThrow(/already registered: reg\.dup/);
  });

  it("throws for unknown get", () => {
    const r = new EffectRegistry();
    expect(() => r.get("reg.missing")).toThrow(/not registered: reg\.missing/);
  });
});

describe("effect node execution", () => {
  it("executes effect fn, passes ctx, and writes structured output to state", async () => {
    let captured: any = null;
    registerEffect("test.effect.double", (ctx) => {
      captured = ctx;
      return { value: (ctx.state as any).x * 2 };
    });

    const { result, store, runId, dir } = await runFlow({
      name: "t", entry: "e",
      nodes: [{ id: "e", type: "effect", effect: "test.effect.double", args: ["x"], writes: { doubled: "{{output.value}}" } }],
      edges: [],
      state: { x: 21 },
    });
    try {
      expect(result.status).toBe("done");
      expect(store.loadState(runId)).toMatchObject({ doubled: 42 });
      expect(captured).toBeTruthy();
      expect(captured.runId).toBe(runId);
      expect(captured.nodeId).toBe("e");
      expect(typeof captured.idempotencyKey).toBe("string");
      expect(captured.idempotencyKey.length).toBeGreaterThan(0);
      expect(typeof captured.log).toBe("function");
      expect(captured.state).toMatchObject({ x: 21 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: re-firing the same node in a loop calls fn only once", async () => {
    let calls = 0;
    registerEffect("test.effect.idem", () => {
      calls++;
      return { ok: true };
    });

    // 自环图：effect 节点每波重跑一次。idempotency 键基于 args 值（state.payload 不变）
    // → 第二次起命中 flow_effects 记录 → skip（fn 只调用一次）。maxSteps=5 终止环。
    const { result, store, runId, dir } = await runFlow({
      name: "t", entry: "e",
      maxSteps: 5,
      nodes: [{ id: "e", type: "effect", effect: "test.effect.idem", args: ["payload"], writes: { out: "{{output}}" } }],
      edges: [{ from: "e", to: "e" }],
      state: { payload: "p1" },
    });
    try {
      // 环未被幂等表终止（每波仍 ready 并 skip）→ maxSteps 耗尽 → failed；但 fn 只执行一次
      expect(result.status).toBe("failed");
      expect(calls).toBe(1);
      // 节点确实被重跑了多次（checkpoint 每波一条）→ 幂等 skip 路径真实生效
      const cps = store.listCheckpoints(runId).filter((c) => c.nodeId === "e");
      expect(cps.length).toBeGreaterThan(1);
      // 幂等记录落库
      expect(store.loadEffectRecords(runId).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists state before appending effect idempotency records", async () => {
    registerEffect("test.effect.order", () => ({ value: "ok" }));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-effect-order-"));
    const store = new FlowStore(dir);
    const saveStateSpy = vi.spyOn(store, "saveState");
    const appendSpy = vi.spyOn(store, "appendEffectRecords");
    const runId = store.createRun({
      name: "t", entry: "e",
      nodes: [{ id: "e", type: "effect", effect: "test.effect.order", writes: { out: "{{output}}" } }],
      edges: [],
    } as any, {});
    const run = makeRunFlowV2(mockSpawnAgent);
    const result = await run(store, runId);
    try {
      expect(result.status).toBe("done");
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(saveStateSpy).toHaveBeenCalled();

      const appendOrder = (appendSpy.mock.invocationCallOrder as number[])[0]!;
      const saveOrders = saveStateSpy.mock.invocationCallOrder as number[];
      const lastSaveBeforeAppend = Math.max(...saveOrders.filter((o) => o < appendOrder));
      expect(lastSaveBeforeAppend).toBeGreaterThan(0);

      const idx = saveOrders.indexOf(lastSaveBeforeAppend);
      expect(saveStateSpy.mock.calls[idx]![1]).toMatchObject({ out: '{"value":"ok"}' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails node when fn throws: no idempotency record, retry re-executes", async () => {
    let calls = 0;
    registerEffect("test.effect.flaky", () => {
      calls++;
      if (calls === 1) throw new Error("flaky boom");
      return { persisted: true };
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-effect-flaky-"));
    const store = new FlowStore(dir);
    const runId = store.createRun({
      name: "t", entry: "e",
      nodes: [{ id: "e", type: "effect", effect: "test.effect.flaky", writes: { out: "{{output}}" } }],
      edges: [],
    } as any, {});
    try {
      const run = makeRunFlowV2(mockSpawnAgent);
      const result = await run(store, runId);
      expect(result.status).toBe("failed");
      // fn 抛错 → 幂等表无记录 → 重试可重新执行
      expect(store.loadEffectRecords(runId)).toEqual([]);

      // resume 重跑：幂等表无记录 → 重新执行 fn（第二次成功）
      const resume = makeResumeFlowV2(mockSpawnAgent);
      const resumed = await resume(store, runId);
      expect(resumed.status).toBe("done");
      expect(calls).toBe(2);
      expect(store.loadEffectRecords(runId).length).toBe(1);
      expect(store.loadState(runId)).toMatchObject({ out: '{"persisted":true}' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails node with clear error for unknown effect name", async () => {
    const { result, store, runId, dir } = await runFlow({
      name: "t", entry: "e",
      nodes: [{ id: "e", type: "effect", effect: "nope.missing" }],
      edges: [],
    });
    try {
      expect(result.status).toBe("failed");
      const cp = store.listCheckpoints(runId).find((c) => c.nodeId === "e" && c.status === "failed");
      expect(cp).toBeTruthy();
      expect(cp!.output).toContain("not registered");
      expect(cp!.output).toContain("nope.missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("effect schema validation", () => {
  it("rejects type:effect node missing the effect field (registered name)", () => {
    const r = validateFlow({
      name: "t", entry: "e",
      nodes: [{ id: "e", type: "effect" }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("effect") && e.includes("required"))).toBe(true);
    }
  });

  it("accepts a well-formed effect node", () => {
    const r = validateFlow({
      name: "t", entry: "e",
      nodes: [{ id: "e", type: "effect", effect: "test.effect.double", args: ["x"], writes: { out: "{{output}}" } }],
      edges: [],
      state: { x: 1 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.nodes[0]!.effect).toBe("test.effect.double");
    }
  });
});
