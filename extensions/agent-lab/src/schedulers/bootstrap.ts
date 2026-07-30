import type { LabCore } from "../core/create-core.ts";
import type { SchedulerRegistry } from "../scheduler/registry.ts";
import type { ModelInfo } from "../types.ts";
import type { WeightedScorerPorts } from "./weighted-scorer.ts";
import type { ArenaSchedulerPorts } from "./arena-scheduler.ts";
import type { FallbackTarget } from "../core/contracts.ts";
import {
  weightedScorerDefinition,
  createWeightedScorer,
  modelToAgentCreateSpec,
  type WeightedScorerParameters,
} from "./weighted-scorer.ts";
import { ARENA_DEFINITION, ARENA_DEFAULT_PARAMETERS } from "./arena-definition.ts";
import { createArenaSchedulerImplementation } from "./arena-scheduler.ts";
import { findOrCreateAgentByModel } from "../arena/agent-id.ts";
import { randomUUID } from "node:crypto";
import { DEFAULT_WEIGHTED_SCORER_INSTANCE_ID, DEFAULT_MARKET_INSTANCE_ID } from "./names.ts";

// ── Public types ──────────────────────────────────────────────────────

export interface BootstrapResult {
  instanceId: string;
  roundId: string;
  agentCount: number;
}

// ── ensureWeightedScorerInstance ──────────────────────────────────────

/**
 * Ensure a weighted-scorer scheduler instance exists, creating one if needed.
 *
 * - Registers the weighted-scorer definition in core.definitions.
 * - Registers the weighted-scorer implementation in schedulers.
 * - Creates a draft seeded from ports.candidates() as agent instances.
 * - Validates and activates the draft through the control plane.
 * - Idempotent: returns the existing instance on subsequent calls.
 *
 * The caller MUST pre-register the `pi-default-loop@1.0.0` WorkLoopDefinition
 * in `core.definitions` before calling this function, otherwise validation
 * will fail because the agent workloop references won't resolve.
 */
export async function ensureWeightedScorerInstance(
  core: LabCore,
  schedulers: SchedulerRegistry,
  ports: WeightedScorerPorts,
  opts?: { instanceId?: string },
): Promise<BootstrapResult> {
  const instanceId = opts?.instanceId ?? DEFAULT_WEIGHTED_SCORER_INSTANCE_ID;

  // Guard: reject dispatch-target ids passed as bootstrap ids (see ADR / 1e4eb56)
  if (opts?.instanceId && opts.instanceId === DEFAULT_MARKET_INSTANCE_ID) {
    throw new Error(
      `ensureWeightedScorerInstance: instanceId "${opts.instanceId}" collides with the market scheduler's canonical instance id — cfg.scheduler.instanceId is a dispatch target, not a bootstrap id`,
    );
  }

  // 0. Register definition + implementation FIRST (idempotent). Must run even
  // when the instance already exists: the in-memory SchedulerRegistry is rebuilt
  // every boot, so the implementation must be re-registered regardless of DB
  // state. (Fixes re-boot bug: the idempotency early-return below previously
  // skipped registration, leaving the fresh registry without the implementation
  // → "implementation not found" on the second boot.)
  try {
    core.definitions.register(weightedScorerDefinition);
  } catch (err) {
    // Already registered — ignore
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }
  try {
    const { implementation } = createWeightedScorer(ports);
    schedulers.register(implementation);
  } catch (err) {
    // Already registered — ignore
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }

  // 1. Idempotency check: if instance already exists and is active, return it
  const existing = core.repository.getInstance(instanceId);
  if (existing && existing.status === "active") {
    const agents = core.repository.listAgents(instanceId);
    return {
      instanceId,
      roundId: existing.currentRoundId,
      agentCount: agents.length,
    };
  }

  // 1b. Stale-draft recovery: a previous bootstrap that crashed between
  // createDraft and activateDraft leaves a 'draft'-status row that would
  // make createDraft throw "draft already exists". Drafts are disposable
  // pre-activation state (activation is transactional), so discard and
  // recreate fresh.
  if (!existing || existing.status !== "active") {
    const staleDraft = core.repository.getDraft(instanceId);
    if (staleDraft) {
      core.repository.deleteDraft(instanceId);
    }
  }

  // 4. Build agent specs from candidates
  const candidates = ports.candidates();
  const agents = candidates.map((m) => modelToAgentCreateSpec(m));

  // 5. Default parameters
  const defaultParams = weightedScorerDefinition.defaultParameters as WeightedScorerParameters;

  // 6–7. Create draft → validate → activate.
  // Concurrent safety (C2): activateDraft uses repository.transaction()
  // (BEGIN IMMEDIATE) internally. If two processes race past the
  // getInstance check, the loser hits a UNIQUE constraint on saveDraft
  // and we re-check idempotently.
  try {
    core.controlPlane.createDraft({
      id: instanceId,
      schedulerDefinition: {
        kind: "scheduler",
        id: weightedScorerDefinition.id,
        version: weightedScorerDefinition.version,
      },
      initialParameters: defaultParams,
      agents,
      fallbackChain: [{ type: "original-request" }],
      routingBindings: [
        { id: "default", priority: 0, match: {} },
      ],
      metadata: {},
    });

    const validation = core.controlPlane.validateDraft(instanceId);
    if (!validation.ok) {
      const issueList = validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new Error(`draft validation failed: ${issueList}`);
    }

    const { roundId } = core.controlPlane.activateDraft(instanceId);
    const finalAgents = core.repository.listAgents(instanceId);

    return { instanceId, roundId, agentCount: finalAgents.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint") || msg.includes("already exists")) {
      const winner = core.repository.getInstance(instanceId);
      if (winner && winner.status === "active") {
        const winnerAgents = core.repository.listAgents(instanceId);
        return { instanceId, roundId: winner.currentRoundId, agentCount: winnerAgents.length };
      }
    }
    throw err;
  }
}

// ── syncWeightedScorerAgents ──────────────────────────────────────────

/**
 * Sync agent population: create agent instances for any model candidates
 * not already in the instance's agent list. Never deactivates existing
 * agents and never creates duplicates.
 *
 * @returns the number of newly created agents.
 */
export function syncWeightedScorerAgents(
  core: LabCore,
  instanceId: string,
  candidates: ModelInfo[],
): number {
  const before = core.repository.listAgents(instanceId).length;

  for (const model of candidates) {
    findOrCreateAgentByModel(core, instanceId, model, process.env.PI_TEMPLATE);
  }

  const after = core.repository.listAgents(instanceId).length;
  return after - before;
}

// ── ensureArenaInstance ───────────────────────────────────────────────

export interface ArenaBootstrapOpts {
  instanceId?: string;
  wsInstanceId?: string;
  routingBindings?: Array<{
    id: string;
    priority: number;
    match: { role?: string; taskCategory?: string; labels?: Record<string, string>; caller?: string };
  }>;
}

/**
 * Ensure an arena scheduler instance exists, creating one if needed.
 *
 * - Registers the arena definition in core.definitions.
 * - Registers the arena implementation in schedulers.
 * - Creates a draft seeded from ports.candidates() as agent instances.
 * - Validates and activates the draft through the control plane.
 * - Idempotent: returns the existing instance on subsequent calls.
 *
 * The caller MUST pre-register the `pi-default-loop@1.0.0` WorkLoopDefinition
 * in `core.definitions` before calling this function, and the weighted-scorer
 * instance referenced by `wsInstanceId` must already be active (fallback chain
 * validation requires it).
 */
export async function ensureArenaInstance(
  core: LabCore,
  schedulers: SchedulerRegistry,
  ports: ArenaSchedulerPorts,
  opts?: ArenaBootstrapOpts,
): Promise<BootstrapResult> {
  const instanceId = opts?.instanceId ?? DEFAULT_MARKET_INSTANCE_ID;

  // Guard: reject dispatch-target ids passed as bootstrap ids (see ADR / 1e4eb56)
  if (opts?.instanceId && opts.instanceId === DEFAULT_WEIGHTED_SCORER_INSTANCE_ID) {
    throw new Error(
      `ensureArenaInstance: instanceId "${opts.instanceId}" collides with the weighted-scorer scheduler's canonical instance id — cfg.scheduler.instanceId is a dispatch target, not a bootstrap id`,
    );
  }

  // 0. Register definition + implementation FIRST (idempotent). Must run even
  // when the instance already exists: the in-memory SchedulerRegistry is rebuilt
  // every boot, so the implementation must be re-registered regardless of DB
  // state. (Fixes re-boot bug: the idempotency early-return below previously
  // skipped registration → "implementation not found: arena@1.0.0" on re-boot.)
  try {
    core.definitions.register(ARENA_DEFINITION);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }
  try {
    const implementation = createArenaSchedulerImplementation(ports);
    schedulers.register(implementation);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already registered")) throw err;
  }

  // 1. Idempotency check: if instance already exists and is active, return it
  const existing = core.repository.getInstance(instanceId);
  if (existing && existing.status === "active") {
    const agents = core.repository.listAgents(instanceId);
    return {
      instanceId,
      roundId: existing.currentRoundId,
      agentCount: agents.length,
    };
  }

  // 1b. Stale-draft recovery: a previous bootstrap that crashed between
  // createDraft and activateDraft leaves a 'draft'-status row that would
  // make createDraft throw "draft already exists". Drafts are disposable
  // pre-activation state (activation is transactional), so discard and
  // recreate fresh.
  if (!existing || existing.status !== "active") {
    const staleDraft = core.repository.getDraft(instanceId);
    if (staleDraft) {
      core.repository.deleteDraft(instanceId);
    }
  }

  // 4. Build agent specs from candidates
  const candidates = ports.candidates();
  const agents = candidates.map((m) => modelToAgentCreateSpec(m, "arena"));

  // 5. Default parameters
  const defaultParams = structuredClone(ARENA_DEFAULT_PARAMETERS);

  // 6. Build fallback chain
  const fallbackChain: FallbackTarget[] = [];
  if (opts?.wsInstanceId) {
    fallbackChain.push({ type: "scheduler-instance", id: opts.wsInstanceId });
  }
  fallbackChain.push({ type: "original-request" });

  // 7. Routing bindings (default: none; caller provides market-mode bindings)
  const routingBindings = opts?.routingBindings ?? [];

  // 8–9. Create draft → validate → activate.
  // Concurrent safety (C2): activateDraft uses repository.transaction()
  // (BEGIN IMMEDIATE) internally. UNIQUE catch for race losers.
  try {
    core.controlPlane.createDraft({
      id: instanceId,
      schedulerDefinition: {
        kind: "scheduler",
        id: ARENA_DEFINITION.id,
        version: ARENA_DEFINITION.version,
      },
      initialParameters: defaultParams,
      agents,
      fallbackChain,
      routingBindings,
      metadata: {},
    });

    const validation = core.controlPlane.validateDraft(instanceId);
    if (!validation.ok) {
      const issueList = validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new Error(`arena draft validation failed: ${issueList}`);
    }

    const { roundId } = core.controlPlane.activateDraft(instanceId);
    const finalAgents = core.repository.listAgents(instanceId);

    return { instanceId, roundId, agentCount: finalAgents.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint") || msg.includes("already exists")) {
      const winner = core.repository.getInstance(instanceId);
      if (winner && winner.status === "active") {
        const winnerAgents = core.repository.listAgents(instanceId);
        return { instanceId, roundId: winner.currentRoundId, agentCount: winnerAgents.length };
      }
    }
    throw err;
  }
}

// ── syncArenaAgents ───────────────────────────────────────────────────

/**
 * Sync arena agent population: create agent instances for any model
 * candidates not already in the instance's agent list. Never deactivates
 * existing agents and never creates duplicates.
 *
 * Uses the same agent spec pattern as weighted-scorer (pi-default-loop
 * workloop) via modelToAgentCreateSpec.
 *
 * @returns the number of newly created agents.
 */
export function syncArenaAgents(
  core: LabCore,
  instanceId: string,
  candidates: ModelInfo[],
): number {
  const before = core.repository.listAgents(instanceId).length;

  for (const model of candidates) {
    findOrCreateAgentByModel(core, instanceId, model, process.env.PI_TEMPLATE);
  }

  const after = core.repository.listAgents(instanceId).length;
  return after - before;
}

// ── derived→UUID migration ───────────────────────────────────────────

/**
 * Migrate lab_agent_instances rows with old derived-format ids
 * (agent-arena-* / agent-*) to UUIDs, populating the model column.
 * Extracts model from definition_json, generates a UUID, and updates.
 * Idempotent: rows that already have a UUID id are skipped.
 *
 * @returns the number of rows migrated.
 */
export function migrateDerivedAgentIds(core: LabCore, schedulerInstanceId: string, rawDb: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }): number {
  const rows = core.repository.listAgents(schedulerInstanceId);
  const derived = rows.filter((a) => a.id.startsWith("agent-") && !a.model);

  if (derived.length === 0) return 0;

  let migrated = 0;
  for (const agent of derived) {
    const def = agent.definition as { standard?: { name?: string } };
    const modelId = def.standard?.name ?? "";
    if (!modelId) continue;

    const newId = randomUUID();
    // Insert with UUID + model, then delete old derived-id row.
    try {
      core.repository.insertAgent({
        id: newId,
        schedulerInstanceId: agent.schedulerInstanceId,
        definition: agent.definition,
        model: modelId,
        sourceTemplateId: agent.sourceTemplateId,
        sourceAgentId: agent.sourceAgentId,
        cloneOperationId: agent.cloneOperationId,
        createdAtRoundId: agent.createdAtRoundId,
        status: agent.status,
        createdAt: agent.createdAt,
      });
      // Remove old derived-id row
      rawDb.prepare("DELETE FROM lab_agent_instances WHERE id = ?").run(agent.id);
      migrated++;
    } catch {
      // UNIQUE constraint: another migration path already handled this model
    }
  }

  return migrated;
}
