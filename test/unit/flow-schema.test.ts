import { describe, it, expect } from "vitest";
import { validateFlow } from "../../src/ptl/flow/schema.js";

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
      tenant: "local",
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
      expect(r.warnings).toEqual([]);
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
          tenant: "t",
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
