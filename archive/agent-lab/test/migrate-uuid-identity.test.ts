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
      ('default-arena', '', 'market', '1.0.0', '1.0.0', '1.0.0',
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
  assert.equal(market.name, "default-arena");
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

test("self-sufficient: adds name column on legacy DB (no name col) + sets distinct names, then UNIQUE index succeeds", async () => {
  // Simulate a LEGACY DB: lab_scheduler_instances WITHOUT name column
  // and WITHOUT the UNIQUE index (old schema). Insert TWO rows with the
  // SAME definition_id — both will get name='' from ALTER DEFAULT.
  // The migration should add the name column, set distinct names, and
  // then a subsequent CREATE UNIQUE INDEX should succeed.
  const db = new DatabaseSync(":memory:");

  // Legacy schema: NO name column, NO UNIQUE constraint on (definition_id, name)
  db.exec(`
    CREATE TABLE lab_scheduler_instances (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      parameter_model_version TEXT NOT NULL,
      agent_schema_version TEXT NOT NULL,
      status TEXT NOT NULL,
      current_round_id TEXT NOT NULL,
      canary_round_id TEXT,
      canary_percent REAL,
      fallback_chain_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_ts INTEGER NOT NULL
    );
    CREATE TABLE lab_optimizer_instances (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      config_json TEXT NOT NULL,
      target_schedulers_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE lab_routing_bindings (
      id TEXT PRIMARY KEY,
      scheduler_instance_id TEXT NOT NULL,
      priority INTEGER NOT NULL,
      match_json TEXT NOT NULL,
      created_ts INTEGER NOT NULL
    );
    CREATE TABLE lab_optimization_rounds (
      id TEXT PRIMARY KEY,
      scheduler_instance_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      parent_round_id TEXT,
      parameters_json TEXT NOT NULL,
      optimizer_json TEXT,
      proposal_id TEXT,
      status TEXT NOT NULL,
      created_ts INTEGER NOT NULL
    );
    CREATE TABLE lab_agent_instances (
      id TEXT PRIMARY KEY,
      scheduler_instance_id TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      model TEXT,
      source_template_id TEXT,
      source_agent_id TEXT,
      clone_operation_id TEXT,
      created_round_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_ts INTEGER NOT NULL
    );
    CREATE TABLE lab_proposals (
      id TEXT PRIMARY KEY,
      optimizer_instance_id TEXT NOT NULL,
      scheduler_instance_id TEXT NOT NULL,
      base_round_id TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      evaluation_json TEXT,
      status TEXT NOT NULL,
      candidate_round_id TEXT,
      promoted_round_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE lab_namespace_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)
    );
  `);

  const now = Date.now();

  // Insert TWO scheduler rows with the SAME definition_id (simulates legacy duplicate-
  // empty-name scenario: both would get name='' from ALTER DEFAULT, which would violate
  // a UNIQUE(definition_id, name) index if the index were created BEFORE the migration).
  db.exec(`
    INSERT INTO lab_scheduler_instances
      (id, definition_id, definition_version, parameter_model_version,
       agent_schema_version, status, current_round_id, canary_round_id,
       canary_percent, fallback_chain_json, metadata_json, created_ts)
    VALUES
      ('default-arena', 'market', '1.0.0', '1.0.0', '1.0.0',
       'active', '', NULL, NULL, '[]', '{}', ${now}),
      ('default-weighted-scorer', 'weighted-scorer', '1.0.0', '1.0.0', '1.0.0',
       'active', '', NULL, NULL, '[]', '{}', ${now}),
      ('extra-market-instance', 'market', '1.0.0', '1.0.0', '1.0.0',
       'active', '', NULL, NULL, '[]', '{}', ${now + 1})
  `);

  // Insert routing binding referencing default-arena
  db.exec(`
    INSERT INTO lab_routing_bindings
      (id, scheduler_instance_id, priority, match_json, created_ts)
    VALUES
      ('arena-default', 'default-arena', 10, '{}', ${now})
  `);

  // Insert optimizer with old target
  db.exec(`
    INSERT INTO lab_optimizer_instances
      (id, definition_id, definition_version, config_json,
       target_schedulers_json, status, created_at)
    VALUES
      ('default-weighted-tuner', 'weighted-tuner', '1.0.0', '{}',
       '["default-arena"]', 'active', ${now})
  `);

  const { runUuidIdentityMigration } = await loadMigration();

  // Run migration
  const result = runUuidIdentityMigration(db);
  assert.equal(result.migrated, true);

  // ── Assert: name column now exists on all three tables ──
  for (const table of ["lab_scheduler_instances", "lab_optimizer_instances", "lab_routing_bindings"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "name"), `${table} should have name column after migration`);
  }

  // ── Assert: ids are UUID ──
  const schedulers = db
    .prepare("SELECT id, name, definition_id FROM lab_scheduler_instances ORDER BY created_ts")
    .all() as Array<{ id: string; name: string; definition_id: string }>;
  for (const s of schedulers) {
    assert.ok(isUuid(s.id), `scheduler id ${s.id} should be UUID`);
  }

  // ── Assert: names are distinct (the two market schedulers got different names) ──
  // First market scheduler (default-arena) → name "default-arena"
  // Third market scheduler (extra-market-instance) → name "extra-market-instance"
  const marketSchedulers = schedulers.filter((s) => s.definition_id === "market");
  assert.equal(marketSchedulers.length, 2);
  const names = marketSchedulers.map((s) => s.name);
  assert.notEqual(names[0], names[1], "market schedulers should have distinct names");

  // ── Assert: CREATE UNIQUE INDEX on (definition_id, name) succeeds ──
  assert.doesNotThrow(() => {
    db.exec("CREATE UNIQUE INDEX idx_test_si_def_name ON lab_scheduler_instances(definition_id, name)");
  }, "UNIQUE index should succeed after migration sets distinct names");

  // ── Also verify optimizer_instances + routing_bindings UNIQUE indexes succeed ──
  assert.doesNotThrow(() => {
    db.exec("CREATE UNIQUE INDEX idx_test_oi_def_name ON lab_optimizer_instances(definition_id, name)");
  });
  assert.doesNotThrow(() => {
    db.exec("CREATE UNIQUE INDEX idx_test_rb_si_name ON lab_routing_bindings(scheduler_instance_id, name)");
  });

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
