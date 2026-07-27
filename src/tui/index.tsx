/**
 * Pi-Triple TUI entry point.
 *
 * Usage: npm run tui
 * Prereqs: Redis running, at least one API key set (env var)
 *
 * Degradation: falls back to CLI REPL for narrow/dumb terminals.
 */

import React from "react";
import { render } from "ink";
import { Redis } from "ioredis";
import { detectPlatform } from "../platform/index.js";
import { createLogger } from "../observability/logger.js";
import { createMetrics } from "../observability/metrics.js";
import { AuditWriter } from "../observability/audit.js";
import { RedisSessionStore } from "../storage/redis-session-store.js";
import { RedisSettingsStore } from "../storage/redis-settings-store.js";
import { EnvCredentialProvider } from "../storage/credential-provider.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { ModelRouter } from "../model-router/router.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolPlatform } from "../tools/platform.js";
import { SessionPool } from "../core/session-pool.js";
import { AgentEngine } from "../core/agent-engine.js";
import { App } from "./app.js";
import { applyWindowsFallbacks } from "./theme.js";

async function main(): Promise<void> {
  // ─── Degradation check ──────────────────────────────────
  const cols = process.stdout.columns ?? 80;
  const term = process.env.TERM ?? "";
  if (cols < 80 || term === "dumb") {
    console.error(
      `Terminal too narrow (${cols} cols) or TERM=dumb. ` +
        "Falling back to CLI REPL.\nRun: npm run cli",
    );
    process.exit(1);
  }

  applyWindowsFallbacks();

  // ─── Wiring (mirrors cli.ts) ─────────────────────────────
  const platform = detectPlatform();

  // Logger → stderr to avoid polluting Ink canvas
  const logger = createLogger(process.env.LOG_LEVEL ?? "warn", 2);
  const metrics = createMetrics();

  logger.info({ os: platform.os, event: "tui_starting" });

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new Redis(redisUrl);

  const sessionStore = new RedisSessionStore(redis);
  const settingsStore = new RedisSettingsStore(redis);
  const credentials = new EnvCredentialProvider();
  const audit = new AuditWriter(redis);

  const dataDir = process.env.DATA_DIR ?? "./.pi-platform-data";
  const workspaceMgr = new WorkspaceManager(
    platform,
    `${dataDir}/workspaces`,
    `${dataDir}/platform`,
    `${dataDir}/tenants`,
  );

  const modelRouter = new ModelRouter(credentials, logger);
  await modelRouter.initialize();

  const toolRegistry = new ToolRegistry();
  const toolPlatform = new ToolPlatform(
    toolRegistry,
    audit,
    metrics,
    logger,
  );

  const SESSION_LIMIT = 5;
  const pool = new SessionPool(
    {
      maxSessions: 20,
      maxSessionsPerTenant: SESSION_LIMIT,
      idleTimeoutMs: 300_000,
    },
    sessionStore,
    logger,
    metrics,
  );

  const engine = new AgentEngine(
    pool,
    modelRouter,
    workspaceMgr,
    sessionStore,
    toolPlatform,
    logger,
    metrics,
  );

  // Evict is handled inside App via handleEvict callback (B7/M7),
  // which chains engine.evictSession + TUI display update.
  // We set a no-op here; App overrides via engine.evictSession wrapping.
  pool.setOnEvict((sid) => {
    // App's handleEvict takes care of everything (engine + TUI display)
  });

  // Resolve model display name
  const rt = modelRouter.getRuntime();
  let modelDisplay = "unknown";
  try {
    const available = await (rt as any).getAvailable();
    if (Array.isArray(available) && available.length > 0) {
      const first = available[0] as { provider?: string; id?: string };
      modelDisplay = `${first.provider ?? "?"}/${first.id ?? "?"}`;
    }
  } catch {
    // getAvailable not available or errored
  }

  // ─── Render ──────────────────────────────────────────────
  const { clear, waitUntilExit } = render(
    <App
      engine={engine}
      platform={platform}
      model={modelDisplay}
      version="0.1.0"
      sessionLimit={SESSION_LIMIT}
      onClear={() => clear()}
    />,
    { exitOnCtrlC: false },
  );

  await waitUntilExit();

  // ─── Cleanup ─────────────────────────────────────────────
  logger.info({ event: "tui_shutdown" });
  await engine.drain().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
