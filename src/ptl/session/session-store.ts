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

export function registerSessionProvider(p: SessionProvider): void { sessionProviders.push(p); }
export function registerTraceProvider(p: TraceProvider): void { traceProviders.push(p); }

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

const NOT_SUPPORTED = (workloop: string, op: string): CommandResult => ({
  ok: false,
  message: "",
  error: {
    code: "NOT_SUPPORTED",
    message: `该会话类型（${workloop}）不支持 ${op}——结构由对应 workloop 定义`,
  },
});

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
  const fn = (provider as any)[op] as ((r: SessionRecord, o: any) => CommandResult) | undefined;
  if (!fn) return NOT_SUPPORTED(record.workloop, op);
  return fn(record, opts);
}
