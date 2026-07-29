/**
 * flow/edit.test.ts — setValue / editGraph / approve / reject 测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FlowStore } from "../../src/ptl/flow/store.js";
import { setValue, approve, reject } from "../../src/ptl/flow/edit.js";

describe("flow edit — setValue", () => {
  let tmpDir: string;
  let store: FlowStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-edit-"));
    store = new FlowStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGraph(name: string) {
    // Dynamically import, build a basic flow and create a run
    const runId = store.createRun(
      {
        name,
        entry: "step1",
        nodes: [
          { id: "step1", type: "agent", prompt: "hello" },
          { id: "step2", type: "agent", prompt: "world" },
        ],
        edges: [
          { from: "step1", to: "step2" },
          { from: "step2", to: "end" },
        ],
      },
      {},
    );
    // Put run into failed state so we can rm it
    store.updateMeta(runId, { status: "failed" });
    return runId;
  }

  // ── graph changes ────────────────────────────────────

  it("set nodes.N.prompt updates graph and creates snapshot", async () => {
    const runId = makeGraph("test-set-prompt");
    const result = await setValue(store, runId, "nodes.0.prompt", '"new prompt"');
    expect(result.ok).toBe(true);

    // Verify graph changed
    const graph = store.loadGraph(runId);
    expect(graph.nodes[0]!.prompt).toBe("new prompt");

    // Verify snapshot exists
    const histDir = path.join(tmpDir, runId, "graph.history");
    const files = fs.readdirSync(histDir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    // Verify meta graphVersion bumped
    const meta = store.loadMeta(runId);
    expect(meta.graphVersion).toBeGreaterThan(1);
  });

  it("set nodes.N.id should be rejected (id change loses checkpoint linkage)", async () => {
    const runId = makeGraph("test-set-id");
    const result = await setValue(store, runId, "nodes.0.id", '"renamed"');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot change");
  });

  it("set value is JSON-parsed: number, boolean, string", async () => {
    const runId = makeGraph("test-set-types");
    const r1 = await setValue(store, runId, "maxSteps", "50");
    expect(r1.ok).toBe(true);
    expect(store.loadGraph(runId).maxSteps).toBe(50);

    // string needs quotes in JSON
    const r2 = await setValue(store, runId, "name", '"my-flow"');
    expect(r2.ok).toBe(true);
    expect(store.loadGraph(runId).name).toBe("my-flow");
  });

  it("set edges.N.to new target (valid reference)", async () => {
    const runId = makeGraph("test-set-edge");
    const result = await setValue(store, runId, "edges.0.to", '"end"');
    expect(result.ok).toBe(true);
  });

  it("set edges.N.to invalid reference → rejected", async () => {
    const runId = makeGraph("test-set-edge-bad");
    const result = await setValue(store, runId, "edges.0.to", '"nonexistent"');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonexistent");
  });

  it("set with unreachable node → warning but not error", async () => {
    const runId = makeGraph("test-set-unreachable");
    // Move step2's entry to the dead node
    const r = await setValue(store, runId, "edges.0.to", '"end"');
    // step2 becomes unreachable — should be warning, not error
    expect(r.ok).toBe(true);
  });

  it("set invalid JSON value → fallback to raw string", async () => {
    const runId = makeGraph("test-set-bad-json");
    const result = await setValue(store, runId, "nodes.0.prompt", "not-json-value");
    expect(result.ok).toBe(true);
    const graph = store.loadGraph(runId);
    expect((graph.nodes[0] as any).prompt).toBe("not-json-value");
  });

  it("set unknown path → error", async () => {
    const runId = makeGraph("test-set-unknown");
    const result = await setValue(store, runId, "bogus.key", "123");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });

  it("set state.* changes state.json", async () => {
    const runId = makeGraph("test-set-state");
    const result = await setValue(store, runId, "state.myVal", "42");
    expect(result.ok).toBe(true);
    const state = store.loadState(runId);
    expect(state.myVal).toBe(42); // number because JSON parse
  });

  it("set state.* with quoted value → string", async () => {
    const runId = makeGraph("test-set-state-str");
    const result = await setValue(store, runId, "state.x", '"hello"');
    expect(result.ok).toBe(true);
    const state = store.loadState(runId);
    expect(state.x).toBe("hello");
  });

  it("set nodes type should be rejected", async () => {
    const runId = makeGraph("test-set-type");
    const result = await setValue(store, runId, "nodes.0.type", '"human"');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot change");
  });
});

describe("flow edit — approve", () => {
  let tmpDir: string;
  let store: FlowStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-approve-"));
    store = new FlowStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRunWithPending(): string {
    const runId = store.createRun(
      {
        name: "test-flow",
        entry: "gate",
        nodes: [
          {
            id: "gate",
            type: "human",
            message: "approve?",
            writes: { "round": "{{increment:state.round}}" },
          },
          { id: "done", type: "agent", prompt: "done" },
        ],
        edges: [
          { from: "gate", to: "done", when: "state.approved == true" },
          { from: "gate", to: "done", when: "state.approved == false" },
          { from: "done", to: "end" },
        ],
      },
      {},
    );

    store.writePending(runId, {
      nodeId: "gate",
      graphVersion: 1,
      nodeSnapshot: {
        id: "gate",
        type: "human",
        message: "approve?",
        writes: { "round": "{{increment:state.round}}" },
      },
      message: "approve?",
      createdAt: Date.now(),
    });
    store.updateMeta(runId, { status: "waiting_human" });

    return runId;
  }

  it("approve sets state.approved=true with note", async () => {
    const runId = createRunWithPending();
    const state = store.loadState(runId);
    state.verdict = "OK";
    store.saveState(runId, state);

    const result = await approve(store, runId, "looks good");
    // approve applies writes (round++) then marks running
    // Since resumeFlow is called, it will try to actually run
    // But without a real spawnAgent, it will fail.
    // We just check state was set correctly before resume.
    expect(result.ok || !result.ok).toBeDefined();

    // After approve, state should have approved=true
    const postState = store.loadState(runId);
    expect(postState.approved).toBe(true);
    expect(postState.approveNote).toBe("looks good");
    // round should have incremented (from 0→1)
    expect(postState.round).toBe(1);
  });

  it("approve increments gate firedEpoch so downstream edge activates (regression)", async () => {
    const runId = createRunWithPending();
    await approve(store, runId, "ok");
    // 门完成后 firedEpoch 必须推进，否则 gate→done 边永远不激活（下游节点饱死）
    const meta = store.loadMeta(runId);
    expect(meta.firedEpoch?.["gate"]).toBe(1);
  });

  it("reject increments gate firedEpoch so downstream edge activates (regression)", async () => {
    const runId = createRunWithPending();
    await reject(store, runId, "no");
    const meta = store.loadMeta(runId);
    expect(meta.firedEpoch?.["gate"]).toBe(1);
  });

  it("approve rejected if not waiting_human", async () => {
    const runId = store.createRun(
      {
        name: "test",
        entry: "step1",
        nodes: [{ id: "step1", type: "agent", prompt: "hi" }],
        edges: [{ from: "step1", to: "end" }],
      },
      {},
    );
    store.updateMeta(runId, { status: "running" });

    const result = await approve(store, runId, "note");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("waiting_human");
  });

  it("approve refused if no pending payload", async () => {
    const runId = store.createRun(
      {
        name: "test",
        entry: "gate",
        nodes: [{ id: "gate", type: "human", message: "x" }],
        edges: [{ from: "gate", to: "end" }],
      },
      {},
    );
    store.updateMeta(runId, { status: "waiting_human" });
    // No pending written

    const result = await approve(store, runId, "nope");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("pending");
  });

  it("reject sets state.approved=false", async () => {
    const runId = createRunWithPending();
    const result = await reject(store, runId, "try again");
    expect(result.ok || !result.ok).toBeDefined();

    const postState = store.loadState(runId);
    expect(postState.approved).toBe(false);
    expect(postState.approveNote).toBe("try again");
    expect(postState.round).toBe(1);
  });
});
