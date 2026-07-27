/**
 * 示例：自定义 API 端点 — GET /api/v1/stats（session 统计）
 *
 * 运行方式：
 *   1. 先启动平台：npm run dev
 *   2. 创建 token：redis-cli SET "auth:token:example" '{"tenantId":"example"}'
 *   3. curl -H "Authorization: Bearer example" http://localhost:3000/api/v1/stats
 *
 *   （本文件展示的是源码挂载方式，需要整合进 server.ts；见下方注释）
 *
 * 参考文档：docs/architecture.md #Gateway Layer
 *
 * 流程：
 *   1. 写一个 registerXxxRoutes(app, engine) 函数，遵循 Fastify plugin 模式
 *   2. 在 server.ts 中调用 registerXxxRoutes(app, engine)
 *   3. 所有 /api/v1/* 路由自动经过 auth hook，req.auth.tenantId 可用
 */

import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AgentEngine } from "../../src/core/agent-engine.js";

// Extend Fastify to include auth hook types
declare module "fastify" {
  interface FastifyRequest {
    auth: { tenantId: string; role: string };
  }
}

// ============================================================
// 第一步：定义自定义路由函数
// ============================================================
export function registerStatsRoutes(app: FastifyInstance, engine: AgentEngine) {
  // 端点 1：session 统计（按租户）
  app.get("/api/v1/stats", async (req) => {
    const tenantId = req.auth.tenantId; // auth hook 自动注入
    const sessions = engine.listSessions(tenantId);

    return {
      tenant: tenantId,
      totalSessions: sessions.length,
      idleSessions: sessions.filter((s) => s.state === "idle").length,
      busySessions: sessions.filter((s) => s.state === "busy").length,
      projects: Array.from(new Set(sessions.map((s) => s.project))),
    };
  });

  // 端点 2：按项目统计
  app.get("/api/v1/stats/:project", async (req) => {
    const { project } = req.params as any;
    const tenantId = req.auth.tenantId;
    const sessions = engine.listSessions(tenantId).filter((s) => s.project === project);

    return { tenant: tenantId, project, sessions: sessions.length };
  });
}

// ============================================================
// 第二步：在 server.ts 中挂载（示例，不实际启动）
// ============================================================
// 实际整合步骤：
//
//   // src/gateway/server.ts 中：
//   import { registerStatsRoutes } from "../../examples/custom-route/index.js";
//   // ...
//   registerStatsRoutes(app, deps.engine);
//
// 挂载后重启服务即可使用新增端点。
//
// 注意：
// - /health 和 /metrics 免认证，/api/v1/* 自动受 auth hook 保护
// - req.auth 的类型声明在 src/gateway/auth.ts 的 declare module "fastify" 中
// - 所有 handler 均可访问 req.auth.tenantId 和 req.auth.role

// 验证：启动一个空 Fastify 实例并检查路由注册是否正常
async function verify() {
  const app = Fastify({ logger: false });

  // Mock engine for verification
  const mockEngine = {
    listSessions: (_tenant: string) => [],
  } as unknown as AgentEngine;

  registerStatsRoutes(app, mockEngine);

  // Fastify 5 printRoutes 使用树形缩进，直接打印可见即可
  console.log("✅ 自定义路由已注册：");
  console.log(app.printRoutes().split("\n").filter((l) => l.includes("stats")).join("\n"));

  await app.close();
}

// 仅在直接运行时验证
if (process.argv[1]?.includes("custom-route")) {
  verify().catch(console.error);
}
