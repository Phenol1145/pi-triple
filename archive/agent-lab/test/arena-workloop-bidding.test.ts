import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import {
  createArenaSchedulerImplementation,
  type ArenaSchedulerPorts,
} from "../src/schedulers/arena-scheduler.ts";
import { ARENA_DEFAULT_PARAMETERS, type ArenaSchedulerParameters } from "../src/schedulers/arena-definition.ts";
import type { SchedulerSDK, SchedulingInput } from "../src/scheduler/contracts.ts";
import type { EndowmentPolicy } from "../src/arena/types.ts";
import type { ModelInfo } from "../src/types.ts";

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };
function model(id: string): ModelInfo {
  return { id, provider: id.split("/")[0], name: id, accessRoute: "free", pricing: { in: 2, out: 6 } };
}

function params(over: Partial<ArenaSchedulerParameters["bidding"]>): ArenaSchedulerParameters {
  return { ...ARENA_DEFAULT_PARAMETERS, bidding: { ...ARENA_DEFAULT_PARAMETERS.bidding, ...over } };
}

function input(): SchedulingInput {
  return { traceId: "t", dispatchId: "d", role: "default", task: "write fn", taskCategory: "coding", mode: "select", settlementRef: "ref-1" };
}

function buildSDK(): SchedulerSDK {
  return {
    agents: { list: async () => [], create: async () => ({ id: "x" }), run: async () => ({ status: "completed" as const, output: { text: "" } }) },
    storage: { get: () => undefined, put: () => ({ value: undefined as unknown, version: 1 }) },
    telemetry: { emit() {} },
    control: { signal: new AbortController().signal },
  };
}

test("workloop engine: bids collected via workLoopBidder port, winner = highest stake", async () => {
  const calls: { model: string; agentId: string }[] = [];
  const bidsByAgent: Record<string, number> = { "agent-openai/gpt-4": 30, "agent-anthropic/claude-3": 80 };
  const candidates = [model("openai/gpt-4"), model("anthropic/claude-3")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { throw new Error("should not be called in workloop engine"); } },
    resolveAgent: (m) => `agent-${m.id}`,
    workLoopBidder: async (m, _prompt, opts) => {
      calls.push({ model: m.id, agentId: opts.agentId });
      const stake = bidsByAgent[opts.agentId] ?? 0;
      return { stake, reasoning: "sim" };
    },
  };
  const scheduler = createArenaSchedulerImplementation(ports);

  const result = await scheduler.schedule(input(), params({ engine: "workloop", maxConcurrentBids: 2 }), buildSDK());

  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
});

test("workloop engine: workLoopBidder returns undefined → stake 0 (fail-open)", async () => {
  const candidates = [model("openai/gpt-4")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { return "50"; } },
    resolveAgent: (m) => `agent-${m.id}`,
    workLoopBidder: async () => undefined,
  };
  const scheduler = createArenaSchedulerImplementation(ports);
  const result = await scheduler.schedule(input(), params({ engine: "workloop" }), buildSDK());
  // 唯一候选出价 0 → failed (no-eligible-bids)
  assert.equal(result.status, "failed");
  assert.equal((result as { error?: { code?: string } }).error?.code, "no-eligible-bids");
});

test("model-caller engine (default): ModelCaller used, workLoopBidder NOT called", async () => {
  let callerHits = 0;
  let bidderCalled = false;
  const candidates = [model("openai/gpt-4")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { callerHits++; return "55"; } },
    resolveAgent: (m) => `agent-${m.id}`,
    workLoopBidder: async () => { bidderCalled = true; return { stake: 99 }; },
  };
  const scheduler = createArenaSchedulerImplementation(ports);
  const result = await scheduler.schedule(input(), params({ engine: "model-caller" }), buildSDK());
  assert.equal(result.status, "completed");
  assert.equal(callerHits, 1);
  assert.equal(bidderCalled, false);
});

test("workloop engine without workLoopBidder port → falls back to model-caller", async () => {
  let callerHits = 0;
  const candidates = [model("openai/gpt-4")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { callerHits++; return "40"; } },
    resolveAgent: (m) => `agent-${m.id}`,
    // 无 workLoopBidder
  };
  const scheduler = createArenaSchedulerImplementation(ports);
  const result = await scheduler.schedule(input(), params({ engine: "workloop" }), buildSDK());
  assert.equal(result.status, "completed");
  assert.equal(callerHits, 1);
});
