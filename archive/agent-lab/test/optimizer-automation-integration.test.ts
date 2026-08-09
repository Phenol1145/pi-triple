/**
 * Integration test: full automation pipeline (Phase 5b T9).
 *
 * End-to-end: seed runs + dispatch events → submit proposal → tick → shadow →
 * validated → tick → canary → seed attributed canary/control runs → tick →
 * auto-promote (scenario 1) and auto-abort on degradation (scenario 2).
 *
 * Asserts full event chain + traceability.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { ControlPlane } from "../src/core/control-plane/service.ts";
import { createAutoFlow } from "../src/optimizer/auto-flow.ts";
import { evaluateShadow } from "../src/optimizer/shadow.ts";
import { evaluateCanary, decideCanaryAction } from "../src/optimizer/canary-eval.ts";
import "../src/optimizers/ws-projector.ts"; // side-effect: register ws-projector
import type { OptimizerConfig } from "../src/types.ts";
import type {
  SchedulerDefinition,
  SchedulerInstanceDraftSpec,
} from "../src/core/contracts.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Setup helpers
// ═══════════════════════════════════════════════════════════════════════════════

const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  task_category TEXT,
  acceptance TEXT,
  completion REAL NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  tool_success REAL,
  turns INTEGER,
  interrupted INTEGER,
  signals TEXT,
  source TEXT NOT NULL,
  trace_id TEXT
);
`;

function makeSchedulerDef(): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "weighted-scorer",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1.0.0",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: {
      weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
      topN: 3,
      pinBehavior: "respect",
      syncOnDispatch: false,
    },
    tunablePaths: ["weights.*", "topN", "pinBehavior", "syncOnDispatch"],
    validateParameters: (value) => {
      const v = value as Record<string, unknown> | null;
      if (!v || typeof v !== "object") {
        return { ok: false, issues: [{ path: "", code: "type", message: "must be object" }] };
      }
      return { ok: true, value: v };
    },
    validateAgentDefinition: (value) => {
      const name = (value as { standard?: { name?: unknown } })?.standard?.name;
      return typeof name === "string" && name.length > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "standard.name", code: "required", message: "agent name is required" }] };
    },
    validateTransition: (_prev: unknown, _next: unknown) => ({ ok: true }),
  };
}

type CatalogModel = { id: string; provider: string; name: string; contextWindow?: number; pricing?: { in: number; out: number }; accessRoute: string };

function fakeCatalog(): CatalogModel[] {
  return [
    { id: "gpt-4o", provider: "openai", name: "GPT-4o", pricing: { in: 2.5, out: 10 }, accessRoute: "free" },
    { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4", pricing: { in: 3, out: 15 }, accessRoute: "free" },
    { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", pricing: { in: 0.14, out: 0.28 }, accessRoute: "direct" },
  ];
}

function makeDraftSpec(instanceId: string): SchedulerInstanceDraftSpec {
  return {
    id: instanceId,
    schedulerDefinition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    agents: [{
      id: `${instanceId}-agent-1`,
      definition: {
        standard: { name: "Test Agent", capabilities: [], executionKind: "pi-subagent", labels: {} },
        workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
        custom: {},
      },
    }],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [],
  };
}

function makeOptimizerDef() {
  return {
    kind: "optimizer" as const,
    id: "weighted-tuner",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configurationSchema: { type: "object" },
    requiredMetrics: ["runs"],
    compatibleSchedulers: [{ id: "weighted-scorer", versionRange: "^1.0.0" }],
    parameterModelVersionRange: "^1.0.0",
  };
}

/** Creates a clock that can be advanced via tick(). */
function makeClock(startMs: number = 1000000) {
  let t = startMs;
  return {
    /** Read current time. */
    now: () => t,
    /** Advance by 60s and return new value. */
    tick: () => { t += 60000; return t; },
    /** Return current value without advancing. */
    peek: () => t,
  };
}

function setupCore(clock: ReturnType<typeof makeClock>) {
  const db = new DatabaseSync(":memory:");
  db.exec(STORE_SCHEMA);

  const definitions = new DefinitionRegistry();
  definitions.register(makeSchedulerDef());
  definitions.register({
    kind: "workloop",
    id: "pi-default-loop",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    cloneModes: ["fresh", "fork"],
  });
  definitions.register(makeOptimizerDef());

  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const controlPlane = new ControlPlane(definitions, repository, events, clock.now);

  return { db, definitions, repository, events, controlPlane };
}

function seedRun(
  db: DatabaseSync,
  ts: number,
  overrides: { role?: string; model?: string; completion?: number; cost?: number; trace_id?: string } = {},
) {
  db.prepare(
    `INSERT INTO runs (ts, role, model, completion, cost, tool_success, source, trace_id)
     VALUES (?, ?, ?, ?, ?, 1.0, 'auto', ?)`,
  ).run(
    ts,
    overrides.role ?? "coder",
    overrides.model ?? "gpt-4o",
    overrides.completion ?? 0.85,
    overrides.cost ?? 0.01,
    overrides.trace_id ?? null,
  );
}

function seedDispatchEvent(
  events: EventLog,
  traceId: string,
  schedulerInstanceId: string,
  optimizationRoundId: string,
) {
  events.append({
    eventId: `scheduling.requested:${traceId}:${Date.now()}`,
    eventType: "scheduling.requested",
    schemaVersion: "1",
    timestamp: Date.now(),
    identity: { traceId, schedulerInstanceId, optimizationRoundId },
    payload: { role: "coder" },
  });
}

function bootstrapInstance(
  controlPlane: ControlPlane,
  repository: CoreRepository,
  sid: string,
  optimizerInstanceId: string,
) {
  controlPlane.createDraft(makeDraftSpec(sid));
  controlPlane.validateDraft(sid);
  controlPlane.activateDraft(sid);

  repository.insertOptimizerInstance({
    id: optimizerInstanceId,
    name: optimizerInstanceId,
    definitionId: "weighted-tuner",
    definitionVersion: "1.0.0",
    config: {},
    targetSchedulers: [sid],
    status: "active",
    createdAt: Date.now(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: Full auto-promote pipeline
// ═══════════════════════════════════════════════════════════════════════════════

test("integration: full pipeline → auto-promote (event chain + traceability)", async () => {
  const clock = makeClock(1000000);
  const { db, repository, events, controlPlane } = setupCore(clock);

  const sid = "ws-test";
  const optimizerInstanceId = "tuner-test";

  bootstrapInstance(controlPlane, repository, sid, optimizerInstanceId);
  const round0Id = repository.getInstance(sid)!.currentRoundId;

  // Seed baseline runs within the upcoming data window
  const windowStart = clock.peek();
  clock.tick();
  for (let i = 0; i < 10; i++) { seedRun(db, clock.peek(), { model: "gpt-4o" }); }

  // Create proposal — nowFn uses clock.now, so candidate round createdAt uses clock time
  const candidateParams = {
    weights: { completion: 0.6, costEffectiveness: 0.2, performance: 0.1, benchmark: 0.1 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
  };
  const dataWindow = { since: windowStart, until: clock.peek() + 1 };

  const { proposalId } = controlPlane.submitProposal(optimizerInstanceId, sid, {
    baseRoundId: round0Id,
    parameters: candidateParams,
    evaluation: { summary: "Quality signal", metrics: { runs: 10 }, dataWindow },
  });
  assert.ok(proposalId);
  const proposal = repository.getProposal(proposalId)!;
  const candidateRoundId = proposal.candidateRoundId!;
  assert.equal(repository.getRound(candidateRoundId)!.status, "proposed");

  // Configure auto-flow
  const config: OptimizerConfig = {
    shadow: { enabled: true },
    canaryPercent: 30,
    autoTrigger: { enabled: false },
    autoPromote: { enabled: true, minSamples: 3, epsilonCompletion: 0.1, epsilonCost: 0.1 },
    autoRollback: { enabled: true, minSamples: 3, epsilonCompletion: 0.1, epsilonCost: 0.1 },
  };

  const autoFlow = createAutoFlow({
    repository, events, controlPlane, config,
    evaluateShadow: (pid: string) =>
      evaluateShadow({
        repository, events, db,
        getCatalogSnapshot: () => fakeCatalog(),
        optimizerInstanceId,
        schedulerInstanceId: sid,
        minSamples: 1,
      }, pid),
    evaluateCanary: (s) => evaluateCanary({ repository, events, db }, s),
    decideCanaryAction,
  });

  // Tick 1: shadow → validated → canary (single tick: step 2 starts canary immediately)
  clock.tick();
  await autoFlow.tick(sid);
  assert.equal(repository.getRound(candidateRoundId)!.status, "canary");
  assert.ok(repository.getInstance(sid)!.canaryRoundId);
  assert.equal(repository.getInstance(sid)!.canaryRoundId, candidateRoundId);

  // Tick 2: no-op (canary already active, no runs yet → minSamples not met)
  clock.tick();
  await autoFlow.tick(sid);

  // Seed attributed canary runs (better than control)
  clock.tick();
  const postCanaryTs = clock.peek();
  for (let i = 0; i < 10; i++) {
    const traceId = `trace-promo-${i}`;
    seedDispatchEvent(events, traceId, sid, candidateRoundId);
    seedRun(db, postCanaryTs, { completion: 0.93, cost: 0.008, trace_id: traceId, model: "gpt-4o" });
  }
  for (let i = 0; i < 10; i++) {
    const traceId = `trace-promo-ctrl-${i}`;
    seedDispatchEvent(events, traceId, sid, round0Id);
    seedRun(db, postCanaryTs, { completion: 0.88, cost: 0.012, trace_id: traceId, model: "gpt-4o" });
  }

  // Tick 3: evaluate canary → auto-promote
  clock.tick();
  await autoFlow.tick(sid);

  // Verify auto-promote event
  const promotedEvents = events.query({ limit: 500 })
    .filter((e) => e.eventType === "optimizer.auto.promoted");
  assert.ok(promotedEvents.length >= 1, "auto-promoted event should be emitted");

  const promotedEvent = promotedEvents[promotedEvents.length - 1];
  assert.equal(
    (promotedEvent.identity as Record<string, unknown>).optimizationRoundId,
    candidateRoundId,
    "should reference candidate round",
  );

  const payload = promotedEvent.payload as Record<string, unknown>;
  assert.ok((payload.canaryRuns as number) > 0);
  assert.ok((payload.controlRuns as number) > 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Degradation → auto-abort
// ═══════════════════════════════════════════════════════════════════════════════

test("integration: degraded canary → auto-rollback (event chain + traceability)", async () => {
  const clock = makeClock(2000000);
  const { db, repository, events, controlPlane } = setupCore(clock);

  const sid = "ws-degrade";
  const optimizerInstanceId = "tuner-degrade";

  bootstrapInstance(controlPlane, repository, sid, optimizerInstanceId);
  const round0Id = repository.getInstance(sid)!.currentRoundId;

  // Seed baseline runs
  const windowStart = clock.peek();
  clock.tick();
  for (let i = 0; i < 10; i++) { seedRun(db, clock.peek(), { model: "gpt-4o" }); }

  const candidateParams = {
    weights: { completion: 0.7, costEffectiveness: 0.1, performance: 0.1, benchmark: 0.1 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
  };
  const dataWindow = { since: windowStart, until: clock.peek() + 1 };

  const { proposalId } = controlPlane.submitProposal(optimizerInstanceId, sid, {
    baseRoundId: round0Id,
    parameters: candidateParams,
    evaluation: { summary: "Test", metrics: { runs: 10 }, dataWindow },
  });
  const candidateRoundId = repository.getProposal(proposalId)!.candidateRoundId!;

  const config: OptimizerConfig = {
    shadow: { enabled: true },
    canaryPercent: 30,
    autoTrigger: { enabled: false },
    autoPromote: { enabled: false },
    autoRollback: { enabled: true, minSamples: 3, epsilonCompletion: 0.05, epsilonCost: 0.05 },
  };

  const autoFlow = createAutoFlow({
    repository, events, controlPlane, config,
    evaluateShadow: (pid: string) =>
      evaluateShadow({
        repository, events, db,
        getCatalogSnapshot: () => fakeCatalog(),
        optimizerInstanceId,
        schedulerInstanceId: sid,
        minSamples: 1,
      }, pid),
    evaluateCanary: (s) => evaluateCanary({ repository, events, db }, s),
    decideCanaryAction,
  });

  // Tick 1: shadow → validated → canary (single tick: step 2 starts canary immediately)
  clock.tick();
  await autoFlow.tick(sid);
  assert.equal(repository.getRound(candidateRoundId)!.status, "canary");
  assert.ok(repository.getInstance(sid)!.canaryRoundId);

  // Tick 2: no-op (canary already active, no runs yet → minSamples not met)
  clock.tick();
  await autoFlow.tick(sid);

  // Seed degraded canary runs (worse than control — completion 0.55 vs 0.85)
  clock.tick();
  const postCanaryTs = clock.peek();
  for (let i = 0; i < 10; i++) {
    const traceId = `trace-deg-${i}`;
    seedDispatchEvent(events, traceId, sid, candidateRoundId);
    seedRun(db, postCanaryTs, { completion: 0.55, cost: 0.030, trace_id: traceId, model: "gpt-4o" });
  }
  for (let i = 0; i < 10; i++) {
    const traceId = `trace-deg-ctrl-${i}`;
    seedDispatchEvent(events, traceId, sid, round0Id);
    seedRun(db, postCanaryTs, { completion: 0.85, cost: 0.010, trace_id: traceId, model: "gpt-4o" });
  }

  // Tick 3: evaluate → auto-rollback
  clock.tick();
  await autoFlow.tick(sid);

  const instanceAfter = repository.getInstance(sid)!;
  assert.equal(instanceAfter.canaryRoundId, undefined, "canary should be cleared");

  const rbRound = repository.getRound(candidateRoundId)!;
  assert.equal(rbRound.status, "rolled-back");

  const rollbackEvents = events.query({ limit: 500 })
    .filter((e) => e.eventType === "optimizer.auto.rollback");
  assert.ok(rollbackEvents.length >= 1, "auto-rollback event should be emitted");

  const rbEvent = rollbackEvents[rollbackEvents.length - 1];
  const rbId = rbEvent.identity as Record<string, unknown>;
  assert.equal(rbId.optimizationRoundId, candidateRoundId);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: NULL trace_id exclusion
// ═══════════════════════════════════════════════════════════════════════════════

test("integration: NULL trace_id runs excluded from canary attribution", async () => {
  const clock = makeClock(3000000);
  const { db, repository, events, controlPlane } = setupCore(clock);

  const sid = "ws-nulltrace";
  const optimizerInstanceId = "tuner-nulltrace";

  bootstrapInstance(controlPlane, repository, sid, optimizerInstanceId);

  // Seed baseline runs + proposal — baseline runs must be BEFORE canary round creation
  const windowStart = clock.peek();
  clock.tick();
  for (let i = 0; i < 10; i++) { seedRun(db, windowStart + 1, { model: "gpt-4o" }); }

  const candidateParams = {
    weights: { completion: 0.5, costEffectiveness: 0.25, performance: 0.15, benchmark: 0.1 },
    topN: 3,
    pinBehavior: "respect",
    syncOnDispatch: false,
  };
  const dataWindow = { since: windowStart, until: clock.peek() + 1 };
  const round0Id = repository.getInstance(sid)!.currentRoundId;

  const { proposalId } = controlPlane.submitProposal(optimizerInstanceId, sid, {
    baseRoundId: round0Id,
    parameters: candidateParams,
    evaluation: { summary: "Test", metrics: { runs: 10 }, dataWindow },
  });
  const candidateRoundId = repository.getProposal(proposalId)!.candidateRoundId!;

  // Manually set up canary (marks round validated + sets canary pointer)
  controlPlane.markRoundValidated(candidateRoundId);
  repository.setCanaryRound(sid, candidateRoundId, 30);

  // Seed traced runs (attributed to canary) — AFTER canary round is created
  clock.tick();
  const afterCanaryTs = clock.peek();
  for (let i = 0; i < 10; i++) {
    const traceId = `trace-null-${i}`;
    seedDispatchEvent(events, traceId, sid, candidateRoundId);
    seedRun(db, afterCanaryTs, { completion: 0.9, cost: 0.01, trace_id: traceId, model: "gpt-4o" });
  }
  // NULL trace_id runs (should be excluded from attribution but counted as excludedNullTrace)
  for (let i = 0; i < 5; i++) {
    seedRun(db, afterCanaryTs, { completion: 0.5, cost: 0.05, model: "gpt-4o" });
  }

  const evalResult = evaluateCanary({ repository, events, db }, sid);
  assert.equal(evalResult.excludedNullTrace, 5, "5 NULL-trace runs should be excluded");
  assert.equal(evalResult.canary.runs, 10, "10 traced runs should be attributed to canary");
});
