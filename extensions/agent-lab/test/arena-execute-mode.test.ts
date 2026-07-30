import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../src/arena/ledger.ts";
import {
  createArenaSchedulerImplementation,
  type ArenaSchedulerPorts,
} from "../src/schedulers/arena-scheduler.ts";
import { ARENA_DEFAULT_PARAMETERS, type ArenaSchedulerParameters } from "../src/schedulers/arena-definition.ts";
import type {
  SchedulerImplementation,
  SchedulingInput,
  SchedulerSDK,
} from "../src/scheduler/contracts.ts";
import type { ModelCaller, EndowmentPolicy } from "../src/arena/types.ts";
import type { ModelInfo } from "../src/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────

const fixedEndow: EndowmentPolicy = { initialCredits: () => 1000 };

function model(id: string): ModelInfo {
  return {
    id,
    provider: id.split("/")[0],
    name: id,
    accessRoute: "free",
    pricing: { in: 2.0, out: 6.0 },
  };
}

interface TelemetryEvent {
  eventType: string;
  payload: unknown;
  metrics?: Record<string, string | number | boolean | null>;
}

function setup(opts?: {
  candidates?: ModelInfo[];
  modelCaller?: ModelCaller;
  parameters?: ArenaSchedulerParameters;
}): {
  ledger: SqliteLedger;
  events: TelemetryEvent[];
  scheduler: SchedulerImplementation;
} {
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
      async complete() {
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
  return { ledger, events, scheduler };
}

function buildSDK(
  events: TelemetryEvent[],
  runImpl: (agentId: string, request: { task: string }) => Promise<{ status: string; output?: { text?: string }; error?: { code: string; message: string; retryable?: boolean } }>,
  signal?: AbortSignal,
): SchedulerSDK {
  return {
    agents: {
      list: async () => [],
      create: async () => ({ id: "agent-1" }),
      run: async (agentId: string, request: { task: string }) => runImpl(agentId, request),
    },
    storage: {
      get: () => undefined,
      put: () => ({ value: undefined as unknown, version: 1 }),
    },
    telemetry: {
      emit(eventType: string, payload: unknown, metrics?: Record<string, string | number | boolean | null>) {
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
    mode: "execute",
    settlementRef: "settle-ref-1",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

test("execute mode: agents.run() called after bidding, output returned", async () => {
  const runCalls: { agentId: string; task: string }[] = [];
  const { scheduler, events } = setup();

  const sdk = buildSDK(events, async (agentId, req) => {
    runCalls.push({ agentId, task: req.task });
    return { status: "completed", output: { text: "result text" } };
  });

  const result = await scheduler.schedule(
    makeInput({ mode: "execute", task: "do something" }),
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  assert.equal(runCalls.length, 1, "agents.run() should be called exactly once");
  assert.equal(runCalls[0]!.task, "do something");
  if (result.status === "completed") {
    assert.ok(result.output, "output should be present in execute mode");
    assert.equal(result.output?.text, "result text");
    assert.ok(result.reason?.includes("executed"), "reason should mention executed");
  }
});

test("execute mode: failed run returns failed status with error", async () => {
  const { scheduler, events } = setup();

  const sdk = buildSDK(events, async () => ({
    status: "failed",
    error: { code: "workloop-err", message: "boom", retryable: false },
  }));

  const result = await scheduler.schedule(
    makeInput({ mode: "execute" }),
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "workloop-err");
    assert.equal(result.error.message, "boom");
  }
});

test("execute mode: run throws → failed with workloop-error", async () => {
  const { scheduler, events } = setup();

  const sdk = buildSDK(events, async () => {
    throw new Error("network down");
  });

  const result = await scheduler.schedule(
    makeInput({ mode: "execute" }),
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "workloop-error");
    assert.equal(result.error.message, "network down");
  }
});

test("execute mode: cancelled run → failed with retryable error", async () => {
  const { scheduler, events } = setup();

  const sdk = buildSDK(events, async () => ({
    status: "cancelled",
  }));

  const result = await scheduler.schedule(
    makeInput({ mode: "execute" }),
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "workloop-failed");
    assert.equal(result.error.retryable, true, "cancelled should be retryable");
  }
});

test("select mode: agents.run() NOT called (no regression)", async () => {
  const runCalls: { agentId: string; task: string }[] = [];
  const { scheduler, events } = setup();

  const sdk = buildSDK(events, async (agentId, req) => {
    runCalls.push({ agentId, task: req.task });
    return { status: "completed", output: { text: "should not happen" } };
  });

  const result = await scheduler.schedule(
    makeInput({ mode: "select" }),
    ARENA_DEFAULT_PARAMETERS,
    sdk,
  );

  assert.equal(result.status, "completed");
  assert.equal(runCalls.length, 0, "agents.run() must NOT be called in select mode");
  if (result.status === "completed") {
    assert.equal(result.output, undefined, "select mode should not return output");
  }
});
