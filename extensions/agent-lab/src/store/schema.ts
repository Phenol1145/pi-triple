export const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_runs_role_model ON runs(role, model);
CREATE TABLE IF NOT EXISTS role_pin (
  role TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Ordered additive migrations for existing databases.
 *  Each entry is a [version, SQL] tuple. The store runs any migration
 *  with version > current db version in order. */
export const MIGRATIONS: Array<[number, string]> = [
  [1, `ALTER TABLE runs ADD COLUMN trace_id TEXT`],
  [2, `ALTER TABLE runs ADD COLUMN tenant_id TEXT`],
  [3, `ALTER TABLE runs ADD COLUMN session_id TEXT`],
  [4, `CREATE INDEX IF NOT EXISTS idx_runs_tenant ON runs(tenant_id)`],
  [5, `ALTER TABLE runs RENAME COLUMN tenant_id TO template_id; DROP INDEX IF EXISTS idx_runs_tenant; CREATE INDEX IF NOT EXISTS idx_runs_template ON runs(template_id)`],
];
