import { describe, it, expect } from "vitest";
import { validateFlow } from "../../packages/framework/src/flow/schema.js";

const PR_REVIEW: unknown = {
  name: "pr-review",
  entry: "analyze",
  state: { pr: "{{input.pr}}", round: 0 },
  maxSteps: 100,
  nodes: [
    {
      id: "analyze",
      type: "agent",
      model: "deepseek/deepseek-v4-flash",
      template: "local",
      prompt: "分析 PR {{state.pr}}",
      writes: { analysis: "{{output}}" },
      timeoutSec: 120,
    },
    {
      id: "review",
      type: "agent",
      model: "kimi/kimi-k3",
      prompt: "审查:\n{{state.analysis}}",
      writes: { verdict: "{{output}}" },
    },
    {
      id: "gate",
      type: "human",
      message: "第 {{state.round}} 轮：{{state.verdict}}\n批准？",
      writes: { round: "{{increment:state.round}}" },
    },
    {
      id: "fix",
      type: "agent",
      prompt: "修复: {{state.verdict}}",
      writes: { fixResult: "{{output}}" },
    },
  ],
  edges: [
    { from: "analyze", to: "review" },
    { from: "review", to: "gate" },
    { from: "gate", to: "fix", when: "state.approved == true" },
    { from: "gate", to: "end", when: "state.round >= 3" },
    { from: "gate", to: "review" },
    { from: "fix", to: "end" },
  ],
};

describe("flow-schema validate", () => {
  it("valid pr-review flow", () => {
    const r = validateFlow(PR_REVIEW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.nodes.length).toBe(4);
      expect(r.def.edges.length).toBe(6);
      // v2: cycle detection on edges → warning (gate→review is a cycle)
      expect(r.warnings.length).toBe(1);
      expect(r.warnings[0]).toContain("cycles");
    }
  });

  it("rejects non-object", () => {
    const r = validateFlow("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("object");
  });

  it("rejects missing name", () => {
    const r = validateFlow({ entry: "x", nodes: [], edges: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects entry not in nodes", () => {
    const r = validateFlow({ name: "x", entry: "ghost", nodes: [], edges: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("entry"))).toBe(true);
  });

  it("rejects edge with invalid from", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [{ from: "ghost", to: "n1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("from"))).toBe(true);
  });

  it("rejects edge with invalid to", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [{ from: "n1", to: "ghost" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("to"))).toBe(true);
  });

  it("rejects duplicate node id", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [
        { id: "dup", type: "agent", prompt: "a" },
        { id: "dup", type: "agent", prompt: "b" },
      ],
      edges: [{ from: "n1", to: "end" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects invalid type", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "tool", prompt: "x" }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("type"))).toBe(true);
  });

  it("agent requires prompt", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent" }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  it("human requires message", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "human" }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("message"))).toBe(true);
  });

  it("end is accepted as edge target", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [{ from: "n1", to: "end" }],
    });
    if (r.ok) {
      // OK
    } else {
      // should not have "to" error
      const hasToError = r.errors.some((e) => e.includes("to") && e.includes("end"));
      expect(hasToError).toBe(false);
    }
  });

  it("warns on unreachable nodes", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [
        { id: "n1", type: "agent", prompt: "hi" },
        { id: "orphan", type: "agent", prompt: "bye" },
      ],
      edges: [{ from: "n1", to: "end" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes("orphan"))).toBe(true);
    }
  });

  it("rejects invalid when expression", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [{ from: "n1", to: "end", when: "state.x @@@ 1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("when"))).toBe(true);
  });

  it("rejects cwd with ..", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi", cwd: "../escape" }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("cwd"))).toBe(true);
  });

  it("accepts valid cwd", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi", cwd: "subdir" }],
      edges: [],
    });
    if (r.ok) {
      expect(r.def.nodes[0].cwd).toBe("subdir");
    } else {
      expect(r.errors).toEqual([]);
    }
  });

  it("rejects maxSteps non-integer", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [],
      maxSteps: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("maxSteps"))).toBe(true);
  });

  it("agent optional fields valid", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [
        {
          id: "n1",
          type: "agent",
          prompt: "hi",
          model: "m",
          template: "t",
          tools: ["read"],
          timeoutSec: 30,
        },
      ],
      edges: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.nodes[0].tools).toEqual(["read"]);
      expect(r.def.nodes[0].timeoutSec).toBe(30);
    }
  });

  it("maxSteps default is 100", () => {
    const r = validateFlow({
      name: "x",
      entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [],
    });
    if (r.ok) expect(r.def.maxSteps).toBe(100);
    else console.log(r.errors); // debug
  });
});

describe("flow-schema validate v2", () => {
  it("accepts maxParallel", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [],
      maxParallel: 2,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.maxParallel).toBe(2);
  });

  it("maxParallel defaults to 4", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [],
    });
    if (r.ok) expect(r.def.maxParallel).toBe(4);
    else console.log(r.errors);
  });

  it("rejects maxParallel non-integer", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [],
      maxParallel: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("maxParallel"))).toBe(true);
  });

  it("warns on >1 unconditional edges from same node (fallback fan-out)", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [
        { from: "n1", to: "end" },
        { from: "n1", to: "end" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes("unconditional"))).toBe(true);
  });

  it("warns on multiple when edges (fan-out)", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [
        { from: "n1", to: "end", when: "state.a == 1" },
        { from: "n1", to: "end", when: "state.b == 2" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes("fan-out"))).toBe(true);
    }
  });

  it("accepts needs with correct static predecessors", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [
        { id: "n1", type: "agent", prompt: "hi" },
        { id: "n2", type: "agent", prompt: "hi" },
        { id: "n3", type: "agent", prompt: "hi", needs: ["n1", "n2"] },
      ],
      edges: [
        { from: "n1", to: "n3" },
        { from: "n2", to: "n3" },
        { from: "n3", to: "end" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.nodes[2].needs).toEqual(["n1", "n2"]);
  });

  it("rejects needs with missing static predecessor in edges", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [
        { id: "n1", type: "agent", prompt: "hi" },
        { id: "n2", type: "agent", prompt: "hi", needs: ["n1"] },
      ],
      edges: [], // no edge n1→n2
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("n2") && e.includes("needs must"))).toBe(true);
    }
  });

  it("rejects needs with extra edge not in needs", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [
        { id: "n1", type: "agent", prompt: "hi" },
        { id: "n2", type: "agent", prompt: "hi", needs: ["n1"] },
        { id: "n3", type: "agent", prompt: "hi" },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n3", to: "n2" },  // n3→n2 is a static predecessor but NOT in needs
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("n2") && e.includes("needs"))).toBe(true);
    }
  });

  it("rejects needs referencing non-existent node", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [
        { id: "n1", type: "agent", prompt: "hi" },
        { id: "n2", type: "agent", prompt: "hi", needs: ["ghost"] },
      ],
      edges: [{ from: "n1", to: "n2" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("needs") && e.includes("ghost"))).toBe(true);
    }
  });

  it("rejects needs cycle", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      nodes: [
        { id: "n1", type: "agent", prompt: "hi", needs: ["n2"] },
        { id: "n2", type: "agent", prompt: "hi", needs: ["n1"] },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n1" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("needs cycle"))).toBe(true);
    }
  });

  it("warns on last-wins with multiple writers", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      state: { result: "initial" },
      nodes: [
        { id: "n1", type: "agent", prompt: "hi", writes: { result: "{{output}}" } },
        { id: "n2", type: "agent", prompt: "hi", writes: { result: "{{output}}" } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "end" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes("last-wins") && w.includes("writers"))).toBe(true);
    }
  });

  it("rejects append reducer with non-array initial", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      state: { reviews: { initial: "not-array", reducer: "append" } },
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("append") && e.includes("array"))).toBe(true);
    }
  });

  it("accepts state with reducer declared", () => {
    const r = validateFlow({
      name: "x", entry: "n1",
      state: {
        bare: "value",
        reviews: { initial: [], reducer: "append" },
        notes: { initial: "", reducer: "concat" },
      },
      nodes: [{ id: "n1", type: "agent", prompt: "hi" }],
      edges: [],
    });
    expect(r.ok).toBe(true);
  });
});

describe("fanout node", () => {
  it("retains maxFanout after validateFlow", () => {
    const r = validateFlow({
      name: "fanout-max",
      entry: "f",
      nodes: [
        {
          id: "f",
          type: "fanout",
          itemsFrom: "items",
          body: [{ id: "b", type: "code", fn: "x" }],
          out: "results",
          maxFanout: 64,
        },
      ],
      edges: [{ from: "f", to: "end" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const f = r.def.nodes.find((n) => n.id === "f");
      expect(f?.maxFanout).toBe(64);
    }
  });
});

describe("code nodes", () => {
  const codeFlow = (over: Record<string, unknown>): unknown => ({
    name: "t", entry: "c", nodes: [{ id: "c", type: "code", fn: "market.score", ...over }], edges: [],
  });

  // brief 原版按 string[] 使用 validateFlow；实际签名为 {ok,def,warnings}|{ok,errors}（supervisor 批准适配，错误文案逐字保留）
  const flowErrors = (flow: unknown): string[] => {
    const r = validateFlow(flow);
    return r.ok ? [] : r.errors;
  };

  it("accepts valid code node", () => {
    expect(flowErrors(codeFlow({ args: ["bids"], writes: { winner: "{{output}}" } }))).toEqual([]);
  });

  it("rejects code node without fn", () => {
    const errs = flowErrors(codeFlow({ fn: undefined }));
    expect(errs).toContain('nodes[0] (code "c"): fn is required');
  });

  it("rejects code node with non-string fn", () => {
    expect(flowErrors(codeFlow({ fn: 42 }))).toContain('nodes[0] (code "c"): fn must be a string');
  });

  it("rejects code node with non-string-array args", () => {
    expect(flowErrors(codeFlow({ args: "bids" }))).toContain('nodes[0] (code "c"): args must be a string array');
  });

  it("rejects invalid metrics structure", () => {
    expect(flowErrors(codeFlow({ metrics: "bad" }))).toContain('nodes[0] ("c"): metrics must be an object of string-string maps');
    expect(flowErrors(codeFlow({ metrics: { credit: "bad" } }))).toContain('nodes[0] ("c"): metrics.credit must be an object');
    expect(flowErrors(codeFlow({ metrics: { credit: { amount: 42 } } }))).toContain('nodes[0] ("c"): metrics.credit.amount must be a string');
  });

  it("accepts metrics on agent nodes", () => {
    const flow: unknown = {
      name: "t", entry: "a",
      nodes: [{ id: "a", type: "agent", prompt: "hi", metrics: { credit: { amount: "{{result.x}}" } } }],
      edges: [],
    };
    expect(flowErrors(flow)).toEqual([]);
  });
});
