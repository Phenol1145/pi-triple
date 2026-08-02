// 装配层类型基座（spec §2.3 MemorySpec / §4.1 类型出处）。
// 被 AgentAssembler/AgentRuntime/MemoryHost 等装配层模块共享。

export interface AgentRef {
  kind: "workloop";
  id: string;
  version: string;
}

export interface MemorySpec {
  dialect?: "json" | "xml" | "markdown"; // markdown = draft-only
  maxEntries?: number;
}

export interface AssembleOptions {
  cloneMode: "fresh" | "fork";
  sourceAgentId?: string;
  schedulerInstanceId: string;
  endowment?: { K: number; initialFloor: number };
  memory?: MemorySpec;
}

export const ASSEMBLY_DIR = "agents";            // <root>/agents/<agentId>/
export const PUBLIC_DOMAIN_DIR = "public-domain"; // <root>/public-domain/
export const ROUND_SENTINEL = "";                // createdAtRoundId 哨兵

const ALLOWED_DIALECTS = ["json", "xml", "markdown"] as const;
const KNOWN_FIELDS = new Set(["dialect", "maxEntries"]);

/** 白名单校验：dialect 枚举 / maxEntries 正整数 / 未知字段拒绝。返回错误信息列表（含字段名）。 */
export function validateMemorySpec(spec: MemorySpec | undefined): string[] {
  if (spec === undefined) return [];
  const errors: string[] = [];
  if (spec.dialect !== undefined && !(ALLOWED_DIALECTS as readonly string[]).includes(spec.dialect)) {
    errors.push(
      `dialect: unsupported "${spec.dialect}" (allowed: json | xml | markdown; markdown = draft-only)`,
    );
  }
  if (
    spec.maxEntries !== undefined &&
    (!Number.isInteger(spec.maxEntries) || spec.maxEntries <= 0)
  ) {
    errors.push(`maxEntries: must be a positive integer, got ${spec.maxEntries}`);
  }
  for (const key of Object.keys(spec)) {
    if (!KNOWN_FIELDS.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }
  return errors;
}
