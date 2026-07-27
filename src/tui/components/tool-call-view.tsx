/**
 * Progressive disclosure: collapsed by default, expanded when focused.
 * Shows tool name + status icon, with args/output only on focus.
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
  focused?: boolean;
}

export function ToolCallView({
  toolName,
  args,
  isError,
  durationMs,
  output,
  focused = false,
}: ToolCallViewProps) {
  const statusIcon = isError ? theme.icons.toolErr : theme.icons.toolOk;
  const statusColor = isError ? theme.colors.toolErr : theme.colors.toolOk;
  const duration = durationMs !== undefined ? ` (${durationMs}ms)` : "";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.colors.tool}>{theme.icons.tool} </Text>
        <Text bold>{toolName}</Text>
        {focused && args && (
          <Text dimColor> {args}</Text>
        )}
        <Text color={statusColor}>
          {" "}{statusIcon}{duration}
        </Text>
      </Box>
      {focused && output && (
        <Box marginLeft={2}>
          <Text dimColor>
            {output.length > 200 ? output.slice(0, 200) + "…" : output}
          </Text>
        </Box>
      )}
    </Box>
  );
}
