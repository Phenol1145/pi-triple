import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  hints: string;
}

export function StatusBar({ hints }: StatusBarProps) {
  return (
    <Box
      width="100%"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
    >
      <Text dimColor>
        {hints}
      </Text>
    </Box>
  );
}
