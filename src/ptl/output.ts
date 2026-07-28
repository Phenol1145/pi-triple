/**
 * Pi-Triple 统一输出层
 *
 * JSON 模式的单一出口：emitJson / emitJsonError。
 * 错误码常量供所有命令 + TUI 复用。
 */

// ─── Types ───────────────────────────────────────────────────

export interface ErrorInfo {
  code: string;
  message: string;
  candidates?: string[];
}

// ─── JSON 出口 ──────────────────────────────────────────────

export function emitJson(data: any): void {
  console.log(JSON.stringify({ ok: true, data, error: null }));
}

export function emitJsonError(code: string, message: string, candidates?: string[]): void {
  const error: ErrorInfo = { code, message };
  if (candidates) error.candidates = candidates;
  console.log(JSON.stringify({ ok: false, data: null, error }));
}

// ─── 错误码 ──────────────────────────────────────────────────

export const ERR = {
  TENANT_NOT_FOUND: "TENANT_NOT_FOUND",
  TENANT_AMBIGUOUS: "TENANT_AMBIGUOUS",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  TMUX_NOT_INSTALLED: "TMUX_NOT_INSTALLED",
  CONFIG_PARSE_ERROR: "CONFIG_PARSE_ERROR",
  INTERACTIVE_REQUIRED: "INTERACTIVE_REQUIRED",
  TUI_NO_JSON: "TUI_NO_JSON",
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  HANDOFF_REQUIRED: "HANDOFF_REQUIRED",
} as const;
