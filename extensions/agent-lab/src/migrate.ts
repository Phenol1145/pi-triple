import type { LabConfig } from "./types.ts";
import type { Store } from "./store/store.ts";
import { copyFileSync, existsSync, statSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────

export interface MigrationDeps {
  cfg: LabConfig;
  store: Store;
  ensureArenaBinding: () => { ok: boolean; reason?: string };
  dbPath: string;
  now?: number;
}

export interface MigrationStep {
  name: string;
  status: "ok" | "skipped" | "error";
  detail?: string;
}

export interface MigrationReport {
  steps: MigrationStep[];
  skipped: MigrationStep[];
  backupPath?: string;
  alreadyMigrated: boolean;
}

const MARKER_KEY = "migration.p7.completed";

// ── Detection ───────────────────────────────────────────────────────

function detectLegacyConfig(cfg: LabConfig): string[] {
  const found: string[] = [];
  // mode is a legacy config field relevant for migration
  if (cfg.mode !== undefined) found.push("mode");
  // autoApply is a legacy config field
  if (cfg.autoApply !== undefined) found.push("autoApply");
  // arena subtree (market, bidding, etc.) is legacy
  if (cfg.arena) found.push("arena.*");
  return found;
}

// ── Main ────────────────────────────────────────────────────────────

export function runP7Migration(deps: MigrationDeps): MigrationReport {
  const { cfg, store, ensureArenaBinding, dbPath, now = Date.now() } = deps;
  const steps: MigrationStep[] = [];
  const skipped: MigrationStep[] = [];

  // Check idempotency: already migrated?
  // Even when the marker exists, VERIFY the arena binding is actually in
  // place and repair it if missing — a prior run may have written the
  // marker while the binding step failed (e.g. bootstrap-pending).
  const config = store.getConfig();
  if (config[MARKER_KEY]) {
    let detail = "already migrated";
    try {
      const existing = JSON.parse(config[MARKER_KEY]);
      detail = `already migrated at ${new Date(existing.ts).toISOString()} (v${existing.version})`;
    } catch {
      // marker parse failure — treat as existing
    }
    steps.push({ name: "check-marker", status: "ok", detail });
    try {
      const bindingResult = ensureArenaBinding();
      if (bindingResult.ok) {
        steps.push({ name: "verify-binding", status: "ok", detail: "arena catch-all binding verified/repaired" });
      } else {
        steps.push({ name: "verify-binding", status: "error", detail: bindingResult.reason ?? "unknown" });
      }
    } catch (err) {
      steps.push({ name: "verify-binding", status: "error", detail: (err as Error).message });
    }
    return { steps, skipped: [], alreadyMigrated: true };
  }

  // Step 1: Detect legacy config fields
  const legacyFields = detectLegacyConfig(cfg);
  steps.push({
    name: "detect-legacy",
    status: "ok",
    detail: legacyFields.length > 0 ? `found: ${legacyFields.join(", ")}` : "no legacy fields detected",
  });

  // Step 2: Ensure arena catch-all binding (idempotent)
  try {
    const bindingResult = ensureArenaBinding();
    if (bindingResult.ok) {
      steps.push({ name: "ensure-binding", status: "ok", detail: "arena catch-all binding ensured" });
    } else {
      steps.push({ name: "ensure-binding", status: "error", detail: bindingResult.reason ?? "unknown" });
    }
  } catch (err) {
    steps.push({ name: "ensure-binding", status: "error", detail: (err as Error).message });
  }

  // Step 3: Backup DB file
  let backupPath: string | undefined;
  if (existsSync(dbPath)) {
    backupPath = `${dbPath}.backup-${now}`;
    try {
      copyFileSync(dbPath, backupPath);
      const backupSize = statSync(backupPath).size;
      steps.push({ name: "backup-db", status: "ok", detail: `backup: ${backupPath} (${backupSize} bytes)` });
    } catch (err) {
      backupPath = undefined;
      steps.push({ name: "backup-db", status: "error", detail: (err as Error).message });
    }
  } else {
    skipped.push({ name: "backup-db", status: "skipped", detail: "db file not found" });
  }

  // Step 4: Write marker — only when the binding step succeeded.
  // A failed binding must not be masked by the idempotency marker:
  // leaving the marker unwritten lets a later run retry the full flow.
  const bindingFailed = steps.some((s) => s.name === "ensure-binding" && s.status === "error");
  if (bindingFailed) {
    steps.push({ name: "write-marker", status: "error", detail: "deferred — ensure-binding failed; re-run /lab migrate after bootstrap completes" });
  } else {
    try {
      const marker = { ts: now, version: "0.1.0" };
      store.setConfig(MARKER_KEY, JSON.stringify(marker));
      steps.push({ name: "write-marker", status: "ok", detail: JSON.stringify(marker) });
    } catch (err) {
      steps.push({ name: "write-marker", status: "error", detail: (err as Error).message });
    }
  }

  return { steps, skipped, backupPath, alreadyMigrated: false };
}

// ── Dry-run variant ─────────────────────────────────────────────────

export function runP7DryRun(deps: MigrationDeps): MigrationReport {
  const { cfg, store, dbPath } = deps;

  // Check idempotency
  const config = store.getConfig();
  if (config[MARKER_KEY]) {
    let detail = "already migrated";
    try {
      const existing = JSON.parse(config[MARKER_KEY]);
      detail = `already migrated at ${new Date(existing.ts).toISOString()} (v${existing.version})`;
    } catch {
      // marker parse failure
    }
    return {
      steps: [{ name: "check-marker", status: "ok", detail }],
      skipped: [],
      alreadyMigrated: true,
    };
  }

  const legacyFields = detectLegacyConfig(cfg);
  const steps: MigrationStep[] = [
    {
      name: "detect-legacy",
      status: "ok",
      detail: legacyFields.length > 0 ? `found: ${legacyFields.join(", ")}` : "no legacy fields detected",
    },
    { name: "ensure-binding", status: "ok", detail: "would ensure arena catch-all binding" },
    { name: "backup-db", status: "ok", detail: `would backup ${dbPath}` },
    { name: "write-marker", status: "ok", detail: "would write migration.p7.completed marker" },
  ];

  return { steps, skipped: [], alreadyMigrated: false };
}

// ── Render helpers ──────────────────────────────────────────────────

export function renderMigrationReport(report: MigrationReport): string {
  if (report.alreadyMigrated) {
    return `Migration already completed.\n${report.steps.map((s) => `  ${s.name}: ${s.detail}`).join("\n")}`;
  }

  const lines: string[] = ["Migration report:"];
  for (const step of report.steps) {
    const icon = step.status === "ok" ? "✓" : step.status === "error" ? "✗" : "○";
    lines.push(`  ${icon} ${step.name}${step.detail ? ` — ${step.detail}` : ""}`);
  }
  for (const step of report.skipped) {
    lines.push(`  - ${step.name} — ${step.detail ?? "skipped"}`);
  }
  if (report.backupPath) {
    lines.push(`  backup: ${report.backupPath}`);
  }
  return lines.join("\n");
}
