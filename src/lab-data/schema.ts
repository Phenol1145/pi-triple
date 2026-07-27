/**
 * lab-data schema — 表名/列名常量
 *
 * 外部契约，不 import extensions/ 下任何模块。
 * 从 agent-lab/src/store/schema.ts 和 src/core/storage/schema.ts 抄录。
 */

export const TABLES = {
  runs: "runs",
  rolePin: "role_pin",
  config: "config",
  credits: "credits",
  creditTx: "credit_tx",
  marketTasks: "market_tasks",
  arenaFreezes: "arena_freezes",
  labEvents: "lab_events",
};

export const RUN_COLUMNS = [
  "id",
  "ts",
  "role",
  "model",
  "task_category",
  "acceptance",
  "completion",
  "tokens_in",
  "tokens_out",
  "cost",
  "tool_success",
  "turns",
  "interrupted",
  "signals",
  "source",
  "trace_id",
  "tenant_id",
  "session_id",
] as const;
