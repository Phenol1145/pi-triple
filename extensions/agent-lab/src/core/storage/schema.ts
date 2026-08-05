export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS lab_scheduler_drafts (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'validated', 'activated', 'rejected')),
  validation_json TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_scheduler_instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
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
  created_ts INTEGER NOT NULL,
  UNIQUE(definition_id, name)
);

CREATE TABLE IF NOT EXISTS lab_optimization_rounds (
  id TEXT PRIMARY KEY,
  scheduler_instance_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  parent_round_id TEXT,
  parameters_json TEXT NOT NULL,
  optimizer_json TEXT,
  proposal_id TEXT,
  status TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  activated_ts INTEGER,
  UNIQUE(scheduler_instance_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_lab_rounds_scheduler ON lab_optimization_rounds(scheduler_instance_id, sequence);

CREATE TABLE IF NOT EXISTS lab_agent_instances (
  id TEXT PRIMARY KEY,
  scheduler_instance_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  model TEXT,
  source_template_id TEXT,
  source_agent_id TEXT,
  clone_operation_id TEXT,
  memory_spec TEXT,
  endowment TEXT,
  elo_global REAL,
  elo_by_domain TEXT,
  accepts TEXT,
  created_round_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_agents_scheduler ON lab_agent_instances(scheduler_instance_id, id);

CREATE TABLE IF NOT EXISTS lab_routing_bindings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  scheduler_instance_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  match_json TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  UNIQUE(scheduler_instance_id, name)
);
CREATE INDEX IF NOT EXISTS idx_lab_routes_priority ON lab_routing_bindings(priority DESC, id);

CREATE TABLE IF NOT EXISTS lab_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sequence INTEGER,
  trace_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_events_trace ON lab_events(trace_id, ts, event_id);
CREATE INDEX IF NOT EXISTS idx_lab_events_type ON lab_events(event_type, ts, event_id);

CREATE TABLE IF NOT EXISTS lab_namespace_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY(namespace, key)
);

CREATE TABLE IF NOT EXISTS lab_optimizer_instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  definition_id TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  config_json TEXT NOT NULL,
  target_schedulers_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(definition_id, name)
);

CREATE TABLE IF NOT EXISTS lab_proposals (
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

-- F/WP5 §6.1: 定时触发任务表（含 tenantId——多租户共享 DB 的租户隔离）。
-- 注意：表名按 spec/plan 逐字为 scheduled_jobs（偏离 lab_* 前缀惯例——spec 为契约）。
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('cron', 'at', 'interval')),
  schedule_spec TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'done', 'cancelled')),
  next_fire_at INTEGER NOT NULL,
  last_fire_at INTEGER,
  fire_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  legal_ref TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(status, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_tenant ON scheduled_jobs(tenant_id, id);
`;
