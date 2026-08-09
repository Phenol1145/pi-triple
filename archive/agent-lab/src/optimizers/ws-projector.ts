/**
 * Metrics projector for the "weighted-scorer" scheduler definition.
 *
 * Queries the legacy `runs` table with a time window to compute per-model
 * aggregates.  This is a time-overlap approximation — runs within the window
 * are attributed to whichever round was active when the run was recorded,
 * which may differ from the round that dispatched the run.
 *
 * ## Time-overlap approximation (P7 migration note)
 *
 * The `runs` table has no `roundId` column, so we cannot attribute runs to
 * a specific optimization round.  Instead we filter by `ts` (run timestamp)
 * and rely on the caller to provide a window that roughly aligns with the
 * round's active period (`[round.createdAt, now]`).
 *
 * When two rounds overlap in time (e.g. a promotion happened mid-window),
 * runs are counted toward both windows, which may inflate sample counts.
 * This is an acceptable approximation for the reference tuner; a proper
 * round-attribution column (`round_id` on runs) is deferred to P7.
 *
 * ## Schema
 *
 * The projector reads directly from the `runs` table (see `src/store/schema.ts`):
 *
 *   runs(id, ts, role, model, task_category, acceptance, completion,
 *        tokens_in, tokens_out, cost, tool_success, turns, interrupted,
 *        signals, source)
 *
 * It **never** modifies SqliteStore — it only issues SELECT queries using
 * the shared `db` handle.
 */

import type { DatabaseSync } from "node:sqlite";
import { registerMetricsProjector } from "../optimizer/registry.ts";

// ── Aggregate shape ─────────────────────────────────────────────────────────

/** Per-model aggregate returned by the windowed SQL query. */
export interface ModelAggregate {
  model: string;
  runs: number;
  avgCompletion: number;
  avgCost: number;
  successRate: number;
}

// ── Projector ───────────────────────────────────────────────────────────────

/**
 * Windowed-SQL projector for the "weighted-scorer" scheduler.
 *
 * When `opts.role` is provided, the query filters by role:
 *   SELECT model, COUNT(*) runs, AVG(completion) avgCompletion,
 *          AVG(cost) avgCost, AVG(tool_success) successRate
 *   FROM runs
 *   WHERE role=? AND ts>=? AND ts<?
 *   GROUP BY model
 *
 * When `opts.role` is undefined, the role predicate is dropped so the
 * projector aggregates ALL roles served by this scheduler instance:
 *   SELECT model, COUNT(*) runs, AVG(completion) avgCompletion,
 *          AVG(cost) avgCost, AVG(tool_success) successRate
 *   FROM runs
 *   WHERE ts>=? AND ts<?
 *   GROUP BY model
 */
function wsProjector(
  db: DatabaseSync,
  window: { since: number; until: number },
  opts: { schedulerInstanceId: string; role?: string },
): ModelAggregate[] {
  const sql =
    opts.role !== undefined
      ? `SELECT model, COUNT(*) as runs, AVG(completion) as avgCompletion,
            AVG(cost) as avgCost, AVG(tool_success) as successRate
     FROM runs
     WHERE role = ? AND ts >= ? AND ts < ?
     GROUP BY model`
      : `SELECT model, COUNT(*) as runs, AVG(completion) as avgCompletion,
            AVG(cost) as avgCost, AVG(tool_success) as successRate
     FROM runs
     WHERE ts >= ? AND ts < ?
     GROUP BY model`;

  const stmt = db.prepare(sql);

  const rows =
    opts.role !== undefined
      ? (stmt.all(opts.role, window.since, window.until) as ModelAggregate[])
      : (stmt.all(window.since, window.until) as ModelAggregate[]);

  return rows;
}

// ── Registration ────────────────────────────────────────────────────────────

registerMetricsProjector("weighted-scorer", wsProjector);
