import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA } from "../src/core/storage/schema.ts";

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Build a :memory: DB with legacy string-id data matching a pre-UUID-identity state. */
function setupLegacy(): {
  db: DatabaseSync;
  /** The agent instance uuid inserted (for reference). */
  agentUuid: string;
} {
  const db = new DatabaseSync(":memory:");
  db.exec(CORE_SCHEMA);

  const now = Date.now();

  // ── Schedulers: string ids ──
  db.exec(`
    INSERT INTO lab_scheduler_instances
      (id, name, definition_id, definition_version, parameter_model_version,
       agent_schema_version, status, current_round_id, canary_round_id,
       canary_percent, fallback_chain_json, metadata_json, created_ts)
    VALUES
      ('default-arena', '', 'arena', '1.0.0', '1.0.0', '1.0.0',
       'active', 'default-arena:round:0', NULL, NULL,
       '[]', '{}', ${now}),
      ('default-weighted-scorer', '', 'weighted-scorer', '1.0.0', '1.0.0', '1.0.0',
       'active', '', NULL, NULL,
       '[]', '{}', ${now})
  `);

  // ── Rounds: string ids ──
  db.exec(`
    INSERT INTO lab_optimization_rounds
      (id, scheduler_instance_id, sequence, parent_round_id, parameters_json,
       optimizer_json, proposal_id, status, created_ts)
    VALUES
      ('default-arena:round:0', 'default-arena', 0, NULL,
       '{}', NULL, NULL, 'active', ${now})
  `);

  // ── Routing bindings: string ids, name set to id to avoid UNIQUE(si,name) collision ──
  db.exec(`
    INSERT INTO lab_routing_bindings
      (id, name, scheduler_instance_id, priority, match_json, created_ts)
    VALUES
      ('arena-default', 'arena-default', 'default-arena', 10, '{}', ${now}),
      ('default', 'default', 'default-arena', 0, '{}', ${now})
  `);

  // ── Optimizer instances: string ids, targets old scheduler id ──
  db.exec(`
    INSERT INTO lab_optimizer_instances
      (id, name, definition_id, definition_version, config_json,
       target_schedulers_json, status, created_at)
    VALUES
      ('default-weighted-tuner', '', 'weighted-tuner', '1.0.0', '{}',
       '["default-arena"]', 'active', ${now})
  `);

  // ── Agent instance: id already UUID, FKs reference old string ids ──
  const agentUuid = crypto.randomUUID();
  db.exec(`
    INSERT INTO lab_agent_instances
      (id, scheduler_instance_id, definition_json, model,
       source_template_id, source_agent_id, clone_operation_id,
       created_round_id, status, created_ts)
    VALUES
      ('${agentUuid}', 'default-arena', '{}', NULL,
       NULL, NULL, NULL,
       'default-arena:round:0', 'active', ${now})
  `);

  return { db, agentUuid };
}

// ── Dynamic import (module may not exist yet) ──
async function loadMigration(): Promise<{
  runUuidIdentityMigration: (
    db: DatabaseSync,
  ) => { migrated: boolean; mapping: Record<string, string> };
}> {
  return (await import("../src/migrate-uuid-identity.ts")) as never;
}

test("migrates legacy string ids to UUIDs with consistent FKs", async () => {
  const { db, agentUuid } = setupLegacy();
  const { runUuidIdentityMigration } = await loadMigration();

  const result = runUuidIdentityMigration(db);

  assert.equal(result.migrated, true);
  assert.ok(Object.keys(result.mapping).length >= 1, "should map at least one scheduler");

  // ── Verify scheduler instances ──
  const schedulerRows = db
    .prepare(
      "SELECT id, name, definition_id, current_round_id, canary_round_id FROM lab_scheduler_instances ORDER BY created_ts",
    )
    .all() as Array<{
    id: string;
    name: string;
    definition_id: string;
    current_round_id: string;
    canary_round_id: string | null;
  }>;

  assert.equal(schedulerRows.length, 2);

  const market = schedulerRows.find((r) => r.definition_id === "market")!;
  assert.ok(market, "market scheduler should exist");
  assert.ok(isUuid(market.id), "market scheduler id should be UUID");
  assert.equal(market.name, "default-market");
  // definition_id "arena" → "market"
  assert.equal(market.definition_id, "market");
  // current_round_id should have been remapped to a UUID
  assert.ok(isUuid(market.current_round_id), "current_round_id should be UUID");

  const wscorer = schedulerRows.find((r) => r.definition_id === "weighted-scorer")!;
  assert.ok(wscorer, "weighted-scorer scheduler should exist");
  assert.ok(isUuid(wscorer.id), "weighted-scorer id should be UUID");
  assert.equal(wscorer.name, "default-weighted-scorer");

  // ── Verify rounds ──
  const roundRows = db
    .prepare("SELECT id, scheduler_instance_id, parent_round_id FROM lab_optimization_rounds")
    .all() as Array<{
    id: string;
    scheduler_instance_id: string;
    parent_round_id: string | null;
  }>;
  assert.equal(roundRows.length, 1);
  const round = roundRows[0];
  assert.ok(isUuid(round.id), "round id should be UUID");
  assert.notEqual(round.id, "default-arena:round:0");
  assert.equal(round.scheduler_instance_id, market.id, "round FK → market scheduler uuid");
  assert.equal(round.parent_round_id, null);

  // ── Verify routing bindings ──
  const bindings = db
    .prepare("SELECT id, name, scheduler_instance_id FROM lab_routing_bindings ORDER BY priority DESC")
    .all() as Array<{ id: string; name: string; scheduler_instance_id: string }>;
  assert.equal(bindings.length, 2);

  const marketBinding = bindings.find((b) => b.name === "market-default")!;
  assert.ok(marketBinding, "market-default binding should exist");
  assert.ok(isUuid(marketBinding.id), "market-default binding id should be UUID");
  assert.equal(marketBinding.scheduler_instance_id, market.id);

  const defaultBinding = bindings.find((b) => b.name === "default")!;
  assert.ok(defaultBinding, "default binding should exist");
  assert.ok(isUuid(defaultBinding.id), "default binding id should be UUID");
  assert.equal(defaultBinding.scheduler_instance_id, market.id);

  // ── Verify optimizer instances ──
  const optimizers = db
    .prepare("SELECT id, name, target_schedulers_json FROM lab_optimizer_instances")
    .all() as Array<{ id: string; name: string; target_schedulers_json: string }>;
  assert.equal(optimizers.length, 1);
  const tuner = optimizers[0];
  assert.ok(isUuid(tuner.id), "tuner id should be UUID");
  assert.equal(tuner.name, "default-weighted-tuner");
  const targets: string[] = JSON.parse(tuner.target_schedulers_json);
  assert.ok(targets.includes(market.id), "target_schedulers_json should contain market uuid");
  assert.ok(!targets.includes("default-arena"), "target_schedulers_json should NOT contain old string id");

  // ── Verify agent instances ──
  const agents = db
    .prepare("SELECT id, scheduler_instance_id, created_round_id FROM lab_agent_instances")
    .all() as Array<{ id: string; scheduler_instance_id: string; created_round_id: string }>;
  assert.equal(agents.length, 1);
  const agent = agents[0];
  assert.equal(agent.id, agentUuid);
  assert.equal(agent.scheduler_instance_id, market.id);
  assert.equal(agent.created_round_id, round.id);

  // ── Verify scheduler current_round_id ──
  assert.equal(market.current_round_id, round.id);

  db.close();
});

test("idempotent: second run returns migrated=false and changes nothing", async () => {
  const { db } = setupLegacy();
  const { runUuidIdentityMigration } = await loadMigration();

  // First run
  const result1 = runUuidIdentityMigration(db);
  assert.equal(result1.migrated, true);

  // Snapshot all ids after first run
  const snapshot = db
    .prepare(
      "SELECT 'scheduler' AS kind, id FROM lab_scheduler_instances " +
        "UNION ALL SELECT 'round', id FROM lab_optimization_rounds " +
        "UNION ALL SELECT 'binding', id FROM lab_routing_bindings " +
        "UNION ALL SELECT 'optimizer', id FROM lab_optimizer_instances " +
        "UNION ALL SELECT 'agent', id FROM lab_agent_instances",
    )
    .all() as Array<{ kind: string; id: string }>;

  // Second run
  const result2 = runUuidIdentityMigration(db);
  assert.equal(result2.migrated, false, "second run should report already migrated");

  // Snapshot after second run
  const snapshot2 = db
    .prepare(
      "SELECT 'scheduler' AS kind, id FROM lab_scheduler_instances " +
        "UNION ALL SELECT 'round', id FROM lab_optimization_rounds " +
        "UNION ALL SELECT 'binding', id FROM lab_routing_bindings " +
        "UNION ALL SELECT 'optimizer', id FROM lab_optimizer_instances " +
        "UNION ALL SELECT 'agent', id FROM lab_agent_instances",
    )
    .all() as Array<{ kind: string; id: string }>;

  assert.deepEqual(snapshot, snapshot2, "all ids must be unchanged on second run");

  // Verify the completion marker exists
  const marker = db
    .prepare(
      "SELECT value_json FROM lab_namespace_kv WHERE namespace = 'migration' AND key = 'uuid_identity.completed'",
    )
    .get() as { value_json: string } | undefined;
  assert.ok(marker, "completion marker should exist after first run");

  db.close();
});

test("no-op when all schedulers are already UUIDs", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(CORE_SCHEMA);

  // Insert scheduler with UUID id
  const uuid = crypto.randomUUID();
  db.exec(`
    INSERT INTO lab_scheduler_instances
      (id, name, definition_id, definition_version, parameter_model_version,
       agent_schema_version, status, current_round_id, canary_round_id,
       canary_percent, fallback_chain_json, metadata_json, created_ts)
    VALUES
      ('${uuid}', 'my-market', 'market', '1.0.0', '1.0.0', '1.0.0',
       'active', '', NULL, NULL,
       '[]', '{}', ${Date.now()})
  `);

  const { runUuidIdentityMigration } = await loadMigration();
  const result = runUuidIdentityMigration(db);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.mapping, {});

  db.close();
});
