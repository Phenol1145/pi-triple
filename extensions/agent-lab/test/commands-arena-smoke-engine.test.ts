/**
 * /lab arena smoke --engine flag — command layer test.
 *
 * Pattern mirrors test/commands-experiment.test.ts: mockPi + registerCommands + invoke handler.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCommands } from "../src/commands/register.ts";
import type { LabConfig } from "../src/types.ts";

// ── Minimal mock ────────────────────────────────────────────────────

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
    topN: 3,
    catalogTtlMs: 21_600_000,
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

// ── Tests ───────────────────────────────────────────────────────────

test("smoke --engine workloop → arenaSmoke called with engine='workloop'", async () => {
  const smokeCalls: Array<{ role: string; engine?: string }> = [];
  const arenaSmoke = async (role: string, _ctx: unknown, engine?: string) => {
    smokeCalls.push({ role, engine });
    return "smoke-output";
  };

  const { pi, handler, ctx } = mockPi();
  const deps = placeholderDeps({ arenaSmoke });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );

  await handler()("arena smoke default --engine workloop", ctx());

  assert.equal(smokeCalls.length, 1);
  assert.equal(smokeCalls[0]!.role, "default");
  assert.equal(smokeCalls[0]!.engine, "workloop");
});

test("smoke --engine model-caller → arenaSmoke called with engine='model-caller'", async () => {
  const smokeCalls: Array<{ role: string; engine?: string }> = [];
  const arenaSmoke = async (role: string, _ctx: unknown, engine?: string) => {
    smokeCalls.push({ role, engine });
    return "smoke-output";
  };

  const { pi, handler, ctx } = mockPi();
  const deps = placeholderDeps({ arenaSmoke });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );

  await handler()("arena smoke default --engine model-caller", ctx());

  assert.equal(smokeCalls.length, 1);
  assert.equal(smokeCalls[0]!.engine, "model-caller");
});

test("smoke without --engine → arenaSmoke called with engine=undefined", async () => {
  const smokeCalls: Array<{ role: string; engine?: string }> = [];
  const arenaSmoke = async (role: string, _ctx: unknown, engine?: string) => {
    smokeCalls.push({ role, engine });
    return "smoke-output";
  };

  const { pi, handler, ctx } = mockPi();
  const deps = placeholderDeps({ arenaSmoke });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );

  await handler()("arena smoke default", ctx());

  assert.equal(smokeCalls.length, 1);
  assert.equal(smokeCalls[0]!.engine, undefined);
});

test("smoke --engine bogus → error notify, arenaSmoke not called", async () => {
  let arenaSmokeCalled = false;
  const arenaSmoke = async () => {
    arenaSmokeCalled = true;
    return "smoke-output";
  };

  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ arenaSmoke });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );

  await handler()("arena smoke default --engine bogus", ctx());

  assert.equal(arenaSmokeCalled, false);
  const err = findNotify(notifies, "--engine 必须是", "error");
  assert.ok(err, `expected error notify with '--engine 必须是' but got: ${JSON.stringify(notifies)}`);
});

test("smoke missing role still caught", async () => {
  let arenaSmokeCalled = false;
  const arenaSmoke = async () => {
    arenaSmokeCalled = true;
    return "smoke-output";
  };

  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ arenaSmoke });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );

  await handler()("arena smoke", ctx());

  assert.equal(arenaSmokeCalled, false);
  const err = findNotify(notifies, "用法:", "error");
  assert.ok(err, "expected usage error");
});

test("smoke with role starting '--' is rejected as missing role", async () => {
  let arenaSmokeCalled = false;
  const arenaSmoke = async () => {
    arenaSmokeCalled = true;
    return "smoke-output";
  };

  const { pi, handler, ctx, notifies } = mockPi();
  const deps = placeholderDeps({ arenaSmoke });
  registerCommands(
    pi as Parameters<typeof registerCommands>[0],
    deps as Parameters<typeof registerCommands>[1],
  );

  await handler()("arena smoke --engine workloop", ctx());

  assert.equal(arenaSmokeCalled, false);
  const err = findNotify(notifies, "用法:", "error");
  assert.ok(err, "expected usage error when role starts with '--'");
});
