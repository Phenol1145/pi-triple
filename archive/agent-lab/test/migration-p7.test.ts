import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/store.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runP7Migration, runP7DryRun } from "../src/migrate.ts";
import type { MigrationDeps, MigrationReport } from "../src/migrate.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-lab-migrate-"));
  return join(dir, "test.db");
}

function cleanup(paths: string[]) {
  for (const p of paths) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function fakeDeps(overrides: Partial<MigrationDeps> & { dbPath: string }): MigrationDeps {
  return {
    cfg: { ...DEFAULT_CONFIG, mode: "classic", autoApply: true },
    store: new SqliteStore(":memory:"),
    ensureArenaBinding: () => ({ ok: true }),
    dbPath: overrides.dbPath,
    now: 1000,
    ...overrides,
  };
}

// ── Happy path ──────────────────────────────────────────────────────

test("migration happy path: legacy config → binding ensured + backup + marker", () => {
  const dbPath = tmpDbPath();
  // Create a real DB file for backup
  writeFileSync(dbPath, "mock-db-content");

  const deps = fakeDeps({
    dbPath,
    cfg: { ...DEFAULT_CONFIG, mode: "market", autoApply: true },
    ensureArenaBinding: () => ({ ok: true }),
  });

  let report: MigrationReport | undefined;
  try {
    report = runP7Migration(deps);
    assert.equal(report.alreadyMigrated, false);

    // detect-legacy step
    const detect = report.steps.find((s) => s.name === "detect-legacy");
    assert.ok(detect);
    assert.equal(detect!.status, "ok");
    assert.ok(detect!.detail!.includes("mode"));
    assert.ok(detect!.detail!.includes("autoApply"));

    // ensure-binding step
    const binding = report.steps.find((s) => s.name === "ensure-binding");
    assert.ok(binding);
    assert.equal(binding!.status, "ok");

    // backup-db step
    const backup = report.steps.find((s) => s.name === "backup-db");
    assert.ok(backup);
    assert.equal(backup!.status, "ok");
    assert.ok(report.backupPath);

    // write-marker step
    const marker = report.steps.find((s) => s.name === "write-marker");
    assert.ok(marker);
    assert.equal(marker!.status, "ok");

    // Verify marker in store
    const config = deps.store.getConfig();
    assert.ok(config["migration.p7.completed"]);
    const parsed = JSON.parse(config["migration.p7.completed"]);
    assert.equal(parsed.ts, 1000);
    assert.ok(typeof parsed.version === "string");

    deps.store.close();
  } finally {
    cleanup([dbPath, `${dbPath}.backup-1000`, ...(report?.backupPath ? [report!.backupPath!] : [])]);
  }
});

// ── Idempotent re-run ───────────────────────────────────────────────

test("idempotent re-run: second run reports alreadyMigrated, no duplicate backup", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content");

  let bindingCalls = 0;
  const deps = fakeDeps({
    dbPath,
    ensureArenaBinding: () => {
      bindingCalls++;
      return { ok: true };
    },
  });

  try {
    // First run
    const report1 = runP7Migration(deps);
    assert.equal(report1.alreadyMigrated, false);
    assert.equal(bindingCalls, 1);

    // Second run: alreadyMigrated, but verify-binding still re-checks
    // (repairs if needed) — steps are check-marker + verify-binding.
    const report2 = runP7Migration(deps);
    assert.equal(report2.alreadyMigrated, true);
    assert.ok(report2.steps[0].detail!.includes("already migrated"));
    assert.equal(report2.steps.length, 2);
    assert.equal(report2.steps[1].name, "verify-binding");
    assert.equal(report2.steps[1].status, "ok");
    assert.equal(bindingCalls, 2);

    deps.store.close();
  } finally {
    cleanup([dbPath, `${dbPath}.backup-1000`]);
  }
});

// ── Dry-run writes nothing ──────────────────────────────────────────

test("dry-run writes nothing", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content");

  const deps = fakeDeps({
    dbPath,
    ensureArenaBinding: () => ({ ok: true }),
    store: new SqliteStore(":memory:"),
  });

  try {
    const report = runP7DryRun(deps);
    assert.equal(report.alreadyMigrated, false);

    // All steps should be "ok" and describe what *would* happen
    assert.ok(report.steps.every((s) => s.status === "ok"));
    assert.equal(report.skipped.length, 0);
    assert.equal(report.backupPath, undefined);

    // Verify no marker was written
    const config = deps.store.getConfig();
    assert.equal(config["migration.p7.completed"], undefined);

    // Verify no backup file was created
    assert.equal(existsSync(`${dbPath}.backup-1000`), false);

    deps.store.close();
  } finally {
    cleanup([dbPath]);
  }
});

// ── Already-migrated detection ──────────────────────────────────────

test("already-migrated detection via marker", () => {
  const store = new SqliteStore(":memory:");
  const markerTs = 1700000000000;
  store.setConfig("migration.p7.completed", JSON.stringify({ ts: markerTs, version: "0.1.0" }));

  const deps = fakeDeps({
    dbPath: tmpDbPath(),
    store,
  });

  const report = runP7Migration(deps);
  assert.equal(report.alreadyMigrated, true);
  assert.ok(report.steps[0].detail!.includes("already migrated"));

  store.close();
});

// ── Dry-run with already-migrated ───────────────────────────────────

test("dry-run with already-migrated reports alreadyMigrated", () => {
  const store = new SqliteStore(":memory:");
  store.setConfig("migration.p7.completed", JSON.stringify({ ts: 3000, version: "0.1.0" }));

  const deps = fakeDeps({
    dbPath: tmpDbPath(),
    store,
  });

  const report = runP7DryRun(deps);
  assert.equal(report.alreadyMigrated, true);

  store.close();
});

// ── Binding failure captured ────────────────────────────────────────

test("binding failure captured as error step", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content");

  const deps = fakeDeps({
    dbPath,
    ensureArenaBinding: () => ({ ok: false, reason: "arena not active" }),
  });

  try {
    const report = runP7Migration(deps);
    assert.equal(report.alreadyMigrated, false);

    const binding = report.steps.find((s) => s.name === "ensure-binding");
    assert.ok(binding);
    assert.equal(binding!.status, "error");
    assert.ok(binding!.detail!.includes("arena not active"));

    // Marker must NOT be written when binding fails — re-run must retry.
    const markerStep = report.steps.find((s) => s.name === "write-marker");
    assert.ok(markerStep);
    assert.equal(markerStep!.status, "error");
    assert.ok(markerStep!.detail!.includes("deferred"));
    assert.equal(deps.store.getConfig()["migration.p7.completed"], undefined);

    deps.store.close();
  } finally {
    cleanup([dbPath, `${dbPath}.backup-1000`]);
  }
});

// ── Binding throws captured ─────────────────────────────────────────

test("binding throws captured as error step", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content");

  const deps = fakeDeps({
    dbPath,
    ensureArenaBinding: () => {
      throw new Error("control plane unavailable");
    },
  });

  try {
    const report = runP7Migration(deps);
    assert.equal(report.alreadyMigrated, false);

    const binding = report.steps.find((s) => s.name === "ensure-binding");
    assert.ok(binding);
    assert.equal(binding!.status, "error");
    assert.ok(binding!.detail!.includes("control plane unavailable"));

    // Marker deferred on binding failure (thrown path).
    assert.equal(deps.store.getConfig()["migration.p7.completed"], undefined);

    deps.store.close();
  } finally {
    cleanup([dbPath, `${dbPath}.backup-1000`]);
  }
});

// ── Already-migrated verifies/repairs binding ────────────────────────

test("already migrated: verify-binding step repairs binding despite marker", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content");

  let bindingCalls = 0;
  const deps = fakeDeps({
    dbPath,
    ensureArenaBinding: () => {
      bindingCalls++;
      return { ok: true };
    },
  });

  try {
    // Pre-seed the marker (simulates a prior run that wrote it).
    deps.store.setConfig("migration.p7.completed", JSON.stringify({ ts: 1, version: "0.1.0" }));

    const report = runP7Migration(deps);
    assert.equal(report.alreadyMigrated, true);
    assert.equal(bindingCalls, 1);

    const verify = report.steps.find((s) => s.name === "verify-binding");
    assert.ok(verify);
    assert.equal(verify!.status, "ok");

    deps.store.close();
  } finally {
    cleanup([dbPath]);
  }
});

test("already migrated: verify-binding failure is reported, not masked", () => {
  const dbPath = tmpDbPath();
  writeFileSync(dbPath, "mock-db-content");

  const deps = fakeDeps({
    dbPath,
    ensureArenaBinding: () => ({ ok: false, reason: "bootstrap-pending" }),
  });

  try {
    deps.store.setConfig("migration.p7.completed", JSON.stringify({ ts: 1, version: "0.1.0" }));

    const report = runP7Migration(deps);
    assert.equal(report.alreadyMigrated, true);

    const verify = report.steps.find((s) => s.name === "verify-binding");
    assert.ok(verify);
    assert.equal(verify!.status, "error");
    assert.ok(verify!.detail!.includes("bootstrap-pending"));

    deps.store.close();
  } finally {
    cleanup([dbPath]);
  }
});

// ── No legacy fields detected ───────────────────────────────────────

test("no legacy fields detected: report still marks detect step ok", () => {
  // Config with mode=classic still has legacy fields
  const deps = fakeDeps({
    dbPath: tmpDbPath(),
    cfg: { ...DEFAULT_CONFIG, mode: "classic", autoApply: true },
  });

  const report = runP7Migration(deps);
  const detect = report.steps.find((s) => s.name === "detect-legacy");
  assert.ok(detect);
  assert.equal(detect!.status, "ok");
  // mode, autoApply, and arena.* are always present in DEFAULT_CONFIG
  assert.ok(detect!.detail!.includes("mode"));
  assert.ok(detect!.detail!.includes("autoApply"));
  assert.ok(detect!.detail!.includes("market.*"));

  deps.store.close();
});
