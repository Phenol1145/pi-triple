import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

interface StatusBarProps {
  state: "idle" | "busy" | "error";
  sessionId: string;
  sessionCount: number;
  sessionLimit: number;
  expanded: boolean;
  tokens?: number;
  model?: string;
  queued?: number;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function StatusBar({
  state,
  sessionId,
  sessionCount,
  sessionLimit,
  expanded,
  tokens,
  model,
  queued,
}: StatusBarProps) {
  const icon =
    state === "idle"
      ? theme.icons.idle
      : state === "busy"
        ? theme.icons.busy
        : theme.icons.error;
  const color =
    state === "idle"
      ? theme.colors.statusIdle
      : state === "busy"
        ? theme.colors.statusBusy
        : theme.colors.statusError;

  return (
    <Box
      borderStyle="single"
      borderColor={theme.colors.border}
      justifyContent="space-between"
    >
      <Box>
        <Text color={color}>
          {icon} {state}
        </Text>
        <Text dimColor> │ {sessionId.slice(0, 8)}</Text>
        <Text dimColor>
          {" "}
          │ {sessionCount}/{sessionLimit}
        </Text>
        {expanded && tokens !== undefined && (
          <Text dimColor> │ tokens: {formatTokens(tokens)}</Text>
        )}
        {expanded && model && <Text dimColor> │ {model}</Text>}
        {queued !== undefined && queued > 0 && (
          <Text color={theme.colors.statusBusy}>
            {" "}
            {theme.icons.queued} {queued} queued
          </Text>
        )}
      </Box>
      <Text dimColor>
        {expanded ? "Ctrl+G: collapse" : "Ctrl+G: details"}
      </Text>
    </Box>
  );
}
