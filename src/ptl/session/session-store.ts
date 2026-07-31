import type { CommandResult } from "../commands.js";
import type {
  SessionProvider, TraceProvider, SessionRecord, TraceRecord, ForkOpts, BranchOpts, TransferOpts,
} from "./session-provider.js";

const sessionProviders: SessionProvider[] = [];
const traceProviders: TraceProvider[] = [];

/** 仅测试用：清空模块级注册表（测试间隔离）。 */
export function _resetForTests(): void {
  sessionProviders.length = 0;
  traceProviders.length = 0;
}

/** 注册（幂等）：providers 按 workloop 唯一（operateSession 的 find 亦依赖此假设） */
export function registerSessionProvider(p: SessionProvider): void {
  if (!sessionProviders.some((x) => x.workloop === p.workloop)) sessionProviders.push(p);
}
export function registerTraceProvider(p: TraceProvider): void {
  if (!traceProviders.some((x) => x.workloop === p.workloop)) traceProviders.push(p);
}

export function listAllSessions(): SessionRecord[] {
  return sessionProviders.flatMap((p) => p.list());
}

export function listAllTraces(): TraceRecord[] {
  return traceProviders.flatMap((p) => p.list());
}

function matchPrefix(id: string, input: string): boolean {
  return id === input || id.startsWith(input);
}

export function resolveSession(input: string): SessionRecord | null {
  for (const p of sessionProviders) {
    for (const r of p.list()) {
      if (matchPrefix(r.id, input)) return r;
    }
  }
  return null;
}

export function resolveTrace(input: string): TraceRecord | null {
  for (const p of traceProviders) {
    for (const r of p.list()) {
      if (matchPrefix(r.id, input)) return r;
    }
  }
  return null;
}

/** 聚合各 trace provider 的 timeline（按 agent 查轨迹） */
export function traceTimeline(agentId: string): TraceRecord[] {
  const out: TraceRecord[] = [];
  for (const p of traceProviders) {
    if (p.timeline) out.push(...p.timeline(agentId));
  }
  return out;
}

const NOT_SUPPORTED = (workloop: string, op: string): CommandResult => ({
  ok: false,
  message: "",
  error: {
    code: "NOT_SUPPORTED",
    message: `该会话类型（${workloop}）不支持 ${op}——结构由对应 workloop 定义`,
  },
});

type SessionOp = "fork" | "clone" | "transfer" | "branch";

// 类型化分发表：仅 fork/clone/transfer/branch 走 operateSession，tree 由命令层直接处理。
const SESSION_OPS: Record<SessionOp, (p: SessionProvider, r: SessionRecord, o: any) => CommandResult | undefined> = {
  fork: (p, r, o) => p.fork?.(r, o as ForkOpts),
  clone: (p, r, o) => p.clone?.(r, o as ForkOpts),
  transfer: (p, r, o) => p.transfer?.(r, o as TransferOpts),
  branch: (p, r, o) => p.branch?.(r, o as BranchOpts),
};

export function operateSession(
  op: string,
  id: string,
  opts: ForkOpts | BranchOpts | TransferOpts,
): CommandResult {
  const record = resolveSession(id);
  if (!record) {
    return { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话 "${id}" 不存在（pit session ls 查看）` } };
  }
  const provider = sessionProviders.find((p) => p.workloop === record.workloop);
  if (!provider || !provider.capabilities.includes(op)) {
    return NOT_SUPPORTED(record.workloop, op);
  }
  const fn = SESSION_OPS[op as SessionOp];
  if (!fn) return NOT_SUPPORTED(record.workloop, op);
  const result = fn(provider, record, opts);
  if (!result) return NOT_SUPPORTED(record.workloop, op);
  return result;
}
