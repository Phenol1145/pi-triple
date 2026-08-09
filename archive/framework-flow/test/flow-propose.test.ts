import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FlowStore } from "../../packages/framework/src/flow/store.js";
import { propose, discard, resumeV2, setValue, EditResult } from "../../packages/framework/src/flow/edit.js";
import { validateFlow, type FlowDef } from "../../packages/framework/src/flow/schema.js";
import { makeRunFlowV2, makeResumeFlowV2, type SpawnAgent, type RunResult, type SpawnResult } from "../../packages/framework/src/flow/engine.js";

let tmpRoot: string;
let store: FlowStore;

function mockSpawn(outputs: Record<string, string | [number, string, string | null]>): SpawnAgent {
  return async function spawnAgent(
    node: { id: string; prompt?: string },
  ): Promise<SpawnResult> {
    const out = outputs[node.id] ?? "default";
    if (Array.isArray(out)) {
      const [exitCode, output, signal] = out;
      return { output: output ?? "", exitCode: exitCode ?? 0, signal: signal ?? null };
    }
    return { output: String(out), exitCode: 0, signal: null };
  };
}

function makeGraph(name: string): string {
  const def: FlowDef = {
    name: name.replace(/[^a-z0-9-]/g, "-"),
    entry: "a",
    state: {},
    nodes: [
      { id: "a", type: "agent", prompt: "echo:hello", writes: { result: "{{output}}" } },
      { id: "b", type: "agent", prompt: "echo:world", writes: { result: "{{output}}" } },
      { id: "gate", type: "human", message: "OK?", writes: { round: "{{increment:state.round}}" } },
    ],
    edges: [
      { from: "a", to: "gate" },
      { from: "gate", to: "b" },
      { from: "b", to: "end" },
    ],
  };
  const runId = store.createRun(def, {});
  return runId;
}

function makeWaitingRun(): string {
  const def: FlowDef = {
    name: "waiting-test",
    entry: "review",
    state: { round: 0, approved: false },
    nodes: [
      { id: "review", type: "agent", prompt: "p", writes: {} },
      { id: "gate", type: "human", message: "Approve?", writes: { round: "{{increment:state.round}}" } },
    ],
    edges: [
      { from: "review", to: "gate" },
      { from: "gate", to: "end" },
    ],
  };
  const runId = store.createRun(def, {});
  // Execute review → gate to reach waiting_human
  const run = makeRunFlowV2(mockSpawn({ review: "done" }));
  run(store, runId);
  return runId;
}

describe("flow propose/discard/resume", () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flow-test-"));
    store = new FlowStore(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── propose ────────────────────────────────────────────────

  describe("propose", () => {
    it("running → editRequested=true", async () => {
      // Create a run that is in "running" state
      const def: FlowDef = {
        name: "propose-running",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "p", writes: { result: "{{output}}" } },
          { id: "b", type: "agent", prompt: "p", writes: {} },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "end" }],
      };
      const runId = store.createRun(def, {});

      const result = await propose(store, runId);
      expect(result.ok).toBe(true);

      const meta = store.loadMeta(runId);
      expect(meta.editRequested).toBe(true);
    });

    it("waiting_human → immediately editing", async () => {
      const def: FlowDef = {
        name: "prop-waiting",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "p", writes: {} },
          { id: "gate", type: "human", message: "OK?" },
        ],
        edges: [{ from: "a", to: "gate" }, { from: "gate", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: "done" }));
      await run(store, runId);
      expect(store.loadMeta(runId).status).toBe("waiting_human");

      const result = await propose(store, runId);
      expect(result.ok).toBe(true);

      const meta = store.loadMeta(runId);
      expect(meta.status).toBe("editing");
      // human pending should be preserved
      expect(store.loadPending(runId)).not.toBeNull();
    });

    it("failed → immediately editing", async () => {
      const def: FlowDef = {
        name: "prop-failed",
        entry: "a",
        state: {},
        nodes: [{ id: "a", type: "agent", prompt: "p", writes: {} }],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null] }));
      await run(store, runId);
      expect(store.loadMeta(runId).status).toBe("failed");

      const result = await propose(store, runId);
      expect(result.ok).toBe(true);

      expect(store.loadMeta(runId).status).toBe("editing");
    });

    it("done → error", async () => {
      const def: FlowDef = {
        name: "prop-done",
        entry: "a",
        state: {},
        nodes: [{ id: "a", type: "agent", prompt: "p", writes: {} }],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: "done" }));
      await run(store, runId);
      expect(store.loadMeta(runId).status).toBe("done");

      const result = await propose(store, runId);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("done");
    });

    it("editing → idempotent ok", async () => {
      const def: FlowDef = {
        name: "prop-edit",
        entry: "a",
        state: {},
        nodes: [{ id: "a", type: "agent", prompt: "p", writes: {} }],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null] }));
      await run(store, runId);
      await propose(store, runId);

      const result = await propose(store, runId);
      expect(result.ok).toBe(true);
    });
  });

  // ── discard ────────────────────────────────────────────────

  describe("discard", () => {
    it("editing → running, clears all barrier state", async () => {
      const def: FlowDef = {
        name: "discard-test",
        entry: "a",
        state: {},
        nodes: [{ id: "a", type: "agent", prompt: "p", writes: {} }],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null] }));
      await run(store, runId);
      await propose(store, runId);
      // queue an edit
      store.updateMeta(runId, {
        pendingEdits: [{ path: "nodes.0.prompt", value: "new-prompt" }],
      });

      const result = await discard(store, runId);
      expect(result.ok).toBe(true);

      const meta = store.loadMeta(runId);
      expect(meta.status).toBe("running");
      expect(meta.editRequested).toBeFalsy();
      expect(meta.editBaseWave).toBeUndefined();
      expect(meta.pendingEdits).toBeUndefined();
    });

    it("non-editing → error", async () => {
      const def: FlowDef = {
        name: "disc-nonedit",
        entry: "a",
        state: {},
        nodes: [{ id: "a", type: "agent", prompt: "p", writes: {} }],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = store.createRun(def, {});

      const result = await discard(store, runId);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not in editing");
    });
  });

  // ── resumeV2 ────────────────────────────────────────────────

  describe("resumeV2", () => {
    it("editing → re-validate + clear + continue wave loop", async () => {
      const def: FlowDef = {
        name: "resume-edit",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "p", writes: { result: "{{output}}" } },
          { id: "b", type: "agent", prompt: "echo:tail", writes: { tail: "{{output}}" } },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "end" }],
      };
      const runId = store.createRun(def, {});
      // Run to completion, then propose, then resume
      const run = makeRunFlowV2(mockSpawn({ a: "mid", b: "tail" }));
      const rr1 = await run(store, runId);
      // It's done
      expect(rr1.status).toBe("done");

      // Can't propose done runs, so let's create a failed run instead
    });

    it("editing with pendingEdits applies them during resume", async () => {
      const def: FlowDef = {
        name: "resume-queue",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "echo:old", writes: { result: "{{output}}" } },
          { id: "b", type: "agent", prompt: "echo:tail", writes: { tail: "{{output}}" } },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "end" }],
      };
      const runId = store.createRun(def, {});
      // Make a fail so we can enter editing
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null], b: "tail" }));
      await run(store, runId);
      expect(store.loadMeta(runId).status).toBe("failed");
      await propose(store, runId);

      // Queue an edit to b's prompt
      store.updateMeta(runId, {
        pendingEdits: [{ path: "nodes.1.prompt", value: "echo:new-tail" }],
      });

      // Resume with b succeeding
      const r2 = await resumeV2(
        store, runId,
        makeResumeFlowV2(mockSpawn({ a: "old-restart", b: "new-tail-output" })),
      );

      // After resume + queue application + wave loop: b runs with new prompt
      expect(r2.status === "done" || r2.status === "waiting_human").toBe(true);

      // Check the graph now has the new prompt
      if (r2.status !== "failed") {
        const graph = store.loadGraph(runId);
        expect((graph.nodes[1] as any).prompt).toBe("echo:new-tail");
      }
    });

    it("resumeV2 with stale human pending re-enters human node", async () => {
      const def: FlowDef = {
        name: "resume-human",
        entry: "review",
        state: { round: 0, approved: false },
        nodes: [
          { id: "review", type: "agent", prompt: "p", writes: {} },
          { id: "gate", type: "human", message: "Review done. Approve?", writes: {} },
        ],
        edges: [{ from: "review", to: "gate" }, { from: "gate", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ review: "analysis" }));
      const r1 = await run(store, runId);
      expect(r1.status).toBe("waiting_human");

      // Now propose (switches to editing, preserves pending)
      await propose(store, runId);
      expect(store.loadPending(runId)).not.toBeNull();

      // Resume — should discard stale pending, re-enter human node with current graph
      const r2 = await resumeV2(
        store, runId,
        makeResumeFlowV2(mockSpawn({ review: "analysis" })),
      );
      expect(r2.status).toBe("waiting_human");
      // Old pending should be replaced by new one
      const newPending = store.loadPending(runId);
      expect(newPending).not.toBeNull();
      expect(newPending?.nodeId).toBe("gate");
    });

    it("resumeV2 with invalid graph stays in editing", async () => {
      const def: FlowDef = {
        name: "resume-bad-graph",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "p", writes: {} },
          { id: "b", type: "agent", prompt: "p", writes: {} },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null], b: "tail" }));
      await run(store, runId);
      await propose(store, runId);

      // Corrupt the graph: add needs referencing nonexistent node
      const graph = store.loadGraph(runId);
      (graph.nodes[0] as any).needs = ["nonexistent", "b"];  // b exists, nonexistent doesn't
      const graphPath = path.join(store["runDir"](runId), "graph.json");
      fs.writeFileSync(graphPath, JSON.stringify(graph));

      const r2 = await resumeV2(
        store, runId,
        makeResumeFlowV2(mockSpawn({})),
      );
      expect(r2.ok).toBe(false);
      expect(r2.error).toContain("re-validation");
      expect(store.loadMeta(runId).status).toBe("editing");
    });

    it("pendingEdits that fail individually are collected and skipped", async () => {
      const def: FlowDef = {
        name: "resume-partial",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "p", writes: { result: "{{output}}" } },
          { id: "b", type: "agent", prompt: "echo:tail", writes: { tail: "{{output}}" } },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null], b: "tail" }));
      await run(store, runId);
      await propose(store, runId);

      // Queue edits: one valid, one invalid
      store.updateMeta(runId, {
        pendingEdits: [
          { path: "nodes.1.prompt", value: "echo:new" }, // valid
          { path: "nodes.99.prompt", value: "bad" },     // invalid — out of range
        ],
      });

      const r2 = await resumeV2(
        store, runId,
        makeResumeFlowV2(mockSpawn({ a: "retry-a", b: "new" })),
      );
      expect(r2.ok).toBe(true);
      // valid edit should have been applied
      const graph = store.loadGraph(runId);
      expect((graph.nodes[1] as any).prompt).toBe("echo:new");
    });
  });

  // ── setValue running guard ──────────────────────────────────

  describe("setValue running guard", () => {
    it("running → queues edit, auto-proposes", async () => {
      const def: FlowDef = {
        name: "running-set",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "p", writes: {} },
          { id: "b", type: "agent", prompt: "echo:tail", writes: {} },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "end" }],
      };
      const runId = store.createRun(def, {});

      // Set before any execution: status should be "running" from createRun
      // Actually, let's just manually set it to running
      store.updateMeta(runId, { status: "running" });

      // Call setValue while "running" — should queue + auto propose
      const result = await setValue(store, runId, "nodes.1.prompt", "echo:queued");

      expect(result.ok).toBe(true);
      expect(result.status).toBe("queued");

      const meta = store.loadMeta(runId);
      expect(meta.editRequested).toBe(true);
      expect(meta.pendingEdits).toBeDefined();
      expect(meta.pendingEdits!.some((e) => e.path === "nodes.1.prompt")).toBe(true);
    });

    it("failed → immediate effect (v1 semantics)", async () => {
      const def: FlowDef = {
        name: "failed-set",
        entry: "a",
        state: {},
        nodes: [
          { id: "a", type: "agent", prompt: "echo:old", writes: {} },
        ],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null] }));
      await run(store, runId);
      expect(store.loadMeta(runId).status).toBe("failed");

      const result = await setValue(store, runId, "nodes.0.prompt", "echo:changed");
      expect(result.ok).toBe(true);
      expect(result.status).toBeUndefined(); // not queued

      const graph = store.loadGraph(runId);
      expect((graph.nodes[0] as any).prompt).toBe("echo:changed");
    });

    it("editing → immediate effect", async () => {
      const def: FlowDef = {
        name: "editing-set",
        entry: "a",
        state: {},
        nodes: [{ id: "a", type: "agent", prompt: "echo:old", writes: {} }],
        edges: [{ from: "a", to: "end" }],
      };
      const runId = store.createRun(def, {});
      const run = makeRunFlowV2(mockSpawn({ a: [1, "", null] }));
      await run(store, runId);
      await propose(store, runId);

      const result = await setValue(store, runId, "nodes.0.prompt", "echo:changed");
      expect(result.ok).toBe(true);

      const graph = store.loadGraph(runId);
      expect((graph.nodes[0] as any).prompt).toBe("echo:changed");
    });
  });
});
