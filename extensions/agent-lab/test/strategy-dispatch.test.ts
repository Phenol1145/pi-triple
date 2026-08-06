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
import type { LabCore } from "../src/core/create-core.ts";
import type { SchedulerDefinition } from "../src/core/contracts.ts";
import type { SchedulingInput, SchedulingResult } from "../src/scheduler/contracts.ts";

// ── Helpers (same pattern as scheduler-runner.test.ts) ───────────────

function memoryDB(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function schedulerDef(
  overrides: Partial<SchedulerDefinition> = {},
): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "test-scheduler",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1.0.0",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: { weight: 0.5 },
    tunablePaths: ["weight"],
    validateParameters: () => ({ ok: true as const, value: {} }),
    validateAgentDefinition: () => ({ ok: true as const, value: {} }),
    ...overrides,
  };
}

/**
 * Minimal LabCore wired to an in-memory DB with one active scheduler
 * instance + round + a catch-all routing binding (same wiring as
 * scheduler-runner.test.ts buildCore, trimmed to what strategy tests need).
 */
function buildCore(opts?: {
  instanceId?: string;
}): { core: LabCore; db: DatabaseSync; instanceId: string } {
  const db = memoryDB();
  const definitions = new DefinitionRegistry();
  definitions.register(schedulerDef());

  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const storage = new NamespacedStore(db);
  const controlPlane = new ControlPlane(definitions, repository, events);

  const instanceId = opts?.instanceId ?? "test-instance";
  const roundId = `${instanceId}:round:0`;
  const now = Date.now();

  const draftSpec = {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler" as const, id: "test-scheduler", version: "1.0.0" },
    initialParameters: { weight: 0.5 },
    agents: [],
    fallbackChain: [{ type: "original-request" as const }],
    routingBindings: [{ id: "r1", priority: 10, match: {} }],
    metadata: {},
  };

  repository.saveDraft(draftSpec);

  repository.transaction(() => {
    repository.insertInstance(
      {
        id: instanceId,
        name: instanceId,
        definition: { kind: "scheduler", id: "test-scheduler", version: "1.0.0" },
        parameterModelVersion: "1.0.0",
        agentDefinitionSchemaVersion: "1.0.0",
        status: "active",
        currentRoundId: roundId,
        fallbackChain: [{ type: "original-request" }],
        createdAt: now,
      },
      {},
    );
    repository.insertRound({
      id: roundId,
      schedulerInstanceId: instanceId,
      sequence: 0,
      parameters: { weight: 0.5 },
      status: "active",
      createdAt: now,
      activatedAt: now,
    });
    repository.insertRoutingBinding(instanceId, { id: "r1", priority: 10, match: {} });
  });

  const core: LabCore = { definitions, repository, events, storage, controlPlane };
  return { core, db, instanceId };
}

function scheduleCompleted(): SchedulingResult {
  return { status: "completed", selectedAgentId: "agent-1", model: "gpt-4", reason: "ok" };
}

/**
 * Dispatch through the real SchedulerRunner and return the resolved
 * strategy observed in the scheduling.requested event payload and in the
 * SchedulingInput captured by the registered scheduler implementation.
 */
async function dispatchAndCapture(opts: {
  traceId: string;
  request: Parameters<SchedulerRunner["dispatch"]>[0];
  runnerOpts?: ConstructorParameters<typeof SchedulerRunner>[0];
}): Promise<{ eventStrategy: unknown; inputStrategy: unknown }> {
  const { core, db } = buildCore();
  const schedulers = new SchedulerRegistry(core.definitions);
  let capturedInput: SchedulingInput | undefined;
  schedulers.register({
    id: "test-scheduler",
    version: "1.0.0",
    schedule: async (input) => {
      capturedInput = input;
      return scheduleCompleted();
    },
  });

  const runner = new SchedulerRunner({ core, schedulers, ...opts.runnerOpts });
  const result = await runner.dispatch(opts.request);
  assert.equal(result.status, "completed");

  const events = core.events.query({ traceId: opts.traceId });
  const reqEvt = events.find((e) => e.eventType === "scheduling.requested");
  assert.ok(reqEvt, "scheduling.requested event should be emitted");

  const eventStrategy = (reqEvt.payload as { strategy?: unknown }).strategy;
  const inputStrategy = capturedInput?.strategy;

  db.close();
  return { eventStrategy, inputStrategy };
}

// ── Strategy resolution + passthrough ───────────────────────────────

test("S: dispatch 显式 strategy=market → scheduling.requested payload 与 SchedulingInput 均携带 market", async () => {
  const { eventStrategy, inputStrategy } = await dispatchAndCapture({
    traceId: "s1",
    request: { traceId: "s1", role: "architect", task: "t", strategy: "market", caller: "cli" },
  });

  assert.equal(eventStrategy, "market");
  assert.equal(inputStrategy, "market");
});

test("S2: dispatch 无显式 strategy + caller=timed-trigger → resolveStrategy 解析为 weighted", async () => {
  const { eventStrategy, inputStrategy } = await dispatchAndCapture({
    traceId: "s2",
    request: { traceId: "s2", role: "architect", task: "t", caller: "timed-trigger" },
  });

  assert.equal(eventStrategy, "weighted");
  assert.equal(inputStrategy, "weighted");
});

test("S3: dispatch 无显式 strategy/labels/caller → 默认 market", async () => {
  const { eventStrategy, inputStrategy } = await dispatchAndCapture({
    traceId: "s3",
    request: { traceId: "s3", role: "architect", task: "t" },
  });

  assert.equal(eventStrategy, "market");
  assert.equal(inputStrategy, "market");
});

test("S4: strategyConfig.weightedRoles 命中 role → weighted（构造参数注入生效）", async () => {
  const { eventStrategy, inputStrategy } = await dispatchAndCapture({
    traceId: "s4",
    request: { traceId: "s4", role: "researcher", task: "t" },
    runnerOpts: { strategyConfig: { defaultStrategy: "market", weightedRoles: ["researcher"] } },
  });

  assert.equal(eventStrategy, "weighted");
  assert.equal(inputStrategy, "weighted");
});
