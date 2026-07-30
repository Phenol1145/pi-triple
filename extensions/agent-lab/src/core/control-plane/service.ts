import { randomUUID } from "node:crypto";
import type { DefinitionRegistry } from "../definitions/registry.ts";
import type { CoreRepository } from "../storage/repository.ts";
import type { EventLog } from "../events/event-log.ts";
import type {
  SchedulerDefinition,
  SchedulerInstanceDraftSpec,
  ValidationReport,
  ValidationIssue,
  FallbackTarget,
  OptimizerDefinition,
} from "../contracts.ts";
import { matchesVersionRange } from "../version-range.ts";
import { diffLeafPaths, assertPathsTunable } from "../parameter-diff.ts";

export interface ActivationResult {
  schedulerInstanceId: string;
  roundId: string;
  agentIds: string[];
}

export class DraftValidationError extends Error {
  readonly report: ValidationReport;
  constructor(report: ValidationReport) {
    super(`scheduler draft validation failed with ${report.issues.length} issue(s)`);
    this.name = "DraftValidationError";
    this.report = report;
  }
}

export class InstanceNotActiveError extends Error {
  constructor(instanceId: string, status?: string) {
    super(
      status
        ? `instance "${instanceId}" is not active (status: ${status})`
        : `instance "${instanceId}" not found`,
    );
    this.name = "InstanceNotActiveError";
  }
}

export class ProposalRejectedError extends Error {
  readonly reason: string;
  readonly proposalId: string;
  constructor(reason: string, proposalId: string) {
    super(`proposal rejected: ${reason}`);
    this.name = "ProposalRejectedError";
    this.reason = reason;
    this.proposalId = proposalId;
  }
}

export interface ParameterProposal {
  baseRoundId: string;
  parameters: unknown;
  evaluation?: { summary: string; metrics: Record<string, number>; dataWindow: { since: number; until: number } };
  metadata?: Record<string, string>;
}

export class ControlPlane {
  private readonly definitions: DefinitionRegistry;
  private readonly repository: CoreRepository;
  private readonly events: EventLog;
  private readonly nowFn: () => number;

  constructor(
    definitions: DefinitionRegistry,
    repository: CoreRepository,
    events: EventLog,
    nowFn: () => number = Date.now,
  ) {
    this.definitions = definitions;
    this.repository = repository;
    this.events = events;
    this.nowFn = nowFn;
  }

  createDraft(spec: SchedulerInstanceDraftSpec): void {
    this.repository.saveDraft(spec);
  }

  validateDraft(id: string): ValidationReport {
    const now = this.nowFn();
    const issues: ValidationIssue[] = [];

    // 1. Draft exists.
    const stored = this.repository.getDraft(id);
    if (!stored) {
      const report: ValidationReport = { ok: false, issues: [{ path: "", code: "draft-not-found", message: `draft not found: ${id}` }], validatedAt: now };
      return report;
    }

    const spec = stored.spec;

    // 2. schedulerDefinition.kind === "scheduler" and exact definition exists.
    if (spec.schedulerDefinition.kind !== "scheduler") {
      issues.push({ path: "schedulerDefinition", code: "invalid-kind", message: `expected kind "scheduler", got "${spec.schedulerDefinition.kind}"` });
    }

    let definition: SchedulerDefinition | undefined;
    try {
      definition = this.definitions.require(spec.schedulerDefinition) as SchedulerDefinition;
    } catch {
      issues.push({
        path: "schedulerDefinition",
        code: "definition-not-found",
        message: `definition not found: ${spec.schedulerDefinition.kind}/${spec.schedulerDefinition.id}@${spec.schedulerDefinition.version}`,
      });
    }

    // 3. validateParameters(initialParameters ?? defaultParameters) succeeds.
    if (definition) {
      const effectiveParams = spec.initialParameters ?? definition.defaultParameters;
      const paramResult = definition.validateParameters(effectiveParams);
      if (!paramResult.ok) {
        for (const issue of paramResult.issues) {
          issues.push(issue);
        }
      }
    }

    // 4. Agent IDs non-empty and unique.
    const agentIds = new Set<string>();
    for (const agent of spec.agents) {
      if (!agent.id || agent.id.trim().length === 0) {
        issues.push({ path: "agents", code: "empty-agent-id", message: "agent id must be non-empty" });
      } else if (agentIds.has(agent.id)) {
        issues.push({ path: "agents", code: "duplicate-agent-id", message: `duplicate agent id: ${agent.id}` });
      } else {
        agentIds.add(agent.id);
      }
    }

    // 5. Every Agent definition passes validateAgentDefinition.
    if (definition) {
      for (const agent of spec.agents) {
        const agentResult = definition.validateAgentDefinition(agent.definition);
        if (!agentResult.ok) {
          for (const issue of agentResult.issues) {
            issues.push(issue);
          }
        }
      }
    }

    // 6. Every Agent workloop exact id@version exists.
    for (const agent of spec.agents) {
      const wlRef = {
        kind: "workloop" as const,
        id: agent.definition.workLoop.id,
        version: agent.definition.workLoop.version,
      };
      if (!this.definitions.resolve(wlRef)) {
        issues.push({
          path: `agents.${agent.id}.workLoop`,
          code: "workloop-not-found",
          message: `workloop not found: ${wlRef.id}@${wlRef.version}`,
        });
      }
    }

    // 7. Each fallback SchedulerInstance exists and is active.
    for (const target of spec.fallbackChain) {
      if (target.type === "scheduler-instance") {
        const instance = this.repository.getInstance(target.id);
        if (!instance || instance.status !== "active") {
          issues.push({
            path: "fallbackChain",
            code: "fallback-not-active",
            message: `fallback target not active: ${target.id}`,
          });
        }
      }
    }

    // 8. Fallback cycle detection.
    if (this.detectFallbackCycle(spec.id, spec.fallbackChain)) {
      issues.push({
        path: "fallbackChain",
        code: "fallback-cycle",
        message: `fallback cycle reaches draft: ${spec.id}`,
      });
    }

    // 9. Routing binding IDs unique within draft.
    const routeIds = new Set<string>();
    for (const binding of spec.routingBindings) {
      if (routeIds.has(binding.id)) {
        issues.push({ path: "routingBindings", code: "duplicate-route-id", message: `duplicate route id: ${binding.id}` });
      } else {
        routeIds.add(binding.id);
      }
    }

    // 10. Routing binding ID not owned by another instance.
    for (const binding of spec.routingBindings) {
      const owner = this.repository.getRoutingOwner(binding.id);
      if (owner !== undefined && owner !== spec.id) {
        issues.push({
          path: `routingBindings.${binding.id}`,
          code: "route-id-conflict",
          message: `route id "${binding.id}" already owned by instance "${owner}"`,
        });
      }
    }

    const report: ValidationReport = { ok: issues.length === 0, issues, validatedAt: now };
    this.repository.setDraftValidation(id, report);
    this.repository.setDraftStatus(id, report.ok ? "validated" : "rejected");
    return report;
  }

  activateDraft(id: string): ActivationResult {
    const stored = this.repository.getDraft(id);
    if (!stored) throw new Error(`draft not found: ${id}`);

    // Always re-validate immediately before activation.
    const report = this.validateDraft(id);
    if (!report.ok) throw new DraftValidationError(report);

    const spec = stored.spec;
    const definition = this.definitions.require(spec.schedulerDefinition) as SchedulerDefinition;
    const effectiveParams = spec.initialParameters ?? definition.defaultParameters;
    const roundId = `${spec.id}:round:0`;
    const now = this.nowFn();
    const agentIds = spec.agents.map((a) => a.id);
    const routeIds = spec.routingBindings.map((b) => b.id);

    return this.repository.transaction(() => {
      // Insert active SchedulerInstance.
      this.repository.insertInstance({
        id: spec.id,
        name: spec.name ?? spec.id,
        definition: spec.schedulerDefinition,
        parameterModelVersion: definition.parameterModelVersion,
        agentDefinitionSchemaVersion: definition.agentDefinitionSchemaVersion,
        status: "active",
        currentRoundId: roundId,
        fallbackChain: spec.fallbackChain,
        createdAt: now,
      }, spec.metadata ?? {});

      // Insert Round 0.
      this.repository.insertRound({
        id: roundId,
        schedulerInstanceId: spec.id,
        sequence: 0,
        parameters: effectiveParams,
        status: "active",
        createdAt: now,
        activatedAt: now,
      });

      // Insert all initial agents.
      for (const agent of spec.agents) {
        this.repository.insertAgent({
          id: agent.id,
          schedulerInstanceId: spec.id,
          definition: agent.definition,
          model: agent.definition?.standard?.name,   // model-candidate agent 的 standard.name = model id
          createdAtRoundId: roundId,
          status: "ready",
          createdAt: now,
        });
      }

      // Insert all routing bindings.
      for (const binding of spec.routingBindings) {
        this.repository.insertRoutingBinding(spec.id, binding);
      }

      // Append instance.activated event (same transaction via shared DatabaseSync).
      this.events.append({
        eventId: `instance.activated:${spec.id}`,
        eventType: "instance.activated",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `control:${spec.id}`,
          schedulerInstanceId: spec.id,
          schedulerDefinitionId: definition.id,
          schedulerDefinitionVersion: definition.version,
          optimizationRoundId: roundId,
        },
        payload: { agentIds, routeIds },
      });

      // Mark draft as activated.
      this.repository.setDraftStatus(spec.id, "activated");

      return { schedulerInstanceId: spec.id, roundId, agentIds };
    });
  }

  setCatchAllBinding(schedulerInstanceId: string, bindingId: string, enabled: boolean): void {
    const instance = this.repository.getInstance(schedulerInstanceId);
    if (!instance) {
      throw new InstanceNotActiveError(schedulerInstanceId);
    }
    if (instance.status !== "active") {
      throw new InstanceNotActiveError(schedulerInstanceId, instance.status);
    }

    const binding = {
      id: bindingId,
      priority: 10,
      match: {} as Record<string, never>,
    };

    if (enabled) {
      this.repository.transaction(() => {
        this.repository.upsertRoutingBinding(schedulerInstanceId, binding);
        this.events.append({
          eventId: `routing.binding.added:${schedulerInstanceId}`,
          eventType: "routing.binding.added",
          schemaVersion: "1",
          timestamp: this.nowFn(),
          identity: {
            traceId: `control:${schedulerInstanceId}`,
            schedulerInstanceId,
          },
          payload: { schedulerInstanceId, binding },
        });
      });
    } else {
      this.repository.transaction(() => {
        const deleted = this.repository.deleteRoutingBinding(bindingId);
        if (deleted > 0) {
          this.events.append({
            eventId: `routing.binding.removed:${schedulerInstanceId}`,
            eventType: "routing.binding.removed",
            schemaVersion: "1",
            timestamp: this.nowFn(),
            identity: {
              traceId: `control:${schedulerInstanceId}`,
              schedulerInstanceId,
            },
            payload: { schedulerInstanceId, binding },
          });
        }
      });
    }
  }

  // ── Proposal submission ────────────────────────────────────────

  /**
   * Submit a parameter proposal through the six ordered gates.
   *
   * Gates (failure persists proposal as rejected + event + throws ProposalRejectedError):
   * 1. Instance exists & active; optimizer instance exists & targets this instance
   * 2. Version compatibility (scheduler versionRange + parameterModelVersionRange)
   * 3. Baseline freshness (baseRoundId === instance.currentRoundId)
   * 4. Schema validation (validateParameters)
   * 5. Transition validation (validateTransition)
   * 6. Tunable-paths check (diffLeafPaths ⊆ tunablePaths)
   *
   * On pass: pending proposal + candidate round (sequence=MAX+1) in a single transaction.
   */
  submitProposal(
    optimizerInstanceId: string,
    schedulerInstanceId: string,
    proposal: ParameterProposal,
  ): { proposalId: string; candidateRoundId: string } {
    const now = this.nowFn();
    const proposalId = randomUUID();

    // ── Gate 1: instance & optimizer existence / active ──────────
    const instance = this.repository.getInstance(schedulerInstanceId);
    if (!instance || instance.status !== "active") {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, "instance not found or not active", proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError("instance not found or not active", proposalId);
    }

    const optInst = this.repository.getOptimizerInstance(optimizerInstanceId);
    if (!optInst || optInst.status !== "active") {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, "optimizer instance not found or not active", proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError("optimizer instance not found or not active", proposalId);
    }
    if (!optInst.targetSchedulers.includes(schedulerInstanceId)) {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, "optimizer instance does not target this scheduler", proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError("optimizer instance does not target this scheduler", proposalId);
    }

    // ── Gate 2: version compatibility ────────────────────────────
    const optDef = this.definitions.require({
      kind: "optimizer",
      id: optInst.definitionId,
      version: optInst.definitionVersion,
    }) as OptimizerDefinition;

    const compatEntry = optDef.compatibleSchedulers.find(
      (e) => e.id === instance.definition.id,
    );
    if (!compatEntry) {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, `scheduler "${instance.definition.id}" not in optimizer compatibleSchedulers`, proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError(`scheduler "${instance.definition.id}" not in optimizer compatibleSchedulers`, proposalId);
    }
    if (!matchesVersionRange(instance.definition.version, compatEntry.versionRange)) {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, `scheduler version ${instance.definition.version} outside range ${compatEntry.versionRange}`, proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError(`scheduler version ${instance.definition.version} outside range ${compatEntry.versionRange}`, proposalId);
    }
    if (!matchesVersionRange(instance.parameterModelVersion, optDef.parameterModelVersionRange)) {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, `parameter model version ${instance.parameterModelVersion} outside range ${optDef.parameterModelVersionRange}`, proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError(`parameter model version ${instance.parameterModelVersion} outside range ${optDef.parameterModelVersionRange}`, proposalId);
    }

    const schedDef = this.definitions.require(instance.definition) as SchedulerDefinition;

    // ── Gate 3: baseline freshness ────────────────────────────────
    if (proposal.baseRoundId !== instance.currentRoundId) {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, "stale baseline", proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError("stale baseline", proposalId);
    }

    const baseRound = this.repository.getRound(instance.currentRoundId);
    if (!baseRound) {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, "base round not found", proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError("base round not found", proposalId);
    }

    // ── Gate 4: schema validation ─────────────────────────────────
    const schemaResult = schedDef.validateParameters(proposal.parameters);
    if (!schemaResult.ok) {
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, `schema: ${schemaResult.issues.map((i) => i.message).join("; ")}`, proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError(`schema: ${schemaResult.issues.map((i) => i.message).join("; ")}`, proposalId);
    }

    // ── Gate 5: transition validation ────────────────────────────
    if (schedDef.validateTransition) {
      const transResult = schedDef.validateTransition(baseRound.parameters, proposal.parameters);
      if (!transResult.ok) {
        this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, `transition: ${transResult.issues.map((i) => i.message).join("; ")}`, proposal.baseRoundId, proposal.parameters);
        throw new ProposalRejectedError(`transition: ${transResult.issues.map((i) => i.message).join("; ")}`, proposalId);
      }
    }

    // ── Gate 6: tunable paths ─────────────────────────────────────
    let changedPaths: string[];
    try {
      changedPaths = diffLeafPaths(baseRound.parameters, proposal.parameters);
      assertPathsTunable(changedPaths, schedDef.tunablePaths);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.rejectProposal(proposalId, optimizerInstanceId, schedulerInstanceId, now, `tunable paths: ${msg}`, proposal.baseRoundId, proposal.parameters);
      throw new ProposalRejectedError(`tunable paths: ${msg}`, proposalId);
    }

    // ── All gates passed: transactional persistence ──────────────
    return this.repository.transaction(() => {
      // Compute next sequence in-transaction
      const latest = this.repository.listRounds(schedulerInstanceId, 1);
      const nextSeq = (latest[0]?.sequence ?? -1) + 1;
      const candidateRoundId = `${schedulerInstanceId}:round:${nextSeq}`;

      // Insert pending proposal
      this.repository.insertProposal({
        id: proposalId,
        optimizerInstanceId,
        schedulerInstanceId,
        baseRoundId: proposal.baseRoundId,
        parameters: proposal.parameters,
        evaluation: proposal.evaluation,
        status: "pending",
        candidateRoundId,
        createdAt: now,
      });

      // Insert candidate round
      this.repository.insertRound({
        id: candidateRoundId,
        schedulerInstanceId,
        sequence: nextSeq,
        parentRoundId: proposal.baseRoundId,
        parameters: proposal.parameters,
        optimizer: {
          instanceId: optimizerInstanceId,
          definitionId: optDef.id,
          definitionVersion: optDef.version,
        },
        proposalId,
        status: "proposed",
        createdAt: now,
      });

      // Events
      this.events.append({
        eventId: `optimizer.proposal.submitted:${proposalId}`,
        eventType: "optimizer.proposal.submitted",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `control:${schedulerInstanceId}`,
          schedulerInstanceId,
          optimizationRoundId: candidateRoundId,
          optimizerInstanceId,
          proposalId,
          schedulerDefinitionId: schedDef.id,
          schedulerDefinitionVersion: schedDef.version,
        },
        payload: { proposalId, candidateRoundId },
      });

      this.events.append({
        eventId: `round.proposed:${candidateRoundId}`,
        eventType: "round.proposed",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `control:${schedulerInstanceId}`,
          schedulerInstanceId,
          optimizationRoundId: candidateRoundId,
          optimizerInstanceId,
          proposalId,
        },
        payload: { roundId: candidateRoundId, proposalId },
      });

      return { proposalId, candidateRoundId };
    });
  }

  // ── Promote candidate round ─────────────────────────────────────

  /**
   * Promote a candidate round to active.
   *
   * - Re-validates parameters + transition + tunablePaths against the CURRENT round
   * - Supersedes other pending proposals and their candidate rounds
   * - All mutations in a single transaction
   */
  promoteRound(candidateRoundId: string): { newRoundId: string } {
    const now = this.nowFn();

    const candidate = this.repository.getRound(candidateRoundId);
    if (!candidate) {
      throw new Error(`candidate round not found: ${candidateRoundId}`);
    }
    if (candidate.status !== "proposed" && candidate.status !== "validated" && candidate.status !== "canary") {
      throw new Error(`candidate round ${candidateRoundId} has status ${candidate.status}, expected proposed or validated or canary`);
    }

    const instance = this.repository.getInstance(candidate.schedulerInstanceId);
    if (!instance || instance.status !== "active") {
      throw new InstanceNotActiveError(candidate.schedulerInstanceId, instance?.status);
    }

    const schedDef = this.definitions.require(instance.definition) as SchedulerDefinition;

    const currentRound = this.repository.getRound(instance.currentRoundId);
    if (!currentRound) {
      throw new Error(`current round not found: ${instance.currentRoundId}`);
    }

    // ── Defensive: exactly one active round ───────────────────────
    const allRounds = this.repository.listRounds(candidate.schedulerInstanceId);
    const activeCount = allRounds.filter((r) => r.status === "active").length;
    if (activeCount !== 1) {
      throw new Error(`instance ${candidate.schedulerInstanceId} has ${activeCount} active rounds (expected 1)`);
    }

    // ── Re-validation against CURRENT round (I4) ─────────────────
    const schemaResult = schedDef.validateParameters(candidate.parameters);
    if (!schemaResult.ok) {
      throw new Error(`re-validation schema: ${schemaResult.issues.map((i) => i.message).join("; ")}`);
    }

    if (schedDef.validateTransition) {
      const transResult = schedDef.validateTransition(currentRound.parameters, candidate.parameters);
      if (!transResult.ok) {
        throw new Error(`re-validation transition: ${transResult.issues.map((i) => i.message).join("; ")}`);
      }
    }

    const changedPaths = diffLeafPaths(currentRound.parameters, candidate.parameters);
    assertPathsTunable(changedPaths, schedDef.tunablePaths);

    const proposalId = candidate.proposalId;
    const optimizerInstanceId = candidate.optimizer?.instanceId;

    // ── Transaction ───────────────────────────────────────────────
    return this.repository.transaction(() => {
      // Compute next sequence
      const latest = this.repository.listRounds(candidate.schedulerInstanceId, 1);
      const nextSeq = (latest[0]?.sequence ?? -1) + 1;
      const newRoundId = `${candidate.schedulerInstanceId}:round:${nextSeq}`;

      // New active round (copies candidate params + optimizer + proposalId)
      this.repository.insertRound({
        id: newRoundId,
        schedulerInstanceId: candidate.schedulerInstanceId,
        sequence: nextSeq,
        parentRoundId: currentRound.id,
        parameters: candidate.parameters,
        optimizer: candidate.optimizer,
        proposalId,
        status: "active",
        createdAt: now,
        activatedAt: now,
      });

      // Old current → superseded
      this.repository.updateRoundStatus(currentRound.id, "superseded");

      // Candidate → superseded
      this.repository.updateRoundStatus(candidateRoundId, "superseded");

      // Switch currentRoundId
      this.repository.updateInstanceCurrentRound(candidate.schedulerInstanceId, newRoundId);

      // Clear stale canary pointer if the promoted round was the canary
      if (instance.canaryRoundId === candidateRoundId) {
        this.repository.clearCanaryRound(candidate.schedulerInstanceId);
      }

      // Proposal → accepted with promoted_round_id
      if (proposalId) {
        this.repository.updateProposalStatus(proposalId, "accepted", newRoundId);
      }

      // Supersede other pending proposals and their candidate rounds
      const supersededProposalIds: string[] = [];
      const otherProposals = this.repository.listProposals(candidate.schedulerInstanceId);
      for (const p of otherProposals) {
        if (p.id === proposalId) continue;
        if (p.status === "pending") {
          this.repository.updateProposalStatus(p.id, "superseded");
          supersededProposalIds.push(p.id);
          if (p.candidateRoundId) {
            this.repository.updateRoundStatus(p.candidateRoundId, "superseded");
          }
        }
      }

      // ── Events ──────────────────────────────────────────────────
      this.events.append({
        eventId: `round.promoted:${newRoundId}`,
        eventType: "round.promoted",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `control:${candidate.schedulerInstanceId}`,
          schedulerInstanceId: candidate.schedulerInstanceId,
          optimizationRoundId: newRoundId,
          ...(optimizerInstanceId ? { optimizerInstanceId } : {}),
          ...(proposalId ? { proposalId } : {}),
        },
        payload: { from: currentRound.id, to: newRoundId, proposalId },
      });

      for (const sid of supersededProposalIds) {
        this.events.append({
          eventId: `optimizer.proposal.superseded:${sid}`,
          eventType: "optimizer.proposal.superseded",
          schemaVersion: "1",
          timestamp: now,
          identity: {
            traceId: `control:${candidate.schedulerInstanceId}`,
            schedulerInstanceId: candidate.schedulerInstanceId,
            proposalId: sid,
          },
          payload: { proposalId: sid },
        });
      }

      return { newRoundId };
    });
  }

  // ── Mark round validated (shadow gate) ──────────────────────────

  /**
   * Transition a round from `proposed` to `validated`.
   *
   * This is a narrow gate: only `proposed` → `validated` is allowed.
   * Any other status throws defensively.  Emits `round.validated`.
   */
  markRoundValidated(roundId: string): void {
    const now = this.nowFn();
    const round = this.repository.getRound(roundId);
    if (!round) {
      throw new Error(`round not found: ${roundId}`);
    }
    if (round.status !== "proposed") {
      throw new Error(
        `cannot mark round ${roundId} as validated: current status is ${round.status}, expected proposed`,
      );
    }

    this.repository.updateRoundStatus(roundId, "validated", now);

    this.events.append({
      eventId: `round.validated:${roundId}`,
      eventType: "round.validated",
      schemaVersion: "1",
      timestamp: now,
      identity: {
        traceId: `control:${round.schedulerInstanceId}`,
        schedulerInstanceId: round.schedulerInstanceId,
        optimizationRoundId: roundId,
        ...(round.proposalId ? { proposalId: round.proposalId } : {}),
        ...(round.optimizer?.instanceId
          ? { optimizerInstanceId: round.optimizer.instanceId }
          : {}),
      },
      payload: { roundId },
    });
  }

  // ── Rollback to a prior round ───────────────────────────────────

  /**
   * Roll back to a prior round.
   *
   * - target must belong to instance, != currentRoundId, status in {active, superseded, rolled-back}
   * - Re-validates parameters + transition against CURRENT round's definition
   * - New round copies target.parameters (optimizer/proposalId EMPTY)
   * - Old current → rolled-back; pending proposals → superseded
   */
  rollbackRound(
    schedulerInstanceId: string,
    targetRoundId: string,
  ): { newRoundId: string } {
    const now = this.nowFn();

    const instance = this.repository.getInstance(schedulerInstanceId);
    if (!instance) {
      throw new Error(`instance not found: ${schedulerInstanceId}`);
    }

    if (targetRoundId === instance.currentRoundId) {
      throw new Error(`cannot rollback to current round: ${targetRoundId}`);
    }

    const target = this.repository.getRound(targetRoundId);
    if (!target) {
      throw new Error(`target round not found: ${targetRoundId}`);
    }
    if (target.schedulerInstanceId !== schedulerInstanceId) {
      throw new Error(`target round ${targetRoundId} belongs to ${target.schedulerInstanceId}, not ${schedulerInstanceId}`);
    }
    if (target.status !== "active" && target.status !== "superseded" && target.status !== "rolled-back") {
      throw new Error(`target round ${targetRoundId} has status ${target.status}, expected active/superseded/rolled-back`);
    }

    const currentRound = this.repository.getRound(instance.currentRoundId);
    if (!currentRound) {
      throw new Error(`current round not found: ${instance.currentRoundId}`);
    }

    // ── Defensive: exactly one active round ───────────────────────
    const allRounds = this.repository.listRounds(schedulerInstanceId);
    const activeCount = allRounds.filter((r) => r.status === "active").length;
    if (activeCount !== 1) {
      throw new Error(`instance ${schedulerInstanceId} has ${activeCount} active rounds (expected 1)`);
    }

    const schedDef = this.definitions.require(instance.definition) as SchedulerDefinition;

    // ── Re-validation ─────────────────────────────────────────────
    const schemaResult = schedDef.validateParameters(target.parameters);
    if (!schemaResult.ok) {
      throw new Error(`rollback schema: ${schemaResult.issues.map((i) => i.message).join("; ")}`);
    }

    if (schedDef.validateTransition) {
      const transResult = schedDef.validateTransition(currentRound.parameters, target.parameters);
      if (!transResult.ok) {
        throw new Error(`rollback transition: ${transResult.issues.map((i) => i.message).join("; ")}`);
      }
    }

    // ── Transaction ───────────────────────────────────────────────
    return this.repository.transaction(() => {
      const latest = this.repository.listRounds(schedulerInstanceId, 1);
      const nextSeq = (latest[0]?.sequence ?? -1) + 1;
      const newRoundId = `${schedulerInstanceId}:round:${nextSeq}`;

      // New active round: copies target.parameters, optimizer/proposalId EMPTY
      this.repository.insertRound({
        id: newRoundId,
        schedulerInstanceId,
        sequence: nextSeq,
        parentRoundId: currentRound.id,
        parameters: target.parameters,
        optimizer: undefined,
        proposalId: undefined,
        status: "active",
        createdAt: now,
        activatedAt: now,
      });

      // Old current → rolled-back
      this.repository.updateRoundStatus(currentRound.id, "rolled-back");

      // Switch currentRoundId
      this.repository.updateInstanceCurrentRound(schedulerInstanceId, newRoundId);

      // Supersede pending proposals
      const supersededProposalIds: string[] = [];
      const proposals = this.repository.listProposals(schedulerInstanceId);
      for (const p of proposals) {
        if (p.status === "pending") {
          this.repository.updateProposalStatus(p.id, "superseded");
          supersededProposalIds.push(p.id);
          if (p.candidateRoundId) {
            this.repository.updateRoundStatus(p.candidateRoundId, "superseded");
          }
        }
      }

      // ── Event ───────────────────────────────────────────────────
      this.events.append({
        eventId: `round.rolled-back:${newRoundId}`,
        eventType: "round.rolled-back",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `control:${schedulerInstanceId}`,
          schedulerInstanceId,
          optimizationRoundId: newRoundId,
        },
        payload: { from: currentRound.id, to: newRoundId, targetRoundId, actor: "manual" },
      });

      for (const sid of supersededProposalIds) {
        this.events.append({
          eventId: `optimizer.proposal.superseded:${sid}`,
          eventType: "optimizer.proposal.superseded",
          schemaVersion: "1",
          timestamp: now,
          identity: {
            traceId: `control:${schedulerInstanceId}`,
            schedulerInstanceId,
            proposalId: sid,
          },
          payload: { proposalId: sid },
        });
      }

      return { newRoundId };
    });
  }

  // ── Abort canary ─────────────────────────────────────────────────

  /**
   * Abort a canary experiment.
   *
   * - Candidate canary round → status "rolled-back" (+ event)
   * - clearCanaryRound (set canary_round_id / canary_percent to NULL)
   * - Linked pending proposal → "superseded" (+ event if found)
   * - Current active round is **untouched**
   *
   * All mutations in a single transaction.
   *
   * When the instance has no canaryRoundId, this throws defensively
   * (caller should guard with a canary check before calling).
   */
  abortCanary(
    schedulerInstanceId: string,
    opts?: { reason?: string; actor?: string },
  ): void {
    const now = this.nowFn();

    const instance = this.repository.getInstance(schedulerInstanceId);
    if (!instance) {
      throw new Error(`scheduler instance not found: ${schedulerInstanceId}`);
    }

    const canaryRoundId = instance.canaryRoundId;
    if (!canaryRoundId) {
      throw new Error(
        `no canary round set on instance ${schedulerInstanceId} — nothing to abort`,
      );
    }

    const canaryRound = this.repository.getRound(canaryRoundId);
    if (!canaryRound) {
      throw new Error(`canary round not found: ${canaryRoundId}`);
    }

    const proposalId = canaryRound.proposalId;
    const actor = opts?.actor ?? "manual";
    const reason = opts?.reason ?? "canary aborted";

    return this.repository.transaction(() => {
      // Candidate canary round → rolled-back
      this.repository.updateRoundStatus(canaryRoundId, "rolled-back");

      // Clear canary pointer on instance
      this.repository.clearCanaryRound(schedulerInstanceId);

      // Supersede linked pending proposal (if any)
      if (proposalId) {
        const proposal = this.repository.getProposal(proposalId);
        if (proposal && proposal.status === "pending") {
          this.repository.updateProposalStatus(proposalId, "superseded");

          this.events.append({
            eventId: `optimizer.proposal.superseded:${proposalId}`,
            eventType: "optimizer.proposal.superseded",
            schemaVersion: "1",
            timestamp: now,
            identity: {
              traceId: `control:${schedulerInstanceId}`,
              schedulerInstanceId,
              proposalId,
            },
            payload: { proposalId, reason: "canary aborted" },
          });
        }
      }

      // ── Event: round.canary-aborted ─────────────────────────────
      this.events.append({
        eventId: `round.canary-aborted:${canaryRoundId}:${now}`,
        eventType: "round.canary-aborted",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `control:${schedulerInstanceId}`,
          schedulerInstanceId,
          optimizationRoundId: canaryRoundId,
          ...(proposalId ? { proposalId } : {}),
        },
        payload: {
          roundId: canaryRoundId,
          reason,
          actor,
          ...(proposalId ? { proposalId } : {}),
        },
      });
    });
  }

  // ── Private helpers ─────────────────────────────────────────────

  private rejectProposal(
    proposalId: string,
    optimizerInstanceId: string,
    schedulerInstanceId: string,
    now: number,
    reason: string,
    baseRoundId?: string,
    parameters?: unknown,
  ): void {
    this.repository.transaction(() => {
      this.repository.insertProposal({
        id: proposalId,
        optimizerInstanceId,
        schedulerInstanceId,
        baseRoundId: baseRoundId ?? "",
        parameters: parameters ?? null,
        status: "rejected",
        createdAt: now,
      });

      this.events.append({
        eventId: `optimizer.proposal.rejected:${proposalId}`,
        eventType: "optimizer.proposal.rejected",
        schemaVersion: "1",
        timestamp: now,
        identity: {
          traceId: `control:${schedulerInstanceId}`,
          schedulerInstanceId,
          optimizerInstanceId,
          proposalId,
        },
        payload: { reason, baseRoundId, parameters },
      });
    });
  }

  private detectFallbackCycle(draftId: string, draftChain: FallbackTarget[]): boolean {
    const visited = new Set<string>();
    const toVisit: string[] = [];

    for (const target of draftChain) {
      if (target.type === "scheduler-instance") {
        if (target.id === draftId) return true;
        toVisit.push(target.id);
      }
    }

    while (toVisit.length > 0) {
      const current = toVisit.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);

      if (current === draftId) return true;

      const instance = this.repository.getInstance(current);
      if (!instance || instance.status !== "active") continue;

      for (const target of instance.fallbackChain) {
        if (target.type === "scheduler-instance") {
          if (target.id === draftId) return true;
          if (!visited.has(target.id)) toVisit.push(target.id);
        }
      }
    }

    return false;
  }
}
