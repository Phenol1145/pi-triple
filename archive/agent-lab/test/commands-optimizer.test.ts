import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerCommands,
  renderOptimizerList,
  renderOptimizerRun,
  renderOptimizerProposals,
  renderOptimizerDiff,
  renderOptimizerPromote,
  renderOptimizerRollback,
  renderOptimizerValidate,
  renderOptimizerCanaryStart,
  renderOptimizerCanaryStop,
  renderOptimizerCanaryStatus,
  renderOptimizerAutoStatus,
  type OptimizerFacade,
} from "../src/commands/register.ts";
import type { LabConfig } from "../src/types.ts";

// ── Minimal mock pi / ctx ───────────────────────────────────────────

interface NotifyCall {
  message: string;
  level: string;
}

function mockPi() {
  const notifies: NotifyCall[] = [];
  let handler:
    | ((
        args: string,
        ctx: { ui: { notify: (msg: string, level: string) => void } },
      ) => void | Promise<void>)
    | undefined;

  return {
    notifies,
    handler: () => handler!,
    pi: {
      registerCommand(
        _name: string,
        opts: { handler: typeof handler },
      ) {
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

function defaultCfg(overrides?: Partial<LabConfig>): LabConfig {
  return {
    weights: {
      completion: 1,
      costEffectiveness: 1,
      performance: 1,
      benchmark: 1,
    },
    autoApply: false,
    acceptanceScoreMap: {},
    interruptedPenalty: 0,
    toolFailPenalty: 0,
    topN: 5,
    catalogTtlMs: 60000,
    mode: "classic",
    market: {
      endowment: { K: 100, floor: 10 },
      odds: { easy: 1.5, medium: 2.0, hard: 2.5 },
      settlement: {
        tax: 0.1,
        errorMode: "stakeOnly",
      },
      cost: {
        tokenMult: 1,
        toolMult: 1,
        latencyMult: 1,
        resourceFactor: 1,
        toolWeights: {},
      },
      bidding: {
        timeoutMs: 5000,
        promptTemplate: "",
        maxCallsPerDispatch: 2,
      },
      market: {
        staleTaskTimeoutMs: 60000,
        eligibility: "all",
        maxBidders: 10,
        bidderSelector: "topBalance",
      },
      risk: { maxStakeRatio: 0.5 },
    },
    ...overrides,
  };
}

// ── Placeholder deps (minimal to satisfy registerCommands) ──────────

function placeholderDeps(overrides?: Record<string, unknown>) {
  return {
    store: {
      aggregateByRole: () => [],
      listRoles: () => [],
    } as unknown as Parameters<typeof registerCommands>[1]["store"],
    catalog: {
      candidates: () => [],
      refresh: async () => {},
      isFresh: true,
    } as unknown as Parameters<typeof registerCommands>[1]["catalog"],
    cfg: defaultCfg(),
    ledger: {
      leaderboard: () => [],
      staleTasks: () => [],
      getTask: () => undefined,
      recoverStaleTask: () => {},
      currentRound: () => 0,
    } as unknown as Parameters<typeof registerCommands>[1]["ledger"],
    market: {} as unknown as Parameters<typeof registerCommands>[1]["market"],
    saveConfig: (_c: LabConfig) => {},
    ...overrides,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function findNotify(
  notifies: NotifyCall[],
  substr: string,
  level?: string,
): NotifyCall | undefined {
  return notifies.find(
    (n) =>
      n.message.includes(substr) &&
      (level === undefined || n.level === level),
  );
}

// ── Fake optimizer facade ──────────────────────────────────────────

interface FakeFacadeOpts {
  list?: () => Array<{
    instanceId: string;
    definitionId: string;
    definitionVersion: string;
    status: string;
    targetSchedulers: string[];
  }>;
  run?: (
    instanceId: string,
  ) => ReturnType<OptimizerFacade["run"]> | Promise<ReturnType<OptimizerFacade["run"]>>;
  proposals?: (
    schedulerInstanceId?: string,
  ) => ReturnType<OptimizerFacade["proposals"]>;
  diff?: (proposalId: string) => ReturnType<OptimizerFacade["diff"]>;
  promote?: (
    roundId: string,
  ) => ReturnType<OptimizerFacade["promote"]>;
  rollback?: (
    schedulerInstanceId: string,
    targetRoundId: string,
  ) => ReturnType<OptimizerFacade["rollback"]>;
  validate?: (
    proposalId: string,
  ) => ReturnType<OptimizerFacade["validate"]>;
  canaryStart?: (
    roundId: string,
    percent?: number,
  ) => ReturnType<OptimizerFacade["canaryStart"]>;
  canaryStop?: (
    schedulerInstanceId: string,
  ) => ReturnType<OptimizerFacade["canaryStop"]>;
  canaryStatus?: () => ReturnType<OptimizerFacade["canaryStatus"]>;
  autoStatus?: () => ReturnType<OptimizerFacade["autoStatus"]>;
}

function fakeFacade(opts: FakeFacadeOpts = {}): OptimizerFacade {
  return {
    list:
      opts.list ??
      (() => [
        {
          instanceId: "default-weighted-tuner",
          definitionId: "weighted-tuner",
          definitionVersion: "1.0.0",
          status: "active",
          targetSchedulers: ["default-weighted-scorer"],
        },
      ]),
    run:
      opts.run
        ? ((id: string) => {
            const r = opts.run!(id);
            return r instanceof Promise ? r : Promise.resolve(r);
          })
        : ((_id: string) => Promise.resolve({
            kind: "proposal" as const,
            eventId: "evt-run-001",
            proposalId: "prop-001",
            evaluation: {
              summary: "Quality signal triggered",
              metrics: { runs: 42, avgCompletion: 0.85 },
              dataWindow: { since: 1700000000000, until: 1700003600000 },
            },
          })),
    proposals:
      opts.proposals ??
      ((_sid?) => [
        {
          proposalId: "prop-001",
          optimizerInstanceId: "default-weighted-tuner",
          schedulerInstanceId: "default-weighted-scorer",
          status: "pending",
          evaluation: { summary: "Quality signal triggered" },
          candidateRoundId: "round-1",
          createdAt: 1700000000000,
        },
      ]),
    diff:
      opts.diff ??
      ((_pid) => ({
        baseRoundId: "round-0",
        candidateRoundId: "round-cand-1",
        changedPaths: [
          { path: "weights.completion", tunable: true },
          { path: "weights.someBlocked", tunable: false },
        ],
      })),
    promote:
      opts.promote ??
      ((_rid) => ({
        newRoundId: "round-2",
        previousRoundId: "round-1",
      })),
    rollback:
      opts.rollback ??
      ((_sid, _tid) => ({
        newRoundId: "round-3",
        previousRoundId: "round-2",
      })),
    validate:
      opts.validate ??
      ((_pid) => Promise.resolve({
        status: "ok",
        selectionChanged: true,
        currentTop: ["gpt-4o"],
        candidateTop: ["claude-sonnet-4"],
        expectedCompletionDelta: 0.02,
        expectedCostDelta: -0.0005,
        samples: 42,
      })),
    canaryStart:
      opts.canaryStart ??
      ((_rid, _pct) => ({
        ok: true,
        schedulerInstanceId: "default-weighted-scorer",
      })),
    canaryStop:
      opts.canaryStop ??
      ((_sid) => ({ ok: true })),
    canaryStatus:
      opts.canaryStatus ??
      (() => ({
        hasCanary: true,
        canaryRoundId: "round-cand-1",
        canaryPercent: 20,
        schedulerInstanceId: "default-weighted-scorer",
      })),
    autoStatus:
      opts.autoStatus ??
      (() => ({
        config: { shadow: { enabled: false }, canaryPercent: 0 },
        triggerStatus: { runsSinceLast: 3, lastFiredAt: null, fires: 0 },
      })),
  };
}

// ════════════════════════════════════════════════════════════════════
//  Unit tests: render helpers
// ════════════════════════════════════════════════════════════════════

test("renderOptimizerList — empty", () => {
  const out = renderOptimizerList([]);
  assert.ok(out.includes("No optimizer instances found"));
});

test("renderOptimizerList — with instances", () => {
  const out = renderOptimizerList([
    {
      instanceId: "tuner-1",
      definitionId: "weighted-tuner",
      definitionVersion: "1.0.0",
      status: "active",
      targetSchedulers: ["ws-1", "ws-2"],
    },
    {
      instanceId: "tuner-2",
      definitionId: "weighted-tuner",
      definitionVersion: "1.0.0",
      status: "disabled",
      targetSchedulers: [],
    },
  ]);
  assert.ok(out.includes("Optimizer Instances:"));
  assert.ok(out.includes("tuner-1"));
  assert.ok(out.includes("weighted-tuner@1.0.0"));
  assert.ok(out.includes("status=active"));
  assert.ok(out.includes("ws-1, ws-2"));
  assert.ok(out.includes("tuner-2"));
  assert.ok(out.includes("status=disabled"));
});

test("renderOptimizerRun — proposal", () => {
  const out = renderOptimizerRun({
    kind: "proposal",
    eventId: "evt-001",
    proposalId: "prop-001",
    evaluation: {
      summary: "Quality signal triggered",
      metrics: { runs: 42, avgCompletion: 0.852 },
      dataWindow: { since: 1700000000000, until: 1700003600000 },
    },
  });
  assert.ok(out.includes("Optimizer run: proposal"));
  assert.ok(out.includes("event: evt-001"));
  assert.ok(out.includes("proposal: prop-001"));
  assert.ok(out.includes("Quality signal triggered"));
  assert.ok(out.includes("runs=42.000"));
  assert.ok(out.includes("avgCompletion=0.852"));
});

test("renderOptimizerRun — skip", () => {
  const out = renderOptimizerRun({
    kind: "skip",
    reason: "insufficient data",
    eventId: "evt-002",
  });
  assert.ok(out.includes("Optimizer run: skip"));
  assert.ok(out.includes("event: evt-002"));
  assert.ok(out.includes("reason: insufficient data"));
});

test("renderOptimizerRun — fail", () => {
  const out = renderOptimizerRun({
    kind: "fail",
    error: "optimizer threw an exception",
    eventId: "evt-003",
  });
  assert.ok(out.includes("Optimizer run: fail"));
  assert.ok(out.includes("event: evt-003"));
  assert.ok(out.includes("error: optimizer threw an exception"));
});

test("renderOptimizerProposals — empty", () => {
  const out = renderOptimizerProposals([]);
  assert.ok(out.includes("No proposals found"));
});

test("renderOptimizerProposals — with proposals", () => {
  const out = renderOptimizerProposals([
    {
      proposalId: "prop-001",
      optimizerInstanceId: "tuner-1",
      schedulerInstanceId: "ws-1",
      status: "pending",
      evaluation: { summary: "Quality signal" },
      candidateRoundId: "round-cand-1",
      createdAt: 1700000000000,
    },
  ]);
  assert.ok(out.includes("Proposals (1)"));
  assert.ok(out.includes("prop-001"));
  assert.ok(out.includes("status=pending"));
  assert.ok(out.includes("optimizer=tuner-1"));
  assert.ok(out.includes("scheduler=ws-1"));
  assert.ok(out.includes("Quality signal"));
  assert.ok(out.includes("candidate: round-cand-1"));
});

test("renderOptimizerDiff — with changes", () => {
  const out = renderOptimizerDiff({
    baseRoundId: "round-0",
    candidateRoundId: "round-cand-1",
    changedPaths: [
      { path: "weights.completion", tunable: true },
      { path: "weights.blocked", tunable: false },
    ],
  });
  assert.ok(out.includes("Diff: base=round-0"));
  assert.ok(out.includes("candidate=round-cand-1"));
  assert.ok(out.includes("✓ weights.completion"));
  assert.ok(out.includes("✗ weights.blocked"));
});

test("renderOptimizerDiff — no changes", () => {
  const out = renderOptimizerDiff({
    baseRoundId: "round-0",
    changedPaths: [],
  });
  assert.ok(out.includes("no leaf-path changes"));
});

test("renderOptimizerPromote", () => {
  const out = renderOptimizerPromote({
    newRoundId: "round-2",
    previousRoundId: "round-1",
  });
  assert.ok(out.includes("Round promoted: round-1 → round-2"));
  assert.ok(out.includes("previous: round-1"));
  assert.ok(out.includes("new:      round-2"));
});

test("renderOptimizerRollback", () => {
  const out = renderOptimizerRollback({
    newRoundId: "round-3",
    previousRoundId: "round-2",
  });
  assert.ok(out.includes("Round rolled back: round-2 → round-3"));
  assert.ok(out.includes("previous: round-2"));
  assert.ok(out.includes("new:      round-3"));
});

// ════════════════════════════════════════════════════════════════════
//  Integration tests: /lab optimizer commands via mock pi
// ════════════════════════════════════════════════════════════════════

// ── Missing dep (bootstrap pending) ────────────────────────────────

test("/lab optimizer list — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer list", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer run — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer run tuner-1", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer proposals — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer proposals", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer diff — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer diff prop-001", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer promote — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer promote round-1", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer rollback — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer rollback ws-1 round-0", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

// ── list ───────────────────────────────────────────────────────────

test("/lab optimizer list — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer list", ctx());

  assert.ok(findNotify(notifies, "Optimizer Instances:", "info"));
  assert.ok(findNotify(notifies, "default-weighted-tuner"));
  assert.ok(findNotify(notifies, "weighted-tuner@1.0.0"));
  assert.ok(findNotify(notifies, "status=active"));
  assert.ok(findNotify(notifies, "default-weighted-scorer"));
});

test("/lab optimizer list — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      list: () => {
        throw new Error("DB connection lost");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer list", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer list failed: DB connection lost", "error"),
  );
});

// ── run ────────────────────────────────────────────────────────────

test("/lab optimizer run — proposal result", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      run: (id: string) => {
        calledWith = id;
        return {
          kind: "proposal",
          eventId: "evt-run-001",
          proposalId: "prop-001",
          evaluation: {
            summary: "Quality signal triggered",
            metrics: { runs: 42, avgCompletion: 0.85 },
            dataWindow: { since: 1700000000000, until: 1700003600000 },
          },
        };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer run tuner-1", ctx());

  assert.equal(calledWith, "tuner-1");
  assert.ok(findNotify(notifies, "Optimizer run: proposal", "info"));
  assert.ok(findNotify(notifies, "event: evt-run-001"));
  assert.ok(findNotify(notifies, "proposal: prop-001"));
  assert.ok(findNotify(notifies, "Quality signal triggered"));
});

test("/lab optimizer run — skip result", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      run: () => ({
        kind: "skip",
        reason: "insufficient data: only 5 runs",
        eventId: "evt-skip-001",
      }),
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer run tuner-1", ctx());

  assert.ok(findNotify(notifies, "Optimizer run: skip", "info"));
  assert.ok(findNotify(notifies, "reason: insufficient data: only 5 runs"));
});

test("/lab optimizer run — fail result", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      run: () => ({
        kind: "fail",
        error: "optimizer threw: round not found",
        eventId: "evt-fail-001",
      }),
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer run tuner-1", ctx());

  assert.ok(findNotify(notifies, "Optimizer run: fail", "info"));
  assert.ok(findNotify(notifies, "error: optimizer threw: round not found"));
});

test("/lab optimizer run — missing instanceId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer run", ctx());

  assert.ok(
    findNotify(
      notifies,
      "用法: /lab optimizer run <instanceId>",
      "error",
    ),
  );
});

test("/lab optimizer run — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      run: () => {
        throw new Error("instance not found");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer run tuner-1", ctx());

  assert.ok(
    findNotify(
      notifies,
      "Optimizer run failed: instance not found",
      "error",
    ),
  );
});

// ── proposals ──────────────────────────────────────────────────────

test("/lab optimizer proposals — without filter", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      proposals: (sid?: string) => {
        calledWith = sid;
        return [
          {
            proposalId: "prop-001",
            optimizerInstanceId: "tuner-1",
            schedulerInstanceId: "ws-1",
            status: "pending",
            evaluation: { summary: "Q signal" },
            candidateRoundId: "round-cand-1",
            createdAt: 1700000000000,
          },
        ];
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer proposals", ctx());

  assert.equal(calledWith, undefined);
  assert.ok(findNotify(notifies, "Proposals (1):", "info"));
  assert.ok(findNotify(notifies, "prop-001"));
  assert.ok(findNotify(notifies, "status=pending"));
  assert.ok(findNotify(notifies, "Q signal"));
});

test("/lab optimizer proposals — with scheduler filter", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      proposals: (sid?: string) => {
        calledWith = sid;
        return [];
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer proposals ws-1", ctx());

  assert.equal(calledWith, "ws-1");
  assert.ok(findNotify(notifies, "No proposals found"));
});

test("/lab optimizer proposals — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      proposals: () => {
        throw new Error("query timeout");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer proposals", ctx());

  assert.ok(
    findNotify(
      notifies,
      "Optimizer proposals failed: query timeout",
      "error",
    ),
  );
});

// ── diff ───────────────────────────────────────────────────────────

test("/lab optimizer diff — success with tunable marks", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      diff: (pid: string) => {
        calledWith = pid;
        return {
          baseRoundId: "round-0",
          candidateRoundId: "round-cand-1",
          changedPaths: [
            { path: "weights.completion", tunable: true },
            { path: "weights.costEffectiveness", tunable: true },
            { path: "weights.performance", tunable: false },
          ],
        };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer diff prop-001", ctx());

  assert.equal(calledWith, "prop-001");
  assert.ok(findNotify(notifies, "Diff: base=round-0", "info"));
  assert.ok(findNotify(notifies, "✓ weights.completion"));
  assert.ok(findNotify(notifies, "✓ weights.costEffectiveness"));
  assert.ok(findNotify(notifies, "✗ weights.performance"));
});

test("/lab optimizer diff — missing proposalId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer diff", ctx());

  assert.ok(
    findNotify(
      notifies,
      "用法: /lab optimizer diff <proposalId>",
      "error",
    ),
  );
});

test("/lab optimizer diff — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      diff: () => {
        throw new Error("proposal not found");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer diff prop-999", ctx());

  assert.ok(
    findNotify(
      notifies,
      "Optimizer diff failed: proposal not found",
      "error",
    ),
  );
});

// ── promote ────────────────────────────────────────────────────────

test("/lab optimizer promote — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      promote: (rid: string) => {
        calledWith = rid;
        return { newRoundId: "round-2", previousRoundId: "round-1" };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer promote round-1", ctx());

  assert.equal(calledWith, "round-1");
  assert.ok(
    findNotify(notifies, "Round promoted: round-1 → round-2", "info"),
  );
  assert.ok(findNotify(notifies, "previous: round-1"));
  assert.ok(findNotify(notifies, "new:      round-2"));
});

test("/lab optimizer promote — missing roundId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer promote", ctx());

  assert.ok(
    findNotify(
      notifies,
      "用法: /lab optimizer promote <roundId>",
      "error",
    ),
  );
});

test("/lab optimizer promote — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      promote: () => {
        throw new Error("round not in proposed state");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer promote round-99", ctx());

  assert.ok(
    findNotify(
      notifies,
      "Optimizer promote failed: round not in proposed state",
      "error",
    ),
  );
});

// ── rollback ───────────────────────────────────────────────────────

test("/lab optimizer rollback — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledSid: string | undefined;
  let calledTarget: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      rollback: (sid: string, tid: string) => {
        calledSid = sid;
        calledTarget = tid;
        return { newRoundId: "round-3", previousRoundId: "round-2" };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer rollback ws-1 round-0", ctx());

  assert.equal(calledSid, "ws-1");
  assert.equal(calledTarget, "round-0");
  assert.ok(
    findNotify(notifies, "Round rolled back: round-2 → round-3", "info"),
  );
});

test("/lab optimizer rollback — missing args", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer rollback", ctx());

  assert.ok(
    findNotify(
      notifies,
      "用法: /lab optimizer rollback <schedulerInstanceId> <targetRoundId>",
      "error",
    ),
  );
});

test("/lab optimizer rollback — missing targetRoundId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer rollback ws-1", ctx());

  assert.ok(
    findNotify(
      notifies,
      "用法: /lab optimizer rollback <schedulerInstanceId> <targetRoundId>",
      "error",
    ),
  );
});

test("/lab optimizer rollback — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      rollback: () => {
        throw new Error("target round not found");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer rollback ws-1 round-99", ctx());

  assert.ok(
    findNotify(
      notifies,
      "Optimizer rollback failed: target round not found",
      "error",
    ),
  );
});

// ── unknown optimizer subcommand ───────────────────────────────────

test("/lab optimizer — unknown subcommand", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer bogus", ctx());

  assert.ok(
    findNotify(
      notifies,
      "用法: /lab optimizer <list|run|proposals|diff|promote|rollback|validate|canary|auto>",
      "info",
    ),
  );
});

// ── optimizer in top-level usage message ───────────────────────────

test("/lab — usage message includes optimizer", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("bogus", ctx());

  const usage = findNotify(notifies, "用法: /lab <");
  assert.ok(usage, "usage message should exist");
  assert.ok(usage!.message.includes("optimizer"), "usage message should mention optimizer");
});

// ════════════════════════════════════════════════════════════════════
//  New P5b subcommands: validate, canary, auto
// ════════════════════════════════════════════════════════════════════

// ── render helper unit tests ───────────────────────────────────────

test("renderOptimizerValidate — ok", () => {
  const out = renderOptimizerValidate({
    status: "ok",
    selectionChanged: true,
    currentTop: ["gpt-4o", "claude-sonnet-4"],
    candidateTop: ["claude-sonnet-4", "gpt-4o"],
    expectedCompletionDelta: 0.03,
    expectedCostDelta: -0.001,
    samples: 50,
  });
  assert.ok(out.includes("Shadow validation: status=ok"));
  assert.ok(out.includes("selectionChanged: true"));
  assert.ok(out.includes("samples: 50"));
  assert.ok(out.includes("current top: gpt-4o, claude-sonnet-4"));
  assert.ok(out.includes("candidate top: claude-sonnet-4, gpt-4o"));
});

test("renderOptimizerValidate — insufficient-data", () => {
  const out = renderOptimizerValidate({
    status: "insufficient-data",
    selectionChanged: false,
    currentTop: [],
    candidateTop: [],
    expectedCompletionDelta: 0,
    expectedCostDelta: 0,
    samples: 5,
  });
  assert.ok(out.includes("status=insufficient-data"));
});

test("renderOptimizerCanaryStart — ok", () => {
  const out = renderOptimizerCanaryStart({
    ok: true,
    schedulerInstanceId: "ws-1",
    percent: 20,
  });
  assert.ok(out.includes("Canary started"));
  assert.ok(out.includes("ws-1"));
  assert.ok(out.includes("20%"));
});

test("renderOptimizerCanaryStart — fail", () => {
  const out = renderOptimizerCanaryStart({
    ok: false,
    reason: "round not found",
  });
  assert.ok(out.includes("Canary start failed"));
  assert.ok(out.includes("round not found"));
});

test("renderOptimizerCanaryStop — ok", () => {
  const out = renderOptimizerCanaryStop({ ok: true });
  assert.ok(out.includes("Canary stopped"));
});

test("renderOptimizerCanaryStop — fail", () => {
  const out = renderOptimizerCanaryStop({ ok: false, reason: "no canary" });
  assert.ok(out.includes("Canary stop failed"));
  assert.ok(out.includes("no canary"));
});

test("renderOptimizerCanaryStatus — active", () => {
  const out = renderOptimizerCanaryStatus({
    hasCanary: true,
    canaryRoundId: "round-1",
    canaryPercent: 20,
    schedulerInstanceId: "ws-1",
  });
  assert.ok(out.includes("Active canary:"));
  assert.ok(out.includes("round-1"));
  assert.ok(out.includes("20%"));
});

test("renderOptimizerCanaryStatus — none", () => {
  const out = renderOptimizerCanaryStatus({ hasCanary: false });
  assert.ok(out.includes("No active canary found"));
});

test("renderOptimizerAutoStatus — with trigger", () => {
  const out = renderOptimizerAutoStatus({
    config: { shadow: { enabled: false }, canaryPercent: 0 },
    triggerStatus: { runsSinceLast: 3, lastFiredAt: 1700000000000, fires: 1 },
  });
  assert.ok(out.includes("Optimizer auto config:"));
  assert.ok(out.includes("runsSinceLast: 3"));
  assert.ok(out.includes("fires: 1"));
});

// ── validate ───────────────────────────────────────────────────────

test("/lab optimizer validate — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer validate prop-001", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer validate — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      validate: (pid: string) => {
        calledWith = pid;
        return Promise.resolve({
          status: "ok",
          selectionChanged: true,
          currentTop: ["gpt-4o"],
          candidateTop: ["claude-sonnet-4"],
          expectedCompletionDelta: 0.02,
          expectedCostDelta: -0.0005,
          samples: 42,
        });
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer validate prop-001", ctx());

  assert.equal(calledWith, "prop-001");
  assert.ok(findNotify(notifies, "Shadow validation: status=ok", "info"));
  assert.ok(findNotify(notifies, "selectionChanged: true"));
  assert.ok(findNotify(notifies, "samples: 42"));
});

test("/lab optimizer validate — missing proposalId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer validate", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab optimizer validate <proposalId>", "error"),
  );
});

test("/lab optimizer validate — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      validate: () => {
        throw new Error("proposal not found");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer validate prop-999", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer validate failed: proposal not found", "error"),
  );
});

// ── canary start ───────────────────────────────────────────────────

test("/lab optimizer canary start — success with percent", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledRound: string | undefined;
  let calledPercent: number | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      canaryStart: (rid: string, pct?: number) => {
        calledRound = rid;
        calledPercent = pct;
        return { ok: true, schedulerInstanceId: "ws-1" };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary start round-1 30", ctx());

  assert.equal(calledRound, "round-1");
  assert.equal(calledPercent, 30);
  assert.ok(findNotify(notifies, "Canary started", "info"));
  assert.ok(findNotify(notifies, "30%"));
});

test("/lab optimizer canary start — invalid percent", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary start round-1 0", ctx());

  assert.ok(findNotify(notifies, "percent 须为 1-100 的数字", "error"));
});

test("/lab optimizer canary start — missing roundId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary start", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab optimizer canary start <roundId> [percent]", "error"),
  );
});

// ── canary stop ────────────────────────────────────────────────────

test("/lab optimizer canary stop — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledSid: string | undefined;
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      canaryStop: (sid: string) => {
        calledSid = sid;
        return { ok: true };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary stop ws-1", ctx());

  assert.equal(calledSid, "ws-1");
  assert.ok(findNotify(notifies, "Canary stopped", "info"));
});

test("/lab optimizer canary stop — missing sid", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary stop", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab optimizer canary stop <schedulerInstanceId>", "error"),
  );
});

test("/lab optimizer canary stop — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      canaryStop: () => {
        throw new Error("instance not found");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary stop ws-999", ctx());

  assert.ok(
    findNotify(notifies, "Canary stop failed: instance not found", "error"),
  );
});

// ── canary status ──────────────────────────────────────────────────

test("/lab optimizer canary status — active", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary status", ctx());

  assert.ok(findNotify(notifies, "Active canary:", "info"));
  assert.ok(findNotify(notifies, "round-cand-1"));
});

test("/lab optimizer canary status — none", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      canaryStatus: () => ({ hasCanary: false }),
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary status", ctx());

  assert.ok(findNotify(notifies, "No active canary found", "info"));
});

// ── canary unknown subcommand ──────────────────────────────────────

test("/lab optimizer canary — unknown action", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary bogus", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab optimizer canary <start|stop|status>", "info"),
  );
});

// ── auto ───────────────────────────────────────────────────────────

test("/lab optimizer auto — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ optimizerFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer auto", ctx());

  assert.ok(findNotify(notifies, "Optimizer auto config:", "info"));
  assert.ok(findNotify(notifies, "runsSinceLast: 3"));
});

test("/lab optimizer auto — throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    optimizerFacade: fakeFacade({
      autoStatus: () => {
        throw new Error("core not initialized");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer auto", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer auto status failed: core not initialized", "error"),
  );
});

// ── missing dep (bootstrap-pending) for new subcommands ────────────

test("/lab optimizer validate — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer validate prop-001", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer canary start — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary start round-1 20", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer canary stop — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary stop ws-1", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer canary status — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer canary status", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});

test("/lab optimizer auto — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("optimizer auto", ctx());

  assert.ok(
    findNotify(notifies, "Optimizer unavailable (bootstrap pending)", "error"),
  );
});
