import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { SessionPool, PoolSession } from "./session-pool.js";
import type { ModelRouter } from "../model-router/router.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { SessionStore } from "../storage/interfaces.js";
import type { ToolPlatform } from "../tools/platform.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { AgentEvent, CreateSessionOpts, ManagedSessionInfo, Result } from "./types.js";
import { createBridge } from "./async-iterable-bridge.js";
import crypto from "node:crypto";

export class AgentEngine {
  private agentSessions = new Map<string, AgentSession>();

  constructor(
    private pool: SessionPool,
    private modelRouter: ModelRouter,
    private workspaceMgr: WorkspaceManager,
    private sessionStore: SessionStore,
    private toolPlatform: ToolPlatform,
    private logger: Logger,
    private metrics: Metrics,
  ) {}

  async createSession(opts: CreateSessionOpts): Promise<Result<ManagedSessionInfo>> {
    const check = this.pool.canCreate(opts.tenantId);
    if (!check.ok) return { ok: false, error: check.reason! };

    const sessionId = crypto.randomUUID();
    const cwd = await this.workspaceMgr.ensureWorkspace(opts.tenantId, opts.project);
    const model = this.modelRouter.resolve(opts.provider, opts.model);

    const { session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: (opts.thinkingLevel as any) ?? "medium",
      modelRuntime: this.modelRouter.getRuntime(),
      sessionManager: SessionManager.inMemory(cwd),
      tools: this.toolPlatform.getAllowedTools(opts.tenantId),
    });

    const now = Date.now();
    const poolSession: PoolSession = {
      sessionId,
      tenantId: opts.tenantId,
      project: opts.project,
      state: "idle",
      refCount: 0,
      lastAccess: now,
      lastCheckpointSeq: 0,
      versionSnapshot: null,
    };

    this.pool.add(poolSession);
    this.agentSessions.set(sessionId, session);

    await this.sessionStore.saveMeta(opts.tenantId, sessionId, {
      version: 1,
      sessionId,
      tenantId: opts.tenantId,
      project: opts.project,
      model: model?.id ?? "unknown",
      thinkingLevel: opts.thinkingLevel ?? "medium",
      status: "active",
      entryCount: 0,
      lastEntrySeq: 0,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    this.logger.info({ sessionId, tenantId: opts.tenantId, event: "session_created" });

    return {
      ok: true,
      data: {
        sessionId,
        tenantId: opts.tenantId,
        project: opts.project,
        state: "idle",
        model: model?.id ?? "unknown",
        createdAt: new Date(now).toISOString(),
        lastAccess: new Date(now).toISOString(),
      },
    };
  }

  async *prompt(sessionId: string, tenantId: string, text: string): AsyncIterable<AgentEvent> {
    const managed = this.pool.get(sessionId);
    if (!managed) throw new Error(`Session not found: ${sessionId}`);
    if (managed.tenantId !== tenantId) throw new Error("Forbidden: tenant mismatch");
    if (managed.state === "busy") throw new Error("Session is busy");

    const session = this.agentSessions.get(sessionId);
    if (!session) throw new Error(`AgentSession not in memory: ${sessionId}`);

    this.pool.markBusy(sessionId);
    const timer = this.metrics.promptDuration.startTimer();
    let seq = 0;

    try {
      const { iterable, push, done, error } = createBridge<AgentEvent>({ maxQueueSize: 1000 });

      const unsubscribe = session.subscribe((event) => {
        seq++;
        push({
          seq,
          type: event.type,
          data: event as any,
          terminal: event.type === "agent_end",
          timestamp: new Date().toISOString(),
        });
        if (event.type === "agent_end") done();
      });

      let watchdog = setTimeout(() => {
        error(new Error("Idle watchdog: no events for 120s"));
        unsubscribe();
      }, 120_000);

      session.prompt(text).catch((err) => {
        error(err instanceof Error ? err : new Error(String(err)));
        unsubscribe();
        clearTimeout(watchdog);
      });

      try {
        for await (const event of iterable) {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            error(new Error("Idle watchdog: no events for 120s"));
            unsubscribe();
          }, 120_000);
          yield event;
        }
      } finally {
        clearTimeout(watchdog);
        unsubscribe();
      }

      await this.checkpoint(managed, seq);
    } finally {
      this.pool.markIdle(sessionId);
      timer();
    }
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.agentSessions.get(sessionId);
    if (session) await session.abort();
  }

  async destroySession(sessionId: string, tenantId: string): Promise<void> {
    const managed = this.pool.get(sessionId);
    if (!managed || managed.tenantId !== tenantId) return;
    const session = this.agentSessions.get(sessionId);
    if (session) session.dispose();
    this.agentSessions.delete(sessionId);
    this.pool.remove(sessionId);
    await this.sessionStore.deleteSession(tenantId, sessionId);
  }

  listSessions(tenantId: string): ManagedSessionInfo[] {
    return this.pool.listByTenant(tenantId).map((s) => ({
      sessionId: s.sessionId,
      tenantId: s.tenantId,
      project: s.project,
      state: s.state,
      model: "unknown",
      createdAt: new Date(s.lastAccess).toISOString(),
      lastAccess: new Date(s.lastAccess).toISOString(),
    }));
  }

  async recoverAll(): Promise<void> {
    this.logger.info({ event: "recovery_start" });
    this.logger.info({ event: "recovery_complete" });
  }

  async drain(): Promise<void> {
    this.logger.info({ event: "drain_start", activeSessions: this.pool.size });
    for (const session of this.pool.listAll()) {
      if (session.state === "busy") {
        await this.abort(session.sessionId);
      }
      await this.checkpoint(session, session.lastCheckpointSeq);
      const agentSession = this.agentSessions.get(session.sessionId);
      if (agentSession) agentSession.dispose();
    }
    this.agentSessions.clear();
    this.logger.info({ event: "drain_complete" });
  }

  private async checkpoint(managed: PoolSession, seq: number): Promise<void> {
    managed.lastCheckpointSeq = seq;
    this.logger.debug({ sessionId: managed.sessionId, seq, event: "checkpoint" });
  }
}
