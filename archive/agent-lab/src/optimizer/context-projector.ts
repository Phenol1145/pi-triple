/**
 * Context strategy projector — event-sourced aggregation over lab_events.
 *
 * Queries the `lab_events` table with raw SQL, bucketing by
 * `json_extract(identity_json, '$.agentInstanceId')`, and aggregates per-bucket
 * metrics from `model.completed`, `agent.completed`, `context.transformed`,
 * and `context.summary.created` events within an optional time window.
 *
 * ## Strategy derivation
 *
 * The strategy is derived primarily from the `workLoopId` in the event
 * identity (always present on runner-emitted events).  The special case
 * `pi-default-loop` is mapped back to `"default"`.  When `workLoopId` is
 * not available, the projector falls back to the agent instance id suffix
 * after the last `-` character (convention: `agent-<model>-<strategy>`,
 * e.g. `agent-gpt4o-default` → `default`).  If neither is available the
 * strategy defaults to `"unknown"`.
 *
 * ## Unattributed events
 *
 * Events whose `identity_json` has a NULL, missing, or empty
 * `$.agentInstanceId` are excluded from the per-strategy buckets and
 * counted in the `unattributed` total.  This is documented so callers
 * can detect gaps in event identity coverage.
 *
 * ## NULL / missing JSON defense
 *
 * All `json_extract` results for numeric fields are passed through
 * `CAST(... AS REAL)` and wrapped in `COALESCE(..., 0)`.  Missing
 * `metrics_json` / `payload_json` fields produce NULL → 0 without
 * crashing the query.
 *
 * ## Ordering
 *
 * Per-bucket results are ordered by `(ts, event_id)` where relevant for
 * sequence-sensitive callers; the high-level aggregation queries use
 * GROUP BY so row order within a bucket is not preserved.
 *
 * @module context-projector
 */

import type { DatabaseSync } from "node:sqlite";

// ── Output shapes ────────────────────────────────────────────────────────

/** Per-strategy aggregate returned by the projector. */
export interface ContextStrategyBucket {
  /** The agent instance id extracted from event identity. */
  agentInstanceId: string;
  /** Derived strategy label (suffix after last `-` or workLoopId fallback). */
  strategy: string;
  /** Number of distinct completed executions (COUNT DISTINCT executionId from `agent.completed`). */
  executions: number;
  /** Number of `model.completed` events. */
  modelCalls: number;
  /** Sum of input tokens from `model.completed` metrics. */
  totalInputTokens: number;
  /** Sum of output tokens from `model.completed` metrics. */
  totalOutputTokens: number;
  /** Sum of cost from `model.completed` metrics where `source = "observed"`. */
  totalCostObserved: number;
  /** Sum of cost from `model.completed` metrics where `source = "derived"`. */
  totalCostDerived: number;
  /** Average duration (ms) of `model.completed` calls. */
  avgDurationMs: number;
  /** Count of `context.transformed` events keyed by transform kind. */
  transforms: Record<string, number>;
  /** Number of `context.summary.created` events. */
  summaryCalls: number;
  /** Sum of cost from `context.summary.created` metrics. */
  summaryCost: number;
}

/** Full output of the projection. */
export interface ContextProjection {
  /** Per-strategy aggregate buckets (ordered by agentInstanceId). */
  buckets: ContextStrategyBucket[];
  /** Count of relevant events with NULL, missing, or empty agentInstanceId. */
  unattributed: number;
}

/** Per-round projection buckets keyed by roundId. */
export interface RoundBuckets {
  [roundId: string]: ContextProjection;
}

// ── Options ──────────────────────────────────────────────────────────────

export interface ContextProjectorOptions {
  /**
   * Optional scheduler instance id filter.
   * When set, only events whose identity matches this scheduler instance
   * are included.
   */
  schedulerInstanceId?: string;
  /**
   * Optional optimization round id filter.
   * When set, only events whose identity.optimizationRoundId matches
   * are included (json_extract(identity_json,'$.optimizationRoundId') = ?).
   */
  roundId?: string;
  /**
   * Inclusive lower bound on event timestamp (ms).
   * When undefined, no lower bound.
   */
  since?: number;
  /**
   * Exclusive upper bound on event timestamp (ms).
   * When undefined, no upper bound.
   */
  until?: number;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Project context-strategy aggregates from lab_events.
 *
 * Runs four grouped aggregation queries over `model.completed`,
 * `agent.completed`, `context.transformed`, and `context.summary.created`
 * events, merges the results per `agentInstanceId`, and returns a
 * structured projection suitable for command rendering and future
 * optimizer consumption.
 *
 * Events with a NULL, missing, or empty `$.agentInstanceId` are excluded
 * from buckets and counted in the `unattributed` total.
 */
export function projectContextStrategies(
  db: DatabaseSync,
  opts: ContextProjectorOptions = {},
): ContextProjection {
  // ── Build shared window predicates ───────────────────────────────
  const { conditions: windowConds, params: windowParams } =
    buildWindowConditions(opts);

  // ── Query 1: model.completed aggregation per agent ───────────────
  const modelRows = queryRows<ModelRow>(db, {
    select: [
      "json_extract(identity_json, '$.agentInstanceId') as agentInstanceId",
      "MAX(json_extract(identity_json, '$.workLoopId')) as workLoopId",
      "COUNT(*) as modelCalls",
      "COALESCE(SUM(CAST(json_extract(metrics_json, '$.input') AS REAL)), 0) as totalInputTokens",
      "COALESCE(SUM(CAST(json_extract(metrics_json, '$.output') AS REAL)), 0) as totalOutputTokens",
      "COALESCE(SUM(CASE WHEN json_extract(metrics_json, '$.source') = 'observed' THEN CAST(json_extract(metrics_json, '$.cost') AS REAL) ELSE 0 END), 0) as totalCostObserved",
      "COALESCE(SUM(CASE WHEN json_extract(metrics_json, '$.source') = 'derived' THEN CAST(json_extract(metrics_json, '$.cost') AS REAL) ELSE 0 END), 0) as totalCostDerived",
      "COALESCE(AVG(CAST(json_extract(metrics_json, '$.durationMs') AS REAL)), 0) as avgDurationMs",
    ],
    from: "lab_events",
    extraWhere: [
      "event_type = 'model.completed'",
      "json_extract(identity_json, '$.agentInstanceId') IS NOT NULL",
      "json_extract(identity_json, '$.agentInstanceId') != ''",
    ],
    groupBy: "json_extract(identity_json, '$.agentInstanceId')",
    windowConds,
    windowParams,
  });

  // ── Query 2: agent.completed → executions per agent ─────────────
  const execRows = queryRows<ExecRow>(db, {
    select: [
      "json_extract(identity_json, '$.agentInstanceId') as agentInstanceId",
      "COUNT(DISTINCT json_extract(identity_json, '$.executionId')) as executions",
    ],
    from: "lab_events",
    extraWhere: [
      "event_type = 'agent.completed'",
      "json_extract(identity_json, '$.agentInstanceId') IS NOT NULL",
      "json_extract(identity_json, '$.agentInstanceId') != ''",
    ],
    groupBy: "json_extract(identity_json, '$.agentInstanceId')",
    windowConds,
    windowParams,
  });

  // ── Query 3: context.transformed counts by kind per agent ───────
  const transformRows = queryRows<TransformRow>(db, {
    select: [
      "json_extract(identity_json, '$.agentInstanceId') as agentInstanceId",
      "COALESCE(json_extract(payload_json, '$.kind'), 'unknown') as kind",
      "COUNT(*) as count",
    ],
    from: "lab_events",
    extraWhere: [
      "event_type = 'context.transformed'",
      "json_extract(identity_json, '$.agentInstanceId') IS NOT NULL",
      "json_extract(identity_json, '$.agentInstanceId') != ''",
    ],
    groupBy: "json_extract(identity_json, '$.agentInstanceId'), json_extract(payload_json, '$.kind')",
    windowConds,
    windowParams,
  });

  // ── Query 4: context.summary.created per agent ──────────────────
  const summaryRows = queryRows<SummaryRow>(db, {
    select: [
      "json_extract(identity_json, '$.agentInstanceId') as agentInstanceId",
      "COUNT(*) as summaryCalls",
      "COALESCE(SUM(CAST(json_extract(metrics_json, '$.cost') AS REAL)), 0) as summaryCost",
    ],
    from: "lab_events",
    extraWhere: [
      "event_type = 'context.summary.created'",
      "json_extract(identity_json, '$.agentInstanceId') IS NOT NULL",
      "json_extract(identity_json, '$.agentInstanceId') != ''",
    ],
    groupBy: "json_extract(identity_json, '$.agentInstanceId')",
    windowConds,
    windowParams,
  });

  // ── Query 5: unattributed count ─────────────────────────────────
  const unattributedResult = queryRows<{ unattributed: number }>(db, {
    select: ["COUNT(*) as unattributed"],
    from: "lab_events",
    extraWhere: [
      "event_type IN ('model.completed','agent.completed','context.transformed','context.summary.created')",
      "(json_extract(identity_json, '$.agentInstanceId') IS NULL OR json_extract(identity_json, '$.agentInstanceId') = '')",
    ],
    windowConds,
    windowParams,
  });

  const unattributed = unattributedResult[0]?.unattributed ?? 0;

  // ── Merge into per-agent buckets ────────────────────────────────
  const agentMap = new Map<string, ContextStrategyBucket>();

  // Seed from model rows (primary source for agent identity + workLoopId)
  for (const row of modelRows) {
    const strategy = deriveStrategy(row.agentInstanceId, row.workLoopId);
    agentMap.set(row.agentInstanceId, {
      agentInstanceId: row.agentInstanceId,
      strategy,
      executions: 0,
      modelCalls: row.modelCalls,
      totalInputTokens: row.totalInputTokens,
      totalOutputTokens: row.totalOutputTokens,
      totalCostObserved: row.totalCostObserved,
      totalCostDerived: row.totalCostDerived,
      avgDurationMs: row.avgDurationMs,
      transforms: {},
      summaryCalls: 0,
      summaryCost: 0,
    });
  }

  // Merge executions
  for (const row of execRows) {
    let bucket = agentMap.get(row.agentInstanceId);
    if (!bucket) {
      bucket = emptyBucket(row.agentInstanceId);
      agentMap.set(row.agentInstanceId, bucket);
    }
    bucket.executions = row.executions;
  }

  // Merge transforms
  for (const row of transformRows) {
    let bucket = agentMap.get(row.agentInstanceId);
    if (!bucket) {
      bucket = emptyBucket(row.agentInstanceId);
      agentMap.set(row.agentInstanceId, bucket);
    }
    bucket.transforms[row.kind] =
      (bucket.transforms[row.kind] ?? 0) + row.count;
  }

  // Merge summary
  for (const row of summaryRows) {
    let bucket = agentMap.get(row.agentInstanceId);
    if (!bucket) {
      bucket = emptyBucket(row.agentInstanceId);
      agentMap.set(row.agentInstanceId, bucket);
    }
    bucket.summaryCalls = row.summaryCalls;
    bucket.summaryCost = row.summaryCost;
  }

  // Sort buckets by agentInstanceId for deterministic output
  const buckets = [...agentMap.values()].sort((a, b) =>
    a.agentInstanceId.localeCompare(b.agentInstanceId),
  );

  return { buckets, unattributed };
}

// ── Internal helpers ─────────────────────────────────────────────────────

interface ModelRow {
  agentInstanceId: string;
  workLoopId: string | null;
  modelCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostObserved: number;
  totalCostDerived: number;
  avgDurationMs: number;
}

interface ExecRow {
  agentInstanceId: string;
  executions: number;
}

interface TransformRow {
  agentInstanceId: string;
  kind: string;
  count: number;
}

interface SummaryRow {
  agentInstanceId: string;
  summaryCalls: number;
  summaryCost: number;
}

interface QuerySpec {
  select: string[];
  from: string;
  extraWhere: string[];
  groupBy?: string;
  windowConds: string[];
  windowParams: unknown[];
}

function queryRows<T>(db: DatabaseSync, spec: QuerySpec): T[] {
  const allConds = [...spec.extraWhere, ...spec.windowConds];
  const where = allConds.length > 0 ? `WHERE ${allConds.join(" AND ")}` : "";
  const groupBy = spec.groupBy ? `GROUP BY ${spec.groupBy}` : "";
  const sql = `SELECT ${spec.select.join(", ")} FROM ${spec.from} ${where} ${groupBy}`;

  const stmt = db.prepare(sql);
  return stmt.all(...spec.windowParams) as T[];
}

function buildWindowConditions(opts: ContextProjectorOptions): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.schedulerInstanceId) {
    conditions.push("json_extract(identity_json, '$.schedulerInstanceId') = ?");
    params.push(opts.schedulerInstanceId);
  }
  if (opts.roundId) {
    conditions.push("json_extract(identity_json, '$.optimizationRoundId') = ?");
    params.push(opts.roundId);
  }
  if (opts.since != null) {
    conditions.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until != null) {
    conditions.push("ts < ?");
    params.push(opts.until);
  }

  return { conditions, params };
}

/**
 * Project context-strategy aggregates grouped by optimization round.
 *
 * Queries distinct `optimizationRoundId` values from lab_events matching
 * the supplied window conditions, then delegates to
 * `projectContextStrategies(opts)` for each round.  Returns a map from
 * roundId → ContextProjection.
 *
 * Rounds with a NULL or empty roundId are skipped.
 */
export function projectContextStrategiesByRound(
  db: DatabaseSync,
  opts: ContextProjectorOptions = {},
): RoundBuckets {
  const { conditions, params } = buildWindowConditions(opts);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT DISTINCT json_extract(identity_json, '$.optimizationRoundId') as roundId FROM lab_events ${where} ORDER BY roundId`;

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<{ roundId: string | null }>;

  const result: RoundBuckets = {};
  for (const row of rows) {
    if (row.roundId) {
      result[row.roundId] = projectContextStrategies(db, {
        ...opts,
        roundId: row.roundId,
      });
    }
  }
  return result;
}

/**
 * Derive a human-readable strategy label.
 *
 * Primary source: `workLoopId` from the event identity.  This is always
 * present and maps directly to the strategy (`budgeted-history`,
 * `selective-summary`).  The special case `pi-default-loop` is mapped
 * back to `"default"`.
 *
 * Fallback: suffix after the last `-` in `agentInstanceId` (works when
 * the strategy name contains no dashes, e.g. `agent-gpt4o-default`).
 *
 * Ultimate fallback: `"unknown"`.
 */
function deriveStrategy(
  agentInstanceId: string,
  workLoopId: string | null,
): string {
  // Primary: workLoopId (most reliable — always set on runner-emitted events)
  if (workLoopId) {
    if (workLoopId === "pi-default-loop") return "default";
    return workLoopId;
  }
  // Fallback: suffix after last `-` in agent instance id
  const lastDash = agentInstanceId.lastIndexOf("-");
  if (lastDash >= 0 && lastDash < agentInstanceId.length - 1) {
    return agentInstanceId.slice(lastDash + 1);
  }
  return "unknown";
}

function emptyBucket(agentInstanceId: string): ContextStrategyBucket {
  return {
    agentInstanceId,
    strategy: deriveStrategy(agentInstanceId, null),
    executions: 0,
    modelCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostObserved: 0,
    totalCostDerived: 0,
    avgDurationMs: 0,
    transforms: {},
    summaryCalls: 0,
    summaryCost: 0,
  };
}
