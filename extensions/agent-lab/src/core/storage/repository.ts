import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA } from "./schema.ts";
import type {
  SchedulerInstanceDraftSpec,
  SchedulerInstanceRecord,
  OptimizationRoundRecord,
  AgentInstanceRecord,
  ValidationReport,
} from "../contracts.ts";

export interface OptimizerInstanceRecord {
  id: string;
  name: string;
  definitionId: string;
  definitionVersion: string;
  config: unknown;
  targetSchedulers: string[];
  status: "active" | "disabled";
  createdAt: number;
}

export interface ProposalRecord {
  id: string;
  optimizerInstanceId: string;
  schedulerInstanceId: string;
  baseRoundId: string;
  parameters: unknown;
  evaluation?: unknown;
  status: "pending" | "accepted" | "rejected" | "superseded";
  candidateRoundId?: string;
  promotedRoundId?: string;
  createdAt: number;
}

export interface StoredDraft {
  id: string;
  spec: SchedulerInstanceDraftSpec;
  status: "draft" | "validated" | "activated" | "rejected";
  validation?: ValidationReport;
  createdAt: number;
  updatedAt: number;
}

export class CoreRepository {
  private readonly db: DatabaseSync;
  private _inTransaction = false;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CORE_SCHEMA);
    this._applyCoreMigrations();
  }

  /** Expose raw db handle for transaction control (bootstrap concurrent safety). */
  get raw(): DatabaseSync { return this.db; }

  private _applyCoreMigrations(): void {
    // Add canary_round_id / canary_percent columns if missing (phase 5b additive)
    for (const col of ["canary_round_id", "canary_percent"]) {
      const cols = this.db.prepare(
        `PRAGMA table_info(lab_scheduler_instances)`
      ).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === col)) {
        const colType = col === "canary_round_id" ? "TEXT" : "REAL";
        this.db.exec(`ALTER TABLE lab_scheduler_instances ADD COLUMN ${col} ${colType}`);
      }
    }
    // Add model / source_template_id columns to lab_agent_instances if missing
    // (phase 1.5 UUID AgentInstance；旧表无此列，findAgentByModel 按 model 查需要）
    for (const col of ["model", "source_template_id"]) {
      const cols = this.db.prepare(
        `PRAGMA table_info(lab_agent_instances)`
      ).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE lab_agent_instances ADD COLUMN ${col} TEXT`);
      }
    }
    // model 列就绪后建 UNIQUE 索引（防同 instance 同 model 同 template 重复 agent）。
    // 阶段 3a 联邦统一市场：UNIQUE 加 source_template_id，允许跨模板同 model 的 agent 共存。
    // 不放 CORE_SCHEMA：旧库表已存在但无 model 列，CREATE INDEX 会先于 ALTER 失败。
    this.db.exec(`DROP INDEX IF EXISTS idx_lab_agents_model`);
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_agents_model ON lab_agent_instances(scheduler_instance_id, model, source_template_id)`
    );

    // ── UUID-identity refactoring (ADR-0002): add name column + UNIQUE index for existing DBs ──
    const migrationTables: Array<{ table: string; uniqueCols: string; indexName: string }> = [
      { table: "lab_scheduler_instances", uniqueCols: "definition_id, name", indexName: "idx_lab_scheduler_instances_def_name" },
      { table: "lab_optimizer_instances", uniqueCols: "definition_id, name", indexName: "idx_lab_optimizer_instances_def_name" },
      { table: "lab_routing_bindings", uniqueCols: "scheduler_instance_id, name", indexName: "idx_lab_routing_bindings_si_name" },
    ];
    for (const { table, uniqueCols, indexName } of migrationTables) {
      const cols = this.db.prepare(
        `PRAGMA table_info(${table})`
      ).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "name")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table}(${uniqueCols})`);
    }
  }

  transaction<T>(fn: () => T): T {
    if (this._inTransaction) {
      throw new Error("nested core transaction is not supported");
    }
    this._inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this._inTransaction = false;
    }
  }

  saveDraft(spec: SchedulerInstanceDraftSpec): void {
    const now = Date.now();
    try {
      this.db.prepare(
        `INSERT INTO lab_scheduler_drafts (id, spec_json, status, created_ts, updated_ts)
         VALUES (?, ?, 'draft', ?, ?)`
      ).run(spec.id, JSON.stringify(spec), now, now);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE constraint")) {
        throw new Error(`draft already exists: ${spec.id}`);
      }
      throw e;
    }
  }

  getDraft(id: string): StoredDraft | undefined {
    const row = this.db.prepare(
      `SELECT spec_json, status, validation_json, created_ts, updated_ts
       FROM lab_scheduler_drafts WHERE id = ?`
    ).get(id) as { spec_json: string; status: string; validation_json: string | null; created_ts: number; updated_ts: number } | undefined;

    if (!row) return undefined;

    return {
      id,
      spec: JSON.parse(row.spec_json) as SchedulerInstanceDraftSpec,
      status: row.status as StoredDraft["status"],
      validation: row.validation_json ? JSON.parse(row.validation_json) as ValidationReport : undefined,
      createdAt: row.created_ts,
      updatedAt: row.updated_ts,
    };
  }

  setDraftValidation(id: string, result: ValidationReport): void {
    this.db.prepare(
      `UPDATE lab_scheduler_drafts SET validation_json = ?, updated_ts = ? WHERE id = ?`
    ).run(JSON.stringify(result), Date.now(), id);
  }

  setDraftStatus(id: string, status: StoredDraft["status"]): void {
    this.db.prepare(
      `UPDATE lab_scheduler_drafts SET status = ?, updated_ts = ? WHERE id = ?`
    ).run(status, Date.now(), id);
  }

  deleteDraft(id: string): void {
    this.db.prepare(
      `DELETE FROM lab_scheduler_drafts WHERE id = ?`
    ).run(id);
  }

  getInstance(id: string): SchedulerInstanceRecord | undefined {
    const row = this.db.prepare(
      `SELECT name, definition_id, definition_version, parameter_model_version, agent_schema_version,
              status, current_round_id, canary_round_id, canary_percent, fallback_chain_json, created_ts
       FROM lab_scheduler_instances WHERE id = ?`
    ).get(id) as {
      name: string; definition_id: string; definition_version: string; parameter_model_version: string;
      agent_schema_version: string; status: string; current_round_id: string;
      canary_round_id: string | null; canary_percent: number | null;
      fallback_chain_json: string; created_ts: number;
    } | undefined;

    if (!row) return undefined;

    return {
      id,
      name: row.name,
      definition: { kind: "scheduler" as const, id: row.definition_id, version: row.definition_version },
      parameterModelVersion: row.parameter_model_version,
      agentDefinitionSchemaVersion: row.agent_schema_version,
      status: row.status as SchedulerInstanceRecord["status"],
      currentRoundId: row.current_round_id,
      canaryRoundId: row.canary_round_id ?? undefined,
      canaryPercent: row.canary_percent ?? undefined,
      fallbackChain: JSON.parse(row.fallback_chain_json) as SchedulerInstanceRecord["fallbackChain"],
      createdAt: row.created_ts,
    };
  }

  listInstances(): SchedulerInstanceRecord[] {
    const rows = this.db.prepare(
      `SELECT id, name, definition_id, definition_version, parameter_model_version, agent_schema_version,
              status, current_round_id, canary_round_id, canary_percent, fallback_chain_json, created_ts
       FROM lab_scheduler_instances ORDER BY created_ts`
    ).all() as Array<{
      id: string; name: string; definition_id: string; definition_version: string; parameter_model_version: string;
      agent_schema_version: string; status: string; current_round_id: string;
      canary_round_id: string | null; canary_percent: number | null;
      fallback_chain_json: string; created_ts: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      definition: { kind: "scheduler" as const, id: row.definition_id, version: row.definition_version },
      parameterModelVersion: row.parameter_model_version,
      agentDefinitionSchemaVersion: row.agent_schema_version,
      status: row.status as SchedulerInstanceRecord["status"],
      currentRoundId: row.current_round_id,
      canaryRoundId: row.canary_round_id ?? undefined,
      canaryPercent: row.canary_percent ?? undefined,
      fallbackChain: JSON.parse(row.fallback_chain_json) as SchedulerInstanceRecord["fallbackChain"],
      createdAt: row.created_ts,
    }));
  }

  getRound(id: string): OptimizationRoundRecord | undefined {
    const row = this.db.prepare(
      `SELECT scheduler_instance_id, sequence, parent_round_id, parameters_json,
              optimizer_json, proposal_id, status, created_ts, activated_ts
       FROM lab_optimization_rounds WHERE id = ?`
    ).get(id) as {
      scheduler_instance_id: string; sequence: number; parent_round_id: string | null;
      parameters_json: string; optimizer_json: string | null; proposal_id: string | null;
      status: string; created_ts: number; activated_ts: number | null;
    } | undefined;

    if (!row) return undefined;

    return {
      id,
      schedulerInstanceId: row.scheduler_instance_id,
      sequence: row.sequence,
      parentRoundId: row.parent_round_id ?? undefined,
      parameters: JSON.parse(row.parameters_json) as unknown,
      optimizer: row.optimizer_json ? JSON.parse(row.optimizer_json) as OptimizationRoundRecord["optimizer"] : undefined,
      proposalId: row.proposal_id ?? undefined,
      status: row.status as OptimizationRoundRecord["status"],
      createdAt: row.created_ts,
      activatedAt: row.activated_ts ?? undefined,
    };
  }

  listAgents(schedulerInstanceId: string): AgentInstanceRecord[] {
    const rows = this.db.prepare(
      `SELECT id, definition_json, model, source_template_id, source_agent_id, clone_operation_id,
              created_round_id, status, created_ts
       FROM lab_agent_instances WHERE scheduler_instance_id = ? ORDER BY created_ts`
    ).all(schedulerInstanceId) as Array<{
      id: string; definition_json: string; model: string | null; source_template_id: string | null;
      source_agent_id: string | null; clone_operation_id: string | null;
      created_round_id: string; status: string; created_ts: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      schedulerInstanceId,
      definition: JSON.parse(row.definition_json) as AgentInstanceRecord["definition"],
      model: row.model ?? undefined,
      sourceTemplateId: row.source_template_id ?? undefined,
      sourceAgentId: row.source_agent_id ?? undefined,
      cloneOperationId: row.clone_operation_id ?? undefined,
      createdAtRoundId: row.created_round_id,
      status: row.status as AgentInstanceRecord["status"],
      createdAt: row.created_ts,
    }));
  }

  getRoutingOwner(bindingId: string): string | undefined {
    const row = this.db.prepare(
      `SELECT scheduler_instance_id FROM lab_routing_bindings WHERE id = ?`
    ).get(bindingId) as { scheduler_instance_id: string } | undefined;
    return row?.scheduler_instance_id;
  }

  insertInstance(record: SchedulerInstanceRecord, metadata: Record<string, string>): void {
    this.db.prepare(
      `INSERT INTO lab_scheduler_instances
       (id, name, definition_id, definition_version, parameter_model_version, agent_schema_version,
        status, current_round_id, canary_round_id, canary_percent, fallback_chain_json, metadata_json, created_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.name,
      record.definition.id,
      record.definition.version,
      record.parameterModelVersion,
      record.agentDefinitionSchemaVersion,
      record.status,
      record.currentRoundId,
      record.canaryRoundId ?? null,
      record.canaryPercent ?? null,
      JSON.stringify(record.fallbackChain),
      JSON.stringify(metadata),
      record.createdAt,
    );
  }

  insertRound(record: OptimizationRoundRecord): void {
    this.db.prepare(
      `INSERT INTO lab_optimization_rounds
       (id, scheduler_instance_id, sequence, parent_round_id, parameters_json,
        optimizer_json, proposal_id, status, created_ts, activated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.schedulerInstanceId,
      record.sequence,
      record.parentRoundId ?? null,
      JSON.stringify(record.parameters),
      record.optimizer ? JSON.stringify(record.optimizer) : null,
      record.proposalId ?? null,
      record.status,
      record.createdAt,
      record.activatedAt ?? null,
    );
  }

  findAgentByModel(schedulerInstanceId: string, model: string, templateId?: string): AgentInstanceRecord | undefined {
    const row = this.db.prepare(
      `SELECT id, definition_json, model, source_template_id, source_agent_id, clone_operation_id,
              created_round_id, status, created_ts
       FROM lab_agent_instances
       WHERE scheduler_instance_id = ? AND model = ? AND (source_template_id = ? OR (? IS NULL AND source_template_id IS NULL))
       LIMIT 1`
    ).get(schedulerInstanceId, model, templateId ?? null, templateId ?? null) as {
      id: string; definition_json: string; model: string | null; source_template_id: string | null;
      source_agent_id: string | null; clone_operation_id: string | null;
      created_round_id: string; status: string; created_ts: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id, schedulerInstanceId,
      definition: JSON.parse(row.definition_json) as AgentInstanceRecord["definition"],
      model: row.model ?? undefined,
      sourceTemplateId: row.source_template_id ?? undefined,
      sourceAgentId: row.source_agent_id ?? undefined,
      cloneOperationId: row.clone_operation_id ?? undefined,
      createdAtRoundId: row.created_round_id,
      status: row.status as AgentInstanceRecord["status"],
      createdAt: row.created_ts,
    };
  }

  insertAgent(record: AgentInstanceRecord): void {
    this.db.prepare(
      `INSERT INTO lab_agent_instances
       (id, scheduler_instance_id, definition_json, model, source_template_id, source_agent_id,
        clone_operation_id, created_round_id, status, created_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.schedulerInstanceId,
      JSON.stringify(record.definition),
      record.model ?? null,
      record.sourceTemplateId ?? null,
      record.sourceAgentId ?? null,
      record.cloneOperationId ?? null,
      record.createdAtRoundId,
      record.status,
      record.createdAt,
    );
  }

  insertRoutingBinding(
    schedulerInstanceId: string,
    binding: SchedulerInstanceDraftSpec["routingBindings"][number],
  ): void {
    this.db.prepare(
      `INSERT INTO lab_routing_bindings (id, name, scheduler_instance_id, priority, match_json, created_ts)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(binding.id, binding.id, schedulerInstanceId, binding.priority, JSON.stringify(binding.match), Date.now());
  }

  upsertRoutingBinding(
    schedulerInstanceId: string,
    binding: SchedulerInstanceDraftSpec["routingBindings"][number],
  ): void {
    this.db.prepare(
      `INSERT INTO lab_routing_bindings (id, name, scheduler_instance_id, priority, match_json, created_ts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         scheduler_instance_id = excluded.scheduler_instance_id,
         priority = excluded.priority,
         match_json = excluded.match_json,
         created_ts = excluded.created_ts`
    ).run(binding.id, binding.id, schedulerInstanceId, binding.priority, JSON.stringify(binding.match), Date.now());
  }

  deleteRoutingBinding(id: string): number {
    const result = this.db.prepare(
      `DELETE FROM lab_routing_bindings WHERE id = ?`
    ).run(id);
    return result.changes;
  }

  listRoutingBindings(): Array<{
    id: string;
    name: string;
    schedulerInstanceId: string;
    priority: number;
    match: { role?: string; taskCategory?: string; labels?: Record<string, string>; caller?: string };
  }> {
    const rows = this.db.prepare(
      `SELECT id, name, scheduler_instance_id, priority, match_json
       FROM lab_routing_bindings
       ORDER BY priority DESC, id ASC`
    ).all() as Array<{
      id: string;
      name: string;
      scheduler_instance_id: string;
      priority: number;
      match_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      schedulerInstanceId: row.scheduler_instance_id,
      priority: row.priority,
      match: JSON.parse(row.match_json) as { role?: string; taskCategory?: string; labels?: Record<string, string>; caller?: string },
    }));
  }

  // ── Optimizer instance methods ──

  insertOptimizerInstance(record: OptimizerInstanceRecord): void {
    this.db.prepare(
      `INSERT INTO lab_optimizer_instances
       (id, name, definition_id, definition_version, config_json, target_schedulers_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.name,
      record.definitionId,
      record.definitionVersion,
      JSON.stringify(record.config),
      JSON.stringify(record.targetSchedulers),
      record.status,
      record.createdAt,
    );
  }

  getOptimizerInstance(id: string): OptimizerInstanceRecord | undefined {
    const row = this.db.prepare(
      `SELECT name, definition_id, definition_version, config_json, target_schedulers_json, status, created_at
       FROM lab_optimizer_instances WHERE id = ?`
    ).get(id) as {
      name: string; definition_id: string; definition_version: string; config_json: string;
      target_schedulers_json: string; status: string; created_at: number;
    } | undefined;

    if (!row) return undefined;

    return {
      id,
      name: row.name,
      definitionId: row.definition_id,
      definitionVersion: row.definition_version,
      config: JSON.parse(row.config_json) as unknown,
      targetSchedulers: JSON.parse(row.target_schedulers_json) as string[],
      status: row.status as OptimizerInstanceRecord["status"],
      createdAt: row.created_at,
    };
  }

  listOptimizerInstances(): OptimizerInstanceRecord[] {
    const rows = this.db.prepare(
      `SELECT id, name, definition_id, definition_version, config_json, target_schedulers_json, status, created_at
       FROM lab_optimizer_instances ORDER BY created_at`
    ).all() as Array<{
      id: string; name: string; definition_id: string; definition_version: string; config_json: string;
      target_schedulers_json: string; status: string; created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      definitionId: row.definition_id,
      definitionVersion: row.definition_version,
      config: JSON.parse(row.config_json) as unknown,
      targetSchedulers: JSON.parse(row.target_schedulers_json) as string[],
      status: row.status as OptimizerInstanceRecord["status"],
      createdAt: row.created_at,
    }));
  }

  // ── Proposal methods ──

  insertProposal(record: ProposalRecord): void {
    this.db.prepare(
      `INSERT INTO lab_proposals
       (id, optimizer_instance_id, scheduler_instance_id, base_round_id,
        parameters_json, evaluation_json, status, candidate_round_id, promoted_round_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.optimizerInstanceId,
      record.schedulerInstanceId,
      record.baseRoundId,
      JSON.stringify(record.parameters),
      record.evaluation != null ? JSON.stringify(record.evaluation) : null,
      record.status,
      record.candidateRoundId ?? null,
      record.promotedRoundId ?? null,
      record.createdAt,
    );
  }

  getProposal(id: string): ProposalRecord | undefined {
    const row = this.db.prepare(
      `SELECT optimizer_instance_id, scheduler_instance_id, base_round_id,
              parameters_json, evaluation_json, status, candidate_round_id, promoted_round_id, created_at
       FROM lab_proposals WHERE id = ?`
    ).get(id) as {
      optimizer_instance_id: string; scheduler_instance_id: string; base_round_id: string;
      parameters_json: string; evaluation_json: string | null; status: string;
      candidate_round_id: string | null; promoted_round_id: string | null; created_at: number;
    } | undefined;

    if (!row) return undefined;

    return {
      id,
      optimizerInstanceId: row.optimizer_instance_id,
      schedulerInstanceId: row.scheduler_instance_id,
      baseRoundId: row.base_round_id,
      parameters: JSON.parse(row.parameters_json) as unknown,
      evaluation: row.evaluation_json != null ? JSON.parse(row.evaluation_json) as unknown : undefined,
      status: row.status as ProposalRecord["status"],
      candidateRoundId: row.candidate_round_id ?? undefined,
      promotedRoundId: row.promoted_round_id ?? undefined,
      createdAt: row.created_at,
    };
  }

  listProposals(schedulerInstanceId?: string): ProposalRecord[] {
    let rows: Array<{
      id: string; optimizer_instance_id: string; scheduler_instance_id: string;
      base_round_id: string; parameters_json: string; evaluation_json: string | null;
      status: string; candidate_round_id: string | null; promoted_round_id: string | null;
      created_at: number;
    }>;

    if (schedulerInstanceId) {
      rows = this.db.prepare(
        `SELECT id, optimizer_instance_id, scheduler_instance_id, base_round_id,
                parameters_json, evaluation_json, status, candidate_round_id, promoted_round_id, created_at
         FROM lab_proposals WHERE scheduler_instance_id = ? ORDER BY created_at`
      ).all(schedulerInstanceId) as typeof rows;
    } else {
      rows = this.db.prepare(
        `SELECT id, optimizer_instance_id, scheduler_instance_id, base_round_id,
                parameters_json, evaluation_json, status, candidate_round_id, promoted_round_id, created_at
         FROM lab_proposals ORDER BY created_at`
      ).all() as typeof rows;
    }

    return rows.map((row) => ({
      id: row.id,
      optimizerInstanceId: row.optimizer_instance_id,
      schedulerInstanceId: row.scheduler_instance_id,
      baseRoundId: row.base_round_id,
      parameters: JSON.parse(row.parameters_json) as unknown,
      evaluation: row.evaluation_json != null ? JSON.parse(row.evaluation_json) as unknown : undefined,
      status: row.status as ProposalRecord["status"],
      candidateRoundId: row.candidate_round_id ?? undefined,
      promotedRoundId: row.promoted_round_id ?? undefined,
      createdAt: row.created_at,
    }));
  }

  updateProposalStatus(id: string, status: ProposalRecord["status"], promotedRoundId?: string): void {
    this.db.prepare(
      `UPDATE lab_proposals SET status = ?, promoted_round_id = ? WHERE id = ?`
    ).run(status, promotedRoundId ?? null, id);
  }

  updateProposalEvaluation(id: string, evaluation: unknown): void {
    this.db.prepare(
      `UPDATE lab_proposals SET evaluation_json = ? WHERE id = ?`
    ).run(JSON.stringify(evaluation), id);
  }

  // ── Round mutation methods ──

  updateInstanceCurrentRound(instanceId: string, roundId: string): void {
    this.db.prepare(
      `UPDATE lab_scheduler_instances SET current_round_id = ? WHERE id = ?`
    ).run(roundId, instanceId);
  }

  setCanaryRound(instanceId: string, roundId: string, percent: number): void {
    this.db.prepare(
      `UPDATE lab_scheduler_instances SET canary_round_id = ?, canary_percent = ? WHERE id = ?`
    ).run(roundId, percent, instanceId);
  }

  clearCanaryRound(instanceId: string): void {
    this.db.prepare(
      `UPDATE lab_scheduler_instances SET canary_round_id = NULL, canary_percent = NULL WHERE id = ?`
    ).run(instanceId);
  }

  updateRoundStatus(roundId: string, status: string, activatedAt?: number): void {
    this.db.prepare(
      `UPDATE lab_optimization_rounds SET status = ?, activated_ts = ? WHERE id = ?`
    ).run(status, activatedAt ?? null, roundId);
  }

  listRounds(schedulerInstanceId: string, limit?: number): OptimizationRoundRecord[] {
    const effectiveLimit = Math.min(Math.max(limit ?? 100, 1), 1000);
    const rows = this.db.prepare(
      `SELECT id, scheduler_instance_id, sequence, parent_round_id, parameters_json,
              optimizer_json, proposal_id, status, created_ts, activated_ts
       FROM lab_optimization_rounds WHERE scheduler_instance_id = ?
       ORDER BY sequence DESC
       LIMIT ?`
    ).all(schedulerInstanceId, effectiveLimit) as Array<{
      id: string; scheduler_instance_id: string; sequence: number; parent_round_id: string | null;
      parameters_json: string; optimizer_json: string | null; proposal_id: string | null;
      status: string; created_ts: number; activated_ts: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      schedulerInstanceId: row.scheduler_instance_id,
      sequence: row.sequence,
      parentRoundId: row.parent_round_id ?? undefined,
      parameters: JSON.parse(row.parameters_json) as unknown,
      optimizer: row.optimizer_json ? JSON.parse(row.optimizer_json) as OptimizationRoundRecord["optimizer"] : undefined,
      proposalId: row.proposal_id ?? undefined,
      status: row.status as OptimizationRoundRecord["status"],
      createdAt: row.created_ts,
      activatedAt: row.activated_ts ?? undefined,
    }));
  }
}
