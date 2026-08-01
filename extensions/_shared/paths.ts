/**
 * Pi-Triple 共享路径解析（_shared — 平台内部共享，非扩展，勿加 index.ts）
 */
import os from "node:os";
import path from "node:path";

export function resolveMailboxRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (agentDir) {
    const dataDir = path.resolve(agentDir, "..", "..");
    return path.join(dataDir, "mailbox");
  }
  return path.join(process.env.PI_TRIPLE_HOME ?? path.join(os.homedir(), ".pi-triple"), "data", "mailbox");
}

export function resolveTenantId(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  if (agentDir) return path.basename(agentDir);
  return "local";
}
