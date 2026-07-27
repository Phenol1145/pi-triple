export const theme = {
  colors: {
    primary: "cyan" as const,
    user: "green" as const,
    assistant: "white" as const,
    tool: "yellow" as const,
    toolOk: "green" as const,
    toolErr: "red" as const,
    error: "red" as const,
    dim: "gray" as const,
    thinking: "gray" as const,
    statusIdle: "green" as const,
    statusBusy: "yellow" as const,
    statusError: "red" as const,
    expired: "gray" as const,
    border: "gray" as const,
  },
  icons: {
    tool: "🔧",
    toolOk: "✅",
    toolErr: "❌",
    thinking: "💭",
    queued: "⏳",
    idle: "●",
    busy: "◐",
    error: "✖",
    expired: "○",
    prompt: ">",
  },
} as const;

/** Replace emoji with ASCII for Windows legacy cmd */
export function applyWindowsFallbacks(): void {
  if (process.platform === "win32" && !process.env.WT_SESSION) {
    (theme.icons as Record<string, string>).tool = "[TOOL]";
    (theme.icons as Record<string, string>).toolOk = "[OK]";
    (theme.icons as Record<string, string>).toolErr = "[ERR]";
    (theme.icons as Record<string, string>).thinking = "[...]";
    (theme.icons as Record<string, string>).queued = "[Q]";
    (theme.icons as Record<string, string>).idle = "(o)";
    (theme.icons as Record<string, string>).busy = "(~)";
    (theme.icons as Record<string, string>).expired = "(x)";
  }
}
