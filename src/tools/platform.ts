import type { ToolRegistry } from "./registry.js";
import type { AuditWriter } from "../observability/audit.js";
import type { Metrics } from "../observability/metrics.js";
import type { Logger } from "../observability/logger.js";
import type { ToolCallRequest, ToolResult } from "./types.js";

export class ToolPlatform {
  constructor(
    private registry: ToolRegistry,
    private audit: AuditWriter,
    private metrics: Metrics,
    private logger: Logger,
  ) {}

  getAllowedTools(tenantId: string): string[] {
    return this.registry.getAllowedTools(tenantId);
  }

  async governExecution(
    request: ToolCallRequest,
    executeFn: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const allowed = this.registry.getAllowedTools(request.tenantId);
    if (!allowed.includes(request.name)) {
      const denied: ToolResult = {
        toolCallId: request.toolCallId,
        output: `Tool "${request.name}" not allowed for tenant`,
        content: [{ type: "text", text: `Tool "${request.name}" not allowed` }],
        isError: true,
        durationMs: 0,
      };
      await this.audit.queryToolCall(request.tenantId, request.name, "denied");
      return denied;
    }

    const start = Date.now();
    this.logger.info({
      tenantId: request.tenantId,
      tool: request.name,
      toolCallId: request.toolCallId,
      event: "tool_call_start",
    });

    try {
      const result = await executeFn();
      const durationMs = Date.now() - start;
      this.metrics.toolCallsTotal.inc({ tool: request.name, tenant: request.tenantId });
      await this.audit.queryToolCall(request.tenantId, request.name, result.isError ? "error" : "success");
      return { ...result, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      await this.audit.queryToolCall(request.tenantId, request.name, "exception");
      return {
        toolCallId: request.toolCallId,
        output: String(err),
        content: [{ type: "text", text: String(err) }],
        isError: true,
        durationMs,
      };
    }
  }
}
