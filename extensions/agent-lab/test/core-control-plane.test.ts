import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DefinitionRegistry } from "../src/core/definitions/registry.ts";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { EventLog } from "../src/core/events/event-log.ts";
import { ControlPlane, DraftValidationError } from "../src/core/control-plane/service.ts";
import { createLabCore } from "../src/core/create-core.ts";
import type { SchedulerDefinition, SchedulerInstanceDraftSpec, WorkLoopDefinition } from "../src/core/contracts.ts";

function scheduler(): SchedulerDefinition {
  return {
    kind: "scheduler",
    id: "weighted-scorer",
    version: "1.0.0",
    sdkVersionRange: "^1.0.0",
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    parameterSchema: { type: "object" },
    agentDefinitionSchema: { type: "object" },
    defaultParameters: { topN: 1 },
    tunablePaths: ["topN"],
    validateParameters: (value) => {
      const topN = (value as { topN?: unknown })?.topN;
      return Number.isInteger(topN) && Number(topN) > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "topN", code: "range", message: "topN must be a positive integer" }] };
    },
    validateAgentDefinition: (value) => {
      const name = (value as { standard?: { name?: unknown } })?.standard?.name;
      return typeof name === "string" && name.length > 0
        ? { ok: true, value }
        : { ok: false, issues: [{ path: "standard.name", code: "required", message: "agent name is required" }] };
    },
  };
}

const loop: WorkLoopDefinition = {
  kind: "workloop",
  id: "pi-default-loop",
  version: "1.0.0",
  sdkVersionRange: "^1.0.0",
  configSchema: { type: "object" },
  requiredCapabilities: [],
  cloneModes: ["fresh", "fork"],
};

function draft(overrides: Partial<SchedulerInstanceDraftSpec> = {}): SchedulerInstanceDraftSpec {
  return {
    id: "coding-scorer",
    schedulerDefinition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    initialParameters: { topN: 2 },
    agents: [{
      id: "coding-agent-1",
      name: "coding-agent-1",
      definition: {
        standard: { name: "Coding Agent", capabilities: ["code"], executionKind: "pi-subagent", labels: {} },
        workLoop: { id: "pi-default-loop", version: "1.0.0", config: {} },
        custom: { model: "openai/gpt-5" },
      },
    }],
    fallbackChain: [{ type: "original-request" }],
    routingBindings: [{ id: "coding-route", priority: 10, match: { role: "worker" } }],
    ...overrides,
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  const definitions = new DefinitionRegistry();
  definitions.register(scheduler());
  definitions.register(loop);
  const repository = new CoreRepository(db);
  const events = new EventLog(db);
  const service = new ControlPlane(definitions, repository, events, () => 1_000);
  return { db, definitions, repository, events, service };
}

test("validateDraft reports parameters, workloop references, duplicate agent ids, and fallback targets", () => {
  const { db, service } = setup();
  service.createDraft(draft({
    initialParameters: { topN: 0 },
    agents: [draft().agents[0], draft().agents[0]],
    fallbackChain: [{ type: "scheduler-instance", id: "missing" }],
  }));
  const report = service.validateDraft("coding-scorer");
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.map((x) => x.code).sort(), ["duplicate-agent-id", "fallback-not-active", "range"]);
  db.close();
});

test("validateDraft rejects indirect fallback cycles", () => {
  const { db, repository, service } = setup();
  repository.insertInstance({
    id: "existing",
    name: "existing",
    definition: { kind: "scheduler", id: "weighted-scorer", version: "1.0.0" },
    parameterModelVersion: "1",
    agentDefinitionSchemaVersion: "1",
    status: "active",
    currentRoundId: "existing:round:0",
    fallbackChain: [{ type: "scheduler-instance", id: "coding-scorer" }],
    createdAt: 1,
  }, {});
  service.createDraft(draft({ fallbackChain: [{ type: "scheduler-instance", id: "existing" }] }));
  const report = service.validateDraft("coding-scorer");
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((x) => x.code === "fallback-cycle"));
  db.close();
});

test("activateDraft atomically creates active instance, round 0, agent, route, and event", () => {
  const { db, repository, events, service } = setup();
  service.createDraft(draft());
  const report = service.validateDraft("coding-scorer");
  assert.equal(report.ok, true);
  const result = service.activateDraft("coding-scorer");
  assert.deepEqual(result, { schedulerInstanceId: "coding-scorer", roundId: "coding-scorer:round:0", agentIds: ["coding-agent-1"] });
  assert.equal(repository.getInstance("coding-scorer")?.status, "active");
  assert.deepEqual(repository.getRound("coding-scorer:round:0")?.parameters, { topN: 2 });
  assert.equal(repository.listAgents("coding-scorer")[0].schedulerInstanceId, "coding-scorer");
  assert.equal(events.query({ eventType: "instance.activated" }).length, 1);
  db.close();
});

test("activateDraft refuses unvalidated or invalid drafts without partial state", () => {
  const { db, repository, service } = setup();
  service.createDraft(draft({ initialParameters: { topN: 0 } }));
  assert.throws(() => service.activateDraft("coding-scorer"), DraftValidationError);
  assert.equal(repository.getInstance("coding-scorer"), undefined);
  assert.equal(repository.getRound("coding-scorer:round:0"), undefined);
  assert.deepEqual(repository.listAgents("coding-scorer"), []);
  db.close();
});

test("activation rolls back if any insert conflicts", () => {
  const { db, repository, service } = setup();
  service.createDraft(draft());
  assert.equal(service.validateDraft("coding-scorer").ok, true);
  repository.insertAgent({
    id: "coding-agent-1",
    schedulerInstanceId: "other",
    definition: draft().agents[0].definition,
    createdAtRoundId: "other:round:0",
    status: "ready",
    createdAt: 1,
  });
  assert.throws(() => service.activateDraft("coding-scorer"));
  assert.equal(repository.getInstance("coding-scorer"), undefined);
  assert.equal(repository.getRound("coding-scorer:round:0"), undefined);
  db.close();
});

test("createLabCore assembles sidecar services without registering runtime hooks", () => {
  const db = new DatabaseSync(":memory:");
  const core = createLabCore(db, { now: () => 2_000 });
  assert.ok(core.definitions);
  assert.ok(core.repository);
  assert.ok(core.events);
  assert.ok(core.storage);
  assert.ok(core.controlPlane);
  assert.equal(Object.prototype.hasOwnProperty.call(core, "pi"), false);
  db.close();
});
