import { randomUUID } from "node:crypto";

export type MemoryKind = "axiom" | "rule" | "fact" | "experience" | "preference" | string;
export type EntryStatus = "draft" | "official" | "archived";

export interface SourceTrace { traceId: string; transitionSeq: number; branch?: string; }
export interface EntryVersion { version: number; watermark: number; contentHash: string; }

export interface MemoryEntry {
  id: string;                       // UUID
  kind: MemoryKind;
  anchors: string[];
  content: string;
  ruleRef?: string;                 // axiom 无 ruleRef（自指）
  idempotencyKey?: string;
  status: EntryStatus;
  ttlExpiresAt?: number;
  promotedFrom?: string;
  meta: {
    version: number; createdAt: number; updatedAt: number;
    sourceTraces: SourceTrace[];
    hitCount: number;
    dialectVersion?: string;
    versions?: EntryVersion[];
    notWriteBack?: boolean;         // 不可回写标记（引用审核动作的条目）
  };
}

export const AXIOM_RULE_ID = "axiom"; // 公理条目固定 id

export function createEntry(input: Partial<MemoryEntry> & { kind: MemoryKind; anchors: string[]; content: string }): MemoryEntry {
  const now = Date.now();
  return {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    anchors: input.anchors,
    content: input.content,
    ...(input.ruleRef !== undefined ? { ruleRef: input.ruleRef } : {}),
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    status: input.status ?? "official",
    ...(input.ttlExpiresAt !== undefined ? { ttlExpiresAt: input.ttlExpiresAt } : {}),
    ...(input.promotedFrom !== undefined ? { promotedFrom: input.promotedFrom } : {}),
    meta: {
      version: input.meta?.version ?? 1,
      createdAt: input.meta?.createdAt ?? now,
      updatedAt: input.meta?.updatedAt ?? now,
      sourceTraces: input.meta?.sourceTraces ?? [],
      hitCount: input.meta?.hitCount ?? 0,
      ...(input.meta?.dialectVersion !== undefined ? { dialectVersion: input.meta.dialectVersion } : {}),
      ...(input.meta?.versions !== undefined ? { versions: input.meta.versions } : {}),
      ...(input.meta?.notWriteBack !== undefined ? { notWriteBack: input.meta.notWriteBack } : {}),
    },
  };
}

export function validateEntryStructure(entry: unknown): string[] {
  const errors: string[] = [];
  if (entry === null || typeof entry !== "object") {
    errors.push("entry must be an object");
    return errors;
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.id !== "string") {
    errors.push("id must be a string");
  }
  if (!Array.isArray(e.anchors) || e.anchors.length === 0 || !e.anchors.every((a) => typeof a === "string")) {
    errors.push("anchors must be a non-empty string array");
  }
  if (typeof e.content !== "string") {
    errors.push("content must be a string");
  }
  if (typeof e.kind !== "string") {
    errors.push("kind must be a string");
  } else if (e.kind !== "axiom" && (typeof e.ruleRef !== "string" || e.ruleRef.length === 0)) {
    errors.push(`ruleRef is required for kind "${e.kind}"`);
  }
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta === null || typeof meta !== "object" || typeof meta.version !== "number") {
    errors.push("meta.version must be a number");
  }
  return errors;
}

export function isAxiom(entry: MemoryEntry): boolean {
  return entry.id === AXIOM_RULE_ID && entry.kind === "axiom";
}
