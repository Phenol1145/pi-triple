/**
 * Pi-Triple 共享路径解析（@away_from/shared — 自 extensions/_shared 迁入，mailbox/pit-control 共用）
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
