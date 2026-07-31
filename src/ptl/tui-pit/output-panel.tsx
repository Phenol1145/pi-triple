import React from "react";
import { Box, Text, useInput } from "ink";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface OutputPanelProps {
  lines: string[];
  onClose: () => void;
}

export function OutputPanel({ lines, onClose }: OutputPanelProps) {
  useInput((_input, key) => {
    if (key.escape) onClose();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text bold color="cyan"> Output</Text>
        <Text dimColor>  [Esc] 返回</Text>
      </Box>
      {lines.map((line, i) => (
        <Text key={i}>{line.replace(ANSI_RE, "")}</Text>
      ))}
    </Box>
  );
}
