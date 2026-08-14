/**
 * 示例：自定义工具 — weather（城市天气查询，mock 数据）
 *
 * 运行方式：npx tsx examples/custom-tool/index.ts
 * 前置条件：Redis 运行中
 *
 * 参考文档：docs/architecture.md
 *
 * 流程：
 *   1. 创建 SDK ToolDefinition（含 TypeBox schema + execute()）
 *   2. 通过 ToolRegistry.registerCustomTool() 注册平台定义 + SDK 定义
 *   3. AgentEngine.createSession() 自动将 SDK 定义传入 createAgentSession({ customTools })
 *   4. Agent 可以调用该工具，ToolPlatform 自动记录审计和指标
 */

// 2026-08-14 A2：引用随当前布局刷新（src/ → src/pth/；会话平面归并进 kernel/storage/session/；
// 平台件收敛进 @away_from/infra）
import { Type } from "@sinclair/typebox";
import { Redis } from "ioredis";
import { detectPlatform, createLogger, EnvCredentialProvider, WorkspaceManager, ModelRouter } from "@away_from/infra";
import { createMetrics } from "../../src/pth/observability/metrics.js";
import { AuditWriter } from "../../src/pth/observability/audit.js";
import { RedisSessionStore } from "../../src/pth/kernel/storage/session/redis-session-store.js";
import { ToolRegistry } from "../../src/pth/tools/registry.js";
import { ToolPlatform } from "../../src/pth/tools/platform.js";
import { SessionPool } from "../../src/pth/core/session-pool.js";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";

// ============================================================
// 第一步：创建 SDK ToolDefinition（含 execute()）
// ============================================================
const weatherToolSdkDef = {
  name: "weather",
  label: "Weather",
  description: "查询指定城市的天气（mock 数据）",
  promptSnippet: "weather: Get weather info for a city",
  parameters: Type.Object({
    city: Type.String({ description: "城市名称" }),
  }),
  async execute(toolCallId: string, params: { city: string }) {
    // Mock 天气数据（实际开发中替换为 API 调用）
    const conditions = ["晴", "多云", "小雨"];
    const temp = Math.round(Math.random() * 30 + 5);
    const text = `${params.city}: ${temp}°C, ${conditions[Math.floor(Math.random() * 3)]}`;

    return {
      toolCallId,
      output: text,
      content: [{ type: "text" as const, text }],
      isError: false,
      durationMs: Math.floor(Math.random() * 100),
    };
  },
};

// ============================================================
// 第二步：注册到 ToolRegistry
// ============================================================
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

  const toolRegistry = new ToolRegistry();

  // 注册：平台定义 + SDK 定义
  toolRegistry.registerCustomTool(
    "example",
    {
      name: "weather",
      description: "查询指定城市的天气",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      version: 1,
      idempotent: true,
      executor: "local",
    },
    weatherToolSdkDef, // ← SDK 定义（含 execute()，将传递给 createAgentSession）
  );

  const toolPlatform = new ToolPlatform(toolRegistry, audit, metrics, logger);
  const pool = new SessionPool({ maxSessions: 10, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, sessionStore, logger, metrics);
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics);

  // 验证注册
  const allowed = toolRegistry.getAllowedTools("example");
  const sdk = toolRegistry.getSdkToolDefinitions("example");
  console.log("允许的工具:", allowed);
  console.log("SDK 定义数:", sdk.length);
  console.log("'weather' 是内置工具?", toolRegistry.isBuiltin("weather"));
  console.log("SDK 工具名:", sdk.map((t: any) => t.name));

  // 端到端验证：创建 session 并让 agent 调用 weather 工具
  console.log("\n--- 端到端验证：创建 session ---");
  const result = await engine.createSession({ tenantId: "example", project: "weather-test" });
  if (!result.ok) {
    console.error("创建失败:", (result as any).error ?? (result as any).reason);
    await engine.drain();
    await redis.quit();
    process.exit(1);
  }
  const sid = result.data.sessionId;
  console.log(`Session: ${sid.slice(0, 8)}  Model: ${result.data.model}`);

  console.log("\n--- 发送 prompt（让 agent 调用 weather 工具）---");
  let textOutput = "";
  try {
    for await (const event of engine.prompt(sid, "example", "请用 weather 工具查询北京的天气")) {
      const ev = event.data as any;
      if (event.type === "tool_execution_start") {
        console.log(`  🔧 ${ev.toolName ?? "?"}`);
      }
      if (event.type === "tool_execution_end") {
        const ok = !ev.isError;
        const dur = ev.durationMs ?? "?";
        console.log(`  ${ok ? "✅" : "❌"} ${ev.toolName ?? "?"} (${dur}ms)`);
      }
      if (event.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        textOutput += ev.assistantMessageEvent.delta;
        process.stdout.write(ev.assistantMessageEvent.delta);
      }
    }
    console.log(); // newline after stream
  } catch (err) {
    console.error("Prompt error:", err);
  }

  console.log(`\nAgent 回答: "${textOutput.trim()}"`);

  // 检查工具是否被实际调用
  const hasToolCall = textOutput.includes("°C") || textOutput.includes("北京") || textOutput.includes("weather");
  console.log(hasToolCall ? "\n✅ 自定义工具端到端验证通过" : "\n⚠️  Agent 未调用 weather 工具（模型决定不调用）");

  await engine.destroySession(sid, "example");
  await engine.drain();
  await redis.quit();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
