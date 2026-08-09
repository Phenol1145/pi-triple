import type { NamespacedStore, VersionedValue } from "../core/storage/namespaced-store.ts";
import { VersionConflictError } from "../core/storage/namespaced-store.ts";
import type { WorkContext } from "./contracts.ts";
import type { AgentRuntimeSnapshot } from "./checkpoints.ts";

function namespace(agentId: string): string {
  return `agent:${agentId}`;
}

const RUNTIME_KEY = "runtime";

/**
 * Manages a single CAS (content-addressable storage) snapshot per agent,
 * holding the combined WorkContext + state + optional lastCheckpointId.
 *
 * Uses P1 NamespacedStore for versioned optimistic concurrency.
 */
export class AgentRuntimeStateStore {
  private readonly store: NamespacedStore;

  constructor(store: NamespacedStore) {
    this.store = store;
  }

  /**
   * Create the initial version-1 snapshot for an agent.
   * Throws VersionConflictError if the agent already has a runtime snapshot.
   */
  initialize(
    agentId: string,
    context: WorkContext,
    state: unknown,
    lastCheckpointId?: string,
  ): VersionedValue<AgentRuntimeSnapshot> {
    const snapshot: AgentRuntimeSnapshot = {
      context: structuredClone(context),
      state: structuredClone(state),
      lastCheckpointId,
    };
    return this.store.put<AgentRuntimeSnapshot>(namespace(agentId), RUNTIME_KEY, snapshot, 0);
  }

  /**
   * Read the current snapshot. Returns undefined if no snapshot exists.
   * Returns a defensive copy to prevent caller mutation of cached internals.
   */
  get(agentId: string): VersionedValue<AgentRuntimeSnapshot> | undefined {
    const entry = this.store.get<AgentRuntimeSnapshot>(namespace(agentId), RUNTIME_KEY);
    if (!entry) return undefined;
    return {
      value: structuredClone(entry.value),
      version: entry.version,
    };
  }

  /**
   * Update the snapshot with a new context/state pair.
   * `expectedVersion` must match the current stored version (optimistic locking).
   * Throws VersionConflictError on mismatch, leaving the old snapshot intact.
   */
  commit(
    agentId: string,
    context: WorkContext,
    state: unknown,
    expectedVersion: number,
    lastCheckpointId?: string,
  ): VersionedValue<AgentRuntimeSnapshot> {
    const snapshot: AgentRuntimeSnapshot = {
      context: structuredClone(context),
      state: structuredClone(state),
      lastCheckpointId,
    };
    return this.store.put<AgentRuntimeSnapshot>(
      namespace(agentId),
      RUNTIME_KEY,
      snapshot,
      expectedVersion,
    );
  }
}
