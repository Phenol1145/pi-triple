import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../src/runtime/delegation-v2.ts";
import { PiSubagentsAdapter } from "../src/runtime/pi-subagents-adapter.ts";

// ---------------------------------------------------------------------------
// Fake event bus
// ---------------------------------------------------------------------------

interface EventBus {
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}

function fakeEventBus(): {
  bus: EventBus;
  handlers: Map<string, Array<(payload: unknown) => void>>;
  emitted: Array<{ event: string; payload: unknown }>;
} {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];

  const bus: EventBus = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        }
      };
    },
    emit(event, payload) {
      emitted.push({ event, payload });
      const list = handlers.get(event);
      if (list) {
        for (const h of [...list]) h(payload);
      }
    },
  };

  return { bus, handlers, emitted };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function v2Request(overrides: Partial<SubagentDelegationV2Request> = {}): SubagentDelegationV2Request {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: "req-1",
    ownerRunId: "run-1",
    nodeId: "node-1",
    agent: "test-agent",
    task: "do the thing",
    context: "fresh",
    cwd: "/tmp",
    result: { kind: "text" as const },
    ...overrides,
  };
}

function v2Started(overrides: Partial<SubagentDelegationV2Started> = {}): SubagentDelegationV2Started {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: "req-1",
    ownerRunId: "run-1",
    nodeId: "node-1",
    ...overrides,
  };
}

function v2Response(
  overrides: Partial<SubagentDelegationV2TerminalResponse> & { status: SubagentDelegationV2TerminalResponse["status"] },
): SubagentDelegationV2TerminalResponse {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: "req-1",
    ownerRunId: "run-1",
    nodeId: "node-1",
    status: "completed",
    ...overrides,
  } as SubagentDelegationV2TerminalResponse;
}

function v2Update(overrides: Partial<SubagentDelegationV2Update> = {}): SubagentDelegationV2Update {
  return {
    version: SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
    requestId: "req-1",
    ownerRunId: "run-1",
    nodeId: "node-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: delegate subscribes before emit, exact request, ignores foreign,
//         forwards matching update, resolves matching terminal response
// ---------------------------------------------------------------------------

test("delegate subscribes before emitting request", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const promise = adapter.delegate(v2Request());

  // Request must be emitted
  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  assert.equal(reqs.length, 1);
  assert.deepStrictEqual(reqs[0].payload, v2Request());

  // Clean up
  adapter.dispose();
  // The dispose will reject the promise; catch it
  await promise.catch(() => {});
});

test("delegate emits exact V2 request", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const req = v2Request({ requestId: "exact-req", ownerRunId: "exact-run", nodeId: "exact-node" });
  const promise = adapter.delegate(req);

  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  assert.equal(reqs.length, 1);
  assert.deepStrictEqual(reqs[0].payload, req);

  adapter.dispose();
  await promise.catch(() => {});
});

test("delegate ignores foreign tuple updates and responses", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const updates: SubagentDelegationV2Update[] = [];
  const promise = adapter.delegate(v2Request({ requestId: "mine", ownerRunId: "run-mine", nodeId: "node-mine" }), {
    onUpdate: (u) => updates.push(u),
  });

  // Emit a foreign update
  const foreignUpdate = v2Update({ requestId: "theirs", ownerRunId: "run-theirs", nodeId: "node-theirs" });
  handlers.get(SUBAGENT_DELEGATION_UPDATE_EVENT)?.forEach((h) => h(foreignUpdate));
  assert.equal(updates.length, 0, "foreign update should be ignored");

  // Emit a foreign response — should not resolve our promise
  const foreignResp = v2Response({ status: "completed", requestId: "theirs", ownerRunId: "run-theirs", nodeId: "node-theirs" });
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) => h(foreignResp));

  // Now emit our matching response — should resolve
  const ourResp = v2Response({ status: "completed", requestId: "mine", ownerRunId: "run-mine", nodeId: "node-mine" });
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) => h(ourResp));

  const result = await promise;
  assert.equal(result.status, "completed");
  assert.equal(updates.length, 0);
});

test("delegate forwards matching update to onUpdate", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const updates: SubagentDelegationV2Update[] = [];
  const promise = adapter.delegate(v2Request({ requestId: "u1", ownerRunId: "r1", nodeId: "n1" }), {
    onUpdate: (u) => updates.push(u),
  });

  // Emit a matching update
  const update = v2Update({ requestId: "u1", ownerRunId: "r1", nodeId: "n1", currentTool: "bash" });
  handlers.get(SUBAGENT_DELEGATION_UPDATE_EVENT)?.forEach((h) => h(update));

  assert.equal(updates.length, 1);
  assert.equal(updates[0].currentTool, "bash");

  // Resolve
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "completed", requestId: "u1", ownerRunId: "r1", nodeId: "n1" })),
  );

  await promise;
});

test("delegate resolves matching terminal response", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const promise = adapter.delegate(v2Request({ requestId: "t1", ownerRunId: "r1", nodeId: "n1" }));

  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "completed", requestId: "t1", ownerRunId: "r1", nodeId: "n1", result: { kind: "text", text: "hello" } })),
  );

  const result = await promise;
  assert.equal(result.status, "completed");
  assert.deepStrictEqual(result.result, { kind: "text", text: "hello" });
});

// ---------------------------------------------------------------------------
// Test 2: AbortSignal emits exact cancel payload; terminal cancelled resolves
// ---------------------------------------------------------------------------

test("AbortSignal emits exact cancel payload with four protocol identity fields", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const controller = new AbortController();
  const promise = adapter.delegate(v2Request({ requestId: "abort-1", ownerRunId: "run-abort", nodeId: "node-abort" }), {
    signal: controller.signal,
  });

  controller.abort();

  const cancels = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT);
  assert.equal(cancels.length, 1);
  const cancelPayload = cancels[0].payload as Record<string, unknown>;
  assert.equal(cancelPayload.version, 2);
  assert.equal(cancelPayload.requestId, "abort-1");
  assert.equal(cancelPayload.ownerRunId, "run-abort");
  assert.equal(cancelPayload.nodeId, "node-abort");
  // Must have exactly 4 keys
  assert.deepStrictEqual(Object.keys(cancelPayload).sort(), ["nodeId", "ownerRunId", "requestId", "version"]);

  const result = await promise;
  assert.equal(result.status, "cancelled");

  adapter.dispose();
});

test("AbortSignal after terminal response does not emit cancel", async () => {
  const { bus, handlers, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const controller = new AbortController();
  const promise = adapter.delegate(v2Request({ requestId: "abort2", ownerRunId: "r2", nodeId: "n2" }), {
    signal: controller.signal,
  });

  // Resolve first
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h(v2Response({ status: "completed", requestId: "abort2", ownerRunId: "r2", nodeId: "n2" })),
  );
  await promise;

  // Now abort — should not emit cancel since it's already terminal
  const cancelCountBefore = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT).length;
  controller.abort();
  const cancelCountAfter = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT).length;
  assert.equal(cancelCountAfter, cancelCountBefore);
});

// ---------------------------------------------------------------------------
// Test 3: Duplicate in-flight attempt tuple rejects without emitting
// ---------------------------------------------------------------------------

test("duplicate in-flight requestId rejects with requestId already in flight", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const req = v2Request({ requestId: "dup", ownerRunId: "run-dup", nodeId: "node-dup" });
  const p1 = adapter.delegate(req);

  // Second call with same identity tuple — the requestId check fires first
  // since requestId uniqueness is enforced across all inflight delegations.
  await assert.rejects(
    () => adapter.delegate(v2Request({ requestId: "dup", ownerRunId: "run-dup", nodeId: "node-dup" })),
    { message: /delegation requestId already in flight/ },
  );

  // Only one request emitted
  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  assert.equal(reqs.length, 1);

  adapter.dispose();
  await p1.catch(() => {});
});

// ---------------------------------------------------------------------------
// Test 4: Local transport timeout emits cancel and rejects; late response ignored
// ---------------------------------------------------------------------------

test("local transport timeout emits cancel and rejects with timed out", async () => {
  // Use a fake timer
  let timerCallback: (() => void) | null = null;
  const fakeSetTimeout = (fn: () => void, _ms: number) => {
    timerCallback = fn;
    return {} as unknown as ReturnType<typeof setTimeout>;
  };
  const fakeClearTimeout = () => {
    timerCallback = null;
  };

  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus, {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });

  const promise = adapter.delegate(v2Request({ requestId: "to", ownerRunId: "rto", nodeId: "nto", timeoutMs: 1_000 }), {
    transportTimeoutMs: 1000, // force fast timeout for test
  });

  // Fire the timeout
  assert.ok(timerCallback, "timer should be set");
  timerCallback!();

  const cancels = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT);
  assert.equal(cancels.length, 1);
  assert.equal((cancels[0].payload as Record<string, unknown>).requestId, "to");

  await assert.rejects(
    promise,
    { message: /delegation transport timed out/ },
  );
});

test("late terminal response after timeout is ignored", async () => {
  let timerCallback: (() => void) | null = null;
  const fakeSetTimeout = (fn: () => void, _ms: number) => {
    timerCallback = fn;
    return {} as unknown as ReturnType<typeof setTimeout>;
  };
  const fakeClearTimeout = () => {
    timerCallback = null;
  };

  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus, {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });

  const promise = adapter.delegate(v2Request({ requestId: "late", ownerRunId: "rlate", nodeId: "nlate" }), {
    transportTimeoutMs: 1,
  });

  // Timeout fires
  timerCallback!();
  await assert.rejects(promise, { message: /delegation transport timed out/ });

  // Now a late response arrives — should not throw, and should be a no-op
  assert.doesNotThrow(() => {
    handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
      h(v2Response({ status: "completed", requestId: "late", ownerRunId: "rlate", nodeId: "nlate" })),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: dispose unsubscribes, emits cancel for each inflight, rejects pending
// ---------------------------------------------------------------------------

test("dispose unsubscribes listeners and rejects pending promises", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const promise = adapter.delegate(v2Request({ requestId: "dispose-me", ownerRunId: "rd", nodeId: "nd" }));

  adapter.dispose();

  await assert.rejects(promise, { message: /delegation adapter disposed/ });

  // After dispose, emitted events should not reach adapter listeners
  // Verify by checking that emitting a response does nothing (handler lists should be empty or cleaned)
  const startedHandlers = handlers.get(SUBAGENT_DELEGATION_STARTED_EVENT);
  const updateHandlers = handlers.get(SUBAGENT_DELEGATION_UPDATE_EVENT);
  const responseHandlers = handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT);

  // Our adapter should have unsubscribed its handlers
  // Since our fake bus removes handlers on unsubscribe, the lists should be empty
  assert.equal(startedHandlers?.length ?? 0, 0, "started handlers should be empty");
  assert.equal(updateHandlers?.length ?? 0, 0, "update handlers should be empty");
  assert.equal(responseHandlers?.length ?? 0, 0, "response handlers should be empty");
});

test("dispose emits cancel for each inflight request", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const p1 = adapter.delegate(v2Request({ requestId: "inf-1", ownerRunId: "r-inf-1", nodeId: "n-inf-1" }));
  const p2 = adapter.delegate(v2Request({ requestId: "inf-2", ownerRunId: "r-inf-2", nodeId: "n-inf-2" }));

  adapter.dispose();

  const cancels = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT);
  assert.equal(cancels.length, 2);
  assert.equal((cancels[0].payload as Record<string, unknown>).requestId, "inf-1");
  assert.equal((cancels[1].payload as Record<string, unknown>).requestId, "inf-2");

  await p1.catch(() => {});
  await p2.catch(() => {});
});

test("dispose clears timers and signal handlers", async () => {
  let timerCleared = false;
  const fakeSetTimeout = (_fn: () => void, _ms: number) => {
    return {} as unknown as ReturnType<typeof setTimeout>;
  };
  const fakeClearTimeout = () => {
    timerCleared = true;
  };

  const { bus } = fakeEventBus();
  const controller = new AbortController();
  const adapter = new PiSubagentsAdapter(bus, {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });

  const promise = adapter.delegate(v2Request({ requestId: "tc", ownerRunId: "rtc", nodeId: "ntc" }), {
    signal: controller.signal,
  });

  adapter.dispose();

  assert.equal(timerCleared, true, "timer should be cleared on dispose");

  // Signal removal is tested implicitly: aborting after dispose should not throw
  assert.doesNotThrow(() => controller.abort());

  await promise.catch(() => {});
});

test("cancel emits exact V2 cancel payload", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const promise = adapter.delegate(v2Request({ requestId: "cancel-me", ownerRunId: "rc", nodeId: "nc" }));

  adapter.cancel({ version: 2 as const, requestId: "cancel-me", ownerRunId: "rc", nodeId: "nc" });

  const cancels = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT);
  assert.equal(cancels.length, 1);
  const payload = cancels[0].payload as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(payload).sort(), ["nodeId", "ownerRunId", "requestId", "version"]);
  assert.equal(payload.version, 2);
  assert.equal(payload.requestId, "cancel-me");
  assert.equal(payload.ownerRunId, "rc");
  assert.equal(payload.nodeId, "nc");

  const result = await promise;
  assert.equal(result.status, "cancelled");
});

test("cancel is a no-op for unknown identity tuple", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  // Cancel something that isn't inflight
  assert.doesNotThrow(() =>
    adapter.cancel({ version: 2 as const, requestId: "nope", ownerRunId: "rn", nodeId: "nn" }),
  );

  // No cancel emitted
  const cancels = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT);
  assert.equal(cancels.length, 0);
});

// ---------------------------------------------------------------------------
// Fix round 1 — critical: partial invalid_request, duplicate requestId, already-aborted
// ---------------------------------------------------------------------------

test("partial invalid_request with only requestId resolves via secondary index", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const promise = adapter.delegate(v2Request({ requestId: "partial-ir", ownerRunId: "pir-run", nodeId: "pir-node" }));

  // Emit an invalid_request response that omits ownerRunId and nodeId
  // (protocol-compliant: SubagentDelegationV2InvalidResponse makes them optional)
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h({
      version: 2,
      requestId: "partial-ir",
      status: "invalid_request",
      error: "bad agent name",
    }),
  );

  const result = await promise;
  // Should resolve with known identity preserved, not sit pending until timeout
  assert.equal(result.status, "failed");
  assert.equal(result.requestId, "partial-ir");
  assert.equal(result.ownerRunId, "pir-run");
  assert.equal(result.nodeId, "pir-node");
  assert.equal(result.error, "bad agent name");
});

test("partial invalid_request with requestId+ownerRunId resolves via secondary index", async () => {
  const { bus, handlers } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  const promise = adapter.delegate(v2Request({ requestId: "partial-ir2", ownerRunId: "pir2-run", nodeId: "pir2-node" }));

  // Emit an invalid_request with requestId + ownerRunId but no nodeId
  handlers.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.forEach((h) =>
    h({
      version: 2,
      requestId: "partial-ir2",
      ownerRunId: "pir2-run",
      status: "invalid_request",
      error: "unknown node",
    }),
  );

  const result = await promise;
  assert.equal(result.status, "failed");
  assert.equal(result.requestId, "partial-ir2");
  assert.equal(result.ownerRunId, "pir2-run");
  assert.equal(result.nodeId, "pir2-node");
  assert.equal(result.error, "unknown node");
});

test("duplicate requestId across different ownerRunId/nodeId rejects with requestId already in flight", async () => {
  const { bus, emitted } = fakeEventBus();
  const adapter = new PiSubagentsAdapter(bus);

  // First delegation
  const p1 = adapter.delegate(v2Request({ requestId: "shared-req", ownerRunId: "run-a", nodeId: "node-a" }));

  // Second delegation: same requestId, different tuple — must reject before emitting
  await assert.rejects(
    () => adapter.delegate(v2Request({ requestId: "shared-req", ownerRunId: "run-b", nodeId: "node-b" })),
    { message: /delegation requestId already in flight/ },
  );

  // Only one request emitted
  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  assert.equal(reqs.length, 1);

  adapter.dispose();
  await p1.catch(() => {});
});

test("already-aborted signal resolves with cancelled, emits cancel, no request emitted, timer cleaned", async () => {
  let timerSet = false;
  let timerCleared = false;
  const fakeSetTimeout = (_fn: () => void, _ms: number) => {
    timerSet = true;
    return {} as unknown as ReturnType<typeof setTimeout>;
  };
  const fakeClearTimeout = () => {
    timerCleared = true;
  };

  const { bus, emitted } = fakeEventBus();
  const controller = new AbortController();
  controller.abort(); // already aborted

  const adapter = new PiSubagentsAdapter(bus, {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });

  const promise = adapter.delegate(v2Request({ requestId: "pre-aborted", ownerRunId: "rpa", nodeId: "npa" }), {
    signal: controller.signal,
  });

  // Should resolve immediately (already aborted)
  const result = await promise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.requestId, "pre-aborted");
  assert.equal(result.ownerRunId, "rpa");
  assert.equal(result.nodeId, "npa");

  // Cancel payload must be emitted with exactly 4 fields
  const cancels = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT);
  assert.equal(cancels.length, 1);
  const cancelPayload = cancels[0].payload as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(cancelPayload).sort(), ["nodeId", "ownerRunId", "requestId", "version"]);
  assert.equal(cancelPayload.requestId, "pre-aborted");

  // No request should have been emitted
  const reqs = emitted.filter((e) => e.event === SUBAGENT_DELEGATION_REQUEST_EVENT);
  assert.equal(reqs.length, 0, "no request emitted for already-aborted signal");

  // Timer must have been set and then cleared (no leak)
  assert.equal(timerSet, true, "timer was set");
  assert.equal(timerCleared, true, "timer was cleared — no leak");
});
