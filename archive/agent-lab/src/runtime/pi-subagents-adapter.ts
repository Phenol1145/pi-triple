import {
  SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  type SubagentDelegationV2Request,
  type SubagentDelegationV2Started,
  type SubagentDelegationV2Update,
  type SubagentDelegationV2TerminalResponse,
  type SubagentDelegationV2Response,
  type SubagentDelegationV2Cancel,
} from "./delegation-v2.ts";

// ---------------------------------------------------------------------------
// Injected event bus
// ---------------------------------------------------------------------------

export interface DelegationEventBus {
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// Injected timer seams
// ---------------------------------------------------------------------------

export interface TimerSeams {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

const defaultTimerSeams: TimerSeams = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

// ---------------------------------------------------------------------------
// Delegate options
// ---------------------------------------------------------------------------

export interface DelegateOptions {
  /** AbortSignal to cancel the delegation. */
  signal?: AbortSignal;
  /** Callback for progress updates correlated to this request. */
  onUpdate?: (update: SubagentDelegationV2Update) => void;
  /** Override the transport-level timeout (ms). Default: max(timeoutMs ?? 30_000, 1_000) + 5_000. */
  transportTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Identity key
// ---------------------------------------------------------------------------

type IdentityKey = string;

function identityKey(started: SubagentDelegationV2Started): IdentityKey {
  return JSON.stringify([started.requestId, started.ownerRunId, started.nodeId]);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PiSubagentsAdapter {
  private readonly bus: DelegationEventBus;
  private readonly timers: TimerSeams;
  private readonly inflight = new Map<
    IdentityKey,
    {
      resolve: (value: SubagentDelegationV2TerminalResponse) => void;
      reject: (reason: Error) => void;
      onUpdate?: (update: SubagentDelegationV2Update) => void;
      timerId: ReturnType<typeof setTimeout>;
      abortHandler: (() => void) | null;
    }
  >();

  /** Secondary index: requestId → tuple key. Enables correlating partial
   *  invalid_request responses that omit ownerRunId/nodeId. */
  private readonly inflightByRequestId = new Map<string, IdentityKey>();

  // One global subscription per event type; correlation by identity tuple.
  private unsubStarted: (() => void) | null = null;
  private unsubUpdate: (() => void) | null = null;
  private unsubResponse: (() => void) | null = null;
  private disposed = false;

  constructor(bus: DelegationEventBus, seams?: Partial<TimerSeams>) {
    this.bus = bus;
    this.timers = { ...defaultTimerSeams, ...seams };

    // Register global handlers once. Subscribe before any request can emit.
    this.unsubStarted = this.bus.on(SUBAGENT_DELEGATION_STARTED_EVENT, this.onStarted);
    this.unsubUpdate = this.bus.on(SUBAGENT_DELEGATION_UPDATE_EVENT, this.onUpdate);
    this.unsubResponse = this.bus.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, this.onResponse);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Emit a V2 delegation request over the event bus and return a Promise that
   * resolves with the terminal response.
   *
   * Rejects only on local adapter failures (timeout, dispose, duplicate inflight).
   */
  delegate(
    request: SubagentDelegationV2Request,
    options: DelegateOptions = {},
  ): Promise<SubagentDelegationV2TerminalResponse> {
    if (this.disposed) {
      return Promise.reject(new Error("delegation adapter disposed"));
    }

    // Enforce requestId uniqueness across all inflight delegations.
    // This allows partial invalid_request responses (which omit
    // ownerRunId/nodeId) to be safely correlated by requestId alone.
    if (this.inflightByRequestId.has(request.requestId)) {
      return Promise.reject(new Error("delegation requestId already in flight"));
    }

    const key = identityKey(request);

    if (this.inflight.has(key)) {
      return Promise.reject(new Error("delegation already in flight"));
    }

    const transportTimeoutMs =
      options.transportTimeoutMs ??
      Math.max(request.timeoutMs ?? 30_000, 1_000) + 5_000;

    let timerId: ReturnType<typeof setTimeout>;
    let settled = false;

    return new Promise<SubagentDelegationV2TerminalResponse>((resolve, reject) => {
      const requestId = request.requestId;
      const cleanup = () => {
        this.inflight.delete(key);
        this.inflightByRequestId.delete(requestId);
        if (timerId !== undefined) this.timers.clearTimeout(timerId);
        if (abortHandler && options.signal) {
          options.signal.removeEventListener("abort", abortHandler);
        }
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      // Transport timeout
      timerId = this.timers.setTimeout(() => {
        settle(() => {
          // Emit cancel before rejecting
          this.emitCancel(request);
          reject(new Error("delegation transport timed out"));
        });
      }, transportTimeoutMs);

      // AbortSignal
      let abortHandler: (() => void) | null = null;
      if (options.signal) {
        abortHandler = () => {
          settle(() => {
            this.emitCancel(request);
            resolve(this.cancelledResponse(request));
          });
        };
        if (options.signal.aborted) {
          // Already aborted — settle immediately
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Store inflight entry and secondary requestId index
      this.inflight.set(key, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (err) => settle(() => reject(err)),
        onUpdate: options.onUpdate,
        timerId,
        abortHandler,
      });
      this.inflightByRequestId.set(requestId, key);

      // Emit request — subscribe-before-emit invariant is satisfied because
      // the global handlers were registered in the constructor.
      this.bus.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
    });
  }

  /**
   * Emit a cancel for the given identity tuple. No-op if the tuple is not
   * currently inflight.
   */
  cancel(identity: SubagentDelegationV2Started): void {
    const key = identityKey(identity);
    const entry = this.inflight.get(key);
    if (!entry) return;

    this.emitCancel(identity);
    entry.resolve(this.cancelledResponse(identity));
  }

  /**
   * Unsubscribe all event listeners, emit cancel for every inflight request,
   * and reject all pending promises.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Unsubscribe global handlers
    this.unsubStarted?.();
    this.unsubStarted = null;
    this.unsubUpdate?.();
    this.unsubUpdate = null;
    this.unsubResponse?.();
    this.unsubResponse = null;

    // Cancel and reject every inflight request
    for (const [key, entry] of this.inflight) {
      if (entry.timerId !== undefined) this.timers.clearTimeout(entry.timerId);
      // Signal abortHandler is cleaned by the settle guard inside entry.reject:
      // dispose rejection triggers settle, which prevents any later signal
      // from double-firing.
      // Emit cancel
      try {
        const parsed = JSON.parse(key) as [string, string, string];
        this.bus.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
          version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
          requestId: parsed[0],
          ownerRunId: parsed[1],
          nodeId: parsed[2],
        } satisfies SubagentDelegationV2Cancel);
      } catch {
        // Best-effort
      }
      entry.reject(new Error("delegation adapter disposed"));
    }

    this.inflight.clear();
    this.inflightByRequestId.clear();
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  private onStarted = (_payload: unknown): void => {
    // Started events are informational; no action needed.
    void _payload;
  };

  private onUpdate = (payload: unknown): void => {
    const update = payload as SubagentDelegationV2Update;
    if (!update?.requestId || !update?.ownerRunId || !update?.nodeId) return;
    const key = identityKey(update);
    const entry = this.inflight.get(key);
    if (!entry?.onUpdate) return;
    entry.onUpdate(update);
  };

  private onResponse = (payload: unknown): void => {
    const response = payload as SubagentDelegationV2Response;
    if (!response?.requestId) return;

    // Try primary (full tuple) correlation first, then secondary
    // (requestId-only) for partial invalid_request responses that
    // may omit ownerRunId/nodeId per protocol.
    let entry: ReturnType<typeof this.inflight.get> | undefined;
    let knownIdentity: SubagentDelegationV2Started | undefined;

    if (response.ownerRunId && response.nodeId) {
      const key = identityKey(response as SubagentDelegationV2Started);
      entry = this.inflight.get(key);
      if (entry) knownIdentity = response as SubagentDelegationV2Started;
    }

    if (!entry) {
      const key = this.inflightByRequestId.get(response.requestId);
      if (key) {
        entry = this.inflight.get(key);
        if (entry) {
          // Reconstruct known identity from stored tuple key
          try {
            const parsed = JSON.parse(key) as [string, string, string];
            knownIdentity = {
              version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
              requestId: parsed[0],
              ownerRunId: parsed[1],
              nodeId: parsed[2],
            };
          } catch {
            return;
          }
        }
      }
    }

    if (!entry || !knownIdentity) return;

    if (response.status === "invalid_request") {
      // Invalid requests resolve (not reject) per protocol: they are terminal
      // responses. Resolve with the known identity preserved and status
      // normalized to "failed" so the caller always receives a
      // SubagentDelegationV2TerminalResponse.
      entry.resolve({
        version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
        requestId: knownIdentity.requestId,
        ownerRunId: knownIdentity.ownerRunId,
        nodeId: knownIdentity.nodeId,
        status: "failed",
        error: response.error ?? "invalid_request",
      });
      return;
    }

    entry.resolve(response as SubagentDelegationV2TerminalResponse);
  };

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emitCancel(identity: SubagentDelegationV2Started): void {
    const cancel: SubagentDelegationV2Cancel = {
      version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
      requestId: identity.requestId,
      ownerRunId: identity.ownerRunId,
      nodeId: identity.nodeId,
    };
    this.bus.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, cancel);
  }

  private cancelledResponse(
    identity: SubagentDelegationV2Started,
  ): SubagentDelegationV2TerminalResponse {
    return {
      version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
      requestId: identity.requestId,
      ownerRunId: identity.ownerRunId,
      nodeId: identity.nodeId,
      status: "cancelled",
    };
  }
}
