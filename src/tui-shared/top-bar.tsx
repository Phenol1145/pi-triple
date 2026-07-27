import React from "react";
import { Box, Text } from "ink";

interface TopBarProps {
  title: string;
  version?: string;
  status?: string;
}

export function TopBar({ title, version, status }: TopBarProps) {
  return (
    <Box
      width="100%"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={2}>
        <Text bold color="cyan">
          {title}
        </Text>
        {version ? (
          <Text dimColor>
            v{version}
          </Text>
        ) : null}
      </Box>
      {status ? (
        <Text color="gray">
          {status}
        </Text>
      ) : null}
    </Box>
  );
}
