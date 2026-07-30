import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCommands, renderSchedulerStatus } from "../src/commands/register.ts";
import type { LabConfig } from "../src/types.ts";

// ── Minimal mock pi / ctx ───────────────────────────────────────────

interface NotifyCall {
  message: string;
  level: string;
}

function mockPi() {
  const notifies: NotifyCall[] = [];
  let handler: ((args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => void | Promise<void>) | undefined;

  return {
    notifies,
    handler: () => handler!,
    pi: {
      registerCommand(_name: string, opts: { handler: typeof handler }) {
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
    weights: { completion: 1, costEffectiveness: 1, performance: 1, benchmark: 1 },
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
      settlement: { tax: 0.1, errorMode: "stakeOnly" },
      cost: { tokenMult: 1, toolMult: 1, latencyMult: 1, resourceFactor: 1, toolWeights: {} },
      bidding: { timeoutMs: 5000, promptTemplate: "", maxCallsPerDispatch: 2 },
      market: { staleTaskTimeoutMs: 60000, eligibility: "all", maxBidders: 10, bidderSelector: "topBalance" },
      risk: { maxStakeRatio: 0.5 },
    },
    ...overrides,
  };
}

// ── Placeholder deps (minimal to satisfy registerCommands) ──────────

function placeholderDeps(overrides?: Record<string, unknown>) {
  return {
    store: { aggregateByRole: () => [], listRoles: () => [] } as unknown as Parameters<typeof registerCommands>[1]["store"],
    catalog: { candidates: () => [], refresh: async () => {}, isFresh: true } as unknown as Parameters<typeof registerCommands>[1]["catalog"],
    cfg: defaultCfg(),
    ledger: { leaderboard: () => [], staleTasks: () => [], getTask: () => undefined, recoverStaleTask: () => {}, currentRound: () => 0 } as unknown as Parameters<typeof registerCommands>[1]["ledger"],
    saveConfig: (_c: LabConfig) => {},
    ...overrides,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function findNotify(notifies: NotifyCall[], substr: string, level?: string): NotifyCall | undefined {
  return notifies.find((n) => n.message.includes(substr) && (level === undefined || n.level === level));
}

// ════════════════════════════════════════════════════════════════════
//  Tests: /lab mode — deprecation notice
// ════════════════════════════════════════════════════════════════════

test("/lab mode shows deprecation notice", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg({ mode: "classic" });
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("mode", ctx());

  assert.ok(findNotify(notifies, "模式切换已废弃", "warning"));
  assert.ok(findNotify(notifies, "/lab migrate"));
  assert.ok(findNotify(notifies, "scheduler binding"));
});

test("/lab mode market — same deprecation notice regardless of arg", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg({ mode: "classic" });
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("mode market", ctx());

  assert.ok(findNotify(notifies, "模式切换已废弃", "warning"));
  assert.ok(findNotify(notifies, "/lab migrate"));
});

test("/lab mode classic — same deprecation notice", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg({ mode: "market" });
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("mode classic", ctx());

  assert.ok(findNotify(notifies, "模式切换已废弃", "warning"));
});

// ════════════════════════════════════════════════════════════════════
//  Tests: /lab recommend — deprecation notice
// ════════════════════════════════════════════════════════════════════

test("/lab recommend shows deprecation notice", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("recommend coder", ctx());

  assert.ok(findNotify(notifies, "推荐功能已废弃", "warning"));
  assert.ok(findNotify(notifies, "/lab scheduler status"));
  assert.ok(findNotify(notifies, "/lab optimizer run"));
});

// ════════════════════════════════════════════════════════════════════
//  Tests: /lab market post — deprecation notice
// ════════════════════════════════════════════════════════════════════

test("/lab market post shows deprecation notice", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("market post", ctx());

  assert.ok(findNotify(notifies, "Market post 已废弃", "warning"));
  assert.ok(findNotify(notifies, "catch-all binding"));
});

// ════════════════════════════════════════════════════════════════════
//  Tests: /lab config — dead keys rejected
// ════════════════════════════════════════════════════════════════════

test("/lab config mode — dead key rejected", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config mode market", ctx());

  assert.ok(findNotify(notifies, "已废弃", "error"));
  assert.ok(findNotify(notifies, "/lab migrate"));
});

test("/lab config autoApply — dead key rejected", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config autoApply true", ctx());

  assert.ok(findNotify(notifies, "已废弃", "error"));
  assert.ok(findNotify(notifies, "/lab migrate"));
});

test("/lab config market.* — dead key rejected (endowment.K)", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config endowment.K 200", ctx());

  assert.ok(findNotify(notifies, "已废弃", "error"));
  assert.ok(findNotify(notifies, "/lab migrate"));
});

test("/lab config market.* — dead key rejected (risk.maxStakeRatio)", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config risk.maxStakeRatio 0.3", ctx());

  assert.ok(findNotify(notifies, "已废弃", "error"));
  assert.ok(findNotify(notifies, "/lab migrate"));
});

test("/lab config weights.completion — still accepted", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  let saved = false;
  const deps = placeholderDeps({ cfg, saveConfig: () => { saved = true; } });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config weights.completion 2", ctx());

  assert.ok(findNotify(notifies, "已设置 weights.completion = 2", "info"));
  assert.ok(saved);
});

test("/lab config scheduler.enabled — still accepted", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  let saved = false;
  const deps = placeholderDeps({ cfg, saveConfig: () => { saved = true; } });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config scheduler.enabled true", ctx());

  assert.ok(findNotify(notifies, "已设置 scheduler.enabled = true", "info"));
  assert.ok(saved);
  assert.equal(cfg.scheduler?.enabled, true);
});

test("/lab config topN — still accepted", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  let saved = false;
  const deps = placeholderDeps({ cfg, saveConfig: () => { saved = true; } });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config topN 10", ctx());

  assert.ok(findNotify(notifies, "已设置 topN = 10", "info"));
  assert.ok(saved);
  assert.equal(cfg.topN, 10);
});

test("/lab config unknown key — rejected", async () => {
  const { pi, handler, ctx, notifies } = mockPi();
  const cfg = defaultCfg();
  const deps = placeholderDeps({ cfg });

  registerCommands(pi as Parameters<typeof registerCommands>[0], deps as Parameters<typeof registerCommands>[1]);
  await handler()("config bogus.key foo", ctx());

  assert.ok(findNotify(notifies, "未知配置键: bogus.key", "error"));
});

// ════════════════════════════════════════════════════════════════════
//  Tests: /lab scheduler status with effective routing
// ════════════════════════════════════════════════════════════════════

test("scheduler status — effectiveRouting catch-all displayed", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: true,
    runtimeAvailable: true,
    effectiveRouting: "catch-all → default-market (market)",
  });
  assert.ok(out.includes("Routing: catch-all → default-market (market)"));
  assert.ok(!out.includes("Instance: default-weighted-scorer"));
});

test("scheduler status — effectiveRouting explicit shown", () => {
  const out = renderSchedulerStatus({
    instanceId: "custom-instance",
    enabled: true,
    runtimeAvailable: true,
    effectiveRouting: "explicit → custom-instance (bypasses catch-all)",
  });
  assert.ok(out.includes("Routing: explicit → custom-instance (bypasses catch-all)"));
  assert.ok(!out.includes("Instance: custom-instance"));
});

test("scheduler status — no effectiveRouting shows Instance fallback", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: false,
    runtimeAvailable: false,
  });
  assert.ok(out.includes("Instance: default-weighted-scorer"));
  assert.ok(!out.includes("Routing:"));
});

test("scheduler status — runtime unavailable with effectiveRouting", () => {
  const out = renderSchedulerStatus({
    instanceId: "default-weighted-scorer",
    enabled: true,
    runtimeAvailable: false,
    effectiveRouting: "bootstrap pending",
  });
  assert.ok(out.includes("Routing: bootstrap pending"));
  assert.ok(out.includes("Runtime: unavailable"));
  assert.ok(!out.includes("Instance:"));
});
