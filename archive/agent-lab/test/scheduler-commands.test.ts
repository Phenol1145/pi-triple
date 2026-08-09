import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderSchedulerStatus,
  renderSchedulerSelect,
  renderSchedulerSync,
  renderSchedulerEvents,
  renderSchedulerDispatch,
  parseDispatchArgs,
  registerCommands,
} from "../src/commands/register.ts";
import type { LabEvent } from "../src/core/contracts.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function fakeEvent(
  eventType: string,
  ts: number,
  overrides?: Partial<LabEvent>,
): LabEvent {
  return {
    eventId: `evt-${eventType}-${ts}`,
    eventType,
    schemaVersion: "1.0",
    timestamp: ts,
    identity: { traceId: "trace-1" },
    payload: {},
    ...overrides,
  } as LabEvent;
}

// ── Status tests ────────────────────────────────────────────────────

test("scheduler status: disabled, runtime unavailable", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: false,
    runtimeAvailable: false,
  });
  assert.ok(out.includes("Enabled: no"));
  assert.ok(out.includes("Runtime: unavailable"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
});

test("scheduler status: enabled, runtime unavailable", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: true,
    runtimeAvailable: false,
  });
  assert.ok(out.includes("Enabled: yes"));
  assert.ok(out.includes("Runtime: unavailable"));
});

test("scheduler status: ready — full info", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    definitionId: "weighted-scorer",
    definitionVersion: "1.0.0",
    roundId: "round-0",
    agentCount: 5,
    enabled: true,
    runtimeAvailable: true,
  });
  assert.ok(out.includes("Enabled: yes"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
  assert.ok(out.includes("Definition: weighted-scorer@1.0.0"));
  assert.ok(out.includes("Round: round-0"));
  assert.ok(out.includes("Agents: 5"));
  assert.ok(!out.includes("Runtime: unavailable"));
});

test("scheduler status: ready — partial info (no definition)", () => {
  const out = renderSchedulerStatus({
    instanceId: "custom-instance",
    enabled: true,
    runtimeAvailable: true,
    agentCount: 0,
  });
  assert.ok(out.includes("Instance: custom-instance"));
  assert.ok(out.includes("Agents: 0"));
  assert.ok(!out.includes("Definition:"));
  assert.ok(!out.includes("Round:"));
});

test("scheduler status: shows UUID when provided", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    instanceUuid: "550e8400-e29b-41d4-a716-446655440000",
    enabled: true,
    runtimeAvailable: true,
  });
  assert.ok(out.includes("ID: 550e8400-e29b-41d4-a716-446655440000"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
});

test("scheduler status: no UUID line when uuid not provided", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: true,
    runtimeAvailable: true,
    agentCount: 5,
  });
  assert.ok(!out.includes("ID:"));
  assert.ok(out.includes("Instance: default-weighted-scorer"));
});

// ── Select tests ────────────────────────────────────────────────────

test("scheduler select: completed with model", () => {
  const out = renderSchedulerSelect(
    { status: "completed", model: "deepseek/deepseek-v3.2", score: 0.852, reason: "top weighted score" },
    [{ model: { id: "deepseek/deepseek-v3.2" }, score: 0.852, reason: "top weighted score" }],
    "coder",
  );
  assert.ok(out.includes("Selected: deepseek/deepseek-v3.2"));
  assert.ok(out.includes("score=0.852"));
  assert.ok(out.includes("top weighted score"));
  assert.ok(out.includes("Legacy recommendation for coder:"));
  assert.ok(out.includes("Dual-run: MATCH"));
});

test("scheduler select: completed with mismatch", () => {
  const out = renderSchedulerSelect(
    { status: "completed", model: "anthropic/claude", score: 0.9, reason: "pin hit" },
    [{ model: { id: "deepseek/deepseek-v3.2" }, score: 0.852, reason: "top weighted score" }],
    "coder",
  );
  assert.ok(out.includes("Selected: anthropic/claude"));
  assert.ok(out.includes("Dual-run: MISMATCH"));
});

test("scheduler select: abstained", () => {
  const out = renderSchedulerSelect(
    { status: "abstained", reason: "no candidates in population" },
    [],
    "coder",
  );
  assert.ok(out.includes("Scheduler abstained: no candidates in population"));
  assert.ok(out.includes("(no candidates)"));
  assert.ok(!out.includes("Dual-run:"));
});

test("scheduler select: failed", () => {
  const out = renderSchedulerSelect(
    { status: "failed", errorMessage: "round not found" },
    [{ model: { id: "qwen/qwen3-coder" }, score: 0.75, reason: "cold start" }],
    "coder",
  );
  assert.ok(out.includes("Scheduler failed: round not found"));
  assert.ok(out.includes("qwen/qwen3-coder"));
  assert.ok(!out.includes("Dual-run:"));
});

test("scheduler select: fallback", () => {
  const out = renderSchedulerSelect(
    { status: "fallback" },
    [],
    "coder",
  );
  assert.ok(out.includes("fell back to original request"));
});

test("scheduler select: no model in completed result", () => {
  const out = renderSchedulerSelect(
    { status: "completed" },
    [{ model: { id: "deepseek/deepseek-v3.2" }, score: 0.852, reason: "top weighted score" }],
    "coder",
  );
  assert.ok(out.includes("No model selected"));
  assert.ok(!out.includes("Dual-run:"));
  assert.ok(!out.includes("Selected:"));
});

// ── Sync tests ──────────────────────────────────────────────────────

test("scheduler sync: added agents", () => {
  const out = renderSchedulerSync(3);
  assert.ok(out.includes("added 3 new agent(s)"));
});

test("scheduler sync: no additions", () => {
  const out = renderSchedulerSync(0);
  assert.ok(out.includes("up to date"));
  assert.ok(out.includes("0 new agents"));
});

// ── Events tests ────────────────────────────────────────────────────

test("scheduler events: empty", () => {
  const out = renderSchedulerEvents([], 20);
  assert.ok(out.includes("No scheduler events found"));
  assert.ok(out.includes("limit=20"));
});

test("scheduler events: with events", () => {
  const events: LabEvent[] = [
    fakeEvent("scheduling.requested", 1700000000000, {
      identity: { traceId: "abc123def456", schedulerInstanceId: "default-weighted-scorer" },
      payload: { role: "coder" },
    }),
    fakeEvent("scheduler.started", 1700000001000, {
      identity: { traceId: "abc123def456", schedulerInstanceId: "default-weighted-scorer", dispatchId: "disp-001" },
    }),
    fakeEvent("scheduler.completed", 1700000002000, {
      identity: { traceId: "abc123def456", schedulerInstanceId: "default-weighted-scorer" },
      payload: { model: "deepseek/deepseek-v3.2" },
    }),
  ];
  const out = renderSchedulerEvents(events, 20);
  assert.ok(out.includes("Last 3 scheduler events:"));
  assert.ok(out.includes("scheduling.requested"));
  assert.ok(out.includes("scheduler.started"));
  assert.ok(out.includes("scheduler.completed"));
  assert.ok(out.includes("trace=abc123def456"));
  assert.ok(out.includes("instance=default-weighted-scorer"));
});

test("scheduler events: respect limit", () => {
  const events: LabEvent[] = [
    fakeEvent("scheduling.requested", 1700000000000),
    fakeEvent("routing.resolved", 1700000001000),
    fakeEvent("scheduler.started", 1700000002000),
    fakeEvent("scheduler.completed", 1700000003000),
    fakeEvent("fallback.started", 1700000004000),
  ];
  const out = renderSchedulerEvents(events, 3);
  assert.ok(out.includes("Last 3 scheduler events:"));
  assert.ok(!out.includes("scheduling.requested"));
  assert.ok(!out.includes("routing.resolved"));
  assert.ok(out.includes("scheduler.started"));
  assert.ok(out.includes("scheduler.completed"));
  assert.ok(out.includes("fallback.started"));
});

test("scheduler events: empty payload omitted", () => {
  const events: LabEvent[] = [
    fakeEvent("routing.failed", 1700000000000),
  ];
  const out = renderSchedulerEvents(events, 20);
  assert.ok(out.includes("routing.failed"));
  assert.ok(!out.includes("{")); // No JSON appended for empty payload
});

// ── Dispatch arg parsing tests ──────────────────────────────────────

test("dispatch parse: missing role → usage error", () => {
  const r = parseDispatchArgs(["scheduler", "dispatch"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("用法: /lab scheduler dispatch"));
});

test("dispatch parse: role without task → usage error", () => {
  const r = parseDispatchArgs(["scheduler", "dispatch", "coder"]);
  assert.equal(r.ok, false);
});

test("dispatch parse: task segments joined with spaces, flags stripped", () => {
  const r = parseDispatchArgs(["scheduler", "dispatch", "coder", "fix", "login", "bug", "--strategy", "market"]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.args.role, "coder");
    assert.equal(r.args.task, "fix login bug");
    assert.equal(r.args.strategy, "market");
    assert.equal(r.args.agentId, undefined);
  }
});

test("dispatch parse: strategy=direct without --agent → error", () => {
  const r = parseDispatchArgs(["scheduler", "dispatch", "coder", "task", "--strategy", "direct"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("--agent"));
});

test("dispatch parse: direct with --agent ok, flag order independent", () => {
  const r = parseDispatchArgs(["scheduler", "dispatch", "coder", "task", "--agent", "agent-7", "--strategy", "direct"]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.args.strategy, "direct");
    assert.equal(r.args.agentId, "agent-7");
  }
});

test("dispatch parse: weighted without agent ok, no strategy defaults undefined", () => {
  const r = parseDispatchArgs(["scheduler", "dispatch", "coder", "task", "--strategy", "weighted"]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.args.strategy, "weighted");
    assert.equal(r.args.agentId, undefined);
  }
  const noStrategy = parseDispatchArgs(["scheduler", "dispatch", "coder", "task"]);
  assert.ok(noStrategy.ok);
  if (noStrategy.ok) assert.equal(noStrategy.args.strategy, undefined);
});

// ── Dispatch render tests ───────────────────────────────────────────

test("scheduler dispatch render: completed with agent/model/reason", () => {
  const out = renderSchedulerDispatch({
    status: "completed",
    selectedAgentId: "agent-7",
    model: "deepseek/deepseek-v3.2",
    reason: "direct pin",
  });
  assert.ok(out.includes("Scheduler dispatch: completed"));
  assert.ok(out.includes("Agent: agent-7"));
  assert.ok(out.includes("deepseek/deepseek-v3.2"));
  assert.ok(out.includes("direct pin"));
});

test("scheduler dispatch render: completed without agent omits Agent line", () => {
  const out = renderSchedulerDispatch({ status: "completed", model: "qwen/qwen3-coder" });
  assert.ok(out.includes("Scheduler dispatch: completed"));
  assert.ok(!out.includes("Agent:"));
});

test("scheduler dispatch render: abstained with reason", () => {
  const out = renderSchedulerDispatch({ status: "abstained", reason: "no candidates in population" });
  assert.ok(out.includes("Scheduler dispatch: abstained"));
  assert.ok(out.includes("no candidates in population"));
});

test("scheduler dispatch render: failed with error message", () => {
  const out = renderSchedulerDispatch({
    status: "failed",
    error: { code: "round-not-found", message: "round 3 missing" },
  });
  assert.ok(out.includes("Scheduler dispatch: failed"));
  assert.ok(out.includes("round 3 missing"));
});

test("scheduler dispatch render: fallback with target", () => {
  const out = renderSchedulerDispatch({ status: "fallback", target: { type: "original-request" } });
  assert.ok(out.includes("Scheduler dispatch: fallback"));
  assert.ok(out.includes("original-request"));
});

// ── /lab scheduler dispatch command tests ───────────────────────────

interface NotifyCall {
  message: string;
  level: string;
}

type CommandHandler = (
  args: string,
  ctx: { ui: { notify: (msg: string, level: string) => void } },
) => void | Promise<void>;

function mockCommandPi() {
  const notifies: NotifyCall[] = [];
  let handler: CommandHandler | undefined;
  return {
    notifies,
    handler: () => handler!,
    pi: {
      registerCommand(_name: string, opts: { handler: CommandHandler }) {
        handler = opts.handler;
      },
      registerTool(_opts: unknown) {
        // no-op
      },
    },
    ctx() {
      return {
        ui: {
          notify(msg: string, level: string) {
            notifies.push({ message: msg, level });
          },
        },
      };
    },
  };
}

function commandDeps(overrides: Record<string, unknown>) {
  return {
    store: {
      aggregateByRole: () => [],
      listRoles: () => [],
    },
    catalog: {
      candidates: () => [],
      refresh: async () => {},
      isFresh: true,
    },
    cfg: { scheduler: { enabled: true } },
    ledger: {},
    saveConfig: () => {},
    ...overrides,
  } as unknown as Parameters<typeof registerCommands>[1];
}

test("/lab scheduler dispatch — normal path calls runtime.dispatch with parsed args", async () => {
  const { pi, handler, ctx, notifies } = mockCommandPi();
  let dispatchReq: Record<string, unknown> | undefined;
  const deps = commandDeps({
    schedulerRuntime: () => ({
      dispatch: async (req: Record<string, unknown>) => {
        dispatchReq = req;
        return {
          status: "completed",
          schedulerInstanceId: "default-weighted-scorer",
          roundId: "round-0",
          selectedAgentId: "agent-7",
          reason: "direct pin",
          attempts: [],
        };
      },
    }),
  });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps);
  await handler()("scheduler dispatch coder 修复登录 bug --strategy direct --agent agent-7", ctx());

  assert.ok(dispatchReq, "runtime.dispatch should be called");
  assert.equal(dispatchReq!.role, "coder");
  assert.equal(dispatchReq!.task, "修复登录 bug");
  assert.equal(dispatchReq!.strategy, "direct");
  assert.equal(dispatchReq!.agentId, "agent-7");
  assert.equal(dispatchReq!.mode, "execute");
  const info = notifies.find((n) => n.level === "info");
  assert.ok(info, "should notify info");
  assert.ok(info!.message.includes("Scheduler dispatch: completed"));
  assert.ok(info!.message.includes("agent-7"));
});

test("/lab scheduler dispatch — runtime unavailable → error notify", async () => {
  const { pi, handler, ctx, notifies } = mockCommandPi();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    commandDeps({ schedulerRuntime: () => undefined }),
  );

  await handler()("scheduler dispatch coder task", ctx());

  const err = notifies.find((n) => n.level === "error");
  assert.ok(err, "should notify error");
  assert.ok(err!.message.includes("runtime unavailable"));
});

test("/lab scheduler dispatch — missing role → usage error notify", async () => {
  const { pi, handler, ctx, notifies } = mockCommandPi();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    commandDeps({ schedulerRuntime: () => undefined }),
  );

  await handler()("scheduler dispatch", ctx());

  const err = notifies.find((n) => n.level === "error");
  assert.ok(err, "should notify error");
  assert.ok(err!.message.includes("用法: /lab scheduler dispatch"));
});
