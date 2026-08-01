import type { CoreRepository } from "../storage/repository.ts";
import type { EventLog } from "../events/event-log.ts";

// ── Parameter proposal (extracted from control-plane/service.ts) ──────

export interface ParameterProposal {
  baseRoundId: string;
  parameters: unknown;
  evaluation?: { summary: string; metrics: Record<string, number>; dataWindow: { since: number; until: number } };
  metadata?: Record<string, string>;
}

export interface RejectProposalDeps {
  repository: Pick<CoreRepository, "transaction" | "insertProposal">;
  events: Pick<EventLog, "append">;
}

/**
 * Persist a rejected proposal + audit event inside a transaction.
 * Extracted from ControlPlane.rejectProposal (behavior-preserving).
 */
export function rejectProposal(
  deps: RejectProposalDeps,
  proposalId: string,
  optimizerInstanceId: string,
  schedulerInstanceId: string,
  now: number,
  reason: string,
  baseRoundId?: string,
  parameters?: unknown,
): void {
  deps.repository.transaction(() => {
    deps.repository.insertProposal({
      id: proposalId,
      optimizerInstanceId,
      schedulerInstanceId,
      baseRoundId: baseRoundId ?? "",
      parameters: parameters ?? null,
      status: "rejected",
      createdAt: now,
    });

    deps.events.append({
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
