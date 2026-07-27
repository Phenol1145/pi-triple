import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface CommandInfo {
  name: string;
  description: string;
}

interface CommandPickerProps {
  commands: CommandInfo[];
  filter: string;
  selectedIndex: number;
}

/** Pi-style command picker dropdown — shown when input starts with "/" */
export function CommandPicker({ commands, filter, selectedIndex }: CommandPickerProps) {
  const filtered = commands.filter((c) => c.name.startsWith(filter));
  if (filtered.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.colors.primary}>
      {filtered.map((cmd, i) => (
        <Box key={cmd.name}>
          <Text inverse={i === selectedIndex} bold={i === selectedIndex}>
            {i === selectedIndex ? " ❯ " : "   "}
          </Text>
          <Text color={theme.colors.primary}>/{cmd.name}</Text>
          <Text dimColor>  {cmd.description}</Text>
        </Box>
      ))}
      <Text dimColor> ↑↓ select · Enter confirm · Esc cancel</Text>
    </Box>
  );
}

/** Get filtered command list (shared between picker and input logic) */
export function filterCommands(commands: CommandInfo[], filter: string): CommandInfo[] {
  return commands.filter((c) => c.name.startsWith(filter));
}
