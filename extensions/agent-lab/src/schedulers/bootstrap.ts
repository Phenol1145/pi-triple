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

// ── Public types ──────────────────────────────────────────────────────

export interface BootstrapResult {
  instanceId: string;
  roundId: string;
  agentCount: number;
}

const DEFAULT_INSTANCE_ID = "default-weighted-scorer";
const DEFAULT_ARENA_INSTANCE_ID = "default-arena";

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
  const instanceId = opts?.instanceId ?? DEFAULT_INSTANCE_ID;

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

  // 6. Create draft
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

  // 7. Validate + activate
  const validation = core.controlPlane.validateDraft(instanceId);
  if (!validation.ok) {
    const issueList = validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`draft validation failed: ${issueList}`);
  }

  const { roundId } = core.controlPlane.activateDraft(instanceId);
  const finalAgents = core.repository.listAgents(instanceId);

  return { instanceId, roundId, agentCount: finalAgents.length };
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
  const existing = core.repository.listAgents(instanceId);
  const existingIds = new Set(existing.map((a) => a.id));

  const instance = core.repository.getInstance(instanceId);
  if (!instance) {
    throw new Error(`scheduler instance not found: ${instanceId}`);
  }

  let added = 0;
  const now = Date.now();

  for (const model of candidates) {
    const spec = modelToAgentCreateSpec(model);
    if (!existingIds.has(spec.id)) {
      existingIds.add(spec.id);
      core.repository.insertAgent({
        id: spec.id,
        schedulerInstanceId: instanceId,
        definition: spec.definition,
        createdAtRoundId: instance.currentRoundId,
        status: "ready",
        createdAt: now,
      });
      added++;
    }
  }

  return added;
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
  const instanceId = opts?.instanceId ?? DEFAULT_ARENA_INSTANCE_ID;

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

  // 8. Create draft
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

  // 9. Validate + activate
  const validation = core.controlPlane.validateDraft(instanceId);
  if (!validation.ok) {
    const issueList = validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`arena draft validation failed: ${issueList}`);
  }

  const { roundId } = core.controlPlane.activateDraft(instanceId);
  const finalAgents = core.repository.listAgents(instanceId);

  return { instanceId, roundId, agentCount: finalAgents.length };
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
  const existing = core.repository.listAgents(instanceId);
  const existingIds = new Set(existing.map((a) => a.id));

  const instance = core.repository.getInstance(instanceId);
  if (!instance) {
    throw new Error(`scheduler instance not found: ${instanceId}`);
  }

  let added = 0;
  const now = Date.now();

  for (const model of candidates) {
    const spec = modelToAgentCreateSpec(model, "arena");
    if (!existingIds.has(spec.id)) {
      existingIds.add(spec.id);
      core.repository.insertAgent({
        id: spec.id,
        schedulerInstanceId: instanceId,
        definition: spec.definition,
        createdAtRoundId: instance.currentRoundId,
        status: "ready",
        createdAt: now,
      });
      added++;
    }
  }

  return added;
}
