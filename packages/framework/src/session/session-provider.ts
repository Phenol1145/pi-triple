import type { CommandResult } from "../commands.js";

export interface SessionRecord {
  id: string;
  kind: "session";
  workloop: string;
  templateId: string;
  templateAlias: string;
  status: "running" | "stopped";
  timestamp: string;
  summary: string;
  detail: Record<string, string>;
}

export interface TraceRecord {
  id: string;
  kind: "trace";
  workloop: string;
  templateId: string;
  timestamp: string;
  summary: string;
  detail: Record<string, string>;
}

export interface ForkOpts { templateId?: string }
export interface BranchOpts { at: string; templateId?: string }
export interface TransferOpts { templateId: string }

export interface SessionProvider {
  workloop: string;
  list(): Promise<SessionRecord[]> | SessionRecord[];
  show(record: SessionRecord): string;
  capabilities: string[]; // ["fork","clone","transfer","branch","tree"]
  fork?(r: SessionRecord, opts: ForkOpts): CommandResult;
  clone?(r: SessionRecord, opts: ForkOpts): CommandResult;
  transfer?(r: SessionRecord, opts: TransferOpts): CommandResult;
  branch?(r: SessionRecord, opts: BranchOpts): CommandResult;
  tree?(sessions: SessionRecord[]): string;
}

export interface TraceProvider {
  workloop: string;
  list(): TraceRecord[];
  show(record: TraceRecord): string;
  timeline?(agentId: string): TraceRecord[];
}
