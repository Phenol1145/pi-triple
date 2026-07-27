/**
 * /lab experiment command family — command layer tests with fake facade.
 *
 * Mirrors test/commands-optimizer.test.ts pattern:
 * - render helper unit tests
 * - bootstrap-pending (missing dep)
 * - usage errors
 * - facade throws → fail-open
 * - success paths with fake facade
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerCommands,
  renderExperimentCreate,
  renderExperimentRun,
  renderExperimentStatus,
  renderExperimentCompare,
  type ExperimentFacade,
  type ExperimentRunResult,
  type ExperimentStatusResult,
  type ExperimentCompareResult,
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
    arena: {
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

// ── Fake experiment facade ──────────────────────────────────────────

interface FakeExperimentFacadeOpts {
  create?: (
    assignments: Array<{ model: string; strategy: string }>,
  ) => ReturnType<ExperimentFacade["create"]> | Promise<ReturnType<ExperimentFacade["create"]>>;
  run?: (
    instanceId: string,
    task: string,
    cmdCtx: unknown,
    labels?: { strategy?: string; assignmentIndex?: number },
  ) => ReturnType<ExperimentFacade["run"]> | Promise<ReturnType<ExperimentFacade["run"]>>;
  status?: (instanceId: string) => ExperimentStatusResult;
  compare?: (instanceId: string, opts?: { roundId?: string; byRound?: boolean }) => ExperimentCompareResult;
}

function fakeFacade(opts: FakeExperimentFacadeOpts = {}): ExperimentFacade {
  return {
    create:
      opts.create
        ? ((a: Parameters<ExperimentFacade["create"]>[0]) => {
            const r = opts.create!(a);
            return r instanceof Promise ? r : Promise.resolve(r);
          })
        : ((_a) =>
            Promise.resolve({
              instanceId: "context-experiment",
              roundId: "round-1",
              agentIds: [
                "agent-openai__gpt-4o-default",
                "agent-openai__gpt-4o-budgeted-history",
                "agent-openai__gpt-4o-selective-summary",
              ],
            })),
    run:
      opts.run
        ? ((...args: Parameters<ExperimentFacade["run"]>) => {
            const r = opts.run!(...args);
            return r instanceof Promise ? r : Promise.resolve(r);
          })
        : ((_iid, _task, _ctx, _labels) =>
            Promise.resolve({
              status: "completed" as const,
              model: "openai/gpt-4o",
              strategy: "default",
              agentId: "agent-openai__gpt-4o-default",
              output: "Hello from experiment!",
              usage: {
                input: 50,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.0004,
                turns: 1,
                durationMs: 1200,
                source: "observed" as const,
              },
            })),
    status:
      opts.status ??
      ((_iid) => ({
        instanceId: "context-experiment",
        status: "active",
        definitionId: "context-experiment",
        definitionVersion: "1.0.0",
        roundId: "round-1",
        agents: [
          {
            id: "agent-openai__gpt-4o-default",
            model: "openai/gpt-4o",
            strategy: "default",
            status: "ready",
          },
          {
            id: "agent-openai__gpt-4o-budgeted-history",
            model: "openai/gpt-4o",
            strategy: "budgeted-history",
            status: "ready",
          },
        ],
      })),
    compare:
      opts.compare ??
      ((_iid, _opts) => ({
        available: false,
        reason: "projection pending",
      })),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Unit tests: render helpers
// ═══════════════════════════════════════════════════════════════════

test("renderExperimentCreate — shows instance and agents", () => {
  const out = renderExperimentCreate({
    instanceId: "context-experiment",
    roundId: "round-1",
    agentIds: ["agent-openai__gpt-4o-default", "agent-openai__gpt-4o-budgeted-history"],
  });
  assert.ok(out.includes("Experiment instance created: context-experiment"));
  assert.ok(out.includes("round: round-1"));
  assert.ok(out.includes("agents (2):"));
  assert.ok(out.includes("agent-openai__gpt-4o-default"));
  assert.ok(out.includes("agent-openai__gpt-4o-budgeted-history"));
});

test("renderExperimentRun — completed", () => {
  const out = renderExperimentRun({
    status: "completed",
    model: "openai/gpt-4o",
    strategy: "budgeted-history",
    agentId: "agent-openai__gpt-4o-budgeted-history",
    output: "Task completed successfully.",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0025,
      turns: 1,
      durationMs: 800,
      source: "observed",
    },
  });
  assert.ok(out.includes("Experiment run: completed"));
  assert.ok(out.includes("model: openai/gpt-4o"));
  assert.ok(out.includes("strategy: budgeted-history"));
  assert.ok(out.includes("agent: agent-openai__gpt-4o-budgeted-history"));
  assert.ok(out.includes("Task completed successfully."));
  assert.ok(out.includes("input=100"));
  assert.ok(out.includes("output=50"));
  assert.ok(out.includes("cost=0.002500"));
  assert.ok(out.includes("source=observed"));
});

test("renderExperimentRun — long output truncated", () => {
  const long = "x".repeat(300);
  const out = renderExperimentRun({
    status: "completed",
    model: "m",
    strategy: "default",
    output: long,
  });
  assert.ok(out.includes("..."));
  assert.ok(!out.includes("x".repeat(300)));
});

test("renderExperimentRun — abstained", () => {
  const out = renderExperimentRun({
    status: "abstained",
    error: "no assignments configured",
  });
  assert.ok(out.includes("Experiment run: abstained"));
  assert.ok(out.includes("reason: no assignments configured"));
});

test("renderExperimentRun — failed", () => {
  const out = renderExperimentRun({
    status: "failed",
    error: "instance not found",
  });
  assert.ok(out.includes("Experiment run: failed"));
  assert.ok(out.includes("error: instance not found"));
});

test("renderExperimentStatus — active instance", () => {
  const out = renderExperimentStatus({
    instanceId: "context-experiment",
    status: "active",
    definitionId: "context-experiment",
    definitionVersion: "1.0.0",
    roundId: "round-1",
    agents: [
      { id: "agent-m-default", model: "m", strategy: "default", status: "ready" },
      { id: "agent-m-budgeted-history", model: "m", strategy: "budgeted-history", status: "ready" },
    ],
  });
  assert.ok(out.includes("Experiment: context-experiment"));
  assert.ok(out.includes("status: active"));
  assert.ok(out.includes("definition: context-experiment@1.0.0"));
  assert.ok(out.includes("round: round-1"));
  assert.ok(out.includes("agents (2):"));
  assert.ok(out.includes("agent-m-default"));
  assert.ok(out.includes("strategy=default"));
});

test("renderExperimentStatus — not found", () => {
  const out = renderExperimentStatus({
    instanceId: "missing-instance",
    status: "not-found",
    definitionId: "",
    definitionVersion: "",
    roundId: "",
    agents: [],
  });
  assert.ok(out.includes("Experiment instance not found: missing-instance"));
});

test("renderExperimentCompare — unavailable", () => {
  const out = renderExperimentCompare({
    available: false,
    reason: "projection pending",
  });
  assert.ok(out.includes("Experiment comparison unavailable: projection pending"));
});

test("renderExperimentCompare — available", () => {
  const out = renderExperimentCompare({
    available: true,
    data: { mode: "single", projection: { default: { cost: 0.01 } } },
  });
  assert.ok(out.includes("Experiment comparison:"));
  assert.ok(out.includes('"cost": 0.01'));
});

// ═══════════════════════════════════════════════════════════════════
//  Integration tests: /lab experiment commands via mock pi
// ═══════════════════════════════════════════════════════════════════

// ── Missing dep (bootstrap pending) ────────────────────────────────

test("/lab experiment create — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment create openai/gpt-4o default", ctx());

  assert.ok(
    findNotify(notifies, "Experiment unavailable (bootstrap pending)", "error"),
  );
});

test("/lab experiment run — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1 hello world", ctx());

  assert.ok(
    findNotify(notifies, "Experiment unavailable (bootstrap pending)", "error"),
  );
});

test("/lab experiment status — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment status ctx-exp-1", ctx());

  assert.ok(
    findNotify(notifies, "Experiment unavailable (bootstrap pending)", "error"),
  );
});

test("/lab experiment compare — missing dep", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare ctx-exp-1", ctx());

  assert.ok(
    findNotify(notifies, "Experiment unavailable (bootstrap pending)", "error"),
  );
});

// ── create ─────────────────────────────────────────────────────────

test("/lab experiment create — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: Array<{ model: string; strategy: string }> | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      create: (assignments) => {
        calledWith = assignments;
        return Promise.resolve({
          instanceId: "ctx-exp-1",
          roundId: "round-1",
          agentIds: ["agent-m-default", "agent-m-budgeted-history"],
        });
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment create openai/gpt-4o default budgeted-history", ctx());

  assert.ok(calledWith);
  assert.equal(calledWith!.length, 2);
  assert.equal(calledWith![0].model, "openai/gpt-4o");
  assert.equal(calledWith![0].strategy, "default");
  assert.equal(calledWith![1].strategy, "budgeted-history");
  assert.ok(findNotify(notifies, "Experiment instance created: ctx-exp-1", "info"));
});

test("/lab experiment create — missing args", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment create", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab experiment create <model> <strategy>", "error"),
  );
});

test("/lab experiment create — invalid strategies", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment create openai/gpt-4o bogus-strategy", ctx());

  assert.ok(
    findNotify(notifies, "未知策略: bogus-strategy", "error"),
  );
});

test("/lab experiment create — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      create: () => {
        throw new Error("DB connection lost");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment create openai/gpt-4o default", ctx());

  assert.ok(
    findNotify(notifies, "Experiment create failed: DB connection lost", "error"),
  );
});

// ── run ────────────────────────────────────────────────────────────

test("/lab experiment run — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledInstance: string | undefined;
  let calledTask: string | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      run: (iid, task, _ctx, _labels) => {
        calledInstance = iid;
        calledTask = task;
        return Promise.resolve({
          status: "completed" as const,
          model: "openai/gpt-4o",
          strategy: "default",
          agentId: "agent-openai__gpt-4o-default",
          output: "Hello!",
          usage: {
            input: 50,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.0004,
            turns: 1,
            durationMs: 800,
            source: "observed" as const,
          },
        });
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1 hello world", ctx());

  assert.equal(calledInstance, "ctx-exp-1");
  assert.equal(calledTask, "hello world");
  assert.ok(findNotify(notifies, "Experiment run: completed", "info"));
  assert.ok(findNotify(notifies, "model: openai/gpt-4o"));
  assert.ok(findNotify(notifies, "strategy: default"));
});

test("/lab experiment run — abstained", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      run: () =>
        Promise.resolve({
          status: "abstained" as const,
          error: "no assignments configured",
        }),
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1 test", ctx());

  assert.ok(findNotify(notifies, "Experiment run: abstained", "info"));
  assert.ok(findNotify(notifies, "reason: no assignments configured"));
});

test("/lab experiment run — failed", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      run: () =>
        Promise.resolve({
          status: "failed" as const,
          error: "instance not found",
        }),
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1 test", ctx());

  assert.ok(findNotify(notifies, "Experiment run: failed", "error"));
  assert.ok(findNotify(notifies, "error: instance not found"));
});

test("/lab experiment run — with --strategy flag", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledLabels: { strategy?: string; assignmentIndex?: number } | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      run: (_iid, _task, _ctx, labels) => {
        calledLabels = labels;
        return Promise.resolve({
          status: "completed" as const,
          model: "m",
          strategy: labels?.strategy ?? "default",
        });
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1 some task --strategy budgeted-history", ctx());

  assert.ok(calledLabels);
  assert.equal(calledLabels!.strategy, "budgeted-history");
});

test("/lab experiment run — with --index flag", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledLabels: { strategy?: string; assignmentIndex?: number } | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      run: (_iid, _task, _ctx, labels) => {
        calledLabels = labels;
        return Promise.resolve({
          status: "completed" as const,
          model: "m",
          strategy: "default",
        });
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1 some task --index 1", ctx());

  assert.ok(calledLabels);
  assert.equal(calledLabels!.assignmentIndex, 1);
});

test("/lab experiment run — flags stripped from task string", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledTask: string | undefined;
  let calledLabels: { strategy?: string; assignmentIndex?: number } | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      run: (_iid, task, _ctx, labels) => {
        calledTask = task;
        calledLabels = labels;
        return Promise.resolve({
          status: "completed" as const,
          model: "m",
          strategy: "default",
        });
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );

  // --strategy flag present
  await handler()("experiment run ctx-exp-1 some task --strategy budgeted-history", ctx());
  assert.equal(calledTask, "some task");
  assert.equal(calledLabels!.strategy, "budgeted-history");

  // --index flag present
  await handler()("experiment run ctx-exp-1 another task here --index 2", ctx());
  assert.equal(calledTask, "another task here");
  assert.equal(calledLabels!.assignmentIndex, 2);

  // Both flags present
  await handler()("experiment run ctx-exp-1 complex task --strategy selective-summary --index 0", ctx());
  assert.equal(calledTask, "complex task");
  assert.equal(calledLabels!.strategy, "selective-summary");
  assert.equal(calledLabels!.assignmentIndex, 0);
});

test("/lab experiment run — missing instanceId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab experiment run <instanceId> <task>", "error"),
  );
});

test("/lab experiment run — missing task", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab experiment run <instanceId> <task>", "error"),
  );
});

test("/lab experiment run — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      run: () => {
        throw new Error("runtime unavailable");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment run ctx-exp-1 test", ctx());

  assert.ok(
    findNotify(notifies, "Experiment run failed: runtime unavailable", "error"),
  );
});

// ── status ─────────────────────────────────────────────────────────

test("/lab experiment status — success", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledWith: string | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      status: (iid) => {
        calledWith = iid;
        return {
          instanceId: "ctx-exp-1",
          status: "active",
          definitionId: "context-experiment",
          definitionVersion: "1.0.0",
          roundId: "round-1",
          agents: [
            { id: "agent-m-default", model: "m", strategy: "default", status: "ready" },
          ],
        };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment status ctx-exp-1", ctx());

  assert.equal(calledWith, "ctx-exp-1");
  assert.ok(findNotify(notifies, "Experiment: ctx-exp-1", "info"));
  assert.ok(findNotify(notifies, "status: active"));
  assert.ok(findNotify(notifies, "definition: context-experiment@1.0.0"));
});

test("/lab experiment status — not found", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      status: () => ({
        instanceId: "missing",
        status: "not-found",
        definitionId: "",
        definitionVersion: "",
        roundId: "",
        agents: [],
      }),
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment status missing", ctx());

  assert.ok(findNotify(notifies, "Experiment instance not found: missing"));
});

test("/lab experiment status — missing instanceId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment status", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab experiment status <instanceId>", "error"),
  );
});

test("/lab experiment status — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      status: () => {
        throw new Error("DB error");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment status ctx-exp-1", ctx());

  assert.ok(
    findNotify(notifies, "Experiment status failed: DB error", "error"),
  );
});

// ── compare ────────────────────────────────────────────────────────

test("/lab experiment compare — projection pending", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare ctx-exp-1", ctx());

  assert.ok(
    findNotify(notifies, "Experiment comparison unavailable: projection pending", "warning"),
  );
});

test("/lab experiment compare — available", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      compare: () => ({
        available: true,
        data: { mode: "single", projection: { default: { cost: 0.01, runs: 3 } } },
      }),
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare ctx-exp-1", ctx());

  assert.ok(findNotify(notifies, "Experiment comparison:", "info"));
  assert.ok(findNotify(notifies, '"cost": 0.01'));
});

test("/lab experiment compare — --round flag parsed and forwarded", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledOpts: { roundId?: string; byRound?: boolean } | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      compare: (_iid, opts) => {
        calledOpts = opts;
        return {
          available: true,
          data: { mode: "single", projection: { default: { cost: 0.01 } } },
        };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare ctx-exp-1 --round round-5", ctx());

  assert.ok(calledOpts);
  assert.equal(calledOpts!.roundId, "round-5");
  assert.equal(calledOpts!.byRound, false);
  assert.ok(findNotify(notifies, "Experiment comparison:", "info"));
});

test("/lab experiment compare — --rounds flag parsed and forwarded", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledOpts: { roundId?: string; byRound?: boolean } | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      compare: (_iid, opts) => {
        calledOpts = opts;
        return {
          available: true,
          data: { mode: "byRound", rounds: { "round-1": { cost: 0.01 }, "round-2": { cost: 0.02 } } },
        };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare ctx-exp-1 --rounds", ctx());

  assert.ok(calledOpts);
  assert.equal(calledOpts!.roundId, undefined);
  assert.equal(calledOpts!.byRound, true);
  assert.ok(findNotify(notifies, "Experiment comparison by round (2 rounds):", "info"));
  assert.ok(findNotify(notifies, "## Round: round-1"));
  assert.ok(findNotify(notifies, "## Round: round-2"));
});

test("/lab experiment compare — --round and --rounds together (--rounds wins render, opts both passed)", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  let calledOpts: { roundId?: string; byRound?: boolean } | undefined;
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      compare: (_iid, opts) => {
        calledOpts = opts;
        return {
          available: true,
          data: { mode: "byRound", rounds: { "round-5": { cost: 0.01 } } },
        };
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare ctx-exp-1 --round round-5 --rounds", ctx());

  assert.ok(calledOpts);
  assert.equal(calledOpts!.roundId, "round-5");
  assert.equal(calledOpts!.byRound, true);
  assert.ok(findNotify(notifies, "Experiment comparison by round (1 rounds):", "info"));
});

test("/lab experiment compare — missing instanceId", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab experiment compare <instanceId>", "error"),
  );
});

test("/lab experiment compare — facade throws → fail-open", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({
    experimentFacade: fakeFacade({
      compare: () => {
        throw new Error("core not initialized");
      },
    }),
  });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment compare ctx-exp-1", ctx());

  assert.ok(
    findNotify(notifies, "Experiment compare failed: core not initialized", "error"),
  );
});

// ── unknown subcommand ─────────────────────────────────────────────

test("/lab experiment — unknown subcommand", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ experimentFacade: fakeFacade() });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("experiment bogus", ctx());

  assert.ok(
    findNotify(notifies, "用法: /lab experiment <create|run|status|compare>", "info"),
  );
});

// ── experiment in top-level usage message ──────────────────────────

test("/lab — usage message includes experiment", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps();
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );
  await handler()("bogus", ctx());

  const usage = findNotify(notifies, "用法: /lab <");
  assert.ok(usage, "usage message should exist");
  assert.ok(usage!.message.includes("experiment"), "usage message should mention experiment");
});
