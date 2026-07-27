export type MessageRole =
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "bash-output"
  | "error"
  | "system";

export interface TuiMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  // tool-call fields
  toolName?: string;
  toolArgs?: string;
  isError?: boolean;
  durationMs?: number;
  // streaming
  streaming?: boolean;
  thinking?: string;
}

export type FocusTarget = "input" | "sessions";

export interface SessionDisplayInfo {
  sessionId: string;
  state: "idle" | "busy" | "expired";
  model: string;
  project: string;
  createdAt: string;
}
