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

export async function listAllSessions(): Promise<SessionRecord[]> {
  const lists = await Promise.all(sessionProviders.map((p) => Promise.resolve(p.list())));
  return lists.flat();
}

export function listAllTraces(): TraceRecord[] {
  return traceProviders.flatMap((p) => p.list());
}

export type SessionResolveResult =
  | { ok: true; record: SessionRecord }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates?: string[] };

export type TraceResolveResult =
  | { ok: true; record: TraceRecord }
  | { ok: false; reason: "not_found" | "ambiguous"; candidates?: string[] };

/** 前缀解析：完整 id 精确命中优先；前缀唯一命中 → ok；前缀多命中 → ambiguous + candidates；无命中 → not_found。 */
function resolveByPrefix<T extends { id: string }>(
  items: T[],
  input: string,
): { ok: true; record: T } | { ok: false; reason: "not_found" | "ambiguous"; candidates?: string[] } {
  const exact = items.find((x) => x.id === input);
  if (exact) return { ok: true, record: exact };
  const matches = items.filter((x) => x.id.startsWith(input));
  if (matches.length === 1) return { ok: true, record: matches[0] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: matches.map((x) => x.id) };
  return { ok: false, reason: "not_found" };
}

export async function resolveSession(input: string): Promise<SessionResolveResult> {
  const lists = await Promise.all(sessionProviders.map((p) => Promise.resolve(p.list())));
  return resolveByPrefix(lists.flat(), input);
}

export function resolveTrace(input: string): TraceResolveResult {
  return resolveByPrefix(traceProviders.flatMap((p) => p.list()), input);
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

export async function operateSession(
  op: string,
  id: string,
  opts: ForkOpts | BranchOpts | TransferOpts,
): Promise<CommandResult> {
  const resolved = await resolveSession(id);
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") {
      return { ok: false, message: "", error: { code: "AMBIGUOUS", message: `会话 "${id}" 匹配 ${resolved.candidates?.length ?? 0} 个，请使用完整 UUID：${resolved.candidates?.map((c) => c.slice(0, 8)).join(", ")}` } };
    }
    return { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话 "${id}" 不存在（ptl session ls 查看）` } };
  }
  const record = resolved.record;
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
