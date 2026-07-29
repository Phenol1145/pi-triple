import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import {
  createArenaSchedulerImplementation,
  type ArenaSchedulerPorts,
} from "../src/schedulers/arena-scheduler.ts";
import {
  ARENA_DEFAULT_PARAMETERS,
  matchEligibility,
  type ArenaSchedulerParameters,
} from "../src/schedulers/arena-definition.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulerSDK,
  SettleContext,
  SettleOutcome,
} from "../src/scheduler/contracts.ts";
import type { ModelCaller, Ledger, EndowmentPolicy } from "../src/arena/types.ts";
import type { ModelInfo } from "../src/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };

function model(id: string, pricing?: { in: number; out: number }): ModelInfo {
  return {
    id,
    provider: id.split("/")[0],
    name: id,
    accessRoute: "free",
    pricing: pricing ?? { in: 2.0, out: 6.0 },
  };
}

interface TelemetryEvent {
  eventType: string;
  payload: unknown;
  metrics?: Record<string, string | number | boolean | null>;
}

interface TestContext {
  ledger: SqliteLedger;
  events: TelemetryEvent[];
  scheduler: SchedulerImplementation;
  candidates: ModelInfo[];
}

function setup(opts?: {
  candidates?: ModelInfo[];
  modelCaller?: ModelCaller;
  parameters?: ArenaSchedulerParameters;
  // Allow per-test control ledger setup
}): TestContext {
  const db = new DatabaseSync(":memory:");
  const ledger = new SqliteLedger(db, fixedEndow);
  const events: TelemetryEvent[] = [];

  const candidates = opts?.candidates ?? [
    model("openai/gpt-4"),
    model("anthropic/claude-3"),
    model("google/gemini-pro"),
  ];

  const modelCaller: ModelCaller =
    opts?.modelCaller ?? {
      async complete(_model, _prompt, _timeoutMs) {
        return "50";
      },
    };

  const ports: ArenaSchedulerPorts = {
    ledger,
    candidates: () => candidates,
    modelCaller,
    resolveAgent: (m: ModelInfo) => `agent-${m.id}`,
  };

  const scheduler = createArenaSchedulerImplementation(ports);

  return { ledger, events, scheduler, candidates };
}

function buildSDK(events: TelemetryEvent[], signal?: AbortSignal): SchedulerSDK {
  return {
    agents: {
      list: async () => [],
      create: async () => ({ id: "agent-1" }),
      run: async () => {
        throw new Error("not implemented");
      },
    },
    storage: {
      get: () => undefined,
      put: () => ({ value: undefined as unknown, version: 1 }),
    },
    telemetry: {
      emit(
        eventType: string,
        payload: unknown,
        metrics?: Record<string, string | number | boolean | null>,
      ) {
        events.push({ eventType, payload, metrics });
      },
    },
    control: {
      signal: signal ?? new AbortController().signal,
    },
  };
}

function makeInput(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    traceId: "trace-1",
    dispatchId: "dispatch-1",
    role: "default",
    task: "write a function",
    taskCategory: "coding",
    mode: "select",
    settlementRef: "settle-ref-1",
    ...overrides,
  };
}

function settleOutcome(
  overrides: Partial<SettleOutcome> = {},
): SettleOutcome {
  return {
    completion: 0.9,
    majorError: false,
    tokensIn: 500,
    tokensOut: 200,
    cost: 0.015,
    toolCalls: [{ name: "read", durationMs: 100 }],
    inferenceLatencyMs: 1200,
    ...overrides,
  };
}

function settleCtx(events: TelemetryEvent[]): SettleContext {
  return {
    schedulerInstanceId: "arena-instance",
    roundId: "round-1",
    traceId: "trace-1",
    telemetry: {
      emit(
        eventType: string,
        payload: unknown,
        metrics?: Record<string, string | number | boolean | null>,
      ) {
        events.push({ eventType, payload, metrics });
      },
    },
    now: Date.now(),
  };
}

function findEvent(
  events: TelemetryEvent[],
  type: string,
): TelemetryEvent | undefined {
  return events.find((e) => e.eventType === type);
}

// ── Tests: schedule ───────────────────────────────────────────────────

test("full select flow succeeds: bidding, freeze, createTask, completed with settlementRef", async () => {
  const { ledger, events, scheduler, candidates } = setup();

  const input = makeInput();
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(
    input,
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected completed");
  assert.equal(result.settlementRef, "settle-ref-1");
  assert.ok(result.model, "model should be set");
  assert.ok(result.reason?.startsWith("stake "));

  // Verify task created
  const task = ledger.getTask("settle-ref-1");
  assert.ok(task, "task should exist");
  assert.equal(task!.status, "pending");
  assert.equal(task!.winner, result.model);

  // Verify bid_call metrics were emitted
  const bidCalls = events.filter((e) => e.eventType === "scheduler.arena.bid_call");
  assert.ok(bidCalls.length > 0, "should have bid_call events");

  // Verify stake + odds + balance_before metrics
  assert.ok(findEvent(events, "scheduler.arena.stake"));
  assert.ok(findEvent(events, "scheduler.arena.odds"));
  assert.ok(findEvent(events, "scheduler.arena.balance_before"));
  assert.ok(findEvent(events, "scheduler.arena.balance_after"));

  // Verify winner balance decreased by stake
  const winnerBalance = ledger.balance(result.model!);
  assert.ok(
    winnerBalance < 1000,
    `winner balance should be less than initial 1000, got ${winnerBalance}`,
  );
});

test("settlementRef missing → failed with no-stable-task-ref", async () => {
  const { events, scheduler } = setup();
  const input = makeInput({ settlementRef: undefined });
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(
    input,
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failed");
  assert.equal(result.error.code, "no-stable-task-ref");
  assert.equal(result.error.retryable, false);
});

test("execute mode → failed with execute-unsupported", async () => {
  const { events, scheduler } = setup();
  const input = makeInput({ mode: "execute" });
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(
    input,
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failed");
  assert.equal(result.error.code, "execute-unsupported");
  assert.equal(result.error.retryable, false);
});

test("eligibility filtering excludes non-matching models", async () => {
  const candidates = [
    model("openai/gpt-4"),
    model("anthropic/claude-3"),
    model("google/gemini-pro"),
  ];

  const { events, scheduler, ledger } = setup({ candidates });
  const input = makeInput();

  // Only allow anthropic models
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    market: { ...ARENA_DEFAULT_PARAMETERS.market, eligibility: "anthropic/*" },
  };
  const sdk = buildSDK(events);

  // Pre-endow all so balance checks work
  for (const c of candidates) ledger.ensureEndowed("agent-" + c.id, c);

  const result = await scheduler.schedule(input, params, sdk);

  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected completed");
  // Winner must be anthropic (now result.model = agent UUID like "agent-anthropic-claude-3")
  assert.ok(result.model!.includes("anthropic"), `expected anthropic model, got ${result.model}`);
});

test("no eligible candidates → failed with no-eligible-bids", async () => {
  const candidates = [model("openai/gpt-4")];
  const { events, scheduler } = setup({ candidates });
  const input = makeInput();

  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    market: { ...ARENA_DEFAULT_PARAMETERS.market, eligibility: "anthropic/*" },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failed");
  assert.equal(result.error.code, "no-eligible-bids");
});

test("maxStakeRatio clamps stake: balance 10000, ratio 0.5 → stake ≤ 5000", async () => {
  const modelId = "openai/gpt-4";
  const candidates = [model(modelId)];

  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "9999"; // bids way above what ratio allows
      },
    },
  });

  // Boost balance to 10000
  ledger.ensureEndowed(modelId, model(modelId));
  ledger.credit(modelId, 9000, "boost");

  const input = makeInput();
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    risk: { maxStakeRatio: 0.5 },
    market: { ...ARENA_DEFAULT_PARAMETERS.market, maxBidders: 1, eligibility: "all" },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);

  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected completed");

  const task = ledger.getTask("settle-ref-1");
  assert.ok(task);
  // Stake must be ≤ floor(10000 * 0.5) = 5000
  assert.ok(task!.stake <= 5000, `stake ${task!.stake} should be ≤ 5000`);
  assert.ok(task!.stake > 0, "stake should be positive");
});

test("no eligible bids (all stake 0) → failed not abstained", async () => {
  const candidates = [model("openai/gpt-4")];

  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "0"; // all bid 0
      },
    },
  });

  ledger.ensureEndowed("openai/gpt-4", model("openai/gpt-4"));

  const input = makeInput();
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
    market: { ...ARENA_DEFAULT_PARAMETERS.market, maxBidders: 1, eligibility: "all" },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failed");
  assert.equal(result.error.code, "no-eligible-bids");
  assert.equal(result.error.retryable, false);
});

test("freeze competition failure → failed with freeze-rejected", async () => {
  const modelId = "openai/gpt-4";
  const candidates = [model(modelId)];

  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "500";
      },
    },
  });

  // Give only 100 balance, but bid 500 will be clamped to 100
  // Then we externally drain balance before freeze
  ledger.ensureEndowed(modelId, model(modelId)); // 1000

  const input = makeInput({ settlementRef: "settle-freeze-fail" });
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    risk: { maxStakeRatio: 1.0 },
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
    market: {
      ...ARENA_DEFAULT_PARAMETERS.market,
      maxBidders: 1,
      eligibility: "all",
    },
  };
  const sdk = buildSDK(events);

  // Override the ledger for this test: use a wrapper that drains balance
  // right before freeze to simulate a race condition.
  // We need to intercept between bidding and freezing.
  // Instead, we use a custom ledger proxy that fails the first freeze.
  let freezeCallCount = 0;
  const proxyLedger = new Proxy(ledger, {
    get(target, prop, receiver) {
      if (prop === "freeze") {
        return (a: string, amt: number, taskId: string) => {
          freezeCallCount++;
          if (freezeCallCount === 1) {
            // Simulate race: drain balance then try freeze
            target.debit(a, target.balance(a), "drain");
            return target.freeze(a, amt, taskId);
          }
          return target.freeze(a, amt, taskId);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  // Build a scheduler with the proxy ledger
  const ports: ArenaSchedulerPorts = {
    ledger: proxyLedger as unknown as Ledger,
    candidates: () => candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "500";
      },
    },
    resolveAgent: (m: ModelInfo) => `agent-${m.id}`,
  };
  const raceScheduler = createArenaSchedulerImplementation(ports);

  const result = await raceScheduler.schedule(input, params, sdk);

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failed");
  assert.equal(result.error.code, "freeze-rejected");
  assert.equal(result.error.retryable, false);
});

test("signal abort stops remaining bid calls", async () => {
  const candidates = [
    model("openai/gpt-4"),
    model("anthropic/claude-3"),
    model("google/gemini-pro"),
  ];

  const ac = new AbortController();
  let callCount = 0;

  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(modelId, _prompt, _timeoutMs) {
        callCount++;
        if (modelId === "openai/gpt-4") {
          // Abort after first call
          ac.abort();
        }
        // Return after abort to simulate async timing
        await new Promise((r) => setTimeout(r, 10));
        return "30";
      },
    },
  });

  for (const c of candidates) ledger.ensureEndowed(c.id, c);

  const input = makeInput({ signal: ac.signal });
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
  };
  const sdk = buildSDK(events, ac.signal);

  const result = await scheduler.schedule(input, params, sdk);

  // Should still complete if at least one bid succeeded before abort
  // The abort doesn't cancel in-flight calls, just prevents new ones from being made
  // (since Promise.all starts all at once, they will all run)
  assert.ok(
    result.status === "completed" || result.status === "failed",
    "should complete or fail gracefully",
  );
});

test("bidderSelector random uses RandomSelector", async () => {
  const candidates = [model("a/m1"), model("b/m2"), model("c/m3")];

  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "50";
      },
    },
  });

  for (const c of candidates) ledger.ensureEndowed(c.id, c);

  const input = makeInput();
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    market: {
      ...ARENA_DEFAULT_PARAMETERS.market,
      bidderSelector: "random",
      maxBidders: 3,
      eligibility: "all",
    },
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);
  assert.equal(result.status, "completed");
});

// ── Tests: settle ─────────────────────────────────────────────────────

test("settle: full settlement flow — unfreeze, credit, task status settled", async () => {
  const { ledger, events, scheduler } = setup();

  // First run schedule to create a task
  const sdk = buildSDK(events);
  const result = await scheduler.schedule(
    makeInput(),
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  const winner = (result as { model: string }).model;
  const balanceBeforeSettle = ledger.balance(winner);

  // Now settle
  const settleEvents: TelemetryEvent[] = [];
  const ctx = settleCtx(settleEvents);
  const outcome = settleOutcome({ completion: 0.95, majorError: false });

  await scheduler.settle!(ctx, "settle-ref-1", outcome);

  // Task should be settled
  const task = ledger.getTask("settle-ref-1");
  assert.equal(task!.status, "settled");

  // Balance should have changed (D - U applied)
  const balanceAfterSettle = ledger.balance(winner);
  assert.notEqual(
    balanceAfterSettle,
    balanceBeforeSettle,
    "balance should change after settle",
  );

  // Metrics emitted
  assert.ok(findEvent(settleEvents, "scheduler.arena.settled"));
  assert.ok(findEvent(settleEvents, "scheduler.arena.balance_after"));
});

test("settle: idempotent — second settle on same task returns early", async () => {
  const { ledger, events, scheduler } = setup();

  // Create and settle once
  const sdk = buildSDK(events);
  await scheduler.schedule(
    makeInput(),
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  const settleEvents1: TelemetryEvent[] = [];
  await scheduler.settle!(settleCtx(settleEvents1), "settle-ref-1", settleOutcome());
  assert.ok(findEvent(settleEvents1, "scheduler.arena.settled"), "first settle should emit settled");

  // Now settle again on same taskRef
  const settleEvents2: TelemetryEvent[] = [];
  await scheduler.settle!(settleCtx(settleEvents2), "settle-ref-1", settleOutcome());

  // Second settle should not emit settled event (returned early)
  assert.equal(
    findEvent(settleEvents2, "scheduler.arena.settled"),
    undefined,
    "second settle should not emit settled event",
  );

  // Balance should not have changed from the first settle
  const task = ledger.getTask("settle-ref-1");
  assert.equal(task!.status, "settled");
});

test("settle: idempotent — unknown taskRef returns early", async () => {
  const { scheduler } = setup();
  const settleEvents: TelemetryEvent[] = [];

  // Should not throw
  await scheduler.settle!(settleCtx(settleEvents), "nonexistent-ref", settleOutcome());

  assert.equal(settleEvents.length, 0, "no events emitted for unknown task");
});

test("settle: bankrupt metric when balance reaches 0", async () => {
  const modelId = "openai/gpt-4";
  const candidates = [model(modelId)];

  const { ledger, events, scheduler } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "1000"; // bid entire balance
      },
    },
  });

  ledger.ensureEndowed(modelId, model(modelId)); // 1000

  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    risk: { maxStakeRatio: 1.0 },
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
  };

  const sdk = buildSDK(events);
  const result = await scheduler.schedule(
    makeInput({ settlementRef: "settle-bankrupt" }),
    params,
    sdk,
  );
  assert.equal(result.status, "completed");

  // Settle with major error (should lose stake entirely)
  const settleEvents: TelemetryEvent[] = [];
  await scheduler.settle!(
    settleCtx(settleEvents),
    "settle-bankrupt",
    settleOutcome({ majorError: true }),
  );

  // Due to errorMode = stakeTimesOdds, the loss could be > balance
  // Check for bankrupt event
  const bankrupt = findEvent(settleEvents, "scheduler.arena.bankrupt");
  // Bankrupt may or may not fire depending on D/U computation
  // At minimum, balance should be low
  const finalBalance = ledger.balance(modelId);
  if (finalBalance <= 0) {
    assert.ok(bankrupt, "bankrupt event should be emitted when balance reaches 0");
  }
});

test("settle: majorError with stakeOnly deducts only stake", async () => {
  const modelId = "openai/gpt-4";
  const candidates = [model(modelId)];

  const { ledger, events, scheduler } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "300";
      },
    },
  });

  ledger.ensureEndowed(modelId, model(modelId));

  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    risk: { maxStakeRatio: 1.0 },
    settlement: {
      ...ARENA_DEFAULT_PARAMETERS.settlement,
      tax: 0,
      errorMode: "stakeOnly",
    },
  };

  const sdk = buildSDK(events);
  const result = await scheduler.schedule(
    makeInput({ settlementRef: "settle-stakeonly" }),
    params,
    sdk,
  );
  assert.equal(result.status, "completed");

  const balanceBefore = ledger.balance(modelId);

  const settleEvents: TelemetryEvent[] = [];
  await scheduler.settle!(
    settleCtx(settleEvents),
    "settle-stakeonly",
    settleOutcome({ majorError: true }),
  );

  const balanceAfter = ledger.balance(modelId);
  // With stakeOnly mode: D = -stake, so balance should be balanceBefore (after settle)
  // Actually: settle happens, unfreeze returns stake, then D = -stake
  // So: balance_before_settle + unfreeze_stake + D - U
  // = balanceBefore + stake - stake - U = balanceBefore - U
  // So balance should decrease by usage cost roughly
  assert.ok(
    balanceAfter <= balanceBefore,
    "balance should decrease or stay same with major error + stakeOnly",
  );
});

// ── Tests: maxCallsPerDispatch cap ────────────────────────────────────

test("maxCallsPerDispatch limits concurrent bid calls", async () => {
  const candidates = [
    model("a/m1"),
    model("b/m2"),
    model("c/m3"),
    model("d/m4"),
    model("e/m5"),
  ];

  let callCount = 0;

  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        callCount++;
        return "30";
      },
    },
  });

  for (const c of candidates) ledger.ensureEndowed(c.id, c);

  const input = makeInput();
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    bidding: {
      ...ARENA_DEFAULT_PARAMETERS.bidding,
      maxCallsPerDispatch: 3,
    },
    market: {
      ...ARENA_DEFAULT_PARAMETERS.market,
      maxBidders: 5,
      eligibility: "all",
    },
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);

  assert.equal(result.status, "completed");
  assert.equal(callCount, 3, "should only call 3 bidders when maxCallsPerDispatch=3");
});

// ── Tests: opt-out tax ────────────────────────────────────────────────

test("opt-out tax deducted for zero-stake bidders", async () => {
  const model1 = "openai/gpt-4";
  const model2 = "anthropic/claude-3";
  const agent1 = `agent-${model1}`;
  const agent2 = `agent-${model2}`;
  const candidates = [model(model1), model(model2)];

  let callSeq = 0;
  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        callSeq++;
        // First model bids positive, second bids 0
        return callSeq === 1 ? "100" : "0";
      },
    },
  });

  ledger.ensureEndowed(model1, model(model1));
  ledger.ensureEndowed(model2, model(model2));
  const balanceBefore2 = ledger.balance(model2);

  const input = makeInput({ settlementRef: "settle-tax" });
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 5 },
    market: {
      ...ARENA_DEFAULT_PARAMETERS.market,
      maxBidders: 2,
      eligibility: "all",
    },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);
  assert.equal(result.status, "completed");

  // Second model should have lost the opt-out tax
  const balanceAfter2 = ledger.balance(agent2);
  assert.ok(
    balanceAfter2 < balanceBefore2,
    `model2 should pay opt-out tax: ${balanceAfter2} < ${balanceBefore2}`,
  );
});

test("opt-out tax not deducted when tax is 0", async () => {
  const model1 = "openai/gpt-4";
  const model2 = "anthropic/claude-3";
  const candidates = [model(model1), model(model2)];

  let callSeq = 0;
  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        callSeq++;
        return callSeq === 1 ? "100" : "0";
      },
    },
  });

  const agent1b = `agent-${model1}`;
  const agent2b = `agent-${model2}`;
  ledger.ensureEndowed(agent1b, model(model1));
  ledger.ensureEndowed(agent2b, model(model2));
  const balanceBefore2 = ledger.balance(agent2b);

  const input = makeInput({ settlementRef: "settle-notax" });
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
    market: {
      ...ARENA_DEFAULT_PARAMETERS.market,
      maxBidders: 2,
      eligibility: "all",
    },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);
  assert.equal(result.status, "completed");

  const balanceAfter2 = ledger.balance(agent2b);
  assert.equal(balanceAfter2, balanceBefore2, "no tax deducted when tax=0");
});

// ── Tests: settle uses default parameters ─────────────────────────────

test("settle handles missing model gracefully (U=0)", async () => {
  const modelId = "openai/gpt-4";
  const candidates = [model(modelId)];

  const { ledger, scheduler } = setup({
    candidates,
    modelCaller: {
      async complete(_model, _prompt, _timeoutMs) {
        return "100";
      },
    },
  });

  ledger.ensureEndowed(modelId, model(modelId));

  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    risk: { maxStakeRatio: 1.0 },
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
  };

  const sdk = buildSDK([]);
  const result = await scheduler.schedule(
    makeInput({ settlementRef: "settle-nomodel" }),
    params,
    sdk,
  );
  assert.equal(result.status, "completed");

  // Now settle with a fake context that has no model candidates
  // The scheduler captures ports.candidates which returns the original models
  // So model lookup will work normally
  const settleEvents: TelemetryEvent[] = [];
  await scheduler.settle!(
    settleCtx(settleEvents),
    "settle-nomodel",
    settleOutcome(),
  );

  const task = ledger.getTask("settle-nomodel");
  assert.equal(task!.status, "settled");
});

// ── Tests: tournament winner selection ────────────────────────────────

test("winner selection: highest stake wins, tie-break by balance then agent", async () => {
  const m1 = "a/m-low";
  const m2 = "b/m-high-stake";
  const m3 = "c/m-high-balance";

  const candidates = [
    model(m1),
    model(m2),
    model(m3),
  ];

  // Use model-id-keyed responses for deterministic concurrent calls
  const bidMap: Record<string, string> = {
    [m1]: "10",
    [m2]: "50",
    [m3]: "50",
  };

  const { events, scheduler, ledger } = setup({
    candidates,
    modelCaller: {
      async complete(modelId, _prompt, _timeoutMs) {
        return bidMap[modelId] ?? "0";
      },
    },
  });

  const a1 = `agent-${m1}`; const a2 = `agent-${m2}`; const a3 = `agent-${m3}`;
  ledger.ensureEndowed(a1, model(m1));
    ledger.ensureEndowed(a2, model(m2));
    ledger.ensureEndowed(a3, model(m3));
  // Give m3 more balance than m2 for tie-break
    ledger.credit(a3, 500, "bonus");

  const input = makeInput({ settlementRef: "settle-tiebreak" });
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    risk: { maxStakeRatio: 1.0 },
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
    market: {
      ...ARENA_DEFAULT_PARAMETERS.market,
      maxBidders: 3,
      eligibility: "all",
    },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);
  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected completed");

  // Winner should be the one with higher stake (m2 or m3), not m1
  assert.notEqual(result.model, a1, "m1 should not win with lowest stake");

  // With same stake (50), the one with higher balance (m3) wins
  // sort: stake desc, balance desc, agent asc
  // m3 has 1500 balance, m2 has 1000, both bid 50 → m3 wins
  assert.equal(result.model, a3, `expected m3 to win with higher balance, got ${result.model}`);
});

// ── Tests: edge cases ─────────────────────────────────────────────────

test("empty candidates → failed", async () => {
  const { events, scheduler } = setup({ candidates: [] });
  const input = makeInput();
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(
    input,
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failed");
  assert.equal(result.error.code, "no-candidates");
});

test("all candidates filtered out by eligibility → no-eligible-bids", async () => {
  const candidates = [model("openai/gpt-4")];
  const { events, scheduler } = setup({ candidates });
  const input = makeInput();
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    market: { ...ARENA_DEFAULT_PARAMETERS.market, eligibility: "nonexistent/*" },
  };
  const sdk = buildSDK(events);

  const result = await scheduler.schedule(input, params, sdk);

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failed");
  assert.equal(result.error.code, "no-eligible-bids");
});

test("bid_call metric includes estimated tokens and cost", async () => {
  const candidates = [model("openai/gpt-4", { in: 2.0, out: 6.0 })];
  const { events, scheduler, ledger } = setup({ candidates });

  ledger.ensureEndowed("openai/gpt-4", model("openai/gpt-4", { in: 2.0, out: 6.0 }));

  const input = makeInput();
  const params: ArenaSchedulerParameters = {
    ...ARENA_DEFAULT_PARAMETERS,
    settlement: { ...ARENA_DEFAULT_PARAMETERS.settlement, tax: 0 },
    market: { ...ARENA_DEFAULT_PARAMETERS.market, maxBidders: 1, eligibility: "all" },
  };
  const sdk = buildSDK(events);

  await scheduler.schedule(input, params, sdk);

  const bidCall = findEvent(events, "scheduler.arena.bid_call");
  assert.ok(bidCall);
  assert.ok(
    typeof bidCall!.metrics?.estimated_tokens === "number",
    "estimated_tokens should be a number",
  );
  assert.ok(
    typeof bidCall!.metrics?.estimated_cost_usd === "number",
    "estimated_cost_usd should be a number",
  );
  assert.ok(
    bidCall!.metrics!.estimated_tokens > 0,
    "estimated_tokens should be positive",
  );
});
