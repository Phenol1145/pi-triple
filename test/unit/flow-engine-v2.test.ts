import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FlowStore } from "../../src/ptl/flow/store.js";
import {
  type FlowDef,
  type NodeDef,
  type EdgeDef,
} from "../../src/ptl/flow/schema.js";
import {
  type SpawnAgent,
  type SpawnResult,
  type RunResult,
  makeRunFlow,
  makeResumeFlow,
  makeRunFlowV2,
  makeResumeFlowV2,
} from "../../src/ptl/flow/engine.js";

// ── Mock spawnAgent ──────────────────────────────────────────

/** nodeId → output map for deterministic parallel testing */
type MockResponses = Record<string, string | Error>;

function makeMockSpawnAgent(responses: MockResponses): SpawnAgent {
  return async (node, _renderedPrompt, _cwd, _env): Promise<SpawnResult> => {
    const resp = responses[node.id];
    if (resp instanceof Error) {
      return { output: "", exitCode: 1, signal: null };
    }
    if (resp !== undefined) {
      return { output: resp, exitCode: 0, signal: null };
    }
    return { output: "OK", exitCode: 0, signal: null };
  };
}

function mockSpawn(exits: Record<string, unknown>): SpawnAgent {
  return async (node, _rendered, _cwd, _env) => {
    const v = exits[node.id];
    if (Array.isArray(v)) {
      // [exitCode, output, signal]
      return {
        exitCode: (v[0] as number) ?? 0,
        output: (v[1] as string) ?? "",
        signal: (v[2] as string | null) ?? null,
      };
    }
    return { exitCode: 0, output: String(v ?? "OK"), signal: null };
  };
}

// ── Helpers ───────────────────────────────────────────────────

function createRun(store: FlowStore, def: FlowDef, input: Record<string, string> = {}): string {
  return store.createRun(def, input);
}

/** Simple linear: a → b → end */
function linearFlow(): FlowDef {
  return {
    name: "test-linear",
    entry: "a",
    state: { count: 0 },
    nodes: [
      { id: "a", type: "agent", prompt: "echo:stepA", writes: { result: "{{output}}", count: "{{increment:state.count}}" } },
      { id: "b", type: "agent", prompt: "echo:stepB {{state.result}}", writes: { final: "{{output}}" } },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "end" },
    ],
  };
}

/** Diamond fan-out/fan-in: prepare → review-kimi, review-ds (parallel) → summarize needs both */
function diamondFlow(): FlowDef {
  return {
    name: "test-diamond",
    entry: "prepare",
    maxSteps: 20,
    state: { reviews: { initial: [], reducer: "append" }, summary: "" },
    nodes: [
      { id: "prepare", type: "agent", prompt: "echo:material", writes: { material: "{{output}}" } },
      { id: "review-kimi", type: "agent", prompt: "echo:review-kimi-output", writes: { reviews: "{{output}}" } },
      { id: "review-ds", type: "agent", prompt: "echo:review-ds-output", writes: { reviews: "{{output}}" } },
      { id: "summarize", type: "agent", needs: ["review-kimi", "review-ds"],
        prompt: "echo:summary", writes: { summary: "{{output}}" } },
    ],
    edges: [
      { from: "prepare", to: "review-kimi" },
      { from: "prepare", to: "review-ds" },
      { from: "review-kimi", to: "summarize" },
      { from: "review-ds", to: "summarize" },
      { from: "summarize", to: "end" },
    ],
  };
}

/** Cycle with guard: review→gate→(approved?fix:review) */
function cycleFlow(): FlowDef {
  return {
    name: "test-cycle",
    entry: "review",
    maxSteps: 10,
    state: { round: 0, approved: false, verdict: "" },
    nodes: [
      { id: "review", type: "agent", prompt: "echo:issues", writes: { verdict: "{{output}}" } },
      { id: "gate", type: "human", message: "Approve?", writes: { round: "{{increment:state.round}}" } },
      { id: "fix", type: "agent", prompt: "echo:fix-done", writes: { fixResult: "{{output}}" } },
    ],
    edges: [
      { from: "review", to: "gate" },
      { from: "gate", to: "fix", when: "state.approved == true" },
      { from: "gate", to: "end", when: "state.round >= 3" },
      { from: "gate", to: "review" },
      { from: "fix", to: "end" },
    ],
  };
}

/** Simple chain with conditional + fallback */
function conditionalFlow(): FlowDef {
  return {
    name: "test-conditional",
    entry: "a",
    state: { score: 0 },
    nodes: [
      { id: "a", type: "agent", prompt: "echo:big", writes: { score: "99" } },
      { id: "b", type: "agent", prompt: "echo:big-path", writes: { path: "{{output}}" } },
      { id: "c", type: "agent", prompt: "echo:small-path", writes: { path: "{{output}}" } },
    ],
    edges: [
      { from: "a", to: "b", when: "state.score > 10" },
      { from: "a", to: "c" },
      { from: "b", to: "end" },
      { from: "c", to: "end" },
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("FlowEngine v2 — waves", () => {
  let store: FlowStore;
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pit-flow-v2-"));
    store = new FlowStore(testRoot);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  // ── v1 compatibility ───────────────────────────────────────

  describe("v1 compatibility (single-out-edge chain)", () => {
    it("linear flow behaves identically to v1", async () => {
      const def = linearFlow();
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ a: "stepA", b: "stepB stepA" }));
      const result = await run(store, runId);

      expect(result.status).toBe("done");
      const state = store.loadState(runId);
      expect(state.result).toBe("stepA");
      expect(state.final).toBe("stepB stepA");
      expect(state.count).toBe(1);

      const cps = store.listCheckpoints(runId);
      expect(cps.length).toBe(2);
      expect(cps[0].nodeId).toBe("a");
      expect(cps[1].nodeId).toBe("b");

      // Wave checkpoints should exist
      const waves = store.listWaveCheckpoints(runId);
      expect(waves.length).toBe(2); // one wave per node
    });

    it("conditional routing follows when-edge priority", async () => {
      const def = conditionalFlow();
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ a: "big", b: "big-path", c: "small-path" }));
      const result = await run(store, runId);

      expect(result.status).toBe("done");
      const state = store.loadState(runId);
      // score 是字符串 "99"，比较运算符数字强转：99 > 10 → true → big-path
      expect(state.path).toBe("big-path");
    });

    it("cycle flow with human gate works (v1 compatibility)", async () => {
      const def = cycleFlow();
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ review: "issues", fix: "fix-done" }));

      // First run → pauses at gate
      const r1 = await run(store, runId);
      expect(r1.status).toBe("waiting_human");

      // Approve
      const state = store.loadState(runId);
      state.approved = true;
      store.saveState(runId, state);

      const resume = makeResumeFlowV2(mockSpawn({ review: "issues", fix: "fix-done" }));
      const r2 = await resume(store, runId);
      expect(r2.status).toBe("done");

      const finalState = store.loadState(runId);
      expect(finalState.fixResult).toBe("fix-done");
      expect(finalState.round).toBe(1);
    });
  });

  // ── Wave parallelism ───────────────────────────────────────

  describe("wave parallelism", () => {
    it("diamond fan-out runs parallel nodes in same wave", async () => {
      const def = diamondFlow();
      const runId = createRun(store, def);

      // Track spawned calls
      const calls: string[] = [];
      const spawn = makeMockSpawnAgent({
        prepare: "material",
        "review-kimi": "kimi-output",
        "review-ds": "ds-output",
        summarize: "summary-text",
      });
      // Wrap to track concurrent calls
      const trackingSpawn: SpawnAgent = async (node, prompt, cwd, env) => {
        calls.push(node.id);
        // tiny delay to test concurrency
        await new Promise((r) => setTimeout(r, 10));
        return spawn(node, prompt, cwd, env);
      };

      const run = makeRunFlowV2(trackingSpawn);
      const result = await run(store, runId);

      expect(result.status).toBe("done");

      // Check state
      const state = store.loadState(runId);
      expect(state.material).toBe("material");
      expect((state.reviews as Array<{node: string; value: unknown}>).length).toBe(2);
      expect((state.reviews as Array<{node: string; value: unknown}>)[0].node).toBe("review-ds");
      expect((state.reviews as Array<{node: string; value: unknown}>)[1].node).toBe("review-kimi");
      expect(state.summary).toBe("summary-text");

      // Wave checkpoints
      const waves = store.listWaveCheckpoints(runId);
      expect(waves.length).toBe(3); // prepare → {kimi,ds} → summarize
      expect(waves[1].nodes.length).toBe(2);
      expect(waves[1].nodes.sort()).toEqual(["review-ds", "review-kimi"]);

      // Node checkpoints: 4 nodes all completed
      const cps = store.listCheckpoints(runId);
      expect(cps.length).toBe(4);
    });

    it("needs AND-join waits for all declared predecessors", async () => {
      // Create a flow where summarize has needs:[kimi,ds]
      // Make ds slow to verify summarize doesn't start early
      const def = diamondFlow();
      const runId = createRun(store, def);

      const completionOrder: string[] = [];
      const spawn: SpawnAgent = async (node, _p, _cwd, _env) => {
        if (node.id === "review-ds") {
          await new Promise((r) => setTimeout(r, 100)); // slow
        }
        completionOrder.push(node.id);
        return { output: `out-${node.id}`, exitCode: 0, signal: null };
      };

      const run = makeRunFlowV2(spawn);
      const result = await run(store, runId);
      expect(result.status).toBe("done");

      // kimi should complete before ds starts (in same wave, but kimi returns first)
      // summarize should be last (waits for both in next wave)
      expect(completionOrder.indexOf("prepare")).toBeLessThan(completionOrder.indexOf("review-kimi"));
      expect(completionOrder.indexOf("prepare")).toBeLessThan(completionOrder.indexOf("review-ds"));
      // summarize starts only after both reviews complete
      expect(completionOrder[completionOrder.length - 1]).toBe("summarize");
    });

    it("firedEpoch increments correctly in cycle loops", async () => {
      // A→B→A cycle with guard: A fires B by default, B fires A (loop back)
      // A has 2 out-edges: A→B (when score < 3) and A→end (fallback)
      const def: FlowDef = {
        name: "test-epoch-cycle",
        entry: "a",
        maxSteps: 10,
        state: { score: 0 },
        nodes: [
          { id: "a", type: "agent", prompt: "echo:tick", writes: { score: "{{increment:state.score}}" } },
          { id: "b", type: "agent", prompt: "echo:tock", writes: {} },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a", when: "state.score < 3" },
          { from: "b", to: "end" },
        ],
      };
      const runId = createRun(store, def);

      const spawn = mockSpawn({ a: "tick", b: "tock" });
      const run = makeRunFlowV2(spawn);
      const result = await run(store, runId);

      expect(result.status).toBe("done");
      const state = store.loadState(runId);
      // score should be 3: a(0→1)→b→a(1→2)→b→a(2→3)→b→end (when score<3 is false)
      expect(state.score).toBe(3);

      // firedEpoch should be tracked
      const meta = store.loadMeta(runId);
      expect(meta.firedEpoch).toBeDefined();
      expect(meta.firedEpoch["a"]).toBe(3);
      expect(meta.firedEpoch["b"]).toBe(3);
      expect(meta.stepCount).toBe(6);
    });

    it("entry with no predecessors fires on start", async () => {
      const def: FlowDef = {
        name: "test-entry",
        entry: "start",
        nodes: [
          { id: "start", type: "agent", prompt: "echo:hello", writes: { msg: "{{output}}" } },
        ],
        edges: [{ from: "start", to: "end" }],
      };
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ start: "hello" }));
      const result = await run(store, runId);

      expect(result.status).toBe("done");
      expect(store.loadState(runId).msg).toBe("hello");
    });

    it("conditional branch: only activated edge triggers (any-join)", async () => {
      // A→B when flag true, A→C when flag false
      // B→end, C→end
      const def: FlowDef = {
        name: "test-cond-branch",
        entry: "a",
        state: { flag: "yes" },
        nodes: [
          { id: "a", type: "agent", prompt: "echo:x", writes: { result: "{{output}}" } },
          { id: "b", type: "agent", prompt: "echo:branch-b", writes: { path: "{{output}}" } },
          { id: "c", type: "agent", prompt: "echo:branch-c", writes: { path: "{{output}}" } },
        ],
        edges: [
          { from: "a", to: "b", when: "state.flag == \"yes\"" },
          { from: "a", to: "c", when: "state.flag == \"no\"" },
          { from: "b", to: "end" },
          { from: "c", to: "end" },
        ],
      };
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ a: "x", b: "branch-b", c: "branch-c" }));
      const result = await run(store, runId);

      expect(result.status).toBe("done");
      expect(store.loadState(runId).path).toBe("branch-b");

      // c should NOT have been executed (no activated edge pointing to it)
      const cps = store.listCheckpoints(runId);
      expect(cps.find((c) => c.nodeId === "c")).toBeUndefined();
    });
  });

  // ── Drain / failure ────────────────────────────────────────

  describe("drain on failure", () => {
    it("failed node in wave doesn't cancel sibling nodes", async () => {
      const def = diamondFlow();
      // Make review-ds fail
      const def2: FlowDef = JSON.parse(JSON.stringify(def));
      const runId = createRun(store, def2);

      const spawn = mockSpawn({
        prepare: "material",
        "review-kimi": "kimi-output",
        "review-ds": [1, "", null], // exitCode=1
        summarize: "summary",
      });

      const run = makeRunFlowV2(spawn);
      const result = await run(store, runId);

      // Drain: kimi completes, ds fails, wave drain completes
      // summarize needs both kimi+ds → ds failed means firedEpoch not advanced
      // So summarize's needs won't be satisfied → needs hunger
      expect(result.status).toBe("failed");
      expect(result.error).toContain("needs hunger");

      // kimi's checkpoint should be completed
      const cps = store.listCheckpoints(runId);
      const kimiCP = cps.find((c) => c.nodeId === "review-kimi");
      expect(kimiCP?.status).toBe("completed");

      // ds should have failed checkpoint
      const dsCP = cps.find((c) => c.nodeId === "review-ds");
      expect(dsCP?.status).toBe("failed");

      // Wave checkpoint for the drain wave should exist
      const waves = store.listWaveCheckpoints(runId);
      expect(waves.length).toBe(2); // wave 1 prepare, wave 2 {kimi,ds} drain
      expect(waves[1].nodes.length).toBe(2);

      // firedEpoch for ds should be 0 (not advanced), kimi should be 1
      const meta = store.loadMeta(runId);
      expect(meta.firedEpoch["review-ds"] ?? 0).toBe(0);
      expect(meta.firedEpoch["review-kimi"]).toBe(1);
    });

    it("resume after drain re-runs failed nodes, skips completed ones", async () => {
      const def = diamondFlow();
      const runId = createRun(store, def);

      // First run: ds fails
      const run1 = makeRunFlowV2(mockSpawn({
        prepare: "material",
        "review-kimi": "kimi-output",
        "review-ds": [1, "", null],
        summarize: "summary",
      }));
      const r1 = await run1(store, runId);
      expect(r1.status).toBe("failed");

      // Now resume with ds succeeding
      const resume = makeResumeFlowV2(mockSpawn({
        prepare: "material",
        "review-kimi": "kimi-output",
        "review-ds": "ds-output-retry",
        summarize: "summary-retry",
      }));
      const r2 = await resume(store, runId);
      expect(r2.status).toBe("done");

      // kimi should NOT re-run (completed in drain wave)
      // ds should re-run, summarize should execute
      const cps = store.listCheckpoints(runId);
      const kimiCPs = cps.filter((c) => c.nodeId === "review-kimi");
      expect(kimiCPs.length).toBe(1); // didn't re-run
      const dsCPs = cps.filter((c) => c.nodeId === "review-ds");
      expect(dsCPs.length).toBe(2); // re-ran
      // First ds is failed, second is completed
      expect(dsCPs[0].status).toBe("failed");
      expect(dsCPs[1].status).toBe("completed");

      // firedEpoch for ds should now be 1
      const meta = store.loadMeta(runId);
      expect(meta.firedEpoch["review-ds"]).toBe(1);

      // Final state should reflect ds's output + summarize
      const state = store.loadState(runId);
      expect(state.summary).toBe("summary-retry");
    });
  });

  // ── editRequested barrier ───────────────────────────────────

  describe("editRequested barrier", () => {
    it("stops at wave boundary when editRequested is set", async () => {
      const def: FlowDef = {
        name: "test-barrier",
        entry: "a",
        maxSteps: 20,
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "echo:a1", writes: { step: "{{output}}" } },
          { id: "b", type: "agent", prompt: "echo:b1", writes: { step2: "{{output}}" } },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "end" },
        ],
      };
      const runId = createRun(store, def);

      // Set editRequested before running
      store.updateMeta(runId, { editRequested: true });

      const run = makeRunFlowV2(mockSpawn({ a: "a1", b: "b1" }));
      const result = await run(store, runId);

      // Should complete wave 1 (a), detect editRequested, stop
      expect(result.status).toBe("done");
      // But meta should show editing status
      const meta = store.loadMeta(runId);
      expect(meta.status).toBe("editing");
      expect(meta.editBaseWave).toBe(1);

      // b should NOT have been executed
      const cps = store.listCheckpoints(runId);
      expect(cps.find((c) => c.nodeId === "b")).toBeUndefined();

      // firedEpoch[a] should be 1
      expect(meta.firedEpoch["a"]).toBe(1);
    });

    it("resume from editing continues with next wave", async () => {
      const def: FlowDef = {
        name: "test-barrier-resume",
        entry: "a",
        maxSteps: 20,
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "echo:a1", writes: { step: "{{output}}" } },
          { id: "b", type: "agent", prompt: "echo:b1", writes: { step2: "{{output}}" } },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "end" },
        ],
      };
      const runId = createRun(store, def);
      store.updateMeta(runId, { editRequested: true });

      const run = makeRunFlowV2(mockSpawn({ a: "a1", b: "b1" }));
      await run(store, runId);

      // Now resume from editing
      const resume = makeResumeFlowV2(mockSpawn({ a: "a1", b: "b1" }));
      const r2 = await resume(store, runId);
      expect(r2.status).toBe("done");

      const cps = store.listCheckpoints(runId);
      expect(cps.find((c) => c.nodeId === "b")).toBeDefined();
      expect(store.loadState(runId).step2).toBe("b1");
    });
  });

  // ── Reducers ────────────────────────────────────────────────

  describe("reducers in wave merge", () => {
    it("append reducer collects {node, value} pairs in nodeId order", async () => {
      const def = diamondFlow();
      const runId = createRun(store, def);

      const run = makeRunFlowV2(mockSpawn({
        prepare: "material",
        "review-kimi": "kimi-output",
        "review-ds": "ds-output",
        summarize: "summary-text",
      }));
      await run(store, runId);

      const state = store.loadState(runId);
      const reviews = state.reviews as Array<{node: string; value: unknown}>;
      expect(reviews.length).toBe(2);
      // nodeId order: review-ds < review-kimi alphabetically
      expect(reviews[0].node).toBe("review-ds");
      expect(reviews[0].value).toBe("ds-output");
      expect(reviews[1].node).toBe("review-kimi");
      expect(reviews[1].value).toBe("kimi-output");
    });

    it("concat reducer joins strings with separator", async () => {
      const def: FlowDef = {
        name: "test-concat",
        entry: "a",
        maxSteps: 20,
        state: { notes: { initial: "", reducer: "concat" } },
        nodes: [
          { id: "a", type: "agent", prompt: "echo:note-a", writes: { notes: "{{output}}" } },
          { id: "b", type: "agent", prompt: "echo:note-b", writes: { notes: "{{output}}" } },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "end" },
        ],
      };
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ a: "note-a", b: "note-b" }));
      await run(store, runId);

      const state = store.loadState(runId);
      expect(state.notes).toBe("note-a\n\n---\n\nnote-b");
    });

    it("last-wins reducer: single writer wins", async () => {
      const def: FlowDef = {
        name: "test-last-wins",
        entry: "a",
        state: { result: "" },
        nodes: [
          { id: "a", type: "agent", prompt: "echo:final", writes: { result: "{{output}}" } },
        ],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ a: "final" }));
      await run(store, runId);

      expect(store.loadState(runId).result).toBe("final");
    });
  });

  // ── maxSteps ────────────────────────────────────────────────

  describe("maxSteps", () => {
    it("fails when total stepCount exceeds maxSteps", async () => {
      const def: FlowDef = {
        name: "test-max-steps",
        entry: "a",
        maxSteps: 3,
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "echo:1", writes: {} },
        ],
        edges: [{ from: "a", to: "a" }], // self-loop
      };
      const runId = createRun(store, def);
      // Set stepCount near limit
      store.updateMeta(runId, { stepCount: 2 });

      const run = makeRunFlowV2(mockSpawn({ a: "1" }));
      const result = await run(store, runId);
      // stepCount=2 → execute a (step 3, firedEpoch[3]) → next wave: stepCount=3≥maxSteps → fail
      // Actually: stepCount check is BEFORE executing a wave node
      // After a executes, stepCount becomes 3. Next iteration: check stepCount≥3 → fail
      expect(result.status).toBe("failed");
      expect(result.error).toContain("maxSteps");
    });
  });

  // ── needs hunger ────────────────────────────────────────────

  describe("needs hunger", () => {
    it("detects hunger when AND-join can never be satisfied", async () => {
      // prepare→X,Y → summarize needs:[X,Y]
      // But Y never gets activated (no edge → Y)
      const def: FlowDef = {
        name: "test-hunger",
        entry: "prepare",
        maxSteps: 20,
        state: {},
        nodes: [
          { id: "prepare", type: "agent", prompt: "echo:data", writes: { data: "{{output}}" } },
          { id: "x", type: "agent", prompt: "echo:review-x", writes: { reviews: "{{output}}" } },
          { id: "y", type: "agent", prompt: "echo:review-y", writes: { reviews: "{{output}}" } },
          { id: "summarize", type: "agent", needs: ["x", "y"], prompt: "echo:sum", writes: {} },
        ],
        edges: [
          { from: "prepare", to: "x" },
          // no edge to y!
          { from: "x", to: "summarize" },
          { from: "y", to: "summarize" },
          { from: "summarize", to: "end" },
        ],
      };
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({
        prepare: "data", x: "review-x", y: "review-y", summarize: "sum",
      }));
      const result = await run(store, runId);

      // x runs, y never activated → summarize needs hunger
      expect(result.status).toBe("failed");
      expect(result.error).toContain("needs hunger");
      expect(result.error).toContain("summarize");
    });
  });

  // ── End-to-end: cycle + human gate ──────────────────────────

  describe("end-to-end cycle with human gate", () => {
    it("review→gate→reject→review(loop)→gate→approve→done", async () => {
      const def = cycleFlow();
      const runId = createRun(store, def);
      const run = makeRunFlowV2(mockSpawn({ review: "issues", fix: "fix-done" }));

      // Round 1: review → gate (waiting_human)
      const r1 = await run(store, runId);
      expect(r1.status).toBe("waiting_human");

      // Reject: approved stays false, gate writes round=1 (increment)
      const state1 = store.loadState(runId);
      state1.approved = false;
      store.saveState(runId, state1);

      const resume = makeResumeFlowV2(mockSpawn({ review: "issues", fix: "fix-done" }));
      const r2 = await resume(store, runId);
      // Should loop back: gate→review→gate (waiting again)
      expect(r2.status).toBe("waiting_human");

      const state2 = store.loadState(runId);
      expect(state2.round).toBe(1); // gate 完成一次（reject1），第二次 gate 仍待决策

      // Approve
      state2.approved = true;
      store.saveState(runId, state2);

      const r3 = await resume(store, runId);
      expect(r3.status).toBe("done");

      const finalState = store.loadState(runId);
      expect(finalState.fixResult).toBe("fix-done");
      expect(finalState.round).toBe(2); // reject1 + approve 各一次 increment
    });
  });
});
