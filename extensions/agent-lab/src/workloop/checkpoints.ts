import type { NamespacedStore } from "../core/storage/namespaced-store.ts";
import type { WorkContext, WorkLoopImplementation } from "./contracts.ts";
import type { AgentRuntimeStateStore } from "./state-store.ts";

// ── Errors ───────────────────────────────────────────────────────────

export class CheckpointNotFoundError extends Error {
  constructor(checkpointId: string) {
    super(`checkpoint not found: ${checkpointId}`);
    this.name = "CheckpointNotFoundError";
  }
}

export class CloneModeNotSupportedError extends Error {
  constructor(workLoopId: string, mode: string, supported: string[]) {
    super(
      `clone mode "${mode}" not supported by workloop "${workLoopId}" (supported: ${supported.join(", ")})`,
    );
    this.name = "CloneModeNotSupportedError";
  }
}

export class SourceCheckpointNotFoundError extends Error {
  constructor(checkpointId: string, agentInstanceId: string) {
    super(`source checkpoint not found: ${checkpointId} (agent: ${agentInstanceId})`);
    this.name = "SourceCheckpointNotFoundError";
  }
}

// ── Data types ───────────────────────────────────────────────────────

export interface AgentRuntimeSnapshot {
  context: WorkContext;
  state: unknown;
  lastCheckpointId?: string;
}

export interface CheckpointRecord {
  checkpointId: string;
  agentInstanceId: string;
  executionId: string;
  workLoopId: string;
  workLoopVersion: string;
  optimizationRoundId: string;
  parentCheckpointId?: string;
  label?: string;
  /** 控制状态（MachineRuntime 自动 checkpoint 写入；resume 经 resumeStateOf 重建） */
  controlState?: string;
  /** 转移序号（MachineRuntime 自动 checkpoint 写入；resume 经 resumeStateOf 重建） */
  seq?: number;
  context: WorkContext;
  state: unknown;
  createdAt: number;
}

// ── Storage helpers ──────────────────────────────────────────────────

function checkpointNamespace(agentId: string): string {
  return `agent:${agentId}`;
}

function checkpointKey(checkpointId: string): string {
  return `checkpoint:${checkpointId}`;
}

// ── CheckpointStore ──────────────────────────────────────────────────

/**
 * Immutable checkpoint persistence.
 *
 * Checkpoints are stored as key-value pairs under agent-scoped namespaces.
 * Both save and get use structuredClone so that caller mutations cannot
 * affect stored data, and vice versa.
 */
export class CheckpointStore {
  private readonly store: NamespacedStore;

  constructor(store: NamespacedStore) {
    this.store = store;
  }

  /**
   * Persist an immutable checkpoint snapshot.
   * The checkpoint data is defensively cloned before storage.
   * Version 0 is used because checkpoints are write-once (never updated).
   *
   * Sets parentCheckpointId from the agent's most recent prior checkpoint (if any)
   * by tracking the latest checkpoint via a well-known "latest" pointer.
   */
  save(agentId: string, record: CheckpointRecord): void {
    // Defensive clone before mutation so we never mutate the caller's
    // record reference.
    const cloned = structuredClone(record);

    // Find the most recent prior checkpoint for this agent
    const latest = this.store.get<{ checkpointId: string }>(
      checkpointNamespace(agentId),
      "latest",
    );
    if (latest && !cloned.parentCheckpointId) {
      cloned.parentCheckpointId = latest.value.checkpointId;
    }

    const frozen = structuredClone(cloned);
    this.store.put<CheckpointRecord>(
      checkpointNamespace(agentId),
      checkpointKey(cloned.checkpointId),
      frozen,
      0, // write-once
    );

    // Update the latest pointer (CAS: version 0 for first, or expected for subsequent)
    this.store.put<{ checkpointId: string }>(
      checkpointNamespace(agentId),
      "latest",
      { checkpointId: cloned.checkpointId },
      latest ? latest.version : 0,
    );
  }

  /**
   * Retrieve a checkpoint by id. Returns a defensive copy so the caller
   * cannot mutate the stored version.
   */
  get(agentId: string, checkpointId: string): CheckpointRecord {
    const entry = this.store.get<CheckpointRecord>(
      checkpointNamespace(agentId),
      checkpointKey(checkpointId),
    );
    if (!entry) {
      throw new CheckpointNotFoundError(checkpointId);
    }
    return structuredClone(entry.value);
  }

  /**
   * Retrieve the most recent checkpoint for an agent via the "latest"
   * pointer (the same pointer save() maintains with CAS). Returns a
   * defensive copy; undefined when the agent has no checkpoint yet.
   * Read-only — the pointer's CAS write path is unchanged.
   */
  latest(agentId: string): CheckpointRecord | undefined {
    const pointer = this.store.get<{ checkpointId: string }>(
      checkpointNamespace(agentId),
      "latest",
    );
    if (!pointer) return undefined;
    const entry = this.store.get<CheckpointRecord>(
      checkpointNamespace(agentId),
      checkpointKey(pointer.value.checkpointId),
    );
    return entry ? structuredClone(entry.value) : undefined;
  }
}

// ── AgentCloneService ────────────────────────────────────────────────

/**
 * Creates new agent runtime snapshots via fresh initialization or fork
 * from an existing agent's checkpoint.
 *
 * Clone operations only create runtime snapshots. They do NOT create
 * P1 AgentInstance records — ownership and lineage persistence remain
 * Scheduler responsibilities (P3). Fork never copies active locks or
 * execution state.
 */
export class AgentCloneService {
  private readonly stateStore: AgentRuntimeStateStore;
  private readonly checkpointStore: CheckpointStore;

  constructor(stateStore: AgentRuntimeStateStore, checkpointStore: CheckpointStore) {
    this.stateStore = stateStore;
    this.checkpointStore = checkpointStore;
  }

  /**
   * Initialize a brand-new agent from the workloop implementation's
   * initialContext and initialState functions. No source agent or
   * checkpoint is involved.
   */
  fresh(
    targetAgentId: string,
    implementation: WorkLoopImplementation,
    config: unknown,
  ): void {
    const context = implementation.initialContext(config);
    const state = implementation.initialState(config);
    this.stateStore.initialize(targetAgentId, context, state);
  }

  /**
   * Fork a new agent from a source agent's checkpoint.
   *
   * Requirements:
   * - implementation.cloneModes must include "fork"
   * - source checkpoint must exist
   * - if implementation.forkState is provided, it transforms the
   *   checkpoint state before initializing the target
   *
   * The target agent's runtime snapshot is initialized with the
   * checkpoint context and (possibly transformed) state.
   */
  fork(
    targetAgentId: string,
    implementation: WorkLoopImplementation,
    sourceAgentId: string,
    checkpointId: string,
  ): void {
    if (!implementation.cloneModes.includes("fork")) {
      throw new CloneModeNotSupportedError(
        implementation.id,
        "fork",
        implementation.cloneModes,
      );
    }

    let record: CheckpointRecord;
    try {
      record = this.checkpointStore.get(sourceAgentId, checkpointId);
    } catch (err) {
      if (err instanceof CheckpointNotFoundError) {
        throw new SourceCheckpointNotFoundError(checkpointId, sourceAgentId);
      }
      throw err;
    }

    // Transform state if forkState is provided
    const state = implementation.forkState
      ? implementation.forkState(record.state)
      : record.state;

    // Initialize the target agent with the checkpoint context + state
    this.stateStore.initialize(targetAgentId, record.context, state, checkpointId);
  }
}
