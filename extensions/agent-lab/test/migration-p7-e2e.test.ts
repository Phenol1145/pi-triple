import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/store.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runP7Migration, runP7DryRun } from "../src/migrate.ts";
import type { MigrationDeps, MigrationReport } from "../src/migrate.ts";
import type { LabConfig } from "../src/types.ts";
import { decideSchedulerSelection } from "../src/interceptor/scheduler-bridge.ts";
import type { SchedulerBridgeDeps } from "../src/interceptor/scheduler-bridge.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-lab-migrate-e2e-"));
  return join(dir, "test.db");
}

function cleanup(paths: string[]) {
  for (const p of paths) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Legacy-shaped config with mode:market, autoApply, arena.* subtree */
function legacyConfig(): LabConfig {
  return {
    weights: DEFAULT_CONFIG.weights,
    autoApply: true,
    acceptanceScoreMap: DEFAULT_CONFIG.acceptanceScoreMap,
    interruptedPenalty: DEFAULT_CONFIG.interruptedPenalty,
    toolFailPenalty: DEFAULT_CONFIG.toolFailPenalty,
    topN: DEFAULT_CONFIG.topN,
    catalogTtlMs: DEFAULT_CONFIG.catalogTtlMs,
    mode: "market",
    arena: {
      endowment: { K: 100, floor: 0.05 },
      odds: { easy: 1.5, medium: 3.0, hard: 5.0 },
      settlement: { tax: 5, errorMode: "stakeTimesOdds" },
      cost: { tokenMult: 1.0, toolMult: 1.0, latencyMult: 1.0, resourceFactor: 1.0, toolWeights: {} },
      bidding: { timeoutMs: 10000, promptTemplate: "" },
      market: { staleTaskTimeoutMs: 600000, eligibility: "all", maxBidders: 6, bidderSelector: "top-balance" },
    },
    scheduler: { enabled: false },
  };
}

// ── E2E: Legacy config migration ────────────────────────────────────

test("e2e: legacy config → migrate → binding ensured + backup + marker", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content-for-e2e");

  let bindingEnsured = false;
  const deps: MigrationDeps = {
    cfg: legacyConfig(),
    store: new SqliteStore(":memory:"),
    ensureArenaBinding: () => {
      bindingEnsured = true;
      return { ok: true };
    },
    dbPath,
    now: 1700000000000,
  };

  let report: MigrationReport | undefined;
  try {
    report = runP7Migration(deps);

    // Check overall result
    assert.equal(report.alreadyMigrated, false);

    // detect-legacy found all three legacy fields
    const detect = report.steps.find((s) => s.name === "detect-legacy");
    assert.ok(detect);
    assert.equal(detect!.status, "ok");
    assert.ok(detect!.detail!.includes("mode"), "should detect mode");
    assert.ok(detect!.detail!.includes("autoApply"), "should detect autoApply");
    assert.ok(detect!.detail!.includes("arena.*"), "should detect arena.*");

    // Arena catch-all binding ensured
    assert.ok(bindingEnsured, "ensureArenaBinding should have been called");
    const binding = report.steps.find((s) => s.name === "ensure-binding");
    assert.ok(binding);
    assert.equal(binding!.status, "ok");

    // Backup file exists
    const backup = report.steps.find((s) => s.name === "backup-db");
    assert.ok(backup);
    assert.equal(backup!.status, "ok");
    assert.ok(report.backupPath);
    assert.ok(existsSync(report.backupPath), "backup file should exist");
    assert.equal(readFileSync(report.backupPath, "utf-8"), "mock-db-content-for-e2e");

    // Marker written
    const marker = report.steps.find((s) => s.name === "write-marker");
    assert.ok(marker);
    assert.equal(marker!.status, "ok");
    const config = deps.store.getConfig();
    assert.ok(config["migration.p7.completed"]);
    const parsed = JSON.parse(config["migration.p7.completed"]);
    assert.equal(parsed.ts, 1700000000000);
    assert.ok(typeof parsed.version === "string");

    deps.store.close();
  } finally {
    cleanup([dbPath, `${dbPath}.backup-1700000000000`, ...(report?.backupPath ? [report.backupPath] : [])]);
  }
});

// ── E2E: Idempotent re-run ──────────────────────────────────────────

test("e2e: second migration run is idempotent", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content");

  let bindingCalls = 0;
  const deps: MigrationDeps = {
    cfg: legacyConfig(),
    store: new SqliteStore(":memory:"),
    ensureArenaBinding: () => {
      bindingCalls++;
      return { ok: true };
    },
    dbPath,
    now: 1000,
  };

  try {
    // First run
    const report1 = runP7Migration(deps);
    assert.equal(report1.alreadyMigrated, false);
    assert.equal(bindingCalls, 1);

    // Second run: alreadyMigrated, but verify-binding re-checks/repairs
    const report2 = runP7Migration(deps);
    assert.equal(report2.alreadyMigrated, true);
    assert.ok(report2.steps[0].detail!.includes("already migrated"));
    assert.equal(report2.steps.length, 2); // check-marker + verify-binding
    assert.equal(report2.steps[1].name, "verify-binding");
    assert.equal(bindingCalls, 2); // verify calls binding again (idempotent op)

    deps.store.close();
  } finally {
    cleanup([dbPath, `${dbPath}.backup-1000`]);
  }
});

// ── E2E: Dry-run writes nothing ─────────────────────────────────────

test("e2e: dry-run writes nothing (no backup, no marker)", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "dry-run-db-content");

  let bindingEnsured = false;
  const deps: MigrationDeps = {
    cfg: legacyConfig(),
    store: new SqliteStore(":memory:"),
    ensureArenaBinding: () => {
      bindingEnsured = true;
      return { ok: true };
    },
    dbPath,
    now: 2000,
  };

  try {
    const report = runP7DryRun(deps);

    assert.equal(report.alreadyMigrated, false);
    assert.ok(report.steps.every((s) => s.status === "ok"), "all dry-run steps should be ok");
    assert.equal(report.skipped.length, 0);
    assert.equal(report.backupPath, undefined, "dry-run should not create backup");

    // ensureArenaBinding NOT called in dry-run
    assert.equal(bindingEnsured, false);

    // No marker written
    const config = deps.store.getConfig();
    assert.equal(config["migration.p7.completed"], undefined);

    // No backup file created
    assert.equal(existsSync(`${dbPath}.backup-2000`), false);

    deps.store.close();
  } finally {
    cleanup([dbPath]);
  }
});

// ── E2E: Post-migration interceptor = bridge-only ───────────────────

test("e2e: post-migration interceptor — abstain → no rewrite (bridge-only)", async () => {
  // After P7 migration, the interceptor is bridge-only: scheduler
  // dispatches exclusively through decideSchedulerSelection.
  // When the scheduler abstains (no candidates), the result is "skip",
  // meaning no model rewrite — confirming the behavior-diff from plan §0.2.
  const abstainedResult = {
    status: "abstained",
    schedulerInstanceId: "arena-default",
    roundId: "round-0",
    reason: "no eligible bids",
    attempts: [{ schedulerInstanceId: "arena-default", roundId: "round-0", status: "abstained" }],
  };

  const deps: SchedulerBridgeDeps = {
    runtime: () => ({
      dispatch: () => Promise.resolve(abstainedResult) as ReturnType<SchedulerBridgeDeps["runtime"] extends () => infer R ? R extends { dispatch(...args: unknown[]): infer D } ? D : never : never>,
    }),
    modelAllowed: () => true,
  };

  const decision = await decideSchedulerSelection(
    {
      role: "coder",
      task: "implement feature",
      cfg: { ...legacyConfig(), scheduler: { enabled: true } },
    },
    deps,
  );

  // Abstain → skip (no rewrite). This is the documented P7 behavior:
  // bridge abstain/throw/不可用 → 不改写 (host 原模型).
  assert.equal(decision.action, "skip");
  assert.ok((decision as { reason: string }).reason.includes("abstained"));
});

test("e2e: post-migration interceptor — throw → skip (bridge-only, fail-open)", async () => {
  // Scheduler dispatch throws → interceptor skips silently.
  // Verifies the "throw → 不改写" row from plan §0.2.
  const deps: SchedulerBridgeDeps = {
    runtime: () => ({
      dispatch: () => Promise.reject(new Error("scheduler unavailable")),
    }),
    modelAllowed: () => true,
  };

  const decision = await decideSchedulerSelection(
    {
      role: "coder",
      task: "fix bug",
      cfg: { ...legacyConfig(), scheduler: { enabled: true } },
    },
    deps,
  );

  assert.equal(decision.action, "skip");
  assert.ok((decision as { reason: string }).reason.includes("dispatch error"));
});

test("e2e: post-migration interceptor — completed → apply (bridge rewrites)", async () => {
  // Confirm that the bridge DOES rewrite when it gets a valid completed result.
  // Not everything is skip: the "bridge completed→apply" row from §0.2 is "同" (unchanged).
  const completedResult = {
    status: "completed",
    schedulerInstanceId: "arena-default",
    roundId: "round-0",
    model: "deepseek/deepseek-v3.2",
    selectedAgentId: "agent-deepseek-deepseek-v3.2",
    reason: "winning bid",
    attempts: [{ schedulerInstanceId: "arena-default", roundId: "round-0", status: "completed" }],
  };

  const deps: SchedulerBridgeDeps = {
    runtime: () => ({
      dispatch: () => Promise.resolve(completedResult) as ReturnType<SchedulerBridgeDeps["runtime"] extends () => infer R ? R extends { dispatch(...args: unknown[]): infer D } ? D : never : never>,
    }),
    modelAllowed: () => true,
  };

  const decision = await decideSchedulerSelection(
    {
      role: "coder",
      task: "implement feature",
      cfg: { ...legacyConfig(), scheduler: { enabled: true } },
    },
    deps,
  );

  assert.equal(decision.action, "apply");
  assert.equal((decision as { model: string }).model, "deepseek/deepseek-v3.2");
});
