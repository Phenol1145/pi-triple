// pi-provider.ts — Pi 纸带 SessionProvider（读侧 + 写侧挂接）
// 写操作委托 pi-fork.ts（fork/clone/transfer/branch）、pi-tree.ts（tree）。
import type { SessionProvider, SessionRecord, ForkOpts, BranchOpts, TransferOpts } from "./session-provider.js";
import { scanSessionFiles, toSessionRecords } from "./pi-scan.js";
import { forkSession, cloneSession, transferSession, forkSessionAtNode } from "./pi-fork.js";
import { buildSessionTree } from "./pi-tree.js";
import { loadConfig } from "../config.js";
import type { CommandResult } from "../commands.js";
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

/** 按 id 解析 PiSessionFile；不存在返回 SESSION_NOT_FOUND */
function requireSessionFile(id: string): { ok: true; file: NonNullable<ReturnType<typeof scanSessionFiles>[number]> } | { ok: false; error: CommandResult } {
  const f = scanSessionFiles(loadConfig()).find((x) => x.id === id);
  if (!f) {
    return { ok: false, error: { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话 "${id}" 不存在` } } };
  }
  return { ok: true, file: f };
}

function fork(r: SessionRecord, opts: ForkOpts): CommandResult {
  const hit = requireSessionFile(r.id);
  return hit.ok ? forkSession(hit.file, opts) : hit.error;
}

function clone(r: SessionRecord, opts: ForkOpts): CommandResult {
  const hit = requireSessionFile(r.id);
  return hit.ok ? cloneSession(hit.file, opts) : hit.error;
}

function transfer(r: SessionRecord, opts: TransferOpts): CommandResult {
  const hit = requireSessionFile(r.id);
  return hit.ok ? transferSession(hit.file, opts, r.status === "running") : hit.error;
}

function branch(r: SessionRecord, opts: BranchOpts): CommandResult {
  const hit = requireSessionFile(r.id);
  return hit.ok ? forkSessionAtNode(hit.file, opts) : hit.error;
}

function tree(_records: SessionRecord[]): string {
  return buildSessionTree(scanSessionFiles(loadConfig()));
}

export function createPiSessionProvider(): SessionProvider {
  return {
    workloop: "pi",
    capabilities: ["fork", "clone", "transfer", "branch", "tree"],
    list,
    show,
    fork,
    clone,
    transfer,
    branch,
    tree,
  };
}

export function registerPiSessionProvider(): void {
  registerSessionProvider(createPiSessionProvider());
}
