import type { Redis } from "ioredis";
import type { AgentEngine } from "../core/agent-engine.js";
import type { SessionStore } from "../storage/interfaces.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { WorkflowDefinition, WorkflowState, WorkflowStep } from "./types.js";

export class WorkflowOrchestrator {
  constructor(
    private redis: Redis,
    private engine: AgentEngine,
    private sessionStore: SessionStore,
    private logger: Logger,
    private metrics: Metrics,
  ) {}

  async execute(def: WorkflowDefinition, tenantId: string): Promise<WorkflowState> {
    const state = await this.loadOrCreateState(def, tenantId);

    const lockKey = `workflow:${def.id}:lock`;
    const acquired = await this.redis.set(lockKey, state.fencingToken, "PX", 600_000, "NX");
    if (!acquired) throw new Error(`Workflow ${def.id} is already being executed`);

    try {
      for (const step of def.steps) {
        if (state.completedSteps.includes(step.index)) continue;

        this.logger.info({ workflowId: def.id, step: step.index, type: step.type, event: "workflow_step_start" });

        const result = await this.executeStep(step, tenantId, state);
        state.completedSteps.push(step.index);
        state.stepResults[step.index] = result;
        state.currentStep = step.index + 1;
        state.updatedAt = new Date().toISOString();
        await this.saveState(state);

        this.metrics.workflowStepsTotal.inc();

        if (state.status === "awaiting_approval") return state;
      }

      state.status = "completed";
      await this.saveState(state);
      return state;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  async approve(workflowId: string, tenantId: string): Promise<void> {
    const state = await this.loadState(workflowId);
    if (!state || state.tenantId !== tenantId) throw new Error("Workflow not found");
    if (state.status !== "awaiting_approval") throw new Error("Not awaiting approval");
    state.status = "running";
    await this.saveState(state);
  }

  async getState(workflowId: string): Promise<WorkflowState | null> {
    return this.loadState(workflowId);
  }

  private async executeStep(step: WorkflowStep, tenantId: string, state: WorkflowState): Promise<unknown> {
    switch (step.type) {
      case "agent": {
        const session = await this.engine.createSession({
          tenantId,
          project: step.agentConfig.project,
          provider: step.agentConfig.provider,
          model: step.agentConfig.model,
        });
        if (!session.ok) throw new Error(session.error);
        const events: unknown[] = [];
        for await (const event of this.engine.prompt(session.data.sessionId, tenantId, step.prompt)) {
          events.push(event);
        }
        await this.engine.destroySession(session.data.sessionId, tenantId);
        return { sessionId: session.data.sessionId, eventCount: events.length };
      }

      case "parallel": {
        const results: unknown[] = [];
        for (const branch of step.branches) {
          for (const subStep of branch) {
            results.push(await this.executeStep(subStep, tenantId, state));
          }
        }
        return results;
      }

      case "condition": {
        return this.executeStep(step.then, tenantId, state);
      }

      case "human-approval": {
        state.status = "awaiting_approval";
        await this.saveState(state);
        return { awaitingApproval: true, question: step.question };
      }

      default:
        throw new Error(`Unknown step type`);
    }
  }

  private async loadOrCreateState(def: WorkflowDefinition, tenantId: string): Promise<WorkflowState> {
    const existing = await this.loadState(def.id);
    if (existing) return existing;
    const state: WorkflowState = {
      workflowId: def.id,
      definitionHash: def.contentHash,
      tenantId,
      status: "running",
      completedSteps: [],
      stepResults: {},
      currentStep: 0,
      fencingToken: Date.now(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.saveState(state);
    return state;
  }

  private async loadState(workflowId: string): Promise<WorkflowState | null> {
    const raw = await this.redis.get(`workflow:${workflowId}:state`);
    return raw ? (JSON.parse(raw) as WorkflowState) : null;
  }

  private async saveState(state: WorkflowState): Promise<void> {
    await this.redis.set(`workflow:${state.workflowId}:state`, JSON.stringify(state));
  }
}
