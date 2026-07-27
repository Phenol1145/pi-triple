import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { SessionDisplayInfo } from "../types.js";

interface SessionListProps {
  sessions: SessionDisplayInfo[];
  activeSessionId: string;
  selectedIndex: number;
  focused: boolean;
  width: number;
}

export function SessionList({
  sessions,
  activeSessionId,
  selectedIndex,
  focused,
  width,
}: SessionListProps) {
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor={focused ? theme.colors.primary : theme.colors.border}
    >
      <Text bold dimColor>
        {" "}Sessions
      </Text>
      {sessions.length === 0 && <Text dimColor>  (none)</Text>}
      {sessions.map((s, i) => {
        const isActive = s.sessionId === activeSessionId;
        const isSelected = i === selectedIndex && focused;
        const stateIcon =
          s.state === "idle"
            ? theme.icons.idle
            : s.state === "busy"
              ? theme.icons.busy
              : theme.icons.expired;
        const stateColor =
          s.state === "idle"
            ? theme.colors.statusIdle
            : s.state === "busy"
              ? theme.colors.statusBusy
              : theme.colors.expired;

        return (
          <Box key={s.sessionId}>
            <Text inverse={isSelected}>
              {isActive ? "*" : " "} {s.sessionId.slice(0, 6)}…
            </Text>
            <Text color={stateColor}> {stateIcon}</Text>
            {isSelected && s.state === "expired" && (
              <Text dimColor> [expired]</Text>
            )}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor> n:new Tab:focus</Text>
      </Box>
    </Box>
  );
}
