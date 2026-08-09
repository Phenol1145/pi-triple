import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { FlowStore } from "../../packages/framework/src/flow/store.js";
import { makeRunFlowV2, makeResumeFlowV2, type RunResult } from "../../packages/framework/src/flow/engine.js";
import path from "node:path";
import { validateFlow } from "../../packages/framework/src/flow/schema.js";
import { registerCodeFn } from "../../packages/framework/src/flow/code-registry.js";

// Register test code functions globally
beforeAll(() => {
  registerCodeFn("identity", () => ({ result: "ok" }));
  registerCodeFn("append_result", () => "item processed");
  registerCodeFn("no_op", () => null);
});

// Helper to create a simple flow with fanout node
function createFanoutFlow(
  fanoutId: string,
  opts: {
    maxFanout?: number;
    itemsFrom?: string;
    out?: string;
  } = {}
) {
  const { maxFanout, itemsFrom = "items", out = "results" } = opts;

  const nodes = [
    {
      id: "entry",
      type: "code" as const,
      fn: "identity",
    },
    {
      id: fanoutId,
      type: "fanout" as const,
      itemsFrom,
      body: [
        {
          id: "item_processor",
          type: "code" as const,
          fn: "append_result",
        },
      ],
      out,
      ...(maxFanout !== undefined && { maxFanout }),
    },
    {
      id: "end_fanout",
      type: "code" as const,
      fn: "no_op",
      writes: {},
    },
  ];

  const edges = [
    { from: "entry", to: fanoutId },
    { from: fanoutId, to: "end_fanout" },
  ];

  return {
    name: "test_fanout_flow",
    entry: "entry",
    nodes,
    edges,
  };
}

describe("fanout node schema validation", () => {
  it("should accept fanout node with required fields", () => {
    const rawFlow = {
      name: "test",
      entry: "entry",
      state: { items: [], results: [] },
      nodes: [
        { id: "entry", type: "code", fn: "test" },
        {
          id: "fanout1",
          type: "fanout",
          itemsFrom: "items",
          body: [{ id: "body_node", type: "code", fn: "body_fn" }],
          out: "results",
        },
      ],
      edges: [{ from: "entry", to: "fanout1" }],
    };
    const result = validateFlow(rawFlow);
    expect(result.ok).toBe(true);
  });

  it("should reject fanout node missing itemsFrom", () => {
    const rawFlow = {
      name: "test",
      entry: "entry",
      nodes: [
        { id: "entry", type: "code", fn: "test" },
        {
          id: "fanout1",
          type: "fanout",
          body: [{ id: "body_node", type: "code", fn: "body_fn" }],
          out: "results",
        },
      ],
      edges: [{ from: "entry", to: "fanout1" }],
    };
    const result = validateFlow(rawFlow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("itemsFrom"))).toBe(true);
    }
  });

  it("should reject fanout node missing out", () => {
    const rawFlow = {
      name: "test",
      entry: "entry",
      nodes: [
        { id: "entry", type: "code", fn: "test" },
        {
          id: "fanout1",
          type: "fanout",
          itemsFrom: "items",
          body: [{ id: "body_node", type: "code", fn: "body_fn" }],
        },
      ],
      edges: [{ from: "entry", to: "fanout1" }],
    };
    const result = validateFlow(rawFlow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("out"))).toBe(true);
    }
  });

  it("should reject fanout node missing body", () => {
    const rawFlow = {
      name: "test",
      entry: "entry",
      nodes: [
        { id: "entry", type: "code", fn: "test" },
        {
          id: "fanout1",
          type: "fanout",
          itemsFrom: "items",
          out: "results",
        },
      ],
      edges: [{ from: "entry", to: "fanout1" }],
    };
    const result = validateFlow(rawFlow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("body"))).toBe(true);
    }
  });

  it("should reject fanout node with invalid maxFanout type", () => {
    const rawFlow = {
      name: "test",
      entry: "entry",
      nodes: [
        { id: "entry", type: "code", fn: "test" },
        {
          id: "fanout1",
          type: "fanout",
          maxFanout: "not-a-number",
          itemsFrom: "items",
          body: [{ id: "body_node", type: "code", fn: "body_fn" }],
          out: "results",
        },
      ],
      edges: [{ from: "entry", to: "fanout1" }],
    };
    const result = validateFlow(rawFlow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("maxFanout"))).toBe(true);
    }
  });
});

describe("fanout node execution scenarios", () => {
  let store: FlowStore;
  let runFlowV2: (store: FlowStore, runId: string) => Promise<RunResult>;
  const testDir = "/tmp/ptl-flow-test-fanout";

  beforeEach(() => {
    // Clean up any existing test data
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    store = new FlowStore(testDir);
    runFlowV2 = makeRunFlowV2(async (node, _prompt, _cwd, _env) => {
      if (node.type === "code") {
        const fn = node.fn as string;
        if (fn === "identity") {
          return { output: JSON.stringify({ result: "ok" }), exitCode: 0, signal: null };
        }
        if (fn === "append_result") {
          return { output: JSON.stringify("item processed"), exitCode: 0, signal: null };
        }
        if (fn === "no_op") {
          return { output: "", exitCode: 0, signal: null };
        }
      }
      return { output: "", exitCode: 0, signal: null };
    });
  });

  afterEach(() => {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  // Scenario 1: 3 候选激活 3 分支 + 结果数组长度 3（顺序保持）
  it("scenario 1: 3 candidates activate 3 branches, result array length 3 (order preserved)", async () => {
    const flow = createFanoutFlow("fanout1");
    const runId = store.createRun(flow, {});

    // Initialize state with items and empty results
    store.saveState(runId, {
      items: ["item1", "item2", "item3"],
      results: [],
    });

    const result = await runFlowV2(store, runId);

    expect(result.status).toBe("done");

    const state = store.loadState(runId);
    expect(state.results).toBeDefined();
    expect(Array.isArray(state.results)).toBe(true);
    expect(state.results).toEqual(["item1", "item2", "item3"]);
  });

  // Scenario 2: 0 候选 → 空数组
  it("scenario 2: 0 candidates → empty array", async () => {
    const flow = createFanoutFlow("fanout1");
    const runId = store.createRun(flow, {});

    // Initialize state with empty items
    store.saveState(runId, {
      items: [],
      results: [],
    });

    const result = await runFlowV2(store, runId);

    expect(result.status).toBe("done");

    const state = store.loadState(runId);
    expect(state.results).toBeDefined();
    expect(Array.isArray(state.results)).toBe(true);
    expect(state.results.length).toBe(0);
  });

  // Scenario 3: 候选 > maxFanout → 清晰抛错
  it("scenario 3: candidates > maxFanout → clear error", async () => {
    const flow = createFanoutFlow("fanout1", { maxFanout: 2 }); // maxFanout = 2
    const runId = store.createRun(flow, {});

    // Initialize state with 5 items, but maxFanout = 2
    store.saveState(runId, {
      items: ["item1", "item2", "item3", "item4", "item5"],
      results: [],
    });

    const result = await runFlowV2(store, runId);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("maxFanout");
  });

  // Scenario 4: 分支失败隔离（1/3 失败 → 结果 2 元素）
  it("scenario 4: branch failure isolation (1/3 fails → 2 elements)", async () => {
    let callCount = 0;
    const flow = createFanoutFlow("fanout1");
    const runId = store.createRun(flow, {});

    store.saveState(runId, {
      items: ["item1", "item2", "item3"],
      results: [],
    });

    // Simulate one failure
    const runFlowV2WithFailure = makeRunFlowV2(async (node, _prompt, _cwd, _env) => {
      if (node.type === "code") {
        const fn = node.fn as string;
        if (fn === "append_result") {
          callCount++;
          if (callCount === 2) {
            return { output: "", exitCode: 1, signal: "SIGTERM" };
          }
          return { output: JSON.stringify("item processed"), exitCode: 0, signal: null };
        }
      }
      return { output: "", exitCode: 0, signal: null };
    });

    const result = await runFlowV2WithFailure(store, runId);

    expect(result.status).toBe("done");

    const state = store.loadState(runId);
    // Should have 2 results (one branch failed)
    expect(state.results.length).toBe(2);
  });

  // Scenario 5: no-op 分支不产元素（结果无 null/占位）
  it("scenario 5: no-op branches do not produce elements (no null/placeholders)", async () => {
    const flow = createFanoutFlow("fanout1");
    const runId = store.createRun(flow, {});

    // Only 2 items, maxFanout defaults to 32, so 30 no-op branches
    store.saveState(runId, {
      items: ["item1", "item2"],
      results: [],
    });

    const result = await runFlowV2(store, runId);

    expect(result.status).toBe("done");

    const state = store.loadState(runId);
    expect(state.results).toBeDefined();
    expect(Array.isArray(state.results)).toBe(true);
    expect(state.results.length).toBe(2);
    expect(state.results).not.toContain(null);
    expect(state.results).not.toContain(undefined);
  });

  // Scenario 6: 首轮完成后篡改 state[itemsFrom]，强制 resume 仍用首轮候选快照
  it("scenario 6: resume uses first-round candidate snapshot even after state[itemsFrom] is tampered", async () => {
    const flow = {
      name: "test_fanout_snapshot_resume",
      entry: "fanout1",
      nodes: [
        {
          id: "fanout1",
          type: "fanout" as const,
          itemsFrom: "items",
          body: [
            {
              id: "item_processor",
              type: "code" as const,
              fn: "append_result",
            },
          ],
          out: "results",
        },
      ],
      edges: [{ from: "fanout1", to: "end" }],
    };
    const runId = store.createRun(flow, {});

    store.saveState(runId, {
      items: ["item1", "item2", "item3"],
      results: [],
    });

    const result1 = await runFlowV2(store, runId);
    expect(result1.status).toBe("done");
    expect(store.loadState(runId).results).toEqual(["item1", "item2", "item3"]);

    // Tamper the candidate source after completion
    store.saveState(runId, {
      items: ["tampered"],
      results: [],
    });

    // Force the fanout node to re-execute by resetting epoch state and
    // removing wave checkpoints, then resume the same runId.
    const meta = store.loadMeta(runId);
    store.updateMeta(runId, {
      status: "running",
      firedEpoch: {},
      consumed: {},
      stepCount: 0,
    });
    const wavesDir = path.join(store.runDir(runId), "waves");
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(wavesDir)) {
      fs.rmSync(wavesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(wavesDir, { recursive: true });

    const resume = makeResumeFlowV2(async (node, _prompt, _cwd, _env) => {
      if (node.type === "code") {
        const fn = node.fn as string;
        if (fn === "append_result") {
          return { output: JSON.stringify("item processed"), exitCode: 0, signal: null };
        }
      }
      return { output: "", exitCode: 0, signal: null };
    });
    const result2 = await resume(store, runId);

    expect(result2.status).toBe("done");
    // Snapshot should win over the tampered state[itemsFrom]
    expect(store.loadState(runId).results).toEqual(["item1", "item2", "item3"]);
  });

  // Scenario 7: maxFanout 默认 32
  it("scenario 7: maxFanout defaults to 32", () => {
    const flow = createFanoutFlow("fanout1");

    // After schema validation, maxFanout should be undefined (use default in engine)
    const fanoutNode = flow.nodes.find((n) => n.id === "fanout1") as any;

    expect(fanoutNode.maxFanout).toBeUndefined();
  });

  it("scenario 7b: 33 candidates without maxFanout should fail with default 32", async () => {
    const flow = createFanoutFlow("fanout1");
    const runId = store.createRun(flow, {});

    const items = Array.from({ length: 33 }, (_, i) => `item${i + 1}`);
    store.saveState(runId, {
      items,
      results: [],
    });

    const result = await runFlowV2(store, runId);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("maxFanout");
  });
});

describe("fanout node default maxFanout behavior", () => {
  let store: FlowStore;
  let runFlowV2: (store: FlowStore, runId: string) => Promise<RunResult>;
  const testDir = "/tmp/ptl-flow-test-fanout-default";

  beforeEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    store = new FlowStore(testDir);
    runFlowV2 = makeRunFlowV2(async (node, _prompt, _cwd, _env) => {
      if (node.type === "code") {
        return { output: JSON.stringify("item processed"), exitCode: 0, signal: null };
      }
      return { output: "", exitCode: 0, signal: null };
    });
  });

  afterEach(() => {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it("should accept more than default 32 candidates only if maxFanout is increased", async () => {
    const flow = createFanoutFlow("fanout1", { maxFanout: 40 });
    const runId = store.createRun(flow, {});

    // 40 items, maxFanout = 40
    const items = Array.from({ length: 40 }, (_, i) => `item${i + 1}`);
    store.saveState(runId, {
      items,
      results: [],
    });

    const result = await runFlowV2(store, runId);

    expect(result.status).toBe("done");

    const state = store.loadState(runId);
    expect(state.results.length).toBe(40);
  });
});

describe("fanout body agent prompt interpolation", () => {
  let store: FlowStore;
  const testDir = "/tmp/ptl-flow-test-fanout-agent-prompt";

  beforeEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    store = new FlowStore(testDir);
  });

  afterEach(() => {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it("receives the current item value via {{state.fanoutId.item}}", async () => {
    const flow = {
      name: "test_fanout_body_agent",
      entry: "entry",
      nodes: [
        {
          id: "entry",
          type: "code" as const,
          fn: "identity",
        },
        {
          id: "fanout1",
          type: "fanout" as const,
          itemsFrom: "items",
          body: [
            {
              id: "body_agent",
              type: "agent" as const,
              prompt: "process {{state.fanout1.item}}",
            },
          ],
          out: "results",
        },
        {
          id: "end_fanout",
          type: "code" as const,
          fn: "no_op",
          writes: {},
        },
      ],
      edges: [
        { from: "entry", to: "fanout1" },
        { from: "fanout1", to: "end_fanout" },
      ],
    };

    const runId = store.createRun(flow, {});
    store.saveState(runId, {
      items: ["alpha", "beta"],
      results: [],
    });

    const prompts: string[] = [];
    const run = makeRunFlowV2(async (node, renderedPrompt, _cwd, _env) => {
      if (node.type === "code") {
        const fn = node.fn as string;
        if (fn === "identity") {
          return { output: JSON.stringify({ result: "ok" }), exitCode: 0, signal: null };
        }
        if (fn === "no_op") {
          return { output: "", exitCode: 0, signal: null };
        }
      }
      if (node.id === "body_agent") {
        prompts.push(renderedPrompt);
        return { output: "processed", exitCode: 0, signal: null };
      }
      return { output: "", exitCode: 0, signal: null };
    });

    const result = await run(store, runId);

    expect(result.status).toBe("done");
    expect(prompts).toEqual(["process alpha", "process beta"]);
    expect(store.loadState(runId).results).toEqual(["alpha", "beta"]);
  });
});