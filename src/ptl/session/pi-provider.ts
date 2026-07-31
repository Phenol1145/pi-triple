// pi-provider.ts — Pi 纸带 SessionProvider 壳（读侧）
// fork/clone/transfer/branch/tree 写操作在 Task 3（pi-fork.ts/pi-tree.ts）挂接。
import type { SessionProvider, SessionRecord } from "./session-provider.js";
import { scanSessionFiles, toSessionRecords } from "./pi-scan.js";
import { loadConfig } from "../config.js";
import { registerSessionProvider } from "./session-store.js";

function list(): SessionRecord[] {
  const cfg = loadConfig();
  return toSessionRecords(scanSessionFiles(cfg));
}

function show(r: SessionRecord): string {
  const lines = [`${r.summary}`, `ID: ${r.id}`, `WorkLoop: ${r.workloop}`];
  for (const [k, v] of Object.entries(r.detail)) lines.push(`${k}: ${v}`);
  return lines.join("\n");
}

export function createPiSessionProvider(): SessionProvider {
  return {
    workloop: "pi",
    capabilities: ["fork", "clone", "transfer", "branch", "tree"],
    list,
    show,
    // fork/clone/transfer/branch/tree 在 Task 3 的 pi-fork.ts/pi-tree.ts 中挂接
  };
}

export function registerPiSessionProvider(): void {
  registerSessionProvider(createPiSessionProvider());
}
