import type { DatabaseSync } from "node:sqlite";
import type { LabEvent, OptimizationRoundRecord } from "../core/contracts.ts";
import type { CoreRepository } from "../core/storage/repository.ts";
import type { EventLog } from "../core/events/event-log.ts";
import type { OptimizationDataAPI } from "./contracts.ts";
import { getProjector, ProjectorNotRegisteredError } from "./registry.ts";

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a DataAPI method is called with a scheduler instance id
 * not in the optimizer instance's `targetSchedulers`.
 *
 * An `optimizer.access.denied` event is also emitted.
 */
export class DataAccessDeniedError extends Error {
  readonly schedulerInstanceId: string;
  readonly method: string;

  constructor(schedulerInstanceId: string, method: string) {
    super(
      `access denied: scheduler instance "${schedulerInstanceId}" is not in the optimizer's targetSchedulers (method: ${method})`,
    );
    this.name = "DataAccessDeniedError";
    this.schedulerInstanceId = schedulerInstanceId;
    this.method = method;
  }
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Read-only data facade authorized against a specific set of scheduler instances.
 *
 * Every method checks that `schedulerInstanceId` is in the authorized set
 * before delegating to the repository, event log, or projector.
 */
export class DataAPIImpl implements OptimizationDataAPI {
  private readonly db: DatabaseSync;
  private readonly repository: CoreRepository;
  private readonly events: EventLog;
  private readonly authorizedIds: ReadonlySet<string>;
  private readonly optimizerInstanceId: string;

  constructor(
    db: DatabaseSync,
    repository: CoreRepository,
    events: EventLog,
    authorizedSchedulerIds: string[],
    optimizerInstanceId: string,
  ) {
    this.db = db;
    this.repository = repository;
    this.events = events;
    this.authorizedIds = new Set(authorizedSchedulerIds);
    this.optimizerInstanceId = optimizerInstanceId;
  }

  // ── Authorization helper ────────────────────────────────────────────────

  private checkAccess(schedulerInstanceId: string, method: string): void {
    if (!this.authorizedIds.has(schedulerInstanceId)) {
      // Emit denial event (fire-and-forget; don't let event failure mask the error)
      try {
        this.events.append({
          eventId: `optimizer.access.denied:${this.optimizerInstanceId}:${schedulerInstanceId}:${Date.now()}`,
          eventType: "optimizer.access.denied",
          schemaVersion: "1",
          timestamp: Date.now(),
          identity: {
            traceId: `data-api:${this.optimizerInstanceId}`,
            optimizerInstanceId: this.optimizerInstanceId,
            schedulerInstanceId,
          },
          payload: {
            optimizerInstanceId: this.optimizerInstanceId,
            schedulerInstanceId,
            method,
          },
        });
      } catch {
        // best-effort event emission
      }
      throw new DataAccessDeniedError(schedulerInstanceId, method);
    }
  }

  // ── Public methods ──────────────────────────────────────────────────────

  getCurrentRound(schedulerInstanceId: string): OptimizationRoundRecord | undefined {
    this.checkAccess(schedulerInstanceId, "getCurrentRound");
    const instance = this.repository.getInstance(schedulerInstanceId);
    if (!instance) return undefined;
    return this.repository.getRound(instance.currentRoundId);
  }

  listRounds(
    schedulerInstanceId: string,
    limit?: number,
  ): OptimizationRoundRecord[] {
    this.checkAccess(schedulerInstanceId, "listRounds");
    return this.repository.listRounds(schedulerInstanceId, limit);
  }

  listEvents(filter: {
    schedulerInstanceId: string;
    types?: string[];
    since?: number;
    until?: number;
    limit?: number;
  }): LabEvent[] {
    this.checkAccess(filter.schedulerInstanceId, "listEvents");

    // Delegate to EventLog.query, which already supports schedulerInstanceId / since / until / limit.
    // If types[] is provided, post-filter client-side.
    const events = this.events.query({
      schedulerInstanceId: filter.schedulerInstanceId,
      since: filter.since,
      until: filter.until,
      limit: filter.limit,
    });

    if (filter.types && filter.types.length > 0) {
      const typeSet = new Set(filter.types);
      return events.filter((e) => typeSet.has(e.eventType));
    }

    return events;
  }

  getCandidateAggregates(
    schedulerInstanceId: string,
    window: { since: number; until: number },
    role?: string,
  ): unknown {
    this.checkAccess(schedulerInstanceId, "getCandidateAggregates");

    const instance = this.repository.getInstance(schedulerInstanceId);
    if (!instance) {
      throw new ProjectorNotRegisteredError(
        `scheduler instance "${schedulerInstanceId}" not found`,
      );
    }

    const schedulerDefinitionId = instance.definition.id;
    const projector = getProjector(schedulerDefinitionId);
    if (!projector) {
      throw new ProjectorNotRegisteredError(schedulerDefinitionId);
    }

    return projector(this.db, window, {
      schedulerInstanceId,
      role,
    });
  }
}
