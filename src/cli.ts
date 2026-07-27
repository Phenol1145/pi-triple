/**
 * CLI entry point for local platform testing.
 * No HTTP server — uses AgentEngine directly in-process.
 *
 * Usage: npx tsx src/cli.ts
 * Prereqs: Redis running, API key set via env var (e.g. ANTHROPIC_API_KEY)
 */

import { Redis } from "ioredis";
import * as readline from "node:readline";
import { detectPlatform } from "./platform/index.js";
import { SDK_EVENTS } from "./sdk-adapter/index.js";
import { createLogger } from "./observability/logger.js";
import { createMetrics } from "./observability/metrics.js";
import { AuditWriter } from "./observability/audit.js";
import { RedisSessionStore } from "./storage/redis-session-store.js";
import { RedisSettingsStore } from "./storage/redis-settings-store.js";
import { EnvCredentialProvider } from "./storage/credential-provider.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { ModelRouter } from "./model-router/router.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolPlatform } from "./tools/platform.js";
import { SessionPool } from "./core/session-pool.js";
import { AgentEngine } from "./core/agent-engine.js";

const TENANT = "local";
const PROJECT = "default";

function formatDelta(ev: Record<string, unknown>): string | null {
  // text_delta from pi SDK
  if (ev.type === "text_delta" && typeof ev.delta === "string") return ev.delta;
  // thinking_delta — show dimmed
  if (ev.type === "thinking_delta" && typeof ev.delta === "string") {
    return `\x1b[2m${ev.delta}\x1b[0m`; // dim
  }
  return null;
}

function printAssistantEvent(ev: Record<string, unknown>): void {
  const delta = formatDelta(ev);
  if (delta !== null) {
    process.stdout.write(delta);
    return;
  }
  // Silent for bookkeeping events
  if (
    ev.type === SDK_EVENTS.MESSAGE_START ||
    ev.type === SDK_EVENTS.MESSAGE_END ||
    ev.type === SDK_EVENTS.TURN_START
  ) {
    return;
  }
}

function printToolEvent(eventType: string, ev: Record<string, unknown>): void {
  process.stdout.write("\n");
  if (eventType === SDK_EVENTS.TOOL_EXECUTION_START) {
    process.stdout.write(`  🔧 \x1b[33m${ev.toolName ?? "?"}\x1b[0m `);
  } else if (eventType === SDK_EVENTS.TOOL_EXECUTION_END) {
    const ok = !ev.isError;
    process.stdout.write(`\n  ${ok ? "✅" : "❌"} ${ev.toolName ?? "?"} (${ev.durationMs ?? "?"}ms)\n`);
  }
}

function printEvent(event: { seq: number; type: string; data: Record<string, unknown> }): void {
  const ev = event.data;
  switch (event.type) {
    case SDK_EVENTS.MESSAGE_UPDATE:
      printAssistantEvent(ev.assistantMessageEvent as Record<string, unknown> ?? ev);
      break;
    case SDK_EVENTS.TOOL_EXECUTION_START:
    case SDK_EVENTS.TOOL_EXECUTION_END:
      printToolEvent(event.type, ev);
      break;
    case SDK_EVENTS.AGENT_END:
      process.stdout.write("\n");
      break;
    default:
      break; // silent
  }
}

async function main() {
  const platform = detectPlatform();
  const logger = createLogger(process.env.LOG_LEVEL ?? "warn"); // quiet by default in CLI
  const metrics = createMetrics();

  logger.info({ os: platform.os, event: "cli_starting" });

  // --- Redis ---
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new Redis(redisUrl);

  // --- Storage ---
  const sessionStore = new RedisSessionStore(redis);
  const settingsStore = new RedisSettingsStore(redis);
  const credentials = new EnvCredentialProvider();
  const audit = new AuditWriter(redis);

  // --- Workspace ---
  const dataDir = process.env.DATA_DIR ?? "./.pi-platform-data";
  const workspaceMgr = new WorkspaceManager(platform, `${dataDir}/workspaces`, `${dataDir}/platform`, `${dataDir}/tenants`);

  // --- Model Router ---
  const modelRouter = new ModelRouter(credentials, logger);
  await modelRouter.initialize();
  // Log available providers
  const rt = modelRouter.getRuntime();
  const available = await rt.getAvailable();
  const providerNames = [...new Set(available.map((m: { provider: string }) => m.provider))];
  console.log(`\nProviders: ${providerNames.join(", ") || "(none — set an API key env var)"}`);

  // --- Tool Platform ---
  const toolRegistry = new ToolRegistry();
  const toolPlatform = new ToolPlatform(toolRegistry, audit, metrics, logger);

  // --- Agent Engine ---
  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    sessionStore, logger, metrics,
  );
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics);
  pool.setOnEvict((sid) => engine.evictSession(sid));

  // --- Create default session ---
  let currentSession: string | null = null;

  async function newSession(): Promise<string> {
    const result = await engine.createSession({ tenantId: TENANT, project: PROJECT });
    if (!result.ok) throw new Error(`Failed to create session: ${result.error}`);
    currentSession = result.data.sessionId;
    console.log(`\nSession: ${shortId(currentSession)}  Model: ${result.data.model}\n`);
    return currentSession;
  }

  await newSession();

  // --- REPL ---
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36m> \x1b[0m",
    terminal: true,
  });

  rl.prompt();

  let running = false;

  // Wraps prompt with busy guard
  async function doPrompt(text: string): Promise<void> {
    if (!currentSession) {
      console.log("No active session. Creating one…");
      await newSession();
    }
    if (running) {
      console.log("\n(Already processing. Use /abort to stop, or queue via Alt+Enter.)");
      return;
    }
    running = true;
    const sid = currentSession!;
    try {
      for await (const event of engine.prompt(sid, TENANT, text)) {
        printEvent(event);
      }
    } catch (err) {
      console.log(`\n\x1b[31mError: ${err}\x1b[0m`);
    } finally {
      running = false;
      rl.prompt();
    }
  }

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Commands
    if (input.startsWith("/")) {
      const [cmd, ...args] = input.split(/\s+/);
      const rest = args.join(" ");

      switch (cmd) {
        case "/quit":
        case "/q": {
          console.log("\nBye.");
          rl.close();
          return;
        }
        case "/new": {
          await newSession();
          rl.prompt();
          return;
        }
        case "/sessions": {
          const sessions = engine.listSessions(TENANT);
          if (sessions.length === 0) {
            console.log("  (no sessions)");
          } else {
            for (const s of sessions) {
              const mark = s.sessionId === currentSession ? "*" : " ";
              console.log(`  ${mark} ${shortId(s.sessionId)}  ${s.state}  ${s.model}  ${s.project}`);
            }
          }
          rl.prompt();
          return;
        }
        case "/abort": {
          if (!currentSession) {
            console.log("  No active session.");
          } else {
            await engine.abort(currentSession, TENANT);
            console.log("  Aborted.");
            running = false;
          }
          rl.prompt();
          return;
        }
        case "/switch": {
          const targetId = rest;
          if (!targetId) {
            console.log("  Usage: /switch <session-id-prefix>");
          } else {
            const sessions = engine.listSessions(TENANT);
            const match = sessions.find((s) => s.sessionId.startsWith(targetId));
            if (match) {
              currentSession = match.sessionId;
              console.log(`  Switched to ${shortId(match.sessionId)}`);
            } else {
              console.log(`  No session matching "${targetId}"`);
            }
          }
          rl.prompt();
          return;
        }
        case "/help": {
          console.log("\n  /quit, /q        Exit");
          console.log("  /new             New session");
          console.log("  /sessions        List sessions");
          console.log("  /abort           Abort current prompt");
          console.log("  /switch <id>     Switch active session");
          console.log("  /help            This help");
          console.log("  Any other text   Send to agent");
          rl.prompt();
          return;
        }
        default:
          console.log(`  Unknown command: ${cmd}. Try /help.`);
          rl.prompt();
          return;
      }
    }

    // Normal prompt
    await doPrompt(input);
  });

  // --- Graceful shutdown ---
  async function shutdown(signal: string) {
    logger.info({ signal, event: "shutdown_start" });
    rl.close();
    try {
      await engine.drain();
    } catch {}
    try {
      await redis.quit();
    } catch {}
    process.exit(0);
  }

  process.on("SIGINT", () => {
    if (running) {
      // First Ctrl+C: abort current prompt
      engine.abort(currentSession!, TENANT).catch(() => {});
      running = false;
      console.log("\n(Aborted. Ctrl+C again to quit.)");
      rl.prompt();
    } else {
      shutdown("SIGINT");
    }
  });

  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
