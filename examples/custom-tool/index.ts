/**
 * 示例：自定义工具 — weather（城市天气查询，mock 数据）
 *
 * 运行方式：npx tsx examples/custom-tool/index.ts
 * 前置条件：Redis 运行中
 *
 * 参考文档：docs/architecture.md #ToolPlatform（C8 治理层）
 *
 * 流程：
 *   1. 实现 ToolExecutor SPI 接口
 *   2. 在 main.ts assembly 阶段通过 ToolRegistry.registerCustomTool() 注册 ToolDefinition
 *   3. pi SDK 的 createAgentSession 会使用 getAllowedTools() 的结果
 *   4. 运行时由 ToolPlatform.recordToolStart/End() 自动记录审计和指标
 */

import { Redis } from "ioredis";
import { detectPlatform } from "../../src/platform/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createMetrics } from "../../src/observability/metrics.js";
import { AuditWriter } from "../../src/observability/audit.js";
import { RedisSessionStore } from "../../src/storage/redis-session-store.js";
import { EnvCredentialProvider } from "../../src/storage/credential-provider.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { ModelRouter } from "../../src/model-router/router.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolPlatform } from "../../src/tools/platform.js";
import { SessionPool } from "../../src/core/session-pool.js";
import { AgentEngine } from "../../src/core/agent-engine.js";
import type { ToolCallRequest, ToolEvent } from "../../src/tools/types.js";

// ============================================================
// 第一步：实现 ToolExecutor SPI
// ============================================================
class WeatherTool {
  readonly type = "weather"; // 工具类型标识（pi SDK 内部使用）

  async *execute(request: ToolCallRequest): AsyncIterable<ToolEvent> {
    const city = (request.arguments.city as string) ?? "unknown";

    // Mock 天气数据（实际开发中替换为 API 调用）
    yield { type: "output_delta", data: `正在查询 ${city} 的天气...` };

    const result = {
      city,
      temperature: Math.round(Math.random() * 30 + 5),
      condition: ["晴", "多云", "小雨"][Math.floor(Math.random() * 3)],
    };

    yield {
      type: "result",
      data: JSON.stringify(result),
      result: {
        toolCallId: request.toolCallId,
        output: `${result.city}: ${result.temperature}°C, ${result.condition}`,
        content: [{ type: "text", text: `${result.city}: ${result.temperature}°C, ${result.condition}` }],
        isError: false,
        durationMs: Math.floor(Math.random() * 100),
      },
    };
  }

  async cancel(_toolCallId: string): Promise<void> {
    // 取消逻辑（本示例为 mock，无需实现）
  }
}

// ============================================================
// 第二步：注册到 ToolRegistry（与 main.ts 中 assembly 阶段一致）
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

  // 注册自定义工具
  toolRegistry.registerCustomTool("example", {
    name: "weather",
    description: "查询指定城市的天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "城市名称" } },
      required: ["city"],
    },
    version: 1,
    idempotent: true,
    executor: "local",
  });

  const toolPlatform = new ToolPlatform(toolRegistry, audit, metrics, logger);
  const pool = new SessionPool({ maxSessions: 10, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, sessionStore, logger, metrics);
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics);

  // 验证注册
  console.log("注册的工具:", toolRegistry.getAllowedTools("example"));
  console.log("自定义工具:", toolRegistry.getCustomTools("example").map((t) => t.name));
  console.log("'weather' 是内置工具?", toolRegistry.isBuiltin("weather"));

  await engine.drain();
  await redis.quit();
  console.log("\n✅ 自定义工具示例完成");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
