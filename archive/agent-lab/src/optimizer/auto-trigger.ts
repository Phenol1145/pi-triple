/**
 * Auto-trigger for optimizer.run — throttled fire-and-forget hook.
 *
 * Phase 5b T7 (§2).  Designed to sit behind a `tool_execution_end` telemetry
 * callback.  All state is in-memory — restart clears throttle (documented
 * limitation).  Never throws, never blocks the caller.
 */

import type { OptimizerConfig } from "../types.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface AutoTriggerDeps {
  /** Auto-trigger subsection of OptimizerConfig; undefined → disabled. */
  config: OptimizerConfig["autoTrigger"];
  /** The async run function to fire (typically `optimizerFacade.run`). */
  run: (instanceId: string) => Promise<unknown>;
  /** Injectable clock (default: `Date.now`). */
  now?: () => number;
}

export interface AutoTrigger {
  /**
   * Called after each run is recorded.  Increments the run counter and
   * checks throttle thresholds.  Fires `run(instanceId)` without awaiting
   * when either threshold is reached, then resets the counter and stamps
   * the last-fire timestamp.
   *
   * This method NEVER throws, NEVER blocks — it is safe to call from
   * performance-sensitive telemetry handlers.
   */
  maybeTrigger(instanceId: string): void;

  /** Returns a snapshot of in-memory throttle state (for /lab optimizer auto). */
  status(): AutoTriggerStatus;
}

export interface AutoTriggerStatus {
  /** Runs recorded since last fire (or since startup). */
  runsSinceLast: number;
  /** Timestamp (ms) of last fire, or null if never fired. */
  lastFiredAt: number | null;
  /** Total number of fires since startup. */
  fires: number;
}

// ── Implementation ───────────────────────────────────────────────────────

/**
 * Create an auto-trigger instance.
 *
 * Throttle state is purely in-memory — restart clears it (documented
 * limitation, acceptable per L5).
 *
 * Fire discipline:
 * - If `everyNRuns` is set: fires after every N calls to `maybeTrigger`
 *   (the Nth call triggers the fire, then the counter resets).
 * - If `everyTMs` is set: fires when at least that many ms have elapsed
 *   since the last fire.
 * - If both are set: fires when EITHER threshold is reached (OR).
 * - First fire via time-only requires a prior fire to establish a baseline
 *   (`lastFiredAt` starts null).
 */
export function createAutoTrigger(deps: AutoTriggerDeps): AutoTrigger {
  const { config, run, now = () => Date.now() } = deps;

  // ── Throttle state (in-memory, restart clears) ─────────────────────
  let runsSinceLast = 0;
  let lastFiredAt: number | null = null;
  let fires = 0;

  return {
    maybeTrigger(instanceId: string) {
      // fail-open — never throw, never block
      try {
        if (!config?.enabled) return;

        runsSinceLast++;

        const byCount =
          config.everyNRuns !== undefined &&
          config.everyNRuns > 0 &&
          runsSinceLast >= config.everyNRuns;

        const byTime =
          config.everyTMs !== undefined &&
          config.everyTMs > 0 &&
          lastFiredAt !== null &&
          now() - lastFiredAt >= config.everyTMs;

        if (!byCount && !byTime) return;

        // Fire — reset counter, stamp timestamp
        runsSinceLast = 0;
        lastFiredAt = now();
        fires++;

        // fire-and-forget: don't await, swallow rejections
        run(instanceId).catch(() => {});
      } catch {
        // fail-open: swallow synchronous errors too
      }
    },

    status(): AutoTriggerStatus {
      return { runsSinceLast, lastFiredAt, fires };
    },
  };
}
