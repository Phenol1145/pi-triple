import type { ToolDefinition } from "./types.js";

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const DEFAULT_ALLOWLIST = ["read", "bash", "edit", "write"];

export class ToolRegistry {
  private tenantAllowlists = new Map<string, string[]>();
  private customTools = new Map<string, ToolDefinition[]>();

  getAllowedTools(tenantId: string): string[] {
    const custom = (this.customTools.get(tenantId) ?? []).map((t) => t.name);
    const allowlist = this.tenantAllowlists.get(tenantId) ?? DEFAULT_ALLOWLIST;
    return [...new Set([...allowlist, ...custom])];
  }

  setTenantAllowlist(tenantId: string, tools: string[]): void {
    this.tenantAllowlists.set(tenantId, tools);
  }

  registerCustomTool(tenantId: string, def: ToolDefinition): void {
    if (BUILTIN_TOOLS.includes(def.name)) {
      throw new Error(`Tool name "${def.name}" is reserved for built-in tools`);
    }
    const existing = this.customTools.get(tenantId) ?? [];
    const filtered = existing.filter((t) => t.name !== def.name);
    this.customTools.set(tenantId, [...filtered, def]);
  }

  getCustomTools(tenantId: string): ToolDefinition[] {
    return this.customTools.get(tenantId) ?? [];
  }

  isBuiltin(name: string): boolean {
    return BUILTIN_TOOLS.includes(name);
  }
}
