import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { NamespacedStore } from "../src/core/storage/namespaced-store.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { SchedulerRegistry } from "../src/scheduler/registry.ts";
import { SchedulerRunner } from "../src/scheduler/runner.ts";
import { WorkLoopRunner } from "../src/workloop/runner.ts";
import { WorkLoopRegistry } from "../src/workloop/registry.ts";
import { AgentRuntimeStateStore } from "../src/workloop/state-store.ts";
import { CheckpointStore } from "../src/workloop/checkpoints.ts";
import { PiSubagentsAdapter } from "../src/runtime/pi-subagents-adapter.ts";
import { PI_DEFAULT_LOOP_DEFINITION } from "../src/runtime/create-runtime.ts";
import { createPiDefaultLoop } from "../src/workloops/pi-default-loop.ts";
import type { DelegationEventBus } from "../src/runtime/pi-subagents-adapter.ts";
import { createLabCore } from "../src/core/create-core.ts";
import type { LabCore } from "../src/core/create-core.ts";
import type { ModelInfo } from "../src/types.ts";
import type { WeightedScorerPorts } from "../src/schedulers/weighted-scorer.ts";
import type { ArenaSchedulerPorts } from "../src/schedulers/arena-scheduler.ts";
import {
  ensureWeightedScorerInstance,
  ensureArenaInstance,
} from "../src/schedulers/bootstrap.ts";
import {
  DEFAULT_MARKET_INSTANCE_ID,
  DEFAULT_WEIGHTED_SCORER_INSTANCE_ID,
} from "../src/schedulers/names.ts";

// ── Fixtures ───────────────────────────────────────────────────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function model(id: string): ModelInfo {
  return {
    id,
    provider: id.includes("/") ? id.split("/")[0] : "unknown",
    name: id,
    pricing: undefined,
    perf: undefined,
    benchmarks: undefined,
    accessRoute: "direct",
  };
}

function mockWsPorts(candidates: ModelInfo[] = []): WeightedScorerPorts {
  return {
    candidates: () => candidates,
    aggregates: () => new Map(),
    pinLookup: () => undefined,
  };
}

function mockLedger(): ArenaSchedulerPorts["ledger"] {
  return {
    credit: () => {},
    debit: () => {},
    freeze: () => true,
    unfreeze: () => 0,
    leaderboard: () => [],
    history: () => [],
    currentRound: () => 0,
    nextRound: () => 1,
    agentTurn: () => 0,
    createTask: () => {},
    getTask: () => undefined,
    setTaskStatus: () => {},
    staleTasks: () => [],
    recoverStaleTask: () => {},
  };
}

function mockArenaPorts(candidates: ModelInfo[] = []): ArenaSchedulerPorts {
  return {
    ledger: mockLedger() as ArenaSchedulerPorts["ledger"],
    candidates: () => candidates,
    modelCaller: { complete: async () => ({ message: { role: "assistant" as const, content: "ok" } }) },
    resolveAgent: (m: ModelInfo) => `agent-${m.id}`,
  };
}

// ── Collision guards ───────────────────────────────────────────────────

test("ensureWeightedScorerInstance rejects the market canonical instanceId", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  const schedulers = new SchedulerRegistry(core.definitions);
  const ports = mockWsPorts([model("openai/gpt-4o")]);

  await assert.rejects(
    () =>
      ensureWeightedScorerInstance(core, schedulers, ports, {
        instanceId: DEFAULT_MARKET_INSTANCE_ID,
      }),
    (err: Error) =>
      /collides/.test(err.message) &&
      err.message.includes(DEFAULT_MARKET_INSTANCE_ID) &&
      err.message.includes("dispatch target"),
  );

  db.close();
});

test("ensureArenaInstance rejects the weighted-scorer canonical instanceId", async () => {
  const db = memoryDB();
  const core = createLabCore(db);
  core.definitions.register(structuredClone(PI_DEFAULT_LOOP_DEFINITION));
  const schedulers = new SchedulerRegistry(core.definitions);
  const ports = mockArenaPorts([model("openai/gpt-4o")]);

  await assert.rejects(
    () =>
      ensureArenaInstance(core, schedulers, ports, {
        instanceId: DEFAULT_WEIGHTED_SCORER_INSTANCE_ID,
      }),
    (err: Error) =>
      /collides/.test(err.message) &&
      err.message.includes(DEFAULT_WEIGHTED_SCORER_INSTANCE_ID) &&
      err.message.includes("dispatch target"),
  );

  db.close();
});
