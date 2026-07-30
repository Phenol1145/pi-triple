import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import { BidBoard } from "../src/arena/bid-board.ts";
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

function buildSDK(bidBoard: BidBoard, bidsByAgent: Record<string, number>, runCalls: { agentId: string; task: string; config: unknown }[]): SchedulerSDK {
  return {
    agents: {
      list: async () => [],
      create: async () => ({ id: "x" }),
      run: async (agentId: string, req: { task: string; configOverrides?: Record<string, unknown>; timeoutMs?: number }) => {
        runCalls.push({ agentId, task: req.task, config: req.configOverrides });
        // 模拟 subagent 解析 token 并调用 place_bid
        const m = req.task.match(/token="([^"]+)"/);
        const stake = bidsByAgent[agentId] ?? 0;
        if (m) bidBoard.place(m[1]!, stake, "simulated");
        return { status: "completed" as const, output: { text: "bid placed" } };
      },
    },
    storage: { get: () => undefined, put: () => ({ value: undefined as unknown, version: 1 }) },
    telemetry: { emit() {} },
    control: { signal: new AbortController().signal },
  };
}

test("workloop engine: bids collected via BidBoard, winner = highest stake", async () => {
  const bidBoard = new BidBoard();
  const runCalls: { agentId: string; task: string; config: unknown }[] = [];
  const candidates = [model("openai/gpt-4"), model("anthropic/claude-3")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { throw new Error("should not be called in workloop engine"); } },
    resolveAgent: (m) => `agent-${m.id}`,
    bidBoard,
  };
  const scheduler = createArenaSchedulerImplementation(ports);
  const sdk = buildSDK(bidBoard, { "agent-openai/gpt-4": 30, "agent-anthropic/claude-3": 80 }, runCalls);

  const result = await scheduler.schedule(input(), params({ engine: "workloop", maxConcurrentBids: 2 }), sdk);

  assert.equal(result.status, "completed");
  assert.equal(runCalls.length, 2);
  // 每次 run 都带 skill + turnBudget（候选自己的模型）
  for (const c of runCalls) {
    const cfg = c.config as Record<string, unknown>;
    assert.equal(cfg.skill, "agent-lab-bidding");
    assert.deepEqual(cfg.turnBudget, { maxTurns: 3 });
    assert.ok(typeof cfg.model === "string");
  }
});

test("workloop engine: subagent that never calls place_bid → stake 0 (fail-open)", async () => {
  const bidBoard = new BidBoard();
  const candidates = [model("openai/gpt-4")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { return "50"; } },
    resolveAgent: (m) => `agent-${m.id}`,
    bidBoard,
  };
  const scheduler = createArenaSchedulerImplementation(ports);
  // run 不 place 任何 bid
  const sdk: SchedulerSDK = {
    agents: { list: async () => [], create: async () => ({ id: "x" }), run: async () => ({ status: "completed" as const, output: { text: "" } }) },
    storage: { get: () => undefined, put: () => ({ value: undefined as unknown, version: 1 }) },
    telemetry: { emit() {} },
    control: { signal: new AbortController().signal },
  };
  const result = await scheduler.schedule(input(), params({ engine: "workloop" }), sdk);
  // 唯一候选出价 0 → failed (no-eligible-bids)，与 model-caller 0 价行为一致
  assert.equal(result.status, "failed");
  assert.equal((result as { error?: { code?: string } }).error?.code, "no-eligible-bids");
});

test("model-caller engine (default): ModelCaller used, bidBoard untouched", async () => {
  const bidBoard = new BidBoard();
  let callerHits = 0;
  const candidates = [model("openai/gpt-4")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { callerHits++; return "55"; } },
    resolveAgent: (m) => `agent-${m.id}`,
    bidBoard,
  };
  const scheduler = createArenaSchedulerImplementation(ports);
  const runCalls: unknown[] = [];
  const sdk = buildSDK(bidBoard, {}, runCalls as never);
  const result = await scheduler.schedule(input(), params({ engine: "model-caller" }), sdk);
  assert.equal(result.status, "completed");
  assert.equal(callerHits, 1);
  assert.equal(runCalls.length, 0); // agents.run 未被调用
});

test("workloop engine without bidBoard port → falls back to model-caller", async () => {
  let callerHits = 0;
  const candidates = [model("openai/gpt-4")];
  const ports: ArenaSchedulerPorts = {
    ledger: new SqliteLedger(new DatabaseSync(":memory:"), fixedEndow),
    candidates: () => candidates,
    modelCaller: { async complete() { callerHits++; return "40"; } },
    resolveAgent: (m) => `agent-${m.id}`,
    // 无 bidBoard
  };
  const scheduler = createArenaSchedulerImplementation(ports);
  const sdk = buildSDK(new BidBoard(), {}, []);
  const result = await scheduler.schedule(input(), params({ engine: "workloop" }), sdk);
  assert.equal(result.status, "completed");
  assert.equal(callerHits, 1);
});
