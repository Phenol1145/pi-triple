/**
 * Quick non-interactive test: create session → prompt → print → exit
 */
import { Redis } from "ioredis";
import { detectPlatform } from "./src/platform/index.js";
import { createLogger } from "./src/observability/logger.js";
import { createMetrics } from "./src/observability/metrics.js";
import { AuditWriter } from "./src/observability/audit.js";
import { RedisSessionStore } from "./src/storage/redis-session-store.js";
import { EnvCredentialProvider } from "./src/storage/credential-provider.js";
import { WorkspaceManager } from "./src/workspace/manager.js";
import { ModelRouter } from "./src/model-router/router.js";
import { ToolRegistry } from "./src/tools/registry.js";
import { ToolPlatform } from "./src/tools/platform.js";
import { SessionPool } from "./src/core/session-pool.js";
import { AgentEngine } from "./src/core/agent-engine.js";

async function main() {
  const platform = detectPlatform();
  const logger = createLogger("warn");
  const metrics = createMetrics();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

  const sessionStore = new RedisSessionStore(redis);
  const credentials = new EnvCredentialProvider();
  const audit = new AuditWriter(redis);
  const dataDir = "./.pi-platform-data";
  const workspaceMgr = new WorkspaceManager(platform, `${dataDir}/workspaces`, `${dataDir}/platform`, `${dataDir}/tenants`);

  const modelRouter = new ModelRouter(credentials, logger);
  await modelRouter.initialize();

  const available = await modelRouter.getRuntime().getAvailable();
  console.log(`Available models: ${available.length}`);
  if (available.length > 0) {
    console.log(`First: ${available[0].provider}/${available[0].id}`);
  }

  const toolRegistry = new ToolRegistry();
  const toolPlatform = new ToolPlatform(toolRegistry, audit, metrics, logger);
  const pool = new SessionPool({ maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, sessionStore, logger, metrics);
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics);

  console.log("\n--- Creating session ---");
  const result = await engine.createSession({ tenantId: "local", project: "test" });
  if (!result.ok) {
    console.error("Failed:", result.error);
    process.exit(1);
  }
  console.log(`Session: ${result.data.sessionId.slice(0, 8)}  Model: ${result.data.model}`);

  console.log("\n--- Sending prompt ---");
  const prompt = process.argv[2] ?? "Say hello in one sentence.";
  console.log(`Prompt: "${prompt}"\n`);

  try {
    for await (const event of engine.prompt(result.data.sessionId, "local", prompt)) {
      const ev = event.data as any;
      if (event.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        process.stdout.write(ev.assistantMessageEvent.delta);
      } else if (event.type === "agent_end") {
        console.log("\n\n--- Done ---");
      }
    }
  } catch (err) {
    console.error("\nPrompt error:", err);
  }

  await engine.drain();
  await redis.quit();
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
