import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

// ── Helpers ─────────────────────────────────────────────────────────

const isUuid = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const MARKER_NS = "migration";
const MARKER_KEY = "uuid_identity.completed";

// ── Row shapes (subset used during migration) ───────────────────────

interface SchedulerRow {
  id: string;
  name: string;
  definition_id: string;
  current_round_id: string;
  canary_round_id: string | null;
}

interface RoundRow {
  id: string;
  scheduler_instance_id: string;
  parent_round_id: string | null;
}

interface BindingRow {
  id: string;
  name: string;
  scheduler_instance_id: string;
}

interface OptimizerRow {
  id: string;
  name: string;
  target_schedulers_json: string;
}

interface AgentRow {
  id: string;
  scheduler_instance_id: string;
  created_round_id: string;
}

interface ProposalRow {
  id: string;
  optimizer_instance_id: string;
  scheduler_instance_id: string;
  base_round_id: string;
  candidate_round_id: string | null;
  promoted_round_id: string | null;
}

// ── Main ────────────────────────────────────────────────────────────

/**
 * Idempotent migration: converts string instance ids to UUIDs across all
 * instance/round/binding/optimizer/agent/proposal tables, keeping FKs consistent.
 *
 * Returns `{ migrated: true, mapping }` on first run (mapping = oldSchedulerId→uuid).
 * Returns `{ migrated: false, mapping: {} }` when already migrated.
 */
export function runUuidIdentityMigration(
  db: DatabaseSync,
): { migrated: boolean; mapping: Record<string, string> } {
  // ── 0. Ensure name column exists on instance tables (idempotent) ──
  // Must precede _applyCoreMigrations' UNIQUE index creation so legacy
  // DBs with duplicate '' names get distinct names set before the index.
  const tablesNeedingName = ["lab_scheduler_instances", "lab_optimizer_instances", "lab_routing_bindings"];
  for (const table of tablesNeedingName) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "name")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
    }
  }

  // ── 1. Detect: if ALL schedulers already UUID → skip ──────────────
  const schedulerRows = db
    .prepare(
      "SELECT id, name, definition_id, current_round_id, canary_round_id FROM lab_scheduler_instances",
    )
    .all() as SchedulerRow[];

  const allUuid = schedulerRows.length > 0 && schedulerRows.every((r) => isUuid(r.id));
  if (allUuid) {
    return { migrated: false, mapping: {} };
  }

  // ── Build all mappings FIRST (read-only phase) ────────────────────

  // Scheduler id → uuid
  const schedulerMap: Record<string, string> = {};
  for (const row of schedulerRows) {
    if (!isUuid(row.id)) {
      schedulerMap[row.id] = crypto.randomUUID();
    }
  }

  // Optimizer id → uuid
  const optimizerRows = db
    .prepare("SELECT id FROM lab_optimizer_instances")
    .all() as Array<{ id: string }>;
  const optimizerMap: Record<string, string> = {};
  for (const row of optimizerRows) {
    if (!isUuid(row.id)) {
      optimizerMap[row.id] = crypto.randomUUID();
    }
  }

  // Round id → uuid
  const roundRows = db
    .prepare("SELECT id, scheduler_instance_id, parent_round_id FROM lab_optimization_rounds")
    .all() as RoundRow[];
  const roundMap: Record<string, string> = {};
  for (const row of roundRows) {
    if (!isUuid(row.id)) {
      roundMap[row.id] = crypto.randomUUID();
    }
  }

  // ── Apply in transaction ──────────────────────────────────────────

  db.exec("BEGIN");

  try {
    // ── 2. Scheduler instances ──────────────────────────────────────
    for (const row of schedulerRows) {
      if (!isUuid(row.id)) {
        const newId = schedulerMap[row.id];
        let name: string;
        let newDefId = row.definition_id;

        if (row.definition_id === "arena") {
          name = "default-market";
          newDefId = "market";
        } else {
          name = row.id;
        }

        db.prepare(
          "UPDATE lab_scheduler_instances SET id = ?, name = ?, definition_id = ? WHERE id = ?",
        ).run(newId, name, newDefId, row.id);
      }
    }

    // ── 3. Optimization rounds ──────────────────────────────────────
    for (const row of roundRows) {
      if (!isUuid(row.id)) {
        const newId = roundMap[row.id];
        const newSchedulerId = schedulerMap[row.scheduler_instance_id] ?? row.scheduler_instance_id;
        const newParentId =
          row.parent_round_id != null
            ? (roundMap[row.parent_round_id] ?? row.parent_round_id)
            : null;

        db.prepare(
          "UPDATE lab_optimization_rounds SET id = ?, scheduler_instance_id = ?, parent_round_id = ? WHERE id = ?",
        ).run(newId, newSchedulerId, newParentId, row.id);
      } else {
        // UUID round — still fix FK if scheduler is old string
        if (schedulerMap[row.scheduler_instance_id]) {
          db.prepare(
            "UPDATE lab_optimization_rounds SET scheduler_instance_id = ? WHERE id = ?",
          ).run(schedulerMap[row.scheduler_instance_id], row.id);
        }
      }
    }

    // ── 4. Routing bindings ─────────────────────────────────────────
    const bindingRows = db
      .prepare("SELECT id, name, scheduler_instance_id FROM lab_routing_bindings")
      .all() as BindingRow[];

    for (const row of bindingRows) {
      let newId = row.id;
      let newName = row.name;
      const newSchedulerId = schedulerMap[row.scheduler_instance_id] ?? row.scheduler_instance_id;

      if (!isUuid(row.id)) {
        newId = crypto.randomUUID();

        // Name mapping (market terminology)
        if (row.id === "arena-default") {
          newName = "market-default";
        } else {
          newName = row.id;
        }
      }

      if (newId !== row.id || newName !== row.name || newSchedulerId !== row.scheduler_instance_id) {
        db.prepare(
          "UPDATE lab_routing_bindings SET id = ?, name = ?, scheduler_instance_id = ? WHERE id = ?",
        ).run(newId, newName, newSchedulerId, row.id);
      }
    }

    // ── 5. Optimizer instances ──────────────────────────────────────
    const optFullRows = db
      .prepare("SELECT id, name, target_schedulers_json FROM lab_optimizer_instances")
      .all() as OptimizerRow[];

    for (const row of optFullRows) {
      let newId = row.id;
      let newName = row.name;

      if (!isUuid(row.id)) {
        newId = optimizerMap[row.id];
        newName = row.id;
      }

      // Replace old scheduler ids in target_schedulers_json
      let targets: string[];
      try {
        targets = JSON.parse(row.target_schedulers_json) as string[];
      } catch {
        targets = [];
      }

      let jsonChanged = false;
      const newTargets = targets.map((t) => {
        if (schedulerMap[t]) {
          jsonChanged = true;
          return schedulerMap[t];
        }
        return t;
      });

      if (newId !== row.id || newName !== row.name || jsonChanged) {
        db.prepare(
          "UPDATE lab_optimizer_instances SET id = ?, name = ?, target_schedulers_json = ? WHERE id = ?",
        ).run(newId, newName, JSON.stringify(newTargets), row.id);
      }
    }

    // ── 6. Agent instances (id already UUID, just FK mapping) ───────
    const agentRows = db
      .prepare("SELECT id, scheduler_instance_id, created_round_id FROM lab_agent_instances")
      .all() as AgentRow[];

    for (const row of agentRows) {
      const newSchedulerId = schedulerMap[row.scheduler_instance_id];
      const newCreatedRoundId = roundMap[row.created_round_id];

      if (newSchedulerId || newCreatedRoundId) {
        db.prepare(
          "UPDATE lab_agent_instances SET scheduler_instance_id = ?, created_round_id = ? WHERE id = ?",
        ).run(
          newSchedulerId ?? row.scheduler_instance_id,
          newCreatedRoundId ?? row.created_round_id,
          row.id,
        );
      }
    }

    // ── 7. Scheduler current_round_id / canary_round_id ─────────────
    const schedAfter = db
      .prepare("SELECT id, current_round_id, canary_round_id FROM lab_scheduler_instances")
      .all() as SchedulerRow[];

    for (const row of schedAfter) {
      const newCur = roundMap[row.current_round_id];
      const newCanary =
        row.canary_round_id != null ? roundMap[row.canary_round_id] : undefined;

      if (newCur || newCanary) {
        db.prepare(
          "UPDATE lab_scheduler_instances SET current_round_id = ?, canary_round_id = ? WHERE id = ?",
        ).run(
          newCur ?? row.current_round_id,
          newCanary ?? row.canary_round_id,
          row.id,
        );
      }
    }

    // ── 8. Proposals (all FK references) ────────────────────────────
    const proposalRows = db
      .prepare(
        "SELECT id, optimizer_instance_id, scheduler_instance_id, base_round_id, " +
          "candidate_round_id, promoted_round_id FROM lab_proposals",
      )
      .all() as ProposalRow[];

    for (const row of proposalRows) {
      const newOptimizerId =
        optimizerMap[row.optimizer_instance_id] ?? row.optimizer_instance_id;
      const newSchedulerId =
        schedulerMap[row.scheduler_instance_id] ?? row.scheduler_instance_id;
      const newBaseRoundId = roundMap[row.base_round_id] ?? row.base_round_id;
      const newCandidateRoundId =
        row.candidate_round_id != null
          ? (roundMap[row.candidate_round_id] ?? row.candidate_round_id)
          : null;
      const newPromotedRoundId =
        row.promoted_round_id != null
          ? (roundMap[row.promoted_round_id] ?? row.promoted_round_id)
          : null;

      if (
        newOptimizerId !== row.optimizer_instance_id ||
        newSchedulerId !== row.scheduler_instance_id ||
        newBaseRoundId !== row.base_round_id ||
        newCandidateRoundId !== row.candidate_round_id ||
        newPromotedRoundId !== row.promoted_round_id
      ) {
        db.prepare(
          "UPDATE lab_proposals SET " +
            "optimizer_instance_id = ?, scheduler_instance_id = ?, base_round_id = ?, " +
            "candidate_round_id = ?, promoted_round_id = ? " +
            "WHERE id = ?",
        ).run(
          newOptimizerId,
          newSchedulerId,
          newBaseRoundId,
          newCandidateRoundId,
          newPromotedRoundId,
          row.id,
        );
      }
    }

    // ── 9. Write completion marker ──────────────────────────────────
    const marker = { ts: Date.now(), version: "1.0.0" };
    db.prepare(
      "INSERT OR REPLACE INTO lab_namespace_kv (namespace, key, value_json, version, updated_ts) " +
        "VALUES (?, ?, ?, ?, ?)",
    ).run(MARKER_NS, MARKER_KEY, JSON.stringify(marker), 1, Date.now());

    db.exec("COMMIT");

    return { migrated: true, mapping: { ...schedulerMap } };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
