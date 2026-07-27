/**
 * Tool execution status line. Phase 1: always shows name + status + duration.
 * Args are truncated inline. No expand/collapse (progressive disclosure via
 * rendering control in MessageBubble when needed).
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface ToolCallViewProps {
  toolName: string;
  args?: string;
  isError?: boolean;
  durationMs?: number;
  output?: string;
}

export function ToolCallView({
  toolName,
  args,
  isError,
  durationMs,
  output,
}: ToolCallViewProps) {
  const statusIcon = isError ? theme.icons.toolErr : theme.icons.toolOk;
  const statusColor = isError ? theme.colors.toolErr : theme.colors.toolOk;

  // Compact args display (truncated, inline)
  const argsDisplay =
    args && args !== "{}" ? ` ${args.length > 60 ? args.slice(0, 57) + "…" : args}` : "";
  const duration = durationMs !== undefined ? ` (${durationMs}ms)` : "";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.colors.tool}>{theme.icons.tool} </Text>
        <Text bold>{toolName}</Text>
        {argsDisplay && <Text dimColor>{argsDisplay}</Text>}
        <Text color={statusColor}>
          {" "}{statusIcon}{duration}
        </Text>
      </Box>
      {output && (
        <Box marginLeft={2}>
          <Text dimColor>
            {output.length > 200 ? output.slice(0, 200) + "…" : output}
          </Text>
        </Box>
      )}
    </Box>
  );
}
