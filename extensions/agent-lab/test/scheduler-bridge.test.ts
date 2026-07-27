import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSchedulerSelection } from "../src/interceptor/scheduler-bridge.ts";
import type { SchedulerBridgeDeps, SchedulerRuntimeLike } from "../src/interceptor/scheduler-bridge.ts";
import type { LabConfig, SchedulerConfig } from "../src/types.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function cfg(sched?: SchedulerConfig): LabConfig & { scheduler: SchedulerConfig } {
  return {
    weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    autoApply: true,
    acceptanceScoreMap: {},
    interruptedPenalty: 0.3,
    toolFailPenalty: 0.2,
    topN: 3,
    catalogTtlMs: 21_600_000,
    mode: "classic",
    arena: {
      endowment: { K: 100, floor: 0.05 },
      odds: { easy: 1.5, medium: 3.0, hard: 5.0 },
      settlement: { tax: 5, errorMode: "stakeTimesOdds" },
      cost: { tokenMult: 1.0, toolMult: 1.0, latencyMult: 1.0, resourceFactor: 1.0, toolWeights: {} },
      bidding: { timeoutMs: 10000, promptTemplate: "" },
      market: { staleTaskTimeoutMs: 600000, eligibility: "all", maxBidders: 6, bidderSelector: "top-balance" },
    },
    scheduler: sched ?? { enabled: false },
  };
}

type DispatchCall = {
  traceId: string;
  dispatchId?: string;
  schedulerInstanceId?: string;
  role: string;
  task: string;
  taskCategory?: string;
  labels?: Record<string, string>;
  caller?: string;
  mode: string;
  signal?: AbortSignal;
};

function fakeRuntime(dispatchResult: unknown): { runtime: () => SchedulerRuntimeLike; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  return {
    calls,
    runtime: () => ({
      dispatch(req) {
        calls.push({ ...req });
        return Promise.resolve(dispatchResult) as ReturnType<SchedulerRuntimeLike["dispatch"]>;
      },
    }),
  };
}

function completedResult(model: string): unknown {
  return {
    status: "completed",
    schedulerInstanceId: "default-weighted-scorer",
    roundId: "round-0",
    selectedAgentId: `agent-${model.replace(/\//g, "-")}`,
    model,
    reason: "top score",
    attempts: [{ schedulerInstanceId: "default-weighted-scorer", roundId: "round-0", status: "completed" }],
  };
}

function abstainedResult(reason: string): unknown {
  return {
    status: "abstained",
    schedulerInstanceId: "default-weighted-scorer",
    roundId: "round-0",
    reason,
    attempts: [{ schedulerInstanceId: "default-weighted-scorer", roundId: "round-0", status: "abstained" }],
  };
}

function failedResult(): unknown {
  return {
    status: "failed",
    error: { code: "SCHEDULER_ERROR", message: "boom", retryable: false },
    attempts: [{ schedulerInstanceId: "default-weighted-scorer", status: "failed" }],
  };
}

function fallbackOriginalResult(): unknown {
  return {
    status: "fallback",
    target: { type: "original-request" },
    attempts: [{ schedulerInstanceId: "default-weighted-scorer", status: "failed" }],
  };
}

const defaultDeps: SchedulerBridgeDeps = {
  runtime: () => undefined,
  modelAllowed: () => true,
};

// ── Tests ───────────────────────────────────────────────────────────

// Behavior 1: scheduler disabled
test("disabled scheduler => skip", async () => {
  const r = fakeRuntime(completedResult("deepseek/deepseek-v3.2"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: false }) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "scheduler disabled" });
  assert.equal(r.calls.length, 0);
});

test("scheduler block absent => skip", async () => {
  const r = fakeRuntime(completedResult("deepseek/deepseek-v3.2"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const c = cfg(undefined!);
  delete (c as Record<string, unknown>).scheduler;
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: c },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "scheduler disabled" });
  assert.equal(r.calls.length, 0);
});

// Behavior 1b: scheduler block present but enabled is falsy (undefined)
test("scheduler block present with enabled undefined => skip", async () => {
  const r = fakeRuntime(completedResult("deepseek/deepseek-v3.2"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({}) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "scheduler disabled" });
  assert.equal(r.calls.length, 0);
});

// Behavior 2: runtime unavailable
test("enabled but runtime() returns undefined => skip", async () => {
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: () => undefined };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "runtime unavailable" });
});

// Behavior 3: completed + modelAllowed => apply
test("enabled + completed + modelAllowed => apply", async () => {
  const r = fakeRuntime(completedResult("deepseek/deepseek-v3.2"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.equal(decision.action, "apply");
  assert.equal((decision as { model: string }).model, "deepseek/deepseek-v3.2");
  assert.equal((decision as { source: string }).source, "scheduler");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].role, "coder");
  assert.equal(r.calls[0].task, "fix bug");
  assert.equal(r.calls[0].mode, "select");
});

// Behavior 4: completed but model not allowed => skip
test("completed + modelNotAllowed => skip", async () => {
  const r = fakeRuntime(completedResult("blocked/model"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime, modelAllowed: () => false };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "model not allowed: blocked/model" });
});

// Behavior 5a: abstained => skip
test("enabled + abstained => skip", async () => {
  const r = fakeRuntime(abstainedResult("no candidates"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "scheduler abstained: no candidates" });
});

// Behavior 5b: failed => skip
test("enabled + failed => skip", async () => {
  const r = fakeRuntime(failedResult());
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "scheduler failed" });
});

// Behavior 5c: fallback original-request => skip
test("enabled + fallback(original-request) => skip", async () => {
  const r = fakeRuntime(fallbackOriginalResult());
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "scheduler fell back to original request" });
});

// Behavior 6: completed result with no model => skip
test("completed but no model in result => skip", async () => {
  const r = fakeRuntime({ ...completedResult(""), model: undefined, selectedAgentId: undefined });
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.deepEqual(decision, { action: "skip", reason: "scheduler completed without model" });
});

// Behavior 7: runtime() throws => skip (fail-open)
test("runtime() throws => skip (fail-open)", async () => {
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: () => { throw new Error("init failed"); } };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.equal(decision.action, "skip");
  assert.ok((decision as { reason: string }).reason.startsWith("runtime error:"));
});

// Behavior 8: dispatch rejects => skip (fail-open)
test("dispatch rejects => skip (fail-open)", async () => {
  const deps: SchedulerBridgeDeps = {
    ...defaultDeps,
    runtime: () => ({
      dispatch: () => Promise.reject(new Error("dispatch boom")),
    }),
  };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.equal(decision.action, "skip");
  assert.ok((decision as { reason: string }).reason.startsWith("dispatch error:"));
});

// Behavior 9: instanceId override
test("instanceId override forwarded to dispatch", async () => {
  const r = fakeRuntime(completedResult("deepseek/deepseek-v3.2"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true, instanceId: "my-custom-instance" }) },
    deps,
  );
  assert.equal(decision.action, "apply");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].schedulerInstanceId, "my-custom-instance");
});

// Behavior 10: traceId = toolCallId when provided
test("traceId = toolCallId when provided", async () => {
  const r = fakeRuntime(completedResult("deepseek/deepseek-v3.2"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", toolCallId: "tc-123", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.equal(decision.action, "apply");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].traceId, "tc-123");
});

test("traceId fallback when toolCallId absent", async () => {
  const r = fakeRuntime(completedResult("deepseek/deepseek-v3.2"));
  const deps: SchedulerBridgeDeps = { ...defaultDeps, runtime: r.runtime };
  const decision = await decideSchedulerSelection(
    { role: "coder", task: "fix bug", cfg: cfg({ enabled: true }) },
    deps,
  );
  assert.equal(decision.action, "apply");
  assert.equal(r.calls.length, 1);
  assert.ok(typeof r.calls[0].traceId === "string" && r.calls[0].traceId.length > 0);
});
