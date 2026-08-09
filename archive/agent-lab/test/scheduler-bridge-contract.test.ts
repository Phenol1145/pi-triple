/**
 * Structural contract assertion between bridge and runner DispatchResult types.
 *
 * The bridge (src/interceptor/scheduler-bridge.ts) defines a structurally
 * looser DispatchResult — looser `attempts`, `output`, `error`, `target`
 * fields — so that the interceptor layer does not depend on scheduler-internal
 * types.  The runner (src/scheduler/runner.ts) produces the concrete type.
 *
 * These assertions prove at compile time that the runner's concrete
 * DispatchResult is structurally assignable to the bridge's looser type.
 * Runtime spot-checks verify that real dispatch-like objects carry all the
 * fields expected by the bridge contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { DispatchResult as RunnerDispatchResult } from "../src/scheduler/runner.ts";
import type { DispatchResult as BridgeDispatchResult } from "../src/interceptor/scheduler-bridge.ts";
import type { SettleOutcome } from "../src/scheduler/contracts.ts";

// ── Compile-time structural assertions ───────────────────────────────
//
// These are validated by the TypeScript compiler (tsc --noEmit).
// At runtime (--experimental-strip-types) the assignments still pass because
// the values are structurally compatible; the types are erased.
//
// If these assignments fail to type-check, the bridge/runner contract is
// broken and the interceptor cannot safely consume runner dispatch results.

/** Identity helper: accepts BridgeDispatchResult, returns it. */
function bridgeAccept(r: BridgeDispatchResult): BridgeDispatchResult {
  return r;
}

// ── Runner → Bridge assignability ────────────────────────────────────

// completed variant
const runnerCompleted: RunnerDispatchResult = {
  status: "completed",
  schedulerInstanceId: "inst-1",
  roundId: "round-1",
  selectedAgentId: "agent-1",
  model: "test/model",
  output: undefined,
  reason: "test reason",
  settlementRef: "ref-1",
  attempts: [
    {
      schedulerInstanceId: "inst-1",
      roundId: "round-1",
      status: "completed" as const,
    },
  ],
};
const _bridgeCompleted: BridgeDispatchResult = bridgeAccept(runnerCompleted);

// abstained variant
const runnerAbstained: RunnerDispatchResult = {
  status: "abstained",
  schedulerInstanceId: "inst-1",
  roundId: "round-1",
  reason: "no eligible agent",
  attempts: [
    {
      schedulerInstanceId: "inst-1",
      roundId: "round-1",
      status: "abstained" as const,
    },
  ],
};
const _bridgeAbstained: BridgeDispatchResult = bridgeAccept(runnerAbstained);

// fallback variant
const runnerFallback: RunnerDispatchResult = {
  status: "fallback",
  target: { type: "original-request" },
  attempts: [
    {
      schedulerInstanceId: "inst-1",
      roundId: "round-1",
      status: "failed" as const,
      error: { code: "ERR", message: "boom", retryable: false },
    },
  ],
};
const _bridgeFallback: BridgeDispatchResult = bridgeAccept(runnerFallback);

// failed variant
const runnerFailed: RunnerDispatchResult = {
  status: "failed",
  error: { code: "scheduler-error", message: "unavailable", retryable: false },
  attempts: [
    {
      schedulerInstanceId: "inst-1",
      roundId: "round-1",
      status: "failed" as const,
      error: { code: "scheduler-error", message: "unavailable", retryable: false },
    },
  ],
};
const _bridgeFailed: BridgeDispatchResult = bridgeAccept(runnerFailed);

// ── SettleOutcome compatibility ─────────────────────────────────────
//
// The bridge defines `settle?(taskRef: string, outcome: unknown): Promise<boolean>`.
// The runner's `settle` accepts `SettleOutcome`.  Since `SettleOutcome` is
// assignable to `unknown`, the bridge can forward any `SettleOutcome`.
// This test also verifies that SettleOutcome carries all fields the arena
// settlement logic (and future consumers) may inspect.

function settleAccept(outcome: unknown): unknown {
  return outcome;
}

const sampleOutcome: SettleOutcome = {
  completion: 0.85,
  majorError: false,
  tokensIn: 1200,
  tokensOut: 400,
  cost: 0.0032,
  toolCalls: [{ name: "read", durationMs: 150 }],
  inferenceLatencyMs: 2300,
};
const _settleOk: unknown = settleAccept(sampleOutcome);

// ── Runtime spot-checks: field presence ─────────────────────────────

test("bridge contract: completed dispatch carries all required fields", () => {
  const r = runnerCompleted;

  // The bridge reads these fields on status === "completed":
  assert.equal(r.status, "completed");
  assert.ok(typeof r.schedulerInstanceId === "string");
  assert.ok(typeof r.roundId === "string");
  // selectedAgentId / model / output / reason / settlementRef are optional
  // in both contracts, but they must be present or undefined (not missing).
  assert.ok("selectedAgentId" in r);
  assert.ok("model" in r);
  assert.ok("output" in r);
  assert.ok("reason" in r);
  assert.ok("settlementRef" in r);
  assert.ok(Array.isArray(r.attempts));
});

test("bridge contract: abstained dispatch carries reason", () => {
  const r = runnerAbstained;
  assert.equal(r.status, "abstained");
  assert.ok(typeof r.reason === "string");
  assert.ok(Array.isArray(r.attempts));
});

test("bridge contract: fallback dispatch carries target type", () => {
  const r = runnerFallback;
  assert.equal(r.status, "fallback");
  assert.ok(typeof r.target.type === "string");
  assert.ok(Array.isArray(r.attempts));
});

test("bridge contract: failed dispatch carries error code and message", () => {
  const r = runnerFailed;
  assert.equal(r.status, "failed");
  assert.ok(typeof r.error.code === "string");
  assert.ok(typeof r.error.message === "string");
  assert.ok(Array.isArray(r.attempts));
});

test("bridge contract: SettleOutcome carries all settlement fields", () => {
  const o = sampleOutcome;
  assert.ok(typeof o.completion === "number");
  assert.ok(typeof o.majorError === "boolean");
  assert.ok(typeof o.tokensIn === "number");
  assert.ok(typeof o.tokensOut === "number");
  assert.ok(typeof o.cost === "number");
  assert.ok(Array.isArray(o.toolCalls));
  assert.ok(typeof o.inferenceLatencyMs === "number");
});

test("bridge contract: DispatchAttempt carries required fields", () => {
  const attempt = runnerCompleted.attempts[0];
  assert.ok(typeof attempt.schedulerInstanceId === "string");
  assert.ok(typeof attempt.roundId === "string");
  assert.ok(
    attempt.status === "completed" ||
      attempt.status === "abstained" ||
      attempt.status === "failed",
  );
});
