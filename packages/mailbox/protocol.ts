import { randomUUID } from "node:crypto";

export interface PitMessage {
  schemaVersion: 1;
  id: string;
  from: { sessionId: string; tenantId: string; name: string };
  to: { sessionId: string; tenantId: string };
  type: "text" | "file" | "ask" | "ask-reply" | "broadcast";
  priority: "normal" | "urgent" | "fyi";
  content: string;
  filePath?: string;
  fileChecksum?: string;
  fileSize?: number;
  replyTo?: string;
  expiresAt?: string;
  timestamp: string;
  hop: number;
}

export function createMessage(partial: {
  from: PitMessage["from"];
  to: PitMessage["to"];
  type: PitMessage["type"];
  content: string;
  priority?: PitMessage["priority"];
  replyTo?: string;
  filePath?: string;
  fileChecksum?: string;
  fileSize?: number;
}): PitMessage {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    ...partial,
    priority: partial.priority ?? "normal",
    timestamp: new Date().toISOString(),
    hop: 0,
  };
}

export function validateMessage(raw: unknown): PitMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  if (msg.schemaVersion !== 1) return null;
  if (typeof msg.id !== "string") return null;
  if (!msg.from || !msg.to) return null;
  if (typeof msg.content !== "string") return null;
  // H2 护栏：注入面来源不可信——补强字段级校验
  const from = msg.from as Record<string, unknown>;
  if (typeof from.name !== "string" || from.name.trim() === "") return null;
  if (msg.priority !== undefined && msg.priority !== "normal" && msg.priority !== "urgent" && msg.priority !== "fyi") return null;
  if (msg.type !== undefined && msg.type !== "text" && msg.type !== "file" && msg.type !== "ask" && msg.type !== "ask-reply" && msg.type !== "broadcast") return null;
  if (msg.content.length > 100_000) return null;
  return raw as PitMessage;
}
