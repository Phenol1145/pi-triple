import { describe, it, expect, beforeAll } from "vitest";
import { registerCodeFn } from "../../src/ptl/flow/code-registry.js";
import { makeRunFlowV2, renderMetrics } from "../../src/ptl/flow/engine.js";
import { FlowStore, readMetrics } from "../../src/ptl/flow/store.js";
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
    const store = new FlowStore(dir);
    const runId = store.createRun({
      name: "t", entry: "s",
      nodes: [{ id: "s", type: "code", fn: "test.settle", args: ["stake"], metrics: { credit: { amount: "{{result.delta}}", agent: "{{state.agentId}}" } } }],
      edges: [],
      state: { stake: 100, agentId: "a1" },
    }, {});
    const run = makeRunFlowV2(async () => ({ exitCode: 0, output: "", signal: null }));
    const result = await run(store, runId);
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
    const store = new FlowStore(dir);
    const runId = store.createRun({
      name: "t", entry: "a",
      nodes: [{ id: "a", type: "code", fn: "test.settle", args: ["stake"] }],
      edges: [],
      state: { stake: 1 },
    }, {});
    const run = makeRunFlowV2(async () => ({ exitCode: 0, output: "", signal: null }));
    const result = await run(store, runId);
    expect(result.status).toBe("done");
    expect(readMetrics(store, runId)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
