import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

interface TopBarProps {
  model: string;
  version: string;
}

export function TopBar({ model, version }: TopBarProps) {
  return (
    <Box
      justifyContent="space-between"
      borderStyle="single"
      borderColor={theme.colors.border}
    >
      <Text bold color={theme.colors.primary}>
        Pi-Triple
      </Text>
      <Text dimColor>v{version}</Text>
      <Text>{model}</Text>
    </Box>
  );
}
