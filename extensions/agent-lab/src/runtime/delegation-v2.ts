/**
 * Delegation V2 public event transport types.
 *
 * Canonical source: `pi-subagents/delegation` v2, minimum 0.36.0.
 * This file mirrors the public API subset that a transport adapter consumes
 * and emits. It does NOT import pi-subagents internal execution modules.
 */
export const SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION = 2 as const;
export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

// ---------------------------------------------------------------------------
// Shared / budget types
// ---------------------------------------------------------------------------

export interface SubagentDelegationTurnBudget {
  maxTurns: number;
  graceTurns?: number;
}

export interface SubagentDelegationToolBudget {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

// ---------------------------------------------------------------------------
// V2 request
// ---------------------------------------------------------------------------

export type SubagentDelegationV2Thinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type SubagentDelegationV2ResultRequest =
  | { kind: "text" }
  | { kind: "structured"; schema: Record<string, unknown> };

export interface SubagentDelegationV2Request {
  version: typeof SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION;
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  cwd: string;
  model?: string;
  thinking?: SubagentDelegationV2Thinking;
  timeoutMs?: number;
  turnBudget?: SubagentDelegationTurnBudget;
  toolBudget?: SubagentDelegationToolBudget;
  skill?: string | string[] | boolean;
  artifacts?: boolean;
  result: SubagentDelegationV2ResultRequest;
}

// ---------------------------------------------------------------------------
// V2 started – identity tuple (also base for cancel)
// ---------------------------------------------------------------------------

export interface SubagentDelegationV2Started {
  version: typeof SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION;
  requestId: string;
  ownerRunId: string;
  nodeId: string;
}

// ---------------------------------------------------------------------------
// V2 update
// ---------------------------------------------------------------------------

export interface SubagentDelegationV2Update extends SubagentDelegationV2Started {
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string;
  recentOutputLines?: string[];
  recentTools?: Array<{ tool: string; args: string }>;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
}

// ---------------------------------------------------------------------------
// V2 status union
// ---------------------------------------------------------------------------

export type SubagentDelegationV2Status =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "turn_budget_exhausted"
  | "tool_budget_exhausted"
  | "structured_output_failed"
  | "acceptance_failed"
  | "invalid_request"
  | "unavailable_context"
  | "duplicate_node";

// ---------------------------------------------------------------------------
// V2 result / usage
// ---------------------------------------------------------------------------

export type SubagentDelegationV2Value =
  | { kind: "text"; text: string }
  | { kind: "structured"; value: unknown };

export interface SubagentDelegationV2Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// V2 response
// ---------------------------------------------------------------------------

export interface SubagentDelegationV2TerminalResponse extends SubagentDelegationV2Started {
  status: Exclude<SubagentDelegationV2Status, "invalid_request">;
  error?: string;
  runId?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  exitCode?: number;
  result?: SubagentDelegationV2Value;
  usage?: SubagentDelegationV2Usage;
}

export interface SubagentDelegationV2InvalidResponse {
  version: typeof SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION;
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: "invalid_request";
  error?: string;
}

export type SubagentDelegationV2Response =
  | SubagentDelegationV2TerminalResponse
  | SubagentDelegationV2InvalidResponse;

// ---------------------------------------------------------------------------
// V2 cancel – only the four protocol identity fields
// ---------------------------------------------------------------------------

export interface SubagentDelegationV2Cancel extends SubagentDelegationV2Started {}
